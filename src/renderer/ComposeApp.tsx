import React, { useEffect, useRef, useState } from 'react';
import { rcpp } from './api';
import type { SendTextResult } from '../shared/types';

/**
 * Native React Compose window (v0.1.32+).
 *
 * Replaces the pre-v0.1.32 720×720 chat.restream.io BrowserWindow that
 * the Compose button used to open. This component renders a small
 * Messages/Slack-thread-reply-style UI:
 *
 *   - multi-line textarea (auto-grow up to 6 lines)
 *   - Send button (Enter to send, Shift+Enter for newline)
 *   - status row with connected/offline dot
 *   - "Always on top" checkbox (persisted across launches)
 *   - escape hatch: "Open Restream webchat" link
 *
 * The send path is `rcpp.sendChatText` — identical to the inline input
 * bar in the main window — so we automatically get the v0.1.30 404
 * retry + showId refresh hardening for free, plus the 1-msg/sec rate
 * limit, REST cache, etc.
 */
export function ComposeApp(): React.ReactElement {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [alwaysOnTop, setAlwaysOnTop] = useState(false);
  const [connected, setConnected] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [err, setErr] = useState<string | undefined>();
  const [hint, setHint] = useState<string | undefined>();
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  // Pull initial state on mount.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const init = await rcpp.composeGetInit();
        if (!alive) return;
        setAlwaysOnTop(init.alwaysOnTop);
        setConnected(init.connected);
        setAuthenticated(init.authenticated);
      } catch (e) {
        console.error('[ComposeApp] composeGetInit failed', e);
      }
    })();
    // Stay in sync with the parent app's live connection state so the
    // send button enables/disables when the WS reconnects.
    const offConn = rcpp.onConnectionState((s) => {
      setConnected(s.status === 'connected');
    });
    const offAuth = rcpp.onAuthStatus((s) => {
      setAuthenticated(s.authenticated);
    });
    return () => {
      alive = false;
      offConn();
      offAuth();
    };
  }, []);

  // Auto-grow textarea up to 6 lines (~108px).
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(108, el.scrollHeight) + 'px';
  }, [text]);

  // Focus the textarea on mount so the user can just start typing.
  useEffect(() => {
    taRef.current?.focus();
  }, []);

  const doSend = async () => {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    setErr(undefined);
    setHint(undefined);
    try {
      const result: SendTextResult = await rcpp.sendChatText(value);
      if (result.ok) {
        setText('');
        setHint('Sent.');
        setTimeout(() => setHint(undefined), 1400);
      } else {
        setErr(prettyReason(result));
      }
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setTimeout(() => setBusy(false), 220);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void doSend();
    }
  };

  const onToggleAlwaysOnTop = async (next: boolean) => {
    setAlwaysOnTop(next);
    try {
      await rcpp.composeSetAlwaysOnTop(next);
    } catch (e) {
      console.error('[ComposeApp] setAlwaysOnTop failed', e);
    }
  };

  const onOpenWebchat = async () => {
    setErr(undefined);
    try {
      const result = await rcpp.openRestreamWebchat();
      if (!result.ok) {
        setErr('Couldn’t open Restream webchat.');
      }
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    }
  };

  const canSend = authenticated && connected && !busy && text.trim().length > 0;
  const placeholder = !authenticated
    ? 'Sign in to Restream first…'
    : !connected
      ? 'Waiting for Restream connection…'
      : 'Type a chat message — Enter to send, Shift+Enter for newline';

  return (
    <div className="compose-window">
      <div className="compose-row compose-status-row">
        <span className={`status-dot ${connected ? 'connected' : 'disconnected'}`} />
        <span className="compose-status-label">
          {!authenticated
            ? 'Not signed in'
            : connected
              ? 'Connected'
              : 'Disconnected'}
        </span>
        <span className="spacer" />
        <label className="compose-aot">
          <input
            type="checkbox"
            checked={alwaysOnTop}
            onChange={(e) => void onToggleAlwaysOnTop(e.target.checked)}
          />
          Always on top
        </label>
      </div>
      <textarea
        ref={taRef}
        className="compose-textarea"
        value={text}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        rows={2}
        disabled={busy || !authenticated || !connected}
        aria-label="Chat message"
      />
      <div className="compose-row compose-actions-row">
        <button
          type="button"
          className="btn ghost compose-webchat-btn"
          onClick={() => void onOpenWebchat()}
          title="Open Restream's webchat (emoji picker, per-platform targeting, cookie refresh)"
        >
          Open Restream webchat
        </button>
        <span className="spacer" />
        {err && <span className="compose-err" role="alert">{err}</span>}
        {!err && hint && <span className="compose-hint">{hint}</span>}
        <button
          type="button"
          className="btn primary compose-send-btn"
          onClick={() => void doSend()}
          disabled={!canSend}
          title="Send (Enter)"
        >
          {busy ? '…' : 'Send'}
        </button>
      </div>
    </div>
  );
}

function prettyReason(result: SendTextResult): string {
  switch (result.reason) {
    case 'not-authenticated':
      return 'Sign in to Restream first.';
    case 'no-session-cookies':
      return 'Chat session not provisioned — open Restream webchat once to sign in.';
    case 'no-active-connections':
      return 'No connected channels to reply to.';
    case 'no-show-id':
      return 'No active Restream show — start streaming first.';
    case 'send-failed':
      return `Send failed${result.status ? ` (HTTP ${result.status})` : ''}${result.error ? ` — ${result.error}` : ''}.`;
    case 'error':
      return result.error ?? 'Send failed.';
    default:
      return 'Send failed.';
  }
}
