import React, { useEffect, useRef, useState } from 'react';
import { rcpp } from './api';
import type { SendTextResult } from '../shared/types';

interface Props {
  authenticated: boolean;
  connected: boolean;
}

/**
 * Inline chat input bar.
 *
 * Sits at the bottom of the main feed and POSTs directly to Restream's
 * internal `/client/reply` endpoint via the main-process handler
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
 * v0.1.34: the separate "Compose" window (v0.1.32-v0.1.33) was a wash —
 * it called the SAME `rcpp.sendChatText` IPC as this inline input, so
 * any send bug here also broke Compose. Removing it kept the surface
 * area honest. The "Open Restream webchat" escape-hatch button remains
 * (next to send) for users who need Restream's full reply UI
 * (emoji picker, per-platform channel targeting) or to refresh expired
 * session cookies.
 *
 * The cold-start cookie provisioning is handled transparently in the
 * main process — first send may take a beat while it spawns an invisible
 * helper window to populate `persist:restream-oauth`'s cookie jar.
 */
export function ChatInputInline({
  authenticated,
  connected,
}: Props): React.ReactElement | null {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [openingWebchat, setOpeningWebchat] = useState(false);
  const [err, setErr] = useState<string | undefined>();
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  // Auto-grow the textarea height as the user types (cap at 6 visible lines
  // ~= 144px). v0.1.34: bumped from 4 lines (96px) since the separate
  // Compose window was removed — multi-line composition now happens here.
  //
  // IMPORTANT: This hook MUST sit ABOVE the `if (!authenticated) return null`
  // early-return below. Hooks must run in the same order on every render —
  // declaring useState/useRef before the early-return and useEffect AFTER it
  // means the hook count jumps from 5 → 6 the moment `authenticated` flips
  // from false → true, which trips React's "Rendered more hooks than during
  // the previous render" guard (production error #310) and blanks the entire
  // app. v0.1.15 surfaced this every launch because the new
  // `startupAuthDone` gating in main.ts guarantees the renderer always boots
  // with `authenticated: false` and flips to true a tick later (instead of
  // the synchronous-resume path that occasionally masked the hook ordering
  // bug in v0.1.14). v0.1.16 fix.
  useEffect(() => {
    if (!authenticated) return;
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(144, el.scrollHeight) + 'px';
  }, [text, authenticated]);

  // Hide entirely until the user is signed in. MUST stay below ALL hooks.
  if (!authenticated) return null;

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

  const onOpenWebchat = async () => {
    setOpeningWebchat(true);
    setErr(undefined);
    try {
      const result = await rcpp.openRestreamWebchat();
      if (!result.ok) {
        setErr(prettyWebchatReason(result.reason));
      }
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setTimeout(() => setOpeningWebchat(false), 250);
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
        onClick={() => void onOpenWebchat()}
        disabled={openingWebchat}
        title="Open Restream's official webchat (emoji picker, per-platform targeting, cookie refresh)"
        aria-label="Open Restream webchat"
      >
        {openingWebchat ? 'Opening…' : 'Webchat'}
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
      return 'Chat session not provisioned — open Webchat once to sign in to chat.';
    case 'no-active-connections':
      return 'No connected channels to reply to.';
    case 'no-show-id':
      return 'No active Restream show — start streaming (or send one message from Restream’s website) so we can pick up the event.';
    case 'send-failed':
      return `Send failed${result.status ? ` (HTTP ${result.status})` : ''}${result.error ? ` — ${result.error}` : ''}. Open Webchat to refresh session.`;
    case 'error':
      return result.error ?? 'Send failed.';
    default:
      return 'Send failed.';
  }
}

function prettyWebchatReason(
  reason: 'not-authenticated' | 'webchat-fetch-failed' | 'no-webchat-url' | 'error',
): string {
  switch (reason) {
    case 'not-authenticated':
      return 'Sign in to Restream first.';
    case 'webchat-fetch-failed':
    case 'no-webchat-url':
      return 'Could not fetch the webchat URL from Restream.';
    case 'error':
    default:
      return 'Failed to open Restream webchat.';
  }
}
