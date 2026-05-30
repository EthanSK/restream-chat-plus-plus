// v0.1.76 (Ethan voice 4414, 2026-05-30) — MAIN-PROCESS TTS + NOTIFICATION DISPATCH.
// ============================================================================
//
// WHY THIS EXISTS / WHAT CHANGED
// ------------------------------
// Through v0.1.75 the chat→speak decision/filter/queue/rate-limit logic lived
// in the RENDERER (App.tsx + the pure deciders in side-effect-decision.ts).
// The main process merely forwarded each chat message to the renderer over
// `IPC.CHAT_MESSAGE`, and the renderer decided whether to speak it. That made
// the never-miss guarantee depend on the renderer being alive + responsive:
// if the renderer was wedged, slow, or mid-teardown, a message could be
// dropped with nothing to catch it.
//
// Ethan voice 4414 (PRIORITY #1: "it must NEVER miss a message") asked to move
// ALL the TTS decision/dispatch into the BACKGROUND (main) process so
// robustness never depends on the renderer. This module is that move.
//
// CONTRACT (the part Ethan cares about):
//   1. NEVER MISS: chat arrives in main (from ws-client). Main decides here,
//      then dispatches to a backend. If the window is genuinely hidden, the
//      native macOS `say` subprocess speaks it — that path does NOT touch the
//      renderer at all, so a dead/wedged renderer can never swallow a message.
//   2. ALL SETTINGS WORK: the decision uses the SAME pure deciders the
//      renderer used (decideTtsAction / decideNotificationAction in
//      shared/side-effect-decision.ts) so every filter/toggle behaves
//      identically. For the actual SPEAKING:
//        - window VISIBLE (incl. merely COVERED — the app disables Chromium
//          occlusion so covered windows stay 'visible') → main tells the
//          renderer to speak via the BROWSER voice (Web Speech), which honours
//          EVERY setting exactly as before: volume, voice, rate, pitch.
//        - window genuinely HIDDEN (minimised / other Space / app-hidden via
//          Cmd-H) → main speaks via native `say`, honouring volume (via the
//          inline `[[volm]]` command — v0.1.76), voice (`-v`) and rate (`-r`).
//      Net: volume + every control work in the normal (visible) case; the only
//      setting the hidden fallback can't honour is PITCH (`say` has no pitch),
//      and that's restored the instant the window is visible again.
//
// WHY DECISION IN MAIN BUT BROWSER-SPEAK STILL IN RENDERER:
//   The browser Web-Speech engine necessarily runs in the renderer (it IS the
//   Chromium speechSynthesis API). We can't move the audio out of the renderer
//   without losing volume/pitch support. So the split is: main OWNS the
//   decision + the never-miss guarantee + the native fallback; the renderer is
//   a THIN executor that, on command (`IPC.TTS_SPEAK_BROWSER`), speaks one
//   utterance via Web Speech. The renderer no longer DECIDES anything.
//
// STATE OWNED HERE (per main-process singleton):
//   - compiled regex patterns + hidden-users set (rebuilt on settings change)
//   - the TTS + notification rate limiters (token buckets; moved out of the
//     renderer so they survive renderer reloads)
//   - lastProcessedId (the same-id-reprocess guard)
//
// The renderer-side App.tsx side-effect useEffect is REMOVED in v0.1.76 (it no
// longer decides/dispatches); the renderer only listens for TTS_SPEAK_BROWSER.

import type {
  ChatMessage,
  NotificationDecisionReason,
  Settings,
  TtsDecisionReason,
  TtsLogEvent,
  TtsSpeakBrowserPayload,
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
 * Backend the dispatcher chose for a given message. Surfaced to the caller
 * (and logged) so a forensic grep can answer "which path voiced this".
 *
 *   - 'browser' → main asked the renderer to speak via Web Speech (window
 *                 visible/covered — all settings honoured incl. pitch).
 *   - 'native'  → main spoke via the `say` subprocess (window genuinely
 *                 hidden — volume/voice/rate honoured, pitch degraded).
 *   - 'skip'    → a decision gate suppressed TTS (disabled, regex, etc.).
 */
export type TtsBackendChoice = 'browser' | 'native' | 'skip';

/**
 * Pure rate limiter (token bucket over a rolling 60s window). Identical math
 * to the renderer's `RateLimiter` in tts.ts, re-implemented here so the main
 * process doesn't have to import the DOM-bound renderer module. `now` is
 * injectable so unit tests can advance the clock deterministically.
 *
 * Lives in main now (not the renderer) so the limit survives a renderer
 * reload — part of "robustness never depends on the renderer".
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
 * Things the dispatcher needs from the host (main.ts) but that we don't want
 * to hard-couple to — passed in so the module is unit-testable with fakes.
 */
export interface TtsDispatchDeps {
  /** Current persisted settings. Called once per message + on settings change. */
  loadSettings(): Settings;
  /**
   * True when the app window is GENUINELY hidden (minimised / on another
   * macOS Space / app hidden via Cmd-H) — i.e. Chromium has suspended Web
   * Speech and the browser voice cannot run. False when visible OR merely
   * covered (the app disables occlusion so covered windows stay usable by
   * Web Speech). When true the dispatcher MUST use the native `say` path so
   * the message is never silently lost. Implemented in main.ts off the
   * BrowserWindow state (isMinimized / isVisible) — see wireTtsDispatch.
   */
  isWindowGenuinelyHidden(): boolean;
  /**
   * Speak `text` via the native `say` engine. `volume`/`voice`/`rate` flow
   * from settings; the native engine applies volume via `[[volm]]`. Wired to
   * the main-process NativeTtsEngine singleton.
   */
  speakNative(text: string, opts: { voice?: string; rate?: number; volume?: number; messageId?: string }): void;
  /**
   * Ask the RENDERER to speak one utterance via Web Speech. Wired to
   * `mainWindow.webContents.send(IPC.TTS_SPEAK_BROWSER, payload)`. The
   * renderer's thin executor honours volume/voice/rate/pitch from the payload
   * (a snapshot of settings.tts at decision time). Best-effort — if the
   * window is gone this is a no-op, but that can only happen when the window
   * is ALSO genuinely hidden, in which case we'd have taken the native path.
   */
  speakBrowser(payload: TtsSpeakBrowserPayload): void;
  /** Fire a native OS notification. `silent` honours settings.notifications.soundEnabled. */
  notify(title: string, body: string, silent: boolean): void;
  /** Persist a tts-events.jsonl row. Best-effort; never throws into dispatch. */
  log(event: TtsLogEvent['event'], data?: Record<string, unknown>): void;
}

/**
 * Build the string the synthesizer speaks for a message — mirror of the
 * renderer's `composeUtterance` (kept here to avoid importing the DOM-bound
 * tts.ts into main). readSenderName=true → "alice says hi"; false → "hi".
 */
export function composeUtteranceForDispatch(m: ChatMessage, readSenderName: boolean): string {
  if (readSenderName) return `${m.username} says ${m.text}`;
  return m.text;
}

/**
 * The main-process TTS + notification dispatcher. One instance per main
 * process. `handleMessage(m)` is called for every chat message that arrives
 * from ws-client — it runs the decision, picks the backend by window
 * visibility, and dispatches. Returns the TTS backend it chose (for tests).
 *
 * Settings + compiled patterns are refreshed lazily per message via
 * `deps.loadSettings()` so a live settings change (UI slider, MCP tool) is
 * always reflected — no stale-cache bugs. The compiled regex/hidden-user
 * derivations are MEMOISED against the source arrays so we don't recompile on
 * every single message during a chat raid (only when the lists actually
 * change). The rate limiters are long-lived (token buckets must persist).
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
    // Seed the limiters from current settings; setMax keeps them live on change.
    this.ttsLimiter = new MainRateLimiter(s.tts.maxPerMinute, now);
    this.notifLimiter = new MainRateLimiter(s.notifications.maxPerMinute, now);
  }

  /**
   * Recompile a memoised regex list ONLY if the source array reference (or
   * contents) changed. We compare by reference first (cheap, hits in the
   * common no-change case) and fall back to a shallow value compare so a
   * fresh-but-equal array from loadSettings() doesn't force a recompile.
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
    // Hidden users.
    const hiddenSrc = settings.hiddenUsers ?? [];
    if (this.cachedHiddenUsersSrc === undefined || !sameStringArray(hiddenSrc, this.cachedHiddenUsersSrc)) {
      this.cachedHiddenUsersSet = compileHiddenUsersSet(hiddenSrc);
      this.cachedHiddenUsersSrc = hiddenSrc;
    }
    // Regex axes (4 lists). memoPatterns mutates the matching cache fields.
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
   * the TTS + notification decisions, dispatches to the chosen backend, and
   * logs the decision (so the "why didn't this get read aloud" forensic grep
   * still works, now from the main side). Returns the TTS backend chosen.
   *
   * Wrapped so a thrown error anywhere in here can NEVER break the chat
   * pipeline — the worst case must be "this one message wasn't voiced", never
   * "the app stopped processing chat".
   */
  handleMessage(m: ChatMessage): TtsBackendChoice {
    try {
      return this.handleMessageInner(m);
    } catch (err) {
      // Defensive: never let a dispatch crash the chat forwarder.
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
    // Keep the limiters' caps in lock-step with live settings.
    this.ttsLimiter.setMax(settings.tts.maxPerMinute);
    this.notifLimiter.setMax(settings.notifications.maxPerMinute);

    const ctx = this.buildContext(settings);

    // --- TTS decision (same pure ladder as the old renderer path) ---
    const ttsResult = decideTtsAction(m, ctx);
    // --- Notification decision (independent axes) ---
    const notifResult = decideNotificationAction(m, ctx);

    // Bump the same-id guard exactly once per non-reprocess message (matches
    // the old renderer semantics — we check the TTS path since both apply the
    // same-id gate identically).
    if (ttsResult.reason !== 'same-id-reprocess') {
      this.lastProcessedId = m.id;
    }

    let backend: TtsBackendChoice = 'skip';

    // --- TTS dispatch ---
    if (ttsResult.decision === 'read') {
      // Rate-limit in main (token bucket persists across renderer reloads).
      if (this.ttsLimiter.tryConsume()) {
        backend = this.dispatchSpeak(m, settings);
        // Decision row carries the chosen backend so a grep proves whether
        // the message went out via browser or native `say`.
        this.deps.log(
          'tts_decision',
          { ...composeDecisionLogData(m, ttsResult), backend },
        );
      } else {
        // Limiter blocked it — log a skip:rate-limited row (matches the
        // renderer's old notification rate-limit logging convention).
        backend = 'skip';
        this.deps.log('tts_decision', {
          ...composeDecisionLogData(m, { decision: 'skip', reason: 'rate-limited' as TtsDecisionReason }),
          backend,
        });
      }
    } else {
      // A gate suppressed it — log the gate's reason as-is.
      this.deps.log('tts_decision', composeDecisionLogData(m, ttsResult));
    }

    // --- Notification dispatch ---
    if (notifResult.decision === 'notify') {
      if (this.notifLimiter.tryConsume()) {
        this.deps.log('notification_decision', composeDecisionLogData(m, notifResult));
        // soundEnabled → silent is its inverse.
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
   * Pick the speak backend by window visibility and dispatch. Returns the
   * backend chosen. This is THE never-miss decision: genuinely-hidden →
   * native (renderer-independent); otherwise → browser (all settings honoured).
   */
  private dispatchSpeak(m: ChatMessage, settings: Settings): TtsBackendChoice {
    const text = composeUtteranceForDispatch(m, settings.tts.readSenderName);
    const hidden = this.deps.isWindowGenuinelyHidden();
    if (hidden) {
      // Genuinely hidden — Web Speech is suspended. Native `say` is immune to
      // renderer visibility, so this is the never-miss path. Volume flows via
      // the inline `[[volm]]` command in the native engine.
      this.deps.speakNative(text, {
        voice: settings.tts.voiceURI,
        rate: settings.tts.rate,
        volume: settings.tts.volume,
        messageId: m.id,
      });
      return 'native';
    }
    // Visible (or merely covered — occlusion disabled keeps it 'visible').
    // Use the browser voice so EVERY setting (volume, voice, rate, PITCH) is
    // honoured exactly as before v0.1.76.
    this.deps.speakBrowser({
      text,
      voiceURI: settings.tts.voiceURI,
      rate: settings.tts.rate,
      pitch: settings.tts.pitch,
      volume: settings.tts.volume,
      messageId: m.id,
    });
    return 'browser';
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
