// Tests for the MAIN-process TTS + notification dispatcher.
//
// v0.1.81 (Ethan 2026-05-31: "lets just use system voice for everything then.
// no more browser one. do it.") — the dispatcher now has exactly ONE speaking
// backend: the native OS voice engine, on every platform. The browser
// (renderer Web-Speech) path + the window-visibility backend choice were
// removed. These tests pin:
//   1. NEVER MISS / always-native — every readable message is spoken via the
//      native engine; there is no browser path and no visibility branch.
//   2. ALL CONTROLS FLOW — volume/voice/rate are carried into the native
//      enqueue (pitch is intentionally NOT — no cross-platform native pitch).
//   3. The decision ladder (disabled / muted / self / filters / hidden-user /
//      platform / rate-limit) still suppresses correctly before the engine.

import { describe, expect, it } from 'vitest';
import { TtsDispatcher, type TtsDispatchDeps } from '../main/tts-dispatch';
import { DEFAULT_SETTINGS, type ChatMessage, type Settings } from '../shared/types';

// Build a settings object with TTS enabled (the default ships disabled) plus
// any overrides the individual test needs.
function settingsWith(overrides: Partial<Settings['tts']> = {}, more: Partial<Settings> = {}): Settings {
  return {
    ...DEFAULT_SETTINGS,
    tts: { ...DEFAULT_SETTINGS.tts, enabled: true, ...overrides },
    ...more,
  };
}

function msg(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: overrides.id ?? `id-${Math.random().toString(36).slice(2)}`,
    platform: 'twitch',
    username: 'alice',
    text: 'hello world',
    ts: Date.now(),
    ...overrides,
  };
}

// Capturing harness around TtsDispatcher. v0.1.81: the deps surface is now just
// loadSettings / speakNative / notify / log — no visibility / browser hooks.
function makeHarness(opts: { settings: Settings; now?: () => number }) {
  const nativeCalls: Array<{ text: string; opts: Record<string, unknown> }> = [];
  const notifyCalls: Array<{ title: string; body: string; silent: boolean }> = [];
  const logRows: Array<{ event: string; data?: Record<string, unknown> }> = [];

  const deps: TtsDispatchDeps = {
    loadSettings: () => opts.settings,
    speakNative: (text, o) => nativeCalls.push({ text, opts: o as Record<string, unknown> }),
    notify: (title, body, silent) => notifyCalls.push({ title, body, silent }),
    log: (event, data) => logRows.push({ event, data }),
  };
  const dispatcher = new TtsDispatcher(deps, opts.now);
  return { dispatcher, nativeCalls, notifyCalls, logRows };
}

describe('TtsDispatcher speaks via the native OS voice (v0.1.81)', () => {
  it('a readable message → spoken via NATIVE, carrying voice/rate/volume', () => {
    const h = makeHarness({
      settings: settingsWith({ voiceURI: 'Daniel', rate: 1.2, pitch: 0.8, volume: 0.4 }),
    });
    const backend = h.dispatcher.handleMessage(msg({ id: 'm1', text: 'hi there' }));
    expect(backend).toBe('native');
    expect(h.nativeCalls).toHaveLength(1);
    const c = h.nativeCalls[0];
    expect(c.text).toBe('hi there');
    expect(c.opts.voice).toBe('Daniel');
    expect(c.opts.rate).toBe(1.2);
    // VOLUME flows to native — the native engine applies it per-platform
    // (macOS [[volm]] / Windows $s.Volume / Linux -a|-i). Load-bearing: this is
    // the "can volume n stuff work with that" guarantee.
    expect(c.opts.volume).toBe(0.4);
    expect(c.opts.messageId).toBe('m1');
    // PITCH is intentionally NOT passed — no cross-platform native pitch knob.
    expect(c.opts.pitch).toBeUndefined();
  });

  it('readSenderName=true prefixes the sender name in the composed text', () => {
    const h = makeHarness({ settings: settingsWith({ readSenderName: true }) });
    h.dispatcher.handleMessage(msg({ id: 'm', username: 'bob', text: 'yo' }));
    expect(h.nativeCalls[0].text).toBe('bob says yo');
  });

  it('undefined voiceURI passes through undefined (native falls back to OS default voice)', () => {
    const h = makeHarness({ settings: settingsWith({ voiceURI: undefined }) });
    h.dispatcher.handleMessage(msg({ text: 'no voice set' }));
    expect(h.nativeCalls[0].opts.voice).toBeUndefined();
  });

  it('multiple readable messages each speak (no double-speak, one backend)', () => {
    const h = makeHarness({ settings: settingsWith() });
    expect(h.dispatcher.handleMessage(msg({ id: 'a' }))).toBe('native');
    expect(h.dispatcher.handleMessage(msg({ id: 'b' }))).toBe('native');
    expect(h.dispatcher.handleMessage(msg({ id: 'c' }))).toBe('native');
    expect(h.nativeCalls).toHaveLength(3);
  });
});

describe('TtsDispatcher decision gates still suppress (v0.1.81)', () => {
  it('TTS disabled → no speak', () => {
    const h = makeHarness({
      settings: { ...DEFAULT_SETTINGS, tts: { ...DEFAULT_SETTINGS.tts, enabled: false } },
    });
    expect(h.dispatcher.handleMessage(msg())).toBe('skip');
    expect(h.nativeCalls).toHaveLength(0);
  });

  it('content regex ignore → skip', () => {
    const h = makeHarness({
      settings: settingsWith({}, {
        filters: {
          ...DEFAULT_SETTINGS.filters,
          tts: { ignoreRegex: ['^spam$'], ignoreUsernameRegex: [] },
        },
      }),
    });
    expect(h.dispatcher.handleMessage(msg({ text: 'spam' }))).toBe('skip');
    expect(h.nativeCalls).toHaveLength(0);
  });

  it('hidden user → skip', () => {
    const h = makeHarness({ settings: settingsWith({}, { hiddenUsers: ['Troll'] }) });
    expect(h.dispatcher.handleMessage(msg({ username: 'troll', text: 'hey' }))).toBe('skip');
    expect(h.nativeCalls).toHaveLength(0);
  });

  // v0.1.77 (voice 4438) — ONE-CLICK MUTE gate. Must skip speech regardless of
  // backend; v0.1.81 there's only the native backend so mute must silence it.
  it('muted=true → no speak (native path silenced)', () => {
    const h = makeHarness({ settings: settingsWith({ muted: true }) });
    expect(h.dispatcher.handleMessage(msg())).toBe('skip');
    expect(h.nativeCalls).toHaveLength(0);
  });

  it('unmuting (muted=false) resumes speech with all settings intact', () => {
    const h = makeHarness({ settings: settingsWith({ muted: false, voiceURI: 'Daniel', volume: 0.4 }) });
    expect(h.dispatcher.handleMessage(msg({ text: 'back on' }))).toBe('native');
    expect(h.nativeCalls).toHaveLength(1);
    expect(h.nativeCalls[0].text).toBe('back on');
    expect(h.nativeCalls[0].opts.voice).toBe('Daniel');
    expect(h.nativeCalls[0].opts.volume).toBe(0.4);
  });

  it('muted does NOT suppress notifications (mute is about SPEECH only)', () => {
    const h = makeHarness({
      settings: settingsWith({ muted: true }, {
        notifications: { enabled: true, soundEnabled: true, maxPerMinute: 30 },
      }),
    });
    h.dispatcher.handleMessage(msg({ username: 'dan', platform: 'twitch', text: 'yo' }));
    expect(h.nativeCalls).toHaveLength(0); // speech muted
    expect(h.notifyCalls).toHaveLength(1); // notification still fires
  });

  it('self message → skip when speakSelf is OFF', () => {
    const h = makeHarness({ settings: settingsWith({ speakSelf: false }) });
    expect(h.dispatcher.handleMessage(msg({ self: true }))).toBe('skip');
    expect(h.nativeCalls).toHaveLength(0);
  });

  it('self message → SPEAKS when speakSelf is ON (v0.1.79 default)', () => {
    const h = makeHarness({ settings: settingsWith() });
    expect(h.dispatcher.handleMessage(msg({ self: true, text: 'my own msg' }))).toBe('native');
    expect(h.nativeCalls).toHaveLength(1);
    expect(h.nativeCalls[0].text).toBe('my own msg');
  });

  it('platform disabled → skip', () => {
    const h = makeHarness({
      settings: settingsWith({}, {
        filter: { platforms: { ...DEFAULT_SETTINGS.filter.platforms, twitch: false } },
      }),
    });
    expect(h.dispatcher.handleMessage(msg({ platform: 'twitch' }))).toBe('skip');
    expect(h.nativeCalls).toHaveLength(0);
  });
});

describe('TtsDispatcher rate limiting + notifications (v0.1.81)', () => {
  it('caps TTS at maxPerMinute within the rolling window', () => {
    let t = 1_000_000;
    const h = makeHarness({ settings: settingsWith({ maxPerMinute: 2 }), now: () => t });
    expect(h.dispatcher.handleMessage(msg({ id: '1' }))).toBe('native');
    expect(h.dispatcher.handleMessage(msg({ id: '2' }))).toBe('native');
    // Third within the same minute is rate-limited → skip.
    expect(h.dispatcher.handleMessage(msg({ id: '3' }))).toBe('skip');
    expect(h.nativeCalls).toHaveLength(2);
    // Advance past the 60s window → the limiter recovers.
    t += 61_000;
    expect(h.dispatcher.handleMessage(msg({ id: '4' }))).toBe('native');
    expect(h.nativeCalls).toHaveLength(3);
  });

  it('fires a notification when notifications enabled (silent honours soundEnabled=false)', () => {
    const h = makeHarness({
      settings: settingsWith({}, {
        notifications: { enabled: true, soundEnabled: false, maxPerMinute: 30 },
      }),
    });
    h.dispatcher.handleMessage(msg({ username: 'carol', platform: 'kick', text: 'ping' }));
    expect(h.notifyCalls).toHaveLength(1);
    expect(h.notifyCalls[0].title).toBe('carol (kick)');
    expect(h.notifyCalls[0].body).toBe('ping');
    expect(h.notifyCalls[0].silent).toBe(true); // soundEnabled=false → silent=true
  });

  it('does not fire a notification when notifications disabled', () => {
    const h = makeHarness({ settings: settingsWith() });
    h.dispatcher.handleMessage(msg());
    expect(h.notifyCalls).toHaveLength(0);
  });
});

describe('TtsDispatcher robustness (v0.1.81)', () => {
  it('a thrown deps.speakNative never escapes handleMessage (chat pipeline protected)', () => {
    const dispatcher = new TtsDispatcher({
      loadSettings: () => settingsWith(),
      speakNative: () => {
        throw new Error('boom');
      },
      notify: () => undefined,
      log: () => undefined,
    });
    expect(() => dispatcher.handleMessage(msg())).not.toThrow();
    expect(dispatcher.handleMessage(msg())).toBe('skip');
  });
});
