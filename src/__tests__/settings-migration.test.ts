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
});
