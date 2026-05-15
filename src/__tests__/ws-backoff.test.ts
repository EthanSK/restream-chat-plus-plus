import { describe, it, expect } from 'vitest';
import { __test_backoff_for } from '../main/ws-client';

describe('ChatClient backoff', () => {
  it('grows exponentially with attempt count', () => {
    expect(__test_backoff_for(1)).toBe(1_000);
    expect(__test_backoff_for(2)).toBe(2_000);
    expect(__test_backoff_for(3)).toBe(4_000);
    expect(__test_backoff_for(4)).toBe(8_000);
  });

  it('caps at 60 seconds', () => {
    expect(__test_backoff_for(20)).toBe(60_000);
    expect(__test_backoff_for(100)).toBe(60_000);
  });
});
