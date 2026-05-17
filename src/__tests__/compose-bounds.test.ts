import { describe, it, expect } from 'vitest';
import {
  clampComposeBounds,
  COMPOSE_DEFAULT_WIDTH,
  COMPOSE_DEFAULT_HEIGHT,
  COMPOSE_MIN_WIDTH,
  COMPOSE_MIN_HEIGHT,
} from '../main/compose-bounds';

const WORK_AREA = { x: 0, y: 0, width: 1920, height: 1080 };

describe('clampComposeBounds', () => {
  it('uses defaults when nothing is saved', () => {
    const out = clampComposeBounds(undefined, WORK_AREA);
    expect(out.width).toBe(COMPOSE_DEFAULT_WIDTH);
    expect(out.height).toBe(COMPOSE_DEFAULT_HEIGHT);
    expect(out.x).toBeUndefined();
    expect(out.y).toBeUndefined();
  });

  it('restores a valid persisted size + position', () => {
    const out = clampComposeBounds(
      { width: 600, height: 320, x: 200, y: 150 },
      WORK_AREA,
    );
    expect(out).toEqual({ width: 600, height: 320, x: 200, y: 150 });
  });

  it('floors below-minimum dimensions to the hard minimums', () => {
    const out = clampComposeBounds({ width: 100, height: 50 }, WORK_AREA);
    expect(out.width).toBe(COMPOSE_MIN_WIDTH);
    expect(out.height).toBe(COMPOSE_MIN_HEIGHT);
  });

  it('ceilings dimensions larger than the work area', () => {
    const out = clampComposeBounds(
      { width: 4000, height: 3000 },
      WORK_AREA,
    );
    expect(out.width).toBe(WORK_AREA.width);
    expect(out.height).toBe(WORK_AREA.height);
  });

  it('drops position when the window would fall off the right edge', () => {
    const out = clampComposeBounds(
      { width: 500, height: 300, x: 1800, y: 100 },
      WORK_AREA,
    );
    // 1800 + 500 = 2300 > 1920 → position dropped
    expect(out.x).toBeUndefined();
    expect(out.y).toBeUndefined();
    expect(out.width).toBe(500);
    expect(out.height).toBe(300);
  });

  it('drops position when the window would fall off the bottom edge', () => {
    const out = clampComposeBounds(
      { width: 500, height: 300, x: 100, y: 900 },
      WORK_AREA,
    );
    expect(out.x).toBeUndefined();
    expect(out.y).toBeUndefined();
  });

  it('drops position when only one axis is saved', () => {
    const out = clampComposeBounds(
      { width: 500, height: 300, x: 100 },
      WORK_AREA,
    );
    expect(out.x).toBeUndefined();
    expect(out.y).toBeUndefined();
  });

  it('drops position when x or y is negative on a non-zero-origin work area', () => {
    const out = clampComposeBounds(
      { width: 500, height: 300, x: -50, y: 50 },
      { x: 0, y: 0, width: 1920, height: 1080 },
    );
    expect(out.x).toBeUndefined();
    expect(out.y).toBeUndefined();
  });

  it('respects a non-zero work-area origin (secondary display to the right)', () => {
    const secondary = { x: 1920, y: 0, width: 1280, height: 1080 };
    const out = clampComposeBounds(
      { width: 500, height: 300, x: 2000, y: 100 },
      secondary,
    );
    expect(out).toEqual({ width: 500, height: 300, x: 2000, y: 100 });
  });

  it('drops position when saved on a now-disconnected secondary display', () => {
    // User saved bounds with x=2000 on a secondary display, then unplugged
    // it. The primary work area is the only one we see.
    const out = clampComposeBounds(
      { width: 500, height: 300, x: 2000, y: 100 },
      WORK_AREA,
    );
    expect(out.x).toBeUndefined();
    expect(out.y).toBeUndefined();
    expect(out.width).toBe(500);
    expect(out.height).toBe(300);
  });

  it('handles non-finite saved values by falling back to defaults', () => {
    const out = clampComposeBounds(
      { width: NaN as unknown as number, height: Infinity as unknown as number },
      WORK_AREA,
    );
    expect(out.width).toBe(COMPOSE_DEFAULT_WIDTH);
    expect(out.height).toBe(COMPOSE_DEFAULT_HEIGHT);
  });
});
