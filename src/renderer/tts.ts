import type {
  ChatMessage,
  NativeVoiceWire,
  Settings,
  TtsNativeEnqueuePayload,
  TtsNativeSettingsPayload,
} from '../shared/types';

/**
 * Throttled Web Speech TTS engine.
 *
 * - Maintains a queue of pending utterances
 * - Honors max-per-minute rate limit (drop oldest if over the cap to keep TTS
 *   from spiraling during a chat raid)
 * - Allows the user to pick a system voice by URI
 *
 * v0.1.41 engine-wake layer (on TOP of v0.1.40 strong-ref + 60s watchdog)
 * ======================================================================
 *
 * Ethan screenshot 2026-05-19 16:26 reported: 5 rapid self-messages
 * ("hi" / "helo" / "poop" / "um" / "bro"), TTS read the first two and
 * silently dropped the next three. The v0.1.40 strong-ref + 60s watchdog
 * was supposed to cover this — and DID fix the GC-driven stall — but a
 * separate Chromium speechSynthesis quirk surfaced underneath:
 *
 *   After a successful utterance, Chromium's internal synthesis state
 *   machine can decide the engine is still "busy" if `onend` hasn't
 *   propagated yet, and silently swallow subsequent `speak()` calls
 *   without firing onstart/onend/onerror. The 60s watchdog eventually
 *   recovers, but by then the messages are stale and we've appeared
 *   broken to the user.
 *
 * v0.1.41 stacks a fast-recovery + prevention layer on top:
 *
 *   1. `cancel()` before every `speak()` — flushes stuck queue state,
 *      forces the engine to wake. Cheap on an idle engine; lifesaving
 *      when the engine is in the wedged-busy state.
 *
 *   2. ~8s keep-alive ping while no TTS in flight — fires a near-silent
 *      utterance (volume 0, ~1ms text) OR pause→resume nudge so the
 *      engine never goes dormant in the first place. Chromium dormancy
 *      kicks in around 10-15s of idle; we stay just under that.
 *
 *   3. Short onstart watchdog (~500ms) — if `onstart` doesn't fire within
 *      500ms of `speak()`, we treat the utterance as silently dropped,
 *      `cancel()` + re-`speak()` exactly once, and log the retry. This
 *      catches the "swallowed by busy engine" case before the user
 *      notices.
 *
 *   4. Auto-retry on `onerror` — Chromium's "interrupted" / "canceled"
 *      errors during rapid succession get one 100ms backoff retry.
 *
 *   5. Disk-persistent TTS event log — every speak_called / onstart /
 *      onend / onerror / watchdog_fired / keepalive_fired / cancel_called
 *      event lands in `~/Library/Logs/Restream Chat Plus Plus/
 *      tts-events.jsonl` via `window.rcpp.ttsLog`. When the next
 *      intermittent skip happens we have a single-file timeline.
 *
 * Throttle theory (Ethan voice): the maxPerMinute rate limit IS real
 * (default 20) but 5 messages in 1 minute is well below the cap. The
 * throttle is NOT the cause of this specific symptom — kept as-is.
 *
 * v0.1.40 multi-message-stall fix (still active, stacked under v0.1.41)
 * ====================================================================
 *
 * Ethan voice 3424 reported: "the first message it read out, subsequent
 * messages it didn't." Codex + Claude diagnosis pointed at two
 * compounding causes for the queue stalling after the first utterance:
 *
 *   1. The SpeechSynthesisUtterance was a function-local variable in
 *      `speak()` — no strong ref retained on the engine instance — so
 *      Chromium's GC could collect it mid-flight. When that happened,
 *      `utter.onend` never fired, `this.speaking` stayed `true` forever,
 *      and every subsequent `tick()` returned early with "already
 *      speaking, skipping."
 *
 *   2. Even with the ref retained, Web Speech on macOS is notoriously
 *      flaky — `onend` can fail to fire for opaque reasons unrelated to
 *      GC. So we add a watchdog timer (`SPEAK_WATCHDOG_MS`) that
 *      force-resets `speaking` if neither end nor error event arrives
 *      within the timeout. The queue self-recovers either way.
 *
 * Tests in `tts-multi-message.test.ts` exercise:
 *   - 5 consecutive `enqueue()` calls all reach `speak()` (the
 *     primary regression)
 *   - The watchdog drains the queue when `onend` never fires
 *   - `cancel()` resets the currentUtter ref + watchdog
 *
 * v0.1.23 latching-fix notes (supersedes v0.1.22)
 * ===============================================
 *
 * v0.1.22 fixed the FIRST-call silence but introduced a latching bug: the
 * preview played the first time, then was silent on every subsequent voice
 * pick / volume-slider release. Root cause:
 *
 *   - `updateSettings()` called `this.cancel()` whenever `enabled=false`
 *     (DEFAULT_SETTINGS.tts.enabled is `false` until the user opts in).
 *   - App.tsx fires `updateSettings()` synchronously BEFORE `previewVoice()`
 *     on every voice/volume change (patchTts → onChange → updateSettings, then
 *     onPreviewVoice in the same event handler).
 *   - `previewVoice()` THEN called `speechSynthesis.cancel()` again
 *     unconditionally.
 *   - Result: every preview after the first fired TWO `cancel()` calls on an
 *     IDLE engine. Real Electron 42 Chromium silently latches its internal
 *     synthesis queue when cancel() is called on an idle engine; subsequent
 *     speak() calls return without producing audio. (The fake speechSynthesis
 *     in tts-regression.test.ts didn't model the latch, so tests passed.)
 *
 * Fix: gate every `cancel()` behind `speechSynthesis.speaking || pending`.
 * Both `updateSettings()` (when disabling) and `previewVoice()` now skip the
 * cancel when the engine is idle and only fire it when there's actually a
 * live utterance to interrupt — which is the only case `cancel()` is needed
 * for. The setTimeout(speak, 100) defer + name-fallback resolve + resume-
 * before-cancel from v0.1.22 remain unchanged.
 *
 * v0.1.22 notes (still current, kept for context)
 * -----------------------------------------------
 *
 * v0.1.21 attempted three fixes but the unit tests in tts-regression.test.ts
 * used a fake `speechSynthesis` that didn't model Chromium's real behaviour;
 * in real Electron 42 Chromium the preview was still silent. v0.1.22:
 *
 *   1. **Microtask defer was too short.** `queueMicrotask` runs at the end of
 *      the current microtask checkpoint — still inside the same V8 task
 *      Chromium dispatched `cancel()` on. Chromium's speechSynthesis flushes
 *      the cancel state machine on the next *task* boundary, not the next
 *      microtask. Fix: use `setTimeout(..., 100)` to land the speak on a
 *      fresh task tick well after cancel has settled.
 *
 *   2. **The keep-alive ping was actively silencing previews.** v0.1.21 armed
 *      a 10s `pause(); resume();` interval on every utterance start. When the
 *      user wiggles the voice dropdown or volume slider, a previous preview's
 *      `clearKeepAlive()` and the new preview's `armKeepAlive()` could
 *      race against the engine's internal state, and in some Electron 42
 *      cases the pause/resume pair on the NEW utterance silenced it
 *      immediately. The Chromium long-utterance stall bug only matters for
 *      utterances >15s — chat messages are short, previews are short. Fix:
 *      remove the keep-alive entirely. We'll add it back later if and only
 *      if we ship long-form TTS.
 *
 *   3. **Voice URI matching.** On macOS Electron 42 some voice URIs round-trip
 *      with subtle differences between the option `value` written to the
 *      `<select>` and the URI on the live `SpeechSynthesisVoice`. If the URI
 *      lookup fails we now fall back to matching by name (the dropdown shows
 *      `${v.name} (${v.lang})` so we can derive it). If both fail we still
 *      speak — just with the system default voice — instead of going silent.
 *
 *   4. **Exhaustive runtime instrumentation.** Every entry point and every
 *      decision branch now logs to `console.log` with a `[tts]` prefix. So
 *      when this still doesn't work, DevTools console will tell us exactly
 *      which step is misbehaving. The logs are cheap and we leave them in;
 *      they help diagnose user-reported issues from the field.
 *
 *   5. **Resume before cancel, not after.** v0.1.21 called `cancel()` THEN
 *      checked `paused` and resumed before `speak()`. But if the engine
 *      latched paused mid-cancel, the cancel itself could be deferred. Fix:
 *      resume → cancel → speak.
 */

const LOG_PREFIX = '[tts]';
function log(...args: unknown[]) {
  // Use console.log so it shows even at default DevTools log level.
  // eslint-disable-next-line no-console
  console.log(LOG_PREFIX, ...args);
}

/**
 * Max wall-clock seconds the engine will trust an in-flight utterance
 * before treating it as silently failed and force-resetting the
 * `speaking` flag so the next queued message can be processed.
 *
 * Cap is generous (60s) since chat messages are short — most utterances
 * finish in <5s — but we want headroom for slow voices + long messages.
 * The watchdog ONLY fires when `utter.onend` AND `utter.onerror` both
 * fail to land within this window, which is the Bug-2 failure mode:
 * Electron 42 Chromium occasionally drops the end event after the FIRST
 * successful speak, leaving subsequent messages stuck in queue forever.
 */
const SPEAK_WATCHDOG_MS = 60_000;

/**
 * Fast-recovery watchdog for the v0.1.41 engine-wake layer. If `onstart`
 * doesn't fire within this window after `speak()`, we treat the utterance
 * as silently dropped (Chromium busy-state swallow) and force a
 * cancel + retry exactly once. 500ms is comfortably longer than any
 * realistic onstart latency (typically <50ms) but short enough that the
 * user doesn't perceive a gap.
 */
const ONSTART_WATCHDOG_MS = 500;

/**
 * Keep-alive cadence — fire a near-silent nudge every ~8s while idle
 * to stop Chromium's speechSynthesis from going dormant. Chromium tends
 * to dormant the engine after 10-15s of idle, so 8s gives us safety
 * margin without burning CPU.
 */
const KEEPALIVE_INTERVAL_MS = 8_000;

/**
 * Backoff before retrying after an `onerror` event. Chromium's
 * "interrupted" / "canceled" errors during rapid succession resolve
 * cleanly after a 100ms gap.
 */
const ERROR_RETRY_BACKOFF_MS = 100;

/**
 * Fire-and-forget bridge to the main-process JSONL persistent log.
 * Lives on `window.rcpp.ttsLog` (preload). Best-effort: if the bridge
 * isn't loaded (test environment, hot-reload race), we no-op so TTS
 * playback never breaks because of logging.
 */
function persistTtsEvent(event: string, data?: Record<string, unknown>): void {
  try {
    const rcpp = (
      typeof window !== 'undefined'
        ? (window as unknown as { rcpp?: { ttsLog?: (e: string, d?: Record<string, unknown>) => void } }).rcpp
        : undefined
    );
    rcpp?.ttsLog?.(event, data);
  } catch {
    /* never throw from logging */
  }
}

/**
 * v0.1.74 (Ethan voice 4407, 2026-05-30) — BACKGROUND-TTS FALLBACK, layer 4.
 * Refined in v0.1.75 to a LAST-RESORT SAFETY NET (Ethan prefers browser voice).
 * ===========================================================================
 *
 * Chromium SUSPENDS `window.speechSynthesis` while the page is genuinely
 * hidden. When that happens, speak() calls are silently swallowed (no
 * onstart/onend/onerror) — the message renders but is never voiced.
 *
 * BROWSER VOICE IS PREFERRED (v0.1.75): Ethan wants the in-app Web-Speech
 * voice even in the background, NOT the native `say` voice. The main process
 * disables Chromium's macOS occlusion feature
 * (`--disable-features=MacWebContentsOcclusion`, see src/main/main.ts), so a
 * window that is merely COVERED by other app windows keeps reporting
 * `document.visibilityState === 'visible'`. `isPageHidden()` therefore returns
 * FALSE for the covered-window case → the browser voice keeps speaking. That
 * is the common "background" scenario and it now uses Web Speech, honouring
 * the in-app volume slider (`say` has no volume knob — exactly why v0.1.44
 * made browser the default).
 *
 * NATIVE `say` IS THE SAFETY NET, NOT THE NORMAL BACKGROUND PATH: the
 * occlusion flag CANNOT rescue every state. A window that is MINIMISED, on
 * ANOTHER macOS Space, or whose app is HIDDEN via Cmd-H still reports
 * `document.hidden === true`, and Chromium HARD-SUSPENDS speechSynthesis in
 * those states — the browser voice genuinely cannot run there. For exactly
 * those genuinely-hidden states, `isPageHidden()` returns TRUE and the engine
 * forwards the utterance to the macOS-native `say(1)` path (driven from the
 * MAIN process via the `window.rcpp.ttsNative` IPC bridge). The native path is
 * a subprocess spawned outside the renderer, so renderer visibility is
 * irrelevant — it ALWAYS speaks. This guarantees a message is NEVER silently
 * dropped, even in the states the browser voice can't reach.
 *
 * Net result:
 *   - foreground                          → Web Speech (volume slider honoured)
 *   - covered by other windows            → Web Speech (PREFERRED; the common
 *                                            background case, kept visible by
 *                                            disabling occlusion)
 *   - minimised / other-Space / app-hidden → native `say` (LAST-RESORT net;
 *                                            browser voice truly can't run)
 */
function isPageHidden(): boolean {
  // `document.hidden` / `visibilityState !== 'visible'` is TRUE for genuinely
  // hidden states only: minimised, on another macOS Space, or app hidden via
  // Cmd-H. It is NOT true for a merely-COVERED window, because the main
  // process disables Chromium's occlusion feature (MacWebContentsOcclusion) —
  // a covered window stays 'visible', so this returns false and the browser
  // voice is used (Ethan's preferred background path). `visibilityState` is
  // the modern signal; we check both for older-Chromium safety. In a non-DOM/
  // test env we report "not hidden" so unit tests exercise the speechSynthesis
  // path unless they explicitly stub document.hidden.
  if (typeof document === 'undefined') return false;
  if (document.hidden === true) return true;
  if (typeof document.visibilityState === 'string') {
    return document.visibilityState !== 'visible';
  }
  return false;
}

/**
 * Grab the native `say` IPC bridge (`window.rcpp.ttsNative`), if present.
 * Returns undefined in test/non-Electron environments — callers fall back
 * to speechSynthesis when it's missing (best-effort: better to try the
 * possibly-suspended browser engine than to drop the message entirely).
 */
function getNativeBridgeForFallback():
  | {
      enqueue: (payload: TtsNativeEnqueuePayload) => void;
      cancel: () => void;
    }
  | undefined {
  if (typeof window === 'undefined') return undefined;
  return (
    window as unknown as {
      rcpp?: {
        ttsNative?: {
          enqueue: (payload: TtsNativeEnqueuePayload) => void;
          cancel: () => void;
        };
      };
    }
  ).rcpp?.ttsNative;
}

export class TTSEngine {
  private queue: ChatMessage[] = [];
  private speaking = false;
  private timestamps: number[] = []; // ms of recent spoken utterances
  private settings: Settings['tts'];
  /**
   * Strong reference to the in-flight utterance so the JS engine never
   * GCs it mid-flight. Bug-2 root cause (Codex + Claude diagnosis,
   * v0.1.40): without retaining the utter, Electron 42 Chromium can
   * drop `onend` after the FIRST successful playback, leaving
   * `this.speaking = true` forever and silently blocking every
   * subsequent `tick()` as "already speaking". Holding the utterance
   * here keeps it alive until we explicitly clear it on end/error.
   */
  private currentUtter: SpeechSynthesisUtterance | null = null;
  /**
   * Watchdog timer for Bug-2 belt-and-suspenders. Even with the utter
   * retained, Web Speech is notoriously flaky on macOS — `onend` can
   * still fail to fire for opaque reasons. When that happens we want
   * the queue to recover ON ITS OWN rather than waiting forever for an
   * event that never arrives. Fires `SPEAK_WATCHDOG_MS` after each
   * `speak()`, treats the utterance as ended, drains the queue.
   */
  private speakWatchdog: ReturnType<typeof setTimeout> | null = null;
  /**
   * Fast `onstart` watchdog (v0.1.41). Detects Chromium silently
   * swallowing a `speak()` call when its engine is in the wedged-busy
   * state. Fires ONSTART_WATCHDOG_MS after `speak()` if neither
   * `onstart` nor `onend` nor `onerror` has arrived — triggers exactly
   * one cancel + retry per utterance.
   */
  private onstartWatchdog: ReturnType<typeof setTimeout> | null = null;
  /**
   * Set true once `onstart` (or any settling event) fires for the
   * current utterance — disarms the onstart watchdog.
   */
  private currentUtterStarted = false;
  /**
   * Retry-count guard for the current utterance. Capped at 1 so we
   * don't loop forever if a voice is genuinely broken.
   */
  private currentUtterRetries = 0;
  /**
   * Keep-alive timer (v0.1.41) — fires periodic near-silent nudges
   * while no TTS is in flight to stop Chromium going dormant.
   */
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Pending `onerror` retry timer — cleared by `cancel()` so a retry
   * doesn't fire after the user disables TTS.
   */
  private errorRetryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(settings: Settings['tts']) {
    this.settings = settings;
    log('engine constructed', {
      enabled: settings.enabled,
      voiceURI: settings.voiceURI,
      volume: settings.volume,
      rate: settings.rate,
      pitch: settings.pitch,
    });
    if (settings.enabled) this.armKeepalive();
  }

  updateSettings(settings: Settings['tts']) {
    log('updateSettings', {
      enabled: settings.enabled,
      voiceURI: settings.voiceURI,
      volume: settings.volume,
      rate: settings.rate,
      pitch: settings.pitch,
    });
    const wasEnabled = this.settings.enabled;
    this.settings = settings;
    if (!settings.enabled) {
      this.queue = [];
      this.speaking = false;
      this.clearCurrentUtter();
      this.clearKeepalive();
      if (this.hasActiveSpeechSynthesis()) this.cancel();
    } else if (!wasEnabled) {
      // Re-enabling — bring back the keep-alive nudge.
      this.armKeepalive();
    }
  }

  enqueue(message: ChatMessage) {
    log('enqueue', { id: message.id, enabled: this.settings.enabled });
    if (!this.settings.enabled) {
      log('enqueue: dropped — TTS disabled');
      return;
    }
    if (typeof window === 'undefined' || !window.speechSynthesis) {
      log('enqueue: dropped — no window.speechSynthesis');
      return;
    }
    this.queue.push(message);
    while (this.queue.length > 50) this.queue.shift();
    this.tick();
  }

  cancel() {
    log('cancel');
    persistTtsEvent('cancel_called', { queuedAtCancel: this.queue.length });
    this.queue = [];
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
    this.speaking = false;
    this.clearCurrentUtter();
    this.clearErrorRetryTimer();
  }

  voices(): SpeechSynthesisVoice[] {
    if (typeof window === 'undefined' || !window.speechSynthesis) return [];
    return window.speechSynthesis.getVoices();
  }

  // -------------------------------------------------------------------- impl

  private tick() {
    if (this.speaking) {
      log('tick: already speaking, skipping');
      return;
    }
    if (this.queue.length === 0) return;
    this.pruneTimestamps();
    if (this.timestamps.length >= this.settings.maxPerMinute) {
      const oldest = this.timestamps[0];
      const waitMs = Math.max(50, oldest + 60_000 - Date.now());
      log('tick: rate-limited, waiting', { waitMs });
      setTimeout(() => this.tick(), waitMs);
      return;
    }
    const next = this.queue.shift();
    if (!next) return;
    this.speak(next);
  }

  private speak(m: ChatMessage) {
    const text = composeUtterance(m, this.settings.readSenderName);
    log('speak (chat message)', { text, voiceURI: this.settings.voiceURI });
    persistTtsEvent('speak_called', {
      message_id: m.id,
      platform: m.platform,
      retry: 0,
    });
    // Pause the keep-alive so it doesn't fire concurrent with real speech.
    this.clearKeepalive();
    this.currentUtterRetries = 0;

    // v0.1.74/v0.1.75 BACKGROUND-TTS SAFETY NET (layer 4): if the page is
    // GENUINELY hidden (minimised / another Space / app hidden via Cmd-H —
    // NOT merely covered, which the occlusion-disable flag keeps 'visible'),
    // Chromium has suspended `window.speechSynthesis` and any speak() we issue
    // will be silently swallowed — the message would render but never be
    // voiced. Only in that genuinely-hidden case do we route through the
    // native main-process `say` bridge instead, which is immune to renderer
    // visibility. The common covered-window background case never reaches here
    // (isPageHidden() returns false) so it keeps using the BROWSER voice that
    // Ethan prefers. We still mark the utterance as
    // "spoken" for throttle bookkeeping (push the timestamp) and immediately
    // advance the queue, because the native bridge is fire-and-forget (no
    // onend handshake back into this engine) — the main-process queue
    // serialises the actual `say` subprocesses on its own.
    if (this.trySpeakViaNativeWhileHidden(m, text)) {
      // pruneTimestamps already ran in tick(); record this utterance so the
      // maxPerMinute rate-limit still applies to background speech.
      this.timestamps.push(Date.now());
      this.speaking = false;
      // Drain the next queued message on a fresh tick; re-arm keepalive if
      // the queue is now empty so the foreground engine stays warm for when
      // the window comes back to the front.
      setTimeout(() => {
        this.tick();
        if (!this.speaking && this.queue.length === 0 && this.settings.enabled) {
          this.armKeepalive();
        }
      }, 50);
      return;
    }

    this.speakUtterance(m, text, 0);
  }

  /**
   * v0.1.74 — background fallback. Returns true if it handled the message
   * by forwarding it to the native `say` bridge (because the page is hidden
   * AND the bridge exists); false if the caller should proceed with the
   * normal speechSynthesis path.
   *
   * Defensive: any failure (bridge throws, etc.) returns false so we fall
   * back to attempting speechSynthesis rather than silently dropping the
   * message. The whole point of this fix is that a message can NEVER be
   * silently lost.
   */
  private trySpeakViaNativeWhileHidden(m: ChatMessage, text: string): boolean {
    if (!isPageHidden()) return false;
    const bridge = getNativeBridgeForFallback();
    if (!bridge) {
      // No native bridge (non-Electron / test env). Can't fall back; let the
      // (possibly-suspended) speechSynthesis path try anyway — better than
      // dropping the message outright.
      log('speak: page hidden but no native bridge — using speechSynthesis');
      return false;
    }
    try {
      log('speak: page hidden — routing via native `say` bridge', { id: m.id });
      persistTtsEvent('background_native_fallback', {
        message_id: m.id,
        platform: m.platform,
      });
      bridge.enqueue({
        text,
        voice: this.settings.voiceURI,
        rate: this.settings.rate,
        volume: this.settings.volume,
        messageId: m.id,
      });
      return true;
    } catch (err) {
      // Bridge failed — fall through to speechSynthesis as last resort.
      log('speak: native bridge threw — falling back to speechSynthesis', { err });
      return false;
    }
  }

  /**
   * Inner speak path — split out so the onstart watchdog + onerror
   * handlers can retry the same logical message without re-running the
   * outer queue bookkeeping (timestamps, keepalive clear).
   *
   * The `retry` arg is 0 for the original attempt, 1 for the
   * single allowed retry triggered by either the onstart watchdog or
   * an onerror event.
   */
  private speakUtterance(m: ChatMessage, text: string, retry: number) {
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = this.settings.rate;
    utter.pitch = this.settings.pitch;
    utter.volume = this.settings.volume;
    const voice = this.resolveVoice(this.settings.voiceURI);
    if (voice) utter.voice = voice;
    this.speaking = true;
    if (retry === 0) {
      this.timestamps.push(Date.now());
    }
    // Retain a strong ref to the utterance for the lifetime of this
    // playback so the JS engine can't GC it out from under
    // SpeechSynthesis (Bug-2 root cause, see field comment above).
    this.currentUtter = utter;
    this.currentUtterStarted = false;

    const onDone = (reason: 'end' | 'error' | 'watchdog', detail?: unknown) => {
      // Guard against late events firing AFTER the watchdog already
      // marked this utterance done — we only want to advance the queue
      // ONCE per utterance.
      if (this.currentUtter !== utter) {
        log('onDone fired but currentUtter has already moved on', { reason });
        return;
      }
      log(`utter.${reason} (chat)`, detail !== undefined ? { detail } : undefined);
      this.speaking = false;
      this.clearCurrentUtter();
      if (reason === 'end') {
        persistTtsEvent('onend', { message_id: m.id, retry });
      } else if (reason === 'watchdog') {
        persistTtsEvent('watchdog_fired', {
          message_id: m.id,
          retry,
          phase: 'speak',
        });
      }
      // Drain next message; re-arm keepalive if queue is empty.
      setTimeout(() => {
        this.tick();
        if (!this.speaking && this.queue.length === 0 && this.settings.enabled) {
          this.armKeepalive();
        }
      }, 50);
    };

    utter.onstart = () => {
      log('utter.onstart (chat)');
      this.currentUtterStarted = true;
      this.clearOnstartWatchdog();
      persistTtsEvent('onstart', { message_id: m.id, retry });
    };
    utter.onend = () => onDone('end');
    utter.onerror = (e) => {
      const err = (e as SpeechSynthesisErrorEvent).error;
      persistTtsEvent('onerror', {
        message_id: m.id,
        retry,
        error: typeof err === 'string' ? err : String(err),
      });
      // Auto-retry once on Chromium "interrupted" / "canceled" — these
      // show up during rapid succession because cancel-before-speak
      // races the previous utterance's tail. A 100ms backoff resolves
      // cleanly.
      if (this.currentUtter === utter && retry === 0) {
        log('utter.onerror — scheduling retry', { error: err });
        this.speaking = false;
        this.clearCurrentUtter();
        this.clearErrorRetryTimer();
        this.errorRetryTimer = setTimeout(() => {
          this.errorRetryTimer = null;
          if (!this.settings.enabled) return;
          persistTtsEvent('speak_called', {
            message_id: m.id,
            retry: 1,
            reason: 'onerror_retry',
          });
          this.speakUtterance(m, text, 1);
        }, ERROR_RETRY_BACKOFF_MS);
        return;
      }
      onDone('error', err);
    };

    // 60s belt-and-suspenders watchdog (v0.1.40) — only fires if
    // onend/onerror never arrive at all. ALSO armed on retries so a
    // wedged retry can't stall forever.
    this.clearSpeakWatchdog();
    this.speakWatchdog = setTimeout(() => {
      onDone('watchdog');
    }, SPEAK_WATCHDOG_MS);

    // 500ms onstart watchdog (v0.1.41) — only on the FIRST attempt.
    // If onstart hasn't fired by then, Chromium silently swallowed
    // the speak. Cancel + re-issue exactly once.
    this.clearOnstartWatchdog();
    if (retry === 0) {
      this.onstartWatchdog = setTimeout(() => {
        if (this.currentUtter !== utter) return;
        if (this.currentUtterStarted) return;
        log('utter.onstart watchdog fired — cancel+retry');
        persistTtsEvent('onstart_watchdog_retry', { message_id: m.id });
        this.currentUtterRetries = 1;
        // Clear the per-utter state without advancing the queue.
        this.speaking = false;
        this.clearCurrentUtter();
        try {
          if (typeof window !== 'undefined' && window.speechSynthesis) {
            window.speechSynthesis.cancel();
          }
        } catch {
          /* defensive — cancel should never throw */
        }
        this.speakUtterance(m, text, 1);
      }, ONSTART_WATCHDOG_MS);
    }

    // Engine-wake recipe (v0.1.41):
    //   1. Lift latched-paused state.
    //   2. cancel() — flushes stuck queue state, forces engine wake.
    //      Cheap on idle engine, lifesaving when busy-wedged.
    //   3. speak().
    if (window.speechSynthesis.paused) {
      log('speak: engine paused — resuming first');
      window.speechSynthesis.resume();
    }
    try {
      window.speechSynthesis.cancel();
    } catch {
      /* defensive */
    }
    log('speak: calling window.speechSynthesis.speak()', {
      paused: window.speechSynthesis.paused,
      speaking: window.speechSynthesis.speaking,
      pending: window.speechSynthesis.pending,
      retry,
    });
    window.speechSynthesis.speak(utter);
  }

  /**
   * Arm the keep-alive nudge interval. Fires a near-silent
   * `SpeechSynthesisUtterance` (volume 0, single space) every
   * KEEPALIVE_INTERVAL_MS while no real TTS is in flight. Stops the
   * Chromium engine going dormant after 10-15s idle, which was one of
   * the two compounding failure modes for v0.1.41.
   *
   * Safe to call repeatedly — clears any existing timer first.
   */
  private armKeepalive(): void {
    if (typeof window === 'undefined' || !window.speechSynthesis) return;
    this.clearKeepalive();
    this.keepaliveTimer = setInterval(() => {
      // Only nudge when we're genuinely idle — never interfere with a
      // real utterance.
      if (this.speaking) return;
      if (this.currentUtter !== null) return;
      try {
        const synth = window.speechSynthesis;
        if (synth.speaking || synth.pending) return;
        persistTtsEvent('keepalive_fired');
        // Cheapest possible nudge: pause+resume on an idle engine.
        // This is enough to reset Chromium's dormant timer without
        // emitting audio. We do NOT speak a real utterance because
        // each one re-enters the speak path + watchdogs.
        if (synth.paused) {
          synth.resume();
        } else {
          synth.pause();
          synth.resume();
        }
      } catch {
        /* never throw from keepalive */
      }
    }, KEEPALIVE_INTERVAL_MS);
  }

  private clearKeepalive(): void {
    if (this.keepaliveTimer !== null) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  private clearOnstartWatchdog(): void {
    if (this.onstartWatchdog !== null) {
      clearTimeout(this.onstartWatchdog);
      this.onstartWatchdog = null;
    }
  }

  private clearErrorRetryTimer(): void {
    if (this.errorRetryTimer !== null) {
      clearTimeout(this.errorRetryTimer);
      this.errorRetryTimer = null;
    }
  }

  private clearCurrentUtter(): void {
    this.currentUtter = null;
    this.currentUtterStarted = false;
    this.clearSpeakWatchdog();
    this.clearOnstartWatchdog();
  }

  private clearSpeakWatchdog(): void {
    if (this.speakWatchdog !== null) {
      clearTimeout(this.speakWatchdog);
      this.speakWatchdog = null;
    }
  }

  /**
   * Play a one-off preview utterance for the given voice URI. Cancels any
   * in-flight preview / queued chat utterances so rapid voice-dropdown
   * changes don't pile up. Bypasses the queue + rate-limit because preview
   * is a UI affordance, not chat playback. Returns the utterance text that
   * was spoken (for tests / debugging).
   *
   * v0.1.22 fix: defer speak() on a 100ms `setTimeout` (not `queueMicrotask`)
   * because Chromium's cancel state machine settles on a TASK boundary, not
   * a microtask boundary. The keep-alive ping has been removed entirely.
   */
  previewVoice(voiceURI: string | undefined): string {
    log('previewVoice', { voiceURI });
    if (typeof window === 'undefined' || !window.speechSynthesis) {
      log('previewVoice: bailed — no window.speechSynthesis');
      return '';
    }

    // Resume FIRST so cancel() lands on a non-paused engine.
    if (window.speechSynthesis.paused) {
      log('previewVoice: engine was paused — resuming');
      window.speechSynthesis.resume();
    }

    // Cancel active speech so rapid switching doesn't queue overlaps, but do
    // not cancel an idle Chromium engine: Electron 42 can latch silent after
    // idle cancel() calls.
    this.queue = [];
    this.speaking = false;
    const shouldCancel = window.speechSynthesis.speaking || window.speechSynthesis.pending;
    log(shouldCancel ? 'previewVoice: calling cancel()' : 'previewVoice: skipping cancel() — engine idle', {
      paused: window.speechSynthesis.paused,
      speaking: window.speechSynthesis.speaking,
      pending: window.speechSynthesis.pending,
    });
    if (shouldCancel) window.speechSynthesis.cancel();

    const voice = this.resolveVoice(voiceURI);
    const displayName = voice?.name ?? 'system default';
    const text = `Hello, my name is ${displayName}`;
    log('previewVoice: built utterance', {
      text,
      voiceName: voice?.name,
      voiceURI: voice?.voiceURI,
      requestedURI: voiceURI,
      volume: this.settings.volume,
      rate: this.settings.rate,
      pitch: this.settings.pitch,
    });
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = this.settings.rate;
    utter.pitch = this.settings.pitch;
    utter.volume = this.settings.volume;
    if (voice) utter.voice = voice;
    utter.onstart = () => log('utter.onstart (preview)');
    utter.onend = () => log('utter.onend (preview)');
    utter.onerror = (e) =>
      log('utter.onerror (preview)', { error: (e as SpeechSynthesisErrorEvent).error });

    // Defer the speak() to a 100ms task. queueMicrotask wasn't enough —
    // Chromium's cancel state machine flushes on the next task boundary,
    // not the next microtask. 100ms is safe slack without feeling laggy.
    setTimeout(() => {
      if (typeof window === 'undefined' || !window.speechSynthesis) {
        log('previewVoice (deferred): bailed — no window.speechSynthesis');
        return;
      }
      // Final paranoia: lift paused one more time (cancel can re-pause some
      // Chromium builds).
      if (window.speechSynthesis.paused) {
        log('previewVoice (deferred): engine paused — resuming');
        window.speechSynthesis.resume();
      }
      log('previewVoice (deferred): calling window.speechSynthesis.speak()', {
        paused: window.speechSynthesis.paused,
        speaking: window.speechSynthesis.speaking,
        pending: window.speechSynthesis.pending,
        utterText: utter.text,
        utterVolume: utter.volume,
        utterVoice: utter.voice?.name,
      });
      window.speechSynthesis.speak(utter);
    }, 100);

    return text;
  }

  /**
   * Resolve a voice by URI, with a name-fallback for Electron 42 macOS quirks
   * where the URI persisted in settings can drift from the live URI. Logs
   * the resolution path so DevTools shows whether the URI matched, the name
   * matched, or we fell back to system default.
   */
  private resolveVoice(voiceURI: string | undefined): SpeechSynthesisVoice | undefined {
    if (!voiceURI) {
      log('resolveVoice: no URI — using system default');
      return undefined;
    }
    const all = this.voices();
    log('resolveVoice: voices loaded', { count: all.length });
    if (all.length === 0) {
      log('resolveVoice: voices array EMPTY — Chromium not ready yet');
      return undefined;
    }
    const byURI = all.find((v) => v.voiceURI === voiceURI);
    if (byURI) {
      log('resolveVoice: matched by URI', { name: byURI.name, lang: byURI.lang });
      return byURI;
    }
    // Fallback: the dropdown value is the URI, but if Electron mangled it,
    // try a name match against the URI string (some platforms use the name
    // verbatim as the URI).
    const byName = all.find((v) => v.name === voiceURI || v.voiceURI.endsWith(voiceURI));
    if (byName) {
      log('resolveVoice: matched by name fallback', { name: byName.name, lang: byName.lang });
      return byName;
    }
    log('resolveVoice: NO MATCH for', voiceURI, '— using system default. Available URIs:', all.map((v) => v.voiceURI));
    return undefined;
  }

  private pruneTimestamps() {
    const cutoff = Date.now() - 60_000;
    while (this.timestamps.length > 0 && this.timestamps[0] < cutoff) {
      this.timestamps.shift();
    }
  }

  private hasActiveSpeechSynthesis(): boolean {
    if (typeof window === 'undefined' || !window.speechSynthesis) return false;
    return window.speechSynthesis.speaking || window.speechSynthesis.pending;
  }
}

/**
 * Build the string the synthesizer should speak for a given chat message.
 * Exported (DOM-free) so the name-toggle behaviour can be unit-tested.
 *
 * - readSenderName=true  → "alice says hello world" (legacy behaviour)
 * - readSenderName=false → "hello world" (default in v0.1.9+)
 */
export function composeUtterance(m: ChatMessage, readSenderName: boolean): string {
  if (readSenderName) return `${m.username} says ${m.text}`;
  return m.text;
}

/**
 * Quality "tier" for a Web Speech voice — lower number = better quality, sort
 * to the top of the picker. The Web Speech API doesn't expose a quality flag,
 * so we infer from `voice.name`. macOS in particular labels its modern voices
 * with markers like "Premium", "Enhanced", "Neural", and "(Eloquence)"; the
 * older robotic novelty voices (Albert, Bahh, Bells, Bubbles, Cellos, …) ship
 * unadorned. Sort by:
 *   0 — Premium / Enhanced  (downloaded high-quality voices)
 *   1 — Neural / Natural    (newer system voices, e.g. Siri-family)
 *   2 — Siri / Apple system flagship voices that don't carry an explicit tier
 *   3 — Eloquence variants  (modern accessibility voices, decent quality)
 *   4 — Everything else     (Albert, Bahh, etc. — bottom of the list)
 *
 * Within a tier we secondary-sort by name (locale-aware) so the list is stable.
 */
export function voiceQualityRank(v: Pick<SpeechSynthesisVoice, 'name'>): number {
  const name = v.name.toLowerCase();
  if (name.includes('premium') || name.includes('enhanced')) return 0;
  if (name.includes('neural') || name.includes('natural')) return 1;
  if (name.includes('siri')) return 2;
  if (name.includes('eloquence')) return 3;
  return 4;
}

/** Pure helper: return a new array of voices sorted quality-first, then name. */
export function sortVoicesByQuality<V extends Pick<SpeechSynthesisVoice, 'name'>>(voices: readonly V[]): V[] {
  return [...voices].sort((a, b) => {
    const r = voiceQualityRank(a) - voiceQualityRank(b);
    if (r !== 0) return r;
    return a.name.localeCompare(b.name);
  });
}

// ============================================================================
// v0.1.42 — engine abstraction + native-`say` IPC client
// ============================================================================
//
// Through v0.1.41 the renderer drove playback directly via the
// `window.speechSynthesis` API encapsulated in `TTSEngine`. v0.1.42 adds a
// second backend — the macOS-native `say` CLI driven from the main process
// via IPC — and a thin polymorphic surface so `App.tsx` can swap engines
// at runtime without sprouting branches at every call site.
//
// The contract is `TtsEngineLike` below: just the methods App.tsx needs
// (enqueue + updateSettings + cancel + voices + previewVoice). Both
// engines satisfy it. `makeTtsEngine` picks one based on
// `settings.tts.engine`.
//
// Why a SECOND engine class instead of branching inside TTSEngine?
//   - Browser engine has a lot of Chromium-specific defensive scaffolding
//     (strong-ref, 60s watchdog, cancel-before-speak, 8s keep-alive,
//     500ms onstart watchdog, onerror retry). None of that applies to
//     `say`. Folding both paths into one class would bloat it and re-
//     create the kind of "is it browser or native?" branching we're
//     trying to avoid.
//   - The native engine is essentially a thin IPC stub — all real logic
//     lives in `src/main/tts-native.ts`. Clean separation makes the
//     renderer test surface tiny and lets the main-process module be
//     unit-tested without DOM globals.

/**
 * Bridge shape provided by the preload (`window.rcpp.ttsNative`) when the
 * renderer is running inside Electron. Optional — when undefined (test
 * environment, hot-reload race) the native engine silently no-ops so a
 * misconfigured environment can't crash the renderer.
 */
interface NativeTtsBridge {
  enqueue(payload: TtsNativeEnqueuePayload): void;
  cancel(): void;
  updateSettings(payload: TtsNativeSettingsPayload): void;
  getVoices(): Promise<NativeVoiceWire[]>;
}

function getNativeBridge(): NativeTtsBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { rcpp?: { ttsNative?: NativeTtsBridge } }).rcpp?.ttsNative;
}

/**
 * Common surface implemented by both `TTSEngine` (browser/Web Speech) and
 * `NativeTtsEngine` (macOS `say` via IPC). App.tsx + SettingsDrawer talk
 * to this interface; the factory swaps the underlying implementation.
 *
 * `voices()` returns the browser-side voice list for the browser engine
 * and an empty array for the native engine (callers use
 * `getNativeVoices()` for the native list — different shape, so we keep
 * them in distinct methods).
 *
 * `previewVoice()` returns the utterance text that was spoken so tests
 * can assert on it without spinning up real audio.
 */
export interface TtsEngineLike {
  enqueue(message: ChatMessage): void;
  cancel(): void;
  updateSettings(settings: Settings['tts']): void;
  voices(): SpeechSynthesisVoice[];
  previewVoice(voiceURI: string | undefined): string;
}

/**
 * Renderer-side native engine. The actual queue + spawn lives in the
 * main process (`src/main/tts-native.ts`); this class is a thin IPC
 * wrapper that translates `enqueue` / `cancel` / `updateSettings` into
 * the corresponding `window.rcpp.ttsNative.*` calls.
 *
 * `voices()` returns `[]` deliberately — the SpeechSynthesisVoice type
 * doesn't match the `say` voice list (the lang separator is different
 * and `voiceURI` doesn't apply). The Settings drawer detects this at
 * render time and pulls the native list via `getNativeVoices()` instead.
 *
 * `previewVoice()` enqueues a sample utterance — same UX as the browser
 * engine's preview, but driven through the native pipe. Returns the
 * sample text so the caller / tests can match on it.
 */
export class NativeTtsEngine implements TtsEngineLike {
  private settings: Settings['tts'];
  /** Same throttle math as the browser engine — applied client-side. */
  private timestamps: number[] = [];
  /** Cached `say -v "?"` list once requested. Refreshed when `voices()` is called. */
  private cachedNativeVoices: NativeVoiceWire[] | undefined;
  /** Outstanding voice-list fetch — dedupes concurrent calls during settings open. */
  private nativeVoicesInflight: Promise<NativeVoiceWire[]> | undefined;

  constructor(settings: Settings['tts']) {
    this.settings = settings;
    log('native engine constructed', {
      enabled: settings.enabled,
      voiceURI: settings.voiceURI,
      rate: settings.rate,
      volume: settings.volume,
    });
    // Push the initial slice so main has a defined voice/rate before the
    // first enqueue. Best-effort.
    this.pushSettings();
  }

  updateSettings(settings: Settings['tts']): void {
    const wasEnabled = this.settings.enabled;
    this.settings = settings;
    if (!settings.enabled && wasEnabled) {
      // Disabling clears the in-flight subprocess + queue immediately.
      this.cancel();
    }
    this.pushSettings();
  }

  enqueue(message: ChatMessage): void {
    if (!this.settings.enabled) return;
    // Rate-limit client-side — same maxPerMinute semantics as the browser
    // engine. Avoids a chat raid spawning hundreds of `say` subprocesses
    // that queue for minutes.
    this.pruneTimestamps();
    if (this.timestamps.length >= this.settings.maxPerMinute) {
      log('native enqueue: rate-limited, dropping', { id: message.id });
      return;
    }
    this.timestamps.push(Date.now());
    const text = composeUtterance(message, this.settings.readSenderName);
    const bridge = getNativeBridge();
    if (!bridge) {
      log('native enqueue: bridge missing — dropping', { id: message.id });
      return;
    }
    bridge.enqueue({
      text,
      voice: this.settings.voiceURI,
      rate: this.settings.rate,
      volume: this.settings.volume,
      messageId: message.id,
    });
  }

  cancel(): void {
    const bridge = getNativeBridge();
    bridge?.cancel();
  }

  /**
   * Browser-style voice list. Returns `[]` for the native engine — the
   * Settings drawer reads the native voice list via `getNativeVoices()`
   * (different wire shape, different lang separator) and renders that
   * instead when `engine === 'native'`.
   */
  voices(): SpeechSynthesisVoice[] {
    return [];
  }

  /**
   * Fetch the `say -v "?"` list. Cached after first call for the
   * lifetime of this engine instance; the Settings drawer is the only
   * caller and one fetch per open is plenty.
   */
  async getNativeVoices(): Promise<NativeVoiceWire[]> {
    if (this.cachedNativeVoices) return this.cachedNativeVoices;
    if (this.nativeVoicesInflight) return this.nativeVoicesInflight;
    const bridge = getNativeBridge();
    if (!bridge) return [];
    this.nativeVoicesInflight = bridge.getVoices().then((vs) => {
      this.cachedNativeVoices = vs;
      this.nativeVoicesInflight = undefined;
      return vs;
    });
    return this.nativeVoicesInflight;
  }

  /**
   * Speak a sample phrase via `say` so the user can hear a voice before
   * committing. Bypasses the queue (we explicitly `cancel()` first so
   * rapid voice-dropdown changes don't pile up overlapping samples).
   * Returns the spoken text so tests can match on it without audio.
   */
  previewVoice(voiceURI: string | undefined): string {
    const displayName = voiceURI ?? 'system default';
    const text = `Hello, my name is ${displayName}`;
    const bridge = getNativeBridge();
    if (!bridge) return text;
    bridge.cancel();
    bridge.enqueue({
      text,
      voice: voiceURI,
      rate: this.settings.rate,
      volume: this.settings.volume,
    });
    return text;
  }

  private pruneTimestamps(): void {
    const cutoff = Date.now() - 60_000;
    while (this.timestamps.length > 0 && this.timestamps[0] < cutoff) {
      this.timestamps.shift();
    }
  }

  private pushSettings(): void {
    const bridge = getNativeBridge();
    bridge?.updateSettings({
      voiceURI: this.settings.voiceURI,
      rate: this.settings.rate,
      volume: this.settings.volume,
    });
  }
}

/**
 * Factory — returns a `TTSEngine` or a `NativeTtsEngine` depending on
 * the user's engine preference. Called from App.tsx on mount and after
 * every Settings push so the live engine matches the live setting.
 *
 * On settings change between browser ↔ native, App.tsx tears down the
 * old engine via `cancel()` and constructs a new one through this
 * factory — the swap is cheap (no audio device handle to negotiate;
 * just a queue + IPC plumbing).
 */
export function makeTtsEngine(settings: Settings['tts']): TtsEngineLike {
  if (settings.engine === 'native') return new NativeTtsEngine(settings);
  return new TTSEngine(settings);
}

// Export for unit testing the rate-limit math without DOM dependencies.
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
