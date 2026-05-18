// v0.1.36 — MCP HTTP transport: end-to-end POST /mcp dispatch + port-file
// lifecycle.
//
// These tests confirm the in-process HTTP MCP architecture works exactly
// as documented:
//
//   - The server binds to 127.0.0.1 on an ephemeral port (we pass port=0
//     so we never collide with a developer running the real GUI).
//   - POST /mcp dispatches initialize / tools/list / tools/call through
//     the same `dispatchRpc` the stdio path used.
//   - Notifications (no `id`) get HTTP 202 + empty body.
//   - The port-discovery file gets written on listen-success and removed
//     on close, with the right shape.
//   - GET /health returns the live name + appVersion + pid.
//   - Mutations applied via HTTP show up immediately on disk (the live
//     bridge isn't used in these tests; we exercise the file-backed
//     path so we re-use the existing DEFAULT_SETTINGS merge).

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {
  startHttpMcpServer,
  resolvePortFilePath,
  type HttpMcpServer,
} from '../mcp/http';
import type { ToolContext } from '../mcp/tools';
import { loadSettings } from '../mcp/store-io';
import { MCP_PROTOCOL_VERSION } from '../mcp/protocol';

interface Harness {
  dir: string;
  storeFile: string;
  portFile: string;
  ctx: ToolContext;
  server: HttpMcpServer;
}

async function startHarness(): Promise<Harness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcpp-mcp-http-'));
  const storeFile = path.join(dir, 'restream-chat-plus-plus.json');
  const portFile = resolvePortFilePath(dir);
  const ctx: ToolContext = { storePath: storeFile, appVersion: '0.0.0-test' };
  // port: 0 — let the OS assign a free port so parallel test runs / a
  // developer with the real GUI on 19852 don't collide.
  const server = await startHttpMcpServer({
    ctx,
    port: 0,
    portFilePath: portFile,
    log: () => undefined,
  });
  return { dir, storeFile, portFile, ctx, server };
}

async function stopHarness(h: Harness): Promise<void> {
  try {
    await h.server.close();
  } catch {
    // ignore
  }
  fs.rmSync(h.dir, { recursive: true, force: true });
}

/**
 * Tiny JSON POST helper. Returns parsed JSON or empty-string body for 202.
 */
function postJson(
  port: number,
  body: unknown,
): Promise<{ status: number; bodyText: string; json: unknown }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (buf += chunk));
        res.on('end', () => {
          let parsed: unknown = null;
          try {
            parsed = buf.length > 0 ? JSON.parse(buf) : null;
          } catch {
            parsed = buf;
          }
          resolve({ status: res.statusCode ?? 0, bodyText: buf, json: parsed });
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function getJson(
  port: number,
  pathname: string,
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: pathname, method: 'GET' },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (buf += chunk));
        res.on('end', () => {
          let parsed: unknown = null;
          try {
            parsed = buf.length > 0 ? JSON.parse(buf) : null;
          } catch {
            parsed = buf;
          }
          resolve({ status: res.statusCode ?? 0, json: parsed });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('mcp http: lifecycle', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await startHarness();
  });

  afterEach(async () => {
    await stopHarness(h);
  });

  it('binds to 127.0.0.1 on an ephemeral port', () => {
    expect(h.server.port).toBeGreaterThan(0);
    const addr = h.server.server.address() as { address?: string };
    expect(addr.address).toBe('127.0.0.1');
  });

  it('writes the port-discovery file with port + pid + startedAt', () => {
    expect(fs.existsSync(h.portFile)).toBe(true);
    const meta = JSON.parse(fs.readFileSync(h.portFile, 'utf8'));
    expect(meta.port).toBe(h.server.port);
    expect(meta.pid).toBe(process.pid);
    expect(typeof meta.startedAt).toBe('string');
    // Should round-trip through Date.
    expect(Number.isNaN(new Date(meta.startedAt).getTime())).toBe(false);
  });

  it('removes the port-discovery file on close', async () => {
    expect(fs.existsSync(h.portFile)).toBe(true);
    await h.server.close();
    expect(fs.existsSync(h.portFile)).toBe(false);
  });

  it('responds to GET /health with the app name + version + pid', async () => {
    const { status, json } = await getJson(h.server.port, '/health');
    expect(status).toBe(200);
    expect((json as any).ok).toBe(true);
    expect((json as any).name).toBe('restream-chat-plus-plus');
    expect((json as any).version).toBe('0.0.0-test');
    expect((json as any).pid).toBe(process.pid);
  });

  it('responds to GET /mcp with a JSON probe payload', async () => {
    const { status, json } = await getJson(h.server.port, '/mcp');
    expect(status).toBe(200);
    expect((json as any).transport).toBe('streamable-http');
    expect((json as any).endpoint).toBe('POST /mcp');
  });

  it('returns 404 for unknown routes', async () => {
    const { status } = await getJson(h.server.port, '/does-not-exist');
    expect(status).toBe(404);
  });
});

describe('mcp http: JSON-RPC dispatch', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await startHarness();
  });

  afterEach(async () => {
    await stopHarness(h);
  });

  it('handles initialize → returns protocol version + serverInfo', async () => {
    const { status, json } = await postJson(h.server.port, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
    });
    expect(status).toBe(200);
    expect((json as any).id).toBe(1);
    expect((json as any).result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect((json as any).result.serverInfo.name).toBe('restream-chat-plus-plus');
    expect((json as any).result.serverInfo.version).toBe('0.0.0-test');
  });

  it('handles tools/list → returns the full tool surface', async () => {
    const { json } = await postJson(h.server.port, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });
    const tools = (json as any).result.tools as Array<{ name: string }>;
    const names = tools.map((t) => t.name);
    expect(names).toContain('list_settings');
    expect(names).toContain('set_voice');
    expect(names).toContain('add_tts_filter');
  });

  it('handles tools/call → dispatches + wraps in MCP content envelope', async () => {
    const { json } = await postJson(h.server.port, {
      jsonrpc: '2.0',
      id: 'abc',
      method: 'tools/call',
      params: { name: 'list_settings', arguments: {} },
    });
    const result = (json as any).result;
    expect(result.content[0].type).toBe('text');
    const settings = JSON.parse(result.content[0].text);
    expect(settings.tts.enabled).toBe(false);
  });

  it('persists mutations to disk via tools/call', async () => {
    await postJson(h.server.port, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'set_voice',
        arguments: { voiceURI: 'com.apple.voice.compact.en-GB.Daniel' },
      },
    });
    const s = loadSettings(h.storeFile);
    expect(s.tts.voiceURI).toBe('com.apple.voice.compact.en-GB.Daniel');
  });

  it('returns HTTP 202 + empty body for notifications (no id)', async () => {
    const { status, bodyText } = await postJson(h.server.port, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    expect(status).toBe(202);
    expect(bodyText).toBe('');
  });

  it('returns a JSON-RPC parse-error on malformed JSON', async () => {
    const port = h.server.port;
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/mcp',
          method: 'POST',
          headers: { 'content-type': 'application/json' },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        },
      );
      req.on('error', reject);
      req.write('{not json');
      req.end();
    });
    expect(status).toBe(400);
  });
});

describe('mcp http: live bridge integration', () => {
  it('routes reads + writes through the live bridge when provided', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcpp-mcp-http-live-'));
    try {
      const inMemory: any = {
        tts: { enabled: false, volume: 0.5, rate: 1, pitch: 1 },
      };
      // Round-trip everything via the live bridge; the storePath should
      // NEVER be touched because the bridge intercepts before the
      // fallback file I/O.
      const ctx: ToolContext = {
        storePath: path.join(dir, 'never-exists.json'),
        appVersion: '0.0.0-test',
        live: {
          readSettings: () => ({
            ...inMemory,
            // Pad to satisfy the Settings shape merge consumers expect.
            tts: { ...inMemory.tts },
            notifications: {
              enabled: false,
              soundEnabled: true,
              maxPerMinute: 30,
            },
            filter: { platforms: {} },
            filters: {
              tts: { ignoreRegex: [] },
              notifications: { ignoreRegex: [] },
            },
            update: { autoCheck: true },
          }),
          writeSettings: (next: any) => {
            Object.assign(inMemory, next);
            return next;
          },
        },
      };
      const server = await startHttpMcpServer({
        ctx,
        port: 0,
        portFilePath: null,
        log: () => undefined,
      });
      try {
        await postJson(server.port, {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'set_tts_volume', arguments: { volume: 0.8 } },
        });
        expect(inMemory.tts.volume).toBe(0.8);
        // The disk fallback should NOT have been written.
        expect(fs.existsSync(path.join(dir, 'never-exists.json'))).toBe(false);
      } finally {
        await server.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
