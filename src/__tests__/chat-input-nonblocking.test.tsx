import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { ChatInputInline } from '../renderer/ChatInputInline';

/**
 * v0.1.43 — the inline chat input is non-blocking. The user can mash
 * Enter as fast as they want; each press fires `onSend` synchronously
 * and the input clears IMMEDIATELY. There is no `await`, no `busy`
 * state, no disabled-during-send affordance. The 1msg/sec pacing now
 * lives in the main-process queue (see `chat-send-queue.test.ts`),
 * out of the renderer's hot path.
 *
 * These tests pin the renderer-side contract via react-test-renderer +
 * act() so we get real `useState` / `useEffect` semantics. The setup
 * file `_setup-react-act-env.ts` flips `IS_REACT_ACT_ENVIRONMENT`.
 */

type TestInstance = TestRenderer.ReactTestInstance;

function findTextarea(renderer: TestRenderer.ReactTestRenderer): TestInstance {
  return renderer.root.findByType('textarea');
}

function findSendButton(renderer: TestRenderer.ReactTestRenderer): TestInstance {
  return renderer.root.findByType('button');
}

function typeInto(
  renderer: TestRenderer.ReactTestRenderer,
  value: string,
): void {
  const ta = findTextarea(renderer);
  act(() => {
    ta.props.onChange({ target: { value } });
  });
}

function pressEnter(renderer: TestRenderer.ReactTestRenderer): void {
  const ta = findTextarea(renderer);
  const event = {
    key: 'Enter',
    shiftKey: false,
    preventDefault: vi.fn(),
  };
  act(() => {
    ta.props.onKeyDown(event);
  });
}

describe('ChatInputInline non-blocking send (v0.1.43)', () => {
  it('clears the input synchronously on Enter (no await, no busy gate)', () => {
    const onSend = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <ChatInputInline authenticated connected onSend={onSend} />,
      );
    });
    typeInto(renderer, 'hello world');
    expect(findTextarea(renderer).props.value).toBe('hello world');
    pressEnter(renderer);
    // Input cleared IMMEDIATELY — no awaiting the IPC.
    expect(findTextarea(renderer).props.value).toBe('');
    // onSend invoked with the trimmed text.
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith('hello world');
  });

  it('the textarea is NEVER disabled by an in-flight send (no busy state)', () => {
    const onSend = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <ChatInputInline authenticated connected onSend={onSend} />,
      );
    });
    typeInto(renderer, 'first');
    expect(findTextarea(renderer).props.disabled).toBe(false);
    pressEnter(renderer);
    // v0.1.42 set `disabled` to true while busy. v0.1.43 must NOT — the
    // user has to be able to type the next message while the previous
    // POST is still in flight. `disabled` only flips on disconnect.
    expect(findTextarea(renderer).props.disabled).toBe(false);
  });

  it('handles 5 rapid Enter presses without dropping or blocking any of them', () => {
    const onSend = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <ChatInputInline authenticated connected onSend={onSend} />,
      );
    });
    // Spam-send 5 messages in immediate succession (the bug scenario:
    // the user can't queue a second message until the first finishes).
    for (let i = 0; i < 5; i++) {
      typeInto(renderer, `spam-${i}`);
      pressEnter(renderer);
      expect(findTextarea(renderer).props.value).toBe('');
    }
    expect(onSend).toHaveBeenCalledTimes(5);
    for (let i = 0; i < 5; i++) {
      expect(onSend).toHaveBeenNthCalledWith(i + 1, `spam-${i}`);
    }
  });

  it('skips empty / whitespace-only sends but does NOT throw', () => {
    const onSend = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <ChatInputInline authenticated connected onSend={onSend} />,
      );
    });
    typeInto(renderer, '   ');
    pressEnter(renderer);
    expect(onSend).not.toHaveBeenCalled();
    expect(findTextarea(renderer).props.value).toBe('   '); // unchanged on no-op
  });

  it('disables the send button when text is empty OR connection is down', () => {
    const onSend = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <ChatInputInline authenticated connected onSend={onSend} />,
      );
    });
    // Empty text — button disabled.
    expect(findSendButton(renderer).props.disabled).toBe(true);
    typeInto(renderer, 'ok');
    expect(findSendButton(renderer).props.disabled).toBe(false);
    // Connection drops — button disabled regardless of text.
    act(() => {
      renderer.update(
        <ChatInputInline authenticated connected={false} onSend={onSend} />,
      );
    });
    expect(findSendButton(renderer).props.disabled).toBe(true);
  });

  it('Shift+Enter does NOT send (newline behaviour preserved)', () => {
    const onSend = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <ChatInputInline authenticated connected onSend={onSend} />,
      );
    });
    typeInto(renderer, 'multi-line');
    const ta = findTextarea(renderer);
    const event = {
      key: 'Enter',
      shiftKey: true,
      preventDefault: vi.fn(),
    };
    act(() => {
      ta.props.onKeyDown(event);
    });
    expect(onSend).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(findTextarea(renderer).props.value).toBe('multi-line');
  });

  it('returns null when not authenticated (no input rendered)', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <ChatInputInline
          authenticated={false}
          connected
          onSend={() => undefined}
        />,
      );
    });
    expect(renderer.toJSON()).toBeNull();
  });
});
