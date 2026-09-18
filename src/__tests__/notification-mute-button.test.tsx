import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { SettingsDrawer } from '../renderer/SettingsDrawer';
import { TtsDispatcher } from '../main/tts-dispatch';
import { DEFAULT_SETTINGS, type Settings } from '../shared/types';

vi.mock('../renderer/api', () => ({ rcpp: {} }));

/** Exercise the actual header JSX and handler without booting Electron or touching live settings. */
function renderControls(settings: Settings, updateSettings: (next: Settings) => void) {
  const source = readFileSync(new URL('../renderer/App.tsx', import.meta.url), 'utf8');
  const tree = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let handler: string | undefined;
  let controls: string | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'toggleNotifications') handler = node.initializer?.getText(tree);
    if (ts.isJsxElement(node) && node.openingElement.attributes.properties.some((attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText(tree) === 'className' && attribute.initializer?.getText(tree) === '"mute-controls"')) controls = node.getText(tree);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert(handler && controls, 'Missing notification mute handler or paired header controls');
  let element!: React.ReactElement;
  runInNewContext(ts.transpile(`const toggleNotifications = ${handler}; capture(${controls});`, { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React }), {
    React, settings, updateSettings, toggleMuted: vi.fn(), capture: (value: React.ReactElement) => { element = value; },
  });
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => { renderer = TestRenderer.create(element); });
  return renderer;
}

describe('Header notification mute', () => {
  it.each([true, false])('toggles notifications from enabled=%s without changing speech or preferences', (enabled) => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.notifications = { enabled, soundEnabled: true, maxPerMinute: 7 };
    settings.tts.muted = true;
    const updateSettings = vi.fn();
    const renderer = renderControls(settings, updateSettings);
    const buttons = renderer.root.findAllByType('button');
    expect(buttons.map((button) => button.props['aria-label'])).toEqual(['Unmute speech', enabled ? 'Mute notifications' : 'Unmute notifications']);
    expect(buttons[1].props.title).toBe(buttons[1].props['aria-label']);
    expect(buttons[1].props['aria-pressed']).toBe(!enabled);
    expect(buttons[1].children).toEqual([enabled ? '🔔' : '🔕']);
    expect(buttons[1].props.className.endsWith(' muted')).toBe(!enabled);
    act(() => { buttons[1].props.onClick(); });
    expect(updateSettings).toHaveBeenCalledExactlyOnceWith({ ...settings, notifications: { ...settings.notifications, enabled: !enabled } });
    act(() => { renderer.unmount(); });
  });

  it('shares Settings enabled state and stops native notifications without stopping speech', () => {
    let settings = structuredClone(DEFAULT_SETTINGS);
    settings.tts.enabled = true;
    settings.tts.muted = false;
    settings.notifications.enabled = true;
    const notify = vi.fn();
    const speakNative = vi.fn();
    const dispatcher = new TtsDispatcher({ loadSettings: () => settings, notify, speakNative, log: vi.fn() });
    const renderer = renderControls(settings, (next) => { settings = next; });
    act(() => { renderer.root.findByProps({ 'aria-label': 'Mute notifications' }).props.onClick(); });
    dispatcher.handleMessage({ id: 'muted', platform: 'twitch', username: 'viewer', text: 'hello', ts: 1 });
    expect(notify).not.toHaveBeenCalled();
    expect(speakNative).toHaveBeenCalledOnce();
    let drawer!: TestRenderer.ReactTestRenderer;
    act(() => { drawer = TestRenderer.create(<SettingsDrawer settings={settings} onChange={(next) => { settings = next; }} onClose={vi.fn()} />); });
    const notifications = drawer.root.findAllByType('section').find((section) => section.findAllByType('h3').some((heading) => heading.children.includes('Notifications')));
    assert(notifications);
    const enabled = notifications.findAllByType('input')[0];
    expect(enabled.props.checked).toBe(false);
    act(() => { enabled.props.onChange({ target: { checked: true } }); });
    const refreshed = renderControls(settings, vi.fn());
    expect(refreshed.root.findByProps({ 'aria-label': 'Mute notifications' }).props['aria-pressed']).toBe(false);
    dispatcher.handleMessage({ id: 'unmuted', platform: 'twitch', username: 'viewer', text: 'again', ts: 2 });
    expect(notify).toHaveBeenCalledOnce();
    expect(speakNative).toHaveBeenCalledTimes(2);
    act(() => { renderer.unmount(); drawer.unmount(); refreshed.unmount(); });
  });
});
