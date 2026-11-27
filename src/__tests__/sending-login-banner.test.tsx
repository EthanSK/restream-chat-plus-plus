import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../renderer/App';
import { DEFAULT_SETTINGS, type ChatHistoryPage, type ChatMessage, type ChatSendEnqueuePayload, type ChatSendStatus, type SilenceUserResult } from '../shared/types';
import { setSilencedUser } from '../shared/message-filters';
import { ChatFeed } from '../renderer/ChatFeed';
import { ChatInputInline } from '../renderer/ChatInputInline';

const api = vi.hoisted(() => ({
  onStatus: undefined as ((status: ChatSendStatus) => void) | undefined,
  onChat: undefined as ((message: ChatMessage) => void) | undefined,
  onClear: undefined as (() => void) | undefined,
  loadOlderChatMessages: vi.fn<(before?: number) => Promise<ChatHistoryPage>>(),
  setUserSilenced: vi.fn<(username: string, silenced: boolean) => Promise<SilenceUserResult>>(),
  signInToSend: vi.fn<() => Promise<boolean>>(),
  authLogout: vi.fn(), authStart: vi.fn(), enqueueChatSend: vi.fn<(payload: ChatSendEnqueuePayload) => void>(),
}));
vi.mock('../renderer/api', async () => {
  const { DEFAULT_SETTINGS } = await import('../shared/types');
  const noopSubscription = () => () => undefined;
  return { rcpp: {
    authStatus: async () => ({ authenticated: true }),
    getSettings: async () => DEFAULT_SETTINGS,
    connectionState: async () => ({ status: 'connected' }),
    getConnections: async () => [], getUpdateStatus: async () => null,
    onAuthStatus: noopSubscription, onConnectionState: noopSubscription,
    onConnections: noopSubscription,
    onChatMessage: (callback: (message: ChatMessage) => void) => {
      api.onChat = callback;
      return noopSubscription();
    },
    onReconnectSucceeded: noopSubscription, onMenuOpenSettings: noopSubscription,
    onChatClear: (callback: () => void) => {
      api.onClear = callback;
      return noopSubscription();
    },
    loadOlderChatMessages: api.loadOlderChatMessages,
    setUserSilenced: api.setUserSilenced,
    onSettingsPush: noopSubscription,
    onUpdateStatus: noopSubscription,
    onChatSendStatus: (callback: (status: ChatSendStatus) => void) => { api.onStatus = callback; return () => undefined; },
    signInToSend: api.signInToSend, authLogout: api.authLogout,
    authStart: api.authStart, enqueueChatSend: api.enqueueChatSend,
  } };
});
vi.mock('../renderer/ChatSourcesBar', () => ({ ChatSourcesBar: () => null }));
vi.mock('../renderer/ChatFeed', () => ({ ChatFeed: () => null }));
vi.mock('../renderer/ChatInputInline', () => ({ ChatInputInline: () => null }));
vi.mock('../renderer/SettingsDrawer', () => ({ SettingsDrawer: () => null }));
vi.mock('../renderer/UpdateBanner', () => ({ UpdateBanner: () => null }));
vi.mock('../renderer/ViewerCount', () => ({ ViewerCount: () => null }));

let renderer: TestRenderer.ReactTestRenderer;
afterEach(() => { act(() => renderer?.unmount()); vi.useRealTimers(); vi.clearAllMocks(); });

it('applies a saved silence change to live chat and loaded history without reload', async () => {
  const row: ChatMessage = { id: 'live', text: 'hello', platform: 'youtube', username: '@viewer', ts: 2 };
  const older = { ...row, id: 'older', ts: 1 };
  api.loadOlderChatMessages.mockResolvedValueOnce({ messages: [older] });
  api.setUserSilenced.mockImplementation(async (username, silenced) => ({
    ok: true,
    settings: setSilencedUser(DEFAULT_SETTINGS, username, silenced),
  }));
  await act(async () => { renderer = TestRenderer.create(<App />); });
  const feed = () => renderer.root.findByType(ChatFeed).props;
  act(() => api.onChat?.(row));
  await act(async () => feed().historyControls.loadOlder());

  await act(async () => feed().onSetUserSilenced(row.username, true));
  expect(feed().isUserSilenced(row.username)).toBe(true);
  expect(feed().messages.map(feed().getMessageFilterFlags)).toEqual([
    { ignoredByTts: true, ignoredByNotifications: true },
    { ignoredByTts: true, ignoredByNotifications: true },
  ]);

  await act(async () => feed().onSetUserSilenced(row.username, false));
  expect(feed().isUserSilenced(row.username)).toBe(false);
  expect(feed().messages.map(feed().getMessageFilterFlags)).toEqual([{}, {}]);
  expect(api.setUserSilenced.mock.calls).toEqual([['@viewer', true], ['@viewer', false]]);
});

describe('loading older chat messages', () => {
  const row = (historySequence: number): ChatMessage => ({
    id: String(historySequence),
    platform: 'twitch',
    username: 'viewer',
    text: `Message ${historySequence}`,
    ts: historySequence,
    historySequence,
  });
  const feed = () => renderer.root.findByType(ChatFeed).props;

  it('prepends older pages without moving live indices or duplicating a live arrival', async () => {
    api.loadOlderChatMessages
      .mockResolvedValueOnce({ messages: [row(2), row(3)], nextBefore: 2 })
      .mockResolvedValueOnce({ messages: [row(1)] });
    await act(async () => { renderer = TestRenderer.create(<App />); });
    const initialIndex = feed().firstItemIndex;
    act(() => api.onChat?.(row(3)));
    await act(async () => feed().historyControls.loadOlder());
    expect(api.loadOlderChatMessages).toHaveBeenNthCalledWith(1, 3);
    expect(feed().messages.map((message: ChatMessage) => message.id)).toEqual(['2', '3']);
    expect(feed().firstItemIndex).toBe(initialIndex - 1);

    act(() => api.onChat?.(row(4)));
    await act(async () => feed().historyControls.loadOlder());
    expect(api.loadOlderChatMessages).toHaveBeenNthCalledWith(2, 2);
    expect(feed().messages.map((message: ChatMessage) => message.id)).toEqual(['1', '2', '3', '4']);
    expect(feed().firstItemIndex).toBe(initialIndex - 2);
    expect(feed().historyControls.status).toBe('exhausted');
    expect(api.enqueueChatSend).not.toHaveBeenCalled();
  });

  it('fetches from an empty feed and ignores a pending reply after Clear Chat', async () => {
    let completePage!: (page: ChatHistoryPage) => void;
    api.loadOlderChatMessages.mockReturnValueOnce(
      new Promise((resolve) => { completePage = resolve; }),
    );
    await act(async () => { renderer = TestRenderer.create(<App />); });
    act(() => {
      feed().historyControls.loadOlder();
      feed().historyControls.loadOlder();
    });
    expect(api.loadOlderChatMessages).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(feed().historyControls.status).toBe('loading');
    act(() => api.onClear?.());
    await act(async () => completePage({ messages: [row(1)] }));
    expect(feed().messages).toEqual([]);
    expect(feed().historyControls.status).toBe('ready');

    api.loadOlderChatMessages.mockResolvedValueOnce({ messages: [row(1)] });
    await act(async () => feed().historyControls.loadOlder());
    expect(api.loadOlderChatMessages).toHaveBeenNthCalledWith(2, undefined);
    expect(feed().messages).toEqual([row(1)]);
  });
});

describe('queue-owned send status', () => {
  it('keeps acknowledged queued sends and automatic retries pending beyond 30 seconds', async () => {
    vi.useFakeTimers();
    await act(async () => { renderer = TestRenderer.create(<App />); });
    act(() => renderer.root.findByType(ChatInputInline).props.onSend('slow delivery'));
    const { clientId } = api.enqueueChatSend.mock.calls[0][0];
    act(() => api.onStatus?.({ clientId, status: 'pending' }));
    act(() => { vi.advanceTimersByTime(90_000); });
    expect(renderer.root.findByType(ChatFeed).props.messages[0].pendingSend).toBe('sending');
    expect(renderer.root.findAllByProps({ className: 'send-notice-text' })).toHaveLength(0);
    act(() => api.onStatus?.({ clientId, status: 'retrying', attempt: 2, maxAttempts: 5 }));
    act(() => { vi.advanceTimersByTime(90_000); });
    expect(renderer.root.findByType(ChatFeed).props.messages[0].pendingSend).toBe('retrying');
    act(() => api.onStatus?.({ clientId, status: 'sent' }));
    expect(renderer.root.findByType(ChatFeed).props.messages[0].pendingSend).toBeUndefined();
    expect(api.enqueueChatSend).toHaveBeenCalledOnce();
  });

  it('retains the missing-acknowledgement guard and clears its warning on confirmed success', async () => {
    vi.useFakeTimers();
    await act(async () => { renderer = TestRenderer.create(<App />); });
    act(() => renderer.root.findByType(ChatInputInline).props.onSend('lost acknowledgement'));
    const { clientId } = api.enqueueChatSend.mock.calls[0][0];
    act(() => { vi.advanceTimersByTime(30_000); });
    expect(renderer.root.findByType(ChatFeed).props.messages[0].pendingSend).toBe('failed');
    expect(renderer.root.findAllByProps({ className: 'send-notice-text' })).toHaveLength(1);
    act(() => api.onStatus?.({ clientId, status: 'sent' }));
    expect(renderer.root.findByType(ChatFeed).props.messages[0].pendingSend).toBeUndefined();
    expect(renderer.root.findAllByProps({ className: 'send-notice-text' })).toHaveLength(0);
  });

  it('keeps genuine exhausted failures visible without clearing another message warning', async () => {
    vi.useFakeTimers();
    await act(async () => { renderer = TestRenderer.create(<App />); });
    act(() => renderer.root.findByType(ChatInputInline).props.onSend('failed destination'));
    const { clientId } = api.enqueueChatSend.mock.calls[0][0];
    act(() => api.onStatus?.({ clientId, status: 'pending' }));
    act(() => api.onStatus?.({ clientId, status: 'failed', reason: 'destination-send-failed', error: 'Kick rejected this message.', attempt: 5, maxAttempts: 5 }));
    act(() => api.onStatus?.({ clientId: 'another-message', status: 'sent' }));
    expect(renderer.root.findByType(ChatFeed).props.messages[0].pendingSend).toBe('failed');
    expect(renderer.root.findByProps({ className: 'send-notice-text' }).children.join('')).toBe('Kick rejected this message.');
  });
});

describe('Sign in to send banner', () => {
  it.each([true, false])('opens sending login only, shows waiting state, and handles completion=%s', async (ok) => {
    let finishLogin!: (ok: boolean) => void;
    api.signInToSend.mockReturnValue(new Promise<boolean>((resolve) => { finishLogin = resolve; }));
    await act(async () => { renderer = TestRenderer.create(<App />); });
    act(() => api.onStatus?.({
      clientId: 'test', status: 'retrying', reason: 'destination-send-failed',
      error: 'Sent to Twitch, Kick. Restream failed.',
      destinations: [{ destination: 'restream', ok: false, reason: 'no-session-cookies' }],
    }));
    const button = renderer.root.findAllByType('button').find((node) => node.children.includes('Sign in to send'));
    expect(button).toBeDefined();
    act(() => button?.props.onClick());
    expect(api.signInToSend).toHaveBeenCalledOnce();
    expect(renderer.root.findAllByType('button').find((node) => node.children.includes('Waiting for sign in...'))?.props.disabled).toBe(true);
    await act(async () => finishLogin(ok));
    const notice = renderer.root.findByProps({ className: 'send-notice-text' }).children.join('');
    expect(notice).toContain(ok ? 'Retry any messages still marked as failed.' : 'sign in was not completed');
    expect(api.authLogout).not.toHaveBeenCalled();
    expect(api.authStart).not.toHaveBeenCalled();
    expect(api.enqueueChatSend).not.toHaveBeenCalled();
  });
});
