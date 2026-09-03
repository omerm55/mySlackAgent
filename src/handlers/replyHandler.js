'use strict';

const { extractJiraIssueKeys } = require('../utils/jiraLinkParser');

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
function registerReplyHandler(app, jiraService, attributionService, config, services) {
  const {
    name, watchChannelId, allowedSlackUserIds, rateLimitPerHour,
    jiraFieldId, jiraFieldName, jiraFieldValue, jiraFieldType = 'select',
  } = config;
  const { dedupCache, rateLimiter, auditLog, alerting, userCache } = services;
  const tag = `[${name}/reply]`;

  app.message(async ({ message, client, logger }) => {
    try {
      if (message.channel !== watchChannelId) return;
      if (!message.thread_ts || message.thread_ts === message.ts) return;

      // Authorization: check allowlist if one is configured
      if (allowedSlackUserIds.length > 0 && !allowedSlackUserIds.includes(message.user)) {
        logger.info(`${tag} User ${message.user} is not in the allowlist — ignoring`);
        return;
      }

      // Rate limiting
      if (!rateLimiter.isAllowed(name, rateLimitPerHour)) {
        logger.warn(`${tag} Rate limit of ${rateLimitPerHour}/hour exceeded — event dropped`);
        await alerting.recordRateLimit(name, rateLimitPerHour, logger);
        return;
      }

      // Deduplication
      const dedupKey = `reply:${watchChannelId}:${message.thread_ts}:${message.ts}`;
      if (dedupCache.isDuplicate(dedupKey)) {
        logger.info(`${tag} Duplicate event for thread ${message.thread_ts} — skipping`);
        return;
      }

      const result = await client.conversations.replies({
        channel: message.channel,
        ts: message.thread_ts,
        limit: 1,
        inclusive: true,
      });

      const rootMessage = result.messages?.[0];
      if (!rootMessage) return;

      const issueKeys = extractJiraIssueKeys(rootMessage.text);
      if (issueKeys.length === 0) return;

      const actorName = await userCache.getName(client, message.user);
      logger.info(`${tag} Reply by ${actorName} in thread ${message.thread_ts} → updating issue(s): ${issueKeys.join(', ')}`);

      // Resolve per-user Jira client via OAuth if the user has authorized.
      // On first trigger without a token, DM the user an auth link and fall
      // back to the service account for this request.
      let effectiveJira = jiraService;
      const { oauthService } = services;
      if (oauthService) {
        if (oauthService.hasToken(message.user)) {
          try {
            effectiveJira = await oauthService.getJiraService(message.user);
          } catch {
            effectiveJira = jiraService;
          }
        } else {
          const authUrl = oauthService.generateAuthUrl(message.user);
          client.conversations.open({ users: message.user })
            .then((dm) => client.chat.postMessage({
              channel: dm.channel.id,
              text: `👋 To make your Jira changes appear as you (not the bot), <${authUrl}|connect your Jira account>. This change was made by the bot account.`,
            }))
            .catch(() => {});
        }
      }

      await Promise.all(
        issueKeys.map(async (key) => {
          let success = true;
          let errorMsg;
          try {
            await effectiveJira.updateIssueField(key, jiraFieldId, jiraFieldValue, jiraFieldType);
            logger.info(`${tag} Updated ${key} ✓`);
            await client.chat.postMessage({
              channel: message.channel,
              thread_ts: message.thread_ts,
              text: `✅ Jira issue *${key}* updated: *${jiraFieldName}* = *${jiraFieldValue}* (triggered by thread reply)`,
            });
            await attributionService.postAttributionComment(
              client, message.user, key, jiraFieldId, jiraFieldName, jiraFieldValue, 'thread reply', name, actorName
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
            trigger: 'thread reply',
            slackUserId: message.user,
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

module.exports = { registerReplyHandler };
