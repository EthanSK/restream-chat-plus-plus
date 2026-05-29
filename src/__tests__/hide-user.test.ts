// v0.1.72 — Hide User affordance.
//
// Voice 4352 (2026-05-28): Ethan wants a one-click "Hide user" button on
// each chat row so messages from a specific viewer disappear from the
// feed AND stop triggering TTS / notifications. Persistent across
// settings reload. Unhide available via the Hidden Users section in the
// Settings drawer.
//
// These tests pin:
//   1. compileHiddenUsersSet builds a lowercase Set defensively.
//   2. isHiddenUser is case-insensitive exact-match.
//   3. addHiddenUser is idempotent (case-insensitive de-dup).
//   4. removeHiddenUser cleans the list (case-insensitive).
//   5. Settings migration: a pre-v0.1.72 blob (no hiddenUsers field)
//      resolves to [] after load — no crash, no undefined.
//   6. End-to-end simulation: hide → message filtered out; unhide →
//      message reappears; persistence round-trip (serialize +
//      deserialize) retains the list.
//
// DOM-free pure-function tests.

import { describe, expect, it } from 'vitest';
import {
  addHiddenUser,
  compileHiddenUsersSet,
  isHiddenUser,
  removeHiddenUser,
} from '../renderer/message-filters';
import { DEFAULT_SETTINGS, type ChatMessage, type Settings } from '../shared/types';

describe('compileHiddenUsersSet', () => {
  it('returns an empty set for an empty input', () => {
    const s = compileHiddenUsersSet([]);
    expect(s.size).toBe(0);
  });

  it('lowercases everything so lookups are case-insensitive', () => {
    const s = compileHiddenUsersSet(['Viewer42', 'BOT_kappa', 'Alice']);
    expect(s.has('viewer42')).toBe(true);
    expect(s.has('bot_kappa')).toBe(true);
    expect(s.has('alice')).toBe(true);
    // Original case is NOT preserved in the set (the persisted list keeps
    // it; the compile step exists only to make lookups O(1)+CI).
    expect(s.has('Viewer42')).toBe(false);
  });

  it('skips empty / whitespace-only / non-string entries (defensive)', () => {
    const s = compileHiddenUsersSet([
      'real',
      '',
      '   ',
      '\n',
      undefined as unknown as string,
      null as unknown as string,
      42 as unknown as string,
    ]);
    expect(s.size).toBe(1);
    expect(s.has('real')).toBe(true);
  });

  it('trims surrounding whitespace before lowercasing', () => {
    const s = compileHiddenUsersSet(['  Alice  ']);
    expect(s.has('alice')).toBe(true);
  });
});

describe('isHiddenUser', () => {
  it('returns false when the set is empty (the default state)', () => {
    expect(isHiddenUser('anyone', new Set())).toBe(false);
  });

  it('is case-insensitive exact-match', () => {
    const s = compileHiddenUsersSet(['Viewer42']);
    expect(isHiddenUser('viewer42', s)).toBe(true);
    expect(isHiddenUser('VIEWER42', s)).toBe(true);
    expect(isHiddenUser('Viewer42', s)).toBe(true);
  });

  it('does NOT substring-match — exact identity only', () => {
    const s = compileHiddenUsersSet(['bot']);
    expect(isHiddenUser('botanist', s)).toBe(false);
    expect(isHiddenUser('robot_kappa', s)).toBe(false);
    expect(isHiddenUser('bot', s)).toBe(true);
  });

  it('returns false defensively for empty / non-string usernames', () => {
    const s = compileHiddenUsersSet(['anyone']);
    expect(isHiddenUser('', s)).toBe(false);
    expect(isHiddenUser(undefined as unknown as string, s)).toBe(false);
  });
});

describe('addHiddenUser', () => {
  it('appends a new username to an empty list', () => {
    const out = addHiddenUser([], 'Alice');
    expect(out).toEqual(['Alice']);
  });

  it('preserves the original case the user clicked Hide on', () => {
    // The display name in the chat row is the source of truth — we
    // don't normalise on the way in because the user might want to
    // visually scan the list and recognise "BobTheStreamer" instead of
    // "bobthestreamer".
    const out = addHiddenUser(['alice'], 'BobTheStreamer');
    expect(out).toEqual(['alice', 'BobTheStreamer']);
  });

  it('is idempotent — adding the same user twice is a no-op (case-insensitive)', () => {
    const prev = ['alice'];
    const out = addHiddenUser(prev, 'ALICE');
    // Length unchanged, contents unchanged.
    expect(out.length).toBe(1);
    expect(out[0]).toBe('alice');
  });

  it('always returns a fresh array (never the same reference)', () => {
    const prev = ['alice'];
    const out = addHiddenUser(prev, 'alice');
    // De-dup path also returns a clone so the caller's reference-equality
    // check still detects "no change needed" via length / value compare.
    expect(out).not.toBe(prev);
    expect(out).toEqual(prev);
  });

  it('skips empty / whitespace-only usernames', () => {
    expect(addHiddenUser([], '')).toEqual([]);
    expect(addHiddenUser([], '   ')).toEqual([]);
    expect(addHiddenUser([], '\n\t')).toEqual([]);
  });

  it('trims the input before appending', () => {
    // A username with leading/trailing whitespace would never match the
    // compiled lowercase Set\'s key (which trim+lower), so we strip on
    // the way in to keep the list itself clean too.
    const out = addHiddenUser([], '  alice  ');
    expect(out).toEqual(['alice']);
  });
});

describe('removeHiddenUser', () => {
  it('removes the matching entry (case-insensitive)', () => {
    expect(removeHiddenUser(['alice', 'bob'], 'ALICE')).toEqual(['bob']);
    expect(removeHiddenUser(['Alice', 'Bob'], 'alice')).toEqual(['Bob']);
  });

  it('is a no-op when the username is not in the list', () => {
    expect(removeHiddenUser(['alice'], 'bob')).toEqual(['alice']);
  });

  it('returns a clone when no removal happens', () => {
    const prev = ['alice'];
    const out = removeHiddenUser(prev, 'bob');
    expect(out).not.toBe(prev);
    expect(out).toEqual(prev);
  });

  it('skips empty / whitespace-only usernames', () => {
    expect(removeHiddenUser(['alice'], '')).toEqual(['alice']);
    expect(removeHiddenUser(['alice'], '   ')).toEqual(['alice']);
  });
});

// ---------------------------------------------------------------------------
// Settings migration: a pre-v0.1.72 blob has no `hiddenUsers` field.
// loadSettings() in src/main/main.ts does a shallow merge over
// DEFAULT_SETTINGS, so the missing field resolves to the default []. We
// mirror that shape here.
// ---------------------------------------------------------------------------

function migrate(stored: Partial<Settings> | undefined): Settings {
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

describe('Settings migration — v0.1.72 hiddenUsers + ignoreUsernameRegex', () => {
  it('a pre-v0.1.72 blob (no hiddenUsers) resolves to [] after load', () => {
    const legacy = {
      tts: { ...DEFAULT_SETTINGS.tts, volume: 0.8 },
      filters: {
        tts: { ignoreRegex: ['^!cmd'] },
        notifications: { ignoreRegex: ['bot'] },
      },
    } as unknown as Partial<Settings>;
    const m = migrate(legacy);
    expect(m.hiddenUsers).toEqual([]);
  });

  it('preserves a user-set hiddenUsers list across migration', () => {
    const stored = {
      hiddenUsers: ['Alice', 'BobTheStreamer'],
    } as Partial<Settings>;
    const m = migrate(stored);
    expect(m.hiddenUsers).toEqual(['Alice', 'BobTheStreamer']);
  });

  it('a pre-v0.1.72 filters blob (no ignoreUsernameRegex) resolves to [] for both lists', () => {
    const legacy = {
      filters: {
        tts: { ignoreRegex: ['^!cmd'] },
        notifications: { ignoreRegex: ['bot'] },
      },
    } as unknown as Partial<Settings>;
    const m = migrate(legacy);
    expect(m.filters.tts.ignoreUsernameRegex).toEqual([]);
    expect(m.filters.notifications.ignoreUsernameRegex).toEqual([]);
  });

  it('round-trip via JSON serialize/deserialize preserves hiddenUsers', () => {
    // electron-store persists Settings as JSON on disk. Simulate the
    // round-trip to be sure no special types (Set, Map) sneak into
    // hiddenUsers that wouldn\'t survive JSON.
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      hiddenUsers: ['Alice', 'BobTheStreamer'],
    };
    const reloaded = JSON.parse(JSON.stringify(settings)) as Settings;
    expect(reloaded.hiddenUsers).toEqual(['Alice', 'BobTheStreamer']);
    // And the compiled lookup set still resolves matches case-insensitively
    // after the round-trip.
    const s = compileHiddenUsersSet(reloaded.hiddenUsers);
    expect(isHiddenUser('alice', s)).toBe(true);
    expect(isHiddenUser('BOBTHESTREAMER', s)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// End-to-end-ish: hide → filtered out; unhide → reappears.
// The renderer\'s `visibleMessages` filter is reproduced here so we don\'t
// need to mount React.
// ---------------------------------------------------------------------------

function visible(messages: ChatMessage[], hiddenSet: Set<string>): ChatMessage[] {
  return messages.filter((m) => !isHiddenUser(m.username, hiddenSet));
}

function mkMsg(username: string, text: string, id = `m-${username}-${text}`): ChatMessage {
  return {
    id,
    platform: 'twitch',
    username,
    text,
    ts: 1_700_000_000_000,
  };
}

describe('v0.1.72 hide-user — end-to-end filter behaviour', () => {
  it('hide → message disappears from the visible feed (past AND future)', () => {
    const messages = [
      mkMsg('Alice', 'first'),
      mkMsg('BobTheStreamer', 'second'),
      mkMsg('Alice', 'third'),
    ];
    // No hides yet — everything visible.
    expect(visible(messages, compileHiddenUsersSet([]))).toHaveLength(3);
    // Hide Alice — both past Alice messages disappear immediately.
    // The renderer recompiles the set in a useMemo over settings.hiddenUsers,
    // so this is the user-observable contract after one click.
    const hidden = compileHiddenUsersSet(['Alice']);
    const v = visible(messages, hidden);
    expect(v).toHaveLength(1);
    expect(v[0].username).toBe('BobTheStreamer');
  });

  it('unhide → message reappears in the visible feed', () => {
    const messages = [mkMsg('Alice', 'hello')];
    const hidden = compileHiddenUsersSet(['Alice']);
    expect(visible(messages, hidden)).toHaveLength(0);

    // Unhide simulated by removing from the list + recompiling the set.
    const next = removeHiddenUser(['Alice'], 'Alice');
    const reHidden = compileHiddenUsersSet(next);
    expect(visible(messages, reHidden)).toHaveLength(1);
  });

  it('persistence reload retains the hidden list (JSON round-trip)', () => {
    // Click Hide on Alice + Bob.
    let hiddenUsers = addHiddenUser([], 'Alice');
    hiddenUsers = addHiddenUser(hiddenUsers, 'BobTheStreamer');
    // Persist + reload.
    const persisted = JSON.parse(JSON.stringify({ hiddenUsers })) as {
      hiddenUsers: string[];
    };
    const reloadedSet = compileHiddenUsersSet(persisted.hiddenUsers);
    const messages = [
      mkMsg('Alice', 'a1'),
      mkMsg('BobTheStreamer', 'b1'),
      mkMsg('Charlie', 'c1'),
    ];
    const v = visible(messages, reloadedSet);
    expect(v).toHaveLength(1);
    expect(v[0].username).toBe('Charlie');
  });

  it('hide does not affect side-effect compose with v0.1.26 regex flags', () => {
    // Sanity: a message can be both hidden AND regex-flagged. The
    // visible-feed filter doesn\'t look at the flags — it only filters
    // by platform + hiddenUsers. The regex-ignored badge logic lives in
    // a separate render path that\'s not exercised here (the hidden row
    // never reaches that render path because it was filtered out
    // upstream). We just verify nothing in the flag handling pollutes
    // the hide gate.
    const m: ChatMessage = {
      ...mkMsg('Alice', 'spam'),
      ignoredByTts: true,
      ignoredByNotifications: true,
    };
    const hidden = compileHiddenUsersSet(['Alice']);
    expect(visible([m], hidden)).toHaveLength(0);
  });
});
