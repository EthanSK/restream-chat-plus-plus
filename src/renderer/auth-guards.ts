/**
 * Auth-flow guard helpers — pure, DOM-free, unit-testable.
 *
 * Sign-out is destructive (clears the OAuth token, forces re-auth on next
 * launch) so we gate it behind a native confirm dialog. The dialog itself
 * comes from `window.confirm` at runtime, but the gate logic lives here so
 * the cancel-path-does-not-clear behaviour can be tested without a DOM.
 */

/**
 * Returns `true` if the caller should proceed with the destructive sign-out,
 * `false` if the user cancelled (or the env has no confirm primitive —
 * defensive default: do NOT log the user out).
 */
export function shouldProceedWithSignOut(
  confirmFn: ((message?: string) => boolean) | undefined,
): boolean {
  if (typeof confirmFn !== 'function') return false;
  return confirmFn("Sign out of Restream? You'll need to re-authenticate.");
}
