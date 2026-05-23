// v0.1.64 — MCP update orchestration tools.
//
// Exercises the four new tools added in v0.1.64 via the in-process
// `LiveSettingsBridge` (the production transport, not the legacy
// file-only `--mcp-stdio` path). Each test injects a fake bridge with
// controllable internal state — no Electron, no autoUpdater, no real
// filesystem write to main.log.
//
// Coverage:
//   - update_check_now : returns the bridge result + cached lastBroadcast.
//   - update_download_status :
//       * idle (no flags set)
//       * downloading (downloadInFlight + pendingVersion + downloadStartedAt)
//       * ready-to-install
//       * error with lastErrorMessage + lastErrorCategory
//   - update_install_now :
//       * happy path (returns { ok: true })
//       * refuses with reason='no-update-downloaded' when nothing staged
//   - update_logs_tail :
//       * filters main.log to updater-relevant lines
//       * respects the `lines` cap
//       * tolerates a missing log file (returns hint)
//
// These tools are HTTP-MCP-only by design — the legacy `--mcp-stdio`
// path returns the standard `guiNotIntrospectable` hint. We also exercise
// that fallback so future MCP transport refactors can't silently start
// claiming false success.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TOOLS_BY_NAME, type LiveSettingsBridge } from '../mcp/tools';
import { DEFAULT_SETTINGS, type Settings, type UpdateInfo } from '../shared/types';

let tmpDir: string;
let storeFile: string;
let logFile: string;
// Default to electron-log's macOS path so the tool's fallback locator
// picks it up automatically (we can't override app.getPath under Vitest).
let originalHome: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcpp-mcp-update-tools-'));
  storeFile = path.join(tmpDir, 'restream-chat-plus-plus.json');
  // Build a fake "macOS Library/Logs" tree so resolveLogPathCandidates can
  // find a log without us needing to monkey-patch the require('electron')
  // dance. The tool prefers electron's app.getPath when available — under
  // Vitest that require() throws, so the second candidate (HOME-based) wins.
  const logDir = path.join(tmpDir, 'Library', 'Logs', 'Restream Chat++');
  fs.mkdirSync(logDir, { recursive: true });
  logFile = path.join(logDir, 'main.log');
  originalHome = process.env.HOME;
  process.env.HOME = tmpDir;
});

afterEach(() => {
  // Restore HOME so other test files don't see our fake tree.
  if (originalHome !== undefined) {
    process.env.HOME = originalHome;
  } else {
    delete process.env.HOME;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/**
 * Seed the on-disk store so the LiveSettingsBridge's read path returns a
 * valid Settings object. The tools we're testing here don't read settings
 * but the underlying mutateSettingsVia plumbing does.
 */
function seedStore(s: Settings = DEFAULT_SETTINGS): void {
  fs.writeFileSync(storeFile, JSON.stringify(s, null, 2));
}

/**
 * Build a stub LiveSettingsBridge. Each test overrides exactly the
 * methods it needs to assert on; the rest fall through to safe defaults.
 */
function buildBridge(overrides: Partial<LiveSettingsBridge> = {}): LiveSettingsBridge {
  const settings: { current: Settings } = { current: { ...DEFAULT_SETTINGS } };
  return {
    readSettings: () => settings.current,
    writeSettings: (next) => {
      settings.current = next;
      return next;
    },
    ...overrides,
  };
}

function call(
  name: string,
  args: Record<string, unknown>,
  bridge?: LiveSettingsBridge,
): Promise<unknown> {
  const tool = TOOLS_BY_NAME.get(name);
  if (!tool) throw new Error(`tool not found: ${name}`);
  return tool.handler(args, {
    storePath: storeFile,
    appVersion: '0.1.64-test',
    live: bridge,
  });
}

// ---------------------------------------------------------------------------
// update_check_now
// ---------------------------------------------------------------------------

describe('mcp tools v0.1.64: update_check_now', () => {
  it('returns the fresh check result + last cached broadcast when bridge is wired', async () => {
    seedStore();
    const fresh: UpdateInfo = {
      kind: 'available',
      currentVersion: '0.1.63',
      latestVersion: '0.1.64',
      releaseUrl: 'https://github.com/EthanSK/restream-chat-plus-plus/releases',
      checkedAt: Date.now(),
    };
    const cached: UpdateInfo = {
      ...fresh,
      checkedAt: fresh.checkedAt - 5000,
    };
    const bridge = buildBridge({
      checkForUpdatesNow: vi.fn().mockResolvedValue(fresh),
      getLastUpdateInfo: vi.fn().mockReturnValue(cached),
    });
    const result = (await call('update_check_now', {}, bridge)) as {
      ok: boolean;
      updateInfo: UpdateInfo;
      lastBroadcast: UpdateInfo | null;
    };
    expect(result.ok).toBe(true);
    expect(result.updateInfo.latestVersion).toBe('0.1.64');
    expect(result.lastBroadcast?.latestVersion).toBe('0.1.64');
  });

  it('returns guiNotIntrospectable when no live bridge', async () => {
    seedStore();
    const result = (await call('update_check_now', {})) as { ok: boolean; guiNotIntrospectable?: boolean };
    expect(result.ok).toBe(false);
    expect(result.guiNotIntrospectable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// update_download_status
// ---------------------------------------------------------------------------

describe('mcp tools v0.1.64: update_download_status', () => {
  it('returns idle when no flags are set', async () => {
    seedStore();
    const bridge = buildBridge({
      getUpdateDownloadState: () => ({
        state: 'idle',
        pendingVersion: undefined,
        downloadStartedAt: undefined,
        lastErrorMessage: undefined,
        lastErrorCategory: undefined,
      }),
      getLastUpdateInfo: () => undefined,
    });
    const result = (await call('update_download_status', {}, bridge)) as {
      ok: boolean;
      state: string;
      pendingVersion: string | null;
      elapsedSeconds: number | null;
    };
    expect(result.ok).toBe(true);
    expect(result.state).toBe('idle');
    expect(result.pendingVersion).toBe(null);
    expect(result.elapsedSeconds).toBe(null);
  });

  it('returns downloading + elapsedSeconds when a download is in flight', async () => {
    seedStore();
    const started = Date.now() - 7500;
    const bridge = buildBridge({
      getUpdateDownloadState: () => ({
        state: 'downloading',
        pendingVersion: '0.1.64',
        downloadStartedAt: started,
        lastErrorMessage: undefined,
        lastErrorCategory: undefined,
      }),
    });
    const result = (await call('update_download_status', {}, bridge)) as {
      ok: boolean;
      state: string;
      pendingVersion: string | null;
      downloadStartedAt: number | null;
      elapsedSeconds: number | null;
    };
    expect(result.state).toBe('downloading');
    expect(result.pendingVersion).toBe('0.1.64');
    expect(result.downloadStartedAt).toBe(started);
    // elapsedSeconds should be ~7 (we kicked at -7500ms). Floor + small
    // wall-clock drift tolerance keeps the test stable on slow CI runners.
    expect(result.elapsedSeconds).toBeGreaterThanOrEqual(7);
    expect(result.elapsedSeconds).toBeLessThan(15);
  });

  it('returns ready-to-install when the bundle is staged', async () => {
    seedStore();
    const bridge = buildBridge({
      getUpdateDownloadState: () => ({
        state: 'ready-to-install',
        pendingVersion: '0.1.64',
        downloadStartedAt: undefined,
        lastErrorMessage: undefined,
        lastErrorCategory: undefined,
      }),
    });
    const result = (await call('update_download_status', {}, bridge)) as {
      state: string;
      pendingVersion: string;
    };
    expect(result.state).toBe('ready-to-install');
    expect(result.pendingVersion).toBe('0.1.64');
  });

  it('returns error + lastErrorMessage + category when the autoUpdater bailed', async () => {
    seedStore();
    const bridge = buildBridge({
      getUpdateDownloadState: () => ({
        state: 'error',
        pendingVersion: '0.1.64',
        downloadStartedAt: undefined,
        lastErrorMessage:
          'Code signature at URL file:///.../update.app/ did not pass validation',
        lastErrorCategory: 'signature-mismatch',
      }),
    });
    const result = (await call('update_download_status', {}, bridge)) as {
      state: string;
      lastErrorMessage: string;
      lastErrorCategory: string;
    };
    expect(result.state).toBe('error');
    expect(result.lastErrorMessage).toMatch(/code signature/i);
    expect(result.lastErrorCategory).toBe('signature-mismatch');
  });

  it('returns guiNotIntrospectable when no live bridge', async () => {
    seedStore();
    const result = (await call('update_download_status', {})) as { ok: boolean; guiNotIntrospectable?: boolean };
    expect(result.ok).toBe(false);
    expect(result.guiNotIntrospectable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// update_install_now
// ---------------------------------------------------------------------------

describe('mcp tools v0.1.64: update_install_now', () => {
  it('returns ok:true when the bridge accepts the install request', async () => {
    seedStore();
    const trigger = vi.fn(() => ({ ok: true as const }));
    const bridge = buildBridge({ triggerInstallNow: trigger });
    const result = (await call('update_install_now', {}, bridge)) as { ok: boolean };
    expect(result.ok).toBe(true);
    expect(trigger).toHaveBeenCalledOnce();
  });

  it('returns the refusal reason verbatim when nothing is staged', async () => {
    seedStore();
    const bridge = buildBridge({
      triggerInstallNow: () => ({ ok: false, reason: 'no-update-downloaded' }),
    });
    const result = (await call('update_install_now', {}, bridge)) as {
      ok: boolean;
      reason?: string;
    };
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no-update-downloaded');
  });

  it('returns guiNotIntrospectable when no live bridge', async () => {
    seedStore();
    const result = (await call('update_install_now', {})) as { ok: boolean; guiNotIntrospectable?: boolean };
    expect(result.ok).toBe(false);
    expect(result.guiNotIntrospectable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// update_logs_tail
// ---------------------------------------------------------------------------

describe('mcp tools v0.1.64: update_logs_tail', () => {
  it('filters main.log to updater-relevant lines', async () => {
    seedStore();
    // Mixed log file: only some lines should pass the filter.
    fs.writeFileSync(
      logFile,
      [
        '[2026-05-23 16:08:05] [info] [updater] kicking Squirrel checkForUpdates() from menu',
        '[2026-05-23 16:08:06] [info] update-available; downloading...',
        '[2026-05-23 16:08:10] [info] some unrelated stuff happening',
        '[2026-05-23 16:08:28] [info] [updater] update downloaded, ready to install',
        '[2026-05-23 16:09:00] [info] tts watchdog fired',
        '[2026-05-23 16:10:00] [warn] [updater-gh] check failed fetch failed',
      ].join('\n'),
    );
    const result = (await call('update_logs_tail', { lines: 200 })) as {
      ok: boolean;
      lineCount: number;
      lines: string;
      logPath: string;
    };
    expect(result.ok).toBe(true);
    expect(result.logPath).toBe(logFile);
    // 4 updater-relevant lines, 2 unrelated → 4 in the tail.
    expect(result.lineCount).toBe(4);
    expect(result.lines).toMatch(/update-available/);
    expect(result.lines).toMatch(/ready to install/);
    expect(result.lines).not.toMatch(/tts watchdog/);
  });

  it('respects the lines cap', async () => {
    seedStore();
    // 50 updater-relevant lines.
    const lines = Array.from({ length: 50 }, (_, i) => `[updater] tick #${i}`).join('\n');
    fs.writeFileSync(logFile, lines);
    const result = (await call('update_logs_tail', { lines: 5 })) as {
      lineCount: number;
      lines: string;
    };
    expect(result.lineCount).toBe(5);
    // Tail semantics: we get the LAST 5 ticks.
    expect(result.lines).toMatch(/#49$/);
    expect(result.lines).toMatch(/#45/);
    expect(result.lines).not.toMatch(/#44/);
  });

  it('returns ok:false + tried-paths when main.log is missing', async () => {
    seedStore();
    // No log written — the file should NOT exist.
    expect(fs.existsSync(logFile)).toBe(false);
    const result = (await call('update_logs_tail', {})) as {
      ok: boolean;
      triedPaths?: string[];
    };
    expect(result.ok).toBe(false);
    expect(result.triedPaths).toBeDefined();
    // At least one candidate should reference our HOME tree on macOS.
    expect(result.triedPaths?.some((p) => p.includes('Library/Logs'))).toBe(true);
  });
});
