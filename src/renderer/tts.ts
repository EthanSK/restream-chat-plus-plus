// Renderer-side TTS HELPERS (pure, DOM-free).
//
// v0.1.81 (Ethan 2026-05-31: "lets just use system voice for everything then.
// no more browser one. do it.") — THE BROWSER WEB-SPEECH ENGINE IS GONE.
// ============================================================================
//
// This file USED to contain the renderer-side speech engines:
//   - `TTSEngine` — Chromium `window.speechSynthesis` (the browser voice), with
//     a big pile of Chromium-quirk defences (strong-ref, 60s watchdog,
//     cancel-before-speak, 8s keep-alive, 500ms onstart watchdog, onerror
//     retry, hidden-page native fallback).
//   - `NativeTtsEngine` — a thin IPC wrapper around the main-process `say`
//     engine.
//   - `makeTtsEngine` / `TtsEngineLike` — the factory + polymorphic surface.
//
// ALL of that was DELETED in v0.1.81. Speech now happens exclusively in the
// MAIN process via the cross-platform native OS voice engine
// (src/main/tts-native.ts), driven by the main-process dispatcher
// (src/main/tts-dispatch.ts). The renderer no longer speaks anything — not
// incoming chat (decided + spoken in main), not the Settings voice preview
// (now an IPC call to the main native engine via `rcpp.ttsNative.preview`).
//
// WHY: Chromium throttles/suspends `window.speechSynthesis` whenever the window
// isn't foreground (covered / other Space / minimised / backgrounded / locked)
// and can silently latch even in the foreground on Electron 42 — `speak()`
// fired but no audio came out, so Ethan heard nothing. An OS-level subprocess
// is immune to that, so we use the system voice on every platform.
//
// What REMAINS here are small PURE helpers with no DOM dependency that other
// modules + tests still import:
//   - `composeUtterance` — build the spoken string from a message.
//   - `RateLimiter`      — token-bucket math (unit-tested in isolation).
//   - `voiceQualityRank` / `sortVoicesByQuality` — order a voice list so the
//     better-quality voices float to the top of the Settings dropdown. These
//     only read `.name`, so they work on both the old Web-Speech voice shape
//     AND the native voice shape (`NativeVoiceWire`).

import type { ChatMessage } from '../shared/types';

/**
 * Build the string the synthesizer should speak for a given chat message.
 * DOM-free so the name-toggle behaviour is unit-testable.
 *
 * - readSenderName=true  → "alice says hello world"
 * - readSenderName=false → "hello world" (default)
 */
export function composeUtterance(m: ChatMessage, readSenderName: boolean): string {
  if (readSenderName) return `${m.username} says ${m.text}`;
  return m.text;
}

/**
 * Quality "tier" for a voice (lower = better, sorts to the top). We can't read
 * a quality flag from the OS voice list, so we infer from the voice NAME.
 * macOS/Windows label modern voices "Premium"/"Enhanced"/"Neural"/"Natural";
 * the older robotic novelty voices ship unadorned. Sort by:
 *   0 — Premium / Enhanced
 *   1 — Neural / Natural
 *   2 — Siri / flagship system voices
 *   3 — Eloquence variants
 *   4 — Everything else (bottom)
 *
 * Takes anything with a `name` so it works on both Web-Speech voices and the
 * native `NativeVoiceWire` shape.
 */
export function voiceQualityRank(v: { name: string }): number {
  const name = v.name.toLowerCase();
  if (name.includes('premium') || name.includes('enhanced')) return 0;
  if (name.includes('neural') || name.includes('natural')) return 1;
  if (name.includes('siri')) return 2;
  if (name.includes('eloquence')) return 3;
  return 4;
}

/** Pure helper: return a new array of voices sorted quality-first, then name. */
export function sortVoicesByQuality<V extends { name: string }>(voices: readonly V[]): V[] {
  return [...voices].sort((a, b) => {
    const r = voiceQualityRank(a) - voiceQualityRank(b);
    if (r !== 0) return r;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Token-bucket rate limiter. Kept here (DOM-free) because rate-limit.test.ts
 * imports it directly. The LIVE rate-limiting for chat TTS now lives in the
 * main-process dispatcher (`MainRateLimiter` in src/main/tts-dispatch.ts) — this
 * class is retained for the unit test + as the canonical math reference.
 */
export class RateLimiter {
  private timestamps: number[] = [];
  constructor(private maxPerMinute: number, private now: () => number = Date.now) {}
  tryConsume(): boolean {
    this.prune();
    if (this.timestamps.length >= this.maxPerMinute) return false;
    this.timestamps.push(this.now());
    return true;
  }
  private prune() {
    const cutoff = this.now() - 60_000;
    while (this.timestamps.length > 0 && this.timestamps[0] < cutoff) {
      this.timestamps.shift();
    }
  }
}
