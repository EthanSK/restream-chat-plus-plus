/**
 * v0.1.70 (sign-out diagnosis 2026-05-25) — transient-refresh-retry
 * watchdog state-machine pin tests.
 *
 * THE BUG WE'RE PINNING:
 *   v0.1.67 user got signed out today despite `tokenEnc` still being on
 *   disk. `reconnect-events.jsonl` showed exactly one
 *   `failureReason:refresh-failed` row at 19:14:39Z — a single
 *   `fetch threw` in `oauth.refresh()` (network sleep, given the
 *   `471944ms` stale-inbound that preceded it). The token was still
 *   VALID, but performFullReconnect saw `refresh()` returned undefined
 *   and pushed `AUTH_STATUS { authenticated: false }` to the renderer
 *   → renderer flipped to the sign-in screen. WS auto-retry gave up
 *   after one attempt; nothing has retried since (19h of only
 *   updater-gh log lines in main.log). User saw "you got signed out"
 *   with no recoverable path other than re-auth.
 *
 * THE FIX (pinned here):
 *   The controller arms ONE outstanding timer, starts at 2m, doubles
 *   each still-transient tick, caps at 30m. On recovery success it
 *   resets to 2m + fires onSuccess. On fatal it fires onFatal and
 *   resets. cancel() tears it down for AUTH_LOGOUT / chat.reconnect
 *   success / before-quit. Concurrent arm() calls coalesce onto a
 *   single timer (no exponential-ladder stacking).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TransientRefreshRetryController,
  TRANSIENT_RETRY_BASE_MS,
  TRANSIENT_RETRY_CAP_MS,
  type RetryTickOutcome,
} from '../main/transient-refresh-retry';

/**
 * Helper — construct a controller wired to a queued list of refresh
 * outcomes. Each tick dequeues the next outcome. Spies are returned
 * for assertion.
 */
function makeController(outcomes: RetryTickOutcome[]) {
  const refresh = vi.fn(async () => {
    if (outcomes.length === 0) return 'transient' as const;
    return outcomes.shift()!;
  });
  const onSuccess = vi.fn();
  const onFatal = vi.fn();
  const onTick = vi.fn();
  const onError = vi.fn();
  const ctrl = new TransientRefreshRetryController({
    refresh,
    onSuccess,
    onFatal,
    onTick,
    onError,
  });
  return { ctrl, refresh, onSuccess, onFatal, onTick, onError };
}

describe('TransientRefreshRetryController (v0.1.70)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('exposes the documented base + cap constants', () => {
    // Pin the documented exponential schedule: 2m start, 30m cap.
    // Bumping these is a user-facing change (recovery latency) so the
    // pin makes the values an explicit decision.
    expect(TRANSIENT_RETRY_BASE_MS).toBe(2 * 60_000);
    expect(TRANSIENT_RETRY_CAP_MS).toBe(30 * 60_000);
  });

  it('arms at exactly 2m on the first call', async () => {
    const { ctrl, refresh } = makeController(['success']);
    ctrl.arm('test-origin');
    expect(ctrl.isArmed()).toBe(true);
    expect(ctrl.getDelayMs()).toBe(TRANSIENT_RETRY_BASE_MS);

    // Just before 2m: no tick yet.
    await vi.advanceTimersByTimeAsync(TRANSIENT_RETRY_BASE_MS - 1);
    expect(refresh).not.toHaveBeenCalled();

    // At 2m: tick fires.
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('doubles delay on still-transient and re-arms', async () => {
    // Three transient ticks back-to-back → 2m, 4m, 8m schedule.
    const { ctrl, refresh, onTick } = makeController([
      'transient',
      'transient',
      'transient',
    ]);
    ctrl.arm('test');

    // Tick 1 at 2m → next delay 4m.
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(ctrl.getDelayMs()).toBe(4 * 60_000);
    expect(ctrl.isArmed()).toBe(true);
    expect(onTick).toHaveBeenLastCalledWith(
      expect.objectContaining({
        origin: 'test',
        previousDelayMs: 2 * 60_000,
        nextDelayMs: 4 * 60_000,
      }),
    );

    // Tick 2 at +4m → next delay 8m.
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(ctrl.getDelayMs()).toBe(8 * 60_000);

    // Tick 3 at +8m → next delay 16m.
    await vi.advanceTimersByTimeAsync(8 * 60_000);
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(ctrl.getDelayMs()).toBe(16 * 60_000);
  });

  it('caps the delay at 30m no matter how many transients in a row', async () => {
    // Eight transients: 2 → 4 → 8 → 16 → 30 (capped) → 30 → 30 → 30.
    const { ctrl, refresh } = makeController([
      'transient',
      'transient',
      'transient',
      'transient',
      'transient',
      'transient',
      'transient',
      'transient',
    ]);
    ctrl.arm('test');

    // Walk through enough ticks to hit + exceed the cap.
    await vi.advanceTimersByTimeAsync(2 * 60_000); // tick 1, next=4m
    await vi.advanceTimersByTimeAsync(4 * 60_000); // tick 2, next=8m
    await vi.advanceTimersByTimeAsync(8 * 60_000); // tick 3, next=16m
    await vi.advanceTimersByTimeAsync(16 * 60_000); // tick 4, next=min(32, 30)=30m
    expect(ctrl.getDelayMs()).toBe(30 * 60_000);

    // Subsequent ticks stay at the cap.
    await vi.advanceTimersByTimeAsync(30 * 60_000); // tick 5
    expect(ctrl.getDelayMs()).toBe(30 * 60_000);
    await vi.advanceTimersByTimeAsync(30 * 60_000); // tick 6
    expect(ctrl.getDelayMs()).toBe(30 * 60_000);

    expect(refresh).toHaveBeenCalledTimes(6);
  });

  it('on recovery success: fires onSuccess, resets delay, idles', async () => {
    // Transient → transient → SUCCESS. After success, no more timers
    // should be armed, and the delay should be reset to BASE so the
    // NEXT cycle (e.g. user sleeps laptop again tomorrow) starts at
    // 2m not 8m.
    const { ctrl, refresh, onSuccess, onFatal } = makeController([
      'transient',
      'transient',
      'success',
    ]);
    ctrl.arm('first-cycle');

    await vi.advanceTimersByTimeAsync(2 * 60_000); // tick 1
    await vi.advanceTimersByTimeAsync(4 * 60_000); // tick 2
    await vi.advanceTimersByTimeAsync(8 * 60_000); // tick 3 → success

    expect(refresh).toHaveBeenCalledTimes(3);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onFatal).not.toHaveBeenCalled();
    expect(ctrl.isArmed()).toBe(false);
    // Reset to BASE so the next cycle starts fresh.
    expect(ctrl.getDelayMs()).toBe(TRANSIENT_RETRY_BASE_MS);
  });

  it('on fatal: fires onFatal, resets delay, idles', async () => {
    // Transient → FATAL (e.g. user revoked the token in Restream
    // settings mid-recovery). Stop retrying, fire onFatal so the
    // renderer flips to the bare sign-in CTA.
    const { ctrl, refresh, onSuccess, onFatal } = makeController([
      'transient',
      'fatal',
    ]);
    ctrl.arm('test');

    await vi.advanceTimersByTimeAsync(2 * 60_000); // tick 1
    await vi.advanceTimersByTimeAsync(4 * 60_000); // tick 2 → fatal

    expect(refresh).toHaveBeenCalledTimes(2);
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(ctrl.isArmed()).toBe(false);
    expect(ctrl.getDelayMs()).toBe(TRANSIENT_RETRY_BASE_MS);
  });

  it('coalesces concurrent arm() calls — one outstanding timer', async () => {
    // Pre-v0.1.70 the WS auto-retry loop fires every 60s during
    // disconnect. If arm() weren't idempotent, every 60s tick would
    // stack a fresh exponential ladder and Restream would get hammered
    // with parallel refreshes. The guard makes successive arm()s no-ops.
    const { ctrl, refresh } = makeController(['success']);

    ctrl.arm('first');
    const firstArmedDelay = ctrl.getDelayMs();
    ctrl.arm('second'); // no-op
    ctrl.arm('third');  // no-op
    ctrl.arm('fourth'); // no-op

    // Still just one outstanding timer (delay unchanged).
    expect(ctrl.isArmed()).toBe(true);
    expect(ctrl.getDelayMs()).toBe(firstArmedDelay);

    // Fire it: only ONE refresh happens.
    await vi.advanceTimersByTimeAsync(TRANSIENT_RETRY_BASE_MS);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('cancel(): tears down armed timer + resets delay', async () => {
    // Simulates AUTH_LOGOUT mid-recovery: the user manually signed out
    // while a retry was armed. The timer must NOT fire (it would call
    // refresh() against the wiped-token state); delay must reset so
    // re-signing-in + later transient blip starts at 2m, not at
    // wherever this cycle was.
    const { ctrl, refresh } = makeController(['transient', 'transient']);
    ctrl.arm('test');

    // Tick once to bump delay to 4m.
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(ctrl.getDelayMs()).toBe(4 * 60_000);
    expect(ctrl.isArmed()).toBe(true);

    // Cancel.
    ctrl.cancel();
    expect(ctrl.isArmed()).toBe(false);
    expect(ctrl.getDelayMs()).toBe(TRANSIENT_RETRY_BASE_MS);

    // Even if we advance through the would-be next-tick window, no
    // additional refresh fires.
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('cancel() is idempotent — safe to call when no timer is armed', () => {
    // Called from before-quit + AUTH_LOGOUT regardless of state.
    const { ctrl } = makeController([]);
    expect(() => ctrl.cancel()).not.toThrow();
    expect(() => ctrl.cancel()).not.toThrow();
    expect(ctrl.isArmed()).toBe(false);
  });

  it('refresh-throws: treats as transient + re-arms (defensive)', async () => {
    // refresh() shouldn't throw (the production OAuthCoordinator
    // catches everything internally) but if some future change
    // breaks that invariant, we don't want the user stranded with no
    // armed retry. Treat the throw as transient + re-arm with
    // doubled delay.
    const refresh = vi
      .fn()
      .mockRejectedValueOnce(new Error('refresh blew up'))
      .mockResolvedValueOnce('success' as RetryTickOutcome);
    const onSuccess = vi.fn();
    const onError = vi.fn();
    const ctrl = new TransientRefreshRetryController({
      refresh,
      onSuccess,
      onFatal: vi.fn(),
      onError,
    });
    ctrl.arm('test');

    await vi.advanceTimersByTimeAsync(2 * 60_000); // tick 1 → throw
    expect(onError).toHaveBeenCalledTimes(1);
    expect(ctrl.isArmed()).toBe(true);
    expect(ctrl.getDelayMs()).toBe(4 * 60_000);

    await vi.advanceTimersByTimeAsync(4 * 60_000); // tick 2 → success
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(ctrl.isArmed()).toBe(false);
  });

  it('passes origin through onTick for diagnostic logging', async () => {
    const { ctrl, onTick } = makeController(['transient']);
    ctrl.arm('startup'); // distinct origin

    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(onTick).toHaveBeenCalledWith(
      expect.objectContaining({ origin: 'startup' }),
    );
  });
});

// -------------------------------------------------------------------
// AUTH_STATUS shape pin — verifies the new fields the renderer keys
// off (`tokenLikelyValid`, `reconnectingDueToTransient`) are present
// on the shared AuthStatus type. If the type ever loses them the
// recovery banner gate would silently flip to "always false" and the
// bug would regress with no test failure — this catches the type
// regression at compile time.
// -------------------------------------------------------------------
import type { AuthStatus } from '../shared/types';

describe('AuthStatus shape (v0.1.70)', () => {
  it('accepts the v0.1.70 recovery-state fields', () => {
    // Type-checked at build time; the runtime expect just keeps the
    // test from being optimized away.
    const transientStatus: AuthStatus = {
      authenticated: false,
      tokenLikelyValid: true,
      reconnectingDueToTransient: true,
    };
    expect(transientStatus.tokenLikelyValid).toBe(true);
    expect(transientStatus.reconnectingDueToTransient).toBe(true);
  });

  it('keeps the fields optional (back-compat with pre-v0.1.70 callers)', () => {
    const fatalStatus: AuthStatus = { authenticated: false };
    const okStatus: AuthStatus = { authenticated: true, scope: 'x', expiresAt: 0 };
    expect(fatalStatus.tokenLikelyValid).toBeUndefined();
    expect(okStatus.tokenLikelyValid).toBeUndefined();
  });
});
