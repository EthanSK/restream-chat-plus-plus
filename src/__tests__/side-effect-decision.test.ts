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

  it('2. self wins over same-id-reprocess', () => {
    const m = makeMessage({ self: true, id: 'x' });
    const r = decideTtsAction(m, makeCtx({ lastProcessedId: 'x' }));
    expect(r.reason).toBe('self');
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
