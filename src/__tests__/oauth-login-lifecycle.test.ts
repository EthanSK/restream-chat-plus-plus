// Exercise the real login coordinator with fake windows and listeners, without binding the live app's OAuth port.
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Store } from '../main/store';

const state = vi.hoisted((): {
  windows: Array<{ close(): void; focus: ReturnType<typeof vi.fn> }>;
  servers: Array<{ close: ReturnType<typeof vi.fn>; emit: EventEmitter['emit'] }>;
  activeServer?: object;
} => ({ windows: [], servers: [] }));

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    BrowserWindow: class extends EventEmitter {
      private destroyed = false;
      focus = vi.fn();
      webContents = { id: state.windows.length + 1, getUserAgent: () => 'Test Electron/42' };
      loadURL = vi.fn(async () => undefined);
      constructor() { super(); state.windows.push(this); }
      isDestroyed() { return this.destroyed; }
      close() { if (!this.destroyed) { this.destroyed = true; this.emit('closed'); } }
    },
    session: { fromPartition: () => ({ setPermissionRequestHandler: vi.fn() }) },
    safeStorage: { isEncryptionAvailable: () => false },
  };
});

vi.mock('node:http', async () => {
  const { EventEmitter } = await import('node:events');
  return { default: { createServer: () => {
    class Listener extends EventEmitter {
      listen() {
        if (state.activeServer) queueMicrotask(() => this.emit('error', new Error('EADDRINUSE')));
        else state.activeServer = this;
        return this;
      }
      close = vi.fn(() => { if (state.activeServer === this) state.activeServer = undefined; });
    }
    const server = new Listener();
    state.servers.push(server);
    return server;
  } } };
});

vi.mock('../main/credentials', () => ({ loadRestreamCreds: () => ({ clientId: 'test-client', clientSecret: 'test-secret' }) }));
import { OAuthCoordinator } from '../main/oauth';

/** Keep persistence visible so cancelling a login cannot silently clear an existing grant. */
function coordinator() {
  const store: Store = { get: () => undefined, set: vi.fn(), delete: vi.fn() };
  return { oauth: new OAuthCoordinator(store), store };
}

afterEach(() => {
  for (const window of state.windows) window.close();
  state.windows.length = 0;
  state.servers.length = 0;
  state.activeServer = undefined;
});

describe('OAuth sign-in lifecycle', () => {
  it('shares overlapping login requests instead of binding the same callback port twice', async () => {
    const { oauth } = coordinator();
    const first = oauth.authenticate();
    const second = oauth.authenticate();
    const results = Promise.allSettled([first, second]);
    expect(state.windows).toHaveLength(1);
    expect(state.servers).toHaveLength(1);
    expect(state.windows[0].focus).toHaveBeenCalledOnce();
    state.windows[0].close();
    expect((await results).every((result) => result.status === 'rejected')).toBe(true);
    expect(state.activeServer).toBeUndefined();
  });

  it('releases a cancelled login and allows a fresh sign-in without touching saved credentials', async () => {
    const { oauth, store } = coordinator();
    const first = oauth.authenticate();
    const firstResult = Promise.allSettled([first]);
    state.windows[0].close();
    await Promise.resolve();
    expect(state.servers[0].close).toHaveBeenCalledOnce();
    expect((await firstResult)[0].status).toBe('rejected');
    const second = oauth.authenticate();
    const secondResult = Promise.allSettled([second]);
    expect(state.windows).toHaveLength(2);
    expect(state.servers).toHaveLength(2);
    state.windows[1].close();
    await secondResult;
    expect(state.activeServer).toBeUndefined();
    expect(store.delete).not.toHaveBeenCalled();
    expect(store.set).not.toHaveBeenCalled();
  });

  it('releases a failed listener so a later sign-in can try again', async () => {
    const { oauth } = coordinator();
    const first = oauth.authenticate();
    const result = Promise.allSettled([first]);
    state.servers[0].emit('error', new Error('listener failed'));
    expect((await result)[0].status).toBe('rejected');
    expect(state.activeServer).toBeUndefined();
    const second = oauth.authenticate();
    const secondResult = Promise.allSettled([second]);
    expect(state.windows).toHaveLength(2);
    state.windows[1].close();
    await secondResult;
  });
});
