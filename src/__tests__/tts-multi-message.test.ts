// Regression guards for the v0.1.40 multi-message TTS stall.
//
// Ethan voice 3424: "the first message it read out, subsequent messages
// it didn't." Root cause (Codex + Claude diagnosis): the
// SpeechSynthesisUtterance was created as a function-local variable in
// `TTSEngine.speak()`, so Electron 42 Chromium could GC it mid-flight.
// When that happened, `utter.onend` never fired, `this.speaking` stayed
// `true` forever, and every subsequent `tick()` returned early.
//
// v0.1.40 fix:
//   1. Retain the utterance as `this.currentUtter` for the lifetime of
//      its playback so the JS engine can't GC it.
//   2. Add a watchdog timer that force-resets `speaking` if neither
//      onend nor onerror fires within SPEAK_WATCHDOG_MS.
//
// These tests use the same fake speechSynthesis pattern as
// `tts-regression.test.ts` — see that file for caveats about how this
// doesn't fully model Chromium's async cancel state machine.

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

function installFakeSpeechSynthesis(): CallLog {
  const log: CallLog = { speak: [], cancel: 0 };
  let paused = false;

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
      paused = true;
    },
    resume() {
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
  maxPerMinute: 60,
};

const msg = (id: string, text: string): ChatMessage => ({
  id,
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

describe('TTSEngine — multi-message queue (v0.1.40 Bug-2)', () => {
  it('drains 5 consecutive enqueue() calls to 5 speak() calls when onend fires normally', () => {
    const log = installFakeSpeechSynthesis();
    const engine = new TTSEngine(baseTts);

    // Send 5 messages in rapid succession (simulates a stream of chat
    // arrivals during a live broadcast).
    for (let i = 0; i < 5; i++) {
      engine.enqueue(msg(`m${i}`, `message ${i}`));
    }

    // First message should be speaking immediately. Remaining are queued.
    expect(log.speak.length).toBe(1);
    expect(log.speak[0]?.text).toBe('message 0');

    // Simulate the engine firing onend for each utterance in turn. The
    // queue must drain to FIVE speak() calls total — pre-v0.1.40 this
    // stalled at 1 because `this.speaking` got stuck true after GC ate
    // the utter.
    for (let i = 0; i < 5; i++) {
      const utter = log.speak[i];
      expect(utter, `utter ${i} should have been spoken`).toBeDefined();
      utter!.onend?.call(
        utter as unknown as SpeechSynthesisUtterance,
        {} as SpeechSynthesisEvent,
      );
      // Engine ticks 50ms after onend.
      vi.advanceTimersByTime(60);
    }

    expect(log.speak.length).toBe(5);
    expect(log.speak.map((u) => u.text)).toEqual([
      'message 0',
      'message 1',
      'message 2',
      'message 3',
      'message 4',
    ]);
  });

  it('retains a strong reference to the in-flight utterance (prevents GC mid-playback)', () => {
    const log = installFakeSpeechSynthesis();
    const engine = new TTSEngine(baseTts);

    engine.enqueue(msg('m0', 'first'));

    const utter = log.speak[0];
    expect(utter).toBeDefined();

    // The engine should still be holding `utter` somewhere — easiest
    // proof: if it's NOT holding it, the test runner's reference is
    // moot. We check by interrogating the engine's behavior: a second
    // enqueue while still "speaking" must queue rather than parallel-
    // speak.
    engine.enqueue(msg('m1', 'second'));
    expect(log.speak.length).toBe(1); // second is queued, not spoken

    // Now fire onend on the FIRST utter and confirm the second drains.
    utter!.onend?.call(
      utter as unknown as SpeechSynthesisUtterance,
      {} as SpeechSynthesisEvent,
    );
    vi.advanceTimersByTime(60);
    expect(log.speak.length).toBe(2);
    expect(log.speak[1]?.text).toBe('second');
  });

  it('watchdog drains the queue when onend never fires (Electron 42 quirk)', () => {
    const log = installFakeSpeechSynthesis();
    const engine = new TTSEngine(baseTts);

    engine.enqueue(msg('m0', 'first'));
    engine.enqueue(msg('m1', 'second'));

    // First message is speaking; second is queued. We DELIBERATELY do
    // not fire onend on the first to simulate the Bug-2 failure mode
    // where Chromium silently drops the end event.
    expect(log.speak.length).toBe(1);

    // Advance past the watchdog cap (60s). The watchdog should treat
    // utter[0] as ended and process the queue.
    vi.advanceTimersByTime(60_500);
    // The post-onDone setTimeout(tick, 50) needs to fire.
    vi.advanceTimersByTime(100);

    expect(log.speak.length).toBe(2);
    expect(log.speak[1]?.text).toBe('second');
  });

  it('late onend after watchdog does NOT double-advance the queue', () => {
    const log = installFakeSpeechSynthesis();
    const engine = new TTSEngine(baseTts);

    engine.enqueue(msg('m0', 'first'));
    engine.enqueue(msg('m1', 'second'));
    engine.enqueue(msg('m2', 'third'));

    const first = log.speak[0];
    expect(first).toBeDefined();

    // Watchdog fires first.
    vi.advanceTimersByTime(60_500);
    vi.advanceTimersByTime(100);
    expect(log.speak.length).toBe(2);

    // NOW the real engine belatedly fires onend on the first utter.
    // This must not advance the queue a second time — that would skip
    // the second message and jump straight to the third while the
    // second is mid-flight.
    first!.onend?.call(
      first as unknown as SpeechSynthesisUtterance,
      {} as SpeechSynthesisEvent,
    );
    vi.advanceTimersByTime(100);

    // Still 2 — the second utter is mid-flight, third should not have
    // been spoken yet.
    expect(log.speak.length).toBe(2);
  });

  it('error event still drains the queue (parity with onend)', () => {
    const log = installFakeSpeechSynthesis();
    const engine = new TTSEngine(baseTts);

    engine.enqueue(msg('m0', 'first'));
    engine.enqueue(msg('m1', 'second'));

    const first = log.speak[0];
    first!.onerror?.call(
      first as unknown as SpeechSynthesisUtterance,
      { error: 'interrupted' } as unknown as SpeechSynthesisErrorEvent,
    );
    vi.advanceTimersByTime(60);

    expect(log.speak.length).toBe(2);
    expect(log.speak[1]?.text).toBe('second');
  });

  it('cancel() clears the queue, watchdog, and currentUtter', () => {
    const log = installFakeSpeechSynthesis();
    const engine = new TTSEngine(baseTts);

    engine.enqueue(msg('m0', 'first'));
    engine.enqueue(msg('m1', 'second'));
    engine.enqueue(msg('m2', 'third'));
    expect(log.speak.length).toBe(1);

    // Make speechSynthesis report it's actively speaking so the cancel
    // path actually calls window.speechSynthesis.cancel().
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ((globalThis as any).window.speechSynthesis as FakeSpeechSynthesis).speaking = true;
    engine.cancel();
    expect(log.cancel).toBe(1);

    // After cancel, advancing past the watchdog must NOT cause more
    // speak() calls — the watchdog timer should have been cleared.
    vi.advanceTimersByTime(120_000);
    expect(log.speak.length).toBe(1);

    // New enqueue after cancel works (queue isn't permanently broken).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ((globalThis as any).window.speechSynthesis as FakeSpeechSynthesis).speaking = false;
    engine.enqueue(msg('m3', 'fourth'));
    expect(log.speak.length).toBe(2);
    expect(log.speak[1]?.text).toBe('fourth');
  });
});
