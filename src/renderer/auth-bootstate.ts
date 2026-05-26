/**
 * v0.1.71 (cold-start flicker fix — voice 4198, 2026-05-26).
 *
 * Pure helpers for the renderer's "have we resolved cold-start auth yet?"
 * state machine. Kept DOM-free + side-effect-free here so the transitions
 * are unit-testable without booting React or Electron — see
 * `src/__tests__/auth-bootstate.test.ts` for the pin tests.
 *
 * THE BUG THIS FIXES
 * ------------------
 * Pre-v0.1.71 the renderer's `useState<AuthStatus>({ authenticated: false })`
 * defaulted to a synchronously-rendered "signed out" UI: the toolbar
 * showed the "Sign in to Restream" button while the main process was
 * still doing its async `oauth.getTokenAsync()` decrypt (~1-2s on cold
 * start) and had not yet sent the first AUTH_STATUS push. During that
 * window a user could click "Sign in" and accidentally start a fresh
 * OAuth round-trip even though they were already signed in. Voice 4198
 * on 2026-05-26 — Ethan did exactly that.
 *
 * THE FIX
 * -------
 * App.tsx now tracks a separate `AuthBootState` discriminator alongside
 * the existing `AuthStatus`. Initial value is `'checking'`. The very
 * first AUTH_STATUS we observe (either from the initial
 * `await rcpp.authStatus()` invoke OR from the `onAuthStatus` push)
 * transitions to `'signed_in'` / `'signed_out'`. A 5s timer escalates
 * `'checking'` → `'checking-slow'` so the user gets a "Still checking…"
 * subtitle instead of staring at a silent spinner. A 15s timer escalates
 * to `'verify_failed'` so we don't hang forever — the user gets a
 * "Couldn't verify sign-in — try again" affordance.
 *
 * INTERACTION WITH v0.1.70 transient-refresh banner
 * -------------------------------------------------
 * v0.1.70 added `tokenLikelyValid` + `reconnectingDueToTransient` for
 * mid-session refresh failures. That case is ORTHOGONAL to this one:
 * v0.1.70 = "we WERE signed in, hit a blip, recovering". v0.1.71 =
 * "we don't know yet, please wait". The cold-start spinner overlay
 * only renders while `bootState ∈ {'checking','checking-slow'}` and
 * disappears the moment we see the first AUTH_STATUS. The v0.1.70
 * banner takes over AFTER that point if the recovered status is
 * `authenticated: false + tokenLikelyValid: true`.
 */

import type { AuthBootState, AuthStatus } from '../shared/types';

/**
 * How long to wait in `'checking'` before showing the "Still checking…"
 * subtitle. ~5s matches the original spec voice 4198: "if it takes
 * longer than ~5 seconds (network slow, OAuth refresh slow), keep the
 * spinner but add a 'Still checking…' subtitle".
 */
export const AUTH_BOOT_SLOW_THRESHOLD_MS = 5_000;

/**
 * Hard timeout after which we give up and show the
 * "Couldn't verify sign-in — try again" retry affordance. 15s leaves
 * plenty of headroom for a slow OAuth refresh round-trip (Restream's
 * refresh endpoint has been observed taking up to ~8s on a cold AWS
 * link), while still guarding against the main process being completely
 * stuck and the user thinking the app is dead.
 */
export const AUTH_BOOT_FAIL_THRESHOLD_MS = 15_000;

/**
 * Returns the *initial* boot state for a fresh App mount. Always
 * `'checking'` — we DELIBERATELY do NOT seed from any synchronously
 * available `AuthStatus`, because the synchronous default IS the bug
 * we're fixing (the renderer can only know "signed out" by waiting for
 * the main process to confirm it).
 */
export function initialAuthBootState(): AuthBootState {
  return 'checking';
}

/**
 * Returns the next boot state after observing an AUTH_STATUS payload.
 *
 * Decision tree:
 *   - If we're still in `'checking'` / `'checking-slow'` / `'verify_failed'`,
 *     the AUTH_STATUS is the resolution we've been waiting for —
 *     transition to `'signed_in'` or `'signed_out'` based on
 *     `status.authenticated`. (Yes, even `'verify_failed'` recovers if
 *     a late AUTH_STATUS arrives — better to honour reality than the
 *     pessimistic timeout.)
 *   - If we're already in a terminal state (`'signed_in'` / `'signed_out'`),
 *     transition normally — subsequent AUTH_STATUS pushes drive ordinary
 *     mid-session transitions (sign-in completed, sign-out fired, etc.).
 *     We intentionally don't go BACK to `'checking'` because we've
 *     already resolved cold-start once and a fresh spinner would be
 *     visually confusing.
 */
export function reduceAuthBootOnStatus(
  prev: AuthBootState,
  status: AuthStatus,
): AuthBootState {
  // The terminal value tracks the most recent AUTH_STATUS — keeping
  // signed_in / signed_out in sync with `status.authenticated` lets
  // downstream UI (the spinner overlay) hide whenever we have a fresh
  // answer, even if that answer flipped mid-session.
  return status.authenticated ? 'signed_in' : 'signed_out';
}

/**
 * Returns the next boot state after the slow-threshold timer fires.
 *
 * Only escalates from `'checking'` → `'checking-slow'`. Any other prior
 * state means we already resolved (signed_in / signed_out) or already
 * escalated past slow (verify_failed) — leave it alone.
 */
export function reduceAuthBootOnSlowTimeout(
  prev: AuthBootState,
): AuthBootState {
  if (prev === 'checking') return 'checking-slow';
  return prev;
}

/**
 * Returns the next boot state after the hard-fail-threshold timer fires.
 *
 * Only escalates from a still-checking state (`'checking'` / `'checking-slow'`)
 * → `'verify_failed'`. Any other prior state means we resolved before
 * the timer expired — leave it alone.
 */
export function reduceAuthBootOnFailTimeout(
  prev: AuthBootState,
): AuthBootState {
  if (prev === 'checking' || prev === 'checking-slow') return 'verify_failed';
  return prev;
}

/**
 * True when the UI should render the centered cold-start spinner overlay
 * that blocks the Sign In button. The overlay covers the toolbar so a
 * mis-click during the boot window can't trigger an unwanted OAuth flow.
 *
 * Includes `'verify_failed'` deliberately — the retry affordance lives
 * INSIDE the same overlay surface (different content), so the overlay
 * stays mounted across the slow → failed escalation and the user never
 * sees a brief flash of the sign-in screen between them.
 */
export function shouldRenderBootOverlay(state: AuthBootState): boolean {
  return (
    state === 'checking' ||
    state === 'checking-slow' ||
    state === 'verify_failed'
  );
}

/**
 * True when ANY auth-keyed renderer logic should be suppressed because
 * we haven't resolved cold-start yet. Used to gate things like:
 *
 *   - The toolbar sign-in / sign-out / settings / reconnect buttons.
 *   - The "Not signed in" status label (we want to render
 *     "Checking sign-in…" instead during this window).
 *   - The ChatInputInline + ChatFeed authenticated-only branches.
 *   - Any "we're signed out, kick off a fresh action" auto-logic.
 *
 * Specifically does NOT include `'verify_failed'` — by the time we hit
 * 15s with no AUTH_STATUS the user has likely already concluded the app
 * is stuck; showing them the regular UI plus the retry chip is a more
 * useful escape hatch than continuing to hide everything behind the
 * spinner forever.
 */
export function isAuthBootPending(state: AuthBootState): boolean {
  return state === 'checking' || state === 'checking-slow';
}
