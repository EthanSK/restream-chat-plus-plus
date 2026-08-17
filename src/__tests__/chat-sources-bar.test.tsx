import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { ChatSourcesBar } from '../renderer/ChatSourcesBar';
import type { DirectChatConnection } from '../shared/types';

function render(connections: DirectChatConnection[]): {
  renderer: TestRenderer.ReactTestRenderer;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
} {
  const connect = vi.fn(async () => undefined);
  const disconnect = vi.fn(async () => undefined);
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <ChatSourcesBar
        restreamAuth={{ authenticated: false }}
        restreamConnection={{ status: 'disconnected', attempt: 0 }}
        restreamChannels={[]}
        directConnections={connections}
        onDirectConnect={connect}
        onDirectDisconnect={disconnect}
      />,
    );
  });
  return { renderer, connect, disconnect };
}

function buttonText(node: TestRenderer.ReactTestInstance): string {
  return node.children
    .flatMap((child) => (typeof child === 'string' ? [child] : child.children))
    .filter((child): child is string => typeof child === 'string')
    .join('');
}

describe('ChatSourcesBar', () => {
  it('keeps each source name and live viewer count on one line', () => {
    const css = readFileSync(
      new URL('../renderer/styles.css', import.meta.url),
      'utf8',
    );
    const chipRule = css.match(/\.source-chip\s*\{([^}]*)\}/s)?.[1] ?? '';
    const viewersRule =
      css.match(/\.source-viewers\s*\{([^}]*)\}/s)?.[1] ?? '';

    expect(chipRule).toMatch(/flex:\s*0 0 auto\s*;/);
    expect(chipRule).toMatch(/white-space:\s*nowrap\s*;/);
    expect(viewersRule).toMatch(/flex:\s*0 0 auto\s*;/);
    expect(viewersRule).toMatch(/white-space:\s*nowrap\s*;/);
  });

  it('keeps Restream, Twitch, and Kick visible in a compact source row', () => {
    const { renderer } = render([
      { provider: 'twitch', status: 'connected', accountName: 'reeethan' },
      { provider: 'kick', status: 'disconnected' },
    ]);
    const chips = renderer.root.findAll(
      (node) =>
        node.type === 'button' &&
        typeof node.props.className === 'string' &&
        node.props.className.includes('source-chip'),
    );
    expect(chips.map(buttonText)).toEqual(['Restream', 'Twitch', 'Kick']);
  });

  it('shows account health and runs the selected provider action', async () => {
    const { renderer, connect } = render([
      {
        provider: 'twitch',
        status: 'connected',
        accountName: 'reeethan',
        detail: 'Reading Twitch chat directly.',
      },
      { provider: 'kick', status: 'disconnected' },
    ]);
    act(() => {
      renderer.root.findByProps({ 'aria-label': 'Manage Kick chat source' }).props.onClick();
    });
    expect(renderer.root.findByProps({ role: 'dialog' })).toBeDefined();
    expect(renderer.root.findAllByType('strong').map((node) => node.children.join(''))).toContain(
      'Twitch · reeethan',
    );
    const kickConnect = renderer.root
      .findAllByType('button')
      .find((button) => buttonText(button) === 'Connect');
    expect(kickConnect).toBeDefined();
    await act(async () => {
      await kickConnect?.props.onClick();
    });
    expect(connect).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledWith('kick');
  });

  it('shows separate live viewer counts for Twitch and Kick', () => {
    const { renderer } = render([
      {
        provider: 'twitch',
        status: 'connected',
        isLive: true,
        viewerCount: 12,
      },
      {
        provider: 'kick',
        status: 'connected',
        isLive: true,
        viewerCount: 3,
      },
    ]);
    expect(
      buttonText(renderer.root.findByProps({ 'aria-label': 'Manage Twitch chat source' })),
    ).toBe('Twitch· 12');
    expect(
      buttonText(renderer.root.findByProps({ 'aria-label': 'Manage Kick chat source' })),
    ).toBe('Kick· 3');

    act(() => {
      renderer.root.findByProps({ 'aria-label': 'Manage Twitch chat source' }).props.onClick();
    });
    const viewerRows = renderer.root.findAllByProps({ className: 'chat-source-viewers' });
    expect(viewerRows.map((node) => node.children.join(''))).toEqual([
      '12 live viewers',
      '3 live viewers',
    ]);
  });

  it('disables Connect when developer setup is not configured', () => {
    const { renderer } = render([
      { provider: 'twitch', status: 'not-configured' },
      { provider: 'kick', status: 'not-configured' },
    ]);
    act(() => {
      renderer.root.findByProps({ 'aria-label': 'Manage Twitch chat source' }).props.onClick();
    });
    const connectButtons = renderer.root
      .findAllByType('button')
      .filter((button) => buttonText(button) === 'Connect');
    expect(connectButtons).toHaveLength(2);
    expect(connectButtons.every((button) => button.props.disabled === true)).toBe(true);
  });

  it('explains that connected direct sources both read and send', () => {
    const { renderer } = render([
      { provider: 'twitch', status: 'connected' },
      { provider: 'kick', status: 'connected' },
    ]);
    act(() => {
      renderer.root.findByProps({ 'aria-label': 'Manage Twitch chat source' }).props.onClick();
    });
    expect(renderer.root.findByProps({ className: 'chat-sources-foot' }).children.join('')).toBe(
      'Twitch and Kick messages are read and sent directly. Other connected channels send through Restream.',
    );
  });
});
