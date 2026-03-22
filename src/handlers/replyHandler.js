'use strict';

const { extractJiraIssueKeys } = require('../utils/jiraLinkParser');

/**
 * @param {import('@slack/bolt').App} app
 * @param {import('../services/jiraService')} jiraService
 * @param {import('../services/attributionService')} attributionService
 * @param {object} config
 * @param {string} config.name
 * @param {string} config.watchChannelId
 * @param {string} config.jiraFieldId
 * @param {string} config.jiraFieldValue
 * @param {string} [config.jiraFieldType]
 * @param {import('../utils/dedupCache')} dedupCache
 */
function registerReplyHandler(app, jiraService, attributionService, config, dedupCache) {
  const { name, watchChannelId, jiraFieldId, jiraFieldValue, jiraFieldType = 'select' } = config;
  const tag = `[${name}/reply]`;

  app.message(async ({ message, client, logger }) => {
    try {
      if (message.channel !== watchChannelId) return;
      if (!message.thread_ts || message.thread_ts === message.ts) return;

      const dedupKey = `reply:${watchChannelId}:${message.thread_ts}:${message.ts}`;
      if (dedupCache.isDuplicate(dedupKey)) {
        logger.info(`${tag} Skipping duplicate event for thread ${message.thread_ts}`);
        return;
      }

      const result = await client.conversations.replies({
        channel: message.channel,
        ts: message.thread_ts,
        limit: 1,
        inclusive: true,
      });

      const rootMessage = result.messages && result.messages[0];
      if (!rootMessage) return;

      const issueKeys = extractJiraIssueKeys(rootMessage.text);
      if (issueKeys.length === 0) return;

      logger.info(`${tag} Reply in thread ${message.thread_ts} → updating issue(s): ${issueKeys.join(', ')}`);

      await Promise.all(
        issueKeys.map(async (key) => {
          try {
            await jiraService.updateIssueField(key, jiraFieldId, jiraFieldValue, jiraFieldType);
            logger.info(`${tag} Updated ${key} ✓`);
            await attributionService.postAttributionComment(
              client, message.user, key, jiraFieldId, jiraFieldValue, 'thread reply', name
            );
          } catch (err) {
            logger.error(`${tag} Failed to update ${key}: ${err.message}`);
          }
        })
      );
    } catch (err) {
      logger.error(`${tag} Unexpected error: ${err.message}`);
    }
  });
}

module.exports = { registerReplyHandler };
