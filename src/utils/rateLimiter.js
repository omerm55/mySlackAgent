'use strict';

/**
 * Simple sliding-window rate limiter.
 * Tracks how many times each key has been used within the current hour window.
 */
class RateLimiter {
  constructor() {
    this.windows = new Map(); // key -> { count, windowStart }
  }

  /**
   * Returns true if the action is allowed, false if the rate limit is exceeded.
   * @param {string} key         e.g. integration name
   * @param {number} maxPerHour
   * @returns {boolean}
   */
  isAllowed(key, maxPerHour) {
    const now = Date.now();
    const windowMs = 60 * 60 * 1000;
    const entry = this.windows.get(key);

    if (!entry || now - entry.windowStart >= windowMs) {
      this.windows.set(key, { count: 1, windowStart: now });
      return true;
    }
    if (entry.count >= maxPerHour) {
      return false;
    }
    entry.count++;
    return true;
  }

  /**
   * Returns how many actions remain in the current window.
   * @param {string} key
   * @param {number} maxPerHour
   * @returns {number}
   */
  remaining(key, maxPerHour) {
    const entry = this.windows.get(key);
    if (!entry) return maxPerHour;
    const windowMs = 60 * 60 * 1000;
    if (Date.now() - entry.windowStart >= windowMs) return maxPerHour;
    return Math.max(0, maxPerHour - entry.count);
  }
}

module.exports = RateLimiter;
