// Main-process CROSS-PLATFORM native OS-voice TTS engine.
//
// v0.1.81 — the engine speaks on macOS (`say`), Windows (PowerShell
// System.Speech) and Linux (spd-say / espeak). These tests cover the
// unit-testable parts WITHOUT spawning a real subprocess:
//
//   - rate/volume mapping math for every platform scale
//   - per-platform voice-list parsers
//   - platform-adapter selection (incl. Linux which/probe fallback chain)
//   - the engine spawns with the right command + argv per platform
//   - SECURITY: untrusted text is passed as an ARGV slot (macOS/Linux) or via a
//     base64 ENV VAR (Windows) — never interpolated into a shell/PS command
//   - cancel() SIGTERMs the child + clears the queue; FIFO ordering; no-engine
//     no-op; spawn-throw recovery; voice-list caching
//
// The fake spawner returns an EventEmitter that mimics a child process just
// enough to drive the engine, and CAPTURES the full spawn spec (command + args
// + env) so the security + argv assertions can inspect exactly what would be
// spawned.

import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  NATIVE_BASE_WPM,
  NATIVE_MAX_WPM,
  NATIVE_MIN_WPM,
  NativeTtsEngine,
  buildSayText,
  clampSayVolume,
  detectPlatformAdapter,
  parseEspeakVoiceList,
  parseSayVoiceList,
  parseSpdVoiceList,
  parseWindowsVoiceList,
  rateToWpm,
  rateToWindowsRate,
  rateToSpdRate,
  ttsToNativeSettings,
  volumeToPercent,
  volumeToSpdIntensity,
  type NativeSpawnArgs,
  type NativeSpawnedChild,
  type NativeSpawner,
  type NativeVoice,
  type PlatformAdapter,
} from '../main/tts-native';
import { DEFAULT_SETTINGS } from '../shared/types';

interface FakeChild extends NativeSpawnedChild {
  pid: number;
  spec: NativeSpawnArgs;
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
  const spawner: NativeSpawner = (spec) => {
    const emitter = new EventEmitter() as EventEmitter & FakeChild;
    emitter.pid = ++pidCounter;
    // Capture the FULL spec (command/args/env) so tests can assert on the exact
    // spawn — critical for the security checks (text in argv / base64 env).
    emitter.spec = { command: spec.command, args: spec.args.slice(), env: spec.env ? { ...spec.env } : undefined };
    emitter.killed = false;
    emitter.kill = (signal?: NodeJS.Signals | number) => {
      emitter.killed = true;
      setImmediate(() => emitter.emit('exit', null, signal ?? 'SIGTERM'));
      return true;
    };
    emitter.exit = (code = 0, signal: NodeJS.Signals | null = null) => {
      emitter.emit('exit', code, signal);
    };
    spawns.push(emitter);
    return emitter;
  };
  return { spawner, spawns, last: () => spawns[spawns.length - 1] };
}

// Force the macOS `say` adapter regardless of the host OS (CI runs Linux), so
// the argv/queue tests are deterministic. detectPlatformAdapter('darwin')
// returns the real say adapter with no `which` probing.
const macAdapter = detectPlatformAdapter('darwin') as PlatformAdapter;
const baseSettings = ttsToNativeSettings(DEFAULT_SETTINGS.tts);

// Convenience: last argv entry is the spoken text on macOS/Linux (after `--`).
function lastArg(c: FakeChild): string {
  return c.spec.args[c.spec.args.length - 1];
}

describe('rate/volume mapping math', () => {
  it('rateToWpm maps 1.0 → base, scales linearly, clamps, falls back', () => {
    expect(rateToWpm(1.0)).toBe(NATIVE_BASE_WPM);
    expect(rateToWpm(0.5)).toBe(Math.round(NATIVE_BASE_WPM * 0.5));
    expect(rateToWpm(2.0)).toBe(Math.round(NATIVE_BASE_WPM * 2.0));
    expect(rateToWpm(0.01)).toBe(NATIVE_MIN_WPM);
    expect(rateToWpm(100)).toBe(NATIVE_MAX_WPM);
    expect(rateToWpm(NaN)).toBe(NATIVE_BASE_WPM);
    expect(rateToWpm(-1)).toBe(NATIVE_BASE_WPM);
    expect(rateToWpm(0)).toBe(NATIVE_BASE_WPM);
  });

  it('clampSayVolume clamps to [0,1], defaults undefined/NaN to 1.0', () => {
    expect(clampSayVolume(0.5)).toBe(0.5);
    expect(clampSayVolume(0)).toBe(0);
    expect(clampSayVolume(1)).toBe(1);
    expect(clampSayVolume(-0.3)).toBe(0);
    expect(clampSayVolume(2)).toBe(1);
    expect(clampSayVolume(undefined)).toBe(1.0);
    expect(clampSayVolume(Number.NaN)).toBe(1.0);
  });

  it('volumeToPercent maps 0..1 → 0..100 integer (Windows / espeak)', () => {
    expect(volumeToPercent(0)).toBe(0);
    expect(volumeToPercent(1)).toBe(100);
    expect(volumeToPercent(0.5)).toBe(50);
    expect(volumeToPercent(0.337)).toBe(34); // rounded
    expect(volumeToPercent(undefined)).toBe(100); // never mute on missing
  });

  it('rateToWindowsRate maps 1.0→0, 2.0→+10, 0.5→-5, clamps to [-10,10]', () => {
    expect(rateToWindowsRate(1.0)).toBe(0);
    expect(rateToWindowsRate(2.0)).toBe(10);
    expect(rateToWindowsRate(0.5)).toBe(-5);
    expect(rateToWindowsRate(5)).toBe(10); // clamp high
    expect(rateToWindowsRate(0.01)).toBe(-10); // clamp low
    expect(rateToWindowsRate(NaN)).toBe(0);
  });

  it('spd-say scales: volume 0→-100/1→0, rate 1.0→0/0.5→-50/2.0→+100', () => {
    expect(volumeToSpdIntensity(0)).toBe(-100);
    expect(volumeToSpdIntensity(1)).toBe(0);
    expect(volumeToSpdIntensity(0.5)).toBe(-50);
    expect(rateToSpdRate(1.0)).toBe(0);
    expect(rateToSpdRate(0.5)).toBe(-50);
    expect(rateToSpdRate(2.0)).toBe(100);
    expect(rateToSpdRate(NaN)).toBe(0);
  });
});

describe('voice-list parsers', () => {
  it('parseSayVoiceList parses macOS names with spaces/qualifiers + hyphen locales', () => {
    const out = parseSayVoiceList(
      'Daniel              en_GB    # Hello! My name is Daniel.\n' +
        'Eddy (English (UK)) en_GB    # Hello! My name is Eddy.\n' +
        'Tingting            zh-CN    # 你好。\n' +
        '# header junk\n',
    );
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ name: 'Daniel', lang: 'en_GB', sample: 'Hello! My name is Daniel.' });
    expect(out[1].name).toBe('Eddy (English (UK))');
    expect(out[2].lang).toBe('zh-CN');
  });

  it('parseWindowsVoiceList parses "name|culture" rows, drops junk', () => {
    const out = parseWindowsVoiceList(
      'Microsoft Zira Desktop|en-US\n' +
        'Microsoft Hazel Desktop|en-GB\n' +
        'no-pipe-line-should-drop\n' +
        '\n',
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ name: 'Microsoft Zira Desktop', lang: 'en-US', sample: '' });
    expect(out[1].lang).toBe('en-GB');
  });

  it('parseSpdVoiceList takes first/second columns, skips header', () => {
    const out = parseSpdVoiceList(
      'Name                 Language  Variant\n' +
        'english-us           en-US     none\n' +
        'german               de        none\n',
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ name: 'english-us', lang: 'en-US', sample: '' });
    expect(out[1].name).toBe('german');
  });

  it('parseEspeakVoiceList takes VoiceName/Language columns, skips Pty header', () => {
    const out = parseEspeakVoiceList(
      ' Pty Language Age/Gender VoiceName          File          Other\n' +
        '  5  en-us          M  english-us          en-us         (en 5)\n' +
        '  5  de             M  german              de            (de 5)\n',
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ name: 'english-us', lang: 'en-us', sample: '' });
    expect(out[1].name).toBe('german');
  });
});

describe('detectPlatformAdapter (platform engine selection)', () => {
  it('darwin → macos-say', () => {
    expect(detectPlatformAdapter('darwin')?.id).toBe('macos-say');
  });

  it('win32 → windows-sapi', () => {
    expect(detectPlatformAdapter('win32')?.id).toBe('windows-sapi');
  });

  it('linux prefers spd-say, then espeak-ng, then espeak, then null', () => {
    const has = (...present: string[]) => (bin: string) => present.includes(bin);
    expect(detectPlatformAdapter('linux', has('spd-say'))?.id).toBe('linux-spd');
    // No spd-say but espeak-ng present.
    expect(detectPlatformAdapter('linux', has('espeak-ng'))?.id).toBe('linux-espeak');
    // Only legacy espeak.
    expect(detectPlatformAdapter('linux', has('espeak'))?.id).toBe('linux-espeak');
    // Nothing installed → null (engine no-ops, never crashes).
    expect(detectPlatformAdapter('linux', has())).toBeNull();
  });

  it('spd-say wins over espeak when both present', () => {
    const both = (bin: string) => ['spd-say', 'espeak-ng', 'espeak'].includes(bin);
    expect(detectPlatformAdapter('linux', both)?.id).toBe('linux-spd');
  });

  it('unknown platform → null', () => {
    expect(detectPlatformAdapter('aix' as NodeJS.Platform, () => true)).toBeNull();
  });
});

describe('NativeTtsEngine — macOS say argv', () => {
  it('spawns `say` with -v <voice> -r <wpm> -- <[[volm]] text>', () => {
    const { spawner, last } = makeFakeSpawner();
    const engine = new NativeTtsEngine({
      settings: { voiceURI: 'Daniel', rate: 1.0, volume: 1.0 },
      spawner,
      adapter: macAdapter,
    });
    engine.enqueue('hello world', { messageId: 'm1' });
    const c = last();
    expect(c.spec.command).toBe('say');
    expect(c.spec.args[0]).toBe('-v');
    expect(c.spec.args[1]).toBe('Daniel');
    expect(c.spec.args[2]).toBe('-r');
    expect(c.spec.args[3]).toBe(String(NATIVE_BASE_WPM));
    expect(c.spec.args[4]).toBe('--');
    expect(c.spec.args[5]).toBe(buildSayText('hello world', 1.0));
    expect(c.spec.args[5]).toBe('[[volm 1]] hello world');
  });

  it('omits -v when no voice configured', () => {
    const { spawner, last } = makeFakeSpawner();
    const engine = new NativeTtsEngine({
      settings: { ...baseSettings, voiceURI: undefined },
      spawner,
      adapter: macAdapter,
    });
    engine.enqueue('hello');
    const c = last();
    expect(c.spec.args.includes('-v')).toBe(false);
    expect(c.spec.args[0]).toBe('-r');
    expect(c.spec.args[2]).toBe('--');
    expect(c.spec.args[3]).toBe(buildSayText('hello', baseSettings.volume));
  });

  it('per-utterance volume + engine-fallback volume both reach the [[volm]] text', async () => {
    const { spawner, last, spawns } = makeFakeSpawner();
    const engine = new NativeTtsEngine({
      settings: { voiceURI: undefined, rate: 1.0, volume: 0.6 },
      spawner,
      adapter: macAdapter,
    });
    engine.enqueue('quiet', { volume: 0.2 });
    expect(lastArg(last())).toBe('[[volm 0.2]] quiet'); // per-utterance wins
    // Let the first utterance finish normally, then the next (no per-utterance
    // volume) must fall back to the engine settings volume (0.6).
    spawns[0].exit(0);
    await new Promise((r) => setImmediate(r));
    engine.enqueue('medium');
    expect(lastArg(last())).toBe('[[volm 0.6]] medium');
  });
});

// =============================================================================
// SECURITY — untrusted chat text MUST never reach a shell / PowerShell parser.
// =============================================================================
describe('SECURITY: untrusted text handling', () => {
  it('macOS: a shell-metachar-laden message is a plain ARGV slot, shell never used', () => {
    const { spawner, last } = makeFakeSpawner();
    const engine = new NativeTtsEngine({
      settings: { voiceURI: undefined, rate: 1.0, volume: 1.0 },
      spawner,
      adapter: macAdapter,
    });
    // Classic injection attempt — must appear VERBATIM as one argv entry,
    // never split / interpreted. shell:false (the default spawner) guarantees
    // no shell parses it.
    const evil = '$(rm -rf ~); `reboot`; "; echo pwned; #';
    engine.enqueue(evil);
    const c = last();
    // The whole evil string is the LAST argv entry, only prefixed by [[volm]].
    expect(lastArg(c)).toBe(`[[volm 1]] ${evil}`);
    // And it's preceded by the `--` end-of-options guard so even a leading `-`
    // in a message can't be read as a flag.
    expect(c.spec.args[c.spec.args.length - 2]).toBe('--');
    // No env smuggling on the macOS path.
    expect(c.spec.env).toBeUndefined();
  });

  it('Windows: text + voice go via base64 ENV vars, never into the -Command script', () => {
    const winAdapter = detectPlatformAdapter('win32') as PlatformAdapter;
    const { spawner, last } = makeFakeSpawner();
    const engine = new NativeTtsEngine({
      settings: { voiceURI: 'Microsoft Zira Desktop', rate: 1.0, volume: 0.5 },
      spawner,
      adapter: winAdapter,
    });
    const evil = "'; Remove-Item C:\\ -Recurse -Force; Start-Process calc; '";
    engine.enqueue(evil, { voice: 'Microsoft Zira Desktop' });
    const c = last();
    expect(c.spec.command).toBe('powershell');
    // The -Command script is present...
    const cmdIdx = c.spec.args.indexOf('-Command');
    expect(cmdIdx).toBeGreaterThanOrEqual(0);
    const script = c.spec.args[cmdIdx + 1];
    // ...and the evil text appears NOWHERE in it (it's only in the env var).
    expect(script.includes(evil)).toBe(false);
    expect(script.includes('Remove-Item')).toBe(false);
    // The script reads from the env vars + decodes base64.
    expect(script).toContain('$env:RCPP_TTS_TEXT');
    expect(script).toContain('FromBase64String');
    // The env var carries the text as base64 — decoding it round-trips exactly,
    // and base64's [A-Za-z0-9+/=] alphabet can't contain a PS metacharacter.
    expect(c.spec.env?.RCPP_TTS_TEXT).toBe(Buffer.from(evil, 'utf8').toString('base64'));
    expect(/^[A-Za-z0-9+/=]*$/.test(c.spec.env?.RCPP_TTS_TEXT ?? '')).toBe(true);
    // Voice name likewise base64'd into its own env var, not the script.
    expect(c.spec.env?.RCPP_TTS_VOICE).toBe(
      Buffer.from('Microsoft Zira Desktop', 'utf8').toString('base64'),
    );
    expect(script.includes('Microsoft Zira Desktop')).toBe(false);
    // Only NUMBERS are spliced into the script literally (volume/rate) — digits.
    expect(script).toContain('$s.Volume = 50');
    expect(script).toContain('$s.Rate = 0');
  });

  it('Windows: empty voice → RCPP_TTS_VOICE empty (script skips SelectVoice)', () => {
    const winAdapter = detectPlatformAdapter('win32') as PlatformAdapter;
    const { spawner, last } = makeFakeSpawner();
    const engine = new NativeTtsEngine({
      settings: { voiceURI: undefined, rate: 1.0, volume: 1.0 },
      spawner,
      adapter: winAdapter,
    });
    engine.enqueue('hi');
    expect(last().spec.env?.RCPP_TTS_VOICE).toBe('');
  });

  it('Linux spd-say: text is an argv slot after --, with -r/-i numeric flags', () => {
    const { spawner, last } = makeFakeSpawner();
    const engine = new NativeTtsEngine({
      settings: { voiceURI: 'english-us', rate: 1.0, volume: 0.5 },
      spawner,
      adapter: { ...spdAdapterForTest() },
    });
    const evil = '`reboot`; rm -rf /';
    engine.enqueue(evil, { voice: 'english-us' });
    const c = last();
    expect(c.spec.command).toBe('spd-say');
    expect(c.spec.args).toContain('-w');
    // Numeric rate/intensity flags.
    expect(c.spec.args[c.spec.args.indexOf('-r') + 1]).toBe(String(rateToSpdRate(1.0)));
    expect(c.spec.args[c.spec.args.indexOf('-i') + 1]).toBe(String(volumeToSpdIntensity(0.5)));
    // text is the LAST entry, right after `--`, verbatim.
    expect(lastArg(c)).toBe(evil);
    expect(c.spec.args[c.spec.args.length - 2]).toBe('--');
  });
});

// Build a spd-say adapter directly (detectPlatformAdapter needs a which-probe;
// this skips that and gives the test the spd adapter unconditionally).
function spdAdapterForTest(): PlatformAdapter {
  return detectPlatformAdapter('linux', (b) => b === 'spd-say') as PlatformAdapter;
}

describe('NativeTtsEngine — queue / cancel / lifecycle', () => {
  it('queues subsequent enqueues; each starts after the previous exits (FIFO)', async () => {
    const { spawner, spawns } = makeFakeSpawner();
    const engine = new NativeTtsEngine({
      settings: { ...baseSettings, voiceURI: 'Daniel' },
      spawner,
      adapter: macAdapter,
    });
    engine.enqueue('one');
    engine.enqueue('two');
    engine.enqueue('three');
    expect(spawns.length).toBe(1);
    expect(lastArg(spawns[0])).toBe(buildSayText('one', baseSettings.volume));
    spawns[0].exit(0);
    await new Promise((r) => setImmediate(r));
    expect(spawns.length).toBe(2);
    expect(lastArg(spawns[1])).toBe(buildSayText('two', baseSettings.volume));
    spawns[1].exit(0);
    await new Promise((r) => setImmediate(r));
    expect(spawns.length).toBe(3);
    spawns[2].exit(0);
    await new Promise((r) => setImmediate(r));
    expect(spawns.length).toBe(3);
    expect(engine.queueDepth).toBe(0);
    expect(engine.isSpeaking).toBe(false);
  });

  it('cancel() SIGTERMs the running child + clears the queue', async () => {
    const { spawner, spawns } = makeFakeSpawner();
    const engine = new NativeTtsEngine({ settings: baseSettings, spawner, adapter: macAdapter });
    engine.enqueue('one');
    engine.enqueue('two');
    engine.enqueue('three');
    expect(spawns.length).toBe(1);
    expect(engine.queueDepth).toBe(2);
    engine.cancel();
    expect(spawns[0].killed).toBe(true);
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
      adapter: macAdapter,
      log: (event, data) => logs.push({ event, data }),
    });
    engine.enqueue('one', { messageId: 'm1' });
    engine.cancel();
    await new Promise((r) => setImmediate(r));
    const events = logs.map((l) => l.event);
    expect(events).toContain('native_speak_start');
    expect(events).toContain('native_speak_killed');
    expect(events).toContain('native_speak_end');
    expect(logs.find((l) => l.event === 'native_speak_killed')?.data?.reason).toBe('cancel');
  });

  it('drops empty / whitespace-only text without spawning', () => {
    const { spawner, spawns } = makeFakeSpawner();
    const engine = new NativeTtsEngine({ settings: baseSettings, spawner, adapter: macAdapter });
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
      adapter: macAdapter,
    });
    engine.enqueue('one');
    expect(spawns[0].spec.args.includes('Daniel')).toBe(true);
    engine.updateSettings({ voiceURI: 'Alice', rate: 1.5, volume: 1.0 });
    expect(spawns[0].spec.args.includes('Daniel')).toBe(true); // running child unchanged
    engine.enqueue('two');
    expect(spawns.length).toBe(1);
    spawns[0].exit(0);
    await new Promise((r) => setImmediate(r));
    expect(spawns.length).toBe(2);
    expect(spawns[1].spec.args.includes('Alice')).toBe(true);
    expect(spawns[1].spec.args.includes(String(Math.round(NATIVE_BASE_WPM * 1.5)))).toBe(true);
  });

  it('survives spawn() throwing and continues to drain the queue', async () => {
    let throwOnNext = true;
    const spawns: FakeChild[] = [];
    const spawner: NativeSpawner = (spec) => {
      if (throwOnNext) {
        throwOnNext = false;
        throw new Error('boom');
      }
      const emitter = new EventEmitter() as EventEmitter & FakeChild;
      emitter.pid = 999;
      emitter.spec = { command: spec.command, args: spec.args.slice() };
      emitter.killed = false;
      emitter.kill = () => {
        emitter.killed = true;
        return true;
      };
      emitter.exit = (code = 0, signal: NodeJS.Signals | null = null) => emitter.emit('exit', code, signal);
      spawns.push(emitter);
      return emitter;
    };
    const engine = new NativeTtsEngine({ settings: baseSettings, spawner, adapter: macAdapter });
    engine.enqueue('one');
    engine.enqueue('two');
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(spawns.length).toBe(1);
    expect(lastArg(spawns[0])).toBe(buildSayText('two', baseSettings.volume));
  });

  it('preview() cancels prior speech + enqueues a sample at current settings', () => {
    const { spawner, last } = makeFakeSpawner();
    const engine = new NativeTtsEngine({
      settings: { voiceURI: 'Daniel', rate: 1.0, volume: 0.5 },
      spawner,
      adapter: macAdapter,
    });
    const spoken = engine.preview('Daniel');
    expect(spoken).toBe('Hello, my name is Daniel');
    // The sample utterance was spawned, voiced through `say`, at 0.5 volume.
    expect(last().spec.args.includes('Daniel')).toBe(true);
    expect(lastArg(last())).toBe('[[volm 0.5]] Hello, my name is Daniel');
  });

  it('preview(undefined) uses the "system default" phrasing', () => {
    const { spawner, last } = makeFakeSpawner();
    const engine = new NativeTtsEngine({ settings: baseSettings, spawner, adapter: macAdapter });
    const spoken = engine.preview(undefined);
    expect(spoken).toBe('Hello, my name is system default');
    expect(lastArg(last())).toContain('Hello, my name is system default');
  });
});

describe('NativeTtsEngine — no-engine platform (no crash)', () => {
  it('with adapter=null: enqueue no-ops + logs native_no_engine ONCE, never throws', () => {
    const { spawner, spawns } = makeFakeSpawner();
    const logs: Array<{ event: string; data?: Record<string, unknown> }> = [];
    const engine = new NativeTtsEngine({
      settings: baseSettings,
      spawner,
      adapter: null, // simulate a Linux box with no spd-say/espeak
      log: (event, data) => logs.push({ event, data }),
    });
    expect(engine.adapterId).toBeNull();
    expect(() => {
      engine.enqueue('hi');
      engine.enqueue('again');
    }).not.toThrow();
    // Nothing spawned, and the warning logged exactly ONCE (not per message).
    expect(spawns.length).toBe(0);
    expect(logs.filter((l) => l.event === 'native_no_engine')).toHaveLength(1);
  });

  it('with adapter=null: getAvailableVoices resolves to [] (no probe)', async () => {
    const { spawner } = makeFakeSpawner();
    const engine = new NativeTtsEngine({ settings: baseSettings, spawner, adapter: null });
    expect(await engine.getAvailableVoices()).toEqual([]);
  });
});

describe('NativeTtsEngine — voice-list caching via adapter', () => {
  it('getAvailableVoices caches across calls (adapter.listVoices once)', async () => {
    let calls = 0;
    const stub: PlatformAdapter = {
      ...macAdapter,
      listVoices: async (): Promise<NativeVoice[]> => {
        calls += 1;
        return [{ name: 'Daniel', lang: 'en_GB', sample: 'hi' }];
      },
    };
    const { spawner } = makeFakeSpawner();
    const engine = new NativeTtsEngine({ settings: baseSettings, spawner, adapter: stub });
    const a = await engine.getAvailableVoices();
    const b = await engine.getAvailableVoices();
    expect(a).toEqual(b);
    expect(calls).toBe(1);
  });

  it('refreshVoices forces a re-probe', async () => {
    let n = 0;
    const stub: PlatformAdapter = {
      ...macAdapter,
      listVoices: async (): Promise<NativeVoice[]> => {
        n += 1;
        return [{ name: `v${n}`, lang: 'en_US', sample: '' }];
      },
    };
    const { spawner } = makeFakeSpawner();
    const engine = new NativeTtsEngine({ settings: baseSettings, spawner, adapter: stub });
    const a = await engine.getAvailableVoices();
    const b = await engine.refreshVoices();
    expect(a[0].name).toBe('v1');
    expect(b[0].name).toBe('v2');
    expect(n).toBe(2);
  });

  it('getAvailableVoices returns [] when the adapter probe throws', async () => {
    const stub: PlatformAdapter = {
      ...macAdapter,
      listVoices: async (): Promise<NativeVoice[]> => {
        throw new Error('probe blew up');
      },
    };
    const { spawner } = makeFakeSpawner();
    const engine = new NativeTtsEngine({ settings: baseSettings, spawner, adapter: stub });
    expect(await engine.getAvailableVoices()).toEqual([]);
  });
});

describe('ttsToNativeSettings', () => {
  it('extracts voiceURI / rate / volume from the full TTS settings', () => {
    const s = { ...DEFAULT_SETTINGS.tts, voiceURI: 'Daniel', rate: 1.25, volume: 0.7 };
    expect(ttsToNativeSettings(s)).toEqual({ voiceURI: 'Daniel', rate: 1.25, volume: 0.7 });
  });
});
