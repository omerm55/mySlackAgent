'use strict';

const YES = new Set(['yes', 'y']);
const NO = new Set(['no', 'n']);

/**
 * @param {import('@slack/bolt').App} app
 * @param {import('../services/jiraService')} jiraService
 * @param {object} services
 * @param {import('../services/pendingQuestions')} services.pendingQuestions
 * @param {import('../services/oauthService')} [services.oauthService]
 */
function registerDmHandler(app, jiraService, services) {
  app.message(async ({ message, client, logger }) => {
    try {
      if (message.channel_type !== 'im') return;
      if (message.bot_id) return;

      const { pendingQuestions } = services;
      let parentTs = null;
      let context = null;

      // Threaded reply: use thread_ts as the key
      if (message.thread_ts && message.thread_ts !== message.ts) {
        parentTs = message.thread_ts;
        context = pendingQuestions.get(message.channel, parentTs);
      }

      // Non-threaded reply: look up the most recent question in this DM channel
      if (!context) {
        const last = pendingQuestions.getLastForChannel(message.channel);
        if (last) {
          parentTs = last.ts;
          context = last.context;
        }
      }

      if (!context) return;

      const reply = (message.text || '').trim().toLowerCase();

      if (!YES.has(reply) && !NO.has(reply)) {
        await client.chat.postMessage({
          channel: message.channel,
          thread_ts: parentTs,
          text: 'Please reply *Yes* or *No*.',
        });
        return;
      }

      pendingQuestions.delete(message.channel, parentTs);

      if (NO.has(reply)) {
        await client.chat.postMessage({
          channel: message.channel,
          thread_ts: parentTs,
          text: 'OK, no changes made.',
        });
        return;
      }

      // Yes — resolve OAuth or fall back to service account
      let effectiveJira = jiraService;
      const { oauthService } = services;
      const slackUserId = context.slackUserId;
      if (oauthService) {
        if (oauthService.hasToken(slackUserId)) {
          try {
            effectiveJira = await oauthService.getJiraService(slackUserId);
          } catch {
            effectiveJira = jiraService;
          }
        }
      }

      const { issueKey, jiraFieldId, jiraFieldValue, jiraFieldType } = context;
      try {
        await effectiveJira.updateIssueField(issueKey, jiraFieldId, jiraFieldValue, jiraFieldType || 'select');
        logger.info(`[dm] Updated ${issueKey} field ${jiraFieldId}=${jiraFieldValue} ✓`);
        await client.chat.postMessage({
          channel: message.channel,
          thread_ts: parentTs,
          text: `✅ Done — *${issueKey}* updated.`,
        });
      } catch (err) {
        logger.error(`[dm] Failed to update ${issueKey}: ${err.message}`);
        await client.chat.postMessage({
          channel: message.channel,
          thread_ts: parentTs,
          text: `❌ Failed to update *${issueKey}*: ${err.message}`,
        });
      }
    } catch (err) {
      logger.error(`[dm] Unexpected error: ${err.message}`);
    }
  });
}

module.exports = { registerDmHandler };
