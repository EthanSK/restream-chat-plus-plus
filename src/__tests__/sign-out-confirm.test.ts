import { describe, it, expect, vi } from 'vitest';
import { shouldProceedWithSignOut } from '../renderer/auth-guards';

describe('shouldProceedWithSignOut', () => {
  it('returns true when the user clicks Sign out on the confirm dialog', async () => {
    const confirmFn = vi.fn().mockResolvedValue(true);
    await expect(shouldProceedWithSignOut(confirmFn)).resolves.toBe(true);
    expect(confirmFn).toHaveBeenCalledTimes(1);
  });

  it('returns false when the user cancels — token MUST NOT be cleared', async () => {
    const confirmFn = vi.fn().mockResolvedValue(false);
    await expect(shouldProceedWithSignOut(confirmFn)).resolves.toBe(false);
  });

  it('returns false (fail-safe) when no confirm primitive is available', async () => {
    // Defensive default — if some non-DOM env is wired up wrong we'd rather
    // refuse to sign out than silently nuke the OAuth token.
    await expect(shouldProceedWithSignOut(undefined)).resolves.toBe(false);
  });

  it('returns false when the confirm transport throws (fail-closed)', async () => {
    // v0.1.52: if the IPC transport rejects, never log the user out.
    const confirmFn = vi.fn().mockRejectedValue(new Error('IPC torn down'));
    await expect(shouldProceedWithSignOut(confirmFn)).resolves.toBe(false);
  });
});
