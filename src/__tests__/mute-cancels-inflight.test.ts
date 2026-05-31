// v0.1.82 → v0.1.84 regression guard — MUTE / DISABLE must stop in-flight +
// queued native TTS, and the cancel must be ATOMIC with the settings write in
// the MAIN process (covering EVERY entry point, including MCP).
//
// THE ORIGINAL BUG (v0.1.81): the header 🔇 mute (and the Settings "Enabled"
// off toggle) only flipped `settings.tts.muted` / `settings.tts.enabled` and
// round-tripped settings. The decideTtsAction `muted`/`engine-disabled` gates
// run only when a NEW message arrives, so the utterance ALREADY playing kept
// going and every ALREADY-queued message still spoke. Mute felt broken.
//
// THE v0.1.82 FIX added a cancel — but in the RENDERER (App.tsx updateSettings),
// which fired `rcpp.ttsNative.cancel()` and THEN `rcpp.setSettings(next)` as TWO
// separate IPCs. Codex review surfaced two gaps in that placement:
//   (a) RENDERER RACE — a chat message arriving in main BETWEEN the two IPCs read
//       the still-unmuted settings, enqueued, and the v0.1.82 drain spoke it
//       AFTER mute.
//   (b) MCP BYPASS — `set_tts_enabled(false)` over MCP went through the main
//       `saveSettings` path, which only called `updateSettings()` (future-
//       utterance config) and NEVER cancelled. So disabling TTS over MCP left
//       the current utterance + backlog playing.
//
// THE v0.1.84 FIX moves the cancel into the MAIN `saveSettings` path so it is
// atomic with the persist and covers renderer toggle + header mute + MCP. This
// file guards both the WIRING (source-level) and the underlying ENGINE behaviour
// (behavioural, via the shared predicate + a fake-spawner NativeTtsEngine).
//   - Pure-logic guard for the predicate → side-effect-decision.test.ts.
//   - Engine cancel (SIGTERM + queue flush) → tts-native.test.ts.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  NativeTtsEngine,
  detectPlatformAdapter,
  ttsToNativeSettings,
  type NativeSpawner,
  type PlatformAdapter,
} from '../main/tts-native';
import { shouldCancelNativeTtsOnSettingsChange } from '../shared/side-effect-decision';
import { DEFAULT_SETTINGS, type Settings } from '../shared/types';

// ---------------------------------------------------------------------------
// Behavioural — the EXACT decision + action `saveSettings` performs in main:
// "if shouldCancelNativeTtsOnSettingsChange(prevTts, nextTts) → nativeTts.cancel()".
// We reconstruct that one-liner against a real NativeTtsEngine driven by a fake
// spawner so we prove the contract end-to-end without booting Electron.
// ---------------------------------------------------------------------------

interface FakeChild extends EventEmitter {
  pid?: number;
  killed: boolean;
  kill(signal?: NodeJS.Signals | number): boolean;
}

function makeFakeSpawner(): { spawner: NativeSpawner; spawns: FakeChild[] } {
  const spawns: FakeChild[] = [];
  let pid = 7000;
  const spawner: NativeSpawner = (spec) => {
    const e = new EventEmitter() as EventEmitter & FakeChild;
    e.pid = ++pid;
    e.killed = false;
    e.kill = () => {
      e.killed = true;
      setImmediate(() => e.emit('exit', null, 'SIGTERM'));
      return true;
    };
    // capture command for assertions (spd-say --cancel vs say)
    (e as unknown as { spec: typeof spec }).spec = spec;
    spawns.push(e);
    return e;
  };
  return { spawner, spawns };
}

const macAdapter = detectPlatformAdapter('darwin') as PlatformAdapter;
const baseNative = ttsToNativeSettings(DEFAULT_SETTINGS.tts);

// Helper mirroring main's saveSettings cancel-on-silence one-liner.
function applySettingsLikeMain(
  engine: NativeTtsEngine,
  prev: Settings,
  next: Settings,
): void {
  if (shouldCancelNativeTtsOnSettingsChange(prev.tts, next.tts)) engine.cancel();
  engine.updateSettings(ttsToNativeSettings(next.tts));
}

function settingsWith(tts: Partial<Settings['tts']>): Settings {
  return { ...DEFAULT_SETTINGS, tts: { ...DEFAULT_SETTINGS.tts, ...tts } };
}

describe('main saveSettings cancel-on-silence (v0.1.84) — engine behaviour', () => {
  it('muting (muted false→true) cancels the speaking child + clears the queue', async () => {
    const { spawner, spawns } = makeFakeSpawner();
    const engine = new NativeTtsEngine({ settings: baseNative, spawner, adapter: macAdapter });
    engine.enqueue('one');
    engine.enqueue('two'); // queued behind `one`
    expect(spawns.length).toBe(1);
    expect(engine.queueDepth).toBe(1);

    applySettingsLikeMain(engine, settingsWith({ muted: false }), settingsWith({ muted: true }));

    expect(spawns[0].killed).toBe(true); // in-flight SIGTERMed
    await new Promise((r) => setImmediate(r));
    expect(engine.queueDepth).toBe(0); // backlog dropped
    expect(engine.isSpeaking).toBe(false);
  });

  it('disabling (enabled true→false) — the MCP set_tts_enabled path — cancels too', async () => {
    const { spawner, spawns } = makeFakeSpawner();
    const engine = new NativeTtsEngine({ settings: baseNative, spawner, adapter: macAdapter });
    engine.enqueue('one');
    expect(spawns.length).toBe(1);

    applySettingsLikeMain(
      engine,
      settingsWith({ enabled: true }),
      settingsWith({ enabled: false }),
    );

    expect(spawns[0].killed).toBe(true);
    await new Promise((r) => setImmediate(r));
    expect(engine.queueDepth).toBe(0);
  });

  it('un-muting / re-enabling does NOT cancel (no backlog replay)', async () => {
    const { spawner, spawns } = makeFakeSpawner();
    const engine = new NativeTtsEngine({ settings: baseNative, spawner, adapter: macAdapter });
    engine.enqueue('one');
    expect(spawns.length).toBe(1);

    // muted true→false
    applySettingsLikeMain(engine, settingsWith({ muted: true }), settingsWith({ muted: false }));
    expect(spawns[0].killed).toBe(false);
    // enabled false→true
    applySettingsLikeMain(
      engine,
      settingsWith({ enabled: false }),
      settingsWith({ enabled: true }),
    );
    expect(spawns[0].killed).toBe(false);
    // unrelated edit (rate change) does not cancel
    applySettingsLikeMain(engine, settingsWith({ rate: 1.0 }), settingsWith({ rate: 1.5 }));
    expect(spawns[0].killed).toBe(false);
  });

  it('no double-cancel: a single silence transition kills the child exactly once', async () => {
    const { spawner, spawns } = makeFakeSpawner();
    let killCount = 0;
    const engine = new NativeTtsEngine({ settings: baseNative, spawner, adapter: macAdapter });
    engine.enqueue('one');
    const child = spawns[0];
    const origKill = child.kill.bind(child);
    child.kill = (sig?: NodeJS.Signals | number) => {
      killCount += 1;
      return origKill(sig);
    };
    applySettingsLikeMain(engine, settingsWith({ muted: false }), settingsWith({ muted: true }));
    await new Promise((r) => setImmediate(r));
    expect(killCount).toBe(1); // exactly one cancel — renderer no longer double-fires
  });
});

// ---------------------------------------------------------------------------
// Source-level wiring guards — main.ts saveSettings owns the cancel; App.tsx no
// longer does. (main.ts is awkward to exercise behaviourally because saveSettings
// is a closure inside the whenReady bootstrap, so we pin the source like the
// repo's other main-side guards.)
// ---------------------------------------------------------------------------

function stripComments(src: string): string {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');
}

describe('wiring — cancel-on-silence lives in MAIN saveSettings, not the renderer', () => {
  const mainPath = path.join(__dirname, '..', 'main', 'main.ts');
  const appPath = path.join(__dirname, '..', 'renderer', 'App.tsx');
  const mainCode = stripComments(fs.readFileSync(mainPath, 'utf8'));
  const appCode = stripComments(fs.readFileSync(appPath, 'utf8'));

  it('main.ts imports the shared shouldCancelNativeTtsOnSettingsChange predicate', () => {
    expect(mainCode).toMatch(/import\s*\{\s*shouldCancelNativeTtsOnSettingsChange\s*\}/);
  });

  it('saveSettings snapshots prev tts, gates on the predicate, and calls nativeTts.cancel()', () => {
    const idx = mainCode.indexOf('function saveSettings');
    expect(idx).toBeGreaterThanOrEqual(0);
    const body = mainCode.slice(idx, idx + 1800);
    // snapshot of the previous persisted settings BEFORE store.set overwrites it
    const snapIdx = body.search(/store\.get\('settings'\)/);
    const setIdx = body.indexOf("store.set('settings'");
    expect(snapIdx).toBeGreaterThanOrEqual(0);
    expect(setIdx).toBeGreaterThanOrEqual(0);
    expect(snapIdx).toBeLessThan(setIdx); // read prev BEFORE write
    // predicate-gated cancel
    const guardIdx = body.indexOf('shouldCancelNativeTtsOnSettingsChange');
    const cancelIdx = body.indexOf('nativeTts.cancel()');
    expect(guardIdx).toBeGreaterThanOrEqual(0);
    expect(cancelIdx).toBeGreaterThan(guardIdx); // cancel inside the guard
  });

  it('App.tsx updateSettings no longer imports the predicate or calls ttsNative.cancel()', () => {
    // The single source of truth is main; the renderer must not re-cancel (that
    // was the two-IPC race). It still triggers the main write via setSettings.
    expect(appCode).not.toMatch(/shouldCancelNativeTtsOnSettingsChange/);
    const idx = appCode.indexOf('const updateSettings');
    expect(idx).toBeGreaterThanOrEqual(0);
    const body = appCode.slice(idx, idx + 1600);
    expect(body).not.toMatch(/ttsNative\?\.cancel/);
    expect(body).toMatch(/rcpp\.setSettings\(next\)/); // still persists via main
  });
});
