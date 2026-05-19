// v0.1.42 — renderer-side native TTS engine + factory.
//
// `NativeTtsEngine` (renderer) is a thin IPC wrapper around the
// main-process queue. These tests verify that:
//
//   - `enqueue(message)` calls `window.rcpp.ttsNative.enqueue` with the
//     right payload (composed text, voice, rate, volume, messageId).
//   - `cancel()` calls the bridge's cancel.
//   - `updateSettings(s)` propagates the slice to the bridge and a
//     transition from enabled=true → enabled=false fires a cancel.
//   - `previewVoice()` bypasses the queue and returns the spoken text.
//   - `makeTtsEngine` picks the right implementation based on
//     `settings.tts.engine`.
//   - `getNativeVoices()` calls through to the bridge and caches.
//
// We stub `window.rcpp.ttsNative` to a manual mock so we can assert on
// every call shape without spawning anything real.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  NativeTtsEngine,
  TTSEngine,
  makeTtsEngine,
  type TtsEngineLike,
} from '../renderer/tts';
import {
  DEFAULT_SETTINGS,
  type ChatMessage,
  type NativeVoiceWire,
  type Settings,
} from '../shared/types';

interface BridgeCalls {
  enqueue: Array<{
    text: string;
    voice?: string;
    rate?: number;
    volume?: number;
    messageId?: string;
  }>;
  cancel: number;
  updateSettings: Array<{ voiceURI?: string; rate: number; volume: number }>;
  getVoices: number;
}

function installFakeBridge(voices: NativeVoiceWire[] = []): BridgeCalls {
  const calls: BridgeCalls = {
    enqueue: [],
    cancel: 0,
    updateSettings: [],
    getVoices: 0,
  };
  (globalThis as unknown as { window: unknown }).window = {
    speechSynthesis: undefined,
    rcpp: {
      ttsNative: {
        enqueue: (p: BridgeCalls['enqueue'][number]) => {
          calls.enqueue.push(p);
        },
        cancel: () => {
          calls.cancel += 1;
        },
        updateSettings: (p: BridgeCalls['updateSettings'][number]) => {
          calls.updateSettings.push(p);
        },
        getVoices: async () => {
          calls.getVoices += 1;
          return voices;
        },
      },
    },
  };
  return calls;
}

function tts(overrides: Partial<Settings['tts']> = {}): Settings['tts'] {
  return {
    ...DEFAULT_SETTINGS.tts,
    enabled: true,
    engine: 'native',
    maxPerMinute: 60,
    ...overrides,
  };
}

function msg(id: string, text: string, username = 'alice'): ChatMessage {
  return {
    id,
    platform: 'twitch',
    username,
    text,
    ts: Date.now(),
  };
}

beforeEach(() => {
  // Clean slate for each test — no leaked window from a previous test.
  delete (globalThis as unknown as { window?: unknown }).window;
});

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe('renderer NativeTtsEngine', () => {
  it('enqueue calls bridge.enqueue with composed text + voice/rate/volume + messageId', () => {
    const calls = installFakeBridge();
    const engine = new NativeTtsEngine(
      tts({ voiceURI: 'Daniel', rate: 1.25, volume: 0.7 }),
    );
    engine.enqueue(msg('m1', 'hello world'));
    expect(calls.enqueue).toHaveLength(1);
    expect(calls.enqueue[0]).toMatchObject({
      text: 'hello world',
      voice: 'Daniel',
      rate: 1.25,
      volume: 0.7,
      messageId: 'm1',
    });
  });

  it('respects readSenderName=true by prefixing the username', () => {
    const calls = installFakeBridge();
    const engine = new NativeTtsEngine(tts({ readSenderName: true }));
    engine.enqueue(msg('m1', 'hello'));
    expect(calls.enqueue[0].text).toBe('alice says hello');
  });

  it('drops enqueue when settings.tts.enabled is false', () => {
    const calls = installFakeBridge();
    const engine = new NativeTtsEngine(tts({ enabled: false }));
    engine.enqueue(msg('m1', 'hello'));
    expect(calls.enqueue).toHaveLength(0);
  });

  it('cancel() invokes bridge.cancel', () => {
    const calls = installFakeBridge();
    const engine = new NativeTtsEngine(tts());
    engine.cancel();
    expect(calls.cancel).toBe(1);
  });

  it('disabling via updateSettings cancels the in-flight queue', () => {
    const calls = installFakeBridge();
    const engine = new NativeTtsEngine(tts({ enabled: true }));
    expect(calls.cancel).toBe(0);
    engine.updateSettings(tts({ enabled: false }));
    expect(calls.cancel).toBe(1);
  });

  it('updateSettings pushes the slice to bridge.updateSettings', () => {
    const calls = installFakeBridge();
    const engine = new NativeTtsEngine(tts({ rate: 1.0, voiceURI: 'Daniel' }));
    // Constructor already pushed once.
    expect(calls.updateSettings).toHaveLength(1);
    engine.updateSettings(tts({ rate: 1.5, voiceURI: 'Alice', volume: 0.4 }));
    expect(calls.updateSettings).toHaveLength(2);
    expect(calls.updateSettings[1]).toEqual({
      voiceURI: 'Alice',
      rate: 1.5,
      volume: 0.4,
    });
  });

  it('previewVoice enqueues a sample utterance + returns the text', () => {
    const calls = installFakeBridge();
    const engine = new NativeTtsEngine(tts());
    const spoken = engine.previewVoice('Daniel');
    expect(spoken).toBe('Hello, my name is Daniel');
    // previewVoice cancels stale previews + enqueues fresh.
    expect(calls.cancel).toBe(1);
    expect(calls.enqueue.at(-1)).toMatchObject({
      text: 'Hello, my name is Daniel',
      voice: 'Daniel',
    });
  });

  it('previewVoice with undefined voice falls back to system default phrasing', () => {
    installFakeBridge();
    const engine = new NativeTtsEngine(tts());
    const spoken = engine.previewVoice(undefined);
    expect(spoken).toBe('Hello, my name is system default');
  });

  it('rate-limits client-side via settings.tts.maxPerMinute', () => {
    const calls = installFakeBridge();
    const engine = new NativeTtsEngine(tts({ maxPerMinute: 2 }));
    engine.enqueue(msg('m1', 'a'));
    engine.enqueue(msg('m2', 'b'));
    engine.enqueue(msg('m3', 'c')); // dropped
    expect(calls.enqueue).toHaveLength(2);
  });

  it('getNativeVoices fetches once and caches', async () => {
    const calls = installFakeBridge([
      { name: 'Daniel', lang: 'en_GB', sample: 'hi' },
    ]);
    const engine = new NativeTtsEngine(tts());
    const a = await engine.getNativeVoices();
    const b = await engine.getNativeVoices();
    expect(a).toEqual(b);
    expect(calls.getVoices).toBe(1);
  });

  it('voices() returns [] (the native list flows through getNativeVoices)', () => {
    installFakeBridge();
    const engine = new NativeTtsEngine(tts());
    expect(engine.voices()).toEqual([]);
  });
});

describe('makeTtsEngine factory', () => {
  it("returns NativeTtsEngine when engine='native'", () => {
    installFakeBridge();
    const engine: TtsEngineLike = makeTtsEngine(tts({ engine: 'native' }));
    expect(engine).toBeInstanceOf(NativeTtsEngine);
  });

  it("returns the legacy TTSEngine when engine='browser'", () => {
    installFakeBridge();
    const engine: TtsEngineLike = makeTtsEngine(tts({ engine: 'browser' }));
    expect(engine).toBeInstanceOf(TTSEngine);
  });
});
