import type { ChatMessage, ChatSendStatus } from '../shared/types';
import { formatSendFailureTooltip } from './send-failure-copy';

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
  // v0.1.90 (voice 4512) — terminal failure. Strip the transient retry
  // counters (sendAttempt/sendMaxAttempts) so the row renders the plain ⚠
  // "failed — tap to retry" affordance rather than "(retry N/5)". The retry
  // loop is OVER at this point.
  const resolved = { ...next[idx] };
  delete resolved.sendAttempt;
  delete resolved.sendMaxAttempts;
  resolved.pendingSend = 'failed';
  resolved.pendingError = formatPendingError(status);
  next[idx] = resolved;
  return next;
}

/**
 * v0.1.90 (voice 4512) — flip the matching optimistic placeholder to
 * `pendingSend: 'retrying'` and stash the attempt counters so the feed can
 * render "sending… (retry N/5)". This is the visible "it is actively fighting
 * to deliver your message" state — Ethan's #1 demand that his own message
 * NEVER silently disappears. Fired off the queue's intermediate `'retrying'`
 * ChatSendStatus between backoff attempts. No-op if no matching placeholder
 * exists (e.g. the WS echo already resolved it).
 */
export function applyRetryingSendStatus(
  prev: ChatMessage[],
  status: ChatSendStatus,
): ChatMessage[] {
  if (status.status !== 'retrying') return prev;
  const idx = prev.findIndex(
    (m) => m.id === status.clientId && m.pendingSend !== undefined,
  );
  if (idx === -1) return prev;
  const next = prev.slice();
  next[idx] = {
    ...next[idx],
    pendingSend: 'retrying',
    // Clear any stale ⚠ tooltip from a previous failed attempt — we're
    // actively retrying again, not in a terminal failed state.
    pendingError: undefined,
    sendAttempt: status.attempt,
    sendMaxAttempts: status.maxAttempts,
  };
  return next;
}

/**
 * v0.1.88 (voice 4504) — was the optimistic placeholder this incoming echo is
 * about to REPLACE in a FAILED (timed-out / ⚠) state?
 *
 * `dedupeOptimisticOnEcho` already replaces ANY placeholder with
 * `pendingSend !== undefined` — that INCLUDES a `'failed'` one — so a LATE echo
 * (arriving after the 30s `OPTIMISTIC_SEND_TIMEOUT_MS` flipped the placeholder
 * to `'failed'`) ALREADY clears the ⚠ purely by being deduped in. This helper
 * does NOT change that behaviour; it just lets the caller DETECT that the echo
 * resolved a previously-FAILED send (vs. a still-`'sending'` one or a brand-new
 * incoming message) so it can emit a structured log row. We look the id up in
 * the CURRENT feed BEFORE the dedupe runs.
 *
 * Returns true iff `prev` contains a placeholder with `id === incoming.id` whose
 * `pendingSend === 'failed'`. The late echo is the authoritative "Restream
 * confirmed this send" signal, so this is the smoking gun that the 30s guard
 * fired too early and the send was actually fine.
 */
export function isLateEchoForFailedSend(
  prev: ChatMessage[],
  incoming: ChatMessage,
): boolean {
  return prev.some(
    (m) => m.id === incoming.id && m.pendingSend === 'failed',
  );
}

/**
 * v0.1.88 (voice 4504) — RECONNECT-SUCCESS SWEEP.
 *
 * After a managed reconnect succeeds and re-subscribes the WS, any optimistic
 * send still showing the red ⚠ (`pendingSend === 'failed'`) whose POST returned
 * HTTP 200 is — empirically — a message that DID deliver (every 200-send
 * round-tripped once we re-subscribed; the ⚠ was a false alarm from the 30s
 * echo-timeout firing during the dead window). This reducer RESOLVES those
 * placeholders: it clears `pendingSend` + `pendingError` so the ⚠ disappears and
 * the row renders as a normal sent self-message.
 *
 * GATING (critical correctness):
 *   - ONLY placeholders whose `id` is in `httpOkClientIds` are touched. That
 *     Set is populated renderer-side from the queue's `'sent'` ChatSendStatus
 *     (which fires only on an HTTP 2xx POST). A send that NEVER POSTed 200 (HTTP
 *     error, no-session-cookies, no-active-connections, network throw, etc.) is
 *     a GENUINE failure and MUST keep its ⚠ — so it is deliberately NOT in the
 *     Set and is left untouched.
 *   - We never RE-SEND anything here (the POST already landed; re-sending risks
 *     a duplicate). This is a pure visual-status resolution.
 *   - Non-failed messages (confirmed echoes, still-`'sending'` placeholders,
 *     incoming messages) are untouched.
 *
 * Returns the same array reference when nothing changed (so React can skip a
 * re-render), or a new array with the resolved placeholders when ≥1 cleared.
 * The second return value is the count of ⚠ cleared, for the caller's log row.
 */
export function resolveLingeringFailedSendsOnReconnect(
  prev: ChatMessage[],
  httpOkClientIds: ReadonlySet<string>,
): { next: ChatMessage[]; clearedCount: number } {
  let clearedCount = 0;
  const next = prev.map((m) => {
    if (m.pendingSend !== 'failed') return m;
    if (!httpOkClientIds.has(m.id)) return m; // genuine failure — keep the ⚠
    clearedCount += 1;
    // Resolve to a plain sent self-message: drop pendingSend + the ⚠ tooltip.
    // We intentionally strip BOTH fields rather than setting some 'sent' state
    // because the ChatMessage contract uses `pendingSend === undefined` to mean
    // "fully sent / not a pending placeholder" (see the type docstring). The
    // row keeps `self: true` so it still renders right-aligned like the user's
    // own confirmed messages.
    const resolved = { ...m };
    delete resolved.pendingSend;
    delete resolved.pendingError;
    return resolved;
  });
  // Preserve reference identity when nothing changed so the caller's setState
  // is a no-op and React doesn't re-render the whole feed needlessly.
  if (clearedCount === 0) return { next: prev, clearedCount: 0 };
  return { next, clearedCount };
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
 * v0.1.72 (voice 4352, 2026-05-28) — added a THIRD hard-default gate:
 *
 *   3. Self-ignore. If `lastMessage.self === true`, the message is the
 *      LOCAL user's own outgoing reply (Restream's `reply_created` echo,
 *      normalised with `self: true` in src/main/normalize.ts). The local
 *      user does NOT want their own messages read aloud or pushed as
 *      notifications, full stop — that's noise from the user's own
 *      action. This is NOT user-configurable; it's a hard default. The
 *      previous v0.1.26 product direction ("read ALL messages including
 *      self") was reverted here per Ethan voice 4352.
 *
 * IMPORTANT — this function is NO LONGER on the live TTS path. v0.1.76 moved
 * the entire chat→speak decision into the MAIN process (`decideTtsAction` in
 * src/shared/side-effect-decision.ts, run by src/main/tts-dispatch.ts). The
 * App.tsx side-effect useEffect that used to call this was deleted. This
 * reducer is retained only for the pure unit tests that pin the historical
 * v0.1.60/v0.1.72 contract (src/__tests__/self-ignore.test.ts,
 * chat-message-reducers.test.ts). The AUTHORITATIVE, user-configurable
 * self-speak gate now lives in `decideTtsAction` gate 2 and keys off
 * `settings.tts.speakSelf` (v0.1.79 — default ON; set false to skip own
 * messages). Do NOT treat the hard `self === true` skip below as the live
 * behaviour — it isn't.
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
  // v0.1.72 — self-ignore. Local user's own messages never trigger TTS
  // or notifications. This is the SINGLE gate point for the rule — any
  // future caller of shouldTriggerSideEffects automatically inherits the
  // self-ignore guarantee. Tested in src/__tests__/self-ignore.test.ts.
  if (lastMessage.self === true) return false;
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
  return formatSendFailureTooltip(status);
}
