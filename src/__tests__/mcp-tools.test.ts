// v0.1.29 — MCP server: per-tool schema validation + persistence side-effect.
//
// We exercise each WRITE tool's happy path AND its arg-validation path so
// out-of-range or wrong-type arguments are caught at the handler level
// (the JSON-Schema in inputSchema is advisory — the actual gate is the
// handler's `requireRange` / `requireBoolean` / etc. calls).
//
// Reads are exercised through `dispatchRpc` in mcp-protocol.test.ts —
// these tests focus on the mutation side.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TOOLS_BY_NAME } from '../mcp/tools';
import { loadSettings } from '../mcp/store-io';

let tmpDir: string;
let storeFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcpp-mcp-tools-'));
  storeFile = path.join(tmpDir, 'restream-chat-plus-plus.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function call(name: string, args: Record<string, unknown>): Promise<unknown> {
  const tool = TOOLS_BY_NAME.get(name);
  if (!tool) throw new Error(`tool not found: ${name}`);
  return tool.handler(args, { storePath: storeFile, appVersion: '0.0.0-test' });
}

describe('mcp tools: set_voice', () => {
  it('persists the voiceURI to disk', async () => {
    await call('set_voice', { voiceURI: 'com.apple.voice.compact.en-GB.Daniel' });
    expect(loadSettings(storeFile).tts.voiceURI).toBe(
      'com.apple.voice.compact.en-GB.Daniel',
    );
  });

  it('rejects empty / missing voiceURI', async () => {
    await expect(call('set_voice', {})).rejects.toThrow();
    await expect(call('set_voice', { voiceURI: '' })).rejects.toThrow();
  });
});

describe('mcp tools: set_tts_volume / rate / pitch', () => {
  it('persists volume in [0,1]', async () => {
    await call('set_tts_volume', { volume: 0.6 });
    expect(loadSettings(storeFile).tts.volume).toBe(0.6);
  });

  it('rejects volume outside [0,1]', async () => {
    await expect(call('set_tts_volume', { volume: 2 })).rejects.toThrow();
    await expect(call('set_tts_volume', { volume: -0.1 })).rejects.toThrow();
  });

  it('persists rate in [0.5,2]', async () => {
    await call('set_tts_rate', { rate: 1.5 });
    expect(loadSettings(storeFile).tts.rate).toBe(1.5);
  });

  it('rejects rate outside [0.5,2]', async () => {
    await expect(call('set_tts_rate', { rate: 0.4 })).rejects.toThrow();
    await expect(call('set_tts_rate', { rate: 3 })).rejects.toThrow();
  });

  it('persists pitch in [0,2]', async () => {
    await call('set_tts_pitch', { pitch: 0.8 });
    expect(loadSettings(storeFile).tts.pitch).toBe(0.8);
  });

  it('rejects pitch outside [0,2]', async () => {
    await expect(call('set_tts_pitch', { pitch: 5 })).rejects.toThrow();
  });

  it('rejects non-numeric args', async () => {
    await expect(call('set_tts_volume', { volume: 'loud' })).rejects.toThrow();
  });
});

describe('mcp tools: set_tts_enabled / set_notifications_enabled', () => {
  it('persists the bool flag', async () => {
    await call('set_tts_enabled', { enabled: true });
    expect(loadSettings(storeFile).tts.enabled).toBe(true);
    await call('set_tts_enabled', { enabled: false });
    expect(loadSettings(storeFile).tts.enabled).toBe(false);
  });

  it('rejects non-boolean enabled', async () => {
    await expect(call('set_tts_enabled', { enabled: 'yes' })).rejects.toThrow();
  });

  it('toggles notifications.enabled', async () => {
    await call('set_notifications_enabled', { enabled: true });
    expect(loadSettings(storeFile).notifications.enabled).toBe(true);
  });

  it('toggles notifications.soundEnabled via set_play_notification_sound', async () => {
    await call('set_play_notification_sound', { enabled: false });
    expect(loadSettings(storeFile).notifications.soundEnabled).toBe(false);
  });
});

describe('mcp tools: filter list management', () => {
  // v0.1.48: DEFAULT_SETTINGS.filters.{tts,notifications}.ignoreRegex now
  // ship with `['^viewer$']` as the seeded baseline. A fresh test store
  // (empty / no settings persisted) therefore reads back the seeded list,
  // not `[]`. The mutate→read flow tests below remove the seed first when
  // they want a clean baseline so the meaningful assertion is on the
  // operation under test rather than the seed.
  const SEED = '^viewer$';

  it('add → list → remove for the TTS list', async () => {
    // Strip the v0.1.48 seed so the rest of the test reads cleanly.
    await call('remove_tts_filter', { regex: SEED });
    await call('add_tts_filter', { regex: '^!cmd' });
    await call('add_tts_filter', { regex: 'bot$' });
    let s = loadSettings(storeFile);
    expect(s.filters.tts.ignoreRegex).toEqual(['^!cmd', 'bot$']);

    // Dedupe — adding the same pattern is a no-op.
    await call('add_tts_filter', { regex: '^!cmd' });
    s = loadSettings(storeFile);
    expect(s.filters.tts.ignoreRegex).toEqual(['^!cmd', 'bot$']);

    await call('remove_tts_filter', { regex: '^!cmd' });
    s = loadSettings(storeFile);
    expect(s.filters.tts.ignoreRegex).toEqual(['bot$']);
  });

  it('rejects invalid regex at add time (not silent skip)', async () => {
    await expect(
      call('add_tts_filter', { regex: '[unclosed' }),
    ).rejects.toThrow(/Invalid regex/);
  });

  it('TTS + notifications lists are independent', async () => {
    // Strip the v0.1.48 seed from both lists first.
    await call('remove_tts_filter', { regex: SEED });
    await call('remove_notification_filter', { regex: SEED });
    await call('add_tts_filter', { regex: 'tts-only' });
    await call('add_notification_filter', { regex: 'notif-only' });
    const s = loadSettings(storeFile);
    expect(s.filters.tts.ignoreRegex).toEqual(['tts-only']);
    expect(s.filters.notifications.ignoreRegex).toEqual(['notif-only']);
  });

  it('remove on a missing pattern is a silent no-op', async () => {
    // The v0.1.48 seed sits in the list at the start of this test; removing
    // a never-added pattern is a no-op, so the seed stays put.
    await call('remove_tts_filter', { regex: 'never-added' });
    const s = loadSettings(storeFile);
    expect(s.filters.tts.ignoreRegex).toEqual([SEED]);
  });

  it('v0.1.48: empty store reads back the seeded `^viewer$` baseline', () => {
    const s = loadSettings(storeFile);
    expect(s.filters.tts.ignoreRegex).toEqual([SEED]);
    expect(s.filters.notifications.ignoreRegex).toEqual([SEED]);
  });
});

describe('mcp tools: set_auto_update_check', () => {
  it('toggles update.autoCheck', async () => {
    await call('set_auto_update_check', { enabled: false });
    expect(loadSettings(storeFile).update.autoCheck).toBe(false);
    await call('set_auto_update_check', { enabled: true });
    expect(loadSettings(storeFile).update.autoCheck).toBe(true);
  });
});

describe('mcp tools: get_status / get_filters / list_settings', () => {
  it('list_settings returns merged defaults on empty store', async () => {
    const out = (await call('list_settings', {})) as any;
    expect(out.tts.enabled).toBe(false);
    // v0.1.48: the empty-store default now seeds `^viewer$` into both
    // ignoreRegex lists.
    expect(out.filters.tts.ignoreRegex).toEqual(['^viewer$']);
    expect(out.filters.notifications.ignoreRegex).toEqual(['^viewer$']);
  });

  it('get_filters returns current ignore lists', async () => {
    // Strip the v0.1.48 seed before adding so the assertion is clean.
    await call('remove_tts_filter', { regex: '^viewer$' });
    await call('remove_notification_filter', { regex: '^viewer$' });
    await call('add_tts_filter', { regex: 'foo' });
    await call('add_notification_filter', { regex: 'bar' });
    const r = (await call('get_filters', {})) as any;
    expect(r.tts).toEqual(['foo']);
    expect(r.notifications).toEqual(['bar']);
  });

  it('get_status reports hasPersistedAuthToken correctly', async () => {
    // No token → false.
    let r = (await call('get_status', {})) as any;
    expect(r.hasPersistedAuthToken).toBe(false);
    expect(r.appVersion).toBe('0.0.0-test');
    expect(r.connectionStatus).toBeNull();

    // Write a tokenEnc → true (we never decrypt; just detect presence).
    fs.writeFileSync(
      storeFile,
      JSON.stringify({
        tokenEnc: 'fake-encrypted-blob',
        settings: { tts: { enabled: true } },
      }),
    );
    r = (await call('get_status', {})) as any;
    expect(r.hasPersistedAuthToken).toBe(true);
    expect(r.ttsEnabled).toBe(true);
  });
});

describe('mcp tools: sign_out', () => {
  it('removes token + tokenEnc but preserves settings', async () => {
    fs.writeFileSync(
      storeFile,
      JSON.stringify({
        token: { accessToken: 'legacy' },
        tokenEnc: 'encrypted',
        settings: { tts: { enabled: true } },
      }),
    );
    const r = (await call('sign_out', {})) as any;
    expect(r.ok).toBe(true);
    const after = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
    expect(after.token).toBeUndefined();
    expect(after.tokenEnc).toBeUndefined();
    expect(after.settings.tts.enabled).toBe(true);
  });

  it('is idempotent on a missing store file', async () => {
    const r = (await call('sign_out', {})) as any;
    expect(r.ok).toBe(true);
    expect(r.alreadySignedOut).toBe(true);
  });
});

describe('mcp tools: runtime-only stubs return guiNotIntrospectable', () => {
  it('clear_chat surfaces the hint', async () => {
    const r = (await call('clear_chat', {})) as any;
    expect(r.guiNotIntrospectable).toBe(true);
    expect(r.hint).toMatch(/loopback IPC/);
  });

  it('check_for_updates_now surfaces the hint', async () => {
    const r = (await call('check_for_updates_now', {})) as any;
    expect(r.guiNotIntrospectable).toBe(true);
  });

  it('list_recent_messages surfaces a non-introspectable note', async () => {
    const r = (await call('list_recent_messages', {})) as any;
    expect(r.messages).toBeNull();
    expect(r.hint).toMatch(/renderer/);
  });

  it('list_connections surfaces a non-introspectable note', async () => {
    const r = (await call('list_connections', {})) as any;
    expect(r.connections).toBeNull();
  });

  it('get_voices returns currentVoiceURI + null list + hint', async () => {
    await call('set_voice', { voiceURI: 'com.apple.voice.compact.en-GB.Daniel' });
    const r = (await call('get_voices', {})) as any;
    expect(r.currentVoiceURI).toBe('com.apple.voice.compact.en-GB.Daniel');
    expect(r.voices).toBeNull();
    expect(r.hint).toMatch(/renderer/);
  });
});
