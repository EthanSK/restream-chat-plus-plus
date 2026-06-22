import React from 'react';
import { Virtuoso } from 'react-virtuoso';
import { rcpp } from './api';
import {
  ChatMessage,
  ConnectionState,
  PLATFORM_COLORS,
  PLATFORM_LABELS,
} from '../shared/types';
import { regexIgnoredBadgeLabel } from './message-filters';

interface Props {
  messages: ChatMessage[];
  authenticated: boolean;
  /**
   * The current WebSocket connection state, used as the SINGLE SOURCE OF
   * TRUTH for the empty-feed copy. Previously this component always said
   * "Listening for chat…" the moment the user was authenticated, even
   * before the WebSocket had connected — which then disagreed with the
   * toolbar status dot showing "idle" / "connecting" / "error". Deriving
   * the empty-feed message from `connection.status` keeps both halves of
   * the UI in lockstep.
   */
  connection: ConnectionState;
  /**
   * v0.1.91 (task: "silence user" button) — invoked by the per-row hover
   * "Silence user" button. App.tsx owns the persist round-trip; ChatFeed
   * just surfaces the affordance + relays the click. Optional so older
   * test-mount sites don't have to thread it through (tests that don't
   * exercise silence can omit it).
   *
   * RENAMED from `onHideUser` (v0.1.72): the action used to fully HIDE the
   * user (drop their rows from the feed). It now SILENCES them — their
   * messages still render but TTS skips them — by adding an anchored,
   * regex-escaped entry to `settings.filters.tts.ignoreUsernameRegex`.
   */
  onSilenceUser?: (username: string) => void;
  /**
   * v0.1.90 (voice 4512) — invoked when the user clicks the ⚠ on a
   * terminally-failed (retries-exhausted) self send. App.tsx re-runs the
   * whole bounded retry loop with the same clientReplyUuid. Optional so test
   * mounts that don't exercise retry can omit it.
   */
  onRetrySend?: (message: ChatMessage) => void;
}

/**
 * Right-click handler attached to the feed container — asks the main
 * process to pop a native context menu (Menu.buildFromTemplate + popup).
 * The native menu items dispatch back via the `chat:clear` IPC broadcast
 * which `App.tsx` consumes. v0.1.18.
 *
 * We use `preventDefault` to suppress Chromium's default DevTools-style
 * context menu, then fire-and-forget the IPC. Failures are swallowed —
 * a context menu refusing to open should not interrupt the UI.
 */
function onFeedContextMenu(e: React.MouseEvent<HTMLDivElement>): void {
  e.preventDefault();
  try {
    void rcpp.showChatContextMenu();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[ChatFeed] showChatContextMenu failed', err);
  }
}

export function ChatFeed({
  messages,
  authenticated,
  connection,
  onSilenceUser,
  onRetrySend,
}: Props): React.ReactElement {
  if (!authenticated) {
    return (
      <div className="feed" onContextMenu={onFeedContextMenu}>
        <div className="empty">
          <h2>Welcome to Restream Chat++</h2>
          <p>
            A native, cross-platform replacement for the official Restream Chat
            desktop app — built because the official one is x86 Electron under
            Rosetta and crashes on every audio queue.
          </p>
          <p>Sign in with Restream above to start streaming live chat into this
            window.</p>
        </div>
      </div>
    );
  }
  if (messages.length === 0) {
    return (
      <div className="feed" onContextMenu={onFeedContextMenu}>
        <div className="empty">
          <EmptyFeedBody connection={connection} />
        </div>
      </div>
    );
  }
  return (
    <div className="feed" onContextMenu={onFeedContextMenu}>
      <Virtuoso
        data={messages}
        followOutput="smooth"
        initialTopMostItemIndex={messages.length - 1}
        // v0.1.91 — thread `onSilenceUser` down to each row so the hover-
        // affordance button can fire without ChatFeed reaching back into
        // its own props inside the itemContent closure. Each MessageRow
        // independently decides whether to render the button (no-op when
        // the callback is undefined, e.g. test mounts that don't exercise
        // silence).
        itemContent={(_, m) => (
          <MessageRow message={m} onSilenceUser={onSilenceUser} onRetrySend={onRetrySend} />
        )}
      />
    </div>
  );
}

/**
 * Empty-feed body. Derives its title + body copy from the WebSocket
 * connection state so the UI never says "Listening for chat…" while the
 * toolbar status dot disagrees (e.g. status="idle"/"error"/"reconnecting").
 */
function EmptyFeedBody({
  connection,
}: {
  connection: ConnectionState;
}): React.ReactElement {
  switch (connection.status) {
    case 'connected':
      return (
        <>
          <h2>Listening for chat…</h2>
          <p>
            Connected to Restream. Once a viewer messages on any of your
            linked platforms, it&apos;ll show up here. If you&apos;ve sent a
            test message and nothing&apos;s arrived, open Logs → raw-frames.jsonl
            to see exactly what the WebSocket is forwarding.
          </p>
        </>
      );
    case 'connecting':
      return (
        <>
          <h2>Connecting to Restream…</h2>
          <p>Negotiating the WebSocket connection.</p>
        </>
      );
    case 'reconnecting':
      return (
        <>
          <h2>Reconnecting…</h2>
          <p>
            Attempt {connection.attempt}
            {connection.lastError ? ` — last error: ${connection.lastError}` : ''}
          </p>
        </>
      );
    case 'error':
      return (
        <>
          <h2>Connection error</h2>
          <p>{connection.lastError ?? 'Unknown error'}</p>
          <p>
            Check Logs → raw-frames.jsonl for details, or sign out + back in to
            re-run the OAuth flow.
          </p>
        </>
      );
    case 'disconnected':
      return (
        <>
          <h2>Disconnected</h2>
          <p>The WebSocket is currently closed. Sign out + back in to reconnect.</p>
        </>
      );
    case 'idle':
    default:
      return (
        <>
          <h2>Idle</h2>
          <p>
            The WebSocket hasn&apos;t started yet. If this persists for more
            than a few seconds after signing in, check Logs → raw-frames.jsonl
            for OAuth or connection errors.
          </p>
        </>
      );
  }
}

function MessageRow({
  message: m,
  onSilenceUser,
  onRetrySend,
}: {
  message: ChatMessage;
  // v0.1.91 — optional so test mounts that don't exercise the silence
  // affordance can leave this off; production always passes it via
  // ChatFeed → App.tsx → handleSilenceUser.
  onSilenceUser?: (username: string) => void;
  // v0.1.90 (voice 4512) — optional manual-retry relay (same rationale).
  onRetrySend?: (message: ChatMessage) => void;
}): React.ReactElement {
  // Self-originated messages (echoes of replies WE sent via the inline
  // send bar at the bottom of the feed) render visually distinct
  // — accent-tinted background + "You" username + "self" badge — so the
  // user can clearly tell their outgoing post landed without confusing it
  // for an incoming chat. v0.1.10 introduced this when we started
  // normalising reply_created frames as self ChatMessages.
  //
  // v0.1.26: when the message tripped one of the regex-ignore lists, we
  // also render a small subtle chip — "🔇 regex-ignored (TTS)" /
  // "🔕 regex-ignored (notif)" / "🔇🔕 regex-ignored" — next to the
  // message text. Muted color so it doesn't dominate; gives the user
  // immediate positional feedback that their regex matched.
  //
  // v0.1.40: self "common replies" (eventSourceId === 1 — broadcast to
  // ALL connected channels) are normalised with `platform: 'unknown'`
  // because there's no single destination platform. For those, hide the
  // platform colour-coding entirely and render a neutral "via Restream"
  // label instead of "Unknown" — that matches how the official
  // chat.restream.io page shows the same message ("sent by restream.io")
  // and avoids the pre-v0.1.40 bug where the badge looked random
  // because connectionIdentifier order varied between replies. Direct
  // self replies (eventSourceId === 2/13/20/etc. — sent to ONE specific
  // platform) keep their normal platform badge so the user can see which
  // channel a targeted reply landed on.
  const isSelfCommon = m.self === true && m.platform === 'unknown';
  const color = isSelfCommon
    ? undefined
    : (m.color || PLATFORM_COLORS[m.platform]);
  const platformLabel = isSelfCommon
    ? 'via Restream'
    : PLATFORM_LABELS[m.platform];
  const ignoredLabel = regexIgnoredBadgeLabel(m);
  // v0.1.43 — optimistic-send status indicators (only set on
  // locally-minted placeholders; see `ChatMessage.pendingSend` docstring).
  // `sending` → faint "sending…" hint next to the timestamp so the user
  // knows the POST hasn't completed yet. `failed` → small ⚠ next to the
  // message body whose tooltip carries `pendingError`. Failed messages
  // are never auto-removed; subsequent sends are never blocked by them.
  const isSending = m.pendingSend === 'sending';
  // v0.1.90 (voice 4512) — actively retrying via the bounded backoff loop.
  // Renders "sending… (retry N/5)" so the user SEES the message fighting to
  // deliver rather than silently disappearing.
  const isRetrying = m.pendingSend === 'retrying';
  const isFailed = m.pendingSend === 'failed';
  // The "(retry N/M)" suffix, only when we have both counters.
  const retryLabel =
    isRetrying &&
    typeof m.sendAttempt === 'number' &&
    typeof m.sendMaxAttempts === 'number'
      ? ` (retry ${m.sendAttempt}/${m.sendMaxAttempts})`
      : '';
  // Whether the ⚠ is an interactive "tap to retry" button (only on terminal
  // failures, only for our own sends, only when a retry handler is wired).
  const canRetry = isFailed && m.self === true && typeof onRetrySend === 'function';
  // v0.1.91 — only surface the Silence-user affordance for incoming
  // messages from a NAMED user. Silencing "You" (self echoes), the
  // anonymous "via Restream" common-reply rows, or messages with an empty
  // username would either be nonsensical ("silence myself") or poison the
  // TTS username ignore list with a meaningless `^$` pattern. The Silence
  // button is therefore gated on (a) not-self, (b) non-empty trimmed
  // username, (c) parent passed `onSilenceUser`. The button itself appears
  // via CSS hover on the row.
  const canSilence =
    !m.self &&
    typeof m.username === 'string' &&
    m.username.trim().length > 0 &&
    typeof onSilenceUser === 'function';
  return (
    <div
      className={
        `message-row${m.self ? ' self' : ''}` +
        (isSending ? ' pending-send' : '') +
        (isRetrying ? ' pending-send retrying' : '') +
        (isFailed ? ' send-failed' : '')
      }
    >
      <span
        className="platform-badge"
        style={color ? { background: color } : undefined}
      />
      <div className="message-meta">
        <div className="message-header">
          <span className="username" style={color ? { color } : undefined}>
            {m.username}
          </span>
          <span className="platform-label">{platformLabel}</span>
          {m.self && <span className="self-badge">self</span>}
          <span className="timestamp">{formatTs(m.ts)}</span>
          {isSending && (
            <span
              className="send-status-hint sending"
              title="Sending to Restream…"
              aria-label="Sending"
            >
              sending…
            </span>
          )}
          {/*
            v0.1.90 (voice 4512) — "sending… (retry N/5)" while the bounded
            exponential-backoff loop is actively re-trying (with a managed
            reconnect between attempts). Always visible so Ethan can SEE his
            message is being fought for, never silently dropped.
          */}
          {isRetrying && (
            <span
              className="send-status-hint retrying"
              title={`Retrying send to Restream…${retryLabel}`}
              aria-label={`Retrying${retryLabel}`}
            >
              {`sending…${retryLabel}`}
            </span>
          )}
          {/*
            v0.1.91 — per-row "Silence user" affordance (was "Hide user" in
            v0.1.72). Rendered last in the message-header so it sits at the
            right edge of the row. CSS .silence-user-btn defaults to
            `visibility: hidden` and the parent .message-row:hover
            .silence-user-btn flips it to `visible` — hover-reveal UX
            without an onMouseEnter / onMouseLeave state dance.

            On click: App.tsx adds an anchored, regex-escaped entry for
            `m.username` to `settings.filters.tts.ignoreUsernameRegex`, so
            the user's messages KEEP rendering in the feed but TTS skips
            them (vs the old hide which dropped the rows entirely). App.tsx
            owns the mutation + persist round-trip; ChatFeed is purely the
            relay surface.

            The 🔇 mute glyph matches the existing "🔇 regex-ignored (TTS)"
            chip language so the affordance reads as "mute this user from
            being read aloud".

            stopPropagation guards against the feed's right-click context
            menu opening — left clicks on the button shouldn't bubble up
            to a parent handler if a future redesign attaches one.
          */}
          {canSilence && (
            <button
              className="silence-user-btn"
              type="button"
              title={`Silence ${m.username} — their messages still show but TTS won't read them aloud`}
              aria-label={`Silence user ${m.username}`}
              onClick={(e) => {
                e.stopPropagation();
                onSilenceUser?.(m.username);
              }}
            >
              🔇 Silence user
            </button>
          )}
        </div>
        <div className="body">
          {m.text}
          {/*
            v0.1.90 (voice 4512) — terminal ⚠ after the 5x auto-retry loop
            exhausts. When a retry handler is wired (our own send), render it
            as a CLICKABLE "tap to retry" button that re-runs the whole loop;
            otherwise (no handler / not self) keep the static informational
            icon. The tooltip surfaces the underlying error either way so the
            user always knows WHY it failed.
          */}
          {isFailed &&
            (canRetry ? (
              <button
                type="button"
                className="send-failed-icon send-failed-retry"
                title={`${m.pendingError ?? 'Send failed.'} — tap to retry`}
                aria-label={`Send failed: ${m.pendingError ?? 'unknown error'}. Tap to retry.`}
                onClick={(e) => {
                  e.stopPropagation();
                  onRetrySend?.(m);
                }}
              >
                {'⚠'}
              </button>
            ) : (
              <span
                className="send-failed-icon"
                title={m.pendingError ?? 'Send failed.'}
                aria-label={`Send failed: ${m.pendingError ?? 'unknown error'}`}
                role="img"
              >
                {'⚠'}
              </span>
            ))}
          {ignoredLabel && (
            <span
              className="regex-ignored-badge"
              title="A pattern in Settings → Filters matched this message, so the corresponding side effect was suppressed."
            >
              {ignoredLabel}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function formatTs(ts: number): string {
  const d = new Date(ts);
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  return `${h}:${m}`;
}
