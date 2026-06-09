import type { ChatSendStatus, SendTextResult } from '../shared/types';
import type { ChatSendLogRecord } from './chat-send';
// v0.1.69 (voice 4015) — structured error log for queue-internal failures
// (runSend.threw catches an exception from `sendChatText`, pending/sent
// emit catches an IPC failure). These were previously console.warn only.
import { appendErrorLog, errorToString } from './structured-log';

/**
 * v0.1.43 — FIFO send queue for the non-blocking inline chat input.
 *
 * The renderer dispatches `CHAT_SEND_ENQUEUE` and IMMEDIATELY clears the
 * input — it never awaits the actual POST. The queue:
 *
 *   1. Accepts every enqueue (no rejection on backlog — Ethan needs to
 *      spam-send without ever hitting "wait 0.x s" errors).
 *   2. Runs the worker loop ONE send at a time so we never violate
 *      Restream's effective 1 msg/sec rate-limit. The minimum spacing
 *      between attempts is configurable via `minSpacingMs` (default
 *      1000ms — matches the old per-IPC gate).
 *   3. Broadcasts `ChatSendStatus` lifecycle events (`pending` on
 *      enqueue, `sent` on 2xx, `failed` on any error). Failure of one
 *      send NEVER blocks subsequent enqueues — the worker logs + moves on.
 *
 * The queue is intentionally agnostic of the actual send implementation:
 * inject it via `runSend` so unit tests can drive the queue with a fake
 * sender that flips between ok / failure / throws.
 */

export interface QueuedSend {
  clientId: string;
  text: string;
}

export interface ChatSendQueueOptions {
  /**
   * Async function that performs ONE POST and resolves with the result.
   * Wired to `sendChatText` from `chat-send.ts` in production; tests pass
   * a stub.
   */
  runSend: (item: QueuedSend) => Promise<SendTextResult>;
  /**
   * Push a status update to the renderer. Wired to
   * `mainWindow?.webContents.send(IPC.CHAT_SEND_STATUS, status)` in
   * production; tests pass a spy.
   */
  emitStatus: (status: ChatSendStatus) => void;
  /**
   * Minimum gap between consecutive sends, ms. Defaults to 1000 which
   * matches the v0.1.42 per-IPC rate-limit so we don't trip Restream's
   * own throttle on rapid spam. Set to 0 in tests for fast assertions.
   */
  minSpacingMs?: number;
  /**
   * Async sleep helper. Defaults to `setTimeout`; tests pass a
   * synchronous stub or a fake-timers-friendly variant.
   */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Optional logger for queue-internal events (drain start/end, drops).
   * Defaults to a no-op.
   */
  log?: (event: string, data?: Record<string, unknown>) => void;
  /**
   * v0.1.68 (voice 4013) — optional sink for structured `chat-send.jsonl`
   * rows so the queue can surface IPC-level failures (e.g. `emitStatus`
   * throws) into the same disk log that `chat-send.ts` writes per-POST
   * rows to. Wired to `appendChatSendLog` in main.ts. Tests can pass a
   * spy or omit it (no-op). Errors from this callback are swallowed
   * inside the queue — logging must never break the send pipeline.
   */
  logChatSend?: (record: ChatSendLogRecord) => void;
  /**
   * v0.1.90 (voice 4512) — max attempts in the bounded exponential-backoff
   * retry loop. Ethan: "we should have exponential retry up to 5 times…
   * because it's really important the messages I send get sent." Default 5.
   * Set to 1 to disable retries (old single-attempt behaviour); tests vary it.
   */
  maxSendAttempts?: number;
  /**
   * v0.1.90 — base backoff (ms) for the retry loop. The wait BEFORE attempt
   * N+1 is `backoffBaseMs * 2^(N-1)`, capped at `backoffMaxMs`:
   * ~1s, 2s, 4s, 8s (16s capped). Default 1000. Tests set 0 for speed.
   */
  backoffBaseMs?: number;
  /** v0.1.90 — cap for the exponential backoff (ms). Default 16000. */
  backoffMaxMs?: number;
  /**
   * v0.1.90 — the "refresh" between retry attempts. Wired in main.ts to
   * `performFullReconnect` (OAuth refresh → chat.reconnect() → re-subscribe →
   * chat-context re-sniff), exactly the managed reconnect the manual Reconnect
   * button + the v0.1.86/87 recoveries use. Called BEFORE each backoff sleep so
   * cookies/context/connections are fresh by the time the next POST fires.
   * Resolves with `{ ok }` (we don't block the retry on a failed reconnect —
   * we still re-POST; the gate inside `sendChatText` will re-evaluate). Omit
   * (or pass undefined) to skip the reconnect step (e.g. unit tests that only
   * exercise the backoff ladder). Errors are swallowed — a reconnect that
   * throws must NOT abort the retry loop.
   */
  reconnectBetweenRetries?: (reason: string) => Promise<{ ok: boolean }>;
}

/**
 * v0.1.90 (voice 4512) — classify a failed `SendTextResult.reason` as
 * RETRYABLE (transient/recoverable — worth a reconnect + re-POST) vs
 * NON-RETRYABLE (re-trying can't help). This is the safety valve Ethan's
 * "make damn sure it sends" loop hangs off.
 *
 * RETRYABLE (transient — a managed reconnect/"refresh" plausibly fixes it):
 *   - no-session-cookies   : cookie jar lost the XSRF (post-reconnect drain) →
 *                            reconnect re-provisions cookies.
 *   - no-active-connections: connections map momentarily drained ("replaced") →
 *                            reconnect re-subscribes the platforms.
 *   - not-authenticated    : token lapsed between enqueue + POST → reconnect
 *                            refreshes OAuth.
 *   - no-show-id           : chat context (showId/eventId) not re-sniffed yet
 *                            after a reconnect → reconnect + REST hydrate re-sniff.
 *   - send-failed          : a non-2xx POST (5xx / transient backend error /
 *                            non-404 4xx). The brief says retry these too; a
 *                            real route-404 short-circuits inside sendChatText
 *                            BEFORE returning send-failed for that case.
 *   - error                : fetch threw / network blip / unexpected → retry.
 *
 * CRITICAL SAFETY (no double-POST): we ONLY ever reach this classifier on
 * `ok:false`. `sendChatText` returns `ok:true` ONLY on a confirmed 2xx, so a
 * retryable result NEVER corresponds to a POST that already landed 200 — it is
 * always safe to re-POST. And every re-POST reuses the SAME `clientReplyUuid`
 * (the queue keeps `item.clientId` constant across attempts), so even if a
 * borderline send DID reach Restream, Restream dedupes on the uuid. The
 * "POSTed-200-but-unconfirmed" case is a DIFFERENT path entirely (ok:true →
 * never retried here; resolved by the v0.1.88 echo/reconnect-sweep).
 *
 * There is currently no non-retryable reason left (every union member is
 * recoverable-or-worth-one-more-try), but the function is explicit so a future
 * reason (e.g. a hard "message too long" 400) can be marked non-retryable in
 * ONE place and immediately surface a terminal ⚠ instead of burning 5 attempts.
 */
export function isRetryableSendFailure(reason: string | undefined): boolean {
  switch (reason) {
    case 'no-session-cookies':
    case 'no-active-connections':
    case 'not-authenticated':
    case 'no-show-id':
    case 'send-failed':
    case 'error':
    case undefined: // defensive: a missing reason is treated as transient
      return true;
    default:
      return false;
  }
}

export interface ChatSendQueue {
  enqueue: (item: QueuedSend) => void;
  /** Resolves once the queue is fully drained. Test-only convenience. */
  whenIdle: () => Promise<void>;
  /** Synchronous read of the current queue length, for tests. */
  pending: () => number;
  /** True while the worker is mid-send. */
  isRunning: () => boolean;
}

export function createChatSendQueue(opts: ChatSendQueueOptions): ChatSendQueue {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const noopLog: NonNullable<ChatSendQueueOptions['log']> = () => undefined;
  const log = opts.log ?? noopLog;
  const minSpacingMs = opts.minSpacingMs ?? 1000;
  // v0.1.90 (voice 4512) — bounded exponential-backoff retry knobs.
  // `Math.max(1, …)` so a misconfigured 0/negative can never make the loop
  // skip the send entirely (we always attempt at least once).
  const maxSendAttempts = Math.max(1, opts.maxSendAttempts ?? 5);
  const backoffBaseMs = opts.backoffBaseMs ?? 1000;
  const backoffMaxMs = opts.backoffMaxMs ?? 16000;

  // v0.1.90 — best-effort structured-log helper. Mirrors the swallow-errors
  // contract everywhere else in this file: logging must NEVER break the send
  // pipeline. Used for the new `retry-attempt` rows that close the 16:50
  // "vanished message, zero log trace" gap.
  const logRetry = (record: ChatSendLogRecord): void => {
    if (!opts.logChatSend) return;
    try {
      opts.logChatSend(record);
    } catch {
      // logging must never break the send path
    }
  };

  // v0.1.90 — backoff for the wait BEFORE attempt `nextAttempt` (1-based).
  // Between attempt 1→2 we wait base*2^0, 2→3 base*2^1, … capped at max:
  // ~1s, 2s, 4s, 8s, 16s. `nextAttempt` is the attempt we're about to make
  // (so the first retry, attempt 2, uses exponent 0).
  const backoffForAttempt = (nextAttempt: number): number => {
    const exponent = Math.max(0, nextAttempt - 2);
    return Math.min(backoffMaxMs, backoffBaseMs * 2 ** exponent);
  };

  const queue: QueuedSend[] = [];
  let running = false;
  let lastSentAt = 0;
  const idleResolvers: Array<() => void> = [];

  const resolveIdle = (): void => {
    while (idleResolvers.length > 0) {
      const r = idleResolvers.shift();
      try {
        r?.();
      } catch {
        // ignore
      }
    }
  };

  // v0.1.90 — emit `'sent'` (2xx success). Keeps the v0.1.69 belt-and-braces
  // IPC-failure logging (both app-errors.jsonl + chat-send.jsonl) so a lost
  // success status — which would strand the placeholder on "sending" — is
  // still grep-able.
  const emitSent = (clientId: string): void => {
    try {
      opts.emitStatus({ clientId, status: 'sent' });
    } catch (err) {
      const errorMessage = String((err as Error)?.message ?? err);
      log('queue.emit.threw', { clientId, phase: 'sent', error: errorMessage });
      appendErrorLog({
        subsystem: 'chat-send-queue',
        phase: 'chat-send-queue.emit-sent-failed',
        errorMessage,
        context: { clientId },
      });
      logRetry({
        phase: 'status-emit-failed',
        clientReplyUuid: clientId,
        reason: 'sent',
        httpStatus: null,
        errorMessage,
      });
    }
  };

  // v0.1.90 — emit the TERMINAL `'failed'` (retries exhausted OR non-retryable).
  // Carries `attempt`/`maxAttempts` so the renderer can label the final state.
  // Same v0.1.68/69 IPC-failure mirroring as before.
  const emitFailed = (
    clientId: string,
    result: SendTextResult,
    attempt: number,
  ): void => {
    try {
      opts.emitStatus({
        clientId,
        status: 'failed',
        reason: result.reason,
        error: result.error,
        httpStatus: result.status,
        attempt,
        maxAttempts: maxSendAttempts,
      });
    } catch (err) {
      const errorMessage = String((err as Error)?.message ?? err);
      log('queue.emit.threw', { clientId, phase: 'failed', error: errorMessage });
      appendErrorLog({
        subsystem: 'chat-send-queue',
        phase: 'chat-send-queue.emit-failed-failed',
        errorMessage,
        context: {
          clientId,
          resultReason: result.reason,
          httpStatus: result.status ?? null,
        },
      });
      logRetry({
        phase: 'status-emit-failed',
        clientReplyUuid: clientId,
        reason: result.reason ?? 'unknown',
        httpStatus: result.status ?? null,
        errorMessage,
      });
    }
  };

  // v0.1.90 — emit the intermediate `'retrying'` status. Best-effort: a lost
  // retrying status is cosmetic (the placeholder just shows the previous
  // "(retry N-1/5)" until the next attempt) and must NEVER abort the loop, so
  // we swallow IPC failures here without the heavyweight mirroring above.
  const emitRetrying = (clientId: string, attempt: number): void => {
    try {
      opts.emitStatus({
        clientId,
        status: 'retrying',
        attempt,
        maxAttempts: maxSendAttempts,
      });
    } catch (err) {
      log('queue.emit.threw', {
        clientId,
        phase: 'retrying',
        error: String((err as Error)?.message ?? err),
      });
    }
  };

  // v0.1.90 — run ONE POST attempt, converting an unexpected throw from
  // `runSend` (== sendChatText, which should catch everything internally) into
  // a `{ ok:false, reason:'error' }` result + structured row. Keeps the
  // v0.1.69 run-send-threw observability.
  const runSendOnce = async (item: QueuedSend): Promise<SendTextResult> => {
    try {
      return await opts.runSend(item);
    } catch (err) {
      const errorMessage = String((err as Error)?.message ?? err);
      log('queue.send.threw', { clientId: item.clientId, error: errorMessage });
      appendErrorLog({
        subsystem: 'chat-send-queue',
        phase: 'chat-send-queue.run-send-threw',
        errorMessage: errorToString(err),
        context: { clientId: item.clientId },
      });
      return { ok: false, reason: 'error', error: errorMessage };
    }
  };

  // v0.1.90 (voice 4512) — the bounded exponential-backoff retry loop for a
  // SINGLE queued send. See the big comment at the call site in `drain`.
  const sendWithRetry = async (item: QueuedSend): Promise<void> => {
    for (let attempt = 1; attempt <= maxSendAttempts; attempt++) {
      const result = await runSendOnce(item);

      // SUCCESS — a confirmed 2xx. Log the terminal `ok` row, emit `'sent'`,
      // done. (The WS echo — matched by clientReplyUuid → id — is what
      // actually replaces the placeholder in the feed; `'sent'` just lets the
      // renderer track the HTTP-200 for the v0.1.88 reconnect sweep.)
      if (result.ok) {
        logRetry({
          phase: 'retry-attempt',
          clientReplyUuid: item.clientId,
          attempt,
          maxAttempts: maxSendAttempts,
          outcome: 'ok',
          decision: 'done',
        });
        emitSent(item.clientId);
        return;
      }

      // FAILURE. Decide: retry (transient + attempts left) or give up.
      const retryable = isRetryableSendFailure(result.reason);
      const hasAttemptsLeft = attempt < maxSendAttempts;
      const willRetry = retryable && hasAttemptsLeft;

      if (!willRetry) {
        // Terminal: either non-retryable, or we've burned the last attempt.
        logRetry({
          phase: 'retry-attempt',
          clientReplyUuid: item.clientId,
          attempt,
          maxAttempts: maxSendAttempts,
          outcome: 'failed',
          reason: result.reason,
          httpStatus: result.status ?? null,
          decision: 'give-up',
        });
        emitFailed(item.clientId, result, attempt);
        return;
      }

      // Will retry. Compute the backoff for the NEXT attempt and run the
      // managed reconnect ("refresh") first so cookies/context/connections are
      // fresh by the time we re-POST. The reconnect is fire-and-await but its
      // success is NOT a precondition for retrying — even a failed reconnect
      // leaves us to re-POST (the gate inside sendChatText re-evaluates state).
      const nextAttempt = attempt + 1;
      const backoffMs = backoffForAttempt(nextAttempt);
      const reconnectRequested = Boolean(opts.reconnectBetweenRetries);

      logRetry({
        phase: 'retry-attempt',
        clientReplyUuid: item.clientId,
        attempt,
        maxAttempts: maxSendAttempts,
        outcome: 'failed',
        reason: result.reason,
        httpStatus: result.status ?? null,
        decision: 'retry-after-reconnect',
        backoffMs,
        reconnectRequested,
      });

      // Flip the placeholder to "(retry N/5)" where N == the attempt we're
      // ABOUT to make — so the user sees progress toward delivery.
      emitRetrying(item.clientId, nextAttempt);

      if (opts.reconnectBetweenRetries) {
        try {
          await opts.reconnectBetweenRetries(`send-retry:${result.reason ?? 'unknown'}`);
        } catch (err) {
          // A reconnect that throws must NEVER abort the retry loop — that
          // would silently strand the send, the exact failure mode we're
          // fixing. Log it and re-POST anyway.
          appendErrorLog({
            subsystem: 'chat-send-queue',
            phase: 'chat-send-queue.reconnect-between-retries-threw',
            errorMessage: errorToString(err),
            context: { clientId: item.clientId, attempt },
          });
        }
      }

      if (backoffMs > 0) {
        await sleep(backoffMs);
      }
      // loop continues → next POST attempt
    }
  };

  const drain = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      while (queue.length > 0) {
        const item = queue.shift();
        if (!item) break;
        // Pace: wait until at least `minSpacingMs` has elapsed since the
        // last completed send. Spam-typed messages get sent at the queue's
        // cadence, not the user's typing speed.
        const now = Date.now();
        const wait = Math.max(0, minSpacingMs - (now - lastSentAt));
        if (wait > 0) {
          await sleep(wait);
        }
        // v0.1.90 (voice 4512) — BOUNDED EXPONENTIAL-BACKOFF RETRY LOOP.
        // ===================================================================
        // Ethan: "we should have exponential retry up to 5 times to send a
        // message… and it should do the refresh [reconnect] if needed."
        //
        // The loop attempts the POST up to `maxSendAttempts` (default 5) times.
        // After each failed attempt that is RETRYABLE (transient — see
        // isRetryableSendFailure), it:
        //   1. emits a `'retrying'` status so the feed shows "(retry N/5)" —
        //      the placeholder NEVER vanishes, Ethan always sees it fighting;
        //   2. runs the managed reconnect/"refresh" (reconnectBetweenRetries)
        //      so cookies + chat-context + connections are fresh;
        //   3. backs off exponentially (~1s,2s,4s,8s,16s capped);
        //   4. re-POSTs with the SAME clientReplyUuid (Restream dedupes; we
        //      only ever reach here on ok:false == no confirmed 200, so a
        //      re-POST can't double-deliver — see isRetryableSendFailure doc).
        // A confirmed 2xx (ok:true) ends the loop immediately (success). A
        // NON-retryable failure ends it immediately (terminal ⚠). Exhausting
        // all attempts ends it with terminal ⚠. EVERY attempt writes a
        // `retry-attempt` chat-send.jsonl row — this is the gap-closer for the
        // 16:50 "vanished message with zero log trace" incident.
        await sendWithRetry(item);
        lastSentAt = Date.now();
      }
    } finally {
      running = false;
      resolveIdle();
    }
  };

  return {
    enqueue(item: QueuedSend): void {
      queue.push(item);
      // Optimistic "pending" so listeners can confirm the enqueue landed.
      // Renderer already shows the placeholder from the click handler;
      // this is mostly useful for tests + future debug instrumentation.
      try {
        opts.emitStatus({ clientId: item.clientId, status: 'pending' });
      } catch (err) {
        log('queue.emit.threw', {
          clientId: item.clientId,
          phase: 'pending',
          error: String((err as Error)?.message ?? err),
        });
        // v0.1.69 (voice 4015): even the harmless `pending` emit gets a
        // row if it throws — the renderer would otherwise have no
        // confirmation the enqueue landed, and worth knowing if the IPC
        // bridge is broken at this stage too.
        appendErrorLog({
          subsystem: 'chat-send-queue',
          phase: 'chat-send-queue.emit-pending-failed',
          errorMessage: errorToString(err),
          context: { clientId: item.clientId },
        });
      }
      // Kick the drain loop. We don't await — enqueue is sync from the
      // caller's perspective (it's wired to `ipcMain.on`, not `.handle`).
      void drain();
    },
    whenIdle(): Promise<void> {
      if (!running && queue.length === 0) return Promise.resolve();
      return new Promise((r) => idleResolvers.push(r));
    },
    pending(): number {
      return queue.length;
    },
    isRunning(): boolean {
      return running;
    },
  };
}
