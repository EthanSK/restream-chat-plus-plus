import { describe, it, expect } from 'vitest';
import { composeUtterance } from '../renderer/tts';
import type { ChatMessage } from '../shared/types';

const msg: ChatMessage = {
  id: 'm1',
  platform: 'twitch',
  username: 'alice',
  text: 'hello world',
  ts: 1_700_000_000_000,
};

describe('composeUtterance', () => {
  it('omits the sender name when readSenderName=false (v0.1.9 default)', () => {
    expect(composeUtterance(msg, false)).toBe('hello world');
  });

  it('prefixes "<name> says " when readSenderName=true', () => {
    expect(composeUtterance(msg, true)).toBe('alice says hello world');
  });

  it('keeps message text verbatim regardless of toggle', () => {
    const m: ChatMessage = { ...msg, text: 'POG :)' };
    expect(composeUtterance(m, false)).toBe('POG :)');
    expect(composeUtterance(m, true)).toBe('alice says POG :)');
  });
});
