import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { URL } from 'node:url';
import { shell } from 'electron';
import WebSocket from 'ws';
import type {
  ChatMessage,
  DirectChatConnection,
  DirectChatSendResult,
} from '../shared/types';
import { loadKickCreds, type KickCreds } from './credentials';
import {
  ProviderTokenStore,
  type KickTokenSet,
} from './provider-token-store';
import type { Store } from './store';
import { appendJsonl, errorToString } from './structured-log';

const REDIRECT_PORT = 8766;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/kick/oauth`;
const AUTHORIZE_URL = 'https://id.kick.com/oauth/authorize';
const TOKEN_URL = 'https://id.kick.com/oauth/token';
const REVOKE_URL = 'https://id.kick.com/oauth/revoke';
const INTROSPECT_URL = 'https://id.kick.com/oauth/token/introspect';
const CHANNELS_URL = 'https://api.kick.com/public/v1/channels';
const LIVESTREAMS_URL = 'https://api.kick.com/public/v1/users/livestreams';
const SUBSCRIPTIONS_URL = 'https://api.kick.com/public/v1/events/subscriptions';
const CHAT_URL = 'https://api.kick.com/public/v1/chat';
const VIEWER_POLL_INTERVAL = 30_000;
const RELAY_PING_INTERVAL = 30_000;
const MAX_MISSED_RELAY_PONGS = 2;
const KICK_SCOPES = ['channel:read', 'events:subscribe', 'chat:write'];

interface KickIdentity {
  userId: number;
  name: string;
}

export interface KickChatSourceEvents {
  state: (state: DirectChatConnection) => void;
  message: (message: ChatMessage) => void;
}

/** Official Kick source: local PKCE OAuth plus a signed public-webhook relay WebSocket. */
export class KickChatSource extends EventEmitter {
  private readonly tokens: ProviderTokenStore<KickTokenSet>;
  private state: DirectChatConnection = {
    provider: 'kick',
    status: 'disconnected',
  };
  private token?: KickTokenSet;
  private socket?: WebSocket;
  private callbackServer?: http.Server;
  private callbackTimer?: NodeJS.Timeout;
  private wantsConnection = false;
  private reconnectTimer?: NodeJS.Timeout;
  private viewerTimer?: NodeJS.Timeout;
  private relayPingTimer?: NodeJS.Timeout;
  private missedRelayPongs = 0;
  private identity?: KickIdentity;
  private reconnectAttempt = 0;

  constructor(store: Store) {
    super();
    this.tokens = new ProviderTokenStore<KickTokenSet>(store, 'kickTokenEnc');
  }

  override on<E extends keyof KickChatSourceEvents>(
    event: E,
    listener: KickChatSourceEvents[E],
  ): this {
    return super.on(event, listener);
  }

  getState(): DirectChatConnection {
    return { ...this.state };
  }

  async start(): Promise<void> {
    if (!loadKickCreds()) {
      this.setState('not-configured', 'Kick app or relay registration is not configured.');
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
    const creds = loadKickCreds();
    if (!creds) {
      this.setState('not-configured', 'Kick app or relay registration is not configured.');
      return;
    }
    this.wantsConnection = true;
    this.token = this.tokens.read();
    if (this.token) {
      await this.connectWithTokenSafely();
      return;
    }
    await this.authorize(creds);
  }

  async reconnect(): Promise<void> {
    this.wantsConnection = true;
    this.stopRuntime();
    this.wantsConnection = true;
    this.token = this.tokens.read();
    if (!this.token) {
      this.setState('disconnected', 'Connect Kick again to continue.');
      return;
    }
    this.log('manual-reconnect');
    await this.connectWithTokenSafely();
  }

  async disconnect(): Promise<void> {
    this.wantsConnection = false;
    this.stopRuntime();
    const token = this.token;
    this.token = undefined;
    this.tokens.clear();
    this.setState('disconnected');
    if (token) {
      const url = new URL(REVOKE_URL);
      url.searchParams.set('token', token.accessToken);
      url.searchParams.set('token_hint_type', 'access_token');
      await fetch(url, { method: 'POST' }).catch(() => undefined);
    }
  }

  stop(): void {
    this.wantsConnection = false;
    this.stopRuntime();
  }

  async send(text: string): Promise<DirectChatSendResult> {
    const creds = loadKickCreds();
    const token = creds ? await this.ensureValidToken(creds) : undefined;
    if (!token || !this.identity || this.state.status !== 'connected') {
      return { ok: false, error: 'Kick chat is not connected.' };
    }
    return sendKickChatMessage({
      accessToken: token.accessToken,
      broadcasterUserId: this.identity.userId,
      text,
    });
  }

  private async authorize(creds: KickCreds): Promise<void> {
    const state = randomBytes(24).toString('base64url');
    const verifier = randomBytes(64).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    this.setState('connecting', 'Waiting for Kick authorization…');
    const codePromise = this.listenForCode(state);
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', creds.clientId);
    url.searchParams.set('redirect_uri', REDIRECT_URI);
    url.searchParams.set('scope', KICK_SCOPES.join(' '));
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', state);
    await shell.openExternal(url.toString());
    try {
      const code = await codePromise;
      const token = await this.exchangeCode(creds, code, verifier);
      this.token = token;
      this.tokens.write(token);
      await this.connectWithTokenSafely();
    } catch (error) {
      this.setState('error', undefined, errorMessage(error));
    } finally {
      this.stopCallbackServer();
    }
  }

  private async connectWithToken(): Promise<void> {
    if (!this.wantsConnection) return;
    const creds = loadKickCreds();
    if (!creds || !this.token) return;
    const token = await this.ensureValidToken(creds);
    if (!token) {
      this.tokens.clear();
      this.token = undefined;
      this.setState('disconnected', 'Connect Kick again to continue.');
      return;
    }
    const missingScopes = missingKickScopes(token.scope, KICK_SCOPES);
    if (missingScopes.length > 0) {
      this.tokens.clear();
      this.token = undefined;
      this.setState(
        'disconnected',
        `Kick did not grant ${missingScopes.join(', ')}. Connect Kick again to approve reading and sending chat.`,
      );
      return;
    }
    this.setState('connecting', 'Connecting to Kick chat…');
    const identity = await this.fetchIdentity(token.accessToken);
    if (!identity) {
      this.scheduleReconnect('Kick could not load the connected account.');
      return;
    }
    this.identity = identity;
    if (!(await this.ensureChatSubscription(token.accessToken))) {
      this.setState(
        'error',
        undefined,
        'Kick rejected the chat webhook subscription. Check the app webhook setting.',
        identity.name,
      );
      return;
    }
    this.openRelay(creds, identity);
  }

  private async connectWithTokenSafely(): Promise<void> {
    try {
      await this.connectWithToken();
    } catch (error) {
      this.scheduleReconnect(`Kick could not connect: ${errorMessage(error)}`);
    }
  }

  private async ensureValidToken(creds: KickCreds): Promise<KickTokenSet | undefined> {
    if (!this.token) return undefined;
    const introspection = await fetch(INTROSPECT_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token.accessToken}` },
    });
    if (introspection.ok) {
      const payload = record(await introspection.json());
      const data = record(payload.data);
      if (data.active === true && numberOr(data.exp, 0) * 1_000 - Date.now() > 60_000) {
        if (typeof data.scope === 'string' && data.scope !== this.token.scope) {
          this.token = { ...this.token, scope: data.scope }; // Kick introspection reports the effective grant; the token response is not authoritative enough for permission checks.
          this.tokens.write(this.token);
        }
        return this.token;
      }
    }
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: this.token.refreshToken,
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
    });
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const payload = record(await response.json().catch(() => ({})));
    if (
      !response.ok ||
      typeof payload.access_token !== 'string' ||
      typeof payload.refresh_token !== 'string'
    ) {
      return undefined;
    }
    this.token = kickToken(payload);
    this.tokens.write(this.token);
    return this.token;
  }

  private async exchangeCode(
    creds: KickCreds,
    code: string,
    verifier: string,
  ): Promise<KickTokenSet> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
      code,
    });
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const payload = record(await response.json().catch(() => ({})));
    if (
      !response.ok ||
      typeof payload.access_token !== 'string' ||
      typeof payload.refresh_token !== 'string'
    ) {
      throw new Error(`Kick token exchange failed (${response.status}).`);
    }
    return kickToken(payload);
  }

  private async fetchIdentity(accessToken: string): Promise<KickIdentity | undefined> {
    const response = await fetch(CHANNELS_URL, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) return undefined;
    return parseKickChannelIdentity(await response.json());
  }

  private async ensureChatSubscription(accessToken: string): Promise<boolean> {
    const response = await fetch(SUBSCRIPTIONS_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        method: 'webhook',
        events: [{ name: 'chat.message.sent', version: 1 }],
      }),
    });
    if (response.ok) return true;
    if (response.status !== 409) return false;
    return true;
  }

  private openRelay(creds: KickCreds, identity: KickIdentity): void {
    const socket = new WebSocket(creds.relayUrl, {
      headers: { authorization: `Bearer ${creds.relayToken}` },
    });
    this.socket?.close(1000, 'Replaced by a new relay connection');
    this.socket = socket;
    socket.on('open', () => {
      this.reconnectAttempt = 0;
      this.log('socket-open');
      this.setState('connected', 'Reading and sending Kick chat directly.', undefined, identity.name);
      this.armViewerPolling();
      this.armRelayPing(socket);
    });
    socket.on('message', (data) => {
      const raw = data.toString();
      this.missedRelayPongs = 0;
      if (raw === 'pong') {
        this.log('relay-pong');
        return;
      }
      const message = normalizeKickRelayMessage(raw, identity.userId);
      if (message) {
        this.log('message-received', { messageId: message.id, self: message.self === true });
        this.emit('message', message);
      } else {
        this.log('message-rejected-malformed');
      }
    });
    socket.on('error', (error) => this.log('socket-error', { error: errorToString(error) }));
    socket.on('close', (code, reason) => {
      if (this.socket !== socket || !this.wantsConnection) return;
      this.disarmRelayPing();
      this.log('socket-close', { code, reason: reason.toString() });
      this.scheduleReconnect('Kick relay disconnected.');
    });
  }

  private scheduleReconnect(reason: string): void {
    if (!this.wantsConnection || this.reconnectTimer) return;
    this.disarmRelayPing();
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

  private listenForCode(expectedState: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((request, response) => {
        if (!request.url) return;
        const url = new URL(request.url, REDIRECT_URI);
        if (url.pathname !== '/kick/oauth') {
          response.writeHead(404).end();
          return;
        }
        const state = url.searchParams.get('state');
        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');
        if (state !== expectedState || error || !code) {
          response.writeHead(400, { 'content-type': 'text/html' });
          response.end('<h2>Kick authorization failed.</h2><p>Return to Chat++ and try again.</p>');
          reject(new Error(error ?? 'Kick returned an invalid OAuth callback.'));
          return;
        }
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end('<h2>Kick connected to Restream Chat++.</h2><p>You can close this page.</p>');
        resolve(code);
      });
      server.on('error', reject);
      server.listen(REDIRECT_PORT, 'localhost');
      this.callbackServer = server;
      this.callbackTimer = setTimeout(() => {
        this.stopCallbackServer();
        reject(new Error('Kick authorization timed out. Try Connect again.'));
      }, 10 * 60 * 1_000);
    });
  }

  private stopRuntime(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.stopViewerPolling();
    this.disarmRelayPing();
    const socket = this.socket;
    this.socket = undefined;
    try {
      socket?.terminate();
    } catch {
      // Already closed.
    }
    this.stopCallbackServer();
  }

  private armRelayPing(socket: WebSocket): void {
    this.disarmRelayPing();
    this.relayPingTimer = setInterval(() => {
      if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) return;
      this.missedRelayPongs += 1;
      if (this.missedRelayPongs > MAX_MISSED_RELAY_PONGS) {
        this.log('relay-ping-timeout-terminate', {
          missedPongs: this.missedRelayPongs,
        });
        this.socket = undefined; // The relay can stay TCP-open after Wi-Fi recovery while no webhooks arrive; force a fresh subscription and socket. (Codex task: 019ff120-ea11-71a3-8b65-c55b45cac2fe)
        this.disarmRelayPing();
        try {
          socket.terminate();
        } catch {
          // The socket can race closed after the readyState check; reconnect still proceeds.
        }
        this.scheduleReconnect('Kick relay stopped responding.');
        return;
      }
      try {
        socket.send('ping');
      } catch {
        // The close event owns reconnect scheduling when send races a disconnect.
      }
    }, RELAY_PING_INTERVAL);
    this.relayPingTimer.unref?.();
  }

  private disarmRelayPing(): void {
    if (this.relayPingTimer) clearInterval(this.relayPingTimer);
    this.relayPingTimer = undefined;
    this.missedRelayPongs = 0;
  }

  private log(event: string, context: Record<string, unknown> = {}): void {
    appendJsonl('direct-chat.jsonl', { provider: 'kick', event, ...context });
  }

  private stopCallbackServer(): void {
    if (this.callbackTimer) clearTimeout(this.callbackTimer);
    this.callbackTimer = undefined;
    this.callbackServer?.close();
    this.callbackServer = undefined;
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
    const identity = this.identity;
    let token = this.token;
    if (!identity || !token || !this.wantsConnection) return;
    if (token.expiresAt - Date.now() <= 60_000) {
      const creds = loadKickCreds();
      token = creds ? await this.ensureValidToken(creds) : undefined;
    }
    if (!token) return;
    try {
      const url = new URL(LIVESTREAMS_URL);
      url.searchParams.set('user_id', String(identity.userId));
      const response = await fetch(url, {
        headers: { authorization: `Bearer ${token.accessToken}` },
      });
      if (!response.ok) return;
      this.setViewerState(parseKickViewerState(await response.json()));
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

  private setState(
    status: DirectChatConnection['status'],
    detail?: string,
    lastError?: string,
    accountName?: string,
  ): void {
    this.state = {
      provider: 'kick',
      status,
      accountName: accountName ?? this.state.accountName,
      detail,
      lastError,
    };
    this.emit('state', this.getState());
  }
}

export function parseKickViewerState(payload: unknown): {
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

export function parseKickChannelIdentity(payload: unknown): KickIdentity | undefined {
  const data = record(payload).data;
  const channel = Array.isArray(data) ? record(data[0]) : {};
  return typeof channel.broadcaster_user_id === 'number' && typeof channel.slug === 'string'
    ? { userId: channel.broadcaster_user_id, name: channel.slug }
    : undefined;
}

export function normalizeKickRelayMessage(
  json: string,
  localUserId?: number,
): ChatMessage | undefined {
  let envelope: Record<string, unknown>;
  try {
    envelope = record(JSON.parse(json));
  } catch {
    return undefined;
  }
  if (envelope.kind !== 'kick.chat.message') return undefined;
  const event = record(envelope.event);
  const sender = record(event.sender);
  const identity = record(sender.identity);
  if (
    typeof event.message_id !== 'string' ||
    typeof event.content !== 'string' ||
    typeof sender.username !== 'string'
  ) {
    return undefined;
  }
  return {
    id: event.message_id,
    platform: 'kick',
    username: sender.username,
    text: event.content,
    ts: typeof event.created_at === 'string' ? Date.parse(event.created_at) || Date.now() : Date.now(),
    color: typeof identity.username_color === 'string' ? identity.username_color : undefined,
    self: typeof sender.user_id === 'number' && sender.user_id === localUserId,
    source: 'kick-direct',
    raw: event,
  };
}

export async function sendKickChatMessage({
  accessToken,
  broadcasterUserId,
  text,
  fetchImpl = fetch,
}: {
  accessToken: string;
  broadcasterUserId: number;
  text: string;
  fetchImpl?: typeof fetch;
}): Promise<DirectChatSendResult> {
  try {
    const response = await fetchImpl(CHAT_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        broadcaster_user_id: broadcasterUserId,
        content: text,
        type: 'user',
      }),
    });
    const payload = record(await response.json().catch(() => ({})));
    const result = record(payload.data);
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        authorizationRequired: response.status === 401 || response.status === 403,
        error: stringOr(payload.message, `Kick rejected the message (${response.status}).`),
      };
    }
    if (result.is_sent !== true) {
      return {
        ok: false,
        status: response.status,
        error: 'Kick did not send the message.',
      };
    }
    return {
      ok: true,
      status: response.status,
      messageId: typeof result.message_id === 'string' ? result.message_id : undefined,
    };
  } catch (error) {
    return { ok: false, error: `Kick send failed: ${errorMessage(error)}` };
  }
}

export function missingKickScopes(current: string, required: readonly string[]): string[] {
  const scopes = new Set(current.split(/\s+/).filter(Boolean));
  return required.filter((scope) => !scopes.has(scope));
}

export function kickToken(payload: Record<string, unknown>): KickTokenSet {
  return {
    accessToken: String(payload.access_token),
    refreshToken: String(payload.refresh_token),
    expiresAt: Date.now() + numberOr(payload.expires_in, 3_600) * 1_000,
    scope: typeof payload.scope === 'string' ? payload.scope : '',
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value ? value : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
