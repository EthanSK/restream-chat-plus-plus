import { describe, expect, it, vi } from 'vitest';
import React, { useState } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { MessageRow } from '../renderer/ChatFeed';
import { applyMessageFilters, compileIgnorePatterns, hasExactSilenceRule, setSilencedUser } from '../shared/message-filters';
import { DEFAULT_SETTINGS, type ChatMessage } from '../shared/types';

vi.mock('../renderer/api', () => ({
  rcpp: { showChatContextMenu: vi.fn() },
}));

const message: ChatMessage = {
  id: 'viewer-1',
  platform: 'youtube',
  username: '@viewer',
  text: 'hello',
  ts: 1,
};

describe('per-row Silence and Unsilence', () => {
  it('toggles the same row both ways and refreshes the ignored badge', () => {
    const stopPropagation = vi.fn();
    const onSetUserSilenced = vi.fn();

    function FeedRow(): React.ReactElement {
      const [settings, setSettings] = useState(DEFAULT_SETTINGS);
      const tts = settings.filters.tts.ignoreUsernameRegex;
      const notifications = settings.filters.notifications.ignoreUsernameRegex;
      return (
        <MessageRow
          message={message}
          silenced={hasExactSilenceRule(tts, message.username) || hasExactSilenceRule(notifications, message.username)}
          filterFlags={applyMessageFilters(message.text, [], [], message.username, compileIgnorePatterns(tts), compileIgnorePatterns(notifications))}
          onSetUserSilenced={(username, silenced) => {
            onSetUserSilenced(username, silenced);
            setSettings((current) => setSilencedUser(current, username, silenced));
          }}
        />
      );
    }

    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => { renderer = TestRenderer.create(<FeedRow />); });
    const button = renderer.root.findByProps({ 'aria-label': 'Silence user @viewer' });
    act(() => button.props.onClick({ stopPropagation }));
    expect(onSetUserSilenced).toHaveBeenNthCalledWith(1, '@viewer', true);
    const reverseButton = renderer.root.findByProps({ 'aria-label': 'Unsilence user @viewer' });
    expect(reverseButton).toBe(button);
    expect(renderer.root.findByProps({ className: 'regex-ignored-badge' }).children).toEqual(['🔇🔕 regex-ignored']);

    act(() => reverseButton.props.onClick({ stopPropagation }));
    expect(onSetUserSilenced).toHaveBeenNthCalledWith(2, '@viewer', false);
    expect(renderer.root.findByProps({ 'aria-label': 'Silence user @viewer' })).toBe(button);
    expect(renderer.root.findAllByProps({ className: 'regex-ignored-badge' })).toHaveLength(0);
    expect(stopPropagation).toHaveBeenCalledTimes(2);
  });

  it('uses current filter flags for rows that carried an earlier ignore badge', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <MessageRow
          message={{ ...message, ignoredByTts: true, ignoredByNotifications: true }}
          filterFlags={{ ignoredByNotifications: true }}
        />,
      );
    });
    expect(renderer.root.findByProps({ className: 'regex-ignored-badge' }).children).toEqual(['🔕 regex-ignored (notif)']);
  });
});
