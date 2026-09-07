import { describe, expect, it } from 'vitest';
import assert from 'node:assert/strict';
import { formatSendFailureTooltip, needsRestreamSendLogin, sendFailureNoticeText } from '../renderer/send-failure-copy';
import type { ChatSendStatus } from '../shared/types';

describe('sending-login failure copy', () => {
  it('preserves partial success and explains missing website login without claiming OAuth expired', () => {
    const status: ChatSendStatus = {
      clientId: 'partial', status: 'failed', reason: 'destination-send-failed',
      error: 'Sent to Twitch, Kick. Restream failed.',
      destinations: [
        { destination: 'restream', ok: false, reason: 'no-session-cookies' },
        { destination: 'twitch', ok: true },
        { destination: 'kick', ok: true },
      ],
    };
    expect(needsRestreamSendLogin(status)).toBe(true);
    const notice = sendFailureNoticeText(status);
    assert(notice);
    expect(notice).toContain('Sent to Twitch, Kick.');
    expect(notice).toContain('separate website login');
    expect(notice).not.toMatch(/expired|revoked|sign out/i);
    expect(formatSendFailureTooltip(status)).toBe(notice);
  });

  it('also recognizes preflight failure before fan-out and while the queue retries', () => {
    expect(needsRestreamSendLogin({ clientId: 'direct', status: 'failed', reason: 'no-session-cookies' })).toBe(true);
    expect(needsRestreamSendLogin({ clientId: 'retry', status: 'retrying', destinations: [{ destination: 'restream', ok: false, reason: 'no-session-cookies' }] })).toBe(true);
  });

  it('does not offer website login for network errors or a successful Restream destination', () => {
    expect(needsRestreamSendLogin({ clientId: 'network', status: 'failed', reason: 'error' })).toBe(false);
    expect(needsRestreamSendLogin({ clientId: 'sent', status: 'failed', destinations: [{ destination: 'restream', ok: true }] })).toBe(false);
  });

  it('describes timeout as unconfirmed delivery, not a proven broken connection', () => {
    const status: ChatSendStatus = { clientId: 'slow', status: 'failed', reason: 'timeout' };
    expect(sendFailureNoticeText(status)).toContain('not confirmed');
    expect(sendFailureNoticeText(status)).toContain('avoid duplicates');
    expect(formatSendFailureTooltip(status)).not.toMatch(/sign in|connection|expired/);
  });
});
