// Regression guards for the v0.1.22 TTS silence fix.
//
// v0.1.21 used `queueMicrotask` + a keep-alive pause/resume ping that worked
// against the fake speechSynthesis used in tests but failed in real
// Electron 42 Chromium. v0.1.22:
//
//   1. Defers preview speak() with `setTimeout(..., 100)` (task boundary,
//      not microtask) so Chromium's cancel state machine has flushed.
//   2. Removes the keep-alive ping (it was racing the new utterance into
//      silence on rapid voice/volume changes).
//   3. Resumes BEFORE cancel so cancel doesn't deferred-trigger on a paused
//      engine.
//   4. Adds a name-fallback in voice resolution.
//
// These tests use a fake `speechSynthesis` that records every call. They
// don't fully model Chromium's async cancel state machine — that's exactly
// why v0.1.21 tests passed while the real engine was silent. Treat these as
// shape-level guards only; the real verification is a live DevTools run.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TTSEngine } from '../renderer/tts';
import type { ChatMessage, Settings } from '../shared/types';

interface FakeUtterance {
  text: string;
  volume?: number;
  rate?: number;
  pitch?: number;
  voice?: SpeechSynthesisVoice | null;
  onstart?: ((this: SpeechSynthesisUtterance, ev: SpeechSynthesisEvent) => unknown) | null;
  onend?: ((this: SpeechSynthesisUtterance, ev: SpeechSynthesisEvent) => unknown) | null;
  onerror?: ((this: SpeechSynthesisUtterance, ev: SpeechSynthesisErrorEvent) => unknown) | null;
}

interface CallLog {
  speak: FakeUtterance[];
  cancel: number;
  pause: number;
  resume: number;
}

interface FakeSpeechSynthesis {
  readonly paused: boolean;
  speaking: boolean;
  pending: boolean;
  speak(utter: FakeUtterance): void;
  cancel(): void;
  pause(): void;
  resume(): void;
  getVoices(): SpeechSynthesisVoice[];
  onvoiceschanged: null;
}

function installFakeSpeechSynthesis(opts: { startPaused?: boolean; voices?: SpeechSynthesisVoice[] } = {}): CallLog {
  const log: CallLog = { speak: [], cancel: 0, pause: 0, resume: 0 };
  let paused = opts.startPaused ?? false;
  const voices = opts.voices ?? [];

  class FakeUtter implements FakeUtterance {
    text: string;
    volume?: number;
    rate?: number;
    pitch?: number;
    voice?: SpeechSynthesisVoice | null;
    onstart?: FakeUtterance['onstart'];
    onend?: FakeUtterance['onend'];
    onerror?: FakeUtterance['onerror'];
    constructor(text: string) {
      this.text = text;
    }
  }

  const synth: FakeSpeechSynthesis = {
    get paused() {
      return paused;
    },
    speaking: false,
    pending: false,
    speak(utter: FakeUtterance) {
      log.speak.push(utter);
    },
    cancel() {
      log.cancel++;
    },
    pause() {
      log.pause++;
      paused = true;
    },
    resume() {
      log.resume++;
      paused = false;
    },
    getVoices(): SpeechSynthesisVoice[] {
      return voices;
    },
    onvoiceschanged: null,
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).window = {
    speechSynthesis: synth,
    SpeechSynthesisUtterance: FakeUtter,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).SpeechSynthesisUtterance = FakeUtter;

  return log;
}

function uninstallFakeSpeechSynthesis() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).window;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).SpeechSynthesisUtterance;
}

const baseTts: Settings['tts'] = {
  enabled: true,
  readSenderName: false,
  voiceURI: undefined,
  rate: 1.0,
  pitch: 1.0,
  volume: 1.0,
  maxPerMinute: 20,
};

const msg = (text = 'hello world'): ChatMessage => ({
  id: 'm1',
  platform: 'twitch',
  username: 'alice',
  text,
  ts: 1_700_000_000_000,
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  uninstallFakeSpeechSynthesis();
});

describe('TTSEngine — preview cancel/speak race fix (v0.1.22 / v0.1.23)', () => {
  it('previewVoice defers speak() on a 100ms setTimeout, skipping idle cancel() (v0.1.23 latching fix)', () => {
    const log = installFakeSpeechSynthesis();
    const engine = new TTSEngine(baseTts);

    engine.previewVoice(undefined);

    // v0.1.23: cancel() is GATED on speechSynthesis.speaking || pending so we
    // don't trigger Electron 42 Chromium's idle-cancel silence latch. Engine
    // starts idle, so no cancel fires. speak() is still deferred 100ms.
    expect(log.cancel).toBe(0);
    expect(log.speak.length).toBe(0);

    // Microtask flush is NOT enough — must be a task tick.
    vi.advanceTimersByTime(50);
    expect(log.speak.length).toBe(0);

    // After 100ms the deferred speak fires.
    vi.advanceTimersByTime(100);
    expect(log.speak.length).toBe(1);
    expect(log.speak[0].text).toContain('Hello, my name is');
  });

  it('previewVoice DOES call cancel() when engine is actively speaking', () => {
    const log = installFakeSpeechSynthesis();
    const engine = new TTSEngine(baseTts);
    // Simulate an in-flight utterance.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ((globalThis as any).window.speechSynthesis as FakeSpeechSynthesis).speaking = true;

    engine.previewVoice(undefined);

    // Cancel fires because the engine is genuinely speaking — this is the
    // "rapid switching" case the cancel is for.
    expect(log.cancel).toBe(1);
  });

  it('repeated previewVoice calls all speak (v0.1.23 latching regression)', () => {
    // The v0.1.22 bug: the FIRST preview played, every subsequent preview
    // was silent. The fix is to NOT call speechSynthesis.cancel() on an idle
    // engine — Electron 42 Chromium latches silent if you do.
    const log = installFakeSpeechSynthesis();
    const engine = new TTSEngine(baseTts);

    engine.previewVoice(undefined);
    vi.advanceTimersByTime(200);
    expect(log.speak.length).toBe(1);

    // updateSettings is what App.tsx fires before each previewVoice in the
    // settings drawer flow. With enabled=false (DEFAULT_SETTINGS.tts.enabled
    // is false until user opts in) this used to fire cancel() and contribute
    // to the latch. v0.1.23 gates that cancel() on speaking || pending.
    engine.updateSettings({ ...baseTts, enabled: false });
    engine.previewVoice(undefined);
    vi.advanceTimersByTime(200);
    expect(log.speak.length).toBe(2);

    engine.updateSettings({ ...baseTts, enabled: false });
    engine.previewVoice(undefined);
    vi.advanceTimersByTime(200);
    expect(log.speak.length).toBe(3);

    // Critical: NO cancels fired on the idle engine across all 3 previews.
    // The cancel() calls in the old code were the silence-latch trigger.
    expect(log.cancel).toBe(0);
  });

  it('previewVoice carries volume / rate / pitch through to the utterance', () => {
    const log = installFakeSpeechSynthesis();
    const engine = new TTSEngine({ ...baseTts, volume: 0.42, rate: 1.5, pitch: 0.8 });

    engine.previewVoice(undefined);
    vi.advanceTimersByTime(200);

    expect(log.speak.length).toBe(1);
    expect(log.speak[0].volume).toBeCloseTo(0.42, 5);
    expect(log.speak[0].rate).toBeCloseTo(1.5, 5);
    expect(log.speak[0].pitch).toBeCloseTo(0.8, 5);
  });
});

describe('TTSEngine — auto-resume paused state (still required)', () => {
  it('resumes BEFORE (possible) cancel in previewVoice — paused engine still gets a deferred speak', () => {
    const log = installFakeSpeechSynthesis({ startPaused: true });
    const engine = new TTSEngine(baseTts);

    engine.previewVoice(undefined);

    // The synchronous portion of previewVoice must lift the pause first.
    // v0.1.23: cancel is gated on speaking || pending — idle paused engine
    // skips cancel to avoid Chromium's idle-cancel silence latch.
    expect(log.resume).toBeGreaterThanOrEqual(1);
    expect(log.cancel).toBe(0);

    vi.advanceTimersByTime(200);
    expect(log.speak.length).toBe(1);
  });

  it('lifts speechSynthesis.paused before speaking an incoming chat message', () => {
    const log = installFakeSpeechSynthesis({ startPaused: true });
    const engine = new TTSEngine(baseTts);

    engine.enqueue(msg());

    expect(log.resume).toBe(1);
    expect(log.speak.length).toBe(1);
  });

  it('does NOT call resume() when not paused (common path stays clean)', () => {
    const log = installFakeSpeechSynthesis({ startPaused: false });
    const engine = new TTSEngine(baseTts);

    engine.enqueue(msg());

    expect(log.resume).toBe(0);
    expect(log.speak.length).toBe(1);
  });
});

describe('TTSEngine — keep-alive removed (v0.1.22)', () => {
  it('does NOT fire pause/resume pings while a chat utterance is speaking', () => {
    const log = installFakeSpeechSynthesis();
    const engine = new TTSEngine(baseTts);

    engine.enqueue(msg('a chat message'));
    const utter = log.speak[0] as unknown as FakeUtterance;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ((globalThis as any).window.speechSynthesis as FakeSpeechSynthesis).speaking = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    utter.onstart?.call(utter as unknown as SpeechSynthesisUtterance, {} as any);

    // 30s pass with no keep-alive — was the v0.1.21 race silencing previews.
    vi.advanceTimersByTime(30_000);
    expect(log.pause).toBe(0);
  });
});

describe('TTSEngine — voice URI resolution (v0.1.22)', () => {
  it('matches a voice by exact URI', () => {
    const fakeVoice = { name: 'Daniel (Enhanced)', lang: 'en-GB', voiceURI: 'com.apple.voice.enhanced.en-GB.Daniel', default: false, localService: true } as SpeechSynthesisVoice;
    const log = installFakeSpeechSynthesis({ voices: [fakeVoice] });
    const engine = new TTSEngine({ ...baseTts, voiceURI: 'com.apple.voice.enhanced.en-GB.Daniel' });

    engine.previewVoice('com.apple.voice.enhanced.en-GB.Daniel');
    vi.advanceTimersByTime(200);

    expect(log.speak.length).toBe(1);
    expect(log.speak[0].voice?.name).toBe('Daniel (Enhanced)');
  });

  it('falls back to system default when URI does not match any voice', () => {
    const fakeVoice = { name: 'Daniel (Enhanced)', lang: 'en-GB', voiceURI: 'com.apple.voice.enhanced.en-GB.Daniel', default: false, localService: true } as SpeechSynthesisVoice;
    const log = installFakeSpeechSynthesis({ voices: [fakeVoice] });
    const engine = new TTSEngine(baseTts);

    engine.previewVoice('totally-bogus-uri');
    vi.advanceTimersByTime(200);

    // Still speaks (does NOT go silent on missing voice).
    expect(log.speak.length).toBe(1);
    expect(log.speak[0].voice).toBeFalsy();
    expect(log.speak[0].text).toContain('system default');
  });
});

describe('TTSEngine — basic plumbing still intact', () => {
  it('respects enabled=false on enqueue (no speak() fires)', () => {
    const log = installFakeSpeechSynthesis();
    const engine = new TTSEngine({ ...baseTts, enabled: false });

    engine.enqueue(msg());
    vi.advanceTimersByTime(200);

    expect(log.speak.length).toBe(0);
  });

  it('previewVoice bypasses enabled flag (it is a UI affordance)', () => {
    const log = installFakeSpeechSynthesis();
    const engine = new TTSEngine({ ...baseTts, enabled: false });

    engine.previewVoice(undefined);
    vi.advanceTimersByTime(200);

    expect(log.speak.length).toBe(1);
  });
});
