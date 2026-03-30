'use strict';

/**
 * Tracks error rates per integration and posts alerts to the ops channel
 * when a threshold is exceeded within a rolling time window.
 *
 * Also handles rate-limit notifications.
 */
class Alerting {
  /**
   * @param {object} opts
   * @param {object} opts.client           Bolt's Slack WebClient (app.client)
   * @param {string} opts.channelId        Ops channel to post alerts to
   * @param {number} opts.errorThreshold   Number of errors before alerting
   * @param {number} opts.errorWindowMs    Rolling window duration in ms
   */
  constructor({ client, channelId, errorThreshold, errorWindowMs }) {
    this.client = client;
    this.channelId = channelId;
    this.errorThreshold = errorThreshold;
    this.errorWindowMs = errorWindowMs;
    this.errorLog = new Map(); // integrationName -> [{ ts, message }]
  }

  /**
   * Record a Jira update error. Posts an alert if the threshold is exceeded.
   * @param {string} integrationName
   * @param {string} errorMessage
   * @param {object} logger
   */
  async recordError(integrationName, errorMessage, logger) {
    const now = Date.now();
    if (!this.errorLog.has(integrationName)) this.errorLog.set(integrationName, []);

    const errors = this.errorLog.get(integrationName);
    errors.push({ ts: now, message: errorMessage });

    // Prune entries outside the rolling window
    const recent = errors.filter((e) => now - e.ts <= this.errorWindowMs);
    this.errorLog.set(integrationName, recent);

    if (recent.length >= this.errorThreshold) {
      // Reset so the next burst triggers a fresh alert rather than flooding
      this.errorLog.set(integrationName, []);
      await this._post(
        `⚠️ *Alert — ${integrationName}*\n` +
        `${recent.length} errors in the last ${Math.round(this.errorWindowMs / 60000)} minutes.\n` +
        `Last error: \`${recent[recent.length - 1].message}\``,
        logger
      );
    }
  }

  /**
   * Post a notification when an integration's rate limit is hit.
   * @param {string} integrationName
   * @param {number} limitPerHour
   * @param {object} logger
   */
  async recordRateLimit(integrationName, limitPerHour, logger) {
    await this._post(
      `⚠️ *Rate limit reached — ${integrationName}*\n` +
      `This integration has exceeded ${limitPerHour} updates/hour. Subsequent events will be dropped until the window resets.`,
      logger
    );
  }

  async _post(text, logger) {
    try {
      await this.client.chat.postMessage({ channel: this.channelId, text });
    } catch (err) {
      logger?.error(`Failed to post ops alert: ${err.message}`);
    }
  }
}

module.exports = Alerting;
