'use strict';

const { extractJiraIssueKeys } = require('../utils/jiraLinkParser');

const THUMBS_UP_EMOJIS = new Set(['+1', 'thumbsup', 'thumbs_up']);

/**
 * @param {import('@slack/bolt').App} app
 * @param {import('../services/jiraService')} jiraService
 * @param {import('../services/attributionService')} attributionService
 * @param {object} config
 * @param {string}   config.name
 * @param {string}   config.watchChannelId
 * @param {string[]} config.allowedSlackUserIds  Empty = all channel members allowed
 * @param {number}   config.rateLimitPerHour
 * @param {string}   config.jiraFieldId
 * @param {string}   config.jiraFieldName
 * @param {string}   config.jiraFieldValue
 * @param {string}   config.jiraFieldType
 * @param {object} services
 * @param {import('../utils/dedupCache')}   services.dedupCache
 * @param {import('../utils/rateLimiter')}  services.rateLimiter
 * @param {import('../utils/auditLog')}     services.auditLog
 * @param {import('../utils/alerting')}     services.alerting
 * @param {import('../utils/userCache')}    services.userCache
 */
function registerReactionHandler(app, jiraService, attributionService, config, services) {
  const {
    name, watchChannelId, allowedSlackUserIds, rateLimitPerHour,
    jiraFieldId, jiraFieldName, jiraFieldValue, jiraFieldType = 'select',
  } = config;
  const { dedupCache, rateLimiter, auditLog, alerting, userCache } = services;
  const tag = `[${name}/reaction]`;

  app.event('reaction_added', async ({ event, client, logger }) => {
    try {
      if (!THUMBS_UP_EMOJIS.has(event.reaction)) return;
      if (event.item.type !== 'message') return;
      if (event.item.channel !== watchChannelId) return;

      // Authorization: check allowlist if one is configured
      if (allowedSlackUserIds.length > 0 && !allowedSlackUserIds.includes(event.user)) {
        logger.info(`${tag} User ${event.user} is not in the allowlist — ignoring`);
        return;
      }

      // Rate limiting
      if (!rateLimiter.isAllowed(name, rateLimitPerHour)) {
        logger.warn(`${tag} Rate limit of ${rateLimitPerHour}/hour exceeded — event dropped`);
        await alerting.recordRateLimit(name, rateLimitPerHour, logger);
        return;
      }

      // Deduplication
      const dedupKey = `reaction:${watchChannelId}:${event.item.ts}:${event.user}`;
      if (dedupCache.isDuplicate(dedupKey)) {
        logger.info(`${tag} Duplicate event on ${event.item.ts} — skipping`);
        return;
      }

      const result = await client.conversations.history({
        channel: event.item.channel,
        latest: event.item.ts,
        limit: 1,
        inclusive: true,
      });

      const message = result.messages?.[0];
      if (!message) return;

      const issueKeys = extractJiraIssueKeys(message.text);
      if (issueKeys.length === 0) return;

      const actorName = await userCache.getName(client, event.user);
      logger.info(`${tag} 👍 by ${actorName} on ${event.item.ts} → updating issue(s): ${issueKeys.join(', ')}`);

      await Promise.all(
        issueKeys.map(async (key) => {
          let success = true;
          let errorMsg;
          try {
            await jiraService.updateIssueField(key, jiraFieldId, jiraFieldValue, jiraFieldType);
            logger.info(`${tag} Updated ${key} ✓`);
            await client.chat.postMessage({
              channel: event.item.channel,
              thread_ts: event.item.ts,
              text: `✅ Jira issue *${key}* updated: *${jiraFieldName}* = *${jiraFieldValue}* (triggered by 👍 reaction)`,
            });
            await attributionService.postAttributionComment(
              client, event.user, key, jiraFieldId, jiraFieldValue, '👍 reaction', name, actorName
            );
          } catch (err) {
            success = false;
            errorMsg = err.message;
            logger.error(`${tag} Failed to update ${key}: ${err.message}`);
            await alerting.recordError(name, err.message, logger);
          }
          auditLog.addEntry({
            ts: Date.now(),
            integrationName: name,
            trigger: '👍 reaction',
            slackUserId: event.user,
            slackUserName: actorName,
            issueKey: key,
            fieldName: jiraFieldName,
            fieldValue: jiraFieldValue,
            success,
            error: errorMsg,
          });
        })
      );
    } catch (err) {
      logger.error(`${tag} Unexpected error: ${err.message}`);
    }
  });
}

module.exports = { registerReactionHandler };
