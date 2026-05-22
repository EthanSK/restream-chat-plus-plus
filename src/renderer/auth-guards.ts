/**
 * Auth-flow guard helpers — pure, DOM-free, unit-testable.
 *
 * Sign-out is destructive (clears the OAuth token, forces re-auth on next
 * launch) so we gate it behind a native confirm dialog.
 *
 * v0.1.52: confirmFn is now async — routed to `dialog.showMessageBox` in
 * the main process via the AUTH_CONFIRM_LOGOUT IPC channel. The previous
 * implementation used `window.confirm()` directly, which in Electron's
 * BrowserWindow context was returning `false` without ever showing a
 * dialog, causing the visible-bug "click Sign out and nothing happens".
 * See `src/main/main.ts` AUTH_CONFIRM_LOGOUT handler for the why.
 *
 * The gate logic stays here so the cancel-path-does-not-clear behaviour
 * stays unit-testable without a DOM. Tests pass an async stub.
 */

/**
 * Returns `true` if the caller should proceed with the destructive sign-out,
 * `false` if the user cancelled (or the env has no confirm primitive —
 * defensive default: do NOT log the user out).
 */
export async function shouldProceedWithSignOut(
  confirmFn: (() => Promise<boolean>) | undefined,
): Promise<boolean> {
  if (typeof confirmFn !== 'function') return false;
  try {
    return await confirmFn();
  } catch {
    // Defensive: if the confirm transport throws, fail closed.
    return false;
  }
}
