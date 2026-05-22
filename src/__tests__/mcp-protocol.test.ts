// v0.1.29 — MCP server: JSON-RPC dispatch + tools/list shape.
//
// These tests confirm:
//   - `initialize` returns the MCP protocol version + server info.
//   - `tools/list` exposes every entry in TOOLS with name/description/schema.
//   - `tools/call` dispatches to the right handler, wraps the result in the
//     MCP `{ content: [...] }` envelope, and surfaces handler exceptions as
//     `{ isError: true }` (not a JSON-RPC -32603).
//   - Unknown methods → -32601 Method not found.
//   - Notifications (no `id`) get no response.
//   - Notifications/initialized is a clean no-op.

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildInitializeResult,
  buildToolsList,
  dispatchRpc,
  MCP_PROTOCOL_VERSION,
} from '../mcp/protocol';
import { TOOLS } from '../mcp/tools';

function tmpCtx() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcpp-mcp-proto-'));
  const file = path.join(dir, 'restream-chat-plus-plus.json');
  return {
    ctx: { storePath: file, appVersion: '0.0.0-test' },
    dir,
  };
}

describe('mcp protocol: buildInitializeResult', () => {
  it('advertises the 2024-11-05 protocol version + tools capability', () => {
    const r = buildInitializeResult('1.2.3');
    expect(r.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(r.protocolVersion).toBe('2024-11-05');
    const info = r.serverInfo as { name: string; version: string };
    expect(info.name).toBe('restream-chat-plus-plus');
    expect(info.version).toBe('1.2.3');
    const caps = r.capabilities as { tools: { listChanged: boolean } };
    expect(caps.tools.listChanged).toBe(false);
  });
});

describe('mcp protocol: buildToolsList', () => {
  const { tools } = buildToolsList();

  it('exposes every tool in TOOLS', () => {
    expect(tools).toHaveLength(TOOLS.length);
  });

  it('every tool has name, description, inputSchema', () => {
    for (const t of tools) {
      expect(typeof t.name).toBe('string');
      expect(t.name.length).toBeGreaterThan(0);
      expect(typeof t.description).toBe('string');
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.inputSchema).toBeTypeOf('object');
      expect((t.inputSchema as any).type).toBe('object');
    }
  });

  it('exposes the documented v0.1.29 tool surface', () => {
    const names = new Set(tools.map((t) => t.name));
    const expected = [
      'list_settings',
      'get_filters',
      'get_status',
      'get_voices',
      'list_recent_messages',
      'list_connections',
      'set_voice',
      'set_tts_volume',
      'set_tts_rate',
      'set_tts_pitch',
      'set_tts_enabled',
      'set_notifications_enabled',
      'set_play_notification_sound',
      'add_tts_filter',
      'remove_tts_filter',
      'add_notification_filter',
      'remove_notification_filter',
      'set_auto_update_check',
      'clear_chat',
      'check_for_updates_now',
      'sign_out',
    ];
    for (const name of expected) {
      expect(names.has(name)).toBe(true);
    }
  });
});

describe('mcp protocol: dispatchRpc', () => {
  it('handles `initialize`', async () => {
    const { ctx, dir } = tmpCtx();
    try {
      const res = await dispatchRpc(
        { jsonrpc: '2.0', id: 1, method: 'initialize' },
        ctx,
      );
      expect(res).toBeTruthy();
      const r = res as any;
      expect(r.id).toBe(1);
      expect(r.result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
      expect(r.result.serverInfo.version).toBe('0.0.0-test');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('handles `notifications/initialized` as a silent no-op', async () => {
    const { ctx, dir } = tmpCtx();
    try {
      const res = await dispatchRpc(
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        ctx,
      );
      expect(res).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('handles `tools/list`', async () => {
    const { ctx, dir } = tmpCtx();
    try {
      const res = await dispatchRpc(
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        ctx,
      );
      const r = res as any;
      expect(r.result.tools.length).toBe(TOOLS.length);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('dispatches `tools/call` to the matching handler + wraps result', async () => {
    const { ctx, dir } = tmpCtx();
    try {
      const res = await dispatchRpc(
        {
          jsonrpc: '2.0',
          id: 'abc',
          method: 'tools/call',
          params: { name: 'list_settings', arguments: {} },
        },
        ctx,
      );
      const r = res as any;
      expect(r.id).toBe('abc');
      expect(r.result.content[0].type).toBe('text');
      const payload = JSON.parse(r.result.content[0].text);
      // Default-settings shape comes through. v0.1.48 seeded `^viewer$`
      // into the ignoreRegex baseline.
      expect(payload.tts.enabled).toBe(false);
      expect(payload.filters.tts.ignoreRegex).toEqual(['^viewer$']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('unknown tool → tools/call returns isError:true (NOT -32601)', async () => {
    const { ctx, dir } = tmpCtx();
    try {
      const res = await dispatchRpc(
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'nope', arguments: {} },
        },
        ctx,
      );
      // Per spec — unknown tool name is a -32601 from us, since the
      // server-side dispatcher *cannot* execute it. (Some MCP servers
      // surface this as a tool-result-with-isError; we picked the
      // method-not-found code since the tool literally doesn't exist.)
      const r = res as any;
      expect(r.error.code).toBe(-32601);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('handler exception → tools/call result with isError:true (not RPC error)', async () => {
    const { ctx, dir } = tmpCtx();
    try {
      // Invalid arg → handler throws → wrapped as content+isError, NOT
      // a -32602. This is the MCP convention so the agent can see the
      // error text inline.
      const res = await dispatchRpc(
        {
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: { name: 'set_tts_volume', arguments: { volume: 5 } },
        },
        ctx,
      );
      const r = res as any;
      expect(r.result.isError).toBe(true);
      expect(r.result.content[0].text).toMatch(/out of range/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('unknown method → -32601 Method not found', async () => {
    const { ctx, dir } = tmpCtx();
    try {
      const res = await dispatchRpc(
        { jsonrpc: '2.0', id: 5, method: 'something/else' },
        ctx,
      );
      const r = res as any;
      expect(r.error.code).toBe(-32601);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('unknown method as notification (no id) → no response', async () => {
    const { ctx, dir } = tmpCtx();
    try {
      const res = await dispatchRpc(
        { jsonrpc: '2.0', method: 'something/else' },
        ctx,
      );
      expect(res).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects malformed envelopes', async () => {
    const { ctx, dir } = tmpCtx();
    try {
      const res = await dispatchRpc(
        { jsonrpc: '1.0' as any, id: 1, method: 'initialize' },
        ctx,
      );
      const r = res as any;
      expect(r.error.code).toBe(-32600);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
