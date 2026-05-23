import type { ChatMessage, ChatSendStatus } from '../shared/types';
import { applyFailedSendStatus } from './chat-message-reducers';
import { SEND_TIMEOUT_TOOLTIP_TEXT } from './send-failure-copy';

/**
 * v0.1.63 — second-line guard for optimistic sends.
 *
 * Primary correctness still lives in the main process: startup cookie repair
 * should make `sendChatText` either POST successfully or emit an explicit
 * `failed` status. This timeout exists because a future silent-bail bug must
 * never leave the renderer showing `pendingSend: "sending"` forever.
 */
export const OPTIMISTIC_SEND_TIMEOUT_MS = 15_000;

export function optimisticSendTimeoutStatus(clientId: string): ChatSendStatus {
  return {
    clientId,
    status: 'failed',
    reason: 'timeout',
    error: SEND_TIMEOUT_TOOLTIP_TEXT,
  };
}

export function applyOptimisticSendTimeout(
  prev: ChatMessage[],
  clientId: string,
): ChatMessage[] {
  return applyFailedSendStatus(prev, optimisticSendTimeoutStatus(clientId));
}
