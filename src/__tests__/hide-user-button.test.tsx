import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { MessageRow } from '../renderer/ChatFeed';
import { SettingsDrawer } from '../renderer/SettingsDrawer';
import { addHiddenUser, compileIgnorePatterns } from '../shared/message-filters';
import { DEFAULT_SETTINGS, IPC, type ChatMessage, type Settings } from '../shared/types';

vi.mock('../renderer/api', () => ({ rcpp: { showChatContextMenu: vi.fn() } }));

const message: ChatMessage = { id: 'bot-1', platform: 'twitch', username: 'Bot[1]', text: 'spam', ts: 1 };

/** Extract the real IPC/renderer closure, following the auth-recovery wiring tests. */
function readHandler(file: string, kind: 'main' | 'renderer'): string {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8');
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let handler: string | undefined;
  const visit = (node: ts.Node): void => {
    if (kind === 'main' && ts.isCallExpression(node) && node.expression.getText(tree) === 'ipcMain.handle' && node.arguments[0]?.getText(tree) === 'IPC.SETTINGS_HIDE_USER') {
      handler = node.arguments[1].getText(tree);
    }
    if (kind === 'renderer' && ts.isVariableDeclaration(node) && node.name.getText(tree) === 'handleHideUser') handler = node.initializer?.getText(tree);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert(handler, `Missing ${kind} hide-user handler`);
  return ts.transpile(`capture(${handler});`, { target: ts.ScriptTarget.ES2022 });
}

describe('Hide user hover action', () => {
  it('keeps Hide available beside Silence and for an already-silenced author', () => {
    const onHideUser = vi.fn();
    const onSilenceUser = vi.fn();
    const stopPropagation = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => { renderer = TestRenderer.create(<MessageRow message={message} onHideUser={onHideUser} onSilenceUser={onSilenceUser} />); });
    expect(renderer.root.findAllByProps({ className: 'silence-user-btn' })).toHaveLength(1);
    const button = renderer.root.findByProps({ className: 'hide-user-btn' });
    expect(button.props['aria-label']).toBe('Hide Bot[1]');
    expect(button.props.title).toContain('RC++');
    act(() => { button.props.onClick({ stopPropagation }); });
    expect(onHideUser).toHaveBeenCalledExactlyOnceWith('Bot[1]');
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(onSilenceUser).not.toHaveBeenCalled();
    const patterns = compileIgnorePatterns(['^Bot\\[1\\]$']);
    act(() => { renderer.update(<MessageRow message={message} onHideUser={onHideUser} onSilenceUser={onSilenceUser} silencedTtsUsernamePatterns={patterns} silencedNotificationUsernamePatterns={patterns} />); });
    expect(renderer.root.findAllByProps({ className: 'silence-user-status' })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ className: 'hide-user-btn' })).toHaveLength(1);
  });

  it.each([{ self: true }, { username: '' }, { username: '  ' }])('does not offer to hide self/anonymous rows: %j', (patch) => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => { renderer = TestRenderer.create(<MessageRow message={{ ...message, ...patch }} onHideUser={vi.fn()} />); });
    expect(renderer.root.findAllByProps({ className: 'hide-user-btn' })).toHaveLength(0);
  });

  it('unhides through existing Settings without changing silence rules', () => {
    const settings = { ...structuredClone(DEFAULT_SETTINGS), hiddenUsers: ['Bot[1]', 'OtherBot'] };
    const onChange = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => { renderer = TestRenderer.create(<SettingsDrawer settings={settings} onChange={onChange} onClose={vi.fn()} />); });
    act(() => { renderer.root.findByProps({ 'aria-label': 'Unhide Bot[1]' }).props.onClick(); });
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ ...settings, hiddenUsers: ['OtherBot'] });
  });
});

describe('Hide user persistence wiring', () => {
  it('merges the latest settings, deduplicates and cancels only this author after saving', () => {
    let current = structuredClone(DEFAULT_SETTINGS);
    let handler!: (_event: unknown, username: unknown) => Settings;
    const saveSettings = vi.fn((settings: Settings) => { current = settings; return settings; });
    const cancelUsername = vi.fn();
    runInNewContext(readHandler('../main/main.ts', 'main'), {
      Error, addHiddenUser, loadSettings: () => current, saveSettings,
      nativeTts: { cancelUsername }, capture: (fn: typeof handler) => { handler = fn; },
    });
    current = { ...current, hiddenUsers: ['OtherBot'], notifications: { ...current.notifications, enabled: !current.notifications.enabled } };
    const latest = current;
    expect(handler(null, ' Bot[1] ')).toEqual({ ...latest, hiddenUsers: ['OtherBot', 'Bot[1]'] });
    expect(cancelUsername).toHaveBeenCalledExactlyOnceWith('Bot[1]');
    expect(saveSettings.mock.invocationCallOrder[0]).toBeLessThan(cancelUsername.mock.invocationCallOrder[0]);
    expect(handler(null, 'bot[1]').hiddenUsers).toEqual(['OtherBot', 'Bot[1]']);
    for (const invalid of ['', ' ', null, 123]) expect(() => handler(null, invalid)).toThrow('Missing chat username');
    saveSettings.mockImplementationOnce(() => { throw new Error('disk full'); });
    expect(() => handler(null, 'NotSaved')).toThrow('disk full');
    expect(cancelUsername).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])('rolls optimistic hiding back after a failed save (reload fails: %s)', async (reloadFails) => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    let current = settings;
    let handler!: (username: string) => void;
    const setSettings = vi.fn((update: Settings | ((previous: Settings) => Settings)) => { current = typeof update === 'function' ? update(current) : update; });
    const setSilenceError = vi.fn();
    const persisted = { ...settings, hiddenUsers: ['OtherBot'] };
    const getSettings = vi.fn(() => reloadFails ? Promise.reject(new Error('IPC down')) : Promise.resolve(persisted));
    const hideUser = vi.fn(() => Promise.reject(new Error('disk full')));
    runInNewContext(readHandler('../renderer/App.tsx', 'renderer'), {
      Error, settings, addHiddenUser, setSettings, setSilenceError, rcpp: { hideUser, getSettings },
      capture: (fn: typeof handler) => { handler = fn; },
    });
    handler('Bot[1]');
    expect(current.hiddenUsers).toEqual(['Bot[1]']);
    await vi.waitFor(() => expect(getSettings).toHaveBeenCalledOnce());
    expect(current).toEqual(reloadFails ? settings : persisted);
    expect(setSilenceError).toHaveBeenLastCalledWith('Failed to hide Bot[1]: disk full');
  });

  it('threads the username-only IPC from preload and the callback from App', () => {
    const preload = readFileSync(new URL('../preload.ts', import.meta.url), 'utf8');
    expect(preload).toContain('ipcRenderer.invoke(IPC.SETTINGS_HIDE_USER, username)');
    expect(IPC.SETTINGS_HIDE_USER).toBe('settings:hide-user');
    const app = readFileSync(new URL('../renderer/App.tsx', import.meta.url), 'utf8');
    expect(app).toContain('onHideUser={handleHideUser}');
  });
});
