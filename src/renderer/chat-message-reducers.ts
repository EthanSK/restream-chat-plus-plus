import type { ChatMessage, ChatSendStatus } from '../shared/types';

/**
 * v0.1.43 — pure reducers for the optimistic-send chat-message flow.
 *
 * These helpers back the inline App.tsx `setMessages` callbacks that
 * drive the renderer's chat feed:
 *
 *   1. `pushOptimisticMessage`  — the user just hit Enter; mint the
 *      placeholder and append (capping at MAX_MESSAGES).
 *   2. `dedupeOptimisticOnEcho` — a WS `reply_created` arrived. If a
 *      placeholder with the matching `id` is in the feed, replace it
 *      with the echo; otherwise just append.
 *   3. `applyFailedSendStatus`  — main-process queue reported a failed
 *      send. Find the placeholder, mark `pendingSend: 'failed'`,
 *      stash `pendingError` for the ⚠ tooltip.
 *
 * Extracting these to a pure module makes them unit-testable without
 * having to mount App.tsx + stub the entire IPC surface. App.tsx still
 * owns the `useState` calls and the IPC subscriptions; the reducers
 * just describe how new state is computed.
 */

const MAX_MESSAGES_DEFAULT = 1000;

/**
 * Append an optimistic placeholder to `prev`. Caps the buffer at
 * `maxMessages` (defaults to the same 1000 App.tsx uses).
 */
export function pushOptimisticMessage(
  prev: ChatMessage[],
  placeholder: ChatMessage,
  maxMessages = MAX_MESSAGES_DEFAULT,
): ChatMessage[] {
  const next = [...prev, placeholder];
  if (next.length > maxMessages) next.splice(0, next.length - maxMessages);
  return next;
}

/**
 * Merge an incoming ChatMessage. If `prev` already contains a
 * placeholder (`pendingSend !== undefined`) with the same id, REPLACE
 * it with `incoming` (the WS echo). Otherwise append normally.
 *
 * The dedupe key is `id` because the renderer mints `clientId` and
 * ships it down as Restream's `clientReplyUuid`; the WS rebroadcasts
 * a `reply_created` echo whose normalised `id` equals that uuid (see
 * `src/main/normalize.ts`).
 */
export function dedupeOptimisticOnEcho(
  prev: ChatMessage[],
  incoming: ChatMessage,
  maxMessages = MAX_MESSAGES_DEFAULT,
): ChatMessage[] {
  const dupIdx = prev.findIndex(
    (m) => m.id === incoming.id && m.pendingSend !== undefined,
  );
  let next: ChatMessage[];
  if (dupIdx !== -1) {
    next = prev.slice();
    next[dupIdx] = incoming;
  } else {
    next = [...prev, incoming];
  }
  if (next.length > maxMessages) next.splice(0, next.length - maxMessages);
  return next;
}

/**
 * Flip the matching optimistic placeholder to `pendingSend: 'failed'`
 * and stash `pendingError` so the ⚠ tooltip in the chat feed shows the
 * actionable reason. If no matching placeholder exists (e.g. the WS
 * echo already replaced it, or the renderer remounted), this is a
 * no-op.
 *
 * A failed send NEVER blocks subsequent sends — that's enforced at the
 * queue layer; this reducer just paints the failure into the feed.
 */
export function applyFailedSendStatus(
  prev: ChatMessage[],
  status: ChatSendStatus,
): ChatMessage[] {
  if (status.status !== 'failed') return prev;
  const idx = prev.findIndex(
    (m) => m.id === status.clientId && m.pendingSend !== undefined,
  );
  if (idx === -1) return prev;
  const next = prev.slice();
  next[idx] = {
    ...next[idx],
    pendingSend: 'failed',
    pendingError: formatPendingError(status),
  };
  return next;
}

/**
 * v0.1.60 — decide whether a freshly-observed `lastMessage` should
 * trigger one-shot side effects (TTS speak + native notification).
 *
 * Two failure modes this guards against:
 *
 *   1. Optimistic-insert dupe (the v0.1.60 bug). When the user hits
 *      Enter, App.tsx synchronously inserts a placeholder with
 *      `pendingSend: 'sending'`. The WS echo arrives ~50–500 ms later
 *      and `dedupeOptimisticOnEcho` REPLACES the placeholder in place
 *      with the real echo (no `pendingSend`). Both state transitions
 *      change the `messages` array reference, so the App.tsx
 *      side-effect useEffect re-fires for BOTH. Without this gate, the
 *      send-sound plays twice: once on Enter (placeholder), once on
 *      echo (confirmed sent). Voice 2026-05-23 — "I hear double
 *      messages sent. One when I click enter, one when it's sent."
 *
 *      Fix: skip when `pendingSend !== undefined`. Only the confirmed
 *      echo (which clears `pendingSend`) triggers the side effect.
 *
 *   2. Same-id reprocessing. The dedupe replacement keeps the same
 *      `id`, and if an UNRELATED incoming message had bumped past the
 *      placeholder before the echo arrived, the array's last element
 *      doesn't change identity when the placeholder mid-array is
 *      replaced — but the array reference still does, so the useEffect
 *      re-fires and would re-speak that unrelated last message. Guard
 *      by remembering the id of the last message we acted on.
 *
 * Returns `true` when the side effect should fire. `lastProcessedId`
 * is the id we most-recently spoke (or `undefined` on first call).
 */
export function shouldTriggerSideEffects(
  lastMessage: ChatMessage | undefined,
  lastProcessedId: string | undefined,
): boolean {
  if (!lastMessage) return false;
  // Optimistic placeholders (sending) or failed-send entries are not
  // "actually-sent" — never speak them. Only confirmed echoes (no
  // pendingSend) qualify.
  if (lastMessage.pendingSend !== undefined) return false;
  // Same-id reprocessing guard (see docstring case 2).
  if (lastMessage.id === lastProcessedId) return false;
  return true;
}

/**
 * Compose the tooltip text for a failed send. Prefers the queue's
 * `error` (which is the Restream response body excerpt for `send-failed`
 * + the reason code for `error`), falling back to a generic message
 * constructed from `reason` + `httpStatus`.
 */
export function formatPendingError(status: ChatSendStatus): string {
  if (status.error) return status.error;
  if (status.reason) {
    const httpSuffix = status.httpStatus ? ` HTTP ${status.httpStatus}` : '';
    return `Send failed (${status.reason}${httpSuffix})`;
  }
  return 'Send failed.';
}
