import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import assert from 'node:assert/strict';
import { describe, expect, it, vi } from 'vitest';
import { IPC } from '../shared/types';
import { readStartupAuthStatus } from '../main/startup-auth-status';

/** Run the actual auth IPC registration block without starting the Electron app or touching a real account. */
function authHandlers() {
  const source = readFileSync(new URL('../main/main.ts', import.meta.url), 'utf8');
  const block = source.slice(source.indexOf('  // ----- IPC: auth -----'), source.indexOf('  ipcMain.handle(IPC.AUTH_STATUS,'));
  const handlers = new Map<string, () => Promise<unknown>>();
  let finishRepair!: (value: { ok: boolean }) => void;
  const repair = new Promise<{ ok: boolean }>((resolve) => { finishRepair = resolve; });
  const send = vi.fn();
  const authenticate = vi.fn(async () => ({ accessToken: 'test-access', scope: 'chat.read', expiresAt: 123 }));
  const isAuthenticatedAsync = vi.fn(async () => true);
  const chat = { setToken: vi.fn(), start: vi.fn() };
  const ensureRestreamChatCookies = vi.fn(() => repair);
  runInNewContext(ts.transpile(block, { target: ts.ScriptTarget.ES2022 }), {
    ipcMain: { handle: (channel: string, handler: () => Promise<unknown>) => handlers.set(channel, handler) },
    IPC, oauth: { authenticate, isAuthenticatedAsync, getTokenAsync: async () => undefined }, chat,
    readStartupAuthStatus, startupAuthDone: Promise.resolve(),
    viewerStats: { setToken: vi.fn(), start: vi.fn() },
    mainWindow: { webContents: { send } }, ensureRestreamChatCookies,
    console: { warn: vi.fn(), error: vi.fn() }, appendErrorLog: vi.fn(), errorToString: String,
  });
  return { handlers, finishRepair, send, authenticate, isAuthenticatedAsync, chat, ensureRestreamChatCookies };
}

describe('sending-login IPC boundary', () => {
  it('does not report stale signed-in state after the user signs out during website login', async () => {
    const ctx = authHandlers();
    const handler = ctx.handlers.get(IPC.AUTH_START);
    assert(handler);
    const pending = handler();
    await vi.waitFor(() => expect(ctx.send).toHaveBeenCalledOnce());
    ctx.isAuthenticatedAsync.mockResolvedValue(false);
    ctx.finishRepair({ ok: false });
    expect(await pending).toMatchObject({ authenticated: false });
  });
  it('repairs only website login without replacing OAuth or restarting receiving chat', async () => {
    const ctx = authHandlers();
    const handler = ctx.handlers.get(IPC.CHAT_SIGN_IN);
    assert(handler);
    const pending = handler();
    expect(ctx.ensureRestreamChatCookies).toHaveBeenCalledOnce();
    expect(ctx.authenticate).not.toHaveBeenCalled();
    expect(ctx.chat.start).not.toHaveBeenCalled();
    ctx.finishRepair({ ok: true });
    expect(await pending).toBe(true);
    expect(ctx.send).not.toHaveBeenCalled();
  });

  it('makes receiving chat visible after OAuth, before sending login completes', async () => {
    const ctx = authHandlers();
    const handler = ctx.handlers.get(IPC.AUTH_START);
    assert(handler);
    const pending = handler();
    await vi.waitFor(() => expect(ctx.send).toHaveBeenCalledWith(IPC.AUTH_STATUS, expect.objectContaining({ authenticated: true })));
    expect(ctx.chat.start).toHaveBeenCalledOnce();
    ctx.finishRepair({ ok: false });
    expect(await pending).toMatchObject({ authenticated: true });
    expect(ctx.send).toHaveBeenCalledOnce();
  });
});
