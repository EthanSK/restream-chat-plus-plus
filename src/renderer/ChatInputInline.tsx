import React, { useEffect, useRef, useState } from 'react';

interface Props {
  authenticated: boolean;
  connected: boolean;
  /**
   * v0.1.43 — invoked synchronously when the user presses Enter on a
   * non-empty text value. The parent (App.tsx) mints the optimistic
   * placeholder message and ships the enqueue IPC. This component does
   * NOT await; the input clears the moment this returns so the user can
   * spam-send without ever being gated by a network round-trip.
   *
   * Returns void — there is no "this might fail" path at the input layer
   * any more. Per-message failures surface as a ⚠ icon on the optimistic
   * placeholder in the chat feed (driven by `CHAT_SEND_STATUS` from main).
   */
  onSend: (text: string) => void;
}

/**
 * Inline chat input bar.
 *
 * Sits at the bottom of the main feed and pushes a `CHAT_SEND_ENQUEUE`
 * IPC for every Enter — the main-process queue serialises the actual
 * POSTs against Restream's `/client/reply` endpoint. The input clears
 * IMMEDIATELY on send so the user can fire as many messages as they want
 * in a row without ever being gated by a network round-trip (v0.1.43).
 *
 * Optimistic UI: App.tsx renders the just-typed message in the chat
 * feed the moment this component calls `onSend`. The main-process queue
 * broadcasts `CHAT_SEND_STATUS` back; App.tsx flips the placeholder to
 * sent (replaced by the WS echo) or failed (small ⚠ + tooltip with the
 * error reason).
 *
 * Keyboard contract:
 *   - Enter           — send (when text is non-empty)
 *   - Shift+Enter     — newline
 *   - Cmd/Ctrl+Enter  — also sends (matches Slack/Discord muscle memory)
 *
 * v0.1.43: removed the local `busy` spinner + `await rcpp.sendChatText`
 * gate. The input is NEVER disabled by an in-flight send. The previous
 * spinner + 1msg/sec rate-limit gated typing speed; now sends are
 * fire-and-forget from the renderer's perspective and the queue paces
 * the actual POSTs at ≤1/sec under the hood.
 *
 * v0.1.34: the separate "Compose" window (v0.1.32-v0.1.33) was a wash —
 * it called the SAME `rcpp.sendChatText` IPC as this inline input, so
 * any send bug here also broke Compose. Removing it kept the surface
 * area honest.
 *
 * v0.1.40: the small "Webchat" escape-hatch button next to send is also
 * gone. Inline send works now (v0.1.34 fixed the `/api/client/reply`
 * endpoint) so the button is redundant.
 *
 * The cold-start cookie provisioning is handled transparently in the
 * main process — first send may take a beat under the hood while it
 * spawns an invisible helper window to populate `persist:restream-oauth`'s
 * cookie jar, but the renderer never blocks on it.
 */
export function ChatInputInline({
  authenticated,
  connected,
  onSend,
}: Props): React.ReactElement | null {
  const [text, setText] = useState('');
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  // Auto-grow the textarea height as the user types (cap at 6 visible lines
  // ~= 144px). v0.1.34: bumped from 4 lines (96px) since the separate
  // Compose window was removed — multi-line composition now happens here.
  //
  // IMPORTANT: This hook MUST sit ABOVE the `if (!authenticated) return null`
  // early-return below. Hooks must run in the same order on every render —
  // declaring useState/useRef before the early-return and useEffect AFTER it
  // means the hook count jumps from 5 → 6 the moment `authenticated` flips
  // from false → true, which trips React's "Rendered more hooks than during
  // the previous render" guard (production error #310) and blanks the entire
  // app. v0.1.15 surfaced this every launch because the new
  // `startupAuthDone` gating in main.ts guarantees the renderer always boots
  // with `authenticated: false` and flips to true a tick later (instead of
  // the synchronous-resume path that occasionally masked the hook ordering
  // bug in v0.1.14). v0.1.16 fix.
  useEffect(() => {
    if (!authenticated) return;
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(144, el.scrollHeight) + 'px';
  }, [text, authenticated]);

  // Hide entirely until the user is signed in. MUST stay below ALL hooks.
  if (!authenticated) return null;

  // Synchronous send: trim, invoke the parent callback (which mints the
  // optimistic placeholder + ships the enqueue IPC), clear the input.
  // No await, no busy state. v0.1.43.
  const doSend = (): void => {
    const value = text.trim();
    if (!value) return;
    try {
      onSend(value);
    } catch (err) {
      // The parent's onSend wraps a fire-and-forget IPC + a state
      // update; throwing here would be a programmer error. Log + carry
      // on — we still clear the input so the user can keep typing.
      // eslint-disable-next-line no-console
      console.error('[ChatInputInline] onSend threw', err);
    }
    setText('');
    // Reset textarea height — the auto-grow effect runs on next render
    // but explicit reset here keeps the visible row count snapping back
    // to 1 immediately rather than waiting a tick.
    const el = taRef.current;
    if (el) el.style.height = 'auto';
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Send on Enter; Shift+Enter means newline. Cmd/Ctrl+Enter also sends
    // (Slack/Discord muscle memory).
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      doSend();
    }
  };

  const placeholder = connected
    ? 'Send a chat message — Enter to send, Shift+Enter for newline'
    : 'Waiting for Restream connection…';

  return (
    <div className="chat-input chat-input-inline">
      <textarea
        ref={taRef}
        className="chat-input-text"
        value={text}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        rows={1}
        disabled={!connected}
        aria-label="Chat message"
      />
      <button
        type="button"
        className="btn primary chat-input-send"
        onClick={() => doSend()}
        disabled={!connected || text.trim().length === 0}
        title="Send"
        aria-label="Send"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M22 2L11 13" />
          <path d="M22 2L15 22L11 13L2 9L22 2Z" />
        </svg>
      </button>
    </div>
  );
}

// Helpers live in `chat-send-client.ts` so this component stays free of
// the `api.ts` → `window.rcpp` module-load coupling and can be unit-
// tested with `react-test-renderer` under a Node vitest environment.
// Import them directly from `./chat-send-client` in App.tsx / future
// callers — do NOT re-export here.
