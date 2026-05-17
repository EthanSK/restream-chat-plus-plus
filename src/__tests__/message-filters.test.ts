// v0.1.26 — regex-ignore filter helpers + the related Settings defaults
// + the regex-ignored badge label deriver in ChatFeed.
//
// These tests pin the user-observable contract of the feature:
//   - All messages are read aloud / notified by default (no self-skip,
//     no implicit filter).
//   - Regex-ignore prevents the side effect AND sets the persisted flag
//     on the ChatMessage so the badge renders.
//   - Both flags collapse to a combined badge label.
//   - Invalid regex entries are silently skipped (don't blow up the list).
//   - Empty list / blank lines = no filtering.
//   - DOM-free pure-function tests so they run under Node + the existing
//     vitest config (no jsdom dep).

import { describe, it, expect } from 'vitest';
import {
  applyMessageFilters,
  compileIgnorePatterns,
  matchesAnyIgnorePattern,
  regexIgnoredBadgeLabel,
  validateIgnoreList,
} from '../renderer/message-filters';
import { DEFAULT_SETTINGS } from '../shared/types';

describe('compileIgnorePatterns', () => {
  it('returns an empty array for an empty list', () => {
    expect(compileIgnorePatterns([])).toEqual([]);
  });

  it('skips empty / whitespace-only entries without throwing', () => {
    const out = compileIgnorePatterns(['', '   ', '\n', 'lurk']);
    expect(out).toHaveLength(1);
    expect(out[0].test('lurk')).toBe(true);
  });

  it('compiles valid patterns case-insensitively', () => {
    const out = compileIgnorePatterns(['^!\\w+', 'BOT$']);
    expect(out).toHaveLength(2);
    // 'i' flag → matches regardless of case.
    expect(out[0].test('!ping')).toBe(true);
    expect(out[1].test('totallyabot')).toBe(true);
    expect(out[1].test('TOTALLYABOT')).toBe(true);
  });

  it('silently drops syntactically-invalid patterns (no throw)', () => {
    // `[unclosed` is an invalid character class.
    expect(() =>
      compileIgnorePatterns(['[unclosed', 'good']),
    ).not.toThrow();
    const out = compileIgnorePatterns(['[unclosed', 'good']);
    expect(out).toHaveLength(1);
    expect(out[0].test('good')).toBe(true);
  });

  it('non-string entries are skipped (defensive)', () => {
    const out = compileIgnorePatterns([
      undefined as unknown as string,
      null as unknown as string,
      42 as unknown as string,
      'kept',
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].test('kept')).toBe(true);
  });
});

describe('matchesAnyIgnorePattern', () => {
  it('returns false for an empty pattern list', () => {
    expect(matchesAnyIgnorePattern('anything', [])).toBe(false);
  });

  it('returns true on first match', () => {
    const re = compileIgnorePatterns(['^foo', 'bar$']);
    expect(matchesAnyIgnorePattern('foo bar', re)).toBe(true);
    expect(matchesAnyIgnorePattern('hello bar', re)).toBe(true);
  });

  it('returns false when no pattern matches', () => {
    const re = compileIgnorePatterns(['^foo', 'bar$']);
    expect(matchesAnyIgnorePattern('hello world', re)).toBe(false);
  });

  it('is case-insensitive by default', () => {
    const re = compileIgnorePatterns(['LURK']);
    expect(matchesAnyIgnorePattern('I am lurking', re)).toBe(true);
    expect(matchesAnyIgnorePattern('Lurk mode', re)).toBe(true);
  });
});

describe('applyMessageFilters', () => {
  it('returns no flags when both lists are empty (the default state)', () => {
    expect(applyMessageFilters('hello', [], [])).toEqual({});
  });

  it('sets ignoredByTts when a TTS pattern matches', () => {
    const tts = compileIgnorePatterns(['^!']);
    const r = applyMessageFilters('!ping', tts, []);
    expect(r.ignoredByTts).toBe(true);
    expect(r.ignoredByNotifications).toBeUndefined();
  });

  it('sets ignoredByNotifications when a notif pattern matches', () => {
    const notif = compileIgnorePatterns(['spam']);
    const r = applyMessageFilters('this is spam', [], notif);
    expect(r.ignoredByNotifications).toBe(true);
    expect(r.ignoredByTts).toBeUndefined();
  });

  it('sets both flags when both lists match', () => {
    const tts = compileIgnorePatterns(['^!']);
    const notif = compileIgnorePatterns(['ping']);
    const r = applyMessageFilters('!ping', tts, notif);
    expect(r.ignoredByTts).toBe(true);
    expect(r.ignoredByNotifications).toBe(true);
  });

  it('lists are independent — a TTS-only match does not flag notif', () => {
    const tts = compileIgnorePatterns(['^!']);
    const notif = compileIgnorePatterns(['spam$']);
    const r = applyMessageFilters('!ping', tts, notif);
    expect(r.ignoredByTts).toBe(true);
    expect(r.ignoredByNotifications).toBeUndefined();
  });
});

describe('validateIgnoreList', () => {
  it('returns no errors for an empty list', () => {
    expect(validateIgnoreList([])).toEqual([]);
  });

  it('returns no errors when all patterns are valid', () => {
    expect(validateIgnoreList(['^!\\w+', 'bot$', '\\bspam\\b'])).toEqual([]);
  });

  it('reports the line + error message for each invalid pattern', () => {
    const errs = validateIgnoreList(['good', '[unclosed', 'also-good']);
    expect(errs).toHaveLength(1);
    expect(errs[0].line).toBe(2);
    expect(errs[0].pattern).toBe('[unclosed');
    expect(errs[0].error).toMatch(/./); // a non-empty error string
  });

  it('blank / whitespace-only lines are not reported as errors', () => {
    expect(validateIgnoreList(['', '  ', '\t', 'valid'])).toEqual([]);
  });
});

describe('regexIgnoredBadgeLabel', () => {
  it('returns null when neither flag is set', () => {
    expect(regexIgnoredBadgeLabel({})).toBeNull();
    expect(
      regexIgnoredBadgeLabel({
        ignoredByTts: false,
        ignoredByNotifications: false,
      }),
    ).toBeNull();
  });

  it('TTS-only → "🔇 regex-ignored (TTS)"', () => {
    expect(regexIgnoredBadgeLabel({ ignoredByTts: true })).toBe(
      '🔇 regex-ignored (TTS)',
    );
  });

  it('Notifs-only → "🔕 regex-ignored (notif)"', () => {
    expect(regexIgnoredBadgeLabel({ ignoredByNotifications: true })).toBe(
      '🔕 regex-ignored (notif)',
    );
  });

  it('both flags → combined "🔇🔕 regex-ignored"', () => {
    expect(
      regexIgnoredBadgeLabel({
        ignoredByTts: true,
        ignoredByNotifications: true,
      }),
    ).toBe('🔇🔕 regex-ignored');
  });
});

describe('DEFAULT_SETTINGS.filters (v0.1.26 product direction)', () => {
  it('ships with empty ignoreRegex lists — read EVERY message by default', () => {
    // The whole point of v0.1.26: the moment TTS is enabled, ALL incoming
    // messages get read aloud. A non-empty default would silently filter
    // some — which is exactly the behaviour Ethan asked us to remove.
    expect(DEFAULT_SETTINGS.filters.tts.ignoreRegex).toEqual([]);
    expect(DEFAULT_SETTINGS.filters.notifications.ignoreRegex).toEqual([]);
  });

  it('a fresh-defaults run of the filter pipeline produces no ignore flags', () => {
    const tts = compileIgnorePatterns(DEFAULT_SETTINGS.filters.tts.ignoreRegex);
    const notif = compileIgnorePatterns(
      DEFAULT_SETTINGS.filters.notifications.ignoreRegex,
    );
    expect(applyMessageFilters('any message at all', tts, notif)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// v0.1.26 — Settings migration adds `filters` section to loadSettings().
// The merge in src/main/main.ts is mirrored here so pre-v0.1.26 settings
// blobs (which lack the `filters` section entirely) still resolve to the
// empty-arrays default after migration.
// ---------------------------------------------------------------------------

function migrate(stored: Partial<typeof DEFAULT_SETTINGS> | undefined) {
  if (!stored) return DEFAULT_SETTINGS;
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    tts: { ...DEFAULT_SETTINGS.tts, ...(stored.tts ?? {}) },
    notifications: {
      ...DEFAULT_SETTINGS.notifications,
      ...(stored.notifications ?? {}),
    },
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

describe('Settings migration — v0.1.26 filters section', () => {
  it('defaults filters to empty lists when missing from a pre-v0.1.26 blob', () => {
    const legacy = {
      tts: {
        enabled: true,
        readSenderName: false,
        rate: 1,
        pitch: 1,
        volume: 1,
        maxPerMinute: 20,
      },
    } as Partial<typeof DEFAULT_SETTINGS>;
    const m = migrate(legacy);
    expect(m.filters.tts.ignoreRegex).toEqual([]);
    expect(m.filters.notifications.ignoreRegex).toEqual([]);
  });

  it('preserves user-set regex lists across migration', () => {
    const stored = {
      filters: {
        tts: { ignoreRegex: ['^!cmd', 'spam$'] },
        notifications: { ignoreRegex: ['bot'] },
      },
    } as Partial<typeof DEFAULT_SETTINGS>;
    const m = migrate(stored);
    expect(m.filters.tts.ignoreRegex).toEqual(['^!cmd', 'spam$']);
    expect(m.filters.notifications.ignoreRegex).toEqual(['bot']);
  });

  it('half-populated filters (only one sub-section) still gets the other default', () => {
    const stored = {
      filters: {
        tts: { ignoreRegex: ['only-tts'] },
      },
    } as unknown as Partial<typeof DEFAULT_SETTINGS>;
    const m = migrate(stored);
    expect(m.filters.tts.ignoreRegex).toEqual(['only-tts']);
    expect(m.filters.notifications.ignoreRegex).toEqual([]);
  });
});
