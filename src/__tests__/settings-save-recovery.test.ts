import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '../shared/types';

/** Run the actual renderer save closure without changing live app settings. */
function makeHarness() {
  const source = readFileSync(new URL('../renderer/App.tsx', import.meta.url), 'utf8');
  const tree = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let implementation: string | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'updateSettings') implementation = node.initializer?.getText(tree);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert(implementation, 'Missing actual settings save closure');
  const previous = structuredClone(DEFAULT_SETTINGS);
  previous.tts.enabled = true;
  previous.tts.muted = false;
  let displayed = previous;
  const setSettings = vi.fn(async (next: Settings) => next);
  const getSettings = vi.fn(async () => previous);
  const previewUpdate = vi.fn();
  const error = vi.fn();
  const update: (next: Settings) => Promise<void> = runInNewContext(ts.transpile(`(${implementation})`, { target: ts.ScriptTarget.ES2022 }), {
    settings: previous,
    setSettings: (next: Settings | ((current: Settings) => Settings)) => { displayed = typeof next === 'function' ? next(displayed) : next; },
    rcpp: { setSettings, getSettings, ttsNative: { updateSettings: previewUpdate } },
    console: { error },
  });
  return { previous, update, setSettings, getSettings, previewUpdate, error, displayed: () => displayed };
}

describe('Settings save failure recovery', () => {
  it('restores saved mute state and handles a failed write without changing native previews', async () => {
    const h = makeHarness();
    const next = { ...h.previous, tts: { ...h.previous.tts, muted: true, volume: .01 } };
    h.setSettings.mockRejectedValueOnce(new Error('Injected write failure'));
    await expect(h.update(next)).resolves.toBeUndefined();
    expect(h.displayed()).toEqual(h.previous);
    expect(h.getSettings).toHaveBeenCalledOnce();
    expect(h.previewUpdate).not.toHaveBeenCalled();
    expect(h.error).toHaveBeenCalledOnce();
  });

  it('keeps the previous visible settings when save and readback both fail', async () => {
    const h = makeHarness();
    h.setSettings.mockRejectedValueOnce(new Error('Write failed'));
    h.getSettings.mockRejectedValueOnce(new Error('Read failed'));
    await expect(h.update({ ...h.previous, notifications: { ...h.previous.notifications, enabled: false } })).resolves.toBeUndefined();
    expect(h.displayed()).toEqual(h.previous);
  });

  it('does not roll back a newer edit when an older failed save finishes readback', async () => {
    const h = makeHarness();
    let resolveRead!: (value: Settings) => void;
    h.setSettings.mockRejectedValueOnce(new Error('Write failed'));
    h.getSettings.mockImplementationOnce(() => new Promise((resolve) => { resolveRead = resolve; }));
    const older = h.update({ ...h.previous, tts: { ...h.previous.tts, muted: true } });
    await vi.waitFor(() => expect(h.getSettings).toHaveBeenCalledOnce());
    const newer = { ...h.previous, tts: { ...h.previous.tts, volume: .6 } };
    await h.update(newer);
    resolveRead(h.previous);
    await older;
    expect(h.displayed()).toEqual(newer);
  });

  it('saves normal settings without a readback or duplicate native settings push', async () => {
    const h = makeHarness();
    const next = { ...h.previous, tts: { ...h.previous.tts, volume: .6 } };
    await h.update(next);
    expect(h.displayed()).toEqual(next);
    expect(h.setSettings).toHaveBeenCalledExactlyOnceWith(next);
    expect(h.getSettings).not.toHaveBeenCalled();
    expect(h.previewUpdate).not.toHaveBeenCalled();
  });
});
