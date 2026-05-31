// MAIN-PROCESS TTS + NOTIFICATION DISPATCH.
// ============================================================================
//
// WHY THIS EXISTS / WHAT IT OWNS
// ------------------------------
// The chat→speak decision (filters, rate-limit, same-id guard) and the actual
// speaking BOTH happen in the MAIN (background) process. ws-client hands every
// chat message to `handleMessage(m)` here; we decide whether to speak, then
// speak via the native OS voice engine (src/main/tts-native.ts). Running this
// in main is PRIORITY #1 from Ethan voice 4414: "it must NEVER miss a message".
// A wedged/dead/slow renderer can no longer swallow a message — there is no
// renderer involvement in speech at all anymore.
//
// v0.1.81 (Ethan 2026-05-31: "lets just use system voice for everything then.
// no more browser one. do it.") — THE BROWSER (renderer Web-Speech) SPEAKING
// PATH IS GONE. Through v0.1.80 this dispatcher had TWO backends: the renderer
// Web-Speech voice (when the window was visible, on win/linux + briefly macOS)
// and the native OS voice (macOS always + the genuinely-hidden fallback). The
// browser path was unreliable: Chromium throttles/suspends `speechSynthesis`
// whenever the window isn't foreground (and can silently latch even when it
// is), so it produced NO AUDIO — Ethan heard nothing. The decision (final) was
// to drop the renderer engine entirely and use the OS system voice on EVERY
// platform. So `dispatchSpeak()` now has exactly ONE path: native. No
// visibility detection, no backend choice, no IPC-to-renderer-to-speak.
//
// WHAT STILL WORKS (all the controls Ethan cares about):
//   - volume → native engine applies it (macOS `[[volm]]`, Windows
//     System.Speech `$s.Volume`, Linux espeak `-a` / spd-say `-i`).
//   - rate   → mapped per platform (WPM on macOS/espeak, -10..10 on Windows,
//     -100..100 on spd-say).
//   - voice  → `-v` (macOS/espeak) / SelectVoice (Windows) / `-t` (spd-say).
//   - mute / enabled / speakSelf / regex filters / hidden-users / platform
//     toggles / rate-limit → all enforced by the SAME pure deciders + limiters
//     here in main, BEFORE the native engine is ever touched.
//   - PITCH is the one Web-Speech control that has no clean native equivalent
//     (`say`/spd-say/espeak/System.Speech don't expose a per-utterance pitch
//     knob we can rely on cross-platform), so it was dropped from the UI in
//     v0.1.81. The `pitch` setting still exists in the persisted blob (for
//     back-compat + the MCP tool) but is no longer used for speech.
//
// STATE OWNED HERE (per main-process singleton):
//   - compiled regex patterns + hidden-users set (rebuilt on settings change)
//   - the TTS + notification rate limiters (token buckets)
//   - lastProcessedId (the same-id-reprocess guard)

import type {
  ChatMessage,
  NotificationDecisionReason,
  Settings,
  TtsDecisionReason,
  TtsLogEvent,
} from '../shared/types';
import {
  compileHiddenUsersSet,
  compileIgnorePatterns,
} from '../shared/message-filters';
import {
  composeDecisionLogData,
  decideNotificationAction,
  decideTtsAction,
  type SideEffectContext,
} from '../shared/side-effect-decision';

/**
 * Backend the dispatcher chose for a message. Surfaced to the caller (+ logged)
 * so a forensic grep can answer "did this message get voiced".
 *
 * v0.1.81: the only speaking backend now is 'native' (the OS system voice on
 * every platform). 'skip' means a decision gate suppressed TTS. The old
 * 'browser' value is gone with the renderer Web-Speech path.
 */
export type TtsBackendChoice = 'native' | 'skip';

/**
 * Pure rate limiter (token bucket over a rolling 60s window). `now` is
 * injectable so unit tests can advance the clock deterministically. Lives in
 * main so the limit survives a renderer reload.
 */
export class MainRateLimiter {
  private timestamps: number[] = [];
  constructor(private maxPerMinute: number, private now: () => number = Date.now) {}
  /** Update the cap live (settings change) without losing the current window. */
  setMax(maxPerMinute: number): void {
    this.maxPerMinute = maxPerMinute;
  }
  tryConsume(): boolean {
    this.prune();
    if (this.timestamps.length >= this.maxPerMinute) return false;
    this.timestamps.push(this.now());
    return true;
  }
  private prune(): void {
    const cutoff = this.now() - 60_000;
    while (this.timestamps.length > 0 && this.timestamps[0] < cutoff) {
      this.timestamps.shift();
    }
  }
}

/**
 * Things the dispatcher needs from the host (main.ts), passed in so the module
 * is unit-testable with fakes.
 */
export interface TtsDispatchDeps {
  /** Current persisted settings. Called once per message + on settings change. */
  loadSettings(): Settings;
  /**
   * Speak `text` via the native OS voice engine. `volume`/`voice`/`rate` flow
   * from settings; the native engine applies them per platform. Wired to the
   * main-process NativeTtsEngine singleton (which works on macOS / Windows /
   * Linux). This is the ONLY speaking path as of v0.1.81 — there is no browser
   * path anymore. `pitch` is intentionally NOT passed (no cross-platform native
   * pitch knob — see the file header).
   */
  speakNative(text: string, opts: { voice?: string; rate?: number; volume?: number; messageId?: string }): void;
  /** Fire a native OS notification. `silent` honours settings.notifications.soundEnabled. */
  notify(title: string, body: string, silent: boolean): void;
  /** Persist a tts-events.jsonl row. Best-effort; never throws into dispatch. */
  log(event: TtsLogEvent['event'], data?: Record<string, unknown>): void;
}

/**
 * Build the string the synthesizer speaks for a message.
 * readSenderName=true → "alice says hi"; false → "hi".
 */
export function composeUtteranceForDispatch(m: ChatMessage, readSenderName: boolean): string {
  if (readSenderName) return `${m.username} says ${m.text}`;
  return m.text;
}

/**
 * The main-process TTS + notification dispatcher. One instance per main
 * process. `handleMessage(m)` is called for every chat message that arrives
 * from ws-client — it runs the decision, and (when not suppressed) speaks via
 * the native OS engine. Returns the backend it chose (for tests).
 *
 * Settings + compiled patterns are refreshed lazily per message via
 * `deps.loadSettings()` so a live settings change (UI slider, MCP tool) is
 * always reflected. The compiled regex/hidden-user derivations are MEMOISED
 * against the source arrays so we don't recompile on every message during a
 * raid. The rate limiters are long-lived (token buckets must persist).
 */
export class TtsDispatcher {
  private readonly deps: TtsDispatchDeps;
  private readonly ttsLimiter: MainRateLimiter;
  private readonly notifLimiter: MainRateLimiter;
  /** same-id-reprocess guard — last message id we acted on. */
  private lastProcessedId: string | undefined;

  // --- memoised compiled derivations (recompiled only when source changes) ---
  private cachedHiddenUsersSrc: readonly string[] | undefined;
  private cachedHiddenUsersSet: ReadonlySet<string> = new Set();
  private cachedTtsContentSrc: readonly string[] | undefined;
  private cachedTtsContent: RegExp[] = [];
  private cachedTtsUserSrc: readonly string[] | undefined;
  private cachedTtsUser: RegExp[] = [];
  private cachedNotifContentSrc: readonly string[] | undefined;
  private cachedNotifContent: RegExp[] = [];
  private cachedNotifUserSrc: readonly string[] | undefined;
  private cachedNotifUser: RegExp[] = [];

  constructor(deps: TtsDispatchDeps, now: () => number = Date.now) {
    this.deps = deps;
    const s = deps.loadSettings();
    this.ttsLimiter = new MainRateLimiter(s.tts.maxPerMinute, now);
    this.notifLimiter = new MainRateLimiter(s.notifications.maxPerMinute, now);
  }

  /**
   * Recompile a memoised regex list ONLY if the source array reference (or
   * contents) changed. Reference compare first (cheap, common no-change case),
   * then a shallow value compare so a fresh-but-equal array doesn't recompile.
   */
  private memoPatterns(
    src: readonly string[],
    cachedSrc: readonly string[] | undefined,
    cached: RegExp[],
    assign: (s: readonly string[], c: RegExp[]) => void,
  ): RegExp[] {
    if (cachedSrc !== undefined && sameStringArray(src, cachedSrc)) return cached;
    const compiled = compileIgnorePatterns(src);
    assign(src, compiled);
    return compiled;
  }

  /** Build the decision context for one message from the current settings. */
  private buildContext(settings: Settings): SideEffectContext {
    const hiddenSrc = settings.hiddenUsers ?? [];
    if (this.cachedHiddenUsersSrc === undefined || !sameStringArray(hiddenSrc, this.cachedHiddenUsersSrc)) {
      this.cachedHiddenUsersSet = compileHiddenUsersSet(hiddenSrc);
      this.cachedHiddenUsersSrc = hiddenSrc;
    }
    const ttsContent = this.memoPatterns(
      settings.filters?.tts?.ignoreRegex ?? [],
      this.cachedTtsContentSrc,
      this.cachedTtsContent,
      (s, c) => {
        this.cachedTtsContentSrc = s;
        this.cachedTtsContent = c;
      },
    );
    const ttsUser = this.memoPatterns(
      settings.filters?.tts?.ignoreUsernameRegex ?? [],
      this.cachedTtsUserSrc,
      this.cachedTtsUser,
      (s, c) => {
        this.cachedTtsUserSrc = s;
        this.cachedTtsUser = c;
      },
    );
    const notifContent = this.memoPatterns(
      settings.filters?.notifications?.ignoreRegex ?? [],
      this.cachedNotifContentSrc,
      this.cachedNotifContent,
      (s, c) => {
        this.cachedNotifContentSrc = s;
        this.cachedNotifContent = c;
      },
    );
    const notifUser = this.memoPatterns(
      settings.filters?.notifications?.ignoreUsernameRegex ?? [],
      this.cachedNotifUserSrc,
      this.cachedNotifUser,
      (s, c) => {
        this.cachedNotifUserSrc = s;
        this.cachedNotifUser = c;
      },
    );
    return {
      settings,
      hiddenUsersSet: this.cachedHiddenUsersSet,
      ttsContentPatterns: ttsContent,
      ttsUsernamePatterns: ttsUser,
      notifContentPatterns: notifContent,
      notifUsernamePatterns: notifUser,
      lastProcessedId: this.lastProcessedId,
    };
  }

  /**
   * Main entry point — called for EVERY chat message arriving in main. Runs
   * the TTS + notification decisions, speaks (when not suppressed), and logs
   * the decision (so the "why didn't this get read aloud" forensic grep works).
   * Returns the TTS backend chosen.
   *
   * Wrapped so a thrown error anywhere in here can NEVER break the chat
   * pipeline — worst case must be "this one message wasn't voiced", never "the
   * app stopped processing chat".
   */
  handleMessage(m: ChatMessage): TtsBackendChoice {
    try {
      return this.handleMessageInner(m);
    } catch (err) {
      try {
        this.deps.log('tts_decision', {
          messageId: m?.id,
          decision: 'skip',
          reason: 'dispatch-error',
          error: String((err as Error)?.message ?? err),
        });
      } catch {
        /* logging best-effort */
      }
      return 'skip';
    }
  }

  private handleMessageInner(m: ChatMessage): TtsBackendChoice {
    const settings = this.deps.loadSettings();
    this.ttsLimiter.setMax(settings.tts.maxPerMinute);
    this.notifLimiter.setMax(settings.notifications.maxPerMinute);

    const ctx = this.buildContext(settings);

    const ttsResult = decideTtsAction(m, ctx);
    const notifResult = decideNotificationAction(m, ctx);

    // Bump the same-id guard exactly once per non-reprocess message.
    if (ttsResult.reason !== 'same-id-reprocess') {
      this.lastProcessedId = m.id;
    }

    let backend: TtsBackendChoice = 'skip';

    // --- TTS dispatch ---
    if (ttsResult.decision === 'read') {
      if (this.ttsLimiter.tryConsume()) {
        backend = this.dispatchSpeak(m, settings);
        this.deps.log('tts_decision', { ...composeDecisionLogData(m, ttsResult), backend });
      } else {
        backend = 'skip';
        this.deps.log('tts_decision', {
          ...composeDecisionLogData(m, { decision: 'skip', reason: 'rate-limited' as TtsDecisionReason }),
          backend,
        });
      }
    } else {
      this.deps.log('tts_decision', composeDecisionLogData(m, ttsResult));
    }

    // --- Notification dispatch ---
    if (notifResult.decision === 'notify') {
      if (this.notifLimiter.tryConsume()) {
        this.deps.log('notification_decision', composeDecisionLogData(m, notifResult));
        this.deps.notify(
          `${m.username} (${m.platform})`,
          m.text,
          !settings.notifications.soundEnabled,
        );
      } else {
        this.deps.log(
          'notification_decision',
          composeDecisionLogData(m, {
            decision: 'skip',
            reason: 'rate-limited' as NotificationDecisionReason,
          }),
        );
      }
    } else {
      this.deps.log('notification_decision', composeDecisionLogData(m, notifResult));
    }

    return backend;
  }

  /**
   * Speak the message via the native OS voice engine. The ONLY speaking path
   * as of v0.1.81 — every platform, foreground or background. Returns 'native'.
   *
   * volume / rate / voice flow from settings into the native engine (which maps
   * them per platform). pitch is deliberately NOT passed — no cross-platform
   * native pitch knob exists; the setting was dropped from the UI in v0.1.81.
   */
  private dispatchSpeak(m: ChatMessage, settings: Settings): TtsBackendChoice {
    const text = composeUtteranceForDispatch(m, settings.tts.readSenderName);
    this.deps.speakNative(text, {
      voice: settings.tts.voiceURI,
      rate: settings.tts.rate,
      volume: settings.tts.volume,
      messageId: m.id,
    });
    return 'native';
  }
}

/** Shallow value-equality for two string arrays. Cheap; used for memo gates. */
function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
