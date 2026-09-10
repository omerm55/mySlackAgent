'use strict';

const MAX_MESSAGE_LENGTH = 3800; // Slack's limit is ~4000 chars; leave headroom

/**
 * In-memory audit log for all triggered Jira updates.
 *
 * Entries accumulate throughout the day. At the configured UTC hour a daily
 * summary is posted to the ops channel and the log is cleared.
 *
 * Note: the log is in-memory only. A process restart clears it. This is
 * acceptable for a daily summary; the persistent record is the Jira comment
 * posted on each issue at the time of the update.
 */
class AuditLog {
  /** @param {{ db?: import('../services/supabaseService') }} [opts] */
  constructor({ db = null } = {}) {
    this.entries = [];
    this.db = db;
    this._summaryTimer = null;
  }

  /** Attach the persistent store after construction (index.js wires Supabase later). */
  setDb(db) { this.db = db; }

  /**
   * Last `limit` entries for a user, newest first — from Supabase when available
   * (survives restarts), else from memory.
   */
  async recentFor(slackUserId, limit = 5) {
    if (this.db?.getRecentActivity) {
      try { return await this.db.getRecentActivity(slackUserId, limit); } catch { /* fall back */ }
    }
    return this.entries.filter((e) => e.slackUserId === slackUserId).slice(-limit).reverse();
  }

  /**
   * Record a triggered event.
   * @param {object} entry
   * @param {number} entry.ts               Unix ms timestamp
   * @param {string} entry.integrationName
   * @param {string} entry.trigger          '👍 reaction' | 'thread reply'
   * @param {string} entry.slackUserId
   * @param {string} entry.slackUserName    Display name (resolved by caller)
   * @param {string} entry.issueKey
   * @param {string} entry.fieldName
   * @param {string} entry.fieldValue
   * @param {boolean} entry.success
   * @param {string} [entry.error]
   */
  addEntry(entry) {
    this.entries.push(entry);
    // Persist for the App Home history; never let a DB hiccup affect the caller.
    if (this.db?.insertActivity && entry.slackUserId && entry.issueKey) {
      this.db.insertActivity(entry).catch(() => {});
    }
  }

  /**
   * Schedule the daily summary to post at `utcHour` every day.
   * @param {object} client      Bolt's Slack WebClient (app.client)
   * @param {string} channelId
   * @param {number} utcHour     0–23
   * @param {object} logger
   */
  scheduleDailySummary(client, channelId, utcHour, logger) {
    const scheduleNext = () => {
      const now = new Date();
      const next = new Date();
      next.setUTCHours(utcHour, 0, 0, 0);
      if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
      const delay = next - now;

      logger.info(`Daily summary scheduled in ${Math.round(delay / 60000)} minutes (at ${next.toUTCString()})`);

      this._summaryTimer = setTimeout(async () => {
        try {
          await this.postDailySummary(client, channelId);
        } catch (err) {
          logger.error(`Failed to post daily summary: ${err.message}`);
        }
        scheduleNext();
      }, delay);

      if (this._summaryTimer.unref) this._summaryTimer.unref();
    };

    scheduleNext();
  }

  /**
   * Immediately post the daily summary and clear the log.
   * Exposed publicly so it can be triggered manually or in tests.
   * @param {object} client
   * @param {string} channelId
   */
  async postDailySummary(client, channelId) {
    const entries = this.entries.splice(0);
    const text = this._formatSummary(entries);
    await client.chat.postMessage({ channel: channelId, text });
  }

  _formatSummary(entries) {
    const date = new Date().toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC',
    });

    if (entries.length === 0) {
      return `📊 *Daily Jira Update Summary — ${date}*\n\nNo updates were triggered today.`;
    }

    const successes = entries.filter((e) => e.success);
    const failures = entries.filter((e) => !e.success);

    let text =
      `📊 *Daily Jira Update Summary — ${date}*\n` +
      `*${successes.length}* update(s) succeeded` +
      (failures.length > 0 ? ` · *${failures.length}* failed` : '') +
      '\n\n';

    // Group by integration
    const byIntegration = new Map();
    for (const entry of entries) {
      if (!byIntegration.has(entry.integrationName)) byIntegration.set(entry.integrationName, []);
      byIntegration.get(entry.integrationName).push(entry);
    }

    for (const [name, events] of byIntegration) {
      text += `*${name}*\n`;
      for (const e of events) {
        const time = new Date(e.ts).toLocaleTimeString('en-US', {
          hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
        });
        if (e.success) {
          text += `✅  ${time}  ·  *${e.issueKey}*  ·  ${e.fieldName} = ${e.fieldValue}  ·  ${e.trigger} by ${e.slackUserName}\n`;
        } else {
          text += `❌  ${time}  ·  *${e.issueKey}*  ·  ${e.error}  ·  ${e.trigger} by ${e.slackUserName}\n`;
        }
      }
      text += '\n';
    }

    if (text.length > MAX_MESSAGE_LENGTH) {
      text = text.slice(0, MAX_MESSAGE_LENGTH) + '\n_…truncated — see application logs for the full record._';
    }

    return text;
  }
}

module.exports = AuditLog;
