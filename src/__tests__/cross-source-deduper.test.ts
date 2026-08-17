import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../shared/types';
import { CrossSourceDeduper } from '../main/cross-source-deduper';

function message(source: ChatMessage['source'], text = 'hello'): ChatMessage {
  return {
    id: `${source}-${text}`,
    platform: 'twitch',
    username: 'Ethan',
    text,
    ts: 1,
    source,
  };
}

describe('CrossSourceDeduper', () => {
  it('drops only the cross-source copy inside the duplicate window', () => {
    const deduper = new CrossSourceDeduper();
    expect(deduper.shouldEmit(message('restream'), 1_000)).toBe(true);
    expect(deduper.shouldEmit(message('twitch-direct'), 1_100)).toBe(false);
  });

  it('keeps repeated messages from the same source', () => {
    const deduper = new CrossSourceDeduper();
    const first = message('twitch-direct');
    expect(deduper.shouldEmit(first, 1_000)).toBe(true);
    expect(deduper.shouldEmit({ ...first, id: 'second-message' }, 1_100)).toBe(true);
  });

  it('drops a replay of the same provider message id', () => {
    const deduper = new CrossSourceDeduper();
    const original = message('kick-direct');
    expect(deduper.shouldEmit(original, 1_000)).toBe(true);
    expect(deduper.shouldEmit(original, 2_000)).toBe(false);
  });

  it('keeps a later matching message outside the duplicate window', () => {
    const deduper = new CrossSourceDeduper();
    expect(deduper.shouldEmit(message('restream'), 1_000)).toBe(true);
    expect(deduper.shouldEmit(message('twitch-direct'), 9_001)).toBe(true);
  });
});
