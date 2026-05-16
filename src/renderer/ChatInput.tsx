import React, { useState } from 'react';
import { rcpp } from './api';

interface Props {
  authenticated: boolean;
  connected: boolean;
}

/**
 * Chat input bar.
 *
 * IMPORTANT API CONSTRAINT — Restream's public Chat API is RECEIVE-ONLY
 * for third-party clients ("This API works one way — from the server to
 * the client. The server will ignore any incoming messages." —
 * https://developers.restream.io/chat/getting-started). There is no
 * documented REST or WS endpoint third-party apps can call to send a
 * chat message; the official Restream Chat app uses an undocumented
 * internal API.
 *
 * To still give Ethan a working "send" affordance without reverse-
 * engineering Restream's private API, we delegate to Restream's own
 * first-party webchat URL (returned by GET /v2/user/webchat/url). The
 * Compose button opens that URL in a dedicated BrowserWindow next to
 * the main feed. When the user sends a message from THAT window, the
 * private API does the actual cross-platform fan-out and the WS
 * rebroadcasts the result to every subscriber including us, as a
 * `reply_created` action. Our normaliser turns those into `self: true`
 * ChatMessages so the outgoing reply appears inline in our feed.
 *
 * If/when Restream documents a real third-party send endpoint we'll
 * replace this with an in-place input.
 */
export function ChatInput({ authenticated, connected }: Props): React.ReactElement | null {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | undefined>();

  if (!authenticated) return null;

  const onOpen = async () => {
    if (busy) return;
    setBusy(true);
    setErr(undefined);
    try {
      const result = await rcpp.openCompose();
      if (!result.ok) {
        setErr(prettyReason(result.reason, result.status));
      }
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      // Floor the busy spinner so the button doesn't flash on a fast
      // round-trip; the new BrowserWindow appears almost instantly.
      setTimeout(() => setBusy(false), 350);
    }
  };

  return (
    <div className="chat-input">
      <button
        type="button"
        className="btn primary chat-input-btn"
        onClick={() => void onOpen()}
        disabled={busy || !connected}
        title={
          connected
            ? 'Send a chat message via Restream webchat'
            : 'Reconnect to Restream first'
        }
      >
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
        {busy ? 'Opening…' : 'Compose'}
      </button>
      <span className="chat-input-hint">
        Opens Restream&apos;s official compose window. Replies you send
        appear here as <em>self</em> messages.
      </span>
      {err && <span className="chat-input-err">{err}</span>}
    </div>
  );
}

function prettyReason(
  reason: 'not-authenticated' | 'webchat-fetch-failed' | 'no-webchat-url' | 'error',
  status?: number,
): string {
  switch (reason) {
    case 'not-authenticated':
      return 'Sign in to Restream first.';
    case 'webchat-fetch-failed':
      return `Couldn't fetch webchat URL${status ? ` (HTTP ${status})` : ''}.`;
    case 'no-webchat-url':
      return 'Restream returned no webchat URL.';
    case 'error':
    default:
      return 'Failed to open compose window.';
  }
}
