// v0.1.73 (Ethan voice 4364, 2026-05-28) — explicit decision logging for the
// TTS + native-notification side-effect paths.
//
// Pre-v0.1.73 the renderer's side-effect useEffect (in App.tsx) silently
// short-circuited at multiple gates (pendingSend, self-ignore, platform
// filter, hidden user, engine disabled, content regex, username regex) and
// the ONLY log row was the engine-level `speak_called` AFTER all the
// upstream filtering had already run. Result: a user reporting "this
// message didn't get read aloud" couldn't be answered from the log because
// the log was blind to every skip reason.
//
// This module is the single source of truth for which path a message takes.
// Both `decideTtsAction` and `decideNotificationAction` are pure — they
// take a message + a context bag (settings flags, refs, etc.) and return
// `{ decision: 'read' | 'skip', reason: TtsDecisionReason, extra? }`.
// App.tsx calls them, fires a `tts_decision` / `notification_decision`
// JSONL row with the result, AND uses the decision to drive the actual
// side-effect engine call. One source of truth, two consumers — log + act.
//
// IMPORTANT contract: the order of gates here MUST match App.tsx's actual
// behaviour. Tests pin the order (see src/__tests__/side-effect-decision.test.ts)
// so a future App.tsx edit can't accidentally re-order gates without
// updating the decision module too.

import type {
  ChatMessage,
  NotificationDecisionReason,
  Settings,
  TtsDecisionReason,
} from './types';
import { matchesAnyIgnorePattern } from './message-filters';

/**
 * Result of a single decision-gate evaluation. `decision: 'read'` /
 * `'notify'` means the side effect fires; `'skip'` means it does NOT.
 *
 * The `reason` is the FIRST gate that resolved the decision — `decideTtsAction`
 * walks gates in priority order and returns as soon as one matches. The
 * `extra` field is path-specific (e.g. the matched-regex source pattern
 * for content-regex / username-regex hits — kept verbatim because users
 * routinely tweak the regex list and want to know WHICH entry caught the
 * message).
 *
 * v0.1.73 invariant: `decision: 'read'` only ever pairs with `reason: 'read'`
 * (TTS side) or `reason: 'notify'` (notifications side). `decision: 'skip'`
 * pairs with EVERY OTHER reason in the corresponding reason union. The two
 * never overlap.
 */
export interface SideEffectDecision<R extends string> {
  /** True iff the side effect should fire. */
  decision: 'read' | 'notify' | 'skip';
  /** First gate that resolved the decision. See TtsDecisionReason / NotificationDecisionReason. */
  reason: R;
  /**
   * Optional path-specific extras (e.g. matched regex pattern source).
   * Kept in a generic record so we can extend without breaking the
   * type union. JSONL row writers spread this into `data.extra`.
   */
  extra?: Record<string, unknown>;
}

/**
 * Shared context fed to BOTH decision functions. Lives in a single object
 * rather than positional args so future gates can add fields without
 * touching every call site.
 *
 * Refs (regex patterns + hidden users) are passed as the snapshot value at
 * decision time — the caller (App.tsx) dereferences `.current` once per
 * message and hands the snapshot in. This keeps the decision function
 * dead-simple to test (just pass arrays) and avoids the caller having to
 * fake `useRef` shapes.
 */
export interface SideEffectContext {
  /** Settings snapshot at decision time. */
  settings: Settings;
  /**
   * Lowercase Set of hidden-username strings. Built via
   * `compileHiddenUsersSet(settings.hiddenUsers)` and cached in a ref by
   * App.tsx. Empty Set = no hidden users.
   */
  hiddenUsersSet: ReadonlySet<string>;
  /**
   * Compiled TTS content-regex list. Matches against `message.text`. The
   * SOURCE of each pattern (the raw user-authored line in
   * `settings.filters.tts.ignoreRegex`) is reachable via `.source` on
   * each RegExp; decision rows quote the first match's `.source` so the
   * forensic log says WHICH regex caught the message.
   */
  ttsContentPatterns: readonly RegExp[];
  /** Same idea as ttsContentPatterns but for the username axis. */
  ttsUsernamePatterns: readonly RegExp[];
  /** Same idea as ttsContentPatterns but for the notification path. */
  notifContentPatterns: readonly RegExp[];
  /** Same idea as ttsUsernamePatterns but for the notification path. */
  notifUsernamePatterns: readonly RegExp[];
  /**
   * Id of the message most-recently acted on (any path). The same-id
   * reprocess guard (see `shouldTriggerSideEffects`) returns SKIP if the
   * latest array element shares this id — guards against useEffect
   * re-fires when the array reference changes but the latest element
   * didn't.
   */
  lastProcessedId: string | undefined;
}

/**
 * Find the FIRST regex in `patterns` that matches `text`. Returns the
 * RegExp itself so the caller can pull `.source` for the log row. Returns
 * `undefined` if nothing matches. Wraps each `.test()` in try/catch
 * defensively — a thrown match never blocks the message (mirrors
 * `matchesAnyIgnorePattern`'s contract).
 *
 * Why we don't reuse `matchesAnyIgnorePattern` directly: that returns a
 * bool, losing the matched-pattern handle we need for forensic logging.
 */
function findFirstMatch(
  text: string,
  patterns: readonly RegExp[],
): RegExp | undefined {
  if (patterns.length === 0) return undefined;
  for (const re of patterns) {
    try {
      if (re.test(text)) return re;
    } catch {
      // Defensive — non-global regex .test() shouldn't throw, but if it
      // does we don't want logging to crash the dispatcher path.
    }
  }
  return undefined;
}

/**
 * Decide whether to speak `message` via TTS. Walks the gate ladder in the
 * same order App.tsx historically did. Returns the FIRST gate that
 * resolved the outcome — caller logs the decision + reason.
 *
 * Gate order:
 *   1. pendingSend !== undefined → SKIP 'pending-send'
 *   2. self === true AND settings.tts.speakSelf === false → SKIP 'self'
 *      (v0.1.79 — was an unconditional hard skip in v0.1.72; now gated by
 *       the "Speak my own messages" toggle, default ON)
 *   3. id === lastProcessedId    → SKIP 'same-id-reprocess'
 *   4. !settings.filter.platforms[platform] → SKIP 'platform-disabled'
 *   5. hiddenUsersSet.has(username.toLowerCase()) → SKIP 'hidden-user'
 *   6. !settings.tts.enabled     → SKIP 'engine-disabled'
 *   6b. settings.tts.muted       → SKIP 'muted'  (v0.1.77 one-click header mute)
 *   7. matches ttsUsernamePatterns → SKIP 'username-regex' (extra.matched: pattern source)
 *   8. matches ttsContentPatterns  → SKIP 'content-regex'  (extra.matched: pattern source)
 *   9. → READ 'read'
 *
 * Pure: no IPC, no side effects. The CALLER fires the JSONL row and the
 * engine `enqueue` based on the returned decision.
 */
export function decideTtsAction(
  message: ChatMessage,
  ctx: SideEffectContext,
): SideEffectDecision<TtsDecisionReason> {
  // Gate 1: optimistic placeholder. Pre-v0.1.60 these double-spoke
  // because the dedupe-replace fired the useEffect twice.
  if (message.pendingSend !== undefined) {
    return { decision: 'skip', reason: 'pending-send' };
  }
  // Gate 2: self-ignore.
  //
  // The user's own outgoing reply is Restream's `reply_created` echo,
  // normalised with `self: true` in src/main/normalize.ts.
  //
  // v0.1.72 (voice 4352) HARD-skipped these — own messages never spoke,
  // with no way to turn it back on. v0.1.79 (Ethan 2026-05-31: "did u remove
  // it from speaking out my own messages? that should be an option") makes
  // it user-configurable via `settings.tts.speakSelf` (defaults to true):
  //   - speakSelf === false → SKIP here (the v0.1.72 behaviour, opt-in now).
  //   - speakSelf === true  → fall through; the self message is treated like
  //     any other message and continues down the gate ladder (platform
  //     filter, hidden-user, engine-disabled, mute, regex skip-filters).
  //
  // So a user who wants their own messages spoken EXCEPT for certain ones
  // (e.g. their own "!commands" or bot triggers) just leaves speakSelf on and
  // adds a regex to the TTS content/username ignore list (gates 7/8 below) —
  // exactly what Ethan suggested ("maybe with regex you supported for that").
  //
  // NOTE: the NOTIFICATION decider (decideNotificationAction) deliberately
  // keeps an UNCONDITIONAL self-skip — this toggle is about the app SPEAKING
  // your own messages, not about firing OS notifications for them.
  if (message.self === true && ctx.settings.tts.speakSelf === false) {
    return { decision: 'skip', reason: 'self' };
  }
  // Gate 3: same-id reprocess. useEffect re-fires on array-identity
  // changes; if the LAST element is still the same logical message we
  // already acted on, this is a re-fire and should no-op.
  if (message.id === ctx.lastProcessedId) {
    return { decision: 'skip', reason: 'same-id-reprocess' };
  }
  // Gate 4: platform filter. The user can hide individual platforms
  // (Twitch / YouTube / Kick / etc) entirely — also suppresses side
  // effects, not just the row in the feed.
  if (!ctx.settings.filter.platforms[message.platform]) {
    return { decision: 'skip', reason: 'platform-disabled' };
  }
  // Gate 5: hidden user. v0.1.72 hidden means hidden — no row, no TTS,
  // no notification.
  if (
    ctx.hiddenUsersSet.size > 0 &&
    typeof message.username === 'string' &&
    ctx.hiddenUsersSet.has(message.username.toLowerCase())
  ) {
    return { decision: 'skip', reason: 'hidden-user' };
  }
  // Gate 6: engine disabled. The user can toggle TTS off in Settings;
  // that's a top-level kill switch, not a per-message filter.
  if (!ctx.settings.tts.enabled) {
    return { decision: 'skip', reason: 'engine-disabled' };
  }
  // Gate 6b (v0.1.77, Ethan voice 4438): ONE-CLICK MUTE.
  //
  // The header 🔊/🔇 button flips `settings.tts.muted`. This gate is the
  // SINGLE source of truth that genuinely silences ALL spoken chat — because
  // it sits in the shared decider that the MAIN-process TtsDispatcher runs
  // BEFORE it ever picks a backend, a `muted` skip suppresses BOTH the browser
  // Web-Speech path AND the native `say` path. So muting works regardless of
  // whether the window is visible or hidden.
  //
  // It is deliberately SEPARATE from gate 6 (`engine-disabled`): mute is a
  // temporary "shut up now" switch that leaves the user's whole TTS config
  // (enabled flag, voice, rate, volume, filters) untouched, so un-muting
  // restores everything exactly. The notification path does NOT have this
  // gate — mute is about the app SPEAKING, not OS notification sounds (those
  // keep their own `notifications.soundEnabled` setting).
  //
  // NOTE: this only suppresses the SPEECH. The message still renders in the
  // chat feed normally — the renderer's onChatMessage handler pushes every
  // message into the feed independently of this decision; mute never drops a
  // row from the UI.
  if (ctx.settings.tts.muted) {
    return { decision: 'skip', reason: 'muted' };
  }
  // Gate 7: username regex (v0.1.72). Checked BEFORE content regex
  // because a username match is cheaper to debug ("oh, I added that
  // bot's username to the ignore list") than tracking down which
  // content regex caught the line.
  const usernameHit = findFirstMatch(
    typeof message.username === 'string' ? message.username : '',
    ctx.ttsUsernamePatterns,
  );
  if (usernameHit) {
    return {
      decision: 'skip',
      reason: 'username-regex',
      extra: { matched: usernameHit.source },
    };
  }
  // Gate 8: content regex (v0.1.26 + ongoing).
  const contentHit = findFirstMatch(
    typeof message.text === 'string' ? message.text : '',
    ctx.ttsContentPatterns,
  );
  if (contentHit) {
    return {
      decision: 'skip',
      reason: 'content-regex',
      extra: { matched: contentHit.source },
    };
  }
  // Every gate passed → read aloud.
  return { decision: 'read', reason: 'read' };
}

/**
 * Sister-function to `decideTtsAction` for the native-notification path.
 *
 * Gate order MATCHES decideTtsAction up to gate 6 (those are the
 * cross-cutting filters — they suppress BOTH paths uniformly), then
 * diverges into the notification-specific regex axes + rate-limit check.
 * The `rate-limited` gate is evaluated by the CALLER (App.tsx holds the
 * RateLimiter ref) and patched in after this function returns 'notify' —
 * see the App.tsx useEffect for the wire-up. This keeps the pure-function
 * surface deterministic + DOM-free.
 *
 * Gate order:
 *   1. pendingSend !== undefined → SKIP 'pending-send'
 *   2. self === true             → SKIP 'self'
 *   3. id === lastProcessedId    → SKIP 'same-id-reprocess'
 *   4. !settings.filter.platforms[platform] → SKIP 'platform-disabled'
 *   5. hiddenUsersSet.has(username.toLowerCase()) → SKIP 'hidden-user'
 *   6. !settings.notifications.enabled → SKIP 'engine-disabled'
 *   7. matches notifUsernamePatterns → SKIP 'username-regex'
 *   8. matches notifContentPatterns  → SKIP 'content-regex'
 *   9. → 'notify' 'notify'   (rate-limit decision happens in caller)
 */
export function decideNotificationAction(
  message: ChatMessage,
  ctx: SideEffectContext,
): SideEffectDecision<NotificationDecisionReason> {
  if (message.pendingSend !== undefined) {
    return { decision: 'skip', reason: 'pending-send' };
  }
  if (message.self === true) {
    return { decision: 'skip', reason: 'self' };
  }
  if (message.id === ctx.lastProcessedId) {
    return { decision: 'skip', reason: 'same-id-reprocess' };
  }
  if (!ctx.settings.filter.platforms[message.platform]) {
    return { decision: 'skip', reason: 'platform-disabled' };
  }
  if (
    ctx.hiddenUsersSet.size > 0 &&
    typeof message.username === 'string' &&
    ctx.hiddenUsersSet.has(message.username.toLowerCase())
  ) {
    return { decision: 'skip', reason: 'hidden-user' };
  }
  if (!ctx.settings.notifications.enabled) {
    return { decision: 'skip', reason: 'engine-disabled' };
  }
  const usernameHit = findFirstMatch(
    typeof message.username === 'string' ? message.username : '',
    ctx.notifUsernamePatterns,
  );
  if (usernameHit) {
    return {
      decision: 'skip',
      reason: 'username-regex',
      extra: { matched: usernameHit.source },
    };
  }
  const contentHit = findFirstMatch(
    typeof message.text === 'string' ? message.text : '',
    ctx.notifContentPatterns,
  );
  if (contentHit) {
    return {
      decision: 'skip',
      reason: 'content-regex',
      extra: { matched: contentHit.source },
    };
  }
  return { decision: 'notify', reason: 'notify' };
}

/**
 * Compose the JSONL `data` payload for a `tts_decision` /
 * `notification_decision` row. Centralised here so both side-effect paths
 * (TTS + notifications) produce structurally-identical rows, and so
 * adding a new field is a one-line change.
 *
 * Fields:
 *   - messageId: ChatMessage.id (matches `speak_called` rows for join)
 *   - username:  ChatMessage.username (the SOURCE of attribution)
 *   - platform:  twitch / youtube / kick / discord / etc.
 *   - decision:  'read' | 'notify' | 'skip'
 *   - reason:    TtsDecisionReason | NotificationDecisionReason
 *   - extra:     optional {matched:'<regex source>'} for regex gates
 */
export function composeDecisionLogData<R extends string>(
  message: ChatMessage,
  result: SideEffectDecision<R>,
): Record<string, unknown> {
  const data: Record<string, unknown> = {
    messageId: message.id,
    username: message.username,
    platform: message.platform,
    decision: result.decision,
    reason: result.reason,
  };
  if (result.extra) data.extra = result.extra;
  return data;
}

// Defensively reference the matchesAnyIgnorePattern import so a future
// "unused export" cleanup of message-filters.ts doesn't break us — we
// don't currently call it (findFirstMatch supersedes it), but importing
// keeps tree-shake-aware tools from accidentally tagging it dead.
void matchesAnyIgnorePattern;
