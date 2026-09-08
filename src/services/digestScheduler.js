'use strict';

const { sendDmQuestion } = require('../utils/dmQuestion');

/**
 * Digest frequencies a user can choose. Delivery slots are in the user's own
 * Slack time zone; 'immediate' is the default and bypasses this scheduler.
 */
const FREQUENCIES = {
  immediate:   { label: 'Immediately', hours: null },
  hourly:      { label: 'Hourly', hours: 'every' },
  twice_daily: { label: 'Twice a day (09:00 & 15:00)', hours: [9, 15] },
  daily:       { label: 'Once a day (09:00)', hours: [9] },
};
const DEFAULT_TZ = 'UTC';

// ── time-zone helpers (no dependencies) ───────────────────────────────────

/** Wall-clock parts of `date` in IANA zone `tz`. */
function localParts(date, tz) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const p = Object.fromEntries(fmt.formatToParts(date).filter((x) => x.type !== 'literal').map((x) => [x.type, parseInt(x.value, 10)]));
  return { y: p.year, m: p.month, d: p.day, hour: p.hour, minute: p.minute };
}

/** UTC instant for wall-clock (y, m, d, hour) in `tz`. */
function zonedTimeToUtc(y, m, d, hour, tz) {
  const guess = Date.UTC(y, m - 1, d, hour);
  const lp = localParts(new Date(guess), tz);
  const asIfUtc = Date.UTC(lp.y, lp.m - 1, lp.d, lp.hour, lp.minute);
  return new Date(guess - (asIfUtc - guess));
}

function safeTz(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch { return DEFAULT_TZ; }
}

/**
 * Start of the most recent delivery slot for `frequency` at or before `now`.
 *   hourly      → top of the current hour
 *   daily       → today 09:00 local, or yesterday 09:00 if it's before 09:00
 *   twice_daily → the latest of today 09:00 / 15:00 not in the future, else yesterday 15:00
 * @returns {Date|null}  null for 'immediate' / unknown frequency
 */
function currentSlotStart(now, frequency, tz) {
  const spec = FREQUENCIES[frequency];
  if (!spec || !spec.hours) return null;
  if (spec.hours === 'every') {
    const t = new Date(now); t.setUTCMinutes(0, 0, 0); return t;
  }
  const zone = safeTz(tz);
  const lp = localParts(now, zone);
  const todays = spec.hours.map((h) => zonedTimeToUtc(lp.y, lp.m, lp.d, h, zone)).filter((t) => t <= now);
  if (todays.length) return todays[todays.length - 1];
  // Before the first slot today → last slot of yesterday
  const y = new Date(Date.UTC(lp.y, lp.m - 1, lp.d) - 24 * 3600 * 1000);
  const yp = localParts(y, zone);
  return zonedTimeToUtc(yp.y, yp.m, yp.d, spec.hours[spec.hours.length - 1], zone);
}

/** A digest is due when a slot has started since the last one we sent. */
function isDigestDue(pref, now = new Date()) {
  const slot = currentSlotStart(now, pref.digest_frequency, pref.tz);
  if (!slot) return false;
  if (!pref.last_digest_at) return true;
  return new Date(pref.last_digest_at) < slot;
}

// ── scheduler ─────────────────────────────────────────────────────────────

/**
 * Delivers queued prompts to users who chose a digest frequency.
 * Runs every tick (default 60s); for each digest user whose slot has come
 * and who has pending prompts, posts a short header then each prompt as its
 * own Yes / No / Reply message (so the existing button handlers work as-is).
 */
class DigestScheduler {
  constructor({ db, slackClient, opsNotifier = null, oauthService = null, logger, intervalMs = 60_000 }) {
    this.db = db;
    this.slack = slackClient;
    this.ops = opsNotifier;
    this.oauth = oauthService;
    this.logger = logger;
    this.intervalMs = intervalMs;
    this._timer = null;
    this._running = false;
  }

  start() {
    if (!this.db) return;
    this.logger.info(`[digest] Started, checking every ${Math.round(this.intervalMs / 1000)}s`);
    this._timer = setInterval(() => this.runOnce().catch((e) => this.logger.error(`[digest] tick failed: ${e.message}`)), this.intervalMs);
    this._timer.unref?.();
  }

  stop() { if (this._timer) clearInterval(this._timer); }

  /** Evaluate all digest users; deliver to those who are due. */
  async runOnce(now = new Date()) {
    if (this._running) return [];
    this._running = true;
    const delivered = [];
    try {
      const users = await this.db.getDigestUsers();
      for (const pref of users) {
        if (!isDigestDue(pref, now)) continue;
        const n = await this.deliverTo(pref.slack_user_id, pref);
        delivered.push({ slackUserId: pref.slack_user_id, count: n });
      }
    } finally {
      this._running = false;
    }
    return delivered;
  }

  /**
   * Send everything queued for one user now (used by the scheduler when a
   * slot is due, and when a user switches back to 'immediate').
   * @returns {Promise<number>} prompts delivered
   */
  async deliverTo(slackUserId, pref = null) {
    const pending = await this.db.getPendingPrompts(slackUserId);
    if (pending.length === 0) {
      if (pref) await this.db.upsertUserPreference(slackUserId, { last_digest_at: new Date().toISOString() }).catch(() => {});
      return 0;
    }

    const freq = pref?.digest_frequency || 'immediate';
    const label = { hourly: 'hourly', twice_daily: 'twice-daily', daily: 'daily' }[freq] || '';
    const header = label
      ? `🔔 *Your ${label} digest* — ${pending.length} item${pending.length === 1 ? '' : 's'} waiting for you:`
      : `🔔 ${pending.length} item${pending.length === 1 ? '' : 's'} waiting for you:`;
    await this.slack.chat.postMessage({ channel: slackUserId, text: header }).catch((e) =>
      this.logger.warn(`[digest] header DM failed for ${slackUserId}: ${e.data?.error || e.message}`));

    const authUrl = this.oauth && !this.oauth.hasToken(slackUserId) ? this.oauth.generateAuthUrl(slackUserId) : null;
    const deliveredIds = [];
    for (const row of pending) {
      const context = { ...(row.payload || {}), issueKey: row.issue_key, ...(authUrl ? { authUrl } : {}) };
      if (!context.question) context.question = `Approve ${row.issue_key}?`;
      try {
        await sendDmQuestion(this.slack, slackUserId, context, null, this.ops);
        deliveredIds.push(row.id);
      } catch (err) {
        this.logger.error(`[digest] Failed to DM ${slackUserId} for ${row.issue_key}: ${err.message}`);
      }
    }
    if (deliveredIds.length) await this.db.markPromptsDelivered(deliveredIds);
    if (pref) await this.db.upsertUserPreference(slackUserId, { last_digest_at: new Date().toISOString() }).catch(() => {});
    this.logger.info(`[digest] Delivered ${deliveredIds.length}/${pending.length} to ${slackUserId} (${freq})`);
    await this.ops?.post?.(`🔔 Digest (${freq}) delivered to <@${slackUserId}>: ${deliveredIds.length} item(s)`);
    return deliveredIds.length;
  }
}

module.exports = { DigestScheduler, FREQUENCIES, localParts, zonedTimeToUtc, currentSlotStart, isDigestDue };
