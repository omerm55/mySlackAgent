'use strict';

const RateLimiter = require('../src/utils/rateLimiter');

describe('RateLimiter', () => {
  test('allows requests up to the limit', () => {
    const rl = new RateLimiter();
    expect(rl.isAllowed('integration-a', 3)).toBe(true);
    expect(rl.isAllowed('integration-a', 3)).toBe(true);
    expect(rl.isAllowed('integration-a', 3)).toBe(true);
    expect(rl.isAllowed('integration-a', 3)).toBe(false); // 4th is over limit
  });

  test('different keys are tracked independently', () => {
    const rl = new RateLimiter();
    rl.isAllowed('a', 1);
    expect(rl.isAllowed('a', 1)).toBe(false);
    expect(rl.isAllowed('b', 1)).toBe(true); // b is unaffected
  });

  test('remaining() reflects the current count', () => {
    const rl = new RateLimiter();
    expect(rl.remaining('x', 5)).toBe(5);
    rl.isAllowed('x', 5);
    rl.isAllowed('x', 5);
    expect(rl.remaining('x', 5)).toBe(3);
  });

  test('window resets after the hour elapses', () => {
    const rl = new RateLimiter();
    // Manually backdate the window start by more than 1 hour
    rl.isAllowed('y', 1);
    const entry = rl.windows.get('y');
    entry.windowStart = Date.now() - (60 * 60 * 1000 + 1);

    expect(rl.isAllowed('y', 1)).toBe(true); // new window
  });
});
