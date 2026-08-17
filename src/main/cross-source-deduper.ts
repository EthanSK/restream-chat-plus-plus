import type { ChatMessage } from '../shared/types';

const DUPLICATE_WINDOW = 8_000;

/** Restream and a direct adapter can report the same platform message; repeated messages from one source remain untouched. */
export class CrossSourceDeduper {
  private readonly recent = new Map<string, { source: ChatMessage['source']; seenAt: number }>();
  private readonly recentIds = new Map<string, number>();

  shouldEmit(message: ChatMessage, now = Date.now()): boolean {
    for (const [key, entry] of this.recent) {
      if (now - entry.seenAt > DUPLICATE_WINDOW) this.recent.delete(key);
    }
    for (const [id, seenAt] of this.recentIds) {
      if (now - seenAt > DUPLICATE_WINDOW) this.recentIds.delete(id);
    }
    const idKey = `${message.platform}\u0000${message.id}`;
    if (this.recentIds.has(idKey)) return false;
    this.recentIds.set(idKey, now);
    const key = [
      message.platform,
      message.username.trim().toLocaleLowerCase(),
      message.text.trim(),
    ].join('\u0000');
    const previous = this.recent.get(key);
    if (
      previous &&
      previous.source !== message.source &&
      now - previous.seenAt <= DUPLICATE_WINDOW
    ) {
      return false;
    }
    this.recent.set(key, { source: message.source, seenAt: now });
    return true;
  }
}
