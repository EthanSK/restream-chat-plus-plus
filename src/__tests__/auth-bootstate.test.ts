import { describe, it, expect } from 'vitest';
import {
  AUTH_BOOT_FAIL_THRESHOLD_MS,
  AUTH_BOOT_SLOW_THRESHOLD_MS,
  initialAuthBootState,
  isAuthBootPending,
  reduceAuthBootOnFailTimeout,
  reduceAuthBootOnSlowTimeout,
  reduceAuthBootOnStatus,
  shouldRenderBootOverlay,
} from '../renderer/auth-bootstate';
import type { AuthStatus } from '../shared/types';

/**
 * v0.1.71 cold-start flicker fix (voice 4198, 2026-05-26).
 *
 * Pin tests for the pure state-machine helpers backing the cold-start
 * auth spinner overlay. The actual UI rendering is exercised manually
 * via cold-start the packaged build; these tests pin the transition
 * graph so a future refactor can't silently regress the bug Ethan hit
 * on 2026-05-26 (accidental sign-in click during the ~1-2s pre-decrypt
 * window).
 */

describe('auth-bootstate — initial state', () => {
  it('starts in "checking" — never seeds from a synchronous default', () => {
    // Re-grounding: the WHOLE bug is that the renderer's synchronous
    // `useState<AuthStatus>({ authenticated: false })` lies during the
    // cold-start window. The boot discriminator must NOT lie the same
    // way, so it always starts at "checking".
    expect(initialAuthBootState()).toBe('checking');
  });
});

describe('auth-bootstate — threshold constants', () => {
  it('slow threshold is 5s (per voice 4198 "after ~5 seconds")', () => {
    expect(AUTH_BOOT_SLOW_THRESHOLD_MS).toBe(5_000);
  });

  it('fail threshold is 15s (per voice 4198 "after 15s + no AUTH_STATUS")', () => {
    expect(AUTH_BOOT_FAIL_THRESHOLD_MS).toBe(15_000);
  });

  it('fail threshold is strictly greater than slow threshold', () => {
    // Defensive: if a future refactor swapped these, the slow timer
    // would fire AFTER the fail timer and the user would briefly see
    // the spinner re-escalate to "Still checking…" after they got the
    // "Try again" button. Guard with a hard ordering invariant.
    expect(AUTH_BOOT_FAIL_THRESHOLD_MS).toBeGreaterThan(
      AUTH_BOOT_SLOW_THRESHOLD_MS,
    );
  });
});

describe('auth-bootstate — reduceAuthBootOnStatus', () => {
  const signedIn: AuthStatus = { authenticated: true };
  const signedOut: AuthStatus = { authenticated: false };

  it('checking + signed_in status → signed_in (the happy cold-start path)', () => {
    expect(reduceAuthBootOnStatus('checking', signedIn)).toBe('signed_in');
  });

  it('checking + signed_out status → signed_out (cold-start, never signed in)', () => {
    expect(reduceAuthBootOnStatus('checking', signedOut)).toBe('signed_out');
  });

  it('checking-slow + signed_in status → signed_in (slow-tier resolves)', () => {
    expect(reduceAuthBootOnStatus('checking-slow', signedIn)).toBe('signed_in');
  });

  it('verify_failed + signed_in status → signed_in (late status recovers)', () => {
    // The 15s timer fired and we showed the retry affordance, but the
    // main process eventually pushed AUTH_STATUS anyway. Honour reality
    // over the pessimistic timeout — flip to signed_in.
    expect(reduceAuthBootOnStatus('verify_failed', signedIn)).toBe('signed_in');
  });

  it('signed_in + signed_out status → signed_out (mid-session sign-out)', () => {
    // Normal mid-session transition: the user clicked Sign Out and
    // confirmed. The discriminator tracks reality.
    expect(reduceAuthBootOnStatus('signed_in', signedOut)).toBe('signed_out');
  });

  it('signed_out + signed_in status → signed_in (mid-session sign-in success)', () => {
    expect(reduceAuthBootOnStatus('signed_out', signedIn)).toBe('signed_in');
  });
});

describe('auth-bootstate — reduceAuthBootOnSlowTimeout', () => {
  it('checking → checking-slow (5s elapsed with no AUTH_STATUS yet)', () => {
    expect(reduceAuthBootOnSlowTimeout('checking')).toBe('checking-slow');
  });

  it('signed_in → signed_in (resolved before slow timer fired; no-op)', () => {
    // The slow timer races against `applyAuthStatus`. If applyAuthStatus
    // won the race the timer should be a no-op even if it fires
    // slightly late (e.g. the clearTimeout call happens AFTER the
    // setTimeout callback was already queued on the next tick).
    expect(reduceAuthBootOnSlowTimeout('signed_in')).toBe('signed_in');
  });

  it('signed_out → signed_out (resolved before slow timer fired; no-op)', () => {
    expect(reduceAuthBootOnSlowTimeout('signed_out')).toBe('signed_out');
  });

  it('checking-slow → checking-slow (timer firing twice is idempotent)', () => {
    expect(reduceAuthBootOnSlowTimeout('checking-slow')).toBe('checking-slow');
  });

  it('verify_failed → verify_failed (already escalated past slow; no-op)', () => {
    expect(reduceAuthBootOnSlowTimeout('verify_failed')).toBe('verify_failed');
  });
});

describe('auth-bootstate — reduceAuthBootOnFailTimeout', () => {
  it('checking → verify_failed (15s elapsed with no AUTH_STATUS)', () => {
    expect(reduceAuthBootOnFailTimeout('checking')).toBe('verify_failed');
  });

  it('checking-slow → verify_failed (15s elapsed; we were already showing the slow subtitle)', () => {
    expect(reduceAuthBootOnFailTimeout('checking-slow')).toBe('verify_failed');
  });

  it('signed_in → signed_in (resolved before fail timer fired; no-op)', () => {
    expect(reduceAuthBootOnFailTimeout('signed_in')).toBe('signed_in');
  });

  it('signed_out → signed_out (resolved before fail timer fired; no-op)', () => {
    expect(reduceAuthBootOnFailTimeout('signed_out')).toBe('signed_out');
  });

  it('verify_failed → verify_failed (idempotent if fired twice)', () => {
    expect(reduceAuthBootOnFailTimeout('verify_failed')).toBe('verify_failed');
  });
});

describe('auth-bootstate — shouldRenderBootOverlay', () => {
  it('renders overlay during checking', () => {
    expect(shouldRenderBootOverlay('checking')).toBe(true);
  });

  it('renders overlay during checking-slow', () => {
    expect(shouldRenderBootOverlay('checking-slow')).toBe(true);
  });

  it('renders overlay on verify_failed (retry button lives inside the overlay)', () => {
    // The verify_failed surface shares the overlay's centered card so
    // the slow→failed escalation doesn't briefly flash the underlying
    // sign-in screen between renders.
    expect(shouldRenderBootOverlay('verify_failed')).toBe(true);
  });

  it('hides overlay once signed_in (the cold-start window is over)', () => {
    expect(shouldRenderBootOverlay('signed_in')).toBe(false);
  });

  it('hides overlay once signed_out (the cold-start window is over)', () => {
    // signed_out is a TERMINAL resolution — we know the user really is
    // signed out, the regular Sign In button is now the correct UI.
    expect(shouldRenderBootOverlay('signed_out')).toBe(false);
  });
});

describe('auth-bootstate — isAuthBootPending', () => {
  it('returns true during checking (gate auth-keyed UI)', () => {
    expect(isAuthBootPending('checking')).toBe(true);
  });

  it('returns true during checking-slow', () => {
    expect(isAuthBootPending('checking-slow')).toBe(true);
  });

  it('returns false on verify_failed (let the regular UI show with retry chip)', () => {
    // Deliberately NOT pending: by the time we hit 15s with no
    // AUTH_STATUS, hiding the toolbar forever is worse UX than showing
    // it (the retry button on the overlay is the escape hatch).
    expect(isAuthBootPending('verify_failed')).toBe(false);
  });

  it('returns false once signed_in (regular signed-in UI takes over)', () => {
    expect(isAuthBootPending('signed_in')).toBe(false);
  });

  it('returns false once signed_out (regular sign-in CTA shows)', () => {
    expect(isAuthBootPending('signed_out')).toBe(false);
  });
});

describe('auth-bootstate — full cold-start happy path', () => {
  it('checking → applyStatus(true) ends in signed_in with no overlay', () => {
    // Simulates the happy cold-start: fresh App mount, initial pull
    // resolves within ~1s with authenticated=true, overlay disappears.
    let state = initialAuthBootState();
    expect(state).toBe('checking');
    expect(shouldRenderBootOverlay(state)).toBe(true);

    state = reduceAuthBootOnStatus(state, { authenticated: true });
    expect(state).toBe('signed_in');
    expect(shouldRenderBootOverlay(state)).toBe(false);
    expect(isAuthBootPending(state)).toBe(false);
  });
});

describe('auth-bootstate — full degraded path', () => {
  it('checking → slow → fail → applyStatus(true) recovers', () => {
    // Simulates a network-stuck cold-start: 5s elapse → slow subtitle,
    // 15s elapse → retry button, eventually a late push arrives and
    // we honour reality.
    let state = initialAuthBootState();
    state = reduceAuthBootOnSlowTimeout(state);
    expect(state).toBe('checking-slow');
    state = reduceAuthBootOnFailTimeout(state);
    expect(state).toBe('verify_failed');
    state = reduceAuthBootOnStatus(state, { authenticated: true });
    expect(state).toBe('signed_in');
  });
});

describe('auth-bootstate — timer-race safety', () => {
  it('applyStatus first, then late slow/fail timers fire → still signed_in', () => {
    // The most common race: applyAuthStatus resolves at t=800ms,
    // clears the slow timer, but a queued microtask fires the slow
    // reducer anyway (e.g. if clearTimeout couldn't beat the macrotask
    // dispatch). The reducer must be a no-op in this case.
    let state = initialAuthBootState();
    state = reduceAuthBootOnStatus(state, { authenticated: true });
    state = reduceAuthBootOnSlowTimeout(state);
    state = reduceAuthBootOnFailTimeout(state);
    expect(state).toBe('signed_in');
  });
});
