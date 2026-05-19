import { describe, it, expect } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '../shared/types';

/**
 * The main process merges persisted Settings over DEFAULT_SETTINGS so that
 * fields added in newer versions (e.g. `tts.volume`, `tts.readSenderName`)
 * don't come back as `undefined` for users upgrading from an older build.
 *
 * This test mirrors `loadSettings()` in src/main/main.ts so we have a
 * DOM-free regression check that an older settings blob — one that predates
 * the volume field landing as a user-facing slider in v0.1.11 — still
 * resolves to volume=1.0 after migration.
 */
function migrate(stored: Partial<Settings> | undefined): Settings {
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
    update: { ...DEFAULT_SETTINGS.update, ...(stored.update ?? {}) },
  };
}

describe('Settings migration', () => {
  it('defaults tts.volume to 1.0 when absent in persisted blob', () => {
    // Pre-v0.1.11 blob: no `volume` field on tts.
    const legacy = {
      tts: {
        enabled: true,
        readSenderName: false,
        rate: 1.0,
        pitch: 1.0,
        maxPerMinute: 20,
      },
    } as unknown as Partial<Settings>;

    const merged = migrate(legacy);
    expect(merged.tts.volume).toBe(1.0);
  });

  it('preserves a user-set tts.volume across migration', () => {
    const stored: Partial<Settings> = {
      tts: {
        ...DEFAULT_SETTINGS.tts,
        volume: 0.42,
      },
    };
    const merged = migrate(stored);
    expect(merged.tts.volume).toBe(0.42);
  });

  it('DEFAULT_SETTINGS.tts.volume is 1.0', () => {
    expect(DEFAULT_SETTINGS.tts.volume).toBe(1.0);
  });

  it('returns full defaults when nothing is persisted', () => {
    expect(migrate(undefined)).toEqual(DEFAULT_SETTINGS);
  });

  // -------------------------------------------------------------------------
  // v0.1.24 — `update.autoCheck` toggle for the GH-Releases poller.
  //
  // The GH-API-backed update checker (`src/main/github-update-check.ts`) is
  // the primary "is there a new version?" signal for unsigned macOS builds,
  // because Squirrel.Mac silently rejects unsigned auto-updates and leaves
  // users stranded on whatever version they first installed. The setting is
  // opt-out: defaulting to ON means a fresh install with no persisted
  // settings starts polling immediately. Defaulting to OFF would re-create
  // the "I never know there's an update" problem we're trying to fix.
  //
  // These tests pin that contract so a future refactor can't silently flip
  // the default to false without us noticing.
  // -------------------------------------------------------------------------
  it('DEFAULT_SETTINGS.update.autoCheck is true (opt-out, not opt-in)', () => {
    expect(DEFAULT_SETTINGS.update.autoCheck).toBe(true);
  });

  it('defaults update.autoCheck to true when absent in persisted blob (pre-v0.1.24 user upgrade)', () => {
    // Simulate a pre-v0.1.24 settings blob: no `update` section at all.
    const legacy = {
      tts: {
        enabled: true,
        readSenderName: false,
        rate: 1.0,
        pitch: 1.0,
        volume: 1.0,
        maxPerMinute: 20,
      },
    } as unknown as Partial<Settings>;

    const merged = migrate(legacy);
    expect(merged.update.autoCheck).toBe(true);
  });

  it('preserves a user-set update.autoCheck=false across migration', () => {
    const stored: Partial<Settings> = {
      update: { autoCheck: false },
    };
    const merged = migrate(stored);
    expect(merged.update.autoCheck).toBe(false);
  });

  it('returns autoCheck=true when nothing is persisted (clean install)', () => {
    expect(migrate(undefined).update.autoCheck).toBe(true);
  });

  // -------------------------------------------------------------------------
  // v0.1.42 → v0.1.44 — `tts.engine` toggle (native | browser).
  //
  // History:
  //   v0.1.42 introduced the native `say` engine and flipped the default
  //   to `'native'` because the Web Speech path had recurring "TTS just
  //   stopped working" bugs.
  //   v0.1.44 flipped the default BACK to `'browser'` after the
  //   v0.1.40 strong-ref + v0.1.41 cancel-before-speak + 8s keep-alive +
  //   500ms onstart watchdog + onerror retry layers made the browser
  //   engine reliable. The deciding factor: the volume slider doesn't
  //   apply to `say` (no `--volume` flag), and Ethan wants slider control.
  //
  // Pre-v0.1.42 settings blobs have no `engine` field. The migration must
  // back-fill from `DEFAULT_SETTINGS.tts.engine` so the user lands on the
  // current default. Users who explicitly chose `'native'` on v0.1.42 /
  // v0.1.43 must keep their choice — the default flip in v0.1.44 only
  // applies to users who never explicitly picked.
  // -------------------------------------------------------------------------
  it("DEFAULT_SETTINGS.tts.engine is 'browser' (v0.1.44 default)", () => {
    expect(DEFAULT_SETTINGS.tts.engine).toBe('browser');
  });

  it('defaults tts.engine to browser when absent in persisted blob', () => {
    const legacy = {
      tts: {
        enabled: true,
        readSenderName: false,
        rate: 1.0,
        pitch: 1.0,
        volume: 1.0,
        maxPerMinute: 20,
      },
    } as unknown as Partial<Settings>;

    const merged = migrate(legacy);
    expect(merged.tts.engine).toBe('browser');
  });

  it("preserves a user-set tts.engine='browser' across migration", () => {
    const stored: Partial<Settings> = {
      tts: {
        ...DEFAULT_SETTINGS.tts,
        engine: 'browser',
      },
    };
    const merged = migrate(stored);
    expect(merged.tts.engine).toBe('browser');
  });

  // v0.1.44 default-flip regression pin: a user who explicitly chose
  // 'native' on v0.1.42 or v0.1.43 must NOT be force-flipped back to
  // 'browser' just because we changed DEFAULT_SETTINGS. Object-spread
  // semantics already give us this (stored.tts.engine overrides the
  // default), but we pin it explicitly so a future refactor that swaps
  // the merge order (e.g. defaults-win) breaks loudly.
  it("preserves a user-set tts.engine='native' across the v0.1.44 default flip", () => {
    const stored: Partial<Settings> = {
      tts: {
        ...DEFAULT_SETTINGS.tts,
        engine: 'native',
      },
    };
    const merged = migrate(stored);
    expect(merged.tts.engine).toBe('native');
  });
});
