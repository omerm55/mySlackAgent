'use strict';

const { extractJiraIssueKeys } = require('../utils/jiraLinkParser');

/**
 * Register the Slack event handler that watches for thread replies in the
 * configured channel and updates linked Jira issues.
 *
 * @param {import('@slack/bolt').App} app
 * @param {import('../services/jiraService')} jiraService
 * @param {object} config
 * @param {string} config.watchChannelId  Slack channel ID to monitor
 * @param {string} config.jiraFieldId     Jira field to update
 * @param {string} config.jiraFieldValue  Value to set on the field
 * @param {string} [config.jiraFieldType] Field type hint (default: 'select')
 */
function registerReplyHandler(app, jiraService, config) {
  const { watchChannelId, jiraFieldId, jiraFieldValue, jiraFieldType = 'select' } = config;

  // `message` fires for every message event, including thread replies.
  app.message(async ({ message, client, logger }) => {
    try {
      // Only process messages from the configured channel.
      if (message.channel !== watchChannelId) return;

      // Only process thread replies (thread_ts exists and differs from ts).
      if (!message.thread_ts || message.thread_ts === message.ts) return;

      // Fetch the root message of the thread to look for Jira links.
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

      logger.info(
        `Reply detected in thread ${message.thread_ts}. ` +
          `Found Jira issue(s): ${issueKeys.join(', ')}. Updating field "${jiraFieldId}" → "${jiraFieldValue}".`
      );

      // Update all linked Jira issues.
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
      logger.error(`replyHandler error: ${err.message}`);
    }
  });
}

module.exports = { registerReplyHandler };
