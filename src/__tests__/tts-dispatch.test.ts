// v0.1.76 (Ethan voice 4414, 2026-05-30) — tests for the MAIN-process TTS +
// notification dispatcher. This is the module that now owns the chat→speak
// decision (moved out of the renderer). The tests pin the two things Ethan
// cares about most:
//   1. NEVER MISS — when the window is genuinely hidden, the message is spoken
//      via the native `say` path (renderer-independent), never dropped.
//   2. ALL SETTINGS WORK — the visible-window path carries volume/voice/rate/
//      pitch in the browser-speak command; the hidden path carries
//      volume/voice/rate into the native enqueue. Backend choice flips purely
//      on the visibility predicate.
// Plus: the decision ladder (disabled / filters / hidden-user) still suppresses
// correctly, and the main-side rate limiter caps runaway raids.

import { describe, expect, it } from 'vitest';
import { TtsDispatcher, type TtsDispatchDeps } from '../main/tts-dispatch';
import { DEFAULT_SETTINGS, type ChatMessage, type Settings, type TtsSpeakBrowserPayload } from '../shared/types';

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

// A capturing test harness around TtsDispatcher.
function makeHarness(opts: {
  settings: Settings;
  hidden: boolean;
  now?: () => number;
}) {
  const nativeCalls: Array<{ text: string; opts: Record<string, unknown> }> = [];
  const browserCalls: TtsSpeakBrowserPayload[] = [];
  const notifyCalls: Array<{ title: string; body: string; silent: boolean }> = [];
  const logRows: Array<{ event: string; data?: Record<string, unknown> }> = [];
  let hidden = opts.hidden;

  const deps: TtsDispatchDeps = {
    loadSettings: () => opts.settings,
    isWindowGenuinelyHidden: () => hidden,
    speakNative: (text, o) => nativeCalls.push({ text, opts: o as Record<string, unknown> }),
    speakBrowser: (payload) => browserCalls.push(payload),
    notify: (title, body, silent) => notifyCalls.push({ title, body, silent }),
    log: (event, data) => logRows.push({ event, data }),
  };
  const dispatcher = new TtsDispatcher(deps, opts.now);
  return {
    dispatcher,
    nativeCalls,
    browserCalls,
    notifyCalls,
    logRows,
    setHidden: (h: boolean) => {
      hidden = h;
    },
  };
}

describe('TtsDispatcher backend choice (v0.1.76)', () => {
  it('VISIBLE window → speaks via the BROWSER path with all settings honoured', () => {
    const h = makeHarness({
      settings: settingsWith({ voiceURI: 'Daniel', rate: 1.2, pitch: 0.8, volume: 0.4 }),
      hidden: false,
    });
    const backend = h.dispatcher.handleMessage(msg({ id: 'm1', text: 'hi there' }));
    expect(backend).toBe('browser');
    expect(h.nativeCalls).toHaveLength(0);
    expect(h.browserCalls).toHaveLength(1);
    const p = h.browserCalls[0];
    // EVERY setting flows through — this is the "all controls still work" proof
    // for the normal (visible) case, including PITCH.
    expect(p.text).toBe('hi there');
    expect(p.voiceURI).toBe('Daniel');
    expect(p.rate).toBe(1.2);
    expect(p.pitch).toBe(0.8);
    expect(p.volume).toBe(0.4);
    expect(p.messageId).toBe('m1');
  });

  it('GENUINELY HIDDEN window → speaks via NATIVE say (never-miss), honouring volume/voice/rate', () => {
    const h = makeHarness({
      settings: settingsWith({ voiceURI: 'Samantha', rate: 0.9, pitch: 1.5, volume: 0.25 }),
      hidden: true,
    });
    const backend = h.dispatcher.handleMessage(msg({ id: 'm2', text: 'background msg' }));
    expect(backend).toBe('native');
    expect(h.browserCalls).toHaveLength(0);
    expect(h.nativeCalls).toHaveLength(1);
    const c = h.nativeCalls[0];
    expect(c.text).toBe('background msg');
    expect(c.opts.voice).toBe('Samantha');
    expect(c.opts.rate).toBe(0.9);
    // VOLUME is carried into the native path — the native engine applies it via
    // `[[volm]]`. This is the load-bearing never-miss + volume guarantee.
    expect(c.opts.volume).toBe(0.25);
    expect(c.opts.messageId).toBe('m2');
    // pitch is intentionally NOT passed to native (say has no pitch knob) — the
    // only degraded setting, and only in this genuinely-hidden state.
    expect(c.opts.pitch).toBeUndefined();
  });

  it('backend flips with window visibility between messages', () => {
    const h = makeHarness({ settings: settingsWith(), hidden: false });
    expect(h.dispatcher.handleMessage(msg({ id: 'a' }))).toBe('browser');
    h.setHidden(true);
    expect(h.dispatcher.handleMessage(msg({ id: 'b' }))).toBe('native');
    h.setHidden(false);
    expect(h.dispatcher.handleMessage(msg({ id: 'c' }))).toBe('browser');
  });

  it('readSenderName=true prefixes the sender name in the composed text (both paths)', () => {
    const h = makeHarness({
      settings: settingsWith({ readSenderName: true }),
      hidden: false,
    });
    h.dispatcher.handleMessage(msg({ id: 'm', username: 'bob', text: 'yo' }));
    expect(h.browserCalls[0].text).toBe('bob says yo');
  });
});

describe('TtsDispatcher decision gates still suppress (v0.1.76)', () => {
  it('TTS disabled → no speak on either backend', () => {
    const h = makeHarness({
      settings: { ...DEFAULT_SETTINGS, tts: { ...DEFAULT_SETTINGS.tts, enabled: false } },
      hidden: false,
    });
    expect(h.dispatcher.handleMessage(msg())).toBe('skip');
    expect(h.browserCalls).toHaveLength(0);
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
      hidden: true,
    });
    expect(h.dispatcher.handleMessage(msg({ text: 'spam' }))).toBe('skip');
    expect(h.nativeCalls).toHaveLength(0);
  });

  it('hidden user → skip', () => {
    const h = makeHarness({
      settings: settingsWith({}, { hiddenUsers: ['Troll'] }),
      hidden: false,
    });
    expect(h.dispatcher.handleMessage(msg({ username: 'troll', text: 'hey' }))).toBe('skip');
    expect(h.browserCalls).toHaveLength(0);
  });

  // v0.1.77 (Ethan voice 4438) — ONE-CLICK MUTE gate. The header 🔇 button
  // flips settings.tts.muted; the dispatcher must skip speech on BOTH backends
  // regardless of window visibility, and un-muting must resume speech.
  it('muted=true → no speak on the BROWSER path (window visible)', () => {
    const h = makeHarness({
      settings: settingsWith({ muted: true }),
      hidden: false,
    });
    expect(h.dispatcher.handleMessage(msg())).toBe('skip');
    expect(h.browserCalls).toHaveLength(0);
    expect(h.nativeCalls).toHaveLength(0);
  });

  it('muted=true → no speak on the NATIVE path either (window hidden)', () => {
    const h = makeHarness({
      settings: settingsWith({ muted: true }),
      hidden: true,
    });
    // The critical guarantee: muting silences ALL speech even when the window
    // is genuinely hidden (the native say path), not just the visible/browser
    // path. Otherwise muting wouldn't actually shut the app up.
    expect(h.dispatcher.handleMessage(msg())).toBe('skip');
    expect(h.nativeCalls).toHaveLength(0);
    expect(h.browserCalls).toHaveLength(0);
  });

  it('unmuting (muted=false) resumes speech with all settings intact', () => {
    // muted=false is the default settingsWith() — every other knob is the
    // user's normal config, proving un-mute restores speech exactly.
    const h = makeHarness({
      settings: settingsWith({ muted: false, voiceURI: 'Daniel', volume: 0.4 }),
      hidden: false,
    });
    expect(h.dispatcher.handleMessage(msg({ text: 'back on' }))).toBe('browser');
    expect(h.browserCalls).toHaveLength(1);
    expect(h.browserCalls[0].text).toBe('back on');
    expect(h.browserCalls[0].voiceURI).toBe('Daniel');
    expect(h.browserCalls[0].volume).toBe(0.4);
  });

  it('muted does NOT suppress notifications (mute is about SPEECH only)', () => {
    // Voice 4438 scope: mute silences the spoken voice; OS notifications keep
    // their own soundEnabled setting. A muted-but-notifications-enabled config
    // still fires the notification.
    const h = makeHarness({
      settings: settingsWith({ muted: true }, {
        notifications: { enabled: true, soundEnabled: true, maxPerMinute: 30 },
      }),
      hidden: false,
    });
    h.dispatcher.handleMessage(msg({ username: 'dan', platform: 'twitch', text: 'yo' }));
    expect(h.browserCalls).toHaveLength(0); // speech muted
    expect(h.notifyCalls).toHaveLength(1); // notification still fires
  });

  it('self message → skip when speakSelf is OFF (own outgoing echo)', () => {
    // v0.1.79: own messages are skipped only when the user has turned the
    // "Speak my own messages" toggle OFF (settings.tts.speakSelf === false).
    const h = makeHarness({ settings: settingsWith({ speakSelf: false }), hidden: false });
    expect(h.dispatcher.handleMessage(msg({ self: true }))).toBe('skip');
    expect(h.browserCalls).toHaveLength(0);
  });

  it('self message → SPEAKS when speakSelf is ON (v0.1.79 default)', () => {
    // The default flipped in v0.1.79: with speakSelf=true the dispatcher reads
    // the user's own messages aloud, dispatching to the browser backend when
    // the window is visible. This is the behaviour Ethan asked to restore.
    const h = makeHarness({ settings: settingsWith(), hidden: false });
    expect(h.dispatcher.handleMessage(msg({ self: true, text: 'my own msg' }))).toBe('browser');
    expect(h.browserCalls).toHaveLength(1);
    expect(h.browserCalls[0].text).toBe('my own msg');
  });

  it('platform disabled → skip', () => {
    const h = makeHarness({
      settings: settingsWith({}, {
        filter: { platforms: { ...DEFAULT_SETTINGS.filter.platforms, twitch: false } },
      }),
      hidden: false,
    });
    expect(h.dispatcher.handleMessage(msg({ platform: 'twitch' }))).toBe('skip');
    expect(h.browserCalls).toHaveLength(0);
  });
});

describe('TtsDispatcher rate limiting + notifications (v0.1.76)', () => {
  it('caps TTS at maxPerMinute within the rolling window', () => {
    let t = 1_000_000;
    const h = makeHarness({
      settings: settingsWith({ maxPerMinute: 2 }),
      hidden: false,
      now: () => t,
    });
    // First two are read.
    expect(h.dispatcher.handleMessage(msg({ id: '1' }))).toBe('browser');
    expect(h.dispatcher.handleMessage(msg({ id: '2' }))).toBe('browser');
    // Third within the same minute is rate-limited → skip.
    expect(h.dispatcher.handleMessage(msg({ id: '3' }))).toBe('skip');
    expect(h.browserCalls).toHaveLength(2);
    // Advance past the 60s window → the limiter recovers.
    t += 61_000;
    expect(h.dispatcher.handleMessage(msg({ id: '4' }))).toBe('browser');
    expect(h.browserCalls).toHaveLength(3);
  });

  it('fires a notification when notifications enabled (silent honours soundEnabled=false)', () => {
    const h = makeHarness({
      settings: settingsWith({}, {
        notifications: { enabled: true, soundEnabled: false, maxPerMinute: 30 },
      }),
      hidden: false,
    });
    h.dispatcher.handleMessage(msg({ username: 'carol', platform: 'kick', text: 'ping' }));
    expect(h.notifyCalls).toHaveLength(1);
    expect(h.notifyCalls[0].title).toBe('carol (kick)');
    expect(h.notifyCalls[0].body).toBe('ping');
    // soundEnabled=false → silent=true.
    expect(h.notifyCalls[0].silent).toBe(true);
  });

  it('does not fire a notification when notifications disabled', () => {
    const h = makeHarness({ settings: settingsWith(), hidden: false });
    h.dispatcher.handleMessage(msg());
    expect(h.notifyCalls).toHaveLength(0);
  });
});

describe('TtsDispatcher robustness (v0.1.76)', () => {
  it('a thrown deps.speakNative never escapes handleMessage (chat pipeline protected)', () => {
    const h = makeHarness({ settings: settingsWith(), hidden: true });
    // Monkeypatch the dispatcher to throw on speak — simulate a backend blowup.
    // handleMessage must swallow it and return 'skip', not throw.
    const dispatcher = new TtsDispatcher(
      {
        loadSettings: () => settingsWith(),
        isWindowGenuinelyHidden: () => true,
        speakNative: () => {
          throw new Error('boom');
        },
        speakBrowser: () => undefined,
        notify: () => undefined,
        log: () => undefined,
      },
    );
    expect(() => dispatcher.handleMessage(msg())).not.toThrow();
    expect(dispatcher.handleMessage(msg())).toBe('skip');
    // reference h so the harness import isn't flagged unused in strict setups
    void h;
  });
});
