import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Regression guard for the v0.1.15 blank-screen bug.
 *
 * `ChatInputInline.tsx` originally placed an `if (!authenticated) return null;`
 * early-return BETWEEN a block of useState/useRef hooks and a subsequent
 * useEffect. That violates React's Rules of Hooks — hook count must be
 * identical across renders — and triggered production error #310
 * ("Rendered more hooks than during the previous render") the moment
 * `authenticated` flipped from false → true after the initial AUTH_STATUS
 * push. The entire renderer threw, the error boundary didn't exist, and
 * the window went blank.
 *
 * v0.1.16 moves the useEffect ABOVE the early-return so hook count is
 * stable. This test asserts that property at the source level so a
 * future refactor can't silently reintroduce the same shape.
 */
describe('ChatInputInline hook ordering', () => {
  const srcPath = path.join(
    __dirname,
    '..',
    'renderer',
    'ChatInputInline.tsx',
  );
  const src = fs.readFileSync(srcPath, 'utf8');

  it('places all React hooks above the `if (!authenticated) return null` early return', () => {
    const lines = src.split('\n');

    // Helper — strip leading whitespace then drop comment lines so the
    // regex below doesn't match commented occurrences of `useEffect(...)`
    // or `if (!authenticated) return null` inside JSDoc / explanatory
    // comments. This is a coarse filter that misses block comments mid-
    // file, but ChatInputInline only uses single-line `//` comments so
    // it's sufficient.
    const isCode = (line: string): boolean => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith('//')) return false;
      if (trimmed.startsWith('*')) return false;
      return true;
    };

    // Find every hook call site. We accept the common ones — useState,
    // useRef, useEffect, useMemo, useCallback, useReducer, useLayoutEffect
    // — and the (case-insensitive) custom `use*` convention is covered by
    // the same regex.
    const hookRe = /\buse[A-Z]\w*\s*\(/;
    const lastHookLine = lines.reduce(
      (acc, line, idx) => (isCode(line) && hookRe.test(line) ? idx : acc),
      -1,
    );
    expect(lastHookLine).toBeGreaterThan(-1);

    // Find the early-return line. It MUST come AFTER the last hook so
    // hook count is identical on every render regardless of the
    // `authenticated` prop.
    const earlyReturnLine = lines.findIndex(
      (line) =>
        isCode(line) &&
        /if\s*\(\s*!\s*authenticated\s*\)\s*return\s+null/.test(line),
    );
    expect(earlyReturnLine).toBeGreaterThan(-1);

    expect(earlyReturnLine).toBeGreaterThan(lastHookLine);
  });
});
