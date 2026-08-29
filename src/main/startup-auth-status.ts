import type { TokenSet } from './oauth';
import type { AuthStatus } from '../shared/types';

interface StartupAuthStatusDeps {
  startupAuthDone: Promise<void>;
  oauth: {
    getTokenAsync: () => Promise<TokenSet | undefined>;
    isAuthenticatedAsync: () => Promise<boolean>;
  };
}

/**
 * Read the renderer's first auth snapshot only after startup restoration has
 * reached a final state.
 *
 * The push path already waits for `startupAuthDone`, but the renderer also
 * performs an AUTH_STATUS pull as soon as it mounts. Before v0.1.110 that pull
 * could observe an expired access token while the refresh-token leg was still
 * running and briefly render Sign in. Whichever path wins the mount race must
 * therefore share the same startup boundary.
 *
 * After startup the promise is already resolved, so later status reads remain
 * immediate and continue to report the current OAuth truth.
 */
export async function readStartupAuthStatus(
  deps: StartupAuthStatusDeps,
): Promise<AuthStatus> {
  await deps.startupAuthDone;
  const token = await deps.oauth.getTokenAsync();
  return {
    authenticated: await deps.oauth.isAuthenticatedAsync(),
    scope: token?.scope,
    expiresAt: token?.expiresAt,
  };
}
