// v0.1.42 — main-process native `say` TTS engine.
//
// These tests cover the unit-testable parts of `src/main/tts-native.ts`
// without spawning a real `say` subprocess:
//
//   - rateToWpm() math + clamp
//   - parseSayVoiceList() parsing including names with spaces / qualifiers
//   - NativeTtsEngine spawns with the right argv
//   - cancel() SIGTERMs the running child + clears the queue
//   - Queue advances in FIFO order; second enqueue waits for first exit
//   - SIGTERM mid-play emits a `native_speak_killed` log + drains correctly
//   - getAvailableVoices() caches across calls
//
// The fake spawner returns an EventEmitter that mimics a child process
// just enough to drive the engine — `pid`, `kill()`, and the `exit` /
// `error` event lifecycle.

import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  NATIVE_BASE_WPM,
  NATIVE_MAX_WPM,
  NATIVE_MIN_WPM,
  NativeTtsEngine,
  buildSayText,
  clampSayVolume,
  parseSayVoiceList,
  rateToWpm,
  ttsToNativeSettings,
  type NativeSpawnedChild,
  type NativeSpawner,
  type NativeVoice,
} from '../main/tts-native';
import { DEFAULT_SETTINGS } from '../shared/types';

interface FakeChild extends NativeSpawnedChild {
  pid: number;
  args: string[];
  killed: boolean;
  exit(code?: number, signal?: NodeJS.Signals | null): void;
}

function makeFakeSpawner(): {
  spawner: NativeSpawner;
  spawns: FakeChild[];
  last(): FakeChild;
} {
  const spawns: FakeChild[] = [];
  let pidCounter = 5000;
  const spawner: NativeSpawner = (args) => {
    const emitter = new EventEmitter() as EventEmitter & FakeChild;
    emitter.pid = ++pidCounter;
    emitter.args = args.slice();
    emitter.killed = false;
    emitter.kill = (signal?: NodeJS.Signals | number) => {
      emitter.killed = true;
      // Mimic the real child: exit asynchronously after the kill so the
      // engine's `exit` listener fires on the next tick.
      setImmediate(() => emitter.emit('exit', null, signal ?? 'SIGTERM'));
      return true;
    };
    emitter.exit = (code = 0, signal: NodeJS.Signals | null = null) => {
      emitter.emit('exit', code, signal);
    };
    spawns.push(emitter);
    return emitter;
  };
  return {
    spawner,
    spawns,
    last() {
      return spawns[spawns.length - 1];
    },
  };
}

const baseSettings = ttsToNativeSettings(DEFAULT_SETTINGS.tts);

describe('rateToWpm', () => {
  it('maps a 1.0 rate to NATIVE_BASE_WPM', () => {
    expect(rateToWpm(1.0)).toBe(NATIVE_BASE_WPM);
  });

  it('scales linearly: 0.5 → ~half, 2.0 → ~double', () => {
    expect(rateToWpm(0.5)).toBe(Math.round(NATIVE_BASE_WPM * 0.5));
    expect(rateToWpm(2.0)).toBe(Math.round(NATIVE_BASE_WPM * 2.0));
  });

  it('clamps below NATIVE_MIN_WPM', () => {
    expect(rateToWpm(0.01)).toBe(NATIVE_MIN_WPM);
  });

  it('clamps above NATIVE_MAX_WPM', () => {
    expect(rateToWpm(100)).toBe(NATIVE_MAX_WPM);
  });

  it('falls back to base on non-finite / non-positive inputs', () => {
    expect(rateToWpm(NaN)).toBe(NATIVE_BASE_WPM);
    expect(rateToWpm(-1)).toBe(NATIVE_BASE_WPM);
    expect(rateToWpm(0)).toBe(NATIVE_BASE_WPM);
  });
});

describe('parseSayVoiceList', () => {
  it('parses a typical macOS `say -v "?"` block', () => {
    const out = parseSayVoiceList(
      'Daniel              en_GB    # Hello! My name is Daniel.\n' +
        'Alice               it_IT    # Ciao! Mi chiamo Alice.\n' +
        'Albert              en_US    # Hello! My name is Albert.\n',
    );
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({
      name: 'Daniel',
      lang: 'en_GB',
      sample: 'Hello! My name is Daniel.',
    });
    expect(out[1].name).toBe('Alice');
    expect(out[2].name).toBe('Albert');
  });

  it('preserves parenthesised qualifiers in voice names', () => {
    const out = parseSayVoiceList(
      'Eddy (English (UK)) en_GB    # Hello! My name is Eddy.\n' +
        'Eddy (English (US)) en_US    # Hello! My name is Eddy.\n',
    );
    expect(out).toHaveLength(2);
    expect(out[0].name).toBe('Eddy (English (UK))');
    expect(out[0].lang).toBe('en_GB');
    expect(out[1].name).toBe('Eddy (English (US))');
    expect(out[1].lang).toBe('en_US');
  });

  it('accepts hyphen-style locales (e.g. zh-CN)', () => {
    const out = parseSayVoiceList('Tingting            zh-CN    # 你好,我叫婷婷。\n');
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      name: 'Tingting',
      lang: 'zh-CN',
      sample: '你好,我叫婷婷。',
    });
  });

  it('drops malformed / header lines silently', () => {
    const out = parseSayVoiceList(
      '\n' +
        '# header\n' +
        'Daniel              en_GB    # Hello! My name is Daniel.\n' +
        '   \n',
    );
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('Daniel');
  });
});

describe('NativeTtsEngine', () => {
  it('spawns `say` with -v <voice> -r <wpm> -- <text>', () => {
    const { spawner, last } = makeFakeSpawner();
    const engine = new NativeTtsEngine({
      settings: { voiceURI: 'Daniel', rate: 1.0, volume: 1.0 },
      spawner,
    });
    engine.enqueue('hello world', { messageId: 'm1' });
    const child = last();
    expect(child.args[0]).toBe('-v');
    expect(child.args[1]).toBe('Daniel');
    expect(child.args[2]).toBe('-r');
    expect(child.args[3]).toBe(String(NATIVE_BASE_WPM));
    expect(child.args[4]).toBe('--');
    // v0.1.76 — spoken text now carries the inline `[[volm n]]` volume command.
    // At volume 1.0 the prefix is `[[volm 1]] ` (full loudness; no-op on volume
    // but always emitted so behaviour is explicit + testable).
    expect(child.args[5]).toBe(buildSayText('hello world', 1.0));
    expect(child.args[5]).toBe('[[volm 1]] hello world');
  });

  it('omits the -v flag when no voice is configured', () => {
    const { spawner, last } = makeFakeSpawner();
    const engine = new NativeTtsEngine({
      settings: { ...baseSettings, voiceURI: undefined },
      spawner,
    });
    engine.enqueue('hello');
    const child = last();
    expect(child.args.includes('-v')).toBe(false);
    // Argv shape with no voice: ['-r', '<wpm>', '--', '<text>'].
    expect(child.args[0]).toBe('-r');
    expect(child.args[2]).toBe('--');
    // v0.1.76 — volume prefix (baseSettings volume is DEFAULT_SETTINGS 1.0).
    expect(child.args[3]).toBe(buildSayText('hello', baseSettings.volume));
  });

  it('queues subsequent enqueues and starts each one after the previous exits', async () => {
    const { spawner, spawns } = makeFakeSpawner();
    const engine = new NativeTtsEngine({
      settings: { ...baseSettings, voiceURI: 'Daniel' },
      spawner,
    });
    engine.enqueue('one', { messageId: 'm1' });
    engine.enqueue('two', { messageId: 'm2' });
    engine.enqueue('three', { messageId: 'm3' });
    // Only one subprocess running at a time.
    expect(spawns.length).toBe(1);
    // v0.1.76 — spoken text now carries the `[[volm n]]` prefix; assert via
    // buildSayText so the test tracks the volume-command format automatically.
    expect(spawns[0].args[spawns[0].args.length - 1]).toBe(buildSayText('one', baseSettings.volume));
    // First exits → next pops on next-tick drain.
    spawns[0].exit(0);
    await new Promise((r) => setImmediate(r));
    expect(spawns.length).toBe(2);
    expect(spawns[1].args[spawns[1].args.length - 1]).toBe(buildSayText('two', baseSettings.volume));
    spawns[1].exit(0);
    await new Promise((r) => setImmediate(r));
    expect(spawns.length).toBe(3);
    expect(spawns[2].args[spawns[2].args.length - 1]).toBe(buildSayText('three', baseSettings.volume));
    spawns[2].exit(0);
    await new Promise((r) => setImmediate(r));
    // Queue is empty; no further spawns.
    expect(spawns.length).toBe(3);
    expect(engine.queueDepth).toBe(0);
    expect(engine.isSpeaking).toBe(false);
  });

  it('cancel() SIGTERMs the running child + clears the queue', async () => {
    const { spawner, spawns } = makeFakeSpawner();
    const engine = new NativeTtsEngine({
      settings: baseSettings,
      spawner,
    });
    engine.enqueue('one');
    engine.enqueue('two');
    engine.enqueue('three');
    expect(spawns.length).toBe(1);
    expect(engine.queueDepth).toBe(2);
    engine.cancel();
    expect(spawns[0].killed).toBe(true);
    // After the killed child's exit propagates we should NOT pop the
    // next entry (cancel cleared the queue).
    await new Promise((r) => setImmediate(r));
    expect(spawns.length).toBe(1);
    expect(engine.queueDepth).toBe(0);
    expect(engine.isSpeaking).toBe(false);
  });

  it('emits native_speak_killed when cancel kills mid-play', async () => {
    const { spawner } = makeFakeSpawner();
    const logs: Array<{ event: string; data?: Record<string, unknown> }> = [];
    const engine = new NativeTtsEngine({
      settings: baseSettings,
      spawner,
      log: (event, data) => logs.push({ event, data }),
    });
    engine.enqueue('one', { messageId: 'm1' });
    engine.cancel();
    await new Promise((r) => setImmediate(r));
    const events = logs.map((l) => l.event);
    expect(events).toContain('native_speak_start');
    expect(events).toContain('native_speak_killed');
    expect(events).toContain('native_speak_end');
    const killed = logs.find((l) => l.event === 'native_speak_killed');
    expect(killed?.data?.reason).toBe('cancel');
  });

  it('drops empty / whitespace-only text without spawning', () => {
    const { spawner, spawns } = makeFakeSpawner();
    const engine = new NativeTtsEngine({ settings: baseSettings, spawner });
    engine.enqueue('');
    engine.enqueue('   ');
    engine.enqueue('\t\n');
    expect(spawns.length).toBe(0);
  });

  it('updateSettings affects future utterances only, not the in-flight one', async () => {
    const { spawner, spawns } = makeFakeSpawner();
    const engine = new NativeTtsEngine({
      settings: { voiceURI: 'Daniel', rate: 1.0, volume: 1.0 },
      spawner,
    });
    engine.enqueue('one');
    expect(spawns[0].args.includes('Daniel')).toBe(true);
    engine.updateSettings({ voiceURI: 'Alice', rate: 1.5, volume: 1.0 });
    // The running child still has Daniel's argv — we don't mutate it.
    expect(spawns[0].args.includes('Daniel')).toBe(true);
    engine.enqueue('two');
    // Still only one spawn — the second is queued behind the first.
    expect(spawns.length).toBe(1);
    spawns[0].exit(0);
    await new Promise((r) => setImmediate(r));
    expect(spawns.length).toBe(2);
    expect(spawns[1].args.includes('Alice')).toBe(true);
    expect(spawns[1].args.includes(String(Math.round(NATIVE_BASE_WPM * 1.5)))).toBe(true);
  });

  it('getAvailableVoices caches across calls (only probes once)', async () => {
    const probe = vi.fn(async (): Promise<NativeVoice[]> => [
      { name: 'Daniel', lang: 'en_GB', sample: 'hi' },
      { name: 'Alice', lang: 'it_IT', sample: 'ciao' },
    ]);
    const { spawner } = makeFakeSpawner();
    const engine = new NativeTtsEngine({
      settings: baseSettings,
      spawner,
      voiceListProbe: probe,
    });
    const a = await engine.getAvailableVoices();
    const b = await engine.getAvailableVoices();
    expect(a).toEqual(b);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('refreshVoices forces a re-probe', async () => {
    let n = 0;
    const probe = vi.fn(async (): Promise<NativeVoice[]> => {
      n += 1;
      return [{ name: `v${n}`, lang: 'en_US', sample: '' }];
    });
    const { spawner } = makeFakeSpawner();
    const engine = new NativeTtsEngine({
      settings: baseSettings,
      spawner,
      voiceListProbe: probe,
    });
    const a = await engine.getAvailableVoices();
    const b = await engine.refreshVoices();
    expect(a[0].name).toBe('v1');
    expect(b[0].name).toBe('v2');
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('survives spawn() throwing and continues to drain the queue', async () => {
    let throwOnNext = true;
    const spawns: FakeChild[] = [];
    const spawner: NativeSpawner = (args) => {
      if (throwOnNext) {
        throwOnNext = false;
        throw new Error('boom');
      }
      const emitter = new EventEmitter() as EventEmitter & FakeChild;
      emitter.pid = 999;
      emitter.args = args.slice();
      emitter.killed = false;
      emitter.kill = () => {
        emitter.killed = true;
        return true;
      };
      emitter.exit = (code = 0, signal: NodeJS.Signals | null = null) =>
        emitter.emit('exit', code, signal);
      spawns.push(emitter);
      return emitter;
    };
    const engine = new NativeTtsEngine({ settings: baseSettings, spawner });
    engine.enqueue('one');
    engine.enqueue('two');
    // Allow the setImmediate-deferred drain after the throw to run.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(spawns.length).toBe(1);
    // v0.1.76 — volume-prefixed spoken text.
    expect(spawns[0].args[spawns[0].args.length - 1]).toBe(buildSayText('two', baseSettings.volume));
  });
});

// v0.1.76 (Ethan voice 4414) — native volume application via `[[volm n]]`.
// This is the load-bearing test for Ethan's hard constraint: the volume slider
// MUST keep working even when the native `say` fallback is what's speaking.
describe('native volume application (v0.1.76)', () => {
  it('clampSayVolume clamps to [0,1] and defaults undefined/NaN to 1.0', () => {
    expect(clampSayVolume(0.5)).toBe(0.5);
    expect(clampSayVolume(0)).toBe(0);
    expect(clampSayVolume(1)).toBe(1);
    expect(clampSayVolume(-0.3)).toBe(0); // below range → 0
    expect(clampSayVolume(2)).toBe(1); // above range → 1
    expect(clampSayVolume(undefined)).toBe(1.0); // missing → full (never mute)
    expect(clampSayVolume(Number.NaN)).toBe(1.0);
  });

  it('buildSayText prepends the inline [[volm n]] command', () => {
    expect(buildSayText('hi', 0.35)).toBe('[[volm 0.35]] hi');
    expect(buildSayText('hi', 1)).toBe('[[volm 1]] hi');
    expect(buildSayText('hi', 0)).toBe('[[volm 0]] hi');
    // Out-of-range clamps before formatting.
    expect(buildSayText('hi', 2)).toBe('[[volm 1]] hi');
  });

  it('per-utterance volume opt flows into the spoken `say` text', () => {
    const { spawner, last } = makeFakeSpawner();
    const engine = new NativeTtsEngine({
      settings: { voiceURI: undefined, rate: 1.0, volume: 1.0 },
      spawner,
    });
    // A specific per-message volume (e.g. from settings.tts.volume = 0.2).
    engine.enqueue('quiet please', { volume: 0.2 });
    const child = last();
    // Last arg is the spoken text — must carry the requested volume command.
    expect(child.args[child.args.length - 1]).toBe('[[volm 0.2]] quiet please');
  });

  it('falls back to engine settings volume when the opt is omitted', () => {
    const { spawner, last } = makeFakeSpawner();
    const engine = new NativeTtsEngine({
      // Engine-level volume the slider set; no per-utterance override.
      settings: { voiceURI: undefined, rate: 1.0, volume: 0.6 },
      spawner,
    });
    engine.enqueue('medium volume');
    const child = last();
    expect(child.args[child.args.length - 1]).toBe('[[volm 0.6]] medium volume');
  });
});

describe('ttsToNativeSettings', () => {
  it('extracts voiceURI / rate / volume from the full TTS settings', () => {
    const s = {
      ...DEFAULT_SETTINGS.tts,
      voiceURI: 'Daniel',
      rate: 1.25,
      volume: 0.7,
    };
    expect(ttsToNativeSettings(s)).toEqual({
      voiceURI: 'Daniel',
      rate: 1.25,
      volume: 0.7,
    });
  });
});
