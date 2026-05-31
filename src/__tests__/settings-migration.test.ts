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
  // v0.1.81 — `tts.engine` REMOVED. The browser/native engine toggle is gone;
  // speech is always the native OS voice now, so DEFAULT_SETTINGS has no
  // `engine` field. A legacy persisted blob may STILL carry `engine:
  // 'browser'|'native'`. The shallow per-section merge
  // (`{ ...DEFAULT_SETTINGS.tts, ...stored.tts }`) carries that stale key
  // through onto the merged object, which is HARMLESS — nothing reads `engine`
  // anymore (the dispatcher always uses the native engine). What matters is
  // that migration doesn't error and the user's REAL settings survive intact.
  // -------------------------------------------------------------------------
  it("DEFAULT_SETTINGS.tts no longer defines an 'engine' field (v0.1.81 removal)", () => {
    expect('engine' in DEFAULT_SETTINGS.tts).toBe(false);
  });

  it('migrating a legacy blob that still carries tts.engine is harmless (real settings survive)', () => {
    const legacy = {
      tts: {
        enabled: true,
        engine: 'native', // legacy key no longer in the type — must not break migration
        readSenderName: true,
        rate: 1.25,
        pitch: 1.0,
        volume: 0.7,
        maxPerMinute: 20,
      },
    } as unknown as Partial<Settings>;

    // Must not throw, and the user's real TTS settings come through unchanged.
    const merged = migrate(legacy);
    expect(merged.tts.enabled).toBe(true);
    expect(merged.tts.readSenderName).toBe(true);
    expect(merged.tts.rate).toBe(1.25);
    expect(merged.tts.volume).toBe(0.7);
    // Defaults for fields the legacy blob lacked are still back-filled.
    expect(merged.tts.muted).toBe(false);
    expect(merged.tts.speakSelf).toBe(true);
  });
});
