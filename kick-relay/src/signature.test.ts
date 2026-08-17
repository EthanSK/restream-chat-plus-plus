import { describe, expect, it } from 'vitest';
import { verifyKickSignature } from './signature';

describe('verifyKickSignature', () => {
  it('rejects a forged webhook signature', async () => {
    await expect(
      verifyKickSignature('message-id', '2026-08-14T12:00:00Z', '{}', 'ZmFrZQ=='),
    ).resolves.toBe(false);
  });
});
