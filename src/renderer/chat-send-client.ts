import { rcpp } from './api';

/**
 * v0.1.43 — helpers shared between `ChatInputInline` (renderer-side) and
 * `App.tsx` (which orchestrates the optimistic placeholder + enqueue
 * IPC flow). Kept in their own module so `ChatInputInline` can be unit
 * tested without dragging the `api.ts` window-coupling at module-load
 * time.
 *
 * Contract:
 *   - `mintChatClientId()` returns a UUID-shaped string that's used as
 *     BOTH the optimistic `ChatMessage.id` AND the Restream
 *     `clientReplyUuid`. When the WS rebroadcasts the matching
 *     `reply_created` echo, the renderer dedupes the placeholder by
 *     matching ids — so the user sees their message exactly once.
 *   - `dispatchEnqueueChatSend(text, clientId)` ships the IPC payload
 *     down to the main-process queue (fire-and-forget). The renderer
 *     never awaits the result; status arrives via `onChatSendStatus`.
 */

export function mintChatClientId(
  rng: () => string = () => {
    try {
      const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
      if (c?.randomUUID) return c.randomUUID();
    } catch {
      // ignore
    }
    return `local-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  },
): string {
  return rng();
}

export function dispatchEnqueueChatSend(text: string, clientId: string): void {
  rcpp.enqueueChatSend({ clientId, text });
}
