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
 * `text` and return the side-effect flags. Pure function — does NOT
 * mutate any input.
 *
 * Returns `undefined` for each flag when the message is NOT ignored.
 * Returning `undefined` rather than `false` keeps the persisted
 * ChatMessage shape lean — only ignored messages carry the flag, which
 * matches the "optional badge" semantics in ChatFeed.tsx.
 */
export function applyMessageFilters(
  text: string,
  ttsPatterns: readonly RegExp[],
  notifPatterns: readonly RegExp[],
): { ignoredByTts?: boolean; ignoredByNotifications?: boolean } {
  const out: { ignoredByTts?: boolean; ignoredByNotifications?: boolean } = {};
  if (matchesAnyIgnorePattern(text, ttsPatterns)) {
    out.ignoredByTts = true;
  }
  if (matchesAnyIgnorePattern(text, notifPatterns)) {
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
