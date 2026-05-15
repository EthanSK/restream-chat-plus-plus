import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import type { ChatMessage, ConnectionState } from '../shared/types';
import { normalizeRestreamEvent } from './normalize';

const RESTREAM_WS_URL = 'wss://chat.api.restream.io/ws';
const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_BACKOFF_MS = 60_000;
const BASE_BACKOFF_MS = 1_000;

export interface ChatClientEvents {
  message: (m: ChatMessage) => void;
  state: (s: ConnectionState) => void;
  raw: (raw: unknown) => void;
}

/**
 * Restream Chat WebSocket subscriber.
 *
 * - Connects to wss://chat.api.restream.io/ws?accessToken=<bearer>
 * - Heartbeats with a periodic ping
 * - Reconnects with exponential backoff on close/error
 * - Normalises events through normalizeRestreamEvent and emits ChatMessage
 */
export class ChatClient extends EventEmitter {
  private ws?: WebSocket;
  private heartbeatTimer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private attempt = 0;
  private accessToken?: string;
  private stopped = false;
  private state: ConnectionState = { status: 'idle', attempt: 0 };

  setToken(token: string) {
    this.accessToken = token;
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    this.clearTimers();
    this.ws?.removeAllListeners();
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
    this.ws = undefined;
    this.setState({ status: 'disconnected', attempt: 0 });
  }

  getState(): ConnectionState {
    return this.state;
  }

  // ------------------------------------------------------------------
  // internals
  // ------------------------------------------------------------------

  private connect() {
    if (!this.accessToken) {
      this.setState({ status: 'error', attempt: this.attempt, lastError: 'no token' });
      return;
    }
    this.setState({
      status: this.attempt === 0 ? 'connecting' : 'reconnecting',
      attempt: this.attempt,
    });
    const url = `${RESTREAM_WS_URL}?accessToken=${encodeURIComponent(this.accessToken)}`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on('open', () => {
      this.attempt = 0;
      this.setState({ status: 'connected', attempt: 0 });
      this.startHeartbeat();
    });

    ws.on('message', (data) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        return;
      }
      this.emit('raw', parsed);
      const msg = normalizeRestreamEvent(parsed);
      if (msg) this.emit('message', msg);
    });

    ws.on('pong', () => {
      // healthy
    });

    ws.on('close', (code, reason) => {
      this.handleDisconnect(`close ${code} ${reason?.toString() ?? ''}`);
    });

    ws.on('error', (err) => {
      this.handleDisconnect(err.message || 'ws error');
    });
  }

  private handleDisconnect(reason: string) {
    this.clearTimers();
    if (this.stopped) return;
    this.attempt += 1;
    const backoff = Math.min(
      MAX_BACKOFF_MS,
      BASE_BACKOFF_MS * Math.pow(2, Math.min(10, this.attempt - 1)),
    );
    this.setState({ status: 'reconnecting', attempt: this.attempt, lastError: reason });
    this.reconnectTimer = setTimeout(() => this.connect(), backoff);
  }

  private startHeartbeat() {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        try {
          this.ws.ping();
        } catch {
          // ignore — next reconnect will handle
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private clearHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private clearTimers() {
    this.clearHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private setState(s: ConnectionState) {
    this.state = s;
    this.emit('state', s);
  }
}

// Re-export Backoff math for unit tests.
export const __test_backoff_for = (attempt: number): number =>
  Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * Math.pow(2, Math.min(10, attempt - 1)));
