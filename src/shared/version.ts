// Tiny semver-compare helper, shared between main and renderer.
//
// We poll GitHub's Releases API ourselves (in parallel with
// `update-electron-app` / Squirrel) so update detection works even when the
// app is unsigned — Squirrel.Mac silently refuses unsigned updates, which is
// why the original auto-update path doesn't fire today. The GH path only
// needs to ANSWER "is there a newer version?" and "where is it?" — actually
// installing the update still requires the signed Squirrel feed; until then
// the banner offers a Download button that opens the release page in the
// system browser.
//
// We deliberately don't pull in a full semver library (`semver` is 50 KB +
// dependencies) — Restream Chat++ versions are always strict
// `MAJOR.MINOR.PATCH` with no pre-release tags, so a numeric three-part
// compare is sufficient.

/**
 * Parse a version string of the form `vX.Y.Z` or `X.Y.Z` (leading `v` is
 * tolerated because GitHub release tags use the `v` prefix). Returns
 * `[major, minor, patch]`, or `null` if the string isn't a well-formed
 * three-segment semver core.
 *
 * Pre-release tags (`1.2.3-rc.1`) and build metadata (`+sha.abc`) are not
 * supported by design — our release flow doesn't produce them. If we ever
 * ship one, this returns `null` for that side which makes the compare
 * conservatively treat it as "not newer" (safer than mis-comparing).
 */
export function parseVersion(input: string | undefined | null): [number, number, number] | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim().replace(/^v/i, '');
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(trimmed);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Return `true` iff `candidate` is strictly newer than `current`.
 *
 * Used to decide whether to surface the "Update available" banner. Both
 * inputs may carry an optional leading `v` (`v0.1.19`); both are normalised
 * via `parseVersion`. If EITHER input fails to parse, returns `false` —
 * being conservative is preferable to flashing a phantom banner.
 */
export function isNewerVersion(candidate: string | undefined | null, current: string | undefined | null): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return false; // equal
}
