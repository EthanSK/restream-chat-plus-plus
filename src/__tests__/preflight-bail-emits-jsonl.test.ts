import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChatSendQueue } from '../main/chat-send-queue';
import { sendChatText, type ChatSendLogRecord } from '../main/chat-send';
import type { ChatConnection, ChatSendStatus } from '../shared/types';

/**
 * v0.1.63 — preflight bails must be observable in both places Ethan needs:
 *
 *   1. `chat-send.jsonl` gets a `phase:"preflight"` row so the disk logs
 *      explain why no POST was attempted.
 *   2. The non-blocking send queue emits `status:"failed"` so the renderer
 *      turns the optimistic placeholder into a red warning instead of
 *      leaving it stuck on "sending".
 */

let tempDir: string | undefined;

function makeConn(id: string): ChatConnection {
  return {
    connectionIdentifier: id,
    connectionUuid: `${id}-uuid`,
    eventSourceId: 2,
    platform: 'twitch',
    status: 'connected',
    updatedAt: Date.now(),
  };
}

function fakeSession(cookies: Array<{ name: string; value: string }>): any {
  return {
    cookies: {
      get: async () => cookies,
    },
  };
}

function appendJsonl(logPath: string, record: ChatSendLogRecord): void {
  fs.appendFileSync(logPath, JSON.stringify(record) + '\n', 'utf8');
}

describe('preflight bail logging + queue status (v0.1.63)', () => {
  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('logs no-session-cookies to chat-send.jsonl and emits failed status', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcpp-chat-send-'));
    const logPath = path.join(tempDir, 'chat-send.jsonl');
    const statuses: ChatSendStatus[] = [];
    const queue = createChatSendQueue({
      runSend: async () =>
        sendChatText({
          text: 'hello from queue',
          connections: [makeConn('c1')],
          context: { showId: 'show-1' },
          parentWindow: null,
          // Mirrors the v0.1.62/v0.1.63 failure signature: OAuth analytics
          // cookies exist, but the chat-session XSRF cookie needed for
          // `POST /api/client/reply` was wiped by the signing-identity change.
          getSession: () =>
            fakeSession([
              { name: '_ga', value: 'GA1.x.y' },
              { name: '_gid', value: 'GA1.x.z' },
            ]),
          skipColdStart: true,
          fetchImpl: vi.fn() as any,
          log: (record) => appendJsonl(logPath, record),
        }),
      emitStatus: (status) => {
        statuses.push(status);
      },
      minSpacingMs: 0,
    });

    queue.enqueue({ clientId: 'local-cookie-bail', text: 'hello from queue' });
    await queue.whenIdle();

    const rows = fs
      .readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as ChatSendLogRecord);
    expect(rows).toHaveLength(1);
    expect(rows[0].phase).toBe('preflight');
    if (rows[0].phase === 'preflight') {
      expect(rows[0].reason).toBe('no-session-cookies');
      expect(rows[0].coldStartAttempted).toBe(false);
      expect(rows[0].cookieNames).toEqual(['_ga', '_gid']);
      expect(rows[0].hasXsrf).toBe(false);
    }

    const failure = statuses.find(
      (status) =>
        status.clientId === 'local-cookie-bail' && status.status === 'failed',
    );
    expect(failure).toBeDefined();
    expect(failure?.reason).toBe('no-session-cookies');
  });
});
