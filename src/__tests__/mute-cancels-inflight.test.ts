// v0.1.82 regression guard — MUTE / DISABLE must stop in-flight + queued TTS.
//
// THE BUG: through v0.1.81 the header 🔇 mute (and the Settings "Enabled" off
// toggle) only flipped `settings.tts.muted` / `settings.tts.enabled` and
// round-tripped settings. The decideTtsAction `muted`/`engine-disabled` gates
// run only when a NEW message arrives, so the utterance ALREADY playing kept
// going and every ALREADY-queued message still spoke. Mute felt broken.
//
// THE FIX has two halves, each guarded here:
//   (a) PURE LOGIC — `shouldCancelNativeTtsOnSettingsChange` returns true only
//       on a transition INTO silence (mute false→true, enabled true→false) and
//       false on the reverse / unrelated edits (so un-mute never replays the
//       backlog). Fully unit-tested in side-effect-decision.test.ts.
//   (b) WIRING — App.tsx's `updateSettings` snapshots the previous tts flags,
//       and when (a) returns true it calls `rcpp.ttsNative.cancel()`, which
//       SIGTERMs the speaking child AND flushes the queue (see
//       NativeTtsEngine.cancel + the cancel/queue tests in tts-native.test.ts).
//
// This file is the SOURCE-LEVEL guard for half (b): the renderer tests run
// under vitest `environment: 'node'` with no jsdom/testing-library (matches the
// repo convention — see settings-slider-preview.test.ts), so we assert the
// wiring is present in App.tsx's source rather than rendering the component.
// Combined with the pure-logic + engine tests, this fully covers "muting while
// speaking calls cancel; muting clears the queue".

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('App.tsx — mute/disable cancels in-flight + queued native TTS (v0.1.82)', () => {
  const appPath = path.join(__dirname, '..', 'renderer', 'App.tsx');
  const src = fs.readFileSync(appPath, 'utf8');

  // Strip comments so the assertions match REAL code, not the (extensive)
  // explanatory comment blocks that also mention these identifiers.
  const code = src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '') // JSX block comments
    .replace(/\/\*[\s\S]*?\*\//g, '') // C-style block comments
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, '')) // // line comments
    .join('\n');

  it('imports the shared shouldCancelNativeTtsOnSettingsChange predicate', () => {
    expect(code).toMatch(/import\s*\{\s*shouldCancelNativeTtsOnSettingsChange\s*\}/);
  });

  it('updateSettings snapshots the previous tts flags before setSettings flips state', () => {
    // The snapshot MUST be taken from the closure `settings` (old value) BEFORE
    // setSettings(next) runs, otherwise the transition can't be detected.
    const updIdx = code.indexOf('const updateSettings');
    expect(updIdx).toBeGreaterThanOrEqual(0);
    const body = code.slice(updIdx, updIdx + 1600);
    const snapIdx = body.indexOf('settings.tts'); // const prevTts = settings.tts
    const setIdx = body.indexOf('setSettings(next)');
    expect(snapIdx).toBeGreaterThanOrEqual(0);
    expect(setIdx).toBeGreaterThanOrEqual(0);
    expect(snapIdx).toBeLessThan(setIdx); // snapshot precedes the state flip
  });

  it('calls rcpp.ttsNative.cancel() when the change is a silence-now transition', () => {
    const updIdx = code.indexOf('const updateSettings');
    const body = code.slice(updIdx, updIdx + 1600);
    // The cancel must be GATED by the predicate (not fired on every change).
    expect(body).toMatch(/shouldCancelNativeTtsOnSettingsChange\(\s*prevTts\s*,\s*next\.tts\s*\)/);
    const guardIdx = body.indexOf('shouldCancelNativeTtsOnSettingsChange');
    const cancelIdx = body.indexOf('ttsNative?.cancel?.()');
    expect(guardIdx).toBeGreaterThanOrEqual(0);
    expect(cancelIdx).toBeGreaterThanOrEqual(0);
    // cancel() appears AFTER (inside) the predicate guard.
    expect(cancelIdx).toBeGreaterThan(guardIdx);
  });

  it('header mute button (toggleMuted) routes through updateSettings (single chokepoint)', () => {
    // toggleMuted must NOT call cancel directly — it flips muted and delegates
    // to updateSettings, which owns the cancel decision. This keeps the header
    // button, the Settings "Muted" row, AND the "Enabled" row all funnelling
    // through ONE place, so the cancel logic can't drift per entry point.
    const tmIdx = code.indexOf('const toggleMuted');
    expect(tmIdx).toBeGreaterThanOrEqual(0);
    const body = code.slice(tmIdx, tmIdx + 300);
    expect(body).toMatch(/updateSettings\(/);
    expect(body).not.toMatch(/cancel/); // no direct cancel in the toggle
  });
});
