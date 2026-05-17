/**
 * Pure renderer-side helpers for chat-feed actions (clear, etc.).
 *
 * Keeping the logic in a DOM-free module makes it unit-testable under
 * `environment: node` (no jsdom) and prevents the reducers from drifting
 * from the test fixtures. v0.1.18.
 */

import type { ChatMessage } from '../shared/types';

/**
 * Reset the chat-message buffer. Returns a fresh empty array (does NOT
 * mutate `prev`) so React's setState picks up the change and the
 * virtualised feed re-renders into the empty state.
 *
 * This only clears the local renderer buffer — it never deletes anything
 * Restream-side and never reaches over the WebSocket. New chat frames
 * pushed by Restream after the clear continue to populate the feed
 * normally.
 *
 * The `prev` parameter is accepted for API symmetry with React's
 * `setMessages((prev) => clearChatMessages(prev))` call shape; ignoring it
 * is intentional.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function clearChatMessages(_prev: ChatMessage[]): ChatMessage[] {
  return [];
}
