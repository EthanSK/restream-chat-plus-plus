// v0.1.73 (Ethan voice 4364, 2026-05-28) — decision-gate evaluator tests.
//
// Pins the gate ladder used by App.tsx's side-effect useEffect. EVERY message
// MUST resolve to exactly one decision + reason; the order of gates is
// load-bearing because the FIRST matching gate wins (matches v0.1.72 App.tsx
// behaviour). A future refactor that re-orders gates without updating these
// tests will fail loudly.
//
// Each test case is a real-world scenario the user could trigger:
//   - Inbound viewer message → READ
//   - Streamer's own reply_created echo → SKIP 'self'
//   - Optimistic placeholder → SKIP 'pending-send'
//   - User adds 'viewer' regex → SKIP 'content-regex' with matched pattern
//   - User clicks Hide on @botaccount → SKIP 'hidden-user'
//   - Toggles TTS off → SKIP 'engine-disabled'
//   - Hides Twitch platform → SKIP 'platform-disabled'
//
// DOM-free pure-function tests — runs under the same vitest config as every
// other reducer test.

import { describe, expect, it } from 'vitest';
import {
  composeDecisionLogData,
  decideNotificationAction,
  decideTtsAction,
  shouldCancelNativeTtsOnSettingsChange,
  type SideEffectContext,
} from '../renderer/side-effect-decision';
import { DEFAULT_SETTINGS, type ChatMessage, type Settings } from '../shared/types';
import { compileHiddenUsersSet, compileIgnorePatterns } from '../renderer/message-filters';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'msg-1',
    platform: 'twitch',
    username: 'viewer42',
    text: 'hello streamer',
    ts: 1_700_000_000_000,
    ...overrides,
  };
}

/**
 * Build a default decision-context where everything's permissive — the
 * message will return READ unless overridden via `overrides`. Mirrors how
 * App.tsx wires up the context, just with sane defaults so test cases
 * read as "what's DIFFERENT for this case" rather than re-stating the
 * entire context every time.
 */
function makeCtx(overrides: Partial<SideEffectContext> = {}): SideEffectContext {
  // DEFAULT_SETTINGS ships with tts.enabled = false / notifications.enabled
  // = false (the user has to opt in). Tests of gate-ladder happy path
  // assume both engines are turned ON — flip them here so the "engine-
  // disabled" gate doesn't dominate every test.
  const settings = structuredClone(DEFAULT_SETTINGS) as Settings;
  settings.tts.enabled = true;
  settings.notifications.enabled = true;
  return {
    settings,
    hiddenUsersSet: new Set<string>(),
    ttsContentPatterns: [],
    ttsUsernamePatterns: [],
    notifContentPatterns: [],
    notifUsernamePatterns: [],
    lastProcessedId: undefined,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// decideTtsAction — gate-by-gate
// ---------------------------------------------------------------------------

describe('decideTtsAction — happy path', () => {
  it('returns read for an ordinary inbound viewer message', () => {
    const r = decideTtsAction(makeMessage(), makeCtx());
    expect(r.decision).toBe('read');
    expect(r.reason).toBe('read');
    expect(r.extra).toBeUndefined();
  });
});

describe('decideTtsAction — gate ordering', () => {
  it('1. pending-send wins over self (optimistic placeholder)', () => {
    // The user's optimistic placeholder is BOTH self=true AND pendingSend.
    // pending-send is checked first because that's how App.tsx gated it
    // before v0.1.72 too — preserving the gate order is the contract.
    const m = makeMessage({ self: true, pendingSend: 'sending' });
    const r = decideTtsAction(m, makeCtx());
    expect(r).toEqual({ decision: 'skip', reason: 'pending-send' });
  });

  it('2. self wins over same-id-reprocess (when speakSelf is OFF)', () => {
    // v0.1.79: the self-skip is now gated by settings.tts.speakSelf. With it
    // OFF, a self message still skips with reason 'self' and that gate still
    // sits ABOVE same-id-reprocess in the ladder — pin that ordering.
    const m = makeMessage({ self: true, id: 'x' });
    const ctx = makeCtx({ lastProcessedId: 'x' });
    ctx.settings.tts.speakSelf = false;
    const r = decideTtsAction(m, ctx);
    expect(r.reason).toBe('self');
  });

  it('2b. self message READS when speakSelf is ON (v0.1.79 default)', () => {
    // The whole point of the v0.1.79 toggle: with speakSelf=true (the default
    // shipped in DEFAULT_SETTINGS), the user's OWN messages are spoken — the
    // self gate does NOT fire and the message falls through to READ.
    const m = makeMessage({ self: true, id: 'self-1' });
    const ctx = makeCtx(); // speakSelf defaults to true via DEFAULT_SETTINGS
    expect(ctx.settings.tts.speakSelf).toBe(true);
    const r = decideTtsAction(m, ctx);
    expect(r.decision).toBe('read');
    expect(r.reason).toBe('read');
  });

  it('2c. self message still respects the TTS content regex skip-filter', () => {
    // Even with speakSelf ON, a self message whose body matches a TTS ignore
    // regex is skipped — this is exactly Ethan's "speak my own messages but
    // skip my !commands via regex" use case (gate 8 still applies to self).
    const m = makeMessage({ self: true, text: '!sr never gonna give you up' });
    const ctx = makeCtx({ ttsContentPatterns: compileIgnorePatterns(['^!']) });
    const r = decideTtsAction(m, ctx);
    expect(r.decision).toBe('skip');
    expect(r.reason).toBe('content-regex');
  });

  it('3. same-id wins over platform filter', () => {
    const m = makeMessage({ id: 'x', platform: 'twitch' });
    const ctx = makeCtx({ lastProcessedId: 'x' });
    ctx.settings.filter.platforms.twitch = false;
    const r = decideTtsAction(m, ctx);
    expect(r.reason).toBe('same-id-reprocess');
  });

  it('4. platform wins over hidden-user', () => {
    const ctx = makeCtx({
      hiddenUsersSet: compileHiddenUsersSet(['viewer42']),
    });
    ctx.settings.filter.platforms.twitch = false;
    const r = decideTtsAction(makeMessage(), ctx);
    expect(r.reason).toBe('platform-disabled');
  });

  it('5. hidden-user wins over engine-disabled', () => {
    const ctx = makeCtx({
      hiddenUsersSet: compileHiddenUsersSet(['viewer42']),
    });
    ctx.settings.tts.enabled = false;
    const r = decideTtsAction(makeMessage(), ctx);
    expect(r.reason).toBe('hidden-user');
  });

  it('6. engine-disabled wins over username-regex', () => {
    const ctx = makeCtx({
      ttsUsernamePatterns: compileIgnorePatterns(['viewer42']),
    });
    ctx.settings.tts.enabled = false;
    const r = decideTtsAction(makeMessage(), ctx);
    expect(r.reason).toBe('engine-disabled');
  });

  // v0.1.77 (Ethan voice 4438) — the one-click-mute gate sits between
  // engine-disabled (gate 6) and username-regex (gate 7). Pin its ordering so
  // a future edit can't accidentally move/drop it.
  it('6b. muted skips with reason "muted" (when enabled but muted)', () => {
    const ctx = makeCtx();
    ctx.settings.tts.enabled = true; // feature on...
    ctx.settings.tts.muted = true; // ...but user tapped the header 🔇 button
    const r = decideTtsAction(makeMessage(), ctx);
    expect(r.decision).toBe('skip');
    expect(r.reason).toBe('muted');
  });

  it('6b. engine-disabled wins over muted (disabled checked first)', () => {
    const ctx = makeCtx();
    ctx.settings.tts.enabled = false;
    ctx.settings.tts.muted = true;
    const r = decideTtsAction(makeMessage(), ctx);
    // Both gates would skip; engine-disabled is the earlier gate so it wins.
    expect(r.reason).toBe('engine-disabled');
  });

  it('6b. muted wins over username-regex (mute checked before regex axes)', () => {
    const ctx = makeCtx({ ttsUsernamePatterns: compileIgnorePatterns(['viewer42']) });
    ctx.settings.tts.muted = true;
    const r = decideTtsAction(makeMessage(), ctx);
    expect(r.reason).toBe('muted');
  });

  it('6b. NOT muted (default) passes the mute gate and reaches READ', () => {
    const ctx = makeCtx(); // muted defaults to false
    const r = decideTtsAction(makeMessage(), ctx);
    expect(r.decision).toBe('read');
    expect(r.reason).toBe('read');
  });

  it('7. username-regex wins over content-regex', () => {
    const ctx = makeCtx({
      ttsUsernamePatterns: compileIgnorePatterns(['viewer42']),
      ttsContentPatterns: compileIgnorePatterns(['hello']),
    });
    const r = decideTtsAction(makeMessage(), ctx);
    expect(r.reason).toBe('username-regex');
    expect(r.extra).toEqual({ matched: 'viewer42' });
  });

  it('8. content-regex surfaces the matched pattern in extra', () => {
    const ctx = makeCtx({
      ttsContentPatterns: compileIgnorePatterns(['streamboo', 'Viewe']),
    });
    // Real-world: Ethan's actual log had a bunnysabbat message with
    // Unicode-obfuscated "Ai Viewers streamboo.com". The 'Viewe' regex
    // (case-insensitive) catches it.
    const r = decideTtsAction(
      makeMessage({ text: 'Ai Viewe𝗿𝘀 𝗌𝗍re𝖺𝗆𝖻𝗈𝗈 . ᴄᴏᴍ' }),
      ctx,
    );
    expect(r.reason).toBe('content-regex');
    expect(r.extra).toEqual({ matched: 'Viewe' });
  });
});

describe('decideTtsAction — defensive', () => {
  it('does NOT throw on non-string text', () => {
    const m = { ...makeMessage(), text: undefined as unknown as string };
    expect(() => decideTtsAction(m, makeCtx())).not.toThrow();
  });

  it('does NOT throw on non-string username', () => {
    const m = { ...makeMessage(), username: undefined as unknown as string };
    expect(() => decideTtsAction(m, makeCtx())).not.toThrow();
  });

  it('treats self:false identically to self:undefined (=== check, not truthy)', () => {
    const m = makeMessage({ self: false });
    const r = decideTtsAction(m, makeCtx());
    expect(r.decision).toBe('read');
  });

  it('empty hiddenUsersSet does not match any username', () => {
    const r = decideTtsAction(
      makeMessage(),
      makeCtx({ hiddenUsersSet: new Set() }),
    );
    expect(r.decision).toBe('read');
  });

  it('hiddenUsersSet match is case-insensitive', () => {
    const r = decideTtsAction(
      makeMessage({ username: 'ViEwEr42' }),
      makeCtx({ hiddenUsersSet: compileHiddenUsersSet(['VIEWER42']) }),
    );
    expect(r.reason).toBe('hidden-user');
  });
});

// ---------------------------------------------------------------------------
// decideNotificationAction — symmetric path
// ---------------------------------------------------------------------------

describe('decideNotificationAction', () => {
  it('returns notify for the happy path', () => {
    const r = decideNotificationAction(makeMessage(), makeCtx());
    expect(r.decision).toBe('notify');
    expect(r.reason).toBe('notify');
  });

  it('skips on self', () => {
    const r = decideNotificationAction(makeMessage({ self: true }), makeCtx());
    expect(r.reason).toBe('self');
  });

  it('engine-disabled when notifications.enabled === false', () => {
    const ctx = makeCtx();
    ctx.settings.notifications.enabled = false;
    const r = decideNotificationAction(makeMessage(), ctx);
    expect(r.reason).toBe('engine-disabled');
  });

  it('v0.1.77 — tts.muted does NOT block notifications (mute is speech-only)', () => {
    const ctx = makeCtx();
    ctx.settings.tts.muted = true; // header mute is on...
    const r = decideNotificationAction(makeMessage(), ctx);
    // ...but the notification still fires — mute only silences spoken TTS.
    expect(r.decision).toBe('notify');
  });

  it('uses the notif-axis regex lists, not the tts-axis ones', () => {
    // A regex that's in the TTS list but NOT the notification list
    // must NOT block the notification.
    const ctx = makeCtx({
      ttsContentPatterns: compileIgnorePatterns(['hello']),
      notifContentPatterns: [],
    });
    const r = decideNotificationAction(makeMessage(), ctx);
    expect(r.decision).toBe('notify');
  });

  it('username-regex on notif axis catches a bot account', () => {
    const ctx = makeCtx({
      notifUsernamePatterns: compileIgnorePatterns(['streamelements']),
    });
    const r = decideNotificationAction(
      makeMessage({ username: 'StreamElements' }),
      ctx,
    );
    expect(r.reason).toBe('username-regex');
    expect(r.extra).toEqual({ matched: 'streamelements' });
  });
});

// ---------------------------------------------------------------------------
// composeDecisionLogData — JSONL row shape
// ---------------------------------------------------------------------------

describe('composeDecisionLogData', () => {
  it('produces a stable structurally-uniform row for TTS skip', () => {
    const m = makeMessage({ id: 'abc', username: 'spam', platform: 'kick' });
    const row = composeDecisionLogData(m, {
      decision: 'skip',
      reason: 'content-regex',
      extra: { matched: 'viewer' },
    });
    expect(row).toEqual({
      messageId: 'abc',
      username: 'spam',
      platform: 'kick',
      decision: 'skip',
      reason: 'content-regex',
      extra: { matched: 'viewer' },
    });
  });

  it('omits extra when not provided', () => {
    const m = makeMessage();
    const row = composeDecisionLogData(m, { decision: 'read', reason: 'read' });
    expect(row).toEqual({
      messageId: 'msg-1',
      username: 'viewer42',
      platform: 'twitch',
      decision: 'read',
      reason: 'read',
    });
    expect('extra' in row).toBe(false);
  });

  it('TTS and notification rows are structurally identical', () => {
    // Same shape for both paths → grep `decision`, `reason`, `messageId`
    // works across both row types.
    const m = makeMessage();
    const ttsRow = composeDecisionLogData(m, {
      decision: 'read',
      reason: 'read',
    });
    const notifRow = composeDecisionLogData(m, {
      decision: 'notify',
      reason: 'notify',
    });
    expect(Object.keys(ttsRow).sort()).toEqual(Object.keys(notifRow).sort());
  });
});

// ---------------------------------------------------------------------------
// Real-world replay — Ethan's 2026-05-29 log incident.
// ---------------------------------------------------------------------------

describe('replay — Ethan voice 4364 (2026-05-28) cases', () => {
  it('wildswanxx "yo wsg reeethan" with default settings → read (matches actual log)', () => {
    // The kick wildswanxx message at 17:05 DID get spoken in the real
    // log. With no regex matching and a viewer (not self), the gate
    // ladder should agree.
    const m = makeMessage({
      id: 'beef578f-7dc0-4479-98f6-6673058c82c1',
      username: 'wildswanxx',
      platform: 'kick',
      text: 'yo wsg reeethan',
    });
    const r = decideTtsAction(m, makeCtx());
    expect(r.decision).toBe('read');
  });

  it('bunnysabbat unicode-spam message → content-regex skip (matches user settings)', () => {
    // The user actually has 'streamboo' + 'Viewe' in their TTS regex
    // list. The Ai Viewers streamboo.com Unicode-obfuscated text in the
    // 13:34 raw frame would have been caught by 'Viewe' (case-i, partial
    // match against the obfuscated 'Viewe𝗿𝘀'). NOT a bug — user's regex
    // working as intended.
    const ctx = makeCtx({
      ttsContentPatterns: compileIgnorePatterns([
        'viewer',
        'streamboo',
        'Viewe',
      ]),
    });
    const m = makeMessage({
      username: 'bunnysabbat',
      text: 'Ai Viewe𝗿𝘀 𝗌𝗍re𝖺𝗆𝖻𝗈𝗈 . ᴄᴏᴍ',
    });
    const r = decideTtsAction(m, ctx);
    expect(r.decision).toBe('skip');
    expect(r.reason).toBe('content-regex');
  });
});

// ---------------------------------------------------------------------------
// v0.1.82 — shouldCancelNativeTtsOnSettingsChange
//
// Governs the EXTRA "stop speech NOW" action App.tsx takes when the user
// toggles into silence: muting (false→true) or disabling TTS (enabled
// true→false) must cancel the in-flight utterance + flush the queue. The
// reverse transitions (un-mute / re-enable) and unrelated edits must NOT —
// turning sound back on never replays the muted backlog.
// ---------------------------------------------------------------------------
describe('shouldCancelNativeTtsOnSettingsChange (mute/disable kills in-flight)', () => {
  const tts = (m: boolean, e: boolean) => ({ muted: m, enabled: e });

  it('returns true on mute-ON transition (false → true)', () => {
    expect(shouldCancelNativeTtsOnSettingsChange(tts(false, true), tts(true, true))).toBe(true);
  });

  it('returns true on disable transition (enabled true → false)', () => {
    expect(shouldCancelNativeTtsOnSettingsChange(tts(false, true), tts(false, false))).toBe(true);
  });

  it('returns FALSE on un-mute (true → false) — must not replay backlog', () => {
    expect(shouldCancelNativeTtsOnSettingsChange(tts(true, true), tts(false, true))).toBe(false);
  });

  it('returns FALSE on re-enable (enabled false → true) — must not replay backlog', () => {
    expect(shouldCancelNativeTtsOnSettingsChange(tts(false, false), tts(false, true))).toBe(false);
  });

  it('returns FALSE when neither muted nor enabled changed (e.g. voice/rate edit)', () => {
    expect(shouldCancelNativeTtsOnSettingsChange(tts(false, true), tts(false, true))).toBe(false);
    expect(shouldCancelNativeTtsOnSettingsChange(tts(true, true), tts(true, true))).toBe(false);
  });

  it('treats missing/undefined `muted` as "not muted" (older persisted config)', () => {
    // A pre-v0.1.77 saved blob has no `muted` field. Going undefined → true is
    // still a mute-ON transition; undefined → undefined is not.
    expect(
      shouldCancelNativeTtsOnSettingsChange(
        { muted: undefined as unknown as boolean, enabled: true },
        { muted: true, enabled: true },
      ),
    ).toBe(true);
    expect(
      shouldCancelNativeTtsOnSettingsChange(
        { muted: undefined as unknown as boolean, enabled: true },
        { muted: undefined as unknown as boolean, enabled: true },
      ),
    ).toBe(false);
  });

  it('mute-ON while ALSO disabling in the same change still cancels (either trigger)', () => {
    // Defensive: a single settings patch that flips both still returns true.
    expect(shouldCancelNativeTtsOnSettingsChange(tts(false, true), tts(true, false))).toBe(true);
  });

  it('uses real DEFAULT_SETTINGS.tts shape as the "before" baseline', () => {
    // Sanity: muting from the shipped default (enabled may be false, muted
    // false) is a no-op for the mute trigger UNLESS muted actually flips on.
    const base = DEFAULT_SETTINGS.tts;
    expect(
      shouldCancelNativeTtsOnSettingsChange(base, { ...base, muted: true }),
    ).toBe(base.muted !== true); // true iff default isn't already muted
  });
});
