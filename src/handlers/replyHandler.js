'use strict';

const { extractJiraIssueKeys } = require('../utils/jiraLinkParser');
const { issueLink } = require('../utils/jiraLink');

function registerReplyHandler(app, jiraService, attributionService, services) {
  const { dedupCache, rateLimiter, auditLog, userCache, integrationCache } = services;

  app.message(async ({ message, client, logger }) => {
    try {
      if (!message.thread_ts || message.thread_ts === message.ts) return;
      if (message.bot_id) return;

      const all = await integrationCache.getAll();
      const matching = all.filter(
        (i) => i.triggers.includes('reply') && i.slackChannelId === message.channel,
      );
      if (matching.length === 0) return;

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

      // Resolve OAuth once per event
      let effectiveJira = jiraService;
      let usingOAuth = false;
      const { oauthService } = services;
      let hasToken = false;
      let authUrl = null;
      if (oauthService) {
        if (oauthService.hasToken(message.user)) {
          try {
            effectiveJira = await oauthService.getJiraService(message.user);
            usingOAuth = true;
            hasToken = true;
          } catch {
            effectiveJira = jiraService;
          }
        }
        if (!hasToken) authUrl = await oauthService.generateAuthUrl(message.user).catch(() => null);
      }
      let authDmSent = false;
      const sendAuthDm = (text) => {
        if (authDmSent || !authUrl) return;
        authDmSent = true;
        client.conversations.open({ users: message.user })
          .then((dm) => client.chat.postMessage({ channel: dm.channel.id, text }))
          .catch((err) => logger.warn(`[reply] Failed to send auth DM to ${message.user}: ${err.message}`));
      };

      for (const integration of matching) {
        const {
          name, allowedSlackUserIds, rateLimitPerHour,
          jiraFieldId, jiraFieldName, jiraFieldValue, jiraFieldType = 'select',
          scope, createdBy, allowBotFallback = false,
        } = integration;
        const tag = `[${name}/reply]`;

        // Personal scope: only fires for the creator
        if (scope === 'personal' && message.user !== createdBy) continue;

        // Allowlist
        if (allowedSlackUserIds.length > 0 && !allowedSlackUserIds.includes(message.user)) {
          logger.info(`${tag} User ${message.user} not in allowlist — ignoring`);
          continue;
        }

        // OAuth required: no token and this trigger does not allow the bot account → ask to connect, write nothing
        if (oauthService && !hasToken && !allowBotFallback) {
          logger.info(`${tag} ${message.user} not connected to Jira and bot fallback not allowed — asking to connect`);
          sendAuthDm(`🔐 To apply your reply on ${issueKeys.map(issueLink).join(', ')} I need your Jira connection: <${authUrl}|connect your Jira account> (10 seconds), then reply again.`);
          await client.chat.postMessage({ channel: message.channel, thread_ts: message.thread_ts, text: `🔐 <@${message.user}> — I've DM'd you a link to connect Jira. Connect once, then reply again and I'll make the change under your name.` }).catch(() => {});
          await services.opsNotifier?.reactionFiltered({ slackUserId: message.user, reason: `not connected to Jira (OAuth required) for *${name}*`, integration: name });
          continue;
        }
        if (oauthService && !hasToken && allowBotFallback) {
          sendAuthDm(`👋 To make your Jira changes appear as you (not the bot), <${authUrl}|connect your Jira account>. This change was made by the bot account.`);
        }

        // Rate limiting
        if (!rateLimiter.isAllowed(name, rateLimitPerHour)) {
          logger.warn(`${tag} Rate limit ${rateLimitPerHour}/hour exceeded`);
          await services.alerting?.recordRateLimit(name, rateLimitPerHour, logger);
          continue;
        }

        // Deduplication (per-integration)
        const dedupKey = `reply:${name}:${message.channel}:${message.thread_ts}:${message.ts}`;
        if (dedupCache.isDuplicate(dedupKey)) {
          logger.info(`${tag} Duplicate — skipping`);
          continue;
        }

        logger.info(`${tag} Reply by ${actorName} in thread ${message.thread_ts} → updating: ${issueKeys.join(', ')}`);

        await Promise.all(issueKeys.map(async (key) => {
          let success = true;
          let errorMsg;
          try {
            await effectiveJira.updateIssueField(key, jiraFieldId, jiraFieldValue, jiraFieldType);
            logger.info(`${tag} Updated ${key} ✓`);
            await client.chat.postMessage({
              channel: message.channel,
              thread_ts: message.thread_ts,
              text: `✅ Jira issue *${issueLink(key)}* updated: *${jiraFieldName}* = *${jiraFieldValue}* (triggered by thread reply)`,
            });
            if (effectiveJira === jiraService) {
              await attributionService.postAttributionComment(
                client, message.user, key, jiraFieldId, jiraFieldName, jiraFieldValue, 'thread reply', name, actorName,
              );
            }
          } catch (err) {
            success = false;
            errorMsg = err.message;
            logger.error(`${tag} Failed to update ${key}: ${err.message}`);
            await services.alerting?.recordError(name, err.message, logger);
          }
          auditLog.addEntry({
            ts: Date.now(), integrationName: name, trigger: 'thread reply',
            slackUserId: message.user, slackUserName: actorName, issueKey: key,
            fieldName: jiraFieldName, fieldValue: jiraFieldValue, success, error: errorMsg,
          });
          await services.opsNotifier?.jiraTriggered({
            trigger: 'thread reply', actorName, slackUserId: message.user,
            issueKey: key, fieldName: jiraFieldName, fieldValue: jiraFieldValue,
            success, error: errorMsg, usingOAuth,
          });
        }));
      }
    } catch (err) {
      logger.error(`[reply] Unexpected error: ${err.message}`);
    }
  });
}

module.exports = { registerReplyHandler };
