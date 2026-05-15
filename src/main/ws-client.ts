import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ChatMessage, ConnectionState } from '../shared/types';
import { normalizeRestreamEventDetailed } from './normalize';

/**
 * Resolve Electron's `app` lazily so this module can also be imported from
 * unit tests where the `electron` module isn't available. Returns undefined
 * outside of an Electron main-process context.
 */
function tryGetElectronApp(): { getPath?: (name: string) => string } | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('electron')?.app;
  } catch {
    return undefined;
  }
}

const RESTREAM_WS_URL = 'wss://chat.api.restream.io/ws';
const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_BACKOFF_MS = 60_000;
const BASE_BACKOFF_MS = 1_000;
const RAW_LOG_MAX_BYTES = 5 * 1024 * 1024; // 5 MiB before rotating

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
  private rawLogPath?: string;
  private rawLogResolved = false;

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
      const text = data.toString();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        this.appendRawLog({ kind: 'parse-error', text, err: String(err) });
        return;
      }
      this.appendRawLog({ kind: 'frame', frame: parsed });
      this.emit('raw', parsed);
      const result = normalizeRestreamEventDetailed(parsed);
      if (result.message) {
        this.emit('message', result.message);
      } else if (result.drop) {
        // Surface silent drops so we can see why a real event isn't reaching
        // the UI. Heartbeats and connection_info will fall through as
        // 'not-event-action' — those are expected. 'no-text' on an event
        // action is the interesting one (= shape mismatch we should fix).
        if (result.drop.reason !== 'not-event-action') {
          this.appendRawLog({
            kind: 'drop',
            reason: result.drop.reason,
            eventTypeId: result.drop.eventTypeId,
            frame: parsed,
          });
        }
      }
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

  // ------------------------------------------------------------------
  // raw-frame logging
  // ------------------------------------------------------------------

  /**
   * Append a single record (one JSON object per line — JSONL) to the raw
   * frame log. Path resolves to:
   *   macOS:   ~/Library/Logs/Restream Chat Plus Plus/raw-frames.jsonl
   *   linux:   ~/.config/Restream Chat Plus Plus/logs/raw-frames.jsonl
   *   win:     %APPDATA%/Restream Chat Plus Plus/logs/raw-frames.jsonl
   *
   * The file rotates once it exceeds 5 MiB (renamed to .1, current file
   * truncated). Failures are swallowed — logging must never break delivery.
   */
  private appendRawLog(record: Record<string, unknown>): void {
    try {
      const p = this.resolveRawLogPath();
      if (!p) return;
      const line =
        JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n';
      // Rotate if over the cap.
      try {
        const st = fs.statSync(p);
        if (st.size > RAW_LOG_MAX_BYTES) {
          fs.renameSync(p, p + '.1');
        }
      } catch {
        // file may not exist yet — fine
      }
      fs.appendFileSync(p, line, 'utf8');
    } catch {
      // never break delivery on a logging failure
    }
  }

  private resolveRawLogPath(): string | undefined {
    if (this.rawLogResolved) return this.rawLogPath;
    this.rawLogResolved = true;
    try {
      let dir: string;
      // `app` may be undefined in unit tests; guard accordingly.
      const electronApp = tryGetElectronApp();
      if (electronApp && typeof electronApp.getPath === 'function') {
        // electron's 'logs' path is platform-appropriate already.
        dir = electronApp.getPath('logs');
      } else if (process.platform === 'darwin') {
        dir = path.join(os.homedir(), 'Library', 'Logs', 'Restream Chat Plus Plus');
      } else if (process.platform === 'win32') {
        dir = path.join(
          process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'),
          'Restream Chat Plus Plus',
          'logs',
        );
      } else {
        dir = path.join(os.homedir(), '.config', 'Restream Chat Plus Plus', 'logs');
      }
      fs.mkdirSync(dir, { recursive: true });
      this.rawLogPath = path.join(dir, 'raw-frames.jsonl');
      return this.rawLogPath;
    } catch {
      this.rawLogPath = undefined;
      return undefined;
    }
  }
}

// Re-export Backoff math for unit tests.
export const __test_backoff_for = (attempt: number): number =>
  Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * Math.pow(2, Math.min(10, attempt - 1)));
