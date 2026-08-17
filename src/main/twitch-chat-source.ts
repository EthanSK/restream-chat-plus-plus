import { EventEmitter } from 'node:events';
import { shell } from 'electron';
import WebSocket from 'ws';
import type {
  ChatMessage,
  DirectChatConnection,
  DirectChatSendResult,
} from '../shared/types';
import { loadTwitchCreds } from './credentials';
import {
  ProviderTokenStore,
  type TwitchTokenSet,
} from './provider-token-store';
import type { Store } from './store';
import { appendJsonl, errorToString } from './structured-log';

const DEVICE_URL = 'https://id.twitch.tv/oauth2/device';
const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const VALIDATE_URL = 'https://id.twitch.tv/oauth2/validate';
const EVENTSUB_URL = 'wss://eventsub.wss.twitch.tv/ws?keepalive_timeout_seconds=30';
const EVENTSUB_SUBSCRIPTIONS_URL = 'https://api.twitch.tv/helix/eventsub/subscriptions';
const STREAMS_URL = 'https://api.twitch.tv/helix/streams';
const CHAT_MESSAGES_URL = 'https://api.twitch.tv/helix/chat/messages';
const VIEWER_POLL_INTERVAL = 30_000;
const EVENTSUB_STALE_TIMEOUT = 75_000;
const EVENTSUB_WATCHDOG_INTERVAL = 15_000;
const TWITCH_SCOPES = ['user:read:chat', 'user:write:chat'];

interface TwitchValidation {
  client_id: string;
  login: string;
  scopes: string[];
  user_id: string;
  expires_in: number;
}

interface TwitchDeviceCode {
  device_code: string;
  expires_in: number;
  interval: number;
  user_code: string;
  verification_uri: string;
}

export interface TwitchChatSourceEvents {
  state: (state: DirectChatConnection) => void;
  message: (message: ChatMessage) => void;
}

/** Official direct Twitch chat source using the public-client Device Code flow and EventSub WebSocket. */
export class TwitchChatSource extends EventEmitter {
  private readonly tokens: ProviderTokenStore<TwitchTokenSet>;
  private state: DirectChatConnection = {
    provider: 'twitch',
    status: 'disconnected',
  };
  private socket?: WebSocket;
  private token?: TwitchTokenSet;
  private userId?: string;
  private wantsConnection = false;
  private reconnectTimer?: NodeJS.Timeout;
  private validationTimer?: NodeJS.Timeout;
  private viewerTimer?: NodeJS.Timeout;
  private eventSubWatchdogTimer?: NodeJS.Timeout;
  private dateLastEventSubFrameReceived?: number;
  private reconnectAttempt = 0;

  constructor(store: Store) {
    super();
    this.tokens = new ProviderTokenStore<TwitchTokenSet>(store, 'twitchTokenEnc');
  }

  override on<E extends keyof TwitchChatSourceEvents>(
    event: E,
    listener: TwitchChatSourceEvents[E],
  ): this {
    return super.on(event, listener);
  }

  getState(): DirectChatConnection {
    return { ...this.state };
  }

  async start(): Promise<void> {
    if (!loadTwitchCreds()) {
      this.setState('not-configured', 'Twitch app registration is not configured.');
      return;
    }
    this.token = this.tokens.read();
    if (!this.token) {
      this.setState('disconnected');
      return;
    }
    this.wantsConnection = true;
    await this.connectWithTokenSafely();
  }

  async connect(): Promise<void> {
    const creds = loadTwitchCreds();
    if (!creds) {
      this.setState('not-configured', 'Twitch app registration is not configured.');
      return;
    }
    this.wantsConnection = true;
    this.token = this.tokens.read();
    if (this.token) {
      await this.connectWithTokenSafely();
      return;
    }
    try {
      await this.authorizeDevice(creds.clientId);
    } catch (error) {
      this.setState('error', undefined, `Twitch authorization failed: ${errorMessage(error)}`);
    }
  }

  async reconnect(): Promise<void> {
    this.wantsConnection = true;
    this.clearTimers();
    this.terminateCurrentSocket();
    this.token = this.tokens.read();
    if (!this.token) {
      this.setState('disconnected', 'Connect Twitch again to continue.');
      return;
    }
    this.log('manual-reconnect');
    await this.connectWithTokenSafely();
  }

  async disconnect(): Promise<void> {
    this.wantsConnection = false;
    this.clearTimers();
    this.socket?.close(1000, 'Disconnected by user');
    this.socket = undefined;
    const token = this.token;
    const creds = loadTwitchCreds();
    this.token = undefined;
    this.userId = undefined;
    this.tokens.clear();
    this.setState('disconnected');
    if (token && creds) {
      const body = new URLSearchParams({
        client_id: creds.clientId,
        token: token.accessToken,
      });
      await fetch('https://id.twitch.tv/oauth2/revoke', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      }).catch(() => undefined);
    }
  }

  stop(): void {
    this.wantsConnection = false;
    this.clearTimers();
    this.socket?.close(1000, 'Application closing');
    this.socket = undefined;
  }

  async send(text: string): Promise<DirectChatSendResult> {
    const creds = loadTwitchCreds();
    const token = await this.ensureValidToken();
    if (!creds || !token || !this.userId || this.state.status !== 'connected') {
      return { ok: false, error: 'Twitch chat is not connected.' };
    }
    return sendTwitchChatMessage({
      clientId: creds.clientId,
      accessToken: token.accessToken,
      userId: this.userId,
      text,
    });
  }

  private async authorizeDevice(clientId: string): Promise<void> {
    this.setState('connecting', 'Waiting for Twitch authorization…');
    const body = new URLSearchParams({
      client_id: clientId,
      scopes: TWITCH_SCOPES.join(' '),
    });
    const response = await fetch(DEVICE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!response.ok) {
      this.setState('error', undefined, `Twitch authorization failed (${response.status}).`);
      return;
    }
    const device = (await response.json()) as TwitchDeviceCode;
    this.setState('connecting', `Enter ${device.user_code} if Twitch asks for the code.`);
    await shell.openExternal(device.verification_uri);
    const deadline = Date.now() + device.expires_in * 1_000;
    while (this.wantsConnection && Date.now() < deadline) {
      await wait(Math.max(1, device.interval) * 1_000);
      const token = await this.exchangeDeviceCode(clientId, device.device_code);
      if (token === 'pending') continue;
      if (!token) {
        this.setState('error', undefined, 'Twitch authorization expired. Try Connect again.');
        return;
      }
      this.token = token;
      this.tokens.write(token);
      await this.connectWithTokenSafely();
      return;
    }
    if (this.wantsConnection) {
      this.setState('error', undefined, 'Twitch authorization expired. Try Connect again.');
    }
  }

  private async exchangeDeviceCode(
    clientId: string,
    deviceCode: string,
  ): Promise<TwitchTokenSet | 'pending' | undefined> {
    const body = new URLSearchParams({
      client_id: clientId,
      scopes: TWITCH_SCOPES.join(' '),
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
    let response: Response;
    try {
      response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
    } catch {
      return 'pending'; // A brief network failure used to abandon an approved device code; keep polling until Twitch replies or the code expires.
    }
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      return payload.message === 'authorization_pending' ? 'pending' : undefined;
    }
    if (
      typeof payload.access_token !== 'string' ||
      typeof payload.refresh_token !== 'string'
    ) {
      return undefined;
    }
    return {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token,
      expiresAt: Date.now() + numberOr(payload.expires_in, 14_400) * 1_000,
      scope: stringArray(payload.scope),
    };
  }

  private async connectWithToken(): Promise<void> {
    if (!this.wantsConnection) return;
    const token = await this.ensureValidToken();
    if (!token) {
      this.tokens.clear();
      this.token = undefined;
      this.setState('disconnected', 'Connect Twitch again to continue.');
      return;
    }
    let validation = await this.validate(token.accessToken);
    if (!validation) {
      this.token = { ...token, expiresAt: 0 };
      const refreshed = await this.ensureValidToken();
      validation = refreshed ? await this.validate(refreshed.accessToken) : undefined;
    }
    if (!validation) {
      this.tokens.clear();
      this.token = undefined;
      this.setState('disconnected', 'Connect Twitch again to continue.');
      return;
    }
    if (!TWITCH_SCOPES.every((scope) => validation.scopes.includes(scope))) {
      this.tokens.clear();
      this.token = undefined;
      this.setState(
        'disconnected',
        'Connect Twitch again to approve reading and sending chat.',
      );
      return;
    }
    this.userId = validation.user_id;
    this.setState('connecting', 'Connecting to Twitch chat…', undefined, validation.login);
    this.openEventSub(EVENTSUB_URL, true);
    this.armHourlyValidation();
  }

  private async connectWithTokenSafely(): Promise<void> {
    try {
      await this.connectWithToken();
    } catch (error) {
      this.scheduleReconnect(`Twitch could not connect: ${errorMessage(error)}`);
    }
  }

  private async ensureValidToken(): Promise<TwitchTokenSet | undefined> {
    if (!this.token) return undefined;
    if (this.token.expiresAt - Date.now() > 60_000) return this.token;
    const creds = loadTwitchCreds();
    if (!creds) return undefined;
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: this.token.refreshToken,
      client_id: creds.clientId,
    });
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (
      !response.ok ||
      typeof payload.access_token !== 'string' ||
      typeof payload.refresh_token !== 'string'
    ) {
      return undefined;
    }
    this.token = {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token,
      expiresAt: Date.now() + numberOr(payload.expires_in, 14_400) * 1_000,
      scope: stringArray(payload.scope),
    };
    this.tokens.write(this.token);
    return this.token;
  }

  private async validate(accessToken: string): Promise<TwitchValidation | undefined> {
    const response = await fetch(VALIDATE_URL, {
      headers: { authorization: `OAuth ${accessToken}` },
    });
    if (!response.ok) return undefined;
    const payload = (await response.json()) as Partial<TwitchValidation>;
    return typeof payload.user_id === 'string' && typeof payload.login === 'string'
      ? (payload as TwitchValidation)
      : undefined;
  }

  private openEventSub(url: string, subscribe: boolean): void {
    const socket = new WebSocket(url);
    const prior = this.socket;
    this.socket = socket;
    socket.on('open', () => {
      this.armEventSubWatchdog(socket);
      this.log('socket-open');
    });
    socket.on('message', (data) => void this.handleEventSubMessage(socket, data.toString(), subscribe));
    socket.on('error', (error) => this.log('socket-error', { error: errorToString(error) }));
    socket.on('close', (code, reason) => {
      if (this.socket !== socket || !this.wantsConnection) return;
      this.disarmEventSubWatchdog();
      this.log('socket-close', { code, reason: reason.toString() });
      this.scheduleReconnect('Twitch chat disconnected.');
    });
    if (prior && prior.readyState !== WebSocket.CLOSED) {
      prior.close(1000, 'Replaced by a new EventSub connection');
    }
  }

  private async handleEventSubMessage(
    socket: WebSocket,
    json: string,
    subscribe: boolean,
  ): Promise<void> {
    if (this.socket !== socket) return;
    this.dateLastEventSubFrameReceived = Date.now();
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(json) as Record<string, unknown>;
    } catch {
      return;
    }
    const metadata = record(frame.metadata);
    const payload = record(frame.payload);
    this.log('inbound-frame', { messageType: metadata.message_type });
    switch (metadata.message_type) {
      case 'session_welcome': {
        if (subscribe) {
          const sessionId = record(payload.session).id;
          if (typeof sessionId !== 'string' || !(await this.subscribe(sessionId))) {
            socket.close(4000, 'Subscription failed');
            this.scheduleReconnect('Twitch chat subscription failed.');
            return;
          }
        }
        this.reconnectAttempt = 0;
        this.setState('connected', 'Reading and sending Twitch chat directly.', undefined, this.state.accountName);
        this.armViewerPolling();
        break;
      }
      case 'session_reconnect': {
        const reconnectUrl = record(payload.session).reconnect_url;
        if (typeof reconnectUrl === 'string') {
          this.setState('connecting', 'Twitch requested a seamless reconnect.', undefined, this.state.accountName);
          this.openEventSub(reconnectUrl, false);
        }
        break;
      }
      case 'notification': {
        const message = normalizeTwitchNotification(payload, this.userId);
        if (message) {
          this.log('message-received', { messageId: message.id, self: message.self === true });
          this.emit('message', message);
        } else {
          this.log('message-rejected-malformed');
        }
        break;
      }
      case 'revocation': {
        this.wantsConnection = false;
        this.tokens.clear();
        this.token = undefined;
        socket.close(4001, 'Twitch revoked the chat subscription');
        this.setState('disconnected', 'Twitch ended direct chat access. Connect Twitch again.');
        break;
      }
      case 'session_keepalive':
      default:
        break;
    }
  }

  private async subscribe(sessionId: string): Promise<boolean> {
    const creds = loadTwitchCreds();
    const token = this.token;
    const userId = this.userId;
    if (!creds || !token || !userId) return false;
    try {
      const response = await fetch(EVENTSUB_SUBSCRIPTIONS_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token.accessToken}`,
          'client-id': creds.clientId,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          type: 'channel.chat.message',
          version: '1',
          condition: { broadcaster_user_id: userId, user_id: userId },
          transport: { method: 'websocket', session_id: sessionId },
        }),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private scheduleReconnect(reason: string): void {
    if (!this.wantsConnection || this.reconnectTimer) return;
    this.disarmEventSubWatchdog();
    this.stopViewerPolling();
    this.reconnectAttempt += 1;
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(5, this.reconnectAttempt - 1));
    this.setState('connecting', `${reason} Retrying…`, undefined, this.state.accountName);
    this.log('reconnect-scheduled', { reason, delay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connectWithTokenSafely();
    }, delay);
  }

  private armHourlyValidation(): void {
    if (this.validationTimer) clearInterval(this.validationTimer);
    this.validationTimer = setInterval(() => void this.validateCurrentSession(), 60 * 60 * 1_000);
  }

  private async validateCurrentSession(): Promise<void> {
    if (!this.wantsConnection || !this.token) return;
    if (await this.validate(this.token.accessToken)) return;
    this.token = { ...this.token, expiresAt: 0 };
    const refreshed = await this.ensureValidToken();
    if (refreshed && (await this.validate(refreshed.accessToken))) return;
    this.socket?.close(4001, 'Twitch authorization expired');
    this.tokens.clear();
    this.token = undefined;
    this.setState('disconnected', 'Connect Twitch again to continue.');
  }

  private armViewerPolling(): void {
    this.stopViewerPolling();
    void this.refreshViewerCount();
    this.viewerTimer = setInterval(() => void this.refreshViewerCount(), VIEWER_POLL_INTERVAL);
  }

  private stopViewerPolling(): void {
    if (this.viewerTimer) clearInterval(this.viewerTimer);
    this.viewerTimer = undefined;
  }

  private async refreshViewerCount(): Promise<void> {
    const creds = loadTwitchCreds();
    const token = await this.ensureValidToken();
    if (!creds || !token || !this.userId || !this.wantsConnection) return;
    try {
      const url = new URL(STREAMS_URL);
      url.searchParams.set('user_id', this.userId);
      const response = await fetch(url, {
        headers: {
          authorization: `Bearer ${token.accessToken}`,
          'client-id': creds.clientId,
        },
      });
      if (!response.ok) return;
      this.setViewerState(parseTwitchViewerState(await response.json()));
    } catch {
      // Chat remains healthy when a viewer-count refresh fails, so retain the last confirmed value.
    }
  }

  private setViewerState(viewers: { isLive: boolean; viewerCount?: number }): void {
    if (
      this.state.isLive === viewers.isLive &&
      this.state.viewerCount === viewers.viewerCount
    ) {
      return;
    }
    this.state = { ...this.state, ...viewers };
    this.emit('state', this.getState());
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.validationTimer) clearInterval(this.validationTimer);
    this.stopViewerPolling();
    this.disarmEventSubWatchdog();
    this.reconnectTimer = undefined;
    this.validationTimer = undefined;
  }

  private armEventSubWatchdog(socket: WebSocket): void {
    this.disarmEventSubWatchdog();
    this.dateLastEventSubFrameReceived = Date.now();
    this.eventSubWatchdogTimer = setInterval(() => {
      if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) return;
      const staleFor = Date.now() - (this.dateLastEventSubFrameReceived ?? Date.now());
      if (staleFor <= EVENTSUB_STALE_TIMEOUT) return;
      this.log('stale-inbound-terminate', { staleFor, threshold: EVENTSUB_STALE_TIMEOUT });
      this.socket = undefined; // A half-open socket never fires close, so detach it before the forced reconnect. (Codex task: 019ff120-ea11-71a3-8b65-c55b45cac2fe)
      this.disarmEventSubWatchdog();
      try {
        socket.terminate();
      } catch {
        // The socket can race closed after the readyState check; reconnect still proceeds.
      }
      this.scheduleReconnect('Twitch chat stopped receiving data.');
    }, EVENTSUB_WATCHDOG_INTERVAL);
    this.eventSubWatchdogTimer.unref?.();
  }

  private disarmEventSubWatchdog(): void {
    if (this.eventSubWatchdogTimer) clearInterval(this.eventSubWatchdogTimer);
    this.eventSubWatchdogTimer = undefined;
    this.dateLastEventSubFrameReceived = undefined;
  }

  private terminateCurrentSocket(): void {
    const socket = this.socket;
    this.socket = undefined;
    if (!socket) return;
    try {
      socket.terminate();
    } catch {
      // Already closed.
    }
  }

  private log(event: string, context: Record<string, unknown> = {}): void {
    appendJsonl('direct-chat.jsonl', { provider: 'twitch', event, ...context });
  }

  private setState(
    status: DirectChatConnection['status'],
    detail?: string,
    lastError?: string,
    accountName?: string,
  ): void {
    this.state = {
      provider: 'twitch',
      status,
      accountName: accountName ?? this.state.accountName,
      detail,
      lastError,
    };
    this.emit('state', this.getState());
  }
}

export function parseTwitchViewerState(payload: unknown): {
  isLive: boolean;
  viewerCount?: number;
} {
  const data = record(payload).data;
  const stream = Array.isArray(data) ? record(data[0]) : {};
  if (typeof stream.viewer_count !== 'number' || !Number.isFinite(stream.viewer_count)) {
    return { isLive: false };
  }
  return { isLive: true, viewerCount: Math.max(0, Math.trunc(stream.viewer_count)) };
}

export function normalizeTwitchNotification(
  payload: Record<string, unknown>,
  localUserId?: string,
): ChatMessage | undefined {
  const event = record(payload.event);
  const message = record(event.message);
  if (
    typeof event.message_id !== 'string' ||
    typeof event.chatter_user_name !== 'string' ||
    typeof message.text !== 'string'
  ) {
    return undefined;
  }
  return {
    id: event.message_id,
    platform: 'twitch',
    username: event.chatter_user_name,
    text: message.text,
    ts: Date.now(),
    self:
      typeof event.chatter_user_id === 'string' &&
      event.chatter_user_id === localUserId,
    source: 'twitch-direct',
    raw: payload,
  };
}

export async function sendTwitchChatMessage({
  clientId,
  accessToken,
  userId,
  text,
  fetchImpl = fetch,
}: {
  clientId: string;
  accessToken: string;
  userId: string;
  text: string;
  fetchImpl?: typeof fetch;
}): Promise<DirectChatSendResult> {
  try {
    const response = await fetchImpl(CHAT_MESSAGES_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'client-id': clientId,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        broadcaster_id: userId,
        sender_id: userId,
        message: text,
      }),
    });
    const payload = record(await response.json().catch(() => ({})));
    const result = Array.isArray(payload.data) ? record(payload.data[0]) : {};
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        authorizationRequired: response.status === 401 || response.status === 403,
        error: stringOr(payload.message, `Twitch rejected the message (${response.status}).`),
      };
    }
    if (result.is_sent !== true) {
      const dropReason = record(result.drop_reason);
      return {
        ok: false,
        status: response.status,
        error: stringOr(dropReason.message, 'Twitch did not send the message.'),
      };
    }
    return {
      ok: true,
      status: response.status,
      messageId: typeof result.message_id === 'string' ? result.message_id : undefined,
    };
  } catch (error) {
    return { ok: false, error: `Twitch send failed: ${errorMessage(error)}` };
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value ? value : fallback;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function wait(duration: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, duration));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
