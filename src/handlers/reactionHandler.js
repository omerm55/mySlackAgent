'use strict';

const { extractJiraIssueKeys } = require('../utils/jiraLinkParser');

// Slack emoji names that represent a thumbs-up reaction.
const THUMBS_UP_EMOJIS = new Set(['+1', 'thumbsup', 'thumbs_up']);

/**
 * Register the Slack event handler that watches for 👍 reactions on messages
 * in the configured channel and updates linked Jira issues.
 *
 * Required Slack bot scope: reactions:read
 *
 * @param {import('@slack/bolt').App} app
 * @param {import('../services/jiraService')} jiraService
 * @param {object} config
 * @param {string} config.watchChannelId
 * @param {string} config.jiraFieldId
 * @param {string} config.jiraFieldValue
 * @param {string} [config.jiraFieldType]
 */
function registerReactionHandler(app, jiraService, config) {
  const { watchChannelId, jiraFieldId, jiraFieldValue, jiraFieldType = 'select' } = config;

  app.event('reaction_added', async ({ event, client, logger }) => {
    try {
      // Only care about thumbs-up reactions on messages in the watched channel.
      if (!THUMBS_UP_EMOJIS.has(event.reaction)) return;
      if (event.item.type !== 'message') return;
      if (event.item.channel !== watchChannelId) return;

      // Fetch the message that was reacted to.
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

      logger.info(
        `👍 reaction by ${event.user} on message ${event.item.ts}. ` +
          `Found Jira issue(s): ${issueKeys.join(', ')}. Updating field "${jiraFieldId}" → "${jiraFieldValue}".`
      );

      await Promise.all(
        issueKeys.map((key) =>
          jiraService
            .updateIssueField(key, jiraFieldId, jiraFieldValue, jiraFieldType)
            .then(() => logger.info(`Updated ${key} successfully.`))
            .catch((err) => {
              const detail = err.response
                ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}`
                : err.message;
              logger.error(`Failed to update ${key}: ${detail}`);
            })
        )
      );
    } catch (err) {
      logger.error(`reactionHandler error: ${err.message}`);
    }
  });
}

module.exports = { registerReactionHandler };
