// Regression guards for the v0.1.21 TTS silence fix.
//
// Runs in the default `environment: 'node'` (vitest.config.ts) — we
// stub `window` + `speechSynthesis` + `SpeechSynthesisUtterance` ourselves
// because installing jsdom for one test file is overkill, and the engine
// only touches a tiny well-defined surface of the browser API.
//
// The pre-v0.1.21 implementation had three independent Chromium / Web
// Speech quirks that compounded into "no sound from any TTS path" once
// the user wiggled enough sliders:
//
//   1. `previewVoice()` called `speechSynthesis.cancel()` and
//      `speechSynthesis.speak()` synchronously back-to-back. Chromium
//      treats `cancel()` as asynchronous in its internal state machine,
//      so the new utterance is silently dropped.
//
//   2. Once `speechSynthesis.paused` latches `true` (which it can after
//      certain audio-device transitions or the cancel/speak race in #1),
//      every subsequent `speak()` queues into the paused queue and never
//      audibly plays. The engine never auto-resumed.
//
//   3. Chromium stalls long-running utterances (>15s) and idle synthesis
//      sessions. The standard workaround is a periodic
//      `pause(); resume();` ping while a speak is in flight; the engine
//      did not arm one.
//
// These tests pin each fix using a fake `window.speechSynthesis`
// implementation that records every call. They do NOT depend on a real
// Web Speech engine — they assert the engine's INTERACTIONS with the
// browser API are correct, which is what was actually broken.

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

// Tests run under `environment: 'node'` so `window` doesn't exist by default
// — we install a minimal fake on `globalThis.window` for the duration of each
// test. The engine checks `typeof window === 'undefined'` and
// `window.speechSynthesis` so this is all it touches.
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

function installFakeSpeechSynthesis(opts: { startPaused?: boolean } = {}): CallLog {
  const log: CallLog = { speak: [], cancel: 0, pause: 0, resume: 0 };
  let paused = opts.startPaused ?? false;

  // Constructor must record assigned properties so tests can verify what
  // each speak() carried (text, volume, voice, …).
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
      return [];
    },
    onvoiceschanged: null,
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).window = {
    speechSynthesis: synth,
    SpeechSynthesisUtterance: FakeUtter,
  };
  // The engine's `new SpeechSynthesisUtterance(...)` reads the constructor
  // from the global scope, so SpeechSynthesisUtterance must also be a
  // top-level global, not just hung off `window`.
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

describe('TTSEngine — preview cancel/speak race fix (regression #1)', () => {
  it('previewVoice defers the speak() call to a microtask after cancel()', async () => {
    const log = installFakeSpeechSynthesis();
    const engine = new TTSEngine(baseTts);

    engine.previewVoice(undefined);

    // Immediately after previewVoice returns, cancel() must have been
    // called (synchronous) but speak() must NOT have run yet — speak()
    // is deferred to the next microtask to dodge Chromium's cancel/speak
    // race that silently drops the synchronously-spawned utterance.
    expect(log.cancel).toBe(1);
    expect(log.speak.length).toBe(0);

    // Flush microtasks; the deferred speak() should now have run.
    await Promise.resolve();
    expect(log.speak.length).toBe(1);
    expect(log.speak[0].text).toContain('Hello, my name is');
  });

  it('previewVoice survives rapid back-to-back calls (last-one-wins)', async () => {
    const log = installFakeSpeechSynthesis();
    const engine = new TTSEngine(baseTts);

    engine.previewVoice(undefined);
    engine.previewVoice(undefined);
    engine.previewVoice(undefined);

    expect(log.cancel).toBe(3);
    expect(log.speak.length).toBe(0); // all deferred

    await Promise.resolve();
    // All three deferred speaks fire; Chromium's queue handles the rest.
    // What matters is that no speak() was dropped from the synchronous
    // cancel/speak race — every one made it through the microtask.
    expect(log.speak.length).toBe(3);
  });
});

describe('TTSEngine — auto-resume paused state fix (regression #2)', () => {
  it('lifts speechSynthesis.paused before speaking an incoming message', () => {
    const log = installFakeSpeechSynthesis({ startPaused: true });
    const engine = new TTSEngine(baseTts);

    engine.enqueue(msg());

    // speak() must have been preceded by resume() this tick — otherwise
    // the utterance goes into Chromium's paused queue and is never heard.
    expect(log.resume).toBe(1);
    expect(log.speak.length).toBe(1);
  });

  it('lifts speechSynthesis.paused before speaking a preview', async () => {
    const log = installFakeSpeechSynthesis({ startPaused: true });
    const engine = new TTSEngine(baseTts);

    engine.previewVoice(undefined);
    await Promise.resolve();

    expect(log.resume).toBe(1);
    expect(log.speak.length).toBe(1);
  });

  it('does NOT call resume() when not paused (no-op stays a no-op)', () => {
    const log = installFakeSpeechSynthesis({ startPaused: false });
    const engine = new TTSEngine(baseTts);

    engine.enqueue(msg());

    // Engine isn't paused, so no resume() needed — keeps the call log
    // free of redundant pause/resume churn for the common path.
    expect(log.resume).toBe(0);
    expect(log.speak.length).toBe(1);
  });
});

describe('TTSEngine — long-utterance keep-alive ping (regression #3)', () => {
  it('arms a pause/resume keep-alive while an utterance is speaking', () => {
    const log = installFakeSpeechSynthesis();
    const engine = new TTSEngine(baseTts);

    engine.enqueue(msg('a very long message that would stall Chromium TTS'));
    // The engine wires onstart on the utterance; simulate the engine
    // firing it (Chromium fires onstart as soon as audio begins).
    const utter = log.speak[0] as unknown as FakeUtterance;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ((globalThis as any).window.speechSynthesis as FakeSpeechSynthesis).speaking = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    utter.onstart?.call(utter as unknown as SpeechSynthesisUtterance, {} as any);

    // Advance time past the 10s keep-alive cadence — engine should
    // have fired a pause()+resume() pair to keep Chromium responsive.
    vi.advanceTimersByTime(10_500);
    expect(log.pause).toBeGreaterThanOrEqual(1);
    expect(log.resume).toBeGreaterThanOrEqual(1);

    // Simulate utterance end — keep-alive must self-clear.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ((globalThis as any).window.speechSynthesis as FakeSpeechSynthesis).speaking = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    utter.onend?.call(utter as unknown as SpeechSynthesisUtterance, {} as any);

    const pauseAfterEnd = log.pause;
    vi.advanceTimersByTime(20_000);
    // No new pause()/resume() should fire after the utterance ended.
    expect(log.pause).toBe(pauseAfterEnd);
  });

  it('cancel() clears the keep-alive timer', () => {
    const log = installFakeSpeechSynthesis();
    const engine = new TTSEngine(baseTts);

    engine.enqueue(msg('start a speak'));
    const utter = log.speak[0] as unknown as FakeUtterance;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ((globalThis as any).window.speechSynthesis as FakeSpeechSynthesis).speaking = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    utter.onstart?.call(utter as unknown as SpeechSynthesisUtterance, {} as any);

    engine.cancel();
    const pauseAtCancel = log.pause;

    // After cancel(), no further keep-alive pings should fire.
    vi.advanceTimersByTime(30_000);
    expect(log.pause).toBe(pauseAtCancel);
  });
});

describe('TTSEngine — basic plumbing still intact', () => {
  it('respects enabled=false (no speak() ever fires)', async () => {
    const log = installFakeSpeechSynthesis();
    const engine = new TTSEngine({ ...baseTts, enabled: false });

    engine.enqueue(msg());
    engine.previewVoice(undefined);
    await Promise.resolve();

    // enqueue() bails before speak(). previewVoice() is a UI affordance
    // that bypasses the enabled flag (matches v0.1.9+ behaviour) — so
    // one preview speak is allowed, but no enqueue speak.
    expect(log.speak.length).toBe(1);
    expect(log.speak[0].text).toContain('Hello, my name is');
  });

  it('passes the configured volume / rate / pitch through to the utterance', async () => {
    const log = installFakeSpeechSynthesis();
    const engine = new TTSEngine({ ...baseTts, volume: 0.42, rate: 1.5, pitch: 0.8 });

    engine.previewVoice(undefined);
    await Promise.resolve();

    expect(log.speak.length).toBe(1);
    expect(log.speak[0].volume).toBeCloseTo(0.42, 5);
    expect(log.speak[0].rate).toBeCloseTo(1.5, 5);
    expect(log.speak[0].pitch).toBeCloseTo(0.8, 5);
  });
});
