import { describe, it, expect, vi } from 'vitest';
import { shouldProceedWithSignOut } from '../renderer/auth-guards';

describe('shouldProceedWithSignOut', () => {
  it('returns true when the user clicks OK on the confirm dialog', () => {
    const confirmFn = vi.fn().mockReturnValue(true);
    expect(shouldProceedWithSignOut(confirmFn)).toBe(true);
    expect(confirmFn).toHaveBeenCalledTimes(1);
    expect(confirmFn).toHaveBeenCalledWith(
      "Sign out of Restream? You'll need to re-authenticate.",
    );
  });

  it('returns false when the user cancels — token MUST NOT be cleared', () => {
    const confirmFn = vi.fn().mockReturnValue(false);
    expect(shouldProceedWithSignOut(confirmFn)).toBe(false);
  });

  it('returns false (fail-safe) when no confirm primitive is available', () => {
    // Defensive default — if some non-DOM env is wired up wrong we'd rather
    // refuse to sign out than silently nuke the OAuth token.
    expect(shouldProceedWithSignOut(undefined)).toBe(false);
  });
});
