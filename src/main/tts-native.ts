// v0.1.42 — Native macOS `say`-backed TTS engine for the main process.
//
// Why this exists
// ----------------
// Through v0.1.41 the renderer used Chromium's `window.speechSynthesis` for
// TTS. That API on Electron 42 macOS is flaky in well-documented ways:
// dormant-engine swallows, GC-collected utterances dropping onend events,
// silent latching after idle cancel() calls, etc. v0.1.40 + v0.1.41 layered
// defensive scaffolding (strong-ref, 60s watchdog, cancel-before-speak,
// 8s keep-alive, 500ms onstart watchdog, onerror retry, JSONL disk log) on
// top of the Web Speech engine but never actually solved the underlying
// fragility — we were fighting browser bugs.
//
// The macOS OS-level `say(1)` CLI does exactly what we want, reliably:
// spawn a subprocess, hand it text + voice + rate, the user hears audio,
// the process exits. No internal state machine to wedge. No GC. No
// "engine went dormant". The only state we own is a small FIFO queue.
//
// This module replaces the browser speech engine for chat playback when
// `settings.tts.engine === 'native'` (the new default on macOS). The
// browser engine stays in place behind the toggle so a future Linux /
// Windows build can keep working.
//
// Design
// ------
//   - Singleton `NativeTtsEngine` instance per main process.
//   - `enqueue(text, opts)` pushes onto an internal queue; if nothing's
//     speaking we kick off `say` immediately. If a subprocess is already
//     running, we wait for its exit before popping the next one.
//   - `cancel()` SIGTERMs the running subprocess + clears the queue. The
//     SIGTERM handler on the subprocess still resolves the in-flight
//     queue advance so the runloop unblocks; we just don't pop another
//     entry after.
//   - `updateSettings(s)` updates voice/rate/volume the NEXT utterance
//     will use. We don't mutate the running utterance — `say` doesn't
//     expose live-update knobs, and chat messages are short enough that
//     waiting for the current one to finish is fine.
//   - `getAvailableVoices()` shells out `say -v "?"` once per process,
//     caches the parsed result. The output is one voice per line:
//       Daniel              en_GB    # Hello! My name is Daniel.
//     Some voice names contain spaces and qualifiers ("Eddy (English
//     (UK))"), so we parse by character class boundaries — the `lang`
//     locale (e.g. `en_GB` / `en_US`) is the reliable column separator.
//
// Volume
// ------
// `say` has no `--volume` flag. Two routes considered:
//   (a) Pipe `say --data-format=…` raw audio to `afplay` with a volume
//       knob. Reliable but adds a second subprocess + audio buffering.
//   (b) Accept that per-utterance volume is unsupported and document it.
//       Users adjust the macOS system output volume (or the dedicated
//       app volume in System Settings → Sound → app mixer) instead.
//
// Shipping with (b) for v0.1.42. Lower latency, less surface area,
// matches what nearly every other macOS app does — system volume is the
// right place for "how loud is RC++". The Settings UI keeps the slider
// visible but it only applies to the browser-engine code path; we add a
// note in the tooltip so users don't think it's broken.
//
// Logging
// -------
// Every spawn / exit / kill / queue mutation lands in
// `~/Library/Logs/Restream Chat Plus Plus/tts-events.jsonl` via the same
// `appendTtsLog` path the renderer side uses (forwarded through
// `IPC.TTS_LOG`). Events:
//   - `native_speak_start`   { message_id?, voice?, rateWPM, queue_size }
//   - `native_speak_end`     { message_id?, exitCode, durationMs }
//   - `native_speak_error`   { message_id?, error }
//   - `native_speak_killed`  { message_id?, reason }
//   - `native_queue_size`    { queue_size }
//
// Rate mapping
// ------------
// Web Speech rate is unitless (1.0 = "normal"). `say -r` is words-per-
// minute (default ~175 on most macOS voices, premium voices vary). We
// map by multiplying: `wpm = round(180 * rate)`. Clamped to [80, 720]
// to avoid `say` rejecting absurd values. Test coverage pins the math.

import * as nodeProc from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { Settings, TtsLogEvent } from '../shared/types';

/**
 * Words-per-minute that maps to a Web-Speech `rate` of 1.0. macOS `say`'s
 * built-in default is ~175 for most legacy voices and ~200 for the newer
 * premium ones — 180 is a sensible middle ground. The chosen constant is
 * pinned by `tts-native.test.ts` so a future tweak is visible.
 */
export const NATIVE_BASE_WPM = 180;

/** Clamp range for `say -r`. Outside this `say` either rejects or sounds broken. */
export const NATIVE_MIN_WPM = 80;
export const NATIVE_MAX_WPM = 720;

/** Map a Web Speech `rate` (unitless, 0.5–2.0 typical) → `say` WPM. */
export function rateToWpm(rate: number): number {
  if (!Number.isFinite(rate) || rate <= 0) return NATIVE_BASE_WPM;
  const wpm = Math.round(NATIVE_BASE_WPM * rate);
  if (wpm < NATIVE_MIN_WPM) return NATIVE_MIN_WPM;
  if (wpm > NATIVE_MAX_WPM) return NATIVE_MAX_WPM;
  return wpm;
}

/**
 * Parsed entry from `say -v "?"`. The `sample` is the demo phrase the
 * voice ships with (e.g. "Hello! My name is Daniel.") — useful as a
 * preview-button accent if we ever wire one. `lang` is the locale
 * identifier (`en_GB`, `fr_CA`, etc.) — the `_` separator is what `say`
 * uses on macOS; the Web Speech API uses `-` (e.g. `en-GB`). We keep the
 * raw `say` form here.
 */
export interface NativeVoice {
  /** Display name including any qualifier — e.g. `Daniel`, `Eddy (English (UK))`. */
  name: string;
  /** Locale identifier in `say` form, e.g. `en_GB`, `fr_FR`. */
  lang: string;
  /** Demo phrase shipped by macOS for this voice. May be empty. */
  sample: string;
}

/**
 * Per-utterance enqueue options. `messageId` is propagated into the JSONL
 * log so we can correlate a queue entry through to its `say` exit, which
 * mirrors what the v0.1.41 renderer-side log already does.
 *
 * `voice` is optional — falls through to whatever the engine's current
 * settings say. `rate` is the Web-Speech-style unitless rate, the same
 * value the Settings slider produces.
 */
export interface NativeEnqueueOpts {
  voice?: string;
  rate?: number;
  /** Per-Web-Speech volume — currently informational only; see module-top comment. */
  volume?: number;
  messageId?: string;
}

/**
 * Subset of Settings.tts the native engine actually cares about. Pulled
 * out so the caller can update only the relevant fields without having
 * to re-construct the engine.
 */
export interface NativeTtsSettings {
  voiceURI?: string;
  rate: number;
  volume: number;
}

/**
 * Hook the engine uses to persist lifecycle events. Wired to the same
 * `appendTtsLog` helper in main.ts that the renderer-side log uses, so
 * native + browser engine events land in one file in event-time order.
 * Best-effort — a logging failure must never break playback.
 */
export type NativeTtsLogger = (
  event: TtsLogEvent['event'] | NativeTtsEventName,
  data?: Record<string, unknown>,
) => void;

export type NativeTtsEventName =
  | 'native_speak_start'
  | 'native_speak_end'
  | 'native_speak_error'
  | 'native_speak_killed'
  | 'native_queue_size';

/**
 * Spawner abstraction so unit tests can substitute a fake `say` without
 * touching the real subprocess. Production code calls
 * `spawn('say', args)`; tests pass a stub that returns a synthetic
 * child-process-shaped object.
 *
 * The shape mirrors only the bits we actually use from the real Node
 * child_process type — `kill`, `on('exit')`, `on('error')`, the `pid`.
 */
export interface NativeSpawnedChild extends EventEmitter {
  pid?: number | undefined;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export type NativeSpawner = (args: string[]) => NativeSpawnedChild;

const defaultSpawner: NativeSpawner = (args) =>
  nodeProc.spawn('say', args, { stdio: ['ignore', 'ignore', 'pipe'] }) as unknown as NativeSpawnedChild;

interface QueueEntry {
  text: string;
  opts: NativeEnqueueOpts;
}

export interface NativeTtsEngineOptions {
  /** Initial Settings.tts subset. Required so the first enqueue has a defined voice/rate. */
  settings: NativeTtsSettings;
  /** Log sink. Wired to `appendTtsLog` in production; left undefined in tests. */
  log?: NativeTtsLogger;
  /** Override spawn for unit tests. */
  spawner?: NativeSpawner;
  /** Override the voice-list spawner (also `say -v ?`). Tests can stub. */
  voiceListProbe?: () => Promise<NativeVoice[]>;
}

export class NativeTtsEngine {
  private queue: QueueEntry[] = [];
  private current: NativeSpawnedChild | null = null;
  private settings: NativeTtsSettings;
  private readonly log: NativeTtsLogger;
  private readonly spawner: NativeSpawner;
  private readonly voiceListProbe: () => Promise<NativeVoice[]>;
  /** Cached `say -v "?"` parse. First call populates; subsequent calls hit cache. */
  private voicesCache: NativeVoice[] | undefined;
  /**
   * Set to `true` while a `cancel()` is in flight so the exit handler
   * for the killed subprocess doesn't pop the next queue entry. Cleared
   * on the next enqueue / explicit drain.
   */
  private cancelling = false;
  /** Monotonic counter used to tag log entries when no messageId is supplied. */
  private speakSeq = 0;

  constructor(opts: NativeTtsEngineOptions) {
    this.settings = opts.settings;
    this.log = opts.log ?? (() => undefined);
    this.spawner = opts.spawner ?? defaultSpawner;
    this.voiceListProbe = opts.voiceListProbe ?? defaultVoiceListProbe;
  }

  /**
   * Push text onto the queue. If nothing is speaking we kick off `say`
   * immediately; otherwise the FIFO drain handler does it when the
   * current `say` exits.
   *
   * Empty / whitespace-only text is dropped silently — `say` accepts it
   * but produces no audio and just wastes a fork.
   */
  enqueue(text: string, opts: NativeEnqueueOpts = {}): void {
    if (typeof text !== 'string') return;
    const trimmed = text.trim();
    if (!trimmed) return;
    this.queue.push({ text, opts });
    this.log('native_queue_size', { queue_size: this.queue.length });
    if (!this.current) {
      this.drain();
    }
  }

  /**
   * Update settings used for future utterances. Does NOT mutate the
   * currently-running `say` subprocess — that one finishes with whatever
   * it was launched with. Chat messages are short so the latency cost of
   * waiting for the current utterance is negligible.
   */
  updateSettings(settings: NativeTtsSettings): void {
    this.settings = settings;
  }

  /**
   * SIGTERM the current `say` subprocess + clear the queue. Idempotent.
   * Safe to call on a quiescent engine.
   */
  cancel(): void {
    const cleared = this.queue.length;
    this.queue = [];
    if (this.current) {
      this.cancelling = true;
      const pid = this.current.pid;
      try {
        this.current.kill('SIGTERM');
      } catch (err) {
        this.log('native_speak_error', {
          stage: 'kill',
          error: String((err as Error)?.message ?? err),
        });
      }
      this.log('native_speak_killed', { pid, reason: 'cancel' });
    }
    if (cleared > 0) {
      this.log('native_queue_size', { queue_size: 0, cleared });
    }
  }

  /**
   * Return the cached `say -v "?"` voice list, populating the cache on
   * first call. The list does not change at runtime (macOS would need a
   * re-login to install new voices); a session-lifetime cache is fine.
   */
  async getAvailableVoices(): Promise<NativeVoice[]> {
    if (this.voicesCache) return this.voicesCache;
    try {
      const list = await this.voiceListProbe();
      this.voicesCache = list;
      return list;
    } catch (err) {
      this.log('native_speak_error', {
        stage: 'voice_list',
        error: String((err as Error)?.message ?? err),
      });
      return [];
    }
  }

  /** Force a re-probe of `say -v "?"` (e.g. after the user installs a new voice). */
  async refreshVoices(): Promise<NativeVoice[]> {
    this.voicesCache = undefined;
    return this.getAvailableVoices();
  }

  /** Inspect-only: current queue depth. Used by tests + diagnostics. */
  get queueDepth(): number {
    return this.queue.length;
  }

  /** Inspect-only: is a `say` subprocess currently running. */
  get isSpeaking(): boolean {
    return this.current !== null;
  }

  // ------------------------------------------------------------- internals

  private drain(): void {
    if (this.current) return;
    const next = this.queue.shift();
    if (!next) return;
    this.cancelling = false;
    const messageId = next.opts.messageId;
    const voice = next.opts.voice ?? this.settings.voiceURI;
    const rate = next.opts.rate ?? this.settings.rate;
    const wpm = rateToWpm(rate);
    const args: string[] = [];
    if (voice) {
      args.push('-v', voice);
    }
    args.push('-r', String(wpm));
    args.push('--', next.text);
    const seq = ++this.speakSeq;
    const startedAt = Date.now();
    this.log('native_speak_start', {
      message_id: messageId,
      seq,
      voice: voice ?? null,
      rateWPM: wpm,
      queue_size: this.queue.length,
    });
    let subproc: NativeSpawnedChild;
    try {
      subproc = this.spawner(args);
    } catch (err) {
      this.log('native_speak_error', {
        message_id: messageId,
        seq,
        stage: 'spawn',
        error: String((err as Error)?.message ?? err),
      });
      // Pop next entry; never let a single bad spawn wedge the queue.
      this.current = null;
      setImmediate(() => this.drain());
      return;
    }
    this.current = subproc;
    let settled = false;
    const settle = (event: 'exit' | 'error', payload: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      this.current = null;
      if (event === 'exit') {
        this.log('native_speak_end', {
          message_id: messageId,
          seq,
          durationMs: Date.now() - startedAt,
          ...payload,
        });
      } else {
        this.log('native_speak_error', {
          message_id: messageId,
          seq,
          stage: 'subproc',
          ...payload,
        });
      }
      // If a cancel() raced this exit, don't pop the next entry — the
      // queue has already been cleared and the user explicitly asked us
      // to stop. The flag resets on the next enqueue.
      if (this.cancelling) {
        this.cancelling = false;
        return;
      }
      // Schedule next drain on next tick so we don't grow the stack on
      // a deep queue.
      setImmediate(() => this.drain());
    };
    subproc.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      settle('exit', {
        exitCode: code,
        signal,
        // SIGTERM from cancel() arrives here too; flag it for log clarity.
        killed: signal === 'SIGTERM' || this.cancelling,
      });
    });
    subproc.on('error', (err: Error) => {
      settle('error', { error: String(err?.message ?? err) });
    });
  }
}

/**
 * Production voice-list probe. Spawns `say -v "?"`, parses each line.
 * The output column layout is fixed-width-ish but voice names can
 * contain spaces and parenthesised qualifiers — we split by recognising
 * the locale token (e.g. `en_US`, `fr_CA`, `zh-CN`) which is the only
 * column with consistent shape. The `#` after the locale is the start
 * of the demo phrase.
 *
 * Example lines:
 *   Daniel              en_GB    # Hello! My name is Daniel.
 *   Eddy (English (UK)) en_GB    # Hello! My name is Eddy.
 *   Reed (English (US)) en_US    # Hello! My name is Reed.
 */
async function defaultVoiceListProbe(): Promise<NativeVoice[]> {
  return new Promise((resolve, reject) => {
    const subproc = nodeProc.spawn('say', ['-v', '?'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    subproc.stdout?.on('data', (b) => {
      stdout += b.toString('utf8');
    });
    subproc.stderr?.on('data', (b) => {
      stderr += b.toString('utf8');
    });
    subproc.on('error', (err) => reject(err));
    subproc.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`say -v "?" exited ${code}: ${stderr.trim()}`));
        return;
      }
      try {
        resolve(parseSayVoiceList(stdout));
      } catch (err) {
        reject(err);
      }
    });
  });
}

/**
 * Pure parser for `say -v "?"` output. Exported for unit testing without
 * spawning anything. Lines that don't match the expected shape are
 * silently dropped — `say` occasionally emits stray header/footer lines
 * on certain macOS builds we don't want to choke on.
 */
export function parseSayVoiceList(stdout: string): NativeVoice[] {
  const out: NativeVoice[] = [];
  const lines = stdout.split(/\r?\n/);
  // Locale token is the column we anchor on. macOS uses `_` separators
  // (e.g. `en_GB`); a small number of voices use plain ISO codes
  // (`zh-CN`, `pt-BR` on older macOS) — accept both.
  const localeRe = /\s([a-z]{2,3}[_-][A-Z]{2,4})\s/;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/u, '');
    if (!line.trim()) continue;
    const localeMatch = localeRe.exec(line);
    if (!localeMatch) continue;
    const localeIdx = localeMatch.index;
    const name = line.slice(0, localeIdx).trim();
    if (!name) continue;
    const lang = localeMatch[1];
    const afterLocale = line.slice(localeIdx + localeMatch[0].length);
    // The remainder starts with "# <sample>" — strip the `#` and any
    // leading whitespace. If the `#` is missing (some macOS builds
    // truncate it), keep whatever's left as-is.
    const sample = afterLocale.replace(/^\s*#\s?/, '').trim();
    out.push({ name, lang, sample });
  }
  return out;
}

/**
 * Helper for unit-testing the integration with the renderer-side
 * Settings shape. Given a full `Settings['tts']` object, extract the
 * subset the native engine consumes.
 */
export function ttsToNativeSettings(tts: Settings['tts']): NativeTtsSettings {
  return {
    voiceURI: tts.voiceURI,
    rate: tts.rate,
    volume: tts.volume,
  };
}
