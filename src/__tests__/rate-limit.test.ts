import { describe, it, expect } from 'vitest';
import { RateLimiter } from '../renderer/tts';

describe('RateLimiter', () => {
  it('allows up to max-per-minute consumes', () => {
    const now = 1_000_000;
    const lim = new RateLimiter(3, () => now);
    expect(lim.tryConsume()).toBe(true);
    expect(lim.tryConsume()).toBe(true);
    expect(lim.tryConsume()).toBe(true);
    expect(lim.tryConsume()).toBe(false);
  });

  it('expires old tokens after 60 seconds', () => {
    let now = 1_000_000;
    const lim = new RateLimiter(2, () => now);
    expect(lim.tryConsume()).toBe(true);
    expect(lim.tryConsume()).toBe(true);
    expect(lim.tryConsume()).toBe(false);
    now += 61_000;
    expect(lim.tryConsume()).toBe(true);
  });
});
