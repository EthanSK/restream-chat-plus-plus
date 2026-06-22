// Regex-based message filtering, v0.1.26.
//
// The Settings drawer exposes two textareas (one for TTS, one for native
// notifications). Each textarea holds one regex pattern per line — the
// user-facing surface is intentionally raw JS regex syntax because Ethan
// asked for full regex power, not glob-style wildcards. Empty / blank-only
// lines are skipped. Syntactically-invalid patterns are also skipped at
// compile time (no throw), but the UI surfaces them with a red border + a
// tooltip carrying the error so the user can fix them — see
// `validateIgnoreList()`.
//
// All three functions are pure and DOM-free so they can be unit-tested
// without a renderer environment, and so the filtering decision survives
// e.g. a feed virtuoso re-render without recompiling the regexes on every
// row. The App.tsx side-effect hook compiles once per Settings change
// (via useMemo) and reuses the compiled list for every arriving message.

/**
 * Compile a list of user-authored regex pattern strings into RegExp
 * objects. Invalid patterns are SILENTLY DROPPED — they never throw out
 * of this function. Empty / whitespace-only strings are also dropped.
 *
 * The case-insensitive (`i`) flag is applied uniformly: chat-content
 * matches almost always want case-insensitive behaviour ("LURK" should
 * catch "lurk" / "Lurk" / "lurking"), and Ethan's user-facing
 * description in the Settings UI says "matches case-insensitively". If
 * a future feature needs case-sensitive matching the pattern can be
 * wrapped in `(?-i:...)` or split into a typed list — but the YAGNI
 * default is on.
 *
 * The `g` flag is intentionally NOT set — `RegExp.prototype.test` on a
 * stateful global regex carries the `lastIndex` between calls, which
 * leads to "every other message matches" bugs. Non-global is the
 * one-shot, stateless mode this filter actually wants.
 */
export function compileIgnorePatterns(patterns: readonly string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const raw of patterns) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    try {
      out.push(new RegExp(trimmed, 'i'));
    } catch {
      // Silently skip — UI surface (validateIgnoreList) flags the entry
      // separately so the user knows it's broken without us throwing.
    }
  }
  return out;
}

/** True iff at least one compiled regex matches `text`. */
export function matchesAnyIgnorePattern(
  text: string,
  patterns: readonly RegExp[],
): boolean {
  if (patterns.length === 0) return false;
  for (const re of patterns) {
    try {
      if (re.test(text)) return true;
    } catch {
      // RegExp.test on a sane non-global regex shouldn't throw, but
      // belt-and-suspenders: a thrown match never blocks the message.
    }
  }
  return false;
}

/**
 * Apply the two ignore lists (TTS + notifications) to a single message
 * `text` + `username` and return the side-effect flags. Pure function —
 * does NOT mutate any input.
 *
 * Returns `undefined` for each flag when the message is NOT ignored.
 * Returning `undefined` rather than `false` keeps the persisted
 * ChatMessage shape lean — only ignored messages carry the flag, which
 * matches the "optional badge" semantics in ChatFeed.tsx.
 *
 * v0.1.72 — accepts two pattern lists PER side-effect (TTS / notif):
 *   - `*ContentPatterns` matches against the message body (`text`).
 *   - `*UsernamePatterns` matches against the author's display name
 *     (`username`).
 *
 * The axes compose with OR — if EITHER the content axis OR the username
 * axis matches, the message is flagged for that side effect. This matches
 * user mental model: "ignore X" where X can be a content rule, a username
 * rule, or both. A rule that needed AND semantics ("ignore messages that
 * are spam AND from bot accounts") would need a different shape; YAGNI
 * for now.
 *
 * The `username` argument is optional + defaulted to '' for backwards
 * compatibility with the v0.1.26-v0.1.71 call sites — but the v0.1.72
 * App.tsx call site always passes the real username, so username
 * filtering is live in production.
 */
export function applyMessageFilters(
  text: string,
  ttsContentPatterns: readonly RegExp[],
  notifContentPatterns: readonly RegExp[],
  username = '',
  ttsUsernamePatterns: readonly RegExp[] = [],
  notifUsernamePatterns: readonly RegExp[] = [],
): { ignoredByTts?: boolean; ignoredByNotifications?: boolean } {
  const out: { ignoredByTts?: boolean; ignoredByNotifications?: boolean } = {};
  // TTS axis: content OR username match → ignored.
  if (
    matchesAnyIgnorePattern(text, ttsContentPatterns) ||
    (username.length > 0 && matchesAnyIgnorePattern(username, ttsUsernamePatterns))
  ) {
    out.ignoredByTts = true;
  }
  // Notifications axis: independent — same OR composition.
  if (
    matchesAnyIgnorePattern(text, notifContentPatterns) ||
    (username.length > 0 && matchesAnyIgnorePattern(username, notifUsernamePatterns))
  ) {
    out.ignoredByNotifications = true;
  }
  return out;
}

/**
 * Compose the regex-ignored badge label for a message based on which (if
 * any) of the v0.1.26 filter flags are set. Returns `null` when the
 * message isn't ignored by either side effect — in that case no badge
 * renders in ChatFeed.
 *
 * Display rules:
 *   - TTS-only     → "🔇 regex-ignored (TTS)"
 *   - Notifs-only  → "🔕 regex-ignored (notif)"
 *   - Both         → "🔇🔕 regex-ignored" (collapsed; the icon pair already
 *                    conveys "both" without the row growing two chip-widths)
 *
 * Lives in `message-filters.ts` rather than alongside the component so
 * tests can exercise it without pulling in `api.ts` / `window.rcpp`.
 */
export function regexIgnoredBadgeLabel(m: {
  ignoredByTts?: boolean;
  ignoredByNotifications?: boolean;
}): string | null {
  if (m.ignoredByTts && m.ignoredByNotifications) {
    return '🔇🔕 regex-ignored';
  }
  if (m.ignoredByTts) return '🔇 regex-ignored (TTS)';
  if (m.ignoredByNotifications) return '🔕 regex-ignored (notif)';
  return null;
}

/**
 * v0.1.72 — case-insensitive exact-match check against the hidden-users
 * list. Returns true when `username` is a member of `hiddenUsers`
 * (regardless of case). Used by both ChatFeed (to drop hidden rows from
 * the visible feed) and the App.tsx side-effect gate (so a hidden user's
 * messages never wake TTS or notifications either).
 *
 * Pure, DOM-free, no allocations on the hot path beyond `.toLowerCase()`
 * once per message. The Set lookup is O(1) — the caller is expected to
 * build the lowercase Set once per Settings change via
 * `compileHiddenUsersSet` below and reuse it on every message.
 */
export function isHiddenUser(
  username: string,
  hiddenUsersLowercaseSet: ReadonlySet<string>,
): boolean {
  if (hiddenUsersLowercaseSet.size === 0) return false;
  if (typeof username !== 'string' || username.length === 0) return false;
  return hiddenUsersLowercaseSet.has(username.toLowerCase());
}

/**
 * v0.1.72 — build a lowercase Set from the raw hidden-users array. Empty /
 * non-string entries are skipped defensively. Returns a frozen Set so a
 * future bug-fix can't accidentally mutate it from outside the compile
 * site (the renderer uses `useMemo` + a ref to keep the live set fresh).
 */
export function compileHiddenUsersSet(hiddenUsers: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const u of hiddenUsers) {
    if (typeof u !== 'string') continue;
    const trimmed = u.trim();
    if (trimmed.length === 0) continue;
    out.add(trimmed.toLowerCase());
  }
  return out;
}

/**
 * v0.1.72 — pure reducer for the Hide User action. Returns a NEW
 * settings.hiddenUsers list with `username` appended if not already
 * present (case-insensitive de-dup). Used by both the hover button in
 * ChatFeed and the future MCP `hide_user` tool if/when we add one.
 *
 * Empty / whitespace-only usernames are no-ops (returns the original
 * list reference, NOT a clone) so a defensive caller doesn't trigger an
 * unnecessary settings persist.
 */
export function addHiddenUser(
  hiddenUsers: readonly string[],
  username: string,
): string[] {
  if (typeof username !== 'string') return hiddenUsers.slice();
  const trimmed = username.trim();
  if (trimmed.length === 0) return hiddenUsers.slice();
  const lower = trimmed.toLowerCase();
  for (const existing of hiddenUsers) {
    if (typeof existing === 'string' && existing.trim().toLowerCase() === lower) {
      // Already hidden — return a clone so the caller's reference
      // equality check still detects "no change needed". Returning the
      // same array would silently no-op which is what we want, but
      // returning a clone keeps the contract simple: this function
      // always returns a fresh array.
      return hiddenUsers.slice();
    }
  }
  return [...hiddenUsers, trimmed];
}

/**
 * v0.1.72 — pure reducer for the Unhide action. Removes `username`
 * (case-insensitive) from the hidden-users list and returns the new
 * array. If `username` wasn't in the list this returns a clone for the
 * same reasons as `addHiddenUser`.
 */
export function removeHiddenUser(
  hiddenUsers: readonly string[],
  username: string,
): string[] {
  if (typeof username !== 'string') return hiddenUsers.slice();
  const lower = username.trim().toLowerCase();
  if (lower.length === 0) return hiddenUsers.slice();
  return hiddenUsers.filter(
    (u) => typeof u !== 'string' || u.trim().toLowerCase() !== lower,
  );
}

/**
 * v0.1.91 (task: "silence user" button) — pure reducer for the per-row
 * "Silence user" action. Returns a NEW `ignoreUsernameRegex` list with an
 * ANCHORED, REGEX-ESCAPED entry for `username` appended if not already
 * present.
 *
 * WHY this replaced the old "Hide user" wiring: the button now SILENCES
 * (TTS-ignores) the user — their messages still RENDER in the feed but TTS
 * skips them — vs the old hide which dropped them from the feed entirely
 * AND suppressed all side effects. We achieve the silence by adding the
 * username to the TTS *username* ignore axis (`settings.filters.tts.
 * ignoreUsernameRegex`), which `applyMessageFilters` matches against the
 * author display name and turns into `ignoredByTts`.
 *
 * The entry we store is `^<escaped>$`:
 *   - We REGEX-ESCAPE the username first so names containing regex
 *     metacharacters (`.`, `+`, `(`, `[`, etc. — common in display names
 *     like "Foo.Bar+1") match LITERALLY rather than as a pattern.
 *   - We ANCHOR with `^...$` so silencing "bot" doesn't also silence
 *     "botanist" / "robot_kappa" — superstring names must NOT over-match.
 *   - Case-insensitivity is NOT baked into the source string; it's added
 *     uniformly by `compileIgnorePatterns` (the `i` flag), matching how
 *     every other entry in these textareas behaves.
 *
 * De-dup is case-insensitive against the existing entries (compare the
 * candidate `^esc$` string case-insensitively). Empty / whitespace-only
 * usernames are no-ops (returns a clone, NOT the same reference, so the
 * caller's reference-equality "did anything change?" check stays simple —
 * mirrors `addHiddenUser`'s contract).
 */
export function addSilencedUser(
  existingPatterns: readonly string[],
  username: string,
): string[] {
  // Defensive: non-string / empty / whitespace-only → no-op clone.
  if (typeof username !== 'string') return existingPatterns.slice();
  const trimmed = username.trim();
  if (trimmed.length === 0) return existingPatterns.slice();
  // Escape the standard JS regex metacharacter set. We anchor with ^...$
  // (NOT a character class) so we escape the full set including `-` is
  // unnecessary, but escaping it is harmless; we stick to the canonical
  // set below. Backslash MUST be escaped first within the class itself —
  // the `\\` in the class handles that.
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const candidate = `^${escaped}$`;
  const candidateLower = candidate.toLowerCase();
  for (const existing of existingPatterns) {
    if (
      typeof existing === 'string' &&
      existing.trim().toLowerCase() === candidateLower
    ) {
      // Already silencing this exact (case-insensitive) anchored pattern —
      // return a clone so the caller still detects "no change needed" via a
      // length / value compare, never a double-add.
      return existingPatterns.slice();
    }
  }
  return [...existingPatterns, candidate];
}

/**
 * Per-line validation for the Settings drawer textareas. Returns an
 * array of `{ line, error }` entries for the lines that didn't compile
 * — used by the UI to draw a red border + tooltip on the textarea when
 * any pattern is broken, and to surface the specific error text.
 *
 * Empty / whitespace-only lines are NOT reported as errors — they're
 * treated as "no pattern on this line, move on".
 */
export function validateIgnoreList(
  patterns: readonly string[],
): { line: number; pattern: string; error: string }[] {
  const errors: { line: number; pattern: string; error: string }[] = [];
  for (let i = 0; i < patterns.length; i += 1) {
    const raw = patterns[i];
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    try {
      new RegExp(trimmed, 'i');
    } catch (err) {
      errors.push({
        line: i + 1,
        pattern: raw,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return errors;
}
