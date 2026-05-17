// Direct file-based read/write of the electron-store JSON used by the
// running Restream Chat++ GUI.
//
// We deliberately do NOT depend on `electron-store` itself — that module is
// ESM-only and pulls a small dep tree (Conf, dot-prop, JSON-schema validation)
// we don't need. The store file is just JSON; we round-trip it with
// `JSON.parse(fs.readFileSync())` and atomic-write back. That gives the MCP
// binary one cheap responsibility: settings-on-disk mutation. The running
// GUI subscribes to changes via its existing pull-on-IPC pattern — the
// renderer re-fetches via `IPC.SETTINGS_GET` whenever it needs current
// values, so an MCP write picks up next time the user opens the Settings
// drawer / TTS pipeline reads its config / etc.
//
// We DO call `electron.app.getPath('userData')` to resolve the store path
// when running inside Electron (the normal `--mcp-stdio` invocation). This
// works pre-`app.whenReady()` since `getPath` is synchronous and doesn't
// require the app loop. When running outside Electron (unit tests), the
// caller passes the path explicitly.
//
// Atomic write strategy: write to `<path>.tmp.<pid>.<n>`, fsync, then
// `fs.renameSync` to the target. This is the same shape electron-store
// uses internally via the `write-file-atomic` package — we hand-roll it to
// keep the dep tree clean.

import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_SETTINGS, type Settings } from '../shared/types';

/**
 * Compose the on-disk JSON shape that electron-store actually writes. The
 * top-level keys mirror `StoreSchema` in `src/main/store.ts`:
 *
 *   - `settings`  — the typed Settings object (what we mutate)
 *   - `token`     — legacy plain token (read-only path from v0.1.15)
 *   - `tokenEnc`  — encrypted token blob (we never touch this)
 *
 * We keep everything except `settings` opaque (`unknown`) so a future
 * electron-store schema addition can't drop fields on round-trip.
 */
export interface StoreFile {
  settings?: Settings;
  // Anything else electron-store wrote — pass through unchanged on write.
  [key: string]: unknown;
}

/**
 * Resolve the absolute path to the electron-store JSON file. When called
 * from inside an Electron process this defers to `app.getPath('userData')`
 * which works pre-ready. When called from a unit test you pass
 * `userDataDir` explicitly to bypass the dynamic require.
 *
 * The file basename matches the `name` we pass to `new ElectronStore({
 * name: 'restream-chat-plus-plus' })` in `src/main/store.ts`. Keep them in
 * sync — a divergence here would silently drop user settings on first
 * MCP write.
 */
export function resolveStorePath(userDataDir?: string): string {
  if (userDataDir) {
    return path.join(userDataDir, 'restream-chat-plus-plus.json');
  }
  // Lazy require so unit tests (which never call this function) can import
  // the module under plain Node without the `electron` peer dep available.
  // Production callers in `--mcp-stdio` always run under Electron where
  // this resolves cleanly. `app.getPath('userData')` works pre-ready.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require('electron') as {
      app?: { getPath?: (name: string) => string };
    };
    const dir = electron?.app?.getPath?.('userData');
    if (dir) return path.join(dir, 'restream-chat-plus-plus.json');
  } catch {
    // fall through to the explicit error
  }
  throw new Error(
    'resolveStorePath: not running inside Electron and no userDataDir override given',
  );
}

/**
 * Read the entire store file. Missing file → empty object (the same way
 * electron-store boots on first run). Malformed JSON throws — we'd rather
 * surface a clear error to the MCP caller than silently nuke the user's
 * settings.
 */
export function readStoreFile(filePath: string): StoreFile {
  try {
    const buf = fs.readFileSync(filePath, 'utf8');
    if (!buf.trim()) return {};
    const parsed = JSON.parse(buf);
    if (parsed && typeof parsed === 'object') return parsed as StoreFile;
    return {};
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e?.code === 'ENOENT') return {};
    throw err;
  }
}

/**
 * Apply the same shallow-per-section merge `main.ts` uses for in-Electron
 * loads so the MCP returns a fully-typed Settings (never `undefined` field)
 * regardless of what's been persisted by older builds. Mirrors the
 * `loadSettings` function in `src/main/main.ts` — keep both in sync.
 */
export function mergeSettings(stored: Partial<Settings> | undefined): Settings {
  if (!stored) return DEFAULT_SETTINGS;
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    tts: { ...DEFAULT_SETTINGS.tts, ...(stored.tts ?? {}) },
    notifications: { ...DEFAULT_SETTINGS.notifications, ...(stored.notifications ?? {}) },
    filter: {
      ...DEFAULT_SETTINGS.filter,
      ...(stored.filter ?? {}),
      platforms: {
        ...DEFAULT_SETTINGS.filter.platforms,
        ...(stored.filter?.platforms ?? {}),
      },
    },
    filters: {
      ...DEFAULT_SETTINGS.filters,
      ...(stored.filters ?? {}),
      tts: {
        ...DEFAULT_SETTINGS.filters.tts,
        ...(stored.filters?.tts ?? {}),
      },
      notifications: {
        ...DEFAULT_SETTINGS.filters.notifications,
        ...(stored.filters?.notifications ?? {}),
      },
    },
    update: { ...DEFAULT_SETTINGS.update, ...(stored.update ?? {}) },
  };
}

/**
 * Read and merge the current Settings from the store file. Returns
 * DEFAULT_SETTINGS if the file is missing / has no `settings` key.
 */
export function loadSettings(filePath: string): Settings {
  const file = readStoreFile(filePath);
  return mergeSettings(file.settings);
}

let atomicCounter = 0;

/**
 * Atomically replace the store file with new contents. Writes the entire
 * `StoreFile` (not just `settings`) so we don't accidentally drop the
 * encrypted token / legacy keys that electron-store also persists.
 */
export function writeStoreFile(filePath: string, contents: StoreFile): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}.${atomicCounter++}`;
  const data = JSON.stringify(contents, null, '\t');
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, data);
    try {
      fs.fsyncSync(fd);
    } catch {
      // fsync is best-effort — some filesystems (network mounts, certain
      // Linux FUSE configs) don't support it. We still proceed with rename.
    }
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
}

/**
 * Read → transform → write helper. The `mutate` callback receives the
 * fully-merged current Settings and returns the new Settings. We only
 * touch the `settings` key — all other top-level keys (token, tokenEnc)
 * pass through unchanged. Returns the new Settings.
 */
export function mutateSettings(
  filePath: string,
  mutate: (current: Settings) => Settings,
): Settings {
  const file = readStoreFile(filePath);
  const current = mergeSettings(file.settings);
  const next = mutate(current);
  writeStoreFile(filePath, { ...file, settings: next });
  return next;
}
