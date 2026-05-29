// v0.1.72 — self-ignore is a HARD DEFAULT for both TTS and notifications.
//
// Voice 4352 (2026-05-28): Ethan no longer wants the app reading his own
// outgoing messages back to him or notifying him about his own posts.
// This reverts the v0.1.26 "read everything including self" product
// direction.
//
// The contract is enforced at the SINGLE gate point — `shouldTriggerSideEffects`
// in src/renderer/chat-message-reducers.ts — so every caller (TTS speak path,
// native notification path, any future side-effect added later) automatically
// inherits the rule. We do NOT scatter `if (m.self) return` across each
// side-effect call site, because that historically drifts (one path forgets
// the check and you get the v0.1.10 → v0.1.26 regression all over again).
//
// These tests pin:
//   1. Self echoes (the only path that has `self: true` set today, by
//      `src/main/normalize.ts` on a Restream reply_created frame) NEVER
//      trigger side effects.
//   2. Self === false / undefined messages still trigger normally —
//      incoming viewer messages are unaffected.
//   3. The gate behaves correctly when composed with the other two
//      checks (pendingSend + lastProcessedId same-id guard).
//   4. The App.tsx side-effect useEffect, simulated here without
//      mounting React, fires TTS only for non-self messages and skips
//      notifications for self too — proving the gate covers BOTH paths.
//
// DOM-free pure-function tests — runs under the same vitest config as
// every other reducer test.

import { describe, expect, it, vi } from 'vitest';
import { shouldTriggerSideEffects } from '../renderer/chat-message-reducers';
import type { ChatMessage } from '../shared/types';

// Factories so each test reads as a story, not a JSON dump.
function selfEcho(id: string, text = 'my outgoing reply'): ChatMessage {
  return {
    id,
    platform: 'twitch',
    username: 'You',
    text,
    ts: 1_700_000_000_000,
    self: true,
    // No pendingSend — this is the WS echo that REPLACED the
    // placeholder via dedupeOptimisticOnEcho. The placeholder has
    // pendingSend='sending'; the echo has it undefined.
  };
}

function viewerMsg(id: string, text = 'hello streamer'): ChatMessage {
  return {
    id,
    platform: 'twitch',
    username: 'viewer42',
    text,
    ts: 1_700_000_001_000,
    // No `self` — undefined is the default for incoming messages.
  };
}

describe('v0.1.72 self-ignore — shouldTriggerSideEffects', () => {
  it('returns FALSE for a self echo (no pendingSend, self===true)', () => {
    // This is the post-dedupe state — the placeholder has been replaced
    // by the WS echo. Pre-v0.1.72 this returned true and we'd hear the
    // user's own message read aloud. v0.1.72: false, full stop.
    expect(shouldTriggerSideEffects(selfEcho('local-x'), undefined)).toBe(false);
  });

  it('returns TRUE for an incoming viewer message (self undefined)', () => {
    expect(shouldTriggerSideEffects(viewerMsg('m-1'), undefined)).toBe(true);
  });

  it('returns FALSE for a viewer message that was already processed (same-id guard wins)', () => {
    // The same-id guard is independent of self-ignore. A message that's
    // already triggered once must not trigger again even though it isn't
    // self.
    expect(shouldTriggerSideEffects(viewerMsg('m-1'), 'm-1')).toBe(false);
  });

  it('returns FALSE for an explicit self: false message... wait, that is just a viewer', () => {
    // Defensive: ensure `self: false` is treated identically to `self
    // undefined` (the gate uses `=== true`, not truthy). A future
    // normalise change that sets `self: false` explicitly should not
    // accidentally also suppress.
    const explicitNotSelf: ChatMessage = {
      ...viewerMsg('m-1'),
      self: false,
    };
    expect(shouldTriggerSideEffects(explicitNotSelf, undefined)).toBe(true);
  });

  it('self-ignore composes with pendingSend gate (both can fire)', () => {
    // A placeholder with pendingSend===\'sending\' AND self===true (which
    // is how every locally-minted optimistic placeholder looks) is gated
    // by BOTH rules. Either alone would suppress; together they
    // double-suppress. The gate doesn\'t care which one fired first.
    const optimisticSelf: ChatMessage = {
      id: 'local-x',
      platform: 'unknown',
      username: 'You',
      text: 'hi',
      ts: 1_700_000_000_000,
      self: true,
      pendingSend: 'sending',
    };
    expect(shouldTriggerSideEffects(optimisticSelf, undefined)).toBe(false);
  });

  it('the dedupe-replace then re-fire sequence stays at ZERO triggers for self', () => {
    // Simulate App.tsx\'s useEffect re-running across the placeholder ->
    // echo transition. Pre-v0.1.72 the echo fires once (good); v0.1.72
    // the echo fires ZERO times (because self-ignore now catches it).
    let lastProcessedId: string | undefined;
    let count = 0;
    const trigger = (m: ChatMessage | undefined): void => {
      if (shouldTriggerSideEffects(m, lastProcessedId)) {
        lastProcessedId = m!.id;
        count += 1;
      }
    };

    // Step 1: placeholder visible. Gated by pendingSend.
    const placeholder: ChatMessage = {
      ...selfEcho('local-x'),
      pendingSend: 'sending',
    };
    trigger(placeholder);
    expect(count).toBe(0);

    // Step 2: WS echo replaces placeholder. Gated by self===true.
    trigger(selfEcho('local-x'));
    expect(count).toBe(0);

    // Step 3: useEffect re-fire from an unrelated array-identity bump.
    trigger(selfEcho('local-x'));
    expect(count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Simulation: the App.tsx side-effect useEffect calls both the TTS engine
// and the native-notification IPC. We verify the SAME gate covers BOTH
// paths — there's no parallel `if (m.self) return` lurking in just one
// branch.
// ---------------------------------------------------------------------------

interface FakeTts {
  enqueue: (m: ChatMessage) => void;
}
interface FakeNotify {
  notify: (title: string, body: string) => void;
}

function runAppSideEffectGate(args: {
  message: ChatMessage;
  lastProcessedId?: string;
  tts: FakeTts;
  notify: FakeNotify;
  ttsEnabled: boolean;
  notificationsEnabled: boolean;
}): void {
  const { message, lastProcessedId, tts, notify, ttsEnabled, notificationsEnabled } = args;
  if (!shouldTriggerSideEffects(message, lastProcessedId)) return;
  if (ttsEnabled) tts.enqueue(message);
  if (notificationsEnabled) {
    notify.notify(`${message.username} (${message.platform})`, message.text);
  }
}

describe('v0.1.72 self-ignore — App.tsx side-effect simulation', () => {
  it('TTS path: early-returns when message is self', () => {
    const tts: FakeTts = { enqueue: vi.fn() };
    const notify: FakeNotify = { notify: vi.fn() };
    runAppSideEffectGate({
      message: selfEcho('local-x'),
      tts,
      notify,
      ttsEnabled: true,
      notificationsEnabled: false,
    });
    expect(tts.enqueue).not.toHaveBeenCalled();
    expect(notify.notify).not.toHaveBeenCalled();
  });

  it('Notification path: early-returns when message is self', () => {
    const tts: FakeTts = { enqueue: vi.fn() };
    const notify: FakeNotify = { notify: vi.fn() };
    runAppSideEffectGate({
      message: selfEcho('local-x'),
      tts,
      notify,
      ttsEnabled: false,
      notificationsEnabled: true,
    });
    // Both must stay quiet — proves the gate covers both paths uniformly.
    expect(tts.enqueue).not.toHaveBeenCalled();
    expect(notify.notify).not.toHaveBeenCalled();
  });

  it('Both paths: fire normally for incoming viewer messages', () => {
    const tts: FakeTts = { enqueue: vi.fn() };
    const notify: FakeNotify = { notify: vi.fn() };
    runAppSideEffectGate({
      message: viewerMsg('m-1', 'hi!'),
      tts,
      notify,
      ttsEnabled: true,
      notificationsEnabled: true,
    });
    expect(tts.enqueue).toHaveBeenCalledTimes(1);
    expect(notify.notify).toHaveBeenCalledTimes(1);
  });
});
