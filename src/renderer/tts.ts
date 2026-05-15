import type { ChatMessage, Settings } from '../shared/types';

/**
 * Throttled Web Speech TTS engine.
 *
 * - Maintains a queue of pending utterances
 * - Honors max-per-minute rate limit (drop oldest if over the cap to keep TTS
 *   from spiraling during a chat raid)
 * - Allows the user to pick a system voice by URI
 */
export class TTSEngine {
  private queue: ChatMessage[] = [];
  private speaking = false;
  private timestamps: number[] = []; // ms of recent spoken utterances
  private settings: Settings['tts'];

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
    const utter = new SpeechSynthesisUtterance(`${m.username} says ${m.text}`);
    utter.rate = this.settings.rate;
    utter.pitch = this.settings.pitch;
    utter.volume = this.settings.volume;
    const voice = this.voices().find((v) => v.voiceURI === this.settings.voiceURI);
    if (voice) utter.voice = voice;
    this.speaking = true;
    this.timestamps.push(Date.now());

    utter.onend = utter.onerror = () => {
      this.speaking = false;
      setTimeout(() => this.tick(), 50);
    };
    window.speechSynthesis.speak(utter);
  }

  private pruneTimestamps() {
    const cutoff = Date.now() - 60_000;
    while (this.timestamps.length > 0 && this.timestamps[0] < cutoff) {
      this.timestamps.shift();
    }
  }
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
