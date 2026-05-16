import React, { useEffect, useRef, useState } from 'react';
import { rcpp } from './api';
import type { SendTextResult } from '../shared/types';

interface Props {
  authenticated: boolean;
  connected: boolean;
}

/**
 * Inline chat input bar (v0.1.14).
 *
 * Sits at the bottom of the main feed and POSTs directly to Restream's
 * internal `/api/v2/client/reply` endpoint via the main-process handler
 * (`CHAT_SEND_TEXT`). Successful sends DO NOT optimistically render —
 * Restream's WS rebroadcasts the message as a `reply_created` frame
 * which our normaliser already surfaces as a `self: true` ChatMessage
 * in the feed.
 *
 * Keyboard contract:
 *   - Enter           — send (when not busy and text is non-empty)
 *   - Shift+Enter     — newline
 *   - Cmd/Ctrl+Enter  — also sends (matches Slack/Discord muscle memory)
 *
 * Fallback: a small "Compose" button next to the input opens Restream's
 * official webchat in a separate BrowserWindow. This is the recovery path
 * for "Cookie expired — click Compose to refresh session" + for anyone
 * who wants Restream's full reply UI (emoji, per-platform targeting, etc).
 *
 * The cold-start cookie provisioning is handled transparently in the
 * main process — first send may take a beat while it spawns an invisible
 * Compose window to populate `persist:restream-oauth`'s cookie jar.
 */
export function ChatInputInline({
  authenticated,
  connected,
}: Props): React.ReactElement | null {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [composing, setComposing] = useState(false);
  const [err, setErr] = useState<string | undefined>();
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  // Hide entirely until the user is signed in.
  if (!authenticated) return null;

  // Auto-grow the textarea height as the user types (max 4 visible lines).
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(96, el.scrollHeight) + 'px';
  }, [text]);

  const doSend = async () => {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    setErr(undefined);
    try {
      const result: SendTextResult = await rcpp.sendChatText(value);
      if (result.ok) {
        setText('');
      } else {
        setErr(prettyReason(result));
      }
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      // Floor the spinner so the button doesn't strobe on instant rejections
      // (e.g. the 1-msg/sec rate-limiter).
      setTimeout(() => setBusy(false), 220);
    }
  };

  const onCompose = async () => {
    setComposing(true);
    setErr(undefined);
    try {
      const result = await rcpp.openCompose();
      if (!result.ok) {
        setErr(prettyComposeReason(result.reason));
      }
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setTimeout(() => setComposing(false), 250);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Send on Enter; Shift+Enter / Cmd-or-Ctrl+Enter mean newline / send-extra.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void doSend();
    }
  };

  const placeholder = connected
    ? 'Send a chat message — Enter to send, Shift+Enter for newline'
    : 'Waiting for Restream connection…';

  return (
    <div className="chat-input chat-input-inline">
      <textarea
        ref={taRef}
        className="chat-input-text"
        value={text}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        rows={1}
        disabled={busy || !connected}
        aria-label="Chat message"
      />
      <button
        type="button"
        className="btn primary chat-input-send"
        onClick={() => void doSend()}
        disabled={busy || !connected || text.trim().length === 0}
        title="Send"
        aria-label="Send"
      >
        {busy ? '…' : (
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M22 2L11 13" />
            <path d="M22 2L15 22L11 13L2 9L22 2Z" />
          </svg>
        )}
      </button>
      <button
        type="button"
        className="btn ghost chat-input-compose-fallback"
        onClick={() => void onCompose()}
        disabled={composing}
        title="Open Restream's official webchat compose window"
        aria-label="Open Compose window"
      >
        {composing ? 'Opening…' : 'Compose'}
      </button>
      {err && <span className="chat-input-err">{err}</span>}
    </div>
  );
}

function prettyReason(result: SendTextResult): string {
  switch (result.reason) {
    case 'not-authenticated':
      return 'Sign in to Restream first.';
    case 'no-session-cookies':
      return 'Chat session not provisioned — click Compose once to sign in to chat.';
    case 'no-active-connections':
      return 'No connected channels to reply to.';
    case 'send-failed':
      return `Send failed${result.status ? ` (HTTP ${result.status})` : ''}${result.error ? ` — ${result.error}` : ''}. Click Compose to refresh session.`;
    case 'error':
      return result.error ?? 'Send failed.';
    default:
      return 'Send failed.';
  }
}

function prettyComposeReason(
  reason: 'not-authenticated' | 'webchat-fetch-failed' | 'no-webchat-url' | 'error',
): string {
  switch (reason) {
    case 'not-authenticated':
      return 'Sign in to Restream first.';
    case 'webchat-fetch-failed':
    case 'no-webchat-url':
      return 'Couldn’t fetch webchat URL — opened chat.restream.io as fallback.';
    case 'error':
    default:
      return 'Failed to open compose window.';
  }
}
