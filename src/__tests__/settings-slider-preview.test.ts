import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Regression guard for v0.1.27 — TTS slider preview parity.
 *
 * v0.1.11 wired `onPreviewVoice?.(voiceURI)` on the Volume slider's release
 * handlers (onPointerUp / onMouseUp / onTouchEnd / onKeyUp) so the user could
 * hear the result of a volume change without typing into chat. The Rate and
 * Pitch sliders SHIPPED WITHOUT THE SAME WIRING — only onChange was set,
 * which mutates state but never re-fires the preview. Net result for the
 * user: Voice + Volume preview correctly, Rate + Pitch silently change the
 * setting with no audible feedback.
 *
 * v0.1.27 extracts a shared `previewOnRelease` handler object and spreads it
 * onto the sliders so every slider previews on release.
 *
 * v0.1.81 — the PITCH slider was REMOVED (the native OS voice engines have no
 * cross-platform pitch knob, so pitch is no longer a setting with audible
 * effect). Only the Rate + Volume sliders remain. This test now asserts:
 *   1. Rate slider has `{...previewOnRelease}` spread on it.
 *   2. Volume slider still has `{...previewOnRelease}` (regression guard).
 *   3. The shared handler exists and calls `onPreviewVoice?.(settings.tts.voiceURI)`.
 *   4. There is NO Pitch slider anymore.
 *
 * Source-level asserts (not render tests) match the codebase convention —
 * the renderer tests run under vitest `environment: 'node'` with no jsdom
 * or testing-library, so DOM-level event simulation would require new
 * tooling. The shape-level guard is sufficient to prevent the regression.
 */
describe('SettingsDrawer — slider preview wiring (v0.1.27)', () => {
  const srcPath = path.join(
    __dirname,
    '..',
    'renderer',
    'SettingsDrawer.tsx',
  );
  const src = fs.readFileSync(srcPath, 'utf8');

  // Strip block comments and single-line // comments so the regex matches
  // don't accidentally hit explanatory comment blocks. This is a coarse
  // filter — fine for SettingsDrawer.tsx's shape.
  const code = src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '') // JSX block comments
    .replace(/\/\*[\s\S]*?\*\//g, '') // C-style block comments
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, '')) // // line comments
    .join('\n');

  // Helper — given a slider <label>NAME</label> followed by an <input>,
  // return the slice of source from the label through the closing `/>` of
  // the input so we can inspect its attributes.
  function sliderInputBlock(labelText: string): string {
    const labelRe = new RegExp(`<label>${labelText}</label>`);
    const labelMatch = labelRe.exec(code);
    expect(labelMatch, `<label>${labelText}</label> should exist in SettingsDrawer.tsx`).not.toBeNull();
    const start = (labelMatch as RegExpExecArray).index;
    // Find the next `/>` after the label — that closes the <input>.
    const closeIdx = code.indexOf('/>', start);
    expect(closeIdx).toBeGreaterThan(start);
    return code.slice(start, closeIdx + 2);
  }

  it('Rate slider spreads {...previewOnRelease} so it previews on release', () => {
    const block = sliderInputBlock('Rate');
    expect(block).toContain('type="range"');
    expect(block).toMatch(/\{\.\.\.previewOnRelease\}/);
  });

  it('Pitch slider was removed (v0.1.81 — no native cross-platform pitch knob)', () => {
    // The Pitch <label>/<input> must NOT be present anymore.
    expect(code).not.toMatch(/<label>Pitch<\/label>/);
  });

  it('Volume slider still spreads {...previewOnRelease} (v0.1.11 guard)', () => {
    const block = sliderInputBlock('Volume');
    expect(block).toContain('type="range"');
    expect(block).toMatch(/\{\.\.\.previewOnRelease\}/);
  });

  it('shared previewOnRelease handler exists and calls onPreviewVoice with the current voiceURI', () => {
    expect(code).toMatch(/const\s+previewOnRelease\s*=/);
    expect(code).toMatch(/onPreviewVoice\?\.\(\s*settings\.tts\.voiceURI\s*\)/);
    // All four release handlers must be present (mouse / pointer / touch / key).
    const handlerBlockMatch = /const\s+previewOnRelease\s*=\s*\{([\s\S]*?)\};/.exec(code);
    expect(handlerBlockMatch, 'previewOnRelease should be a const-declared object literal').not.toBeNull();
    const handlerBlock = (handlerBlockMatch as RegExpExecArray)[1];
    expect(handlerBlock).toContain('onPointerUp');
    expect(handlerBlock).toContain('onMouseUp');
    expect(handlerBlock).toContain('onTouchEnd');
    expect(handlerBlock).toContain('onKeyUp');
  });

  it('previewOnRelease.onKeyUp only previews on navigation keys (a11y guard)', () => {
    // Keyboard release should fire preview ONLY for arrow / Home / End /
    // PageUp / PageDown — pressing Tab away from the slider must NOT trigger
    // a stray preview.
    const navKeys = [
      'ArrowLeft',
      'ArrowRight',
      'ArrowUp',
      'ArrowDown',
      'Home',
      'End',
      'PageUp',
      'PageDown',
    ];
    for (const key of navKeys) {
      expect(code, `navigation key ${key} should be handled in onKeyUp`).toContain(key);
    }
    // Tab should NOT appear as a preview-trigger condition.
    const navRegion =
      /NAV_KEYS\s*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(code)?.[1] ??
      /onKeyUp\s*:\s*\(e[^)]*\)\s*=>\s*\{([\s\S]*?)\}/.exec(code)?.[1] ??
      '';
    expect(navRegion).not.toContain("'Tab'");
    expect(navRegion).not.toContain('"Tab"');
  });
});
