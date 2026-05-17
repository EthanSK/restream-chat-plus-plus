// Bounds sanitisation for the v0.1.32 native Compose window.
//
// The Compose window's last size + position is persisted via electron-store
// under the `composeWindow` key. On restore we must clamp the saved values
// against (a) the compose UI's intrinsic min dimensions, and (b) the work
// area of the display the window is supposed to appear on.
//
// The function is split out of main.ts so it can be unit-tested without
// having to spin up Electron's `screen` module — main.ts injects the
// actual work area at runtime.

import type { ComposeWindowBounds } from './store';

/** Compose window's hard minimum content size — anything smaller renders
 * the textarea + send button without enough room to type. */
export const COMPOSE_MIN_WIDTH = 360;
export const COMPOSE_MIN_HEIGHT = 200;

/** Default size used when no persisted bounds exist. Tuned to match
 * Messages/Slack-thread-reply-style compose popups: narrow, short, just
 * enough for the textarea + a couple of UI controls. */
export const COMPOSE_DEFAULT_WIDTH = 520;
export const COMPOSE_DEFAULT_HEIGHT = 280;

export interface WorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ClampedBounds {
  width: number;
  height: number;
  /** Only set when both a saved x AND y were present AND fit inside the
   * work area. Otherwise undefined → BrowserWindow will centre on parent. */
  x?: number;
  y?: number;
}

/**
 * Clamp persisted compose bounds against the display's work area. Pure
 * function: takes the saved values + work area, returns the values the
 * BrowserWindow should be opened with.
 *
 * Behaviour:
 *   - Missing / non-finite dimensions fall back to defaults.
 *   - Width/height clamped to [MIN_*, workArea.size] so the window can
 *     never be larger than the display or smaller than usable.
 *   - Position is only honoured if BOTH x and y are inside the work area
 *     after the size clamp. Otherwise we drop position (caller centres).
 *   - A saved `alwaysOnTop` is preserved as-is — we don't mutate it here.
 */
export function clampComposeBounds(
  saved: ComposeWindowBounds | undefined,
  workArea: WorkArea,
): ClampedBounds {
  const wRaw = saved?.width;
  const hRaw = saved?.height;
  const width = Number.isFinite(wRaw)
    ? clamp(wRaw as number, COMPOSE_MIN_WIDTH, workArea.width)
    : COMPOSE_DEFAULT_WIDTH;
  const height = Number.isFinite(hRaw)
    ? clamp(hRaw as number, COMPOSE_MIN_HEIGHT, workArea.height)
    : COMPOSE_DEFAULT_HEIGHT;

  const x = saved?.x;
  const y = saved?.y;
  // Position is only honoured when both axes are finite AND the window
  // (with its clamped size) fits ENTIRELY inside the work area. This
  // defends against multi-monitor unplug scenarios where the saved
  // position would put the window off-screen.
  const positionUsable =
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    (x as number) >= workArea.x &&
    (y as number) >= workArea.y &&
    (x as number) + width <= workArea.x + workArea.width &&
    (y as number) + height <= workArea.y + workArea.height;

  if (positionUsable) {
    return { width, height, x: x as number, y: y as number };
  }
  return { width, height };
}

function clamp(value: number, lo: number, hi: number): number {
  if (hi < lo) return lo;
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}
