// v0.1.29 — MCP server: file-backed Settings round-trip via `store-io.ts`.
//
// These tests confirm:
//   - Missing store file → DEFAULT_SETTINGS merge (the same shape
//     `loadSettings` in main.ts produces for a fresh install).
//   - Partial / pre-v0.1.26 store blobs migrate forward (filters section
//     defaulted, all per-section keys filled).
//   - `mutateSettings` round-trips atomically — concurrent token / tokenEnc
//     keys at the top of the file pass through unchanged.
//   - Writes are atomic via a `<file>.tmp.<pid>.<n>` → rename, so a crash
//     mid-write doesn't corrupt the on-disk JSON.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadSettings,
  mergeSettings,
  mutateSettings,
  readStoreFile,
  writeStoreFile,
} from '../mcp/store-io';
import { DEFAULT_SETTINGS } from '../shared/types';

function makeTmpStore(): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcpp-mcp-store-'));
  const file = path.join(dir, 'restream-chat-plus-plus.json');
  return { dir, file };
}

describe('store-io: readStoreFile', () => {
  let tmp: { dir: string; file: string };
  beforeEach(() => {
    tmp = makeTmpStore();
  });
  afterEach(() => {
    fs.rmSync(tmp.dir, { recursive: true, force: true });
  });

  it('returns {} for a missing file', () => {
    expect(readStoreFile(tmp.file)).toEqual({});
  });

  it('returns {} for an empty file', () => {
    fs.writeFileSync(tmp.file, '');
    expect(readStoreFile(tmp.file)).toEqual({});
  });

  it('parses a well-formed store file', () => {
    fs.writeFileSync(
      tmp.file,
      JSON.stringify({ settings: { tts: { enabled: true } }, tokenEnc: 'abc' }),
    );
    const r = readStoreFile(tmp.file);
    expect(r.tokenEnc).toBe('abc');
    expect((r.settings as any)?.tts?.enabled).toBe(true);
  });

  it('throws on malformed JSON (do not nuke user settings)', () => {
    fs.writeFileSync(tmp.file, '{not valid');
    expect(() => readStoreFile(tmp.file)).toThrow();
  });
});

describe('store-io: mergeSettings', () => {
  it('returns DEFAULT_SETTINGS for undefined input', () => {
    expect(mergeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
  });

  it('defaults the filters section for pre-v0.1.26 blobs (mirror of loadSettings in main.ts)', () => {
    const legacy = {
      tts: {
        enabled: true,
        readSenderName: false,
        rate: 1,
        pitch: 1,
        volume: 1,
        maxPerMinute: 20,
      },
    } as any;
    const merged = mergeSettings(legacy);
    expect(merged.filters.tts.ignoreRegex).toEqual([]);
    expect(merged.filters.notifications.ignoreRegex).toEqual([]);
    expect(merged.tts.enabled).toBe(true);
  });

  it('preserves user-set regex lists', () => {
    const merged = mergeSettings({
      filters: {
        tts: { ignoreRegex: ['^!cmd'] },
        notifications: { ignoreRegex: ['bot'] },
      },
    } as any);
    expect(merged.filters.tts.ignoreRegex).toEqual(['^!cmd']);
    expect(merged.filters.notifications.ignoreRegex).toEqual(['bot']);
  });
});

describe('store-io: mutateSettings', () => {
  let tmp: { dir: string; file: string };
  beforeEach(() => {
    tmp = makeTmpStore();
  });
  afterEach(() => {
    fs.rmSync(tmp.dir, { recursive: true, force: true });
  });

  it('creates the file on first write when no store file exists', () => {
    const next = mutateSettings(tmp.file, (s) => ({
      ...s,
      tts: { ...s.tts, volume: 0.4 },
    }));
    expect(next.tts.volume).toBe(0.4);
    expect(fs.existsSync(tmp.file)).toBe(true);
    const reread = loadSettings(tmp.file);
    expect(reread.tts.volume).toBe(0.4);
  });

  it('preserves tokenEnc / token keys across a mutation', () => {
    fs.writeFileSync(
      tmp.file,
      JSON.stringify({
        token: { accessToken: 'legacy' },
        tokenEnc: 'encrypted-blob',
        settings: { tts: { enabled: false } },
      }),
    );
    mutateSettings(tmp.file, (s) => ({
      ...s,
      tts: { ...s.tts, enabled: true },
    }));
    const raw = JSON.parse(fs.readFileSync(tmp.file, 'utf8'));
    expect(raw.tokenEnc).toBe('encrypted-blob');
    expect(raw.token.accessToken).toBe('legacy');
    expect(raw.settings.tts.enabled).toBe(true);
  });

  it('does not leave a `.tmp.<pid>.<n>` lingering after success', () => {
    mutateSettings(tmp.file, (s) => s);
    const stragglers = fs
      .readdirSync(tmp.dir)
      .filter((n) => n.includes('.tmp.'));
    expect(stragglers).toEqual([]);
  });
});

describe('store-io: writeStoreFile atomicity', () => {
  it('produces the same content via rename — final file is well-formed JSON', () => {
    const tmp = makeTmpStore();
    try {
      writeStoreFile(tmp.file, {
        settings: { tts: { enabled: true } } as any,
      });
      const parsed = JSON.parse(fs.readFileSync(tmp.file, 'utf8'));
      expect(parsed.settings.tts.enabled).toBe(true);
    } finally {
      fs.rmSync(tmp.dir, { recursive: true, force: true });
    }
  });
});
