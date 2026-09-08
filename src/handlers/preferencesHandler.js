'use strict';

const { FREQUENCIES } = require('../services/digestScheduler');
const { publishHome } = require('./homeHandler');

/**
 * Home tab: "🔔 Notifications" select → store the user's digest frequency.
 * Switching back to 'immediate' flushes anything already queued.
 */
function registerPreferencesHandler(app, services) {
  app.action('home_set_digest', async ({ ack, body, client, logger }) => {
    await ack();
    const userId = body.user.id;
    const frequency = body.actions?.[0]?.selected_option?.value;
    if (!FREQUENCIES[frequency]) return;
    if (!services.db) {
      await client.chat.postMessage({ channel: userId, text: '⚠️ Preferences need Supabase, which is not configured.' }).catch(() => {});
      return;
    }

    // Time zone from the Slack profile, so daily/twice-daily land at 09:00 *their* time
    let tz = null;
    try {
      const info = await client.users.info({ user: userId });
      tz = info.user?.tz || null;
    } catch (err) {
      logger.warn(`[prefs] users.info failed for ${userId}: ${err.data?.error || err.message}`);
    }

    try {
      await services.db.upsertUserPreference(userId, { digest_frequency: frequency, ...(tz ? { tz } : {}) });
      logger.info(`[prefs] ${userId} → ${frequency}${tz ? ` (${tz})` : ''}`);

      let flushed = 0;
      if (frequency === 'immediate' && services.digestScheduler) {
        flushed = await services.digestScheduler.deliverTo(userId, null);
      }

      await publishHome(client, userId, services, logger);
      const note = frequency === 'immediate'
        ? `🔔 You'll now get questions *immediately*.${flushed ? ` Sent ${flushed} that were waiting.` : ''}`
        : `🔔 You'll now get questions as a *${FREQUENCIES[frequency].label.toLowerCase()}* digest${tz ? ` (${tz})` : ''}. Anything new is held until then.`;
      await client.chat.postMessage({ channel: userId, text: note }).catch(() => {});
    } catch (err) {
      const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      logger.error(`[prefs] Failed to save preference for ${userId}: ${detail}`);
      await client.chat.postMessage({ channel: userId, text: `❌ Couldn't save your notification preference: ${detail}` }).catch(() => {});
    }
  });
}

module.exports = { registerPreferencesHandler };
