// v0.1.70 (sign-out diagnosis 2026-05-25) — transient-refresh-retry
// watchdog state machine, factored out of main.ts so it's unit-testable
// without booting Electron's `app.on('ready')` closure.
//
// THE BUG WE'RE FIXING:
//   v0.1.67 user got signed out today despite `tokenEnc` still being on
//   disk. `reconnect-events.jsonl` showed exactly one
//   `failureReason:refresh-failed` row at 19:14:39Z — a single
//   `fetch threw` in `oauth.refresh()` (almost certainly network
//   sleep, given the `471944ms` stale-inbound that preceded it). The
//   token was still VALID, but performFullReconnect saw `refresh()`
//   returned undefined and pushed `AUTH_STATUS { authenticated: false }`
//   to the renderer → renderer flipped to the sign-in screen. WS
//   auto-retry gave up after one attempt; nothing has retried since
//   (19 hours of only updater-gh log lines in main.log). User saw
//   "you got signed out" with no recoverable path other than re-auth.
//
// THE FIX:
//   When refresh() fails transiently (5xx or fetch-threw, NOT 4xx),
//   we (a) tell the renderer "tokenLikelyValid, reconnectingDueToTransient"
//   so it shows a recovery banner instead of the sign-in CTA, and
//   (b) arm a periodic retry that re-tries `oauth.refresh()` on an
//   exponential 2m → 4m → 8m → 16m → 30m schedule until either:
//     - refresh succeeds → push `authenticated: true`, drive
//       chat.setToken + chat.reconnect, log recovery, reset state.
//     - refresh returns 'fatal' (4xx → tokens were wiped by
//       oauth.refresh's logout() call) → push final
//       `authenticated: false` (no `tokenLikelyValid`), log give-up,
//       reset state.
//     - refresh still transient → schedule the next tick with the
//       doubled delay (capped at 30m), keep banner up.
//
// WHY ONE TIMER, NOT A LOOP:
//   We want exactly one outstanding retry timer at any moment. The
//   `if (this.timer) return;` guard inside `arm()` makes successive
//   arm calls idempotent (so e.g. WS auto-retry firing every 60s
//   doesn't stack up multiple parallel exponential ladders). On each
//   tick we clear the handle FIRST so a recursive re-arm from inside
//   the tick can install the next timer.
//
// WHY EXPONENTIAL BACKOFF:
//   Transient causes are bimodal: short blips (Wi-Fi handoff, DNS
//   hiccup — recover in seconds) and long outages (ISP / Restream
//   downtime — minutes to hours). We want fast recovery in the first
//   case and not-hammering-Restream in the second. 2m start gives the
//   short-blip case room to self-heal, doubling avoids the
//   bug-of-the-week where 100k users + a 60s retry cadence stampede a
//   recovering Restream API. 30m cap keeps recovery latency bounded
//   for users who are actively staring at the app.

/** Initial backoff window before the first retry attempt fires. */
export const TRANSIENT_RETRY_BASE_MS = 2 * 60_000;
/** Max backoff cap — recovery latency for an actively-staring user. */
export const TRANSIENT_RETRY_CAP_MS = 30 * 60_000;

/**
 * Outcome classification returned by the injected `refresh()` call.
 * Mirrors `OAuthCoordinator.getLastRefreshFailure()` but with the
 * recovery-success case mapped to `'success'` (rather than `'none'`)
 * so the controller has a single union to switch on.
 */
export type RetryTickOutcome = 'success' | 'fatal' | 'transient';

/**
 * Side-effect surface the controller drives on each tick.
 *
 *  - `refresh()` — perform one `oauth.refresh()` attempt and report
 *    classified outcome. Returning `'success'` MUST imply the token
 *    set was persisted by the caller.
 *  - `onSuccess()` — invoked when `refresh()` returns `'success'`.
 *    Caller pushes `AUTH_STATUS { authenticated: true }` and drives
 *    `chat.setToken` + `chat.reconnect()`.
 *  - `onFatal()` — invoked when `refresh()` returns `'fatal'`. Caller
 *    pushes `AUTH_STATUS { authenticated: false }` (no
 *    `tokenLikelyValid`) — the user really is signed out.
 *  - `onTick(info)` — diagnostic-only callback fired AFTER a still-
 *    transient tick decides to recurse. Used for structured logging.
 *  - `onError(err)` — invoked when `refresh()` itself throws (it
 *    shouldn't — it catches everything — but we still want to log).
 */
export interface TransientRetryHooks {
  refresh: () => Promise<RetryTickOutcome>;
  onSuccess: () => void | Promise<void>;
  onFatal: () => void | Promise<void>;
  onTick?: (info: {
    origin: string;
    previousDelayMs: number;
    nextDelayMs: number;
    cappedAt: number;
  }) => void;
  onError?: (err: unknown, origin: string) => void;
}

/**
 * Timer primitives — defaulted to `setTimeout`/`clearTimeout` from the
 * host. Injectable so tests can pin behavior with Vitest fake timers.
 */
export interface TransientRetryTimers {
  setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
}

/**
 * v0.1.70 — periodic refresh-retry watchdog.
 *
 * Single-instance state machine: holds the current backoff window +
 * the outstanding timer handle. Constructed once per app session
 * inside `app.on('ready')` and torn down on `before-quit` /
 * `AUTH_LOGOUT` / successful chat.reconnect (see callers in main.ts).
 *
 * State transitions:
 *
 *   [idle]
 *     arm(origin) → [armed @ delay=2m]
 *
 *   [armed @ delay=D]
 *     tick fires:
 *       outcome=success → onSuccess(); delay := BASE; [idle]
 *       outcome=fatal   → onFatal();   delay := BASE; [idle]
 *       outcome=transient → delay := min(D*2, CAP); arm(origin);
 *                             onTick(...); [armed @ delay=D*2]
 *       throw           → onError(err); delay := min(D*2, CAP);
 *                             arm(origin); [armed @ delay=D*2]
 *
 *   [armed @ delay=D]
 *     cancel() → [idle], delay := BASE
 *
 *   [armed @ delay=D]
 *     arm(origin') → no-op (coalesced — one outstanding timer at a time)
 */
export class TransientRefreshRetryController {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private delayMs = TRANSIENT_RETRY_BASE_MS;
  private readonly setTimer: TransientRetryTimers['setTimeout'];
  private readonly clearTimer: TransientRetryTimers['clearTimeout'];

  constructor(
    private readonly hooks: TransientRetryHooks,
    timers: TransientRetryTimers = {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    },
  ) {
    this.setTimer = timers.setTimeout;
    this.clearTimer = timers.clearTimeout;
  }

  /** Inspected by tests + diagnostic logging. */
  getDelayMs(): number {
    return this.delayMs;
  }

  /** Inspected by tests + diagnostic logging. */
  isArmed(): boolean {
    return this.timer !== undefined;
  }

  /**
   * Arm the next retry tick. Idempotent — if a timer is already armed,
   * this is a no-op (coalesces concurrent callers).
   *
   * `origin` is diagnostic-only; surfaced through `onTick` /
   * `onError` so post-mortem can tell which call site originally
   * started the recovery cycle.
   */
  arm(origin: string): void {
    if (this.timer) return;
    // Capture the delay AT ARM TIME so a concurrent cancel() between
    // arm and tick can't desync (cancel() resets delayMs to BASE).
    const delay = this.delayMs;
    this.timer = this.setTimer(async () => {
      // Clear the handle FIRST so the recursive arm() call inside the
      // still-transient branch can install the next timer without
      // tripping the idempotent guard above.
      this.timer = undefined;
      try {
        const outcome = await this.hooks.refresh();
        if (outcome === 'success') {
          // ---- Recovery success ----
          // Reset delay to BASE so the NEXT transient cycle (e.g. user
          // puts laptop to sleep again tomorrow) starts at 2m, not at
          // wherever this cycle left off.
          this.delayMs = TRANSIENT_RETRY_BASE_MS;
          await this.hooks.onSuccess();
          return;
        }
        if (outcome === 'fatal') {
          // ---- Give up: 4xx promotion to fatal ----
          // refresh() already called logout() and wiped tokenEnc. The
          // user truly does need to re-auth.
          this.delayMs = TRANSIENT_RETRY_BASE_MS;
          await this.hooks.onFatal();
          return;
        }
        // ---- Still transient → reschedule with doubled delay ----
        const previousDelayMs = this.delayMs;
        this.delayMs = Math.min(this.delayMs * 2, TRANSIENT_RETRY_CAP_MS);
        this.hooks.onTick?.({
          origin,
          previousDelayMs,
          nextDelayMs: this.delayMs,
          cappedAt: TRANSIENT_RETRY_CAP_MS,
        });
        this.arm(origin);
      } catch (err) {
        // refresh() itself shouldn't throw (it catches everything
        // internally), but if some future change breaks that invariant
        // we still don't want to leave the user stranded with no armed
        // retry. Treat as transient + re-arm.
        this.hooks.onError?.(err, origin);
        this.delayMs = Math.min(this.delayMs * 2, TRANSIENT_RETRY_CAP_MS);
        this.arm(origin);
      }
    }, delay);
  }

  /**
   * Cancel any armed timer + reset backoff. Idempotent — safe to call
   * even when no timer is armed. Called from:
   *   - AUTH_LOGOUT (user signed out manually)
   *   - Successful chat.reconnect inside performFullReconnect
   *   - app.on('before-quit')
   */
  cancel(): void {
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
    this.delayMs = TRANSIENT_RETRY_BASE_MS;
  }
}
