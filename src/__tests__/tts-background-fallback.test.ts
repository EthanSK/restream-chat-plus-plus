// v0.1.74 (Ethan voice 4407, 2026-05-30) — BACKGROUND-TTS FIX regression guards.
//
// Symptom: when RC++ sits in the background/occluded for a while, an
// incoming chat message still RENDERS (the WS frame is received in the MAIN
// process and pushed over IPC, which is never throttled) but TTS does NOT
// speak it. When the window is focused, TTS works fine.
//
// Root cause: the default TTS engine is the renderer-side Web Speech path
// (`window.speechSynthesis`). Chromium SUSPENDS speechSynthesis while the
// page is hidden/occluded — speak() is silently swallowed (no
// onstart/onend/onerror), so the message renders but is never voiced.
//
// Fix (the load-bearing layer): the browser `TTSEngine` detects
// `document.hidden` / `visibilityState !== 'visible'` and, when hidden,
// forwards the utterance to the native main-process `say` bridge
// (`window.rcpp.ttsNative`) instead of calling speechSynthesis. The native
// path is a subprocess spawned outside the renderer, so renderer visibility
// is irrelevant — it ALWAYS speaks. When visible we keep speechSynthesis so
// the in-app volume slider still works.
//
// These tests pin that routing behaviour so it can't silently regress:
//   - hidden  → message goes to the native bridge, NOT speechSynthesis
//   - visible → message goes to speechSynthesis, NOT the native bridge
//   - hidden but NO native bridge → falls back to speechSynthesis (never
//     drops the message outright)
//   - background fallback still honours the maxPerMinute rate limit

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TTSEngine } from '../renderer/tts';
import type { ChatMessage, Settings, TtsNativeEnqueuePayload } from '../shared/types';

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

interface NativeBridgeCalls {
  enqueue: TtsNativeEnqueuePayload[];
  cancel: number;
}

interface Harness {
  speak: FakeUtterance[];
  native: NativeBridgeCalls;
}

/**
 * Install a fake `window` carrying speechSynthesis + (optionally) the
 * native `say` bridge, plus a fake `document` with a controllable
 * `hidden` flag. `hidden` simulates the backgrounded/occluded state.
 * `withNativeBridge=false` simulates a non-Electron env where the bridge
 * is missing (test the safe fallback to speechSynthesis).
 */
function installHarness(opts: { hidden: boolean; withNativeBridge?: boolean }): Harness {
  const withBridge = opts.withNativeBridge !== false;
  const speakLog: FakeUtterance[] = [];
  const native: NativeBridgeCalls = { enqueue: [], cancel: 0 };

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

  const synth = {
    paused: false,
    speaking: false,
    pending: false,
    speak(utter: FakeUtterance) {
      speakLog.push(utter);
    },
    cancel() {
      /* no-op for these tests */
    },
    pause() {
      /* no-op */
    },
    resume() {
      /* no-op */
    },
    getVoices(): SpeechSynthesisVoice[] {
      return [];
    },
    onvoiceschanged: null,
  };

  const rcpp = withBridge
    ? {
        // ttsLog is queried by persistTtsEvent — provide a no-op so the
        // disk-log path doesn't throw.
        ttsLog: () => undefined,
        ttsNative: {
          enqueue: (p: TtsNativeEnqueuePayload) => {
            native.enqueue.push(p);
          },
          cancel: () => {
            native.cancel += 1;
          },
          updateSettings: () => undefined,
          getVoices: async () => [],
        },
      }
    : {
        ttsLog: () => undefined,
        // No ttsNative — simulates non-Electron / missing bridge.
      };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).window = {
    speechSynthesis: synth,
    SpeechSynthesisUtterance: FakeUtter,
    rcpp,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).SpeechSynthesisUtterance = FakeUtter;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).document = {
    hidden: opts.hidden,
    visibilityState: opts.hidden ? 'hidden' : 'visible',
  };

  return { speak: speakLog, native };
}

function uninstallHarness() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).window;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).SpeechSynthesisUtterance;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).document;
}

const baseTts: Settings['tts'] = {
  enabled: true,
  engine: 'browser', // explicitly exercise the browser engine + its fallback
  readSenderName: false,
  voiceURI: 'Daniel',
  rate: 1.25,
  pitch: 1.0,
  volume: 0.8,
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
  uninstallHarness();
});

describe('TTSEngine — background/visibility fallback (v0.1.74)', () => {
  it('routes to the native `say` bridge when the page is HIDDEN (occluded)', () => {
    const h = installHarness({ hidden: true });
    const engine = new TTSEngine(baseTts);
    engine.enqueue(msg('m1', 'hello world'));

    // The whole point: speechSynthesis is suspended while hidden, so we must
    // NOT have called it — the message goes to the native bridge instead.
    expect(h.speak).toHaveLength(0);
    expect(h.native.enqueue).toHaveLength(1);
    expect(h.native.enqueue[0]).toMatchObject({
      text: 'hello world',
      voice: 'Daniel',
      rate: 1.25,
      volume: 0.8,
      messageId: 'm1',
    });
  });

  it('uses speechSynthesis (NOT the native bridge) when the page is VISIBLE', () => {
    const h = installHarness({ hidden: false });
    const engine = new TTSEngine(baseTts);
    engine.enqueue(msg('m1', 'hello world'));

    // Foreground: keep using Web Speech so the volume slider is honoured.
    expect(h.speak).toHaveLength(1);
    expect(h.speak[0].text).toBe('hello world');
    expect(h.native.enqueue).toHaveLength(0);
  });

  it('falls back to speechSynthesis when hidden but the native bridge is missing (never drops the message)', () => {
    const h = installHarness({ hidden: true, withNativeBridge: false });
    const engine = new TTSEngine(baseTts);
    engine.enqueue(msg('m1', 'hello world'));

    // No native bridge available — rather than silently dropping the
    // message, we attempt the (possibly-suspended) speechSynthesis path.
    expect(h.native.enqueue).toHaveLength(0);
    expect(h.speak).toHaveLength(1);
  });

  it('drains multiple hidden messages through the native bridge in order', () => {
    const h = installHarness({ hidden: true });
    const engine = new TTSEngine(baseTts);
    engine.enqueue(msg('m1', 'first'));
    // The fallback path advances the queue on a 50ms setTimeout; flush it.
    vi.advanceTimersByTime(60);
    engine.enqueue(msg('m2', 'second'));
    vi.advanceTimersByTime(60);

    expect(h.speak).toHaveLength(0);
    expect(h.native.enqueue.map((e) => e.text)).toEqual(['first', 'second']);
  });

  it('background fallback still honours the maxPerMinute rate limit', () => {
    const h = installHarness({ hidden: true });
    const engine = new TTSEngine({ ...baseTts, maxPerMinute: 2 });
    engine.enqueue(msg('m1', 'a'));
    vi.advanceTimersByTime(60);
    engine.enqueue(msg('m2', 'b'));
    vi.advanceTimersByTime(60);
    // Third within the same minute should be rate-limited (deferred), so the
    // native bridge has only seen the first two so far.
    engine.enqueue(msg('m3', 'c'));
    vi.advanceTimersByTime(60);

    expect(h.native.enqueue.map((e) => e.text)).toEqual(['a', 'b']);
  });
});
