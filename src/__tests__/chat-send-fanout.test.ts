import { describe, expect, it, vi } from 'vitest';
import {
  createChatSendFanout,
  intendedTargets,
} from '../main/chat-send-fanout';
import type {
  ChatConnection,
  DirectChatConnection,
  DirectChatSendResult,
} from '../shared/types';

function restream(platform: ChatConnection['platform']): ChatConnection {
  return {
    connectionIdentifier: platform,
    connectionUuid: `${platform}-uuid`,
    eventSourceId: 1,
    platform,
    status: 'connected',
    updatedAt: 1,
  };
}

function direct(
  provider: DirectChatConnection['provider'],
  status: DirectChatConnection['status'] = 'connected',
): DirectChatConnection {
  return { provider, status };
}

describe('intendedTargets', () => {
  it('uses Restream once and adds direct providers that Restream does not carry', () => {
    expect(
      intendedTargets(
        [restream('youtube')],
        [direct('twitch'), direct('kick')],
      ),
    ).toEqual(['restream', 'twitch', 'kick']);
  });

  it('does not duplicate Twitch or Kick when Restream already carries them', () => {
    expect(
      intendedTargets(
        [restream('youtube'), restream('twitch'), restream('kick')],
        [direct('twitch'), direct('kick')],
      ),
    ).toEqual(['restream']);
  });
});

describe('createChatSendFanout', () => {
  it('preserves missing sending-login evidence through partial delivery and retry', async () => {
    const sendRestream = vi.fn()
      .mockResolvedValueOnce({ ok: false, reason: 'no-session-cookies' })
      .mockResolvedValueOnce({ ok: true });
    const sendDirect = vi.fn(async () => ({ ok: true }));
    const fanout = createChatSendFanout({
      getRestreamConnections: () => [restream('youtube')],
      getDirectConnections: () => [direct('twitch'), direct('kick')],
      sendRestream, sendDirect,
    });
    const item = { clientId: 'missing-login', text: 'hello' };
    const result = await fanout.send(item);
    expect(result.destinations?.[0]).toMatchObject({ reason: 'no-session-cookies' });
    expect(result.error).toContain('Sent to Twitch, Kick.');
    expect(await fanout.send(item)).toMatchObject({ ok: true });
    expect(sendDirect).toHaveBeenCalledTimes(2);
  });
  it('retries only failed destinations and never duplicates successful sends', async () => {
    const sendRestream = vi.fn(async () => ({ ok: true as const }));
    const twitch = vi.fn(async (text: string) => {
      void text;
      return { ok: true as const, messageId: 't-1' };
    });
    const kick = vi
      .fn(async (text: string): Promise<DirectChatSendResult> => {
        void text;
        return { ok: true, messageId: 'k-1' };
      })
      .mockResolvedValueOnce({ ok: false, error: 'temporary Kick failure' })
      .mockResolvedValueOnce({ ok: true, messageId: 'k-1' });
    const fanout = createChatSendFanout({
      getRestreamConnections: () => [restream('youtube')],
      getDirectConnections: () => [direct('twitch'), direct('kick')],
      sendRestream,
      sendDirect: (provider, text) =>
        provider === 'twitch' ? twitch(text) : kick(text),
    });
    const item = { clientId: 'message-1', text: 'hello everyone' };

    const first = await fanout.send(item);
    expect(first).toMatchObject({
      ok: false,
      reason: 'destination-send-failed',
    });
    const second = await fanout.send(item);
    expect(second).toMatchObject({ ok: true });
    expect(sendRestream).toHaveBeenCalledOnce();
    expect(twitch).toHaveBeenCalledOnce();
    expect(kick).toHaveBeenCalledTimes(2);
  });

  it('requires reauthorization without retrying an already-successful destination', async () => {
    const sendRestream = vi.fn(async () => ({ ok: true as const }));
    const fanout = createChatSendFanout({
      getRestreamConnections: () => [restream('youtube')],
      getDirectConnections: () => [direct('twitch')],
      sendRestream,
      sendDirect: async () => ({
        ok: false,
        status: 403,
        authorizationRequired: true,
        error: 'missing scope',
      }),
    });

    expect(await fanout.send({ clientId: 'message-2', text: 'hello' })).toMatchObject({
      ok: false,
      reason: 'provider-authorization-required',
      error: expect.stringContaining('Reconnect'),
    });
    expect(sendRestream).toHaveBeenCalledOnce();
  });
});
