import { describe, it, expect } from 'vitest';
import { clearChatMessages } from '../renderer/chat-actions';
import type { ChatMessage } from '../shared/types';

function msg(id: string, text: string): ChatMessage {
  return {
    id,
    platform: 'twitch',
    username: 'alice',
    text,
    ts: 1_700_000_000_000,
  };
}

/**
 * Regression guard for the v0.1.18 "Clear chat" context-menu action.
 *
 * The clear logic is intentionally a pure reducer so it can be unit-tested
 * here (vitest runs under `environment: node`, not jsdom). The renderer
 * wires `setMessages((prev) => clearChatMessages(prev))` so a mis-named
 * import or a refactor that accidentally returned `prev` instead of `[]`
 * would silently break the feature.
 */
describe('clearChatMessages', () => {
  it('returns an empty array when given a populated buffer', () => {
    const before: ChatMessage[] = [msg('a', 'hi'), msg('b', 'there'), msg('c', '👋')];
    const after = clearChatMessages(before);
    expect(after).toEqual([]);
    expect(after.length).toBe(0);
  });

  it('returns an empty array when already empty (idempotent)', () => {
    expect(clearChatMessages([])).toEqual([]);
  });

  it('does NOT mutate the input buffer (React state immutability)', () => {
    // React's setState relies on referential inequality to schedule a
    // re-render. The reducer MUST return a fresh array, not splice the
    // existing one — otherwise an extra setMessages([...prev]) would be
    // needed at the call site.
    const before: ChatMessage[] = [msg('a', 'hi'), msg('b', 'there')];
    const snapshot = [...before];
    const after = clearChatMessages(before);
    expect(before).toEqual(snapshot); // unchanged
    expect(after).not.toBe(before); // new reference
  });
});
