import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../renderer/App';
import type { ChatSendStatus } from '../shared/types';

const api = vi.hoisted(() => ({
  onStatus: undefined as ((status: ChatSendStatus) => void) | undefined,
  signInToSend: vi.fn<() => Promise<boolean>>(),
  authLogout: vi.fn(), authStart: vi.fn(), enqueueChatSend: vi.fn(),
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
    onConnections: noopSubscription, onChatMessage: noopSubscription,
    onReconnectSucceeded: noopSubscription, onMenuOpenSettings: noopSubscription,
    onChatClear: noopSubscription, onSettingsPush: noopSubscription,
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
afterEach(() => { act(() => renderer?.unmount()); vi.clearAllMocks(); });

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
