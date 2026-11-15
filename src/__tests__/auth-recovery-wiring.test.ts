import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { IPC, type AuthStatus } from '../shared/types';
import type { TokenSet } from '../main/oauth';
import type { ChatSendQueueOptions } from '../main/chat-send-queue';

/** Execute the real main-process recovery closures with fake account and transport dependencies. */
function recoveryWiring() {
  const source = readFileSync(new URL('../main/main.ts', import.meta.url), 'utf8');
  const tree = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
  const declarations = new Map<string, string>();
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'pushAuthStatus') declarations.set('push', node.getText(tree));
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      if (node.name.text === 'performFullReconnect' && node.initializer) declarations.set('reconnect', node.initializer.getText(tree));
      if (node.name.text === 'viewerStats' && node.initializer && ts.isNewExpression(node.initializer)) {
        const provider = node.initializer.arguments?.[0];
        if (provider) declarations.set('viewer', provider.getText(tree));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  for (const name of ['push', 'reconnect', 'viewer']) assert(declarations.has(name), `Missing main.ts recovery declaration: ${name}`);
  const token: TokenSet = { accessToken: 'test-expired', refreshToken: 'test-refresh', tokenType: 'Bearer', scope: 'chat.read', expiresAt: Date.now() - 1000 };
  const state: { token?: TokenSet; auth: AuthStatus; retryArmed: boolean } = { token, auth: { authenticated: true }, retryArmed: false };
  const fresh: TokenSet = { ...token, accessToken: 'test-fresh', expiresAt: Date.now() + 3_600_000 };
  const refresh = vi.fn(async (): Promise<TokenSet | undefined> => undefined);
  const failure = vi.fn(() => 'transient');
  const send = vi.fn((_channel: string, auth: AuthStatus) => { state.auth = auth; });
  const chat = { setToken: vi.fn(), reconnect: vi.fn() };
  const viewerStats = { setToken: vi.fn(), reconnect: vi.fn() };
  const cancel = vi.fn(() => { state.retryArmed = false; });
  const handlers = new Map<string, () => Promise<unknown>>();
  const executable = [declarations.get('push'), `capture('viewer', ${declarations.get('viewer')});`, `capture('reconnect', ${declarations.get('reconnect')});`].join('\n');
  runInNewContext(ts.transpile(executable, { target: ts.ScriptTarget.ES2022 }), {
    Date, IPC, mainWindow: { webContents: { send } }, chat, viewerStats,
    oauth: {
      getToken: () => state.token, getTokenAsync: async () => state.token,
      isAuthenticated: () => !!state.token && state.token.expiresAt - Date.now() > 60_000,
      refresh, getLastRefreshFailure: failure,
    },
    armTransientRefreshRetry: () => { state.retryArmed = true; }, cancelTransientRefreshRetry: cancel,
    console: { error: vi.fn() }, appendErrorLog: vi.fn(),
    capture: (name: string, handler: () => Promise<unknown>) => handlers.set(name, handler),
  });
  const reconnect = handlers.get('reconnect');
  const viewer = handlers.get('viewer');
  assert(reconnect && viewer);
  return { state, fresh, refresh, failure, send, chat, viewerStats, cancel, reconnect, viewer };
}

describe('main-process auth recovery publication', () => {
  it('clears false sign-out when the viewer refresh wins after a network failure', async () => {
    const ctx = recoveryWiring();
    expect(await ctx.reconnect()).toMatchObject({ ok: false, reason: 'refresh-failed' });
    expect(ctx.state.auth).toMatchObject({ authenticated: false, tokenLikelyValid: true });
    expect(ctx.state.retryArmed).toBe(true);
    ctx.refresh.mockImplementationOnce(async () => { ctx.state.token = ctx.fresh; return ctx.fresh; });
    expect(await ctx.viewer()).toBe(ctx.fresh.accessToken);
    expect(ctx.state.auth).toMatchObject({ authenticated: true, expiresAt: ctx.fresh.expiresAt });
    expect(ctx.state.auth.tokenLikelyValid).toBeUndefined();
    expect(ctx.chat.reconnect).not.toHaveBeenCalled(); // Viewer recovery must publish auth without interrupting the independent receiving socket.
    expect(await ctx.reconnect()).toMatchObject({ ok: true });
    expect(ctx.state.auth.authenticated).toBe(true);
    expect(ctx.state.retryArmed).toBe(false);
    expect(ctx.refresh).toHaveBeenCalledTimes(2);
  });

  it('publishes a reused valid grant before cancelling the recovery timer', async () => {
    const ctx = recoveryWiring();
    await ctx.reconnect();
    ctx.state.token = ctx.fresh; // Another existing recovery path may already have renewed the grant before this reconnect.
    ctx.send.mockClear();
    expect(await ctx.reconnect()).toMatchObject({ ok: true });
    expect(ctx.send).toHaveBeenCalledWith(IPC.AUTH_STATUS, expect.objectContaining({ authenticated: true }));
    expect(ctx.send.mock.invocationCallOrder[0]).toBeLessThan(ctx.cancel.mock.invocationCallOrder[0]);
    expect(ctx.refresh).toHaveBeenCalledOnce();
  });

  it('keeps the recovery hint when the viewer refresh also fails transiently', async () => {
    const ctx = recoveryWiring();
    await ctx.reconnect();
    const recovering = ctx.state.auth;
    ctx.send.mockClear();
    expect(await ctx.viewer()).toBeUndefined();
    expect(ctx.state.auth).toBe(recovering);
    expect(ctx.state.retryArmed).toBe(true);
    expect(ctx.send).not.toHaveBeenCalled();
    expect(ctx.state.token).toBeDefined();
  });

  it('does not refresh or reconnect receiving chat for a healthy viewer token', async () => {
    const ctx = recoveryWiring();
    ctx.state.token = ctx.fresh;
    expect(await ctx.viewer()).toBe(ctx.fresh.accessToken);
    expect(ctx.refresh).not.toHaveBeenCalled();
    expect(ctx.chat.reconnect).not.toHaveBeenCalled();
  });

  it('uses current auth truth instead of a late viewer refresh result after logout', async () => {
    const ctx = recoveryWiring();
    ctx.refresh.mockImplementationOnce(async () => {
      ctx.state.token = undefined;
      ctx.state.auth = { authenticated: false };
      return ctx.fresh;
    });
    await ctx.viewer();
    expect(ctx.state.auth.authenticated).toBe(false);
    expect(ctx.send).not.toHaveBeenCalledWith(IPC.AUTH_STATUS, expect.objectContaining({ authenticated: true }));
  });

  it('does not revive a missing or definitively rejected grant', async () => {
    const ctx = recoveryWiring();
    ctx.failure.mockReturnValue('fatal');
    ctx.refresh.mockImplementationOnce(async () => { ctx.state.token = undefined; return undefined; });
    expect(await ctx.reconnect()).toMatchObject({ ok: false });
    expect(ctx.state.auth).toEqual({ authenticated: false });
    expect(await ctx.reconnect()).toMatchObject({ ok: false, reason: 'not-authenticated' });
    expect(await ctx.viewer()).toBeUndefined();
    expect(ctx.refresh).toHaveBeenCalledOnce();
    expect(ctx.chat.reconnect).not.toHaveBeenCalled();
  });
});

/** Run the production send-retry callback without opening account or transport connections. */
function sendRetryWiring() {
  const source = readFileSync(new URL('../main/main.ts', import.meta.url), 'utf8');
  const tree = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
  let callbackSource: string | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'sendQueue' && node.initializer && ts.isCallExpression(node.initializer)) {
      const options = node.initializer.arguments[0];
      if (options && ts.isObjectLiteralExpression(options)) {
        const property = options.properties.find((entry) => ts.isPropertyAssignment(entry) && entry.name.getText(tree) === 'reconnectBetweenRetries');
        if (property && ts.isPropertyAssignment(property)) callbackSource = property.initializer.getText(tree);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert(callbackSource);
  let retry: NonNullable<ChatSendQueueOptions['reconnectBetweenRetries']> | undefined;
  const reconnect = vi.fn(async () => ({ ok: true }));
  runInNewContext(ts.transpile(`capture(${callbackSource});`, { target: ts.ScriptTarget.ES2022 }), {
    performFullReconnect: reconnect,
    capture: (callback: NonNullable<ChatSendQueueOptions['reconnectBetweenRetries']>) => { retry = callback; },
  });
  assert(retry);
  return { retry, reconnect };
}

describe('send-retry connection ownership', () => {
  it('keeps healthy receiving chat open when only the website sending credential is missing', async () => {
    const ctx = sendRetryWiring();
    await ctx.retry('send-retry', {
      ok: false,
      reason: 'destination-send-failed',
      destinations: [
        { destination: 'restream', ok: false, reason: 'no-session-cookies' },
        { destination: 'twitch', ok: true },
      ],
    });
    expect(ctx.reconnect).not.toHaveBeenCalled();
  });

  it('keeps the same isolation for a direct missing-cookie result', async () => {
    const ctx = sendRetryWiring();
    await ctx.retry('send-retry', { ok: false, reason: 'no-session-cookies' });
    expect(ctx.reconnect).not.toHaveBeenCalled();
  });

  it('still reconnects Restream after an actual Restream transport failure', async () => {
    const ctx = sendRetryWiring();
    await ctx.retry('send-retry', {
      ok: false,
      reason: 'destination-send-failed',
      destinations: [{ destination: 'restream', ok: false, reason: 'send-failed', status: 503 }],
    });
    expect(ctx.reconnect).toHaveBeenCalledOnce();
  });

  it('continues to isolate failed direct destinations', async () => {
    const ctx = sendRetryWiring();
    await ctx.retry('send-retry', {
      ok: false,
      reason: 'destination-send-failed',
      destinations: [{ destination: 'kick', ok: false, status: 503 }],
    });
    expect(ctx.reconnect).not.toHaveBeenCalled();
  });
});
