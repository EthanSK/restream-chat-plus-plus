import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { MessageRow } from '../renderer/ChatFeed';
import { compileIgnorePatterns } from '../renderer/message-filters';
import type { ChatMessage } from '../shared/types';

vi.mock('../renderer/api', () => ({
  rcpp: { showChatContextMenu: vi.fn() },
}));

const message: ChatMessage = {
  id: 'twitch-1',
  platform: 'twitch',
  username: 'burntballs_',
  text: 'hello',
  ts: 1_786_195_091_000,
};

function findByClass(
  renderer: TestRenderer.ReactTestRenderer,
  className: string,
): TestRenderer.ReactTestInstance[] {
  return renderer.root.findAll((node) => node.props.className === className);
}

describe('per-row Silence user feedback', () => {
  it('click relays the exact Twitch username and stops propagation', () => {
    const onSilenceUser = vi.fn();
    const stopPropagation = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <MessageRow message={message} onSilenceUser={onSilenceUser} />,
      );
    });

    const button = findByClass(renderer, 'silence-user-btn')[0];
    expect(button).toBeDefined();
    act(() => button.props.onClick({ stopPropagation }));
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(onSilenceUser).toHaveBeenCalledWith('burntballs_');
  });

  it('existing row changes to Silenced only after both TTS and notifications match', () => {
    const onSilenceUser = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <MessageRow message={message} onSilenceUser={onSilenceUser} />,
      );
    });
    expect(findByClass(renderer, 'silence-user-btn')).toHaveLength(1);
    expect(findByClass(renderer, 'silence-user-status')).toHaveLength(0);

    const ttsOnly = compileIgnorePatterns(['^burntballs_$']);
    act(() => {
      renderer.update(
        <MessageRow
          message={message}
          onSilenceUser={onSilenceUser}
          silencedTtsUsernamePatterns={ttsOnly}
        />,
      );
    });
    expect(findByClass(renderer, 'silence-user-btn')).toHaveLength(1);
    expect(findByClass(renderer, 'regex-ignored-badge')[0].children).toEqual([
      '🔇 regex-ignored (TTS)',
    ]);

    act(() => {
      renderer.update(
        <MessageRow
          message={message}
          onSilenceUser={onSilenceUser}
          silencedTtsUsernamePatterns={ttsOnly}
          silencedNotificationUsernamePatterns={ttsOnly}
        />,
      );
    });
    expect(findByClass(renderer, 'silence-user-btn')).toHaveLength(0);
    expect(findByClass(renderer, 'silence-user-status')[0].children).toEqual([
      '✓ Silenced',
    ]);
    expect(findByClass(renderer, 'regex-ignored-badge')[0].children).toEqual([
      '🔇🔕 regex-ignored',
    ]);
  });
});
