import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventEmitter } from 'node:events';

type TestSocket = EventEmitter & { url: string; readyState: number; terminate: () => void };
const sockets = vi.hoisted(() => [] as TestSocket[]);
vi.mock('../main/structured-log', () => ({ appendJsonl: vi.fn(), errorToString: String }));
vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events');
  return { default: class extends EventEmitter {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 0;
    constructor(public url: string) { super(); sockets.push(this); }
    ping() { this.emit('pong'); }
    terminate() { this.readyState = 3; this.emit('close', 1006); }
  } };
});
import { ViewerStatsClient } from '../main/viewer-stats';

describe('viewer feed reconnects with current OAuth without touching chat', () => {
  const clients: ViewerStatsClient[] = [];
  beforeEach(() => { vi.useFakeTimers(); sockets.length = 0; });
  afterEach(() => { clients.splice(0).forEach((client) => client.stop()); vi.useRealTimers(); });
  function start(getToken: (rejectedToken?: string) => Promise<string | undefined>) {
    const client = new ViewerStatsClient(getToken);
    clients.push(client);
    client.setToken('old-token');
    client.start();
    return client;
  }

  it('passes a rejected bearer to refresh and reconnects once with the new token', async () => {
    const getToken = vi.fn(async () => 'new-token');
    start(getToken);
    const resume = vi.fn();
    sockets[0].emit('unexpected-response', {}, { statusCode: 401, resume });
    expect(resume).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(4999);
    expect(getToken).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(getToken).toHaveBeenCalledWith('old-token');
    expect(sockets).toHaveLength(2);
    expect(sockets[1].url).toContain('accessToken=new-token');
  });

  it('looks up current OAuth after a network close without forcing token refresh', async () => {
    const getToken = vi.fn(async () => 'current-token');
    start(getToken);
    sockets[0].terminate();
    await vi.advanceTimersByTimeAsync(5000);
    expect(getToken).toHaveBeenCalledWith(undefined);
    expect(sockets[1].url).toContain('accessToken=current-token');
  });

  it.each(['sign-out', 'newer reconnect'])('discards an OAuth result after %s', async (action) => {
    let resolve!: (token: string) => void;
    const client = start(() => new Promise<string>((done) => { resolve = done; }));
    sockets[0].terminate();
    await vi.advanceTimersByTimeAsync(5000);
    if (action === 'sign-out') client.stop();
    else { client.setToken('newer-token'); client.reconnect(); }
    resolve('stale-result');
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(action === 'sign-out' ? 1 : 2);
    expect(sockets.some((socket) => socket.url.includes('stale-result'))).toBe(false);
    if (action !== 'sign-out') expect(sockets[1].url).toContain('newer-token');
  });

  it('backs off token lookup failures and never reconnects with the expired bearer', async () => {
    const getToken = vi.fn<() => Promise<string | undefined>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue('recovered-token');
    start(getToken);
    sockets[0].terminate();
    await vi.advanceTimersByTimeAsync(5000);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10000);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(20000);
    expect(sockets).toHaveLength(2);
    expect(sockets[1].url).toContain('recovered-token');
  });
});
