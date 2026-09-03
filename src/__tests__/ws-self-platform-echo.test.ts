/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('ws', () => {
  const { EventEmitter } = require('node:events');
  class FakeWS extends EventEmitter {
    static OPEN = 1;
    static instances: FakeWS[] = [];
    readyState = 0;

    constructor(public readonly url: string) {
      super();
      FakeWS.instances.push(this);
    }

    ping(): void {
      this.emit('pong');
    }

    close(): void {
      this.readyState = 3;
    }

    removeAllListeners(): this {
      return super.removeAllListeners();
    }
  }
  return { default: FakeWS };
});

import WSMock from 'ws';
import { ChatClient } from '../main/ws-client';

const WS = WSMock as any;

function sendFrame(frame: unknown): void {
  WS.instances[WS.instances.length - 1].emit(
    'message',
    Buffer.from(JSON.stringify(frame)),
  );
}

function connectClient(): ChatClient {
  const client = new ChatClient();
  client.setToken('token');
  client.start();
  WS.instances[0].readyState = WS.OPEN;
  WS.instances[0].emit('open');
  return client;
}

function connectionInfo({
  connectionIdentifier,
  eventSourceId,
  ownerId,
}: {
  connectionIdentifier: string;
  eventSourceId: number;
  ownerId?: string;
}): unknown {
  return {
    action: 'connection_info',
    payload: {
      connectionIdentifier,
      connectionUuid: `uuid-${eventSourceId}`,
      eventSourceId,
      status: 'connected',
      target: ownerId
        ? { owner: { id: ownerId, displayName: 'REEEthan' } }
        : { owner: { displayName: 'REEEthan' } },
    },
  };
}

function platformEvent({
  connectionIdentifier,
  eventTypeId,
  authorId,
  messageId,
}: {
  connectionIdentifier: string;
  eventTypeId: number;
  authorId: string;
  messageId: string;
}): unknown {
  return {
    action: 'event',
    payload: {
      connectionIdentifier,
      eventTypeId,
      eventPayload: {
        id: messageId,
        author: { id: authorId, displayName: 'REEEthan' },
        text: `message ${messageId}`,
      },
    },
  };
}

describe('ChatClient delayed platform self-echo suppression', () => {
  beforeEach(() => {
    WS.instances = [];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ['X', '5849342-twitter-x', 28, 24, '1473468965313814530'],
    ['YouTube', '5849342-youtube-channel', 13, 5, 'UCGVZSIfJKEzu5Viu2dQ-_mQ'],
    ['Twitch', '5849342-twitch-channel', 2, 4, '906603453'],
  ])(
    'suppresses an ordinary %s event when its stable author id is the connection owner',
    (_platform, connectionIdentifier, eventSourceId, eventTypeId, ownerId) => {
      const client = connectClient();
      const received = vi.fn();
      client.on('message', received);

      sendFrame(connectionInfo({ connectionIdentifier, eventSourceId, ownerId }));
      sendFrame(platformEvent({
        connectionIdentifier,
        eventTypeId,
        authorId: ownerId,
        messageId: `own-${eventSourceId}`,
      }));

      expect(received).not.toHaveBeenCalled();
      client.stop();
    },
  );

  it('still forwards another viewer with the same display name', () => {
    const client = connectClient();
    const received = vi.fn();
    client.on('message', received);
    const connectionIdentifier = '5849342-twitter-x';

    sendFrame(connectionInfo({
      connectionIdentifier,
      eventSourceId: 28,
      ownerId: '1473468965313814530',
    }));
    sendFrame(platformEvent({
      connectionIdentifier,
      eventTypeId: 24,
      authorId: 'different-account-id',
      messageId: 'viewer-1',
    }));

    expect(received).toHaveBeenCalledOnce();
    expect(received).toHaveBeenCalledWith(expect.objectContaining({ id: 'viewer-1' }));
    client.stop();
  });

  it('does not guess self identity when Restream omits the owner id', () => {
    const client = connectClient();
    const received = vi.fn();
    client.on('message', received);
    const connectionIdentifier = '5849342-twitter-x';

    sendFrame(connectionInfo({ connectionIdentifier, eventSourceId: 28 }));
    sendFrame(platformEvent({
      connectionIdentifier,
      eventTypeId: 24,
      authorId: '1473468965313814530',
      messageId: 'unverified-1',
    }));

    expect(received).toHaveBeenCalledOnce();
    client.stop();
  });
});
