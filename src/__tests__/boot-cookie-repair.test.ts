import { describe, it, expect, vi } from 'vitest';
import { resumeAuthWithCookieRepair } from '../main/startup-auth-resume';
import type { TokenSet } from '../main/oauth';

/**
 * v0.1.63 — startup cookie repair regression coverage.
 *
 * v0.1.62 repaired chat.restream.io cookies only after fresh OAuth sign-in
 * (`AUTH_START`). Already-authenticated users who installed through the
 * in-app updater skipped that path entirely: startup resumed their stored
 * OAuth token, started the WebSocket, and never rehydrated the
 * `persist:restream-oauth` chat-session cookies required for REST sends.
 */

function token(accessToken: string): TokenSet {
  return {
    accessToken,
    refreshToken: 'refresh-token',
    tokenType: 'Bearer',
    scope: 'chat.read chat.write',
    expiresAt: Date.now() + 60_000,
  };
}

describe('startup auth resume cookie repair (v0.1.63)', () => {
  it('repairs chat cookies after chat.start when a stored token is restored', async () => {
    const order: string[] = [];
    const stored = token('stored-access-token');
    const ensureRestreamChatCookies = vi.fn(async () => {
      order.push('ensure-cookies');
      return {
        ok: true,
        reason: 'already-present' as const,
        cookieCount: 3,
        hasXsrf: true,
      };
    });
    const chat = {
      setToken: vi.fn((accessToken: string) => {
        order.push(`set-token:${accessToken}`);
      }),
      start: vi.fn(() => {
        order.push('chat-start');
      }),
    };
    const pushAuthStatus = vi.fn(() => {
      order.push('push-auth-status');
    });
    const resolveStartupAuth = vi.fn(() => {
      order.push('resolve-startup-auth');
    });

    await resumeAuthWithCookieRepair({
      oauth: {
        isAuthenticatedAsync: vi.fn(async () => true),
        getTokenAsync: vi.fn(async () => stored),
        refresh: vi.fn(async () => undefined),
      },
      chat,
      ensureRestreamChatCookies,
      parentWindow: 'main-window' as any,
      pushAuthStatus,
      resolveStartupAuth,
      logWarn: vi.fn(),
      logError: vi.fn(),
    });

    expect(chat.setToken).toHaveBeenCalledWith('stored-access-token');
    expect(ensureRestreamChatCookies).toHaveBeenCalledWith({
      parentWindow: 'main-window',
      interactiveFallback: true,
    });
    expect(order).toEqual([
      'set-token:stored-access-token',
      'chat-start',
      'ensure-cookies',
      'push-auth-status',
      'resolve-startup-auth',
    ]);
  });

  it('also repairs chat cookies after the refresh-token startup leg succeeds', async () => {
    const order: string[] = [];
    const refreshed = token('refreshed-access-token');
    const ensureRestreamChatCookies = vi.fn(async () => {
      order.push('ensure-cookies');
      return {
        ok: true,
        reason: 'headless' as const,
        cookieCount: 3,
        hasXsrf: true,
      };
    });

    await resumeAuthWithCookieRepair({
      oauth: {
        isAuthenticatedAsync: vi.fn(async () => false),
        getTokenAsync: vi.fn(async () => undefined),
        refresh: vi.fn(async () => refreshed),
      },
      chat: {
        setToken: vi.fn((accessToken: string) => {
          order.push(`set-token:${accessToken}`);
        }),
        start: vi.fn(() => {
          order.push('chat-start');
        }),
      },
      ensureRestreamChatCookies,
      parentWindow: null,
      pushAuthStatus: vi.fn(() => {
        order.push('push-auth-status');
      }),
      resolveStartupAuth: vi.fn(() => {
        order.push('resolve-startup-auth');
      }),
      logWarn: vi.fn(),
      logError: vi.fn(),
    });

    expect(order).toEqual([
      'set-token:refreshed-access-token',
      'chat-start',
      'ensure-cookies',
      'push-auth-status',
      'resolve-startup-auth',
    ]);
  });
});
