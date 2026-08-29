import { describe, expect, it, vi } from 'vitest';
import { readStartupAuthStatus } from '../main/startup-auth-status';
import type { TokenSet } from '../main/oauth';

const restoredToken: TokenSet = {
  accessToken: 'restored-access-token',
  refreshToken: 'stored-refresh-token',
  tokenType: 'Bearer',
  scope: 'profile.read chat.read',
  expiresAt: Date.now() + 60_000,
};

describe('startup AUTH_STATUS pull', () => {
  it('stays unresolved until startup token restoration finishes', async () => {
    let finishStartup: () => void = () => undefined;
    const startupAuthDone = new Promise<void>((resolve) => {
      finishStartup = resolve;
    });
    const getTokenAsync = vi.fn(async () => restoredToken);
    const isAuthenticatedAsync = vi.fn(async () => true);
    let settled = false;

    const statusPromise = readStartupAuthStatus({
      startupAuthDone,
      oauth: { getTokenAsync, isAuthenticatedAsync },
    }).then((status) => {
      settled = true;
      return status;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    expect(getTokenAsync).not.toHaveBeenCalled();
    expect(isAuthenticatedAsync).not.toHaveBeenCalled();

    finishStartup();

    await expect(statusPromise).resolves.toEqual({
      authenticated: true,
      scope: restoredToken.scope,
      expiresAt: restoredToken.expiresAt,
    });
    expect(getTokenAsync).toHaveBeenCalledTimes(1);
    expect(isAuthenticatedAsync).toHaveBeenCalledTimes(1);
  });

  it('reports signed out only after startup has conclusively resolved that way', async () => {
    const getTokenAsync = vi.fn(async () => undefined);
    const isAuthenticatedAsync = vi.fn(async () => false);

    await expect(
      readStartupAuthStatus({
        startupAuthDone: Promise.resolve(),
        oauth: { getTokenAsync, isAuthenticatedAsync },
      }),
    ).resolves.toEqual({
      authenticated: false,
      scope: undefined,
      expiresAt: undefined,
    });
  });
});
