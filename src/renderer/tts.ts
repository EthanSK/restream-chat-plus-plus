import type { ChatMessage, Settings } from '../shared/types';

/**
 * Throttled Web Speech TTS engine.
 *
 * - Maintains a queue of pending utterances
 * - Honors max-per-minute rate limit (drop oldest if over the cap to keep TTS
 *   from spiraling during a chat raid)
 * - Allows the user to pick a system voice by URI
 *
 * v0.1.40 multi-message-stall fix
 * ===============================
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

  constructor(settings: Settings['tts']) {
    this.settings = settings;
    log('engine constructed', {
      enabled: settings.enabled,
      voiceURI: settings.voiceURI,
      volume: settings.volume,
      rate: settings.rate,
      pitch: settings.pitch,
    });
  }

  updateSettings(settings: Settings['tts']) {
    log('updateSettings', {
      enabled: settings.enabled,
      voiceURI: settings.voiceURI,
      volume: settings.volume,
      rate: settings.rate,
      pitch: settings.pitch,
    });
    this.settings = settings;
    if (!settings.enabled) {
      this.queue = [];
      this.speaking = false;
      this.clearCurrentUtter();
      if (this.hasActiveSpeechSynthesis()) this.cancel();
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
    this.queue = [];
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
    this.speaking = false;
    this.clearCurrentUtter();
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
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = this.settings.rate;
    utter.pitch = this.settings.pitch;
    utter.volume = this.settings.volume;
    const voice = this.resolveVoice(this.settings.voiceURI);
    if (voice) utter.voice = voice;
    this.speaking = true;
    this.timestamps.push(Date.now());
    // Retain a strong ref to the utterance for the lifetime of this
    // playback so the JS engine can't GC it out from under
    // SpeechSynthesis (Bug-2 root cause, see field comment above).
    this.currentUtter = utter;

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
      setTimeout(() => this.tick(), 50);
    };

    utter.onstart = () => log('utter.onstart (chat)');
    utter.onend = () => onDone('end');
    utter.onerror = (e) =>
      onDone('error', (e as SpeechSynthesisErrorEvent).error);

    // Watchdog: if neither onend nor onerror fires within
    // SPEAK_WATCHDOG_MS, treat the utterance as ended so we can move
    // on to the next queued message. This guards against the Electron
    // 42 Chromium quirk where `onend` is silently dropped after the
    // first successful playback, which was the v0.1.40 Bug-2 root cause
    // (Codex + Claude diagnosis).
    this.clearSpeakWatchdog();
    this.speakWatchdog = setTimeout(() => {
      onDone('watchdog');
    }, SPEAK_WATCHDOG_MS);

    // Lift latched paused state BEFORE cancel/speak (note #5 above).
    if (window.speechSynthesis.paused) {
      log('speak: engine paused — resuming first');
      window.speechSynthesis.resume();
    }
    log('speak: calling window.speechSynthesis.speak()', {
      paused: window.speechSynthesis.paused,
      speaking: window.speechSynthesis.speaking,
      pending: window.speechSynthesis.pending,
    });
    window.speechSynthesis.speak(utter);
  }

  private clearCurrentUtter(): void {
    this.currentUtter = null;
    this.clearSpeakWatchdog();
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
