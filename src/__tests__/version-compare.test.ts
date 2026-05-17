import { describe, it, expect } from 'vitest';
import { isNewerVersion, parseVersion } from '../shared/version';

/**
 * The GH-Releases-API update poller (`src/main/github-update-check.ts`) decides
 * whether to surface the "Update available" banner based on `isNewerVersion`.
 * If this helper says yes when it shouldn't, the user gets a phantom banner
 * pointing at a release they already have installed (or worse, a downgrade).
 * If it says no when it should, the user misses real updates and stays
 * stranded — exactly the symptom that prompted the GH-API path in the first
 * place (Squirrel.Mac silently rejecting unsigned updates).
 *
 * So this test suite exhaustively covers the regression-prone edges: leading
 * `v` prefixes (GH release tags use them, `app.getVersion()` doesn't), equal
 * versions (must return false — equal is NOT newer), each segment's
 * sensitivity to lexicographic-vs-numeric compare (`v0.1.10` MUST beat
 * `v0.1.9` even though the string compare says otherwise), and malformed
 * inputs (must conservatively return false, never throw).
 */

describe('parseVersion', () => {
  it('parses bare X.Y.Z', () => {
    expect(parseVersion('0.1.24')).toEqual([0, 1, 24]);
  });

  it('tolerates a leading v', () => {
    expect(parseVersion('v0.1.24')).toEqual([0, 1, 24]);
  });

  it('tolerates a leading V (uppercase)', () => {
    expect(parseVersion('V0.1.24')).toEqual([0, 1, 24]);
  });

  it('trims surrounding whitespace', () => {
    expect(parseVersion('  v0.1.24  ')).toEqual([0, 1, 24]);
  });

  it('returns null for two-segment versions', () => {
    expect(parseVersion('0.1')).toBeNull();
  });

  it('returns null for four-segment versions', () => {
    expect(parseVersion('0.1.2.3')).toBeNull();
  });

  it('returns null for pre-release tags (not supported by design)', () => {
    expect(parseVersion('0.1.24-rc.1')).toBeNull();
  });

  it('returns null for build metadata', () => {
    expect(parseVersion('0.1.24+sha.abc')).toBeNull();
  });

  it('returns null for non-string input', () => {
    expect(parseVersion(undefined)).toBeNull();
    expect(parseVersion(null)).toBeNull();
    // @ts-expect-error — runtime guard
    expect(parseVersion(123)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseVersion('')).toBeNull();
  });
});

describe('isNewerVersion', () => {
  it('returns true when patch is newer', () => {
    expect(isNewerVersion('0.1.24', '0.1.22')).toBe(true);
  });

  it('returns true when minor is newer', () => {
    expect(isNewerVersion('0.2.0', '0.1.99')).toBe(true);
  });

  it('returns true when major is newer', () => {
    expect(isNewerVersion('1.0.0', '0.99.99')).toBe(true);
  });

  it('returns false when versions are equal', () => {
    expect(isNewerVersion('0.1.24', '0.1.24')).toBe(false);
  });

  it('returns false when candidate is older (patch)', () => {
    expect(isNewerVersion('0.1.22', '0.1.24')).toBe(false);
  });

  it('returns false when candidate is older (minor)', () => {
    expect(isNewerVersion('0.0.99', '0.1.0')).toBe(false);
  });

  it('returns false when candidate is older (major)', () => {
    expect(isNewerVersion('0.99.99', '1.0.0')).toBe(false);
  });

  it('uses numeric, not lexicographic, comparison on patch', () => {
    // The regression-prone case: "10" < "9" lexicographically but 10 > 9
    // numerically. A string-compare implementation would tell users on
    // v0.1.10 there's an "update" to v0.1.9 and downgrade them.
    expect(isNewerVersion('0.1.10', '0.1.9')).toBe(true);
    expect(isNewerVersion('0.1.9', '0.1.10')).toBe(false);
  });

  it('uses numeric, not lexicographic, comparison on minor', () => {
    expect(isNewerVersion('0.10.0', '0.9.99')).toBe(true);
    expect(isNewerVersion('0.9.99', '0.10.0')).toBe(false);
  });

  it('tolerates a leading v on the candidate (GH tag style)', () => {
    expect(isNewerVersion('v0.1.24', '0.1.22')).toBe(true);
  });

  it('tolerates a leading v on the current version', () => {
    expect(isNewerVersion('0.1.24', 'v0.1.22')).toBe(true);
  });

  it('tolerates mixed v-prefix styles', () => {
    expect(isNewerVersion('v0.1.24', 'v0.1.22')).toBe(true);
  });

  it('returns false when either side fails to parse (conservative)', () => {
    // Better to skip the banner than to flash a phantom one.
    expect(isNewerVersion('garbage', '0.1.22')).toBe(false);
    expect(isNewerVersion('0.1.24', 'garbage')).toBe(false);
    expect(isNewerVersion('0.1.24-rc.1', '0.1.22')).toBe(false);
  });

  it('returns false for nullish / undefined input', () => {
    expect(isNewerVersion(undefined, '0.1.22')).toBe(false);
    expect(isNewerVersion('0.1.24', undefined)).toBe(false);
    expect(isNewerVersion(null, null)).toBe(false);
  });

  it('handles the real-world v0.1.22 → v0.1.24 jump used by this release', () => {
    // Sanity check the actual jump shipped with this code change.
    expect(isNewerVersion('v0.1.24', 'v0.1.22')).toBe(true);
    expect(isNewerVersion('v0.1.23', 'v0.1.24')).toBe(false);
  });
});
