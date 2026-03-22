'use strict';

const { extractJiraIssueKeys } = require('../utils/jiraLinkParser');

const THUMBS_UP_EMOJIS = new Set(['+1', 'thumbsup', 'thumbs_up']);

/**
 * @param {import('@slack/bolt').App} app
 * @param {import('../services/jiraService')} jiraService
 * @param {object} config
 * @param {string} config.name           Integration name (for logging)
 * @param {string} config.watchChannelId
 * @param {string} config.jiraFieldId
 * @param {string} config.jiraFieldValue
 * @param {string} [config.jiraFieldType]
 * @param {import('../utils/dedupCache')} dedupCache
 */
function registerReactionHandler(app, jiraService, config, dedupCache) {
  const { name, watchChannelId, jiraFieldId, jiraFieldValue, jiraFieldType = 'select' } = config;
  const tag = `[${name}/reaction]`;

  app.event('reaction_added', async ({ event, client, logger }) => {
    try {
      if (!THUMBS_UP_EMOJIS.has(event.reaction)) return;
      if (event.item.type !== 'message') return;
      if (event.item.channel !== watchChannelId) return;

      const dedupKey = `reaction:${watchChannelId}:${event.item.ts}:${event.user}`;
      if (dedupCache.isDuplicate(dedupKey)) {
        logger.info(`${tag} Skipping duplicate reaction event on ${event.item.ts}`);
        return;
      }

      const result = await client.conversations.history({
        channel: event.item.channel,
        latest: event.item.ts,
        limit: 1,
        inclusive: true,
      });

      const message = result.messages && result.messages[0];
      if (!message) return;

      const issueKeys = extractJiraIssueKeys(message.text);
      if (issueKeys.length === 0) return;

      logger.info(`${tag} 👍 on message ${event.item.ts} → updating issue(s): ${issueKeys.join(', ')}`);

      await Promise.all(
        issueKeys.map((key) =>
          jiraService
            .updateIssueField(key, jiraFieldId, jiraFieldValue, jiraFieldType)
            .then(() => logger.info(`${tag} Updated ${key} ✓`))
            .catch((err) => {
              logger.error(`${tag} Failed to update ${key}: ${err.message}`);
            })
        )
      );
    } catch (err) {
      logger.error(`${tag} Unexpected error: ${err.message}`);
    }
  });
}

module.exports = { registerReactionHandler };
