'use strict';

/**
 * A simple in-memory deduplication cache with per-entry TTL.
 *
 * Purpose: Slack may deliver the same event more than once (at-least-once
 * delivery guarantee). This cache prevents the bot from triggering the same
 * Jira update twice within a short window.
 *
 * Key format: "<trigger>:<channel>:<messageTs>:<issueKey>"
 */
class DedupCache {
  /**
   * @param {number} ttlMs  How long to remember a processed event (default 5 min)
   */
  constructor(ttlMs = 5 * 60 * 1000) {
    this.ttlMs = ttlMs;
    this.cache = new Map();
  }

  /**
   * Returns true if this key was already seen within the TTL window.
   * Marks it as seen if not.
   * @param {string} key
   * @returns {boolean}
   */
  isDuplicate(key) {
    if (this.cache.has(key)) return true;
    const timer = setTimeout(() => this.cache.delete(key), this.ttlMs);
    // Allow the process to exit even if entries are pending
    if (timer.unref) timer.unref();
    this.cache.set(key, timer);
    return false;
  }
}

module.exports = DedupCache;
