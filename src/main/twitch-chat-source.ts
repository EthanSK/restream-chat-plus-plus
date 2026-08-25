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
/** Refresh this far ahead of expiry so a request never rides a token that dies mid-flight. */
const TOKEN_REFRESH_MARGIN = 60_000;
const REAUTHORIZE_DETAIL = 'Connect Twitch again to continue.';

interface TwitchValidation {
  client_id: string;
  login: string;
  scopes: string[];
  user_id: string;
  expires_in: number;
}

/**
 * Twitch itself refused the grant, so the stored authorization is worthless and the user must reconnect.
 * Only Twitch's explicit rejections produce this outcome — see {@link isAuthorizationRejection}.
 */
interface AuthorizationRejected {
  kind: 'invalid';
  detail: string;
}

/**
 * Something temporary failed — DNS, offline Wi-Fi, a Twitch 5xx, a rate limit, a locked keychain.
 * The stored authorization is still presumed usable, so it must survive and the connect must retry.
 */
interface AuthorizationDeferred {
  kind: 'transient';
  detail: string;
}

type TwitchTokenOutcome =
  | { kind: 'ok'; token: TwitchTokenSet }
  | AuthorizationRejected
  | AuthorizationDeferred;

type TwitchValidationOutcome =
  | { kind: 'ok'; validation: TwitchValidation }
  | AuthorizationRejected
  | AuthorizationDeferred;

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
  /** Twitch rotates the refresh token on every use, so parallel refreshes would invalidate each other. */
  private refreshInFlight?: Promise<TwitchTokenOutcome>;

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

  /**
   * True while an authorization is still on hand, so retrying is worthwhile even from `disconnected`.
   * The in-memory token counts because a keyring read can fail temporarily without the grant being gone.
   */
  hasStoredAuthorization(): boolean {
    return this.token !== undefined || this.tokens.read() !== undefined;
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
    this.token = this.tokens.read() ?? this.token;
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
    // Prefer the persisted grant, but keep the in-memory one when the keyring read fails temporarily.
    this.token = this.tokens.read() ?? this.token;
    if (!this.token) {
      this.wantsConnection = false;
      this.setState('disconnected', REAUTHORIZE_DETAIL);
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
    if (!creds || token.kind !== 'ok' || !this.userId || this.state.status !== 'connected') {
      return { ok: false, error: 'Twitch chat is not connected.' };
    }
    return sendTwitchChatMessage({
      clientId: creds.clientId,
      accessToken: token.token.accessToken,
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
    const session = await this.resolveAuthorizedSession();
    if (session.kind === 'transient') {
      // A Twitch outage, a sleeping laptop or a locked keyring must never cost the user their grant:
      // keep the stored token and let the backoff ladder retry until Twitch answers again.
      this.scheduleReconnect(session.detail);
      return;
    }
    if (session.kind === 'invalid') {
      this.requireReauthorization(session.detail);
      return;
    }
    // A disconnect, stop or revocation can land while Twitch is still answering; never open a zombie socket.
    if (!this.wantsConnection) return;
    this.userId = session.validation.user_id;
    this.setState('connecting', 'Connecting to Twitch chat…', undefined, session.validation.login);
    this.openEventSub(EVENTSUB_URL, true);
    this.armHourlyValidation();
  }

  /** Confirms the stored grant still works, refreshing at most once, without discarding it on a blip. */
  private async resolveAuthorizedSession(): Promise<TwitchValidationOutcome> {
    const token = await this.ensureValidToken();
    if (token.kind !== 'ok') return token;
    let validation = await this.validate(token.token.accessToken);
    if (validation.kind === 'invalid') {
      // Twitch rejected this access token, but the refresh token may still mint a working one.
      const refreshed = await this.ensureValidToken({ force: true });
      if (refreshed.kind !== 'ok') return refreshed;
      validation = await this.validate(refreshed.token.accessToken);
    }
    if (validation.kind !== 'ok') return validation;
    const granted = validation.validation.scopes;
    if (!TWITCH_SCOPES.every((scope) => granted.includes(scope))) {
      return {
        kind: 'invalid',
        detail: 'Connect Twitch again to approve reading and sending chat.',
      };
    }
    return validation;
  }

  private async connectWithTokenSafely(): Promise<void> {
    try {
      await this.connectWithToken();
    } catch (error) {
      this.scheduleReconnect(`Twitch could not connect: ${errorMessage(error)}`);
    }
  }

  /**
   * Returns the usable access token, refreshing when it is near expiry (or when `force` is set after
   * Twitch rejected the current one). Never clears storage — only the caller decides what a failure means.
   */
  private async ensureValidToken(
    options: { force?: boolean } = {},
  ): Promise<TwitchTokenOutcome> {
    const token = this.token;
    if (!token) return { kind: 'invalid', detail: REAUTHORIZE_DETAIL };
    if (!options.force && token.expiresAt - Date.now() > TOKEN_REFRESH_MARGIN) {
      return { kind: 'ok', token };
    }
    // Coalesce: a socket reconnect, the hourly validation, a send and the viewer poll can all land
    // together, and a second refresh would spend the rotated refresh token and revoke the first one.
    const inFlight = this.refreshInFlight;
    if (inFlight) return inFlight;
    const request = this.refreshToken(token).finally(() => {
      this.refreshInFlight = undefined;
    });
    this.refreshInFlight = request;
    return request;
  }

  private async refreshToken(expiring: TwitchTokenSet): Promise<TwitchTokenOutcome> {
    const creds = loadTwitchCreds();
    if (!creds) {
      // The keychain can be locked or briefly unreadable; that says nothing about the grant itself.
      return { kind: 'transient', detail: 'Twitch app registration is unavailable.' };
    }
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: expiring.refreshToken,
      client_id: creds.clientId,
    });
    let response: Response;
    try {
      response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
    } catch (error) {
      return {
        kind: 'transient',
        detail: `Twitch could not refresh authorization (${errorMessage(error)}).`,
      };
    }
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      this.log('token-refresh-failed', { status: response.status });
      return isAuthorizationRejection(response.status)
        ? { kind: 'invalid', detail: REAUTHORIZE_DETAIL }
        : {
            kind: 'transient',
            detail: `Twitch could not refresh authorization (${response.status}).`,
          };
    }
    if (
      typeof payload.access_token !== 'string' ||
      typeof payload.refresh_token !== 'string'
    ) {
      // A 200 without usable fields is a Twitch-side anomaly, not a revoked grant.
      return { kind: 'transient', detail: 'Twitch returned an unreadable token response.' };
    }
    const refreshed: TwitchTokenSet = {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token,
      expiresAt: Date.now() + numberOr(payload.expires_in, 14_400) * 1_000,
      scope: stringArray(payload.scope),
    };
    if (!this.token || this.token.refreshToken !== expiring.refreshToken) {
      // A disconnect or a fresh authorization replaced this grant mid-flight; never resurrect the old one.
      return { kind: 'transient', detail: 'Twitch authorization changed during refresh.' };
    }
    this.token = refreshed;
    try {
      this.tokens.write(refreshed);
    } catch (error) {
      // Losing at-rest persistence must not end a working session; the live token still reads chat.
      this.log('token-persist-failed', { error: errorToString(error) });
    }
    return { kind: 'ok', token: refreshed };
  }

  private async validate(accessToken: string): Promise<TwitchValidationOutcome> {
    let response: Response;
    try {
      response = await fetch(VALIDATE_URL, {
        headers: { authorization: `OAuth ${accessToken}` },
      });
    } catch (error) {
      return {
        kind: 'transient',
        detail: `Twitch could not verify authorization (${errorMessage(error)}).`,
      };
    }
    if (!response.ok) {
      this.log('validation-failed', { status: response.status });
      return isAuthorizationRejection(response.status)
        ? { kind: 'invalid', detail: REAUTHORIZE_DETAIL }
        : {
            kind: 'transient',
            detail: `Twitch could not verify authorization (${response.status}).`,
          };
    }
    const payload = (await response.json().catch(() => ({}))) as Partial<TwitchValidation>;
    if (typeof payload.user_id !== 'string' || typeof payload.login !== 'string') {
      return { kind: 'transient', detail: 'Twitch returned an unreadable validation response.' };
    }
    return { kind: 'ok', validation: payload as TwitchValidation };
  }

  /** Terminal path: the grant really is unusable, so drop it and ask for a deliberate reconnect. */
  private requireReauthorization(
    detail: string,
    closeReason = 'Twitch authorization expired',
  ): void {
    this.wantsConnection = false;
    this.clearTimers();
    this.socket?.close(4001, closeReason);
    this.socket = undefined;
    this.token = undefined;
    this.userId = undefined;
    this.tokens.clear();
    this.log('authorization-cleared', { detail });
    this.setState('disconnected', detail);
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
        // Twitch itself withdrew the subscription, so this is a real revocation, not a blip.
        this.requireReauthorization(
          'Twitch ended direct chat access. Connect Twitch again.',
          'Twitch revoked the chat subscription',
        );
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
    const validation = await this.validate(this.token.accessToken);
    if (validation.kind === 'ok') return;
    if (validation.kind === 'transient') {
      // The hourly check is a health probe, not a verdict: a failed probe leaves the session alone,
      // and the EventSub watchdog still owns liveness if the connection is genuinely dead.
      this.log('hourly-check-deferred', { detail: validation.detail });
      return;
    }
    // Twitch rejected the access token, so one forced refresh separates a rotation from a revocation.
    const refreshed = await this.ensureValidToken({ force: true });
    if (refreshed.kind === 'transient') {
      this.log('hourly-check-deferred', { detail: refreshed.detail });
      return;
    }
    if (
      refreshed.kind === 'ok' &&
      (await this.validate(refreshed.token.accessToken)).kind !== 'invalid'
    ) {
      return;
    }
    this.requireReauthorization(REAUTHORIZE_DETAIL);
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
    if (!creds || token.kind !== 'ok' || !this.userId || !this.wantsConnection) return;
    try {
      const url = new URL(STREAMS_URL);
      url.searchParams.set('user_id', this.userId);
      const response = await fetch(url, {
        headers: {
          authorization: `Bearer ${token.token.accessToken}`,
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

/**
 * Only Twitch's explicit authorization refusals may erase a stored grant. `400` is the documented
 * refresh-token rejection, `401`/`403` cover an invalid or unscoped token. Everything else — `429`,
 * any `5xx`, a proxy's `502`, an unexpected status — is temporary and must leave the grant intact.
 */
function isAuthorizationRejection(status: number): boolean {
  return status === 400 || status === 401 || status === 403;
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
