import type { ChatMessage, ChatSendStatus } from '../shared/types';
import { applyFailedSendStatus } from './chat-message-reducers';
import { SEND_TIMEOUT_TOOLTIP_TEXT } from './send-failure-copy';

/**
 * v0.1.63 — second-line guard for optimistic sends.
 *
 * Primary correctness still lives in the main process: startup cookie repair
 * should make `sendChatText` either POST successfully or emit an explicit
 * `failed` status. This timeout exists because a future silent-bail bug must
 * never leave the renderer showing `pendingSend: "sending"` forever.
 *
 * v0.1.68 (voice 4013): bumped from 15s → 30s. The 15s value was tight
 * enough that genuinely-slow-but-fine sends (REST hydration after a
 * fresh sign-in, post-cookie-repair first attempt with cold DNS / TLS
 * resume, Restream's own backend latency spikes) could trip the
 * renderer's stuck-send guard even though the send DID land within a
 * "reasonable" wall-clock window. 30s gives the entire pipeline
 * — preflight cookie probe + REST hydration + attempt #1 + retry +
 * Restream backend processing + WS echo round-trip — enough headroom
 * to complete on a sluggish connection without producing a false ⚠.
 * The 30s value matches roughly 2x the worst-case observed end-to-end
 * latency in production logs.
 */
export const OPTIMISTIC_SEND_TIMEOUT_MS = 30_000;

export function optimisticSendTimeoutStatus(clientId: string): ChatSendStatus {
  return {
    clientId,
    status: 'failed',
    reason: 'timeout',
    error: SEND_TIMEOUT_TOOLTIP_TEXT,
  };
}

export function applyOptimisticSendTimeout(
  prev: ChatMessage[],
  clientId: string,
): ChatMessage[] {
  return applyFailedSendStatus(prev, optimisticSendTimeoutStatus(clientId));
}

/**
 * v0.1.68 (voice 4013): emit a structured `chat-send.jsonl` row when
 * the renderer's stuck-send guard fires. The renderer can't write the
 * jsonl file directly (no fs in preload); we ship the row over the
 * `CHAT_SEND_LOG_EVENT` IPC channel which main relays to
 * `appendChatSendLog`. Without this row a `optimistic-timeout` is
 * invisible from disk forensics — exactly the class of bug voice 4013
 * is asking us to make discoverable from logs alone.
 *
 * `queueState` is optional and best-effort: the renderer doesn't know
 * the main-process queue depth, just whether the placeholder still has
 * `pendingSend === 'sending'` at fire time. The caller in App.tsx
 * passes a short string ("still-sending" by default) so we can later
 * extend it without breaking the IPC contract.
 *
 * Failure-mode: if `window.rcpp.emitChatSendLogEvent` is missing (older
 * preload, future renderer refactor), this is a silent no-op. The
 * actual user-visible `failed` placeholder is unaffected.
 */
export function logOptimisticSendTimeout(
  clientId: string,
  queueState?: string,
): void {
  emitChatSendLogRow({
    phase: 'optimistic-timeout',
    clientReplyUuid: clientId,
    elapsedMs: OPTIMISTIC_SEND_TIMEOUT_MS,
    queueState: queueState ?? 'still-sending',
  });
}

/**
 * v0.1.88 (voice 4504) — structured row written when a LATE WS echo resolves a
 * placeholder the 30s timeout had already flipped to ⚠ `'failed'`. Lets a
 * post-mortem grep `phase:"late-echo-resolved"` and correlate with the matching
 * `optimistic-timeout` row (same `clientReplyUuid`) to see "the send was fine,
 * the echo just arrived after the guard fired". Same fire-and-forget relay +
 * swallow-everything contract as `logOptimisticSendTimeout`.
 */
export function logLateEchoResolved(clientId: string): void {
  emitChatSendLogRow({
    phase: 'late-echo-resolved',
    clientReplyUuid: clientId,
  });
}

/**
 * v0.1.88 (voice 4504) — structured row written ONCE per managed
 * reconnect-success sweep that cleared ≥1 lingering ⚠. `clearedCount` is the
 * number of HTTP-200 failed sends resolved; `reason` is the reconnect-context
 * label. The caller skips this when the sweep cleared zero. Same fire-and-forget
 * relay + swallow-everything contract as the other renderer log helpers.
 */
export function logReconnectSweepCleared(
  reason: string,
  clearedCount: number,
): void {
  emitChatSendLogRow({
    phase: 'reconnect-sweep-cleared',
    reason,
    clearedCount,
  });
}

/**
 * Shared fire-and-forget relay used by the renderer-side chat-send log helpers.
 * The renderer has no fs access in preload, so every row is shipped over the
 * `CHAT_SEND_LOG_EVENT` IPC channel and `appendChatSendLog` in main is the
 * single writer. Missing `rcpp.emitChatSendLogEvent` (older preload / future
 * refactor) is a silent no-op; any throw is swallowed — logging must NEVER
 * break the renderer's send/echo/reconnect loops.
 */
function emitChatSendLogRow(record: Record<string, unknown>): void {
  try {
    const api = (
      globalThis as unknown as {
        rcpp?: {
          emitChatSendLogEvent?: (record: Record<string, unknown>) => void;
        };
      }
    ).rcpp;
    if (!api?.emitChatSendLogEvent) return;
    api.emitChatSendLogEvent(record);
  } catch {
    // logging must never break the renderer's send loop
  }
}
