import type { ChatSendStatus } from '../shared/types';

/**
 * v0.1.63 — user-facing copy for send failures.
 *
 * Keep this in one pure module because the same failure can surface in two
 * places: the inline ⚠ tooltip next to the failed placeholder, and the
 * top-of-app send notice. If those strings drift, Ethan sees conflicting
 * guidance for the same broken send.
 */

export const SEND_LOGIN_REQUIRED_TEXT =
  'Restream sending needs a separate website login. Receiving chat is unaffected.';

export const SEND_TIMEOUT_NOTICE_TEXT =
  'Send not confirmed. Check your chat before retrying to avoid duplicates.';

export const SEND_TIMEOUT_TOOLTIP_TEXT =
  'Send not confirmed. Check your chat before retrying.';

/** Missing website cookies do not prove OAuth expired or that any other destination failed. */
export function needsRestreamSendLogin(status: ChatSendStatus): boolean {
  return status.reason === 'no-session-cookies' || status.destinations?.some(
    (result) => result.destination === 'restream' && !result.ok && result.reason === 'no-session-cookies',
  ) === true;
}

/**
 * Tooltip copy is attached to the failed message itself. It can be more
 * specific than the toast/banner because the user may hover it later while
 * investigating a single failed placeholder in the feed.
 */
export function formatSendFailureTooltip(status: ChatSendStatus): string {
  if (needsRestreamSendLogin(status)) {
    return `${status.error ? `${status.error} ` : ''}${SEND_LOGIN_REQUIRED_TEXT}`;
  }
  if (status.error) return status.error;
  if (status.reason === 'timeout') {
    return SEND_TIMEOUT_TOOLTIP_TEXT;
  }
  if (status.reason) {
    const httpSuffix = status.httpStatus ? ` HTTP ${status.httpStatus}` : '';
    return `Send failed (${status.reason}${httpSuffix})`;
  }
  return 'Send failed.';
}

/**
 * Notice copy is intentionally limited to failures where a red inline icon is
 * not enough. Cookie loss and timeout both imply "something outside this one
 * message is wrong", so they deserve a visible app-level nudge.
 */
export function sendFailureNoticeText(status: ChatSendStatus): string | undefined {
  if (needsRestreamSendLogin(status)) return formatSendFailureTooltip(status);
  if (
    status.reason === 'destination-send-failed' ||
    status.reason === 'provider-authorization-required'
  ) {
    return status.error ?? 'One or more chat destinations failed.';
  }
  if (status.reason === 'timeout') {
    return SEND_TIMEOUT_NOTICE_TEXT;
  }
  return undefined;
}
