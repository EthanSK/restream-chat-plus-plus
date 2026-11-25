import React from 'react';
import { Virtuoso } from 'react-virtuoso';
import { rcpp } from './api';
import type { ChatHistoryStatus } from './useChatHistory';
import {
  ChatMessage,
  ConnectionState,
  PLATFORM_COLORS,
  PLATFORM_LABELS,
} from '../shared/types';
import { regexIgnoredBadgeLabel } from './message-filters';

interface Props {
  messages: ChatMessage[];
  firstItemIndex?: number;
  historyControls?: HistoryControls;
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
  onSetUserSilenced?: (username: string, silenced: boolean) => void;
  onHideUser?: (username: string) => void;
  isUserSilenced?: (username: string) => boolean;
  getMessageFilterFlags?: (message: ChatMessage) => MessageFilterFlags;
  /**
   * v0.1.90 (voice 4512) — invoked when the user clicks the ⚠ on a
   * terminally-failed (retries-exhausted) self send. App.tsx re-runs the
   * whole bounded retry loop with the same clientReplyUuid. Optional so test
   * mounts that don't exercise retry can omit it.
   */
  onRetrySend?: (message: ChatMessage) => void;
}

type MessageFilterFlags = Pick<ChatMessage, 'ignoredByTts' | 'ignoredByNotifications'>;

interface HistoryControls {
  status: ChatHistoryStatus;
  loadOlder: () => void;
}

function ChatHistoryHeader({ context }: { context?: HistoryControls }): React.ReactElement | null {
  if (!context) return null;
  return (
    <div className="chat-history-header">
      {context.status === 'exhausted' ? (
        <span role="status">No older messages</span>
      ) : (
        <button
          type="button"
          className="btn ghost"
          disabled={context.status === 'loading'}
          onClick={context.loadOlder}
        >
          {context.status === 'loading' ? 'Loading…' : 'Load older messages'}
        </button>
      )}
      {context.status === 'error' && <span role="status">Couldn’t load older messages</span>}
    </div>
  );
}

const feedComponents = { Header: ChatHistoryHeader };

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
  firstItemIndex,
  historyControls,
  authenticated,
  connection,
  onSetUserSilenced,
  onHideUser,
  isUserSilenced,
  getMessageFilterFlags,
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
      <div className="feed feed-empty" onContextMenu={onFeedContextMenu}>
        <ChatHistoryHeader context={historyControls} />
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
        // With prepended history, the live rows keep their virtual indices.
        firstItemIndex={firstItemIndex}
        components={feedComponents}
        context={historyControls}
        followOutput="smooth"
        initialTopMostItemIndex={messages.length - 1}
        itemContent={(_, m) => (
          <MessageRow
            message={m}
            onSetUserSilenced={onSetUserSilenced}
            onHideUser={onHideUser}
            silenced={isUserSilenced?.(m.username)}
            filterFlags={getMessageFilterFlags?.(m)}
            onRetrySend={onRetrySend}
          />
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

export function MessageRow({
  message: m,
  onSetUserSilenced,
  onHideUser,
  silenced = false,
  filterFlags,
  onRetrySend,
}: {
  message: ChatMessage;
  onSetUserSilenced?: Props['onSetUserSilenced'];
  onHideUser?: Props['onHideUser'];
  silenced?: boolean;
  filterFlags?: MessageFilterFlags;
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
  // Compute badge state from current filters so Unsilence clears existing rows too. Found and fixed by GPT-6.2 Sol.
  const ignoredLabel = regexIgnoredBadgeLabel(filterFlags ?? m);
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
  const isNamedViewer = !m.self && typeof m.username === 'string' && m.username.trim().length > 0;
  const silenceAction = silenced ? 'Unsilence user' : 'Silence user';
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
          {isNamedViewer && onSetUserSilenced && (
            <button
              className={silenced ? 'silence-user-btn silenced' : 'silence-user-btn'}
              type="button"
              title={silenced ? undefined : `Silence ${m.username} — their messages still show, but TTS and notifications stop`}
              aria-label={`${silenceAction} ${m.username}`}
              onClick={(e) => {
                e.stopPropagation();
                onSetUserSilenced(m.username, !silenced);
              }}
            >
              {silenced ? silenceAction : `🔇 ${silenceAction}`}
            </button>
          )}
          {isNamedViewer && onHideUser && (
            <button
              className="hide-user-btn"
              type="button"
              title={`Hide ${m.username} — their messages disappear from RC++ and stop triggering TTS and notifications`}
              aria-label={`Hide ${m.username}`}
              onClick={(e) => {
                e.stopPropagation();
                onHideUser?.(m.username);
              }}
            >
              Hide user
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
