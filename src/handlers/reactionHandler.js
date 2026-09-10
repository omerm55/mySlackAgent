'use strict';

const { extractJiraIssueKeys } = require('../utils/jiraLinkParser');
const { issueLink } = require('../utils/jiraLink');
const { pauseState, describePause } = require('../utils/pauseState');

const THUMBS_UP_EMOJIS = new Set(['+1', 'thumbsup', 'thumbs_up', 'white_check_mark']);
const isThumbsUp = (r) => THUMBS_UP_EMOJIS.has(r) || THUMBS_UP_EMOJIS.has(r.split('::')[0]);

function registerReactionHandler(app, jiraService, attributionService, services) {
  const { dedupCache, rateLimiter, auditLog, userCache, integrationCache } = services;

  app.event('reaction_added', async ({ event, client, logger }) => {
    try {
      if (!isThumbsUp(event.reaction)) return;
      if (event.item.type !== 'message') return;

      const all = await integrationCache.getAll();
      const matching = all.filter(
        (i) => i.triggers.includes('reaction') && i.slackChannelId === event.item.channel,
      );
      if (matching.length === 0) {
        const known = [...new Set(all.map((i) => i.slackChannelId))].join(', ') || 'none';
        logger.info(`[reaction] 👍 from ${event.user} in ${event.item.channel} — no integration matches (known channels: ${known})`);
        return;
      }

      logger.info(`[reaction] 👍 from ${event.user} in ${event.item.channel} — ${matching.length} integration(s) match`);

      const result = await client.conversations.history({
        channel: event.item.channel,
        latest: event.item.ts,
        limit: 1,
        inclusive: true,
      });
      const message = result.messages?.[0];
      if (!message) return;

      const issueKeys = extractJiraIssueKeys(message.text);
      if (issueKeys.length === 0) {
        for (const i of matching) {
          await services.opsNotifier?.reactionFiltered({ slackUserId: event.user, reason: 'no Jira issue keys in message', integration: i.name });
        }
        return;
      }

      // Global pause: say so once in the thread, write nothing.
      const pause = await pauseState(services.db);
      if (pause.paused) {
        logger.info('[reaction] Paused — no Jira update');
        await client.chat.postMessage({ channel: event.item.channel, thread_ts: event.item.ts, text: `⏸ <@${event.user}> — I'm paused by an admin, so I haven't changed anything. React again once I'm back.` }).catch(() => {});
        await services.opsNotifier?.post?.(`⏸ <@${event.user}> reacted while paused — nothing written. ${describePause(pause)}`, { kind: 'paused_refusal', user: event.user });
        return;
      }

      const actorName = await userCache.getName(client, event.user);

      // Resolve OAuth once per event
      let effectiveJira = jiraService;
      let usingOAuth = false;
      const { oauthService } = services;
      let hasToken = false;
      let authUrl = null;
      if (oauthService) {
        if (oauthService.hasToken(event.user)) {
          try {
            effectiveJira = await oauthService.getJiraService(event.user);
            usingOAuth = true;
            hasToken = true;
          } catch {
            effectiveJira = jiraService;
          }
        }
        if (!hasToken) authUrl = await oauthService.generateAuthUrl(event.user).catch(() => null);
      }
      let authDmSent = false;
      const sendAuthDm = (text) => {
        if (authDmSent || !authUrl) return;
        authDmSent = true;
        client.conversations.open({ users: event.user })
          .then((dm) => client.chat.postMessage({ channel: dm.channel.id, text }))
          .catch((err) => logger.warn(`[reaction] Failed to send auth DM to ${event.user}: ${err.message}`));
      };

      for (const integration of matching) {
        const {
          name, allowedSlackUserIds, rateLimitPerHour,
          jiraFieldId, jiraFieldName, jiraFieldValue, jiraFieldType = 'select',
          scope, createdBy, allowBotFallback = false,
        } = integration;
        const tag = `[${name}/reaction]`;

        // Personal scope: only fires for the creator
        if (scope === 'personal' && event.user !== createdBy) continue;

        // Allowlist
        if (allowedSlackUserIds.length > 0 && !allowedSlackUserIds.includes(event.user)) {
          logger.info(`${tag} User ${event.user} not in allowlist — ignoring`);
          await services.opsNotifier?.reactionFiltered({ slackUserId: event.user, reason: `not in allowlist for *${name}*`, integration: name });
          continue;
        }

        // OAuth required: no token and this trigger does not allow the bot account → ask to connect, write nothing
        if (oauthService && !hasToken && !allowBotFallback) {
          logger.info(`${tag} ${event.user} not connected to Jira and bot fallback not allowed — asking to connect`);
          sendAuthDm(`🔐 To apply your 👍 on ${issueKeys.map(issueLink).join(', ')} I need your Jira connection: <${authUrl}|connect your Jira account> (10 seconds), then react again.`);
          await client.chat.postMessage({ channel: event.item.channel, thread_ts: event.item.ts, text: `🔐 <@${event.user}> — I've DM'd you a link to connect Jira. Connect once, then react again and I'll make the change under your name.` }).catch(() => {});
          await services.opsNotifier?.reactionFiltered({ slackUserId: event.user, reason: `not connected to Jira (OAuth required) for *${name}*`, integration: name });
          continue;
        }
        if (oauthService && !hasToken && allowBotFallback) {
          sendAuthDm(`👋 To make your Jira changes appear as you (not the bot), <${authUrl}|connect your Jira account>. This change was made by the bot account.`);
        }

        // Rate limiting
        if (!rateLimiter.isAllowed(name, rateLimitPerHour)) {
          logger.warn(`${tag} Rate limit ${rateLimitPerHour}/hour exceeded`);
          await services.alerting?.recordRateLimit(name, rateLimitPerHour, logger);
          await services.opsNotifier?.reactionFiltered({ slackUserId: event.user, reason: `rate limit (${rateLimitPerHour}/hour) exceeded`, integration: name });
          continue;
        }

        // Deduplication (per-integration)
        const dedupKey = `reaction:${name}:${event.item.channel}:${event.item.ts}:${event.user}`;
        if (dedupCache.isDuplicate(dedupKey)) {
          logger.info(`${tag} Duplicate — skipping`);
          continue;
        }

        logger.info(`${tag} 👍 by ${actorName} → updating: ${issueKeys.join(', ')}`);

        await Promise.all(issueKeys.map(async (key) => {
          let success = true;
          let errorMsg;
          try {
            await effectiveJira.updateIssueField(key, jiraFieldId, jiraFieldValue, jiraFieldType);
            logger.info(`${tag} Updated ${key} ✓`);
            await client.chat.postMessage({
              channel: event.item.channel,
              thread_ts: event.item.ts,
              text: `✅ Jira issue *${issueLink(key)}* updated: *${jiraFieldName}* = *${jiraFieldValue}* (triggered by 👍 reaction)`,
            });
            if (effectiveJira === jiraService) {
              await attributionService.postAttributionComment(
                client, event.user, key, jiraFieldId, jiraFieldName, jiraFieldValue, '👍 reaction', name, actorName,
              );
            }
          } catch (err) {
            success = false;
            errorMsg = err.message;
            logger.error(`${tag} Failed to update ${key}: ${err.message}`);
            await services.alerting?.recordError(name, err.message, logger);
          }
          auditLog.addEntry({
            ts: Date.now(), integrationName: name, trigger: '👍 reaction',
            slackUserId: event.user, slackUserName: actorName, issueKey: key,
            fieldName: jiraFieldName, fieldValue: jiraFieldValue, success, error: errorMsg,
          });
          await services.opsNotifier?.jiraTriggered({
            trigger: '👍 reaction', actorName, slackUserId: event.user,
            issueKey: key, fieldName: jiraFieldName, fieldValue: jiraFieldValue,
            success, error: errorMsg, usingOAuth,
          });
        }));
      }
    } catch (err) {
      logger.error(`[reaction] Unexpected error: ${err.message}`);
    }
  });
}

module.exports = { registerReactionHandler };
