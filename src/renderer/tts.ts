import type { ChatMessage, Settings } from '../shared/types';

/**
 * Throttled Web Speech TTS engine.
 *
 * - Maintains a queue of pending utterances
 * - Honors max-per-minute rate limit (drop oldest if over the cap to keep TTS
 *   from spiraling during a chat raid)
 * - Allows the user to pick a system voice by URI
 *
 * v0.1.21 regression-fix notes
 * ============================
 *
 * Both the preview path (voice-picker change, volume-slider release) and the
 * incoming-message path went silent in <=v0.1.18. Three Chromium / Web Speech
 * quirks compounded:
 *
 *   1. `speechSynthesis.cancel()` is asynchronous in the engine's internal
 *      state machine. Calling `speak()` synchronously after `cancel()` can
 *      cause Chromium to silently drop the new utterance. This was the
 *      preview-silence root cause — `previewVoice()` did exactly that. Fix:
 *      defer the `speak()` to the next microtask (queueMicrotask) so the
 *      cancel state settles before we enqueue the new utterance.
 *
 *   2. `speechSynthesis.paused` can latch to `true` and stick there after
 *      certain transitions (window blur, system audio device change, the
 *      cancel-speak race in #1). Once paused, every subsequent `speak()`
 *      is silently queued into the paused queue — utterances stack up but
 *      none ever speak. This was the incoming-message silence root cause:
 *      a misfired preview earlier in the session left the engine paused,
 *      and every chat message after that went into the paused queue. Fix:
 *      always `speechSynthesis.resume()` before `speak()` and re-arm the
 *      paused state if it latches mid-utterance.
 *
 *   3. Chromium has a long-standing bug where `speechSynthesis` stops
 *      responding entirely if a single utterance runs longer than ~15s OR
 *      if the renderer is left idle for several minutes. The standard
 *      workaround is a periodic `pause(); resume();` keep-alive ping while
 *      a speak is in flight. Fix: arm an interval ping when an utterance
 *      starts, clear it on end/error.
 *
 * The three fixes are independent and each pins a separate observed
 * symptom; tests in tts-regression.test.ts exercise each one.
 */
export class TTSEngine {
  private queue: ChatMessage[] = [];
  private speaking = false;
  private timestamps: number[] = []; // ms of recent spoken utterances
  private settings: Settings['tts'];
  /**
   * Chromium keep-alive interval handle (see note #3 above). Armed in
   * `speak()` / `previewVoice()` on `onstart`, cleared on `onend` / `onerror`.
   * Stored on the instance so tests can assert it's cleared cleanly.
   */
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;

  constructor(settings: Settings['tts']) {
    this.settings = settings;
  }

  updateSettings(settings: Settings['tts']) {
    this.settings = settings;
    if (!settings.enabled) this.cancel();
  }

  enqueue(message: ChatMessage) {
    if (!this.settings.enabled) return;
    if (typeof window === 'undefined' || !window.speechSynthesis) return;
    this.queue.push(message);
    // Cap queue size so a raid can't blow memory.
    while (this.queue.length > 50) this.queue.shift();
    this.tick();
  }

  cancel() {
    this.queue = [];
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
    this.speaking = false;
    this.clearKeepAlive();
  }

  voices(): SpeechSynthesisVoice[] {
    if (typeof window === 'undefined' || !window.speechSynthesis) return [];
    return window.speechSynthesis.getVoices();
  }

  // -------------------------------------------------------------------- impl

  private tick() {
    if (this.speaking) return;
    if (this.queue.length === 0) return;
    this.pruneTimestamps();
    if (this.timestamps.length >= this.settings.maxPerMinute) {
      // Wait until oldest falls out of the 60s window.
      const oldest = this.timestamps[0];
      const waitMs = Math.max(50, oldest + 60_000 - Date.now());
      setTimeout(() => this.tick(), waitMs);
      return;
    }
    const next = this.queue.shift();
    if (!next) return;
    this.speak(next);
  }

  private speak(m: ChatMessage) {
    const text = composeUtterance(m, this.settings.readSenderName);
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = this.settings.rate;
    utter.pitch = this.settings.pitch;
    utter.volume = this.settings.volume;
    const voice = this.voices().find((v) => v.voiceURI === this.settings.voiceURI);
    if (voice) utter.voice = voice;
    this.speaking = true;
    this.timestamps.push(Date.now());

    utter.onstart = () => {
      // Arm the keep-alive ping (see note #3 above).
      this.armKeepAlive();
    };
    utter.onend = utter.onerror = () => {
      this.speaking = false;
      this.clearKeepAlive();
      setTimeout(() => this.tick(), 50);
    };
    // Always lift any latched paused state before speaking (note #2 above).
    // This is a no-op when the engine isn't paused, so it's safe to call
    // unconditionally on every speak.
    if (window.speechSynthesis.paused) {
      window.speechSynthesis.resume();
    }
    window.speechSynthesis.speak(utter);
  }

  /**
   * Play a one-off preview utterance for the given voice URI. Cancels any
   * in-flight preview / queued chat utterances so rapid voice-dropdown
   * changes don't pile up. Bypasses the queue + rate-limit because preview
   * is a UI affordance, not chat playback. Returns the utterance text that
   * was spoken (for tests / debugging).
   *
   * v0.1.21 fix: the cancel() then speak() pair runs across a microtask
   * boundary now — calling them synchronously in Chromium causes the new
   * utterance to be silently dropped (the cancel hasn't yet flushed the
   * engine's internal state machine).
   */
  previewVoice(voiceURI: string | undefined): string {
    if (typeof window === 'undefined' || !window.speechSynthesis) return '';
    // Cancel everything in flight so rapid switching doesn't queue overlaps.
    this.queue = [];
    this.speaking = false;
    this.clearKeepAlive();
    window.speechSynthesis.cancel();

    const voice = this.voices().find((v) => v.voiceURI === voiceURI);
    const displayName = voice?.name ?? 'system default';
    const text = `Hello, my name is ${displayName}`;
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = this.settings.rate;
    utter.pitch = this.settings.pitch;
    utter.volume = this.settings.volume;
    if (voice) utter.voice = voice;
    utter.onstart = () => this.armKeepAlive();
    utter.onend = utter.onerror = () => this.clearKeepAlive();

    // Defer the speak() to a microtask so the cancel() above has a chance to
    // settle. Calling speak() synchronously after cancel() in Chromium can
    // cause the new utterance to be silently dropped — this is the
    // observable preview-silence regression that shipped pre-v0.1.21.
    // `queueMicrotask` is preferred over `setTimeout(0)` because it runs
    // BEFORE the next render frame, keeping the UX snappy.
    queueMicrotask(() => {
      if (typeof window === 'undefined' || !window.speechSynthesis) return;
      // Always lift any latched paused state before speaking (note #2 above).
      if (window.speechSynthesis.paused) {
        window.speechSynthesis.resume();
      }
      window.speechSynthesis.speak(utter);
    });

    return text;
  }

  /**
   * Arm a periodic `pause(); resume();` ping while an utterance is speaking.
   * Workaround for Chromium's long-utterance stall bug (note #3 in the
   * class header). The ping is a no-op acoustically but keeps the engine
   * responsive for utterances >15s and after long idle periods. Idempotent
   * — calling this twice in a row clears the previous timer first.
   */
  private armKeepAlive(): void {
    this.clearKeepAlive();
    if (typeof window === 'undefined' || !window.speechSynthesis) return;
    this.keepAliveTimer = setInterval(() => {
      if (typeof window === 'undefined' || !window.speechSynthesis) return;
      if (!window.speechSynthesis.speaking) {
        // Defensive: end event might have been swallowed; clear ourselves.
        this.clearKeepAlive();
        return;
      }
      try {
        window.speechSynthesis.pause();
        window.speechSynthesis.resume();
      } catch {
        // Some Chromium builds throw on pause() when nothing is speaking;
        // swallow because there's nothing to recover.
      }
    }, 10_000);
  }

  private clearKeepAlive(): void {
    if (this.keepAliveTimer !== null) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  private pruneTimestamps() {
    const cutoff = Date.now() - 60_000;
    while (this.timestamps.length > 0 && this.timestamps[0] < cutoff) {
      this.timestamps.shift();
    }
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
