import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureRestreamChatCookies } from '../main/chat-send';

const require = createRequire(import.meta.url);
const electronPath = require.resolve('electron');
const originalElectron = require.cache[electronPath];
const originalVersion = Object.getOwnPropertyDescriptor(process.versions, 'electron');
let cookies: { name: string; value: string }[];
const session = { cookies: { get: async () => cookies } };

class FakeWindow extends EventEmitter {
  static windows: FakeWindow[] = [];
  destroyed = false;
  constructor(public options: { show: boolean }) {
    super();
    FakeWindow.windows.push(this);
  }
  loadURL = vi.fn(async () => undefined);
  focus = vi.fn();
  isDestroyed = () => this.destroyed;
  destroy() {
    this.destroyed = true;
    this.emit('closed');
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  cookies = [];
  FakeWindow.windows = [];
  Object.defineProperty(process.versions, 'electron', { value: 'test', configurable: true });
  require.cache[electronPath] = {
    id: electronPath, filename: electronPath, loaded: true,
    exports: { BrowserWindow: FakeWindow, session: { fromPartition: () => session } },
  } as NodeJS.Module;
});

afterEach(() => {
  vi.useRealTimers();
  if (originalElectron) require.cache[electronPath] = originalElectron;
  else delete require.cache[electronPath];
  if (originalVersion) Object.defineProperty(process.versions, 'electron', originalVersion);
  else Reflect.deleteProperty(process.versions, 'electron');
});

describe('interactive sending login', () => {
  it('waits beyond a minute for Google/passkey login and closes only after cookies arrive', async () => {
    const result = ensureRestreamChatCookies({ interactiveFallback: true });
    await vi.advanceTimersByTimeAsync(9000);
    const visible = FakeWindow.windows.find((win) => win.options.show);
    assert(visible);
    expect(visible).toBeDefined();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(visible.isDestroyed()).toBe(false);
    cookies = [{ name: 'accessXsrfToken', value: 'test-cookie' }];
    await vi.advanceTimersByTimeAsync(250);
    expect(await result).toMatchObject({ ok: true, reason: 'interactive' });
    expect(visible.isDestroyed()).toBe(true);
  });

  it('lets the user cancel without clearing any cookies', async () => {
    const result = ensureRestreamChatCookies({ interactiveFallback: true });
    await vi.advanceTimersByTimeAsync(9000);
    const visible = FakeWindow.windows.find((win) => win.options.show);
    assert(visible);
    visible.destroy();
    await vi.advanceTimersByTimeAsync(250);
    expect(await result).toMatchObject({ ok: false, reason: 'still-no-cookies' });
  });

  it('keeps automatic headless recovery bounded with no interactive fallback', async () => {
    const result = ensureRestreamChatCookies();
    await vi.advanceTimersByTimeAsync(9000);
    expect(await result).toMatchObject({ ok: false });
    expect(FakeWindow.windows).toHaveLength(1);
    expect(FakeWindow.windows[0].isDestroyed()).toBe(true);
  });

  it('shares startup and button recovery, then allows a new login after cancellation', async () => {
    const first = ensureRestreamChatCookies({ interactiveFallback: true });
    await vi.advanceTimersByTimeAsync(9000);
    const second = ensureRestreamChatCookies({ interactiveFallback: true });
    await vi.advanceTimersByTimeAsync(9000);
    const windows = FakeWindow.windows.filter((win) => win.options.show);
    expect(windows).toHaveLength(1);
    expect(windows[0].focus).toHaveBeenCalledOnce();
    windows[0].destroy();
    await vi.advanceTimersByTimeAsync(250);
    expect(await first).toMatchObject({ ok: false });
    expect(await second).toMatchObject({ ok: false });
    const third = ensureRestreamChatCookies({ interactiveFallback: true });
    await vi.advanceTimersByTimeAsync(9000);
    const reopened = FakeWindow.windows.filter((win) => win.options.show);
    expect(reopened).toHaveLength(2);
    reopened[1].destroy();
    await vi.advanceTimersByTimeAsync(250);
    await third;
  });

  it('closes the login and settles when its parent is destroyed', async () => {
    const parent = new FakeWindow({ show: false });
    const result = ensureRestreamChatCookies({ interactiveFallback: true, parentWindow: parent });
    await vi.advanceTimersByTimeAsync(9000);
    const visible = FakeWindow.windows.find((win) => win.options.show);
    assert(visible);
    parent.destroy();
    await vi.advanceTimersByTimeAsync(250);
    expect(await result).toMatchObject({ ok: false });
    expect(visible.isDestroyed()).toBe(true);
  });
});
