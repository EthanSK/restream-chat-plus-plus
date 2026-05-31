// CROSS-PLATFORM NATIVE OS TTS ENGINE (main process).
//
// v0.1.81 (Ethan 2026-05-31: "lets just use system voice for everything then.
// no more browser one. do it.") — THIS ENGINE NOW SPEAKS ON EVERY PLATFORM.
// ============================================================================
//
// WHY THE BROWSER (Web-Speech) ENGINE WAS REMOVED
// ------------------------------------------------
// Through v0.1.80 incoming chat was spoken via Chromium's renderer
// `window.speechSynthesis` on win/linux (and, briefly, macOS). Chromium
// THROTTLES / SUSPENDS the renderer speech engine whenever the window isn't
// foreground (covered by another window, on another Space/desktop, minimised,
// app backgrounded, screen-locked) and on Electron 42 it can silently latch
// even in the foreground — `speak()` fires but NO AUDIO comes out. Ethan kept
// hearing nothing. The decision (final) was: drop the renderer engine entirely
// and use the OS-level system voice on ALL platforms. An OS subprocess is
// immune to Chromium renderer throttling, so it always plays regardless of
// window state. This module is that engine.
//
// HISTORY: v0.1.42 introduced this as a macOS-only `say` engine behind a
// toggle; v0.1.76 made it the genuinely-hidden fallback (+ volume via
// `[[volm]]`); v0.1.80 made macOS always-native. v0.1.81 generalises it to
// Windows + Linux and makes it THE one and only speech path everywhere.
//
// PER-PLATFORM BACKENDS (see PlatformAdapter below for the exact commands):
//   - macOS  (darwin): `say` CLI.
//       speak: `say -v <voice> -r <wpm> -- "[[volm n]] <text>"`
//       voices: `say -v "?"`  (one per line; locale is the column anchor)
//       volume: inline `[[volm 0.0-1.0]]` tune-management command in the text
//       rate:   `-r <wpm>` (words/min); voice: `-v <name>`
//   - Windows (win32): PowerShell System.Speech.Synthesis.SpeechSynthesizer.
//       speak: powershell -NoProfile -Command <script>  where the script does
//              Add-Type System.Speech; $s=New-Object …SpeechSynthesizer;
//              $s.Volume=<0-100>; $s.Rate=<-10..10>; $s.SelectVoice(<name>);
//              $s.Speak(<text>)
//       voices: same synth, $s.GetInstalledVoices() | %{ $_.VoiceInfo.Name }
//       volume: $s.Volume 0-100; rate: $s.Rate -10..10; voice: SelectVoice
//   - Linux: prefer `spd-say` (speech-dispatcher), else `espeak-ng`/`espeak`.
//       spd-say: `spd-say -w -r <-100..100> -i <-100..100> -y <name?> -- <text>`
//                (-w waits, -r rate, -i volume/intensity, -y NAMED synthesis
//                 voice — matches the names `spd-say -L` lists. NOT `-t`, which
//                 selects a generic voice *type* and ignores synthesis names.)
//       espeak:  `espeak -a <0-200> -s <wpm> -v <name?> -- <text>`
//       voices:  `spd-say -L`  /  `espeak --voices`
//       If NONE of these binaries exist → we log ONCE and no-op (never crash,
//       never fall back to a browser engine — there is no browser engine now).
//
// !!! SECURITY — UNTRUSTED CHAT TEXT MUST NEVER REACH A SHELL !!!
// --------------------------------------------------------------
// Chat message text is fully attacker-controlled (any viewer can type
// anything). We MUST guarantee it can never be interpreted as a shell command
// or a PowerShell expression. Two rules, enforced below and asserted by tests:
//
//   1. We ALWAYS spawn with an ARGS ARRAY and NEVER `shell: true`. With
//      `shell:false` (the Node default) argv entries are passed to the child
//      verbatim — no shell parsing, no glob/quote/`;`/`$()` interpretation.
//      So for `say`/`espeak`/`spd-say` the message text is just one argv slot
//      after a `--` end-of-options separator; it cannot inject anything.
//
//   2. WINDOWS IS THE DANGEROUS ONE. We invoke `powershell -Command <script>`,
//      and PowerShell DOES parse its `-Command` argument as code. If we
//      interpolated the message text into that script string, a message like
//      `"; Remove-Item C:\ -Recurse; "` would execute. To make injection
//      structurally impossible we NEVER put message text (or the voice name)
//      into the script as a literal. Instead the script reads them from
//      ENVIRONMENT VARIABLES we set on the spawned process
//      (`RCPP_TTS_TEXT`, `RCPP_TTS_VOICE`) and decodes them from BASE64 inside
//      PowerShell ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(
//      $env:RCPP_TTS_TEXT))). Base64 is a fixed `[A-Za-z0-9+/=]` alphabet, so
//      the value we place in the env var can NEVER contain a PowerShell
//      metacharacter — and env vars aren't evaluated as code anyway. The only
//      values spliced into the script literally are NUMBERS we generate
//      ourselves (volume 0-100, rate -10..10), which are clamped + integer-cast
//      so they're always plain digits. Result: no chat text and no voice name
//      ever touches the PowerShell parser as code.
//
// Everything else (the FIFO queue, cancel = SIGTERM the child + drop the queue,
// kill-on-quit, mute/enabled handled UPSTREAM in the dispatcher) is unchanged
// from the macOS-only engine — those semantics are identical across platforms.

import * as nodeProc from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { Settings, TtsLogEvent } from '../shared/types';

// ============================================================================
// Rate / volume mapping constants
// ============================================================================

/**
 * Words-per-minute that maps to a unitless `rate` of 1.0 on the macOS `say`
 * + Linux `espeak` paths (both take WPM). macOS `say` defaults ~175-200; 180
 * is a sensible middle ground. Pinned by tts-native.test.ts.
 */
export const NATIVE_BASE_WPM = 180;
/** Clamp range for WPM-based engines. Outside this `say`/espeak misbehave. */
export const NATIVE_MIN_WPM = 80;
export const NATIVE_MAX_WPM = 720;

/** Map a unitless `rate` (0.5–2.0 typical, the Settings slider range) → WPM. */
export function rateToWpm(rate: number): number {
  if (!Number.isFinite(rate) || rate <= 0) return NATIVE_BASE_WPM;
  const wpm = Math.round(NATIVE_BASE_WPM * rate);
  if (wpm < NATIVE_MIN_WPM) return NATIVE_MIN_WPM;
  if (wpm > NATIVE_MAX_WPM) return NATIVE_MAX_WPM;
  return wpm;
}

/**
 * Clamp a Web-Speech-style `volume` (0.0–1.0) to the same range. macOS `say`'s
 * inline `[[volm n]]` uses 0.0 = silent, 1.0 = full, so it's a straight clamp.
 * undefined / non-finite → 1.0 (full volume; a missing setting never mutes).
 * Pinned by tts-native.test.ts.
 */
export function clampSayVolume(volume: number | undefined): number {
  if (typeof volume !== 'number' || !Number.isFinite(volume)) return 1.0;
  if (volume < 0) return 0;
  if (volume > 1) return 1;
  return volume;
}

/**
 * macOS `say` text builder — prepend the inline `[[volm n]]` tune-management
 * command so the utterance plays at the requested volume (`say` has no
 * `--volume` flag but honours `[[volm n]]` embedded in the spoken text). We
 * always emit it (even at 1.0) so behaviour is explicit + testable. Rounded to
 * 2 dp to keep the embedded command tidy in logs.
 *
 * NOTE: `say` treats any `[[...]]` in the text as a command, so a chat message
 * containing literal `[[volm 9]]` could change its own volume. That's a cosmetic
 * abuse (viewer makes their own line louder/quieter), NOT a security issue —
 * `say` runs `[[...]]` as TUNE commands, never shell. We accept it rather than
 * escaping (which would risk mangling legitimate `[[` text). The guard if abuse
 * ever appears is to strip `[[...]]` from `text` here.
 */
export function buildSayText(text: string, volume: number | undefined): string {
  const v = clampSayVolume(volume);
  const vStr = (Math.round(v * 100) / 100).toString();
  return `[[volm ${vStr}]] ${text}`;
}

/**
 * Map unitless `volume` (0.0–1.0) → an integer percentage (0–100). Used by the
 * Windows (System.Speech `$s.Volume`) and the Linux `espeak -a` (0..200, we use
 * 0..100 of its range) / `spd-say -i` (we map 0-1 → -100..+100) paths. Integer
 * so it splices into the PowerShell script as a plain digit run (see security
 * note). Pinned by tts-native.test.ts.
 */
export function volumeToPercent(volume: number | undefined): number {
  const v = clampSayVolume(volume);
  return Math.round(v * 100);
}

/**
 * Map unitless `rate` (0.5–2.0 typical) → the Windows System.Speech rate scale
 * (-10..+10, where 0 is normal). We treat 1.0 → 0, <1 slower (negative), >1
 * faster (positive), linear: rate 0.5 → -5, rate 2.0 → +10. Clamped + integer
 * (so it's a safe literal in the PS script). Pinned by tests.
 */
export function rateToWindowsRate(rate: number): number {
  if (!Number.isFinite(rate) || rate <= 0) return 0;
  // 1.0 = 0; scale so 2.0→+10 and 0.5→-5 (10 units per 1.0 above, mirrored).
  const scaled = Math.round((rate - 1) * 10);
  if (scaled < -10) return -10;
  if (scaled > 10) return 10;
  return scaled;
}

/**
 * Map unitless `volume`/`rate` → speech-dispatcher's -100..+100 scales used by
 * `spd-say` (-i intensity for volume, -r rate where 0 is normal). volume 0-1 →
 * 0..100 is too quiet relative to its default of 0, so we map 0→-100, 1→0
 * (speech-dispatcher 0 is "normal/full", negative is quieter). rate 1.0→0,
 * 0.5→-50, 2.0→+100. Clamped to [-100,100]. Pinned by tests.
 */
export function volumeToSpdIntensity(volume: number | undefined): number {
  const v = clampSayVolume(volume); // 0..1
  // 0 → -100 (quietest spd allows), 1 → 0 (spd "normal" == full).
  return Math.round(-100 + v * 100);
}
export function rateToSpdRate(rate: number): number {
  if (!Number.isFinite(rate) || rate <= 0) return 0;
  const scaled = Math.round((rate - 1) * 100);
  if (scaled < -100) return -100;
  if (scaled > 100) return 100;
  return scaled;
}

// ============================================================================
// Shared types
// ============================================================================

/**
 * Parsed voice entry. `sample` is the demo phrase a voice ships with (macOS
 * only; empty elsewhere). `lang` is the locale identifier in whatever shape the
 * platform reports (`en_GB` on `say`, `en-GB`/`en` on espeak; may be empty on
 * Windows where System.Speech reports culture separately — we best-effort it).
 */
export interface NativeVoice {
  /** Display name — e.g. `Daniel`, `Microsoft Zira Desktop`, `english-us`. */
  name: string;
  /** Locale identifier in the platform's native shape. May be empty. */
  lang: string;
  /** Demo phrase shipped by the OS for this voice. Usually empty off macOS. */
  sample: string;
}

/** Per-utterance enqueue options. `messageId` is propagated into the JSONL log. */
export interface NativeEnqueueOpts {
  voice?: string;
  /** Unitless rate (Settings slider value). */
  rate?: number;
  /** Unitless volume 0.0–1.0 (Settings slider value). */
  volume?: number;
  messageId?: string;
}

/** Subset of Settings.tts the native engine consumes. */
export interface NativeTtsSettings {
  voiceURI?: string;
  rate: number;
  volume: number;
}

export type NativeTtsEventName =
  | 'native_speak_start'
  | 'native_speak_end'
  | 'native_speak_error'
  | 'native_speak_killed'
  | 'native_queue_size'
  | 'native_no_engine';

export type NativeTtsLogger = (
  event: TtsLogEvent['event'] | NativeTtsEventName,
  data?: Record<string, unknown>,
) => void;

/**
 * Spawned-child shape — only the bits we use from Node's ChildProcess, so unit
 * tests can substitute a fake without touching real subprocesses.
 */
export interface NativeSpawnedChild extends EventEmitter {
  pid?: number | undefined;
  kill(signal?: NodeJS.Signals | number): boolean;
}

/**
 * How the engine spawns a child. PRODUCTION ALWAYS uses an args array with
 * `shell:false` (never `shell:true`) so untrusted text in argv can't be parsed
 * by a shell. `env` is merged onto `process.env` — the Windows adapter uses it
 * to pass base64 text/voice OUT OF the script string entirely (security note at
 * top of file). Tests pass a stub that records the call + returns a fake child.
 */
export interface NativeSpawnArgs {
  command: string;
  args: string[];
  /** Extra env vars merged onto process.env for the child. */
  env?: Record<string, string>;
}
export type NativeSpawner = (spec: NativeSpawnArgs) => NativeSpawnedChild;

const defaultSpawner: NativeSpawner = (spec) =>
  // SECURITY: shell:false (Node default) — argv passed verbatim, no shell
  // parsing of the (possibly attacker-controlled) text/voice argv entries.
  nodeProc.spawn(spec.command, spec.args, {
    stdio: ['ignore', 'ignore', 'pipe'],
    shell: false,
    env: spec.env ? { ...process.env, ...spec.env } : process.env,
  }) as unknown as NativeSpawnedChild;

interface QueueEntry {
  text: string;
  opts: NativeEnqueueOpts;
}

// ============================================================================
// Platform adapter — builds the spawn spec + parses the voice list per OS.
// ============================================================================

/**
 * A platform adapter knows how to (a) build the spawn spec for one utterance
 * and (b) enumerate installed voices. `id` is for logging. The engine is
 * platform-agnostic and just drives whichever adapter `detectPlatformAdapter()`
 * returns for the current OS (or `null` when no usable engine exists).
 */
export interface PlatformAdapter {
  id: 'macos-say' | 'windows-sapi' | 'linux-spd' | 'linux-espeak';
  /** Build the spawn spec for one utterance. Text/voice handled SAFELY. */
  buildSpeakSpec(args: {
    text: string;
    voice?: string;
    rate: number;
    volume: number;
  }): NativeSpawnArgs;
  /** Enumerate installed voices. Spawns the platform's list command + parses. */
  listVoices(): Promise<NativeVoice[]>;
}

// ---------- macOS: `say` ----------------------------------------------------
const macosSayAdapter: PlatformAdapter = {
  id: 'macos-say',
  buildSpeakSpec({ text, voice, rate, volume }) {
    const wpm = rateToWpm(rate);
    // Volume rides inline in the spoken text via `[[volm n]]`.
    const spoken = buildSayText(text, volume);
    const args: string[] = [];
    if (voice) args.push('-v', voice);
    args.push('-r', String(wpm));
    // `--` ends option parsing; everything after is the literal text argv slot.
    // With shell:false this text cannot inject a shell command.
    args.push('--', spoken);
    return { command: 'say', args };
  },
  listVoices() {
    return spawnCollectStdout('say', ['-v', '?']).then(parseSayVoiceList);
  },
};

// ---------- Windows: PowerShell System.Speech --------------------------------
/**
 * The PowerShell speak script. It contains NO interpolated text or voice — it
 * reads BOTH from base64-encoded env vars and decodes them in-process, so
 * attacker-controlled text can never be parsed as PowerShell (see top-of-file
 * security note). Only the numeric volume/rate are spliced as plain integers.
 * `RCPP_TTS_VOICE` is optional: when empty we skip SelectVoice (system default).
 */
function windowsSpeakScript(volumePercent: number, winRate: number): string {
  // volumePercent ∈ [0,100], winRate ∈ [-10,10], both integers we generated.
  return [
    'Add-Type -AssemblyName System.Speech;',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;',
    `$s.Volume = ${volumePercent};`,
    `$s.Rate = ${winRate};`,
    // Decode the UTF-8 text from base64 in the env var (NOT a script literal).
    '$txt = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($env:RCPP_TTS_TEXT));',
    '$vb64 = $env:RCPP_TTS_VOICE;',
    'if ($vb64) {',
    '  $vname = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($vb64));',
    // SelectVoice can throw if the named voice was uninstalled — swallow and
    // fall back to the default voice rather than crashing the subprocess.
    '  try { $s.SelectVoice($vname) } catch { }',
    '}',
    '$s.Speak($txt);',
  ].join(' ');
}

const windowsSapiAdapter: PlatformAdapter = {
  id: 'windows-sapi',
  buildSpeakSpec({ text, voice, rate, volume }) {
    const volPct = volumeToPercent(volume);
    const winRate = rateToWindowsRate(rate);
    const script = windowsSpeakScript(volPct, winRate);
    // Pass text + voice via env vars as base64 — they NEVER enter the -Command
    // string, so no PowerShell metacharacter in chat text can ever execute.
    const env: Record<string, string> = {
      RCPP_TTS_TEXT: Buffer.from(text, 'utf8').toString('base64'),
      RCPP_TTS_VOICE: voice ? Buffer.from(voice, 'utf8').toString('base64') : '',
    };
    return {
      command: 'powershell',
      args: ['-NoProfile', '-NonInteractive', '-Command', script],
      env,
    };
  },
  listVoices() {
    // Emit "name|culture" per line so the parser keeps the lang column.
    const script = [
      'Add-Type -AssemblyName System.Speech;',
      '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;',
      '$s.GetInstalledVoices() | ForEach-Object {',
      '  $vi = $_.VoiceInfo;',
      '  Write-Output ("{0}|{1}" -f $vi.Name, $vi.Culture)',
      '}',
    ].join(' ');
    return spawnCollectStdout('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      script,
    ]).then(parseWindowsVoiceList);
  },
};

// ---------- Linux: spd-say (preferred) --------------------------------------
const linuxSpdAdapter: PlatformAdapter = {
  id: 'linux-spd',
  buildSpeakSpec({ text, voice, rate, volume }) {
    const args: string[] = ['-w']; // -w = wait for speech to complete
    args.push('-r', String(rateToSpdRate(rate)));
    args.push('-i', String(volumeToSpdIntensity(volume)));
    // v0.1.82 fix: select the named SYNTHESIS voice with `-y`
    // (`--synthesis-voice`), NOT `-t`. `-t` (`--voice-type`) picks a generic
    // voice *type* (male1/female2/child1/…), but the names we offer the user
    // come from `parseSpdVoiceList(spd-say -L)`, which lists synthesis-voice
    // *names* (e.g. `english-us`, `Alan`). Passing such a name via `-t` is
    // ignored / falls back to the default voice, so the user's chosen voice
    // never took effect on Linux. `-y <name>` is the matching flag for those
    // names. (Linux is untested from our dev machines — this is a
    // correctness-by-inspection fix; the flag now matches the list source.)
    if (voice) args.push('-y', voice); // -y = named synthesis voice (matches -L)
    args.push('--', text); // `--` then literal text; shell:false → no injection
    return { command: 'spd-say', args };
  },
  listVoices() {
    return spawnCollectStdout('spd-say', ['-L']).then(parseSpdVoiceList);
  },
};

// ---------- Linux: espeak-ng / espeak (fallback) ----------------------------
function makeEspeakAdapter(bin: 'espeak-ng' | 'espeak'): PlatformAdapter {
  return {
    id: 'linux-espeak',
    buildSpeakSpec({ text, voice, rate, volume }) {
      const args: string[] = [];
      // espeak -a amplitude 0..200 (100 = default). Map 0..1 → 0..200.
      args.push('-a', String(Math.round(clampSayVolume(volume) * 200)));
      args.push('-s', String(rateToWpm(rate))); // -s words/min
      if (voice) args.push('-v', voice);
      args.push('--', text); // literal text; shell:false → no injection
      return { command: bin, args };
    },
    listVoices() {
      return spawnCollectStdout(bin, ['--voices']).then(parseEspeakVoiceList);
    },
  };
}

/**
 * Pick the adapter for the current OS, or null when no usable engine exists.
 * Linux probes `spd-say` first (best quality / most installs), then
 * `espeak-ng`, then `espeak`. `which <bin>` is the probe — synchronous so the
 * engine can decide its adapter once at construction. Injectable for tests via
 * `NativeTtsEngineOptions.adapter`.
 */
export function detectPlatformAdapter(
  platform: NodeJS.Platform = process.platform,
  whichSync: (bin: string) => boolean = defaultWhichSync,
): PlatformAdapter | null {
  if (platform === 'darwin') return macosSayAdapter;
  if (platform === 'win32') return windowsSapiAdapter;
  if (platform === 'linux') {
    if (whichSync('spd-say')) return linuxSpdAdapter;
    if (whichSync('espeak-ng')) return makeEspeakAdapter('espeak-ng');
    if (whichSync('espeak')) return makeEspeakAdapter('espeak');
    return null; // no speech engine present → engine no-ops (logged once)
  }
  return null; // unknown platform → no-op
}

/** `which <bin>` returning true when the binary is on PATH. Best-effort. */
function defaultWhichSync(bin: string): boolean {
  try {
    const probe = process.platform === 'win32' ? 'where' : 'which';
    const r = nodeProc.spawnSync(probe, [bin], { stdio: 'ignore', shell: false });
    return r.status === 0;
  } catch {
    return false;
  }
}

// ============================================================================
// The engine
// ============================================================================

export interface NativeTtsEngineOptions {
  /** Initial Settings.tts subset so the first enqueue has a defined voice/rate. */
  settings: NativeTtsSettings;
  /** Log sink. Wired to `appendTtsLog` in production; undefined in tests. */
  log?: NativeTtsLogger;
  /** Override spawn for unit tests. */
  spawner?: NativeSpawner;
  /**
   * Override the platform adapter (tests inject a fake; production lets
   * `detectPlatformAdapter()` choose). `null` explicitly = "no engine" path.
   */
  adapter?: PlatformAdapter | null;
}

export class NativeTtsEngine {
  private queue: QueueEntry[] = [];
  private current: NativeSpawnedChild | null = null;
  private settings: NativeTtsSettings;
  private readonly log: NativeTtsLogger;
  private readonly spawner: NativeSpawner;
  /** Chosen platform adapter, or null when no usable OS engine exists. */
  private readonly adapter: PlatformAdapter | null;
  /** Cached voice list (does not change at runtime). */
  private voicesCache: NativeVoice[] | undefined;
  /** True while a cancel() is in flight so the killed child's exit doesn't pop. */
  private cancelling = false;
  /** Monotonic tag for log entries when no messageId is supplied. */
  private speakSeq = 0;
  /** Guard so the "no speech engine installed" warning only logs once. */
  private warnedNoEngine = false;

  constructor(opts: NativeTtsEngineOptions) {
    this.settings = opts.settings;
    this.log = opts.log ?? (() => undefined);
    this.spawner = opts.spawner ?? defaultSpawner;
    // `adapter` defaults to auto-detect; an explicit `null` (tests / no-engine
    // platforms) keeps the engine alive but makes every speak a logged no-op.
    this.adapter = opts.adapter !== undefined ? opts.adapter : detectPlatformAdapter();
  }

  /** Which backend the engine resolved to (for diagnostics/tests). null = none. */
  get adapterId(): PlatformAdapter['id'] | null {
    return this.adapter ? this.adapter.id : null;
  }

  /**
   * Push text onto the queue. If nothing's speaking we kick off immediately;
   * else the FIFO drain handler does it when the current child exits.
   * Empty / whitespace-only text is dropped silently. If there's NO platform
   * engine, we log once + no-op (never crash — there is no browser fallback).
   */
  enqueue(text: string, opts: NativeEnqueueOpts = {}): void {
    if (typeof text !== 'string') return;
    const trimmed = text.trim();
    if (!trimmed) return;
    if (!this.adapter) {
      // No `say`/PowerShell/spd-say/espeak available. Warn ONCE so the user can
      // install one, then silently drop subsequent utterances. We deliberately
      // do NOT throw — a missing voice engine must never break chat handling.
      if (!this.warnedNoEngine) {
        this.warnedNoEngine = true;
        this.log('native_no_engine', {
          platform: process.platform,
          note: 'no system speech engine found (need say / PowerShell / spd-say / espeak)',
        });
      }
      return;
    }
    this.queue.push({ text, opts });
    this.log('native_queue_size', { queue_size: this.queue.length });
    if (!this.current) this.drain();
  }

  /** Update settings for FUTURE utterances. Does not mutate the running child. */
  updateSettings(settings: NativeTtsSettings): void {
    this.settings = settings;
  }

  /** SIGTERM the current child + clear the queue. Idempotent. */
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
    // v0.1.84 — Linux (spd-say) daemon stop.
    //
    // On the spd-say adapter the child we SIGTERM above is only the *client*
    // (`spd-say -w …`). It has already handed the utterance to the
    // speech-dispatcher DAEMON, which keeps synthesising/playing even after the
    // client dies — so SIGTERM alone does NOT stop audio that's already
    // started. `spd-say --cancel` tells the daemon to stop the current message
    // (and clear its queue), which is what actually silences playback.
    //
    // We fire it as a fresh short-lived child (args array, shell:false → no
    // injection, consistent with every other spawn in this file). Fire-and-
    // forget: errors are swallowed because a failed cancel must never break the
    // queue-clear / kill-child path above.
    //
    // NOTE: untested from our dev machines (no Linux user in the loop) — this is
    // a correctness-by-inspection fix mirroring the spd-say documented behaviour.
    if (this.adapter?.id === 'linux-spd') {
      try {
        const canceller = this.spawner({ command: 'spd-say', args: ['--cancel'] });
        // Reap quietly so a spawn-level error (e.g. spd-say vanished) doesn't
        // surface as an unhandled 'error' event and crash main.
        canceller.on('error', () => undefined);
      } catch (err) {
        this.log('native_speak_error', {
          stage: 'cancel-daemon',
          error: String((err as Error)?.message ?? err),
        });
      }
    }
    if (cleared > 0) this.log('native_queue_size', { queue_size: 0, cleared });
  }

  /**
   * Speak a one-off PREVIEW utterance for the given voice — used by the
   * Settings voice-preview button (over IPC). Cancels any in-flight preview /
   * queued chat first so rapid dropdown changes don't pile up overlapping
   * samples, then enqueues "Hello, my name is <voice>" at the current
   * rate/volume. Returns the spoken text (for tests). No-ops to the returned
   * string if no engine is present.
   */
  preview(voiceURI: string | undefined): string {
    const displayName = voiceURI ?? 'system default';
    const text = `Hello, my name is ${displayName}`;
    this.cancel();
    this.enqueue(text, {
      voice: voiceURI,
      rate: this.settings.rate,
      volume: this.settings.volume,
    });
    return text;
  }

  /** Cached voice list, populated on first call. Empty array on failure. */
  async getAvailableVoices(): Promise<NativeVoice[]> {
    if (this.voicesCache) return this.voicesCache;
    if (!this.adapter) return [];
    try {
      const list = await this.adapter.listVoices();
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

  /** Force a re-probe of the voice list (e.g. after a new voice is installed). */
  async refreshVoices(): Promise<NativeVoice[]> {
    this.voicesCache = undefined;
    return this.getAvailableVoices();
  }

  /** Inspect-only: current queue depth. */
  get queueDepth(): number {
    return this.queue.length;
  }
  /** Inspect-only: is a subprocess currently running. */
  get isSpeaking(): boolean {
    return this.current !== null;
  }

  // ------------------------------------------------------------- internals

  private drain(): void {
    if (this.current) return;
    const next = this.queue.shift();
    if (!next) return;
    if (!this.adapter) return; // belt-and-suspenders; enqueue already guards
    this.cancelling = false;
    const messageId = next.opts.messageId;
    const voice = next.opts.voice ?? this.settings.voiceURI;
    const rate = next.opts.rate ?? this.settings.rate;
    // Resolve volume per-utterance first, then engine settings, then full.
    const volume = clampSayVolume(next.opts.volume ?? this.settings.volume);

    // Build the per-platform spawn spec. The adapter owns the SAFE handling of
    // the (untrusted) text + voice — args array everywhere, env-var base64 on
    // Windows. No string interpolation of message text into a shell/PS command.
    const spec = this.adapter.buildSpeakSpec({ text: next.text, voice, rate, volume });

    const seq = ++this.speakSeq;
    const startedAt = Date.now();
    this.log('native_speak_start', {
      message_id: messageId,
      seq,
      engine: this.adapter.id,
      voice: voice ?? null,
      // Resolved volume/rate logged so a forensic grep confirms the slider
      // values actually reached the subprocess (what Ethan wants verifiable).
      volume,
      rate,
      queue_size: this.queue.length,
    });

    let subproc: NativeSpawnedChild;
    try {
      subproc = this.spawner(spec);
    } catch (err) {
      this.log('native_speak_error', {
        message_id: messageId,
        seq,
        stage: 'spawn',
        engine: this.adapter.id,
        error: String((err as Error)?.message ?? err),
      });
      // Never let a single bad spawn wedge the queue.
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
      // If a cancel() raced this exit, clear the flag — but do NOT
      // unconditionally bail. There's a subtle race (the v0.1.82 fix):
      //
      //   cancel()  → cancelling=true, queue cleared, child SIGTERMed
      //              (its `exit` fires ASYNCHRONOUSLY, on a later tick)
      //   enqueue() → pushes a NEW entry; its `if (!this.current) drain()`
      //               guard is FALSE because `this.current` still points at
      //               the dying (not-yet-exited) child, so it does NOT start
      //   <killed child's exit fires here> → settle() runs
      //
      // The OLD code did `if (cancelling) { cancelling=false; return; }`,
      // returning BEFORE drain(). `this.current` was just set to null above,
      // so the freshly-enqueued entry sat idle in the queue until the NEXT
      // enqueue happened to call drain(). Symptom: spam-clicking the Settings
      // voice-preview button (preview() does cancel() THEN enqueue()
      // synchronously) dropped samples — the sample queued during the
      // cancelling window never spoke. So: after clearing the flag, if an item
      // got enqueued during the window (queue non-empty) and nothing is
      // running (current === null, set above), kick the drain. drain() itself
      // re-guards on `this.current` and shift()s, so this can't double-start or
      // double-pop; the killed child already settled (settled=true) so it won't
      // re-enter. We schedule via setImmediate to match the normal exit path's
      // ordering (drain on a fresh tick, never re-entrantly inside settle()).
      if (this.cancelling) {
        this.cancelling = false;
        // Only drain if cancel() was followed by an enqueue() that couldn't
        // self-start. No pending item → genuine cancel, stay idle (mute/quit).
        if (!this.current && this.queue.length > 0) {
          setImmediate(() => this.drain());
        }
        return;
      }
      setImmediate(() => this.drain());
    };
    subproc.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      settle('exit', {
        exitCode: code,
        signal,
        killed: signal === 'SIGTERM' || this.cancelling,
      });
    });
    subproc.on('error', (err: Error) => {
      settle('error', { error: String(err?.message ?? err) });
    });
  }
}

// ============================================================================
// stdout collection + per-platform voice-list parsers
// ============================================================================

/**
 * Spawn `command args`, collect stdout, resolve it (reject on non-zero exit or
 * spawn error). Used by every adapter's voice-list probe. shell:false — the
 * args here are all our own constants, but we keep the safe default uniform.
 */
function spawnCollectStdout(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const subproc = nodeProc.spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
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
        reject(new Error(`${command} ${args.join(' ')} exited ${code}: ${stderr.trim()}`));
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * Parse `say -v "?"` output (macOS). Lines look like:
 *   Daniel              en_GB    # Hello! My name is Daniel.
 *   Eddy (English (UK)) en_GB    # Hello! My name is Eddy.
 *   Majed               ar_001   # مرحبا اسمي ماجد.   ← NUMERIC region!
 * Voice names contain spaces/parens, so we anchor on the locale token (the only
 * column with a consistent `xx_YY` shape). Stray header/footer lines are
 * dropped. Exported for unit testing without spawning.
 *
 * v0.1.82 fix: the region group now allows DIGITS, not just uppercase letters.
 * macOS ships voices whose locale uses a UN M49 numeric region instead of an
 * ISO alpha-2 country — e.g. `ar_001` (Majed, "Arabic – World"), `en_001`,
 * `es_419` ("Spanish – Latin America"). The old anchor `[A-Z]{2,4}` required
 * uppercase letters in the region, so every numeric-region voice failed to
 * match and was silently dropped from the dropdown. `[A-Z0-9]{2,4}` keeps the
 * alpha forms (`en_GB`, `zh-CN`) AND admits the numeric ones.
 */
export function parseSayVoiceList(stdout: string): NativeVoice[] {
  const out: NativeVoice[] = [];
  const lines = stdout.split(/\r?\n/);
  // Region group is [A-Z0-9]{2,4}: alpha countries (GB, US) + numeric M49
  // regions (001, 419). Language stays lowercase alpha (en, ar, zh, yue).
  const localeRe = /\s([a-z]{2,3}[_-][A-Z0-9]{2,4})\s/;
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
    const sample = afterLocale.replace(/^\s*#\s?/, '').trim();
    out.push({ name, lang, sample });
  }
  return out;
}

/**
 * Parse the Windows voice-list output. Our PS script emits one `name|culture`
 * per line (e.g. `Microsoft Zira Desktop|en-US`). Lines without a `|` are
 * dropped. Exported for unit testing.
 */
export function parseWindowsVoiceList(stdout: string): NativeVoice[] {
  const out: NativeVoice[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const pipe = line.indexOf('|');
    if (pipe < 0) continue;
    const name = line.slice(0, pipe).trim();
    const lang = line.slice(pipe + 1).trim();
    if (!name) continue;
    out.push({ name, lang, sample: '' });
  }
  return out;
}

/**
 * Parse `spd-say -L` output (Linux speech-dispatcher). Format is a header line
 * then rows like:
 *   en-US  espeak-ng  male1
 * The FIRST whitespace-delimited token that looks like a voice name varies by
 * module; spd-say -L actually prints columns "NAME LANGUAGE VARIANT". We take
 * the first column as the name and the second as lang. Header line ("Name ...")
 * and blank lines are dropped. Exported for unit testing.
 */
export function parseSpdVoiceList(stdout: string): NativeVoice[] {
  const out: NativeVoice[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    // Skip an obvious header row.
    if (/^name\b/i.test(line)) continue;
    const cols = line.split(/\s+/);
    if (cols.length === 0) continue;
    const name = cols[0];
    const lang = cols[1] ?? '';
    if (!name) continue;
    out.push({ name, lang, sample: '' });
  }
  return out;
}

/**
 * Parse `espeak --voices` output (Linux). Columns are:
 *   Pty Language Age/Gender VoiceName          File          Other
 *     5  en-us          M  english-us          en-us         (en 5)
 * Header row starts with "Pty". We take VoiceName (4th column) as the name and
 * Language (2nd column) as lang. Exported for unit testing.
 */
export function parseEspeakVoiceList(stdout: string): NativeVoice[] {
  const out: NativeVoice[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/u, '');
    if (!line.trim()) continue;
    if (/^\s*Pty\b/i.test(line)) continue; // header
    const cols = line.trim().split(/\s+/);
    // cols: [Pty, Language, Age/Gender, VoiceName, File, ...]
    if (cols.length < 4) continue;
    const lang = cols[1] ?? '';
    const name = cols[3] ?? '';
    if (!name) continue;
    out.push({ name, lang, sample: '' });
  }
  return out;
}

/** Extract the Settings.tts subset the native engine consumes. */
export function ttsToNativeSettings(tts: Settings['tts']): NativeTtsSettings {
  return {
    voiceURI: tts.voiceURI,
    rate: tts.rate,
    volume: tts.volume,
  };
}
