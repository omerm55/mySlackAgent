'use strict';

/**
 * Caches Slack user display names to avoid repeated API calls.
 * Names are cached for the lifetime of the process.
 */
class UserCache {
  constructor() {
    this.cache = new Map(); // userId -> displayName
  }

  /**
   * Returns the display name for a Slack user, fetching it if not cached.
   * Falls back to the raw user ID if the lookup fails.
   * @param {object} client  Bolt's Slack WebClient
   * @param {string} userId
   * @returns {Promise<string>}
   */
  async getName(client, userId) {
    if (this.cache.has(userId)) return this.cache.get(userId);
    try {
      const result = await client.users.info({ user: userId });
      const profile = result.user?.profile;
      const name = profile?.real_name || profile?.display_name || userId;
      if (name === userId) {
        console.warn(`[userCache] users.info returned no display name for ${userId}`);
      }
      this.cache.set(userId, name);
      return name;
    } catch (err) {
      console.warn(`[userCache] users.info failed for ${userId}: ${err.message} — check users:read scope`);
      return userId;
    }
  }
}

module.exports = UserCache;
