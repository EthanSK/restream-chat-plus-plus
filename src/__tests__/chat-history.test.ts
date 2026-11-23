import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ChatHistory } from '../main/chat-history';
import type { ChatMessage } from '../shared/types';

const sources = ['restream', 'twitch-direct', 'kick-direct'] as const;

function message(index: number): ChatMessage {
  return {
    id: String(index),
    platform: 'twitch',
    source: sources[index % sources.length],
    username: 'viewer',
    text: `Message ${index}`,
    ts: 1_000 - index, // Provider clocks may disagree with receive order.
    raw: { providerPayload: 'private' },
  };
}

it('restores a bounded feed across app restarts and pages backward in arrival order', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rcpp-chat-history-'));
  const filename = join(directory, 'chat.sqlite');
  let history = new ChatHistory(filename);
  try {
    for (let index = 1; index <= 1_025; index += 1) history.add(message(index));
    history.close();
    history = new ChatHistory(filename);

    expect(history.add(message(1_000))).toBeUndefined();
    expect(history.add({ ...message(1_026), pendingSend: 'failed' })).toBeUndefined();
    const first = history.loadOlder();
    expect(first.messages).toHaveLength(50);
    expect(first.messages[0]).toMatchObject({ id: '976' });
    expect(first.messages.at(-1)).toMatchObject({ id: '1025' });
    expect(new Set(first.messages.map((row) => row.source))).toEqual(new Set(sources));
    expect(first.messages[0]).not.toHaveProperty('raw');

    const newSequence = history.add(message(1026));
    expect(newSequence).toBeDefined();
    const second = history.loadOlder(first.nextBefore);
    expect(second.messages[0].id).toBe('926');
    expect(second.messages.at(-1)?.id).toBe('975');
    expect(history.loadOlder(newSequence).messages.at(-1)?.id).toBe('1025');

    let total = first.messages.length;
    let page = first;
    while (page.nextBefore !== undefined) {
      page = history.loadOlder(page.nextBefore);
      total += page.messages.length;
    }
    expect(total).toBe(999); // The new live arrival displaced the oldest row.
    expect(page.messages[0].id).toBe('27');

    history.clear();
    history.close();
    history = new ChatHistory(filename);
    expect(history.loadOlder().messages).toEqual([]);
    expect(history.add(message(1027))).toBeGreaterThan(newSequence ?? 0);
  } finally {
    history.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
