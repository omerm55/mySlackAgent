'use strict';

const { extractSubjectIssueKey } = require('../utils/jiraLinkParser');
const { issueLink } = require('../utils/jiraLink');
const { pauseState, describePause } = require('../utils/pauseState');
const { isApprovalReaction: isThumbsUp, threadReader, findSettlingMarker } = require('../utils/replyMarkers');
const { DONE_EMOJI } = require('../utils/threadDecision');

function registerReactionHandler(app, jiraService, services) {
  const { dedupCache, rateLimiter, auditLog, userCache, integrationCache } = services;

  app.event('reaction_added', async ({ event, client, logger, context }) => {
    try {
      if (!isThumbsUp(event.reaction)) return;
      // The bot's own 👍 (a reply marker) is a mark, not an approval.
      if (context?.botUserId && event.user === context.botUserId) return;
      if (event.item.type !== 'message') return;

      const all = await integrationCache.getAll();
      let matching = all.filter(
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

      // Only the post's subject issue — other keys in it are references, not targets.
      const subjectKey = extractSubjectIssueKey(message.text);
      const issueKeys = subjectKey ? [subjectKey] : [];
      if (issueKeys.length === 0) {
        for (const i of matching) {
          await services.opsNotifier?.reactionFiltered({ slackUserId: event.user, reason: 'no Jira issue keys in message', integration: i.name });
        }
        return;
      }

      // Already approved (e.g. auto-verified): the 👍 adds nothing — no write, no thread message.
      const readThread = threadReader(client, event.item.channel, message.ts);
      const unsettled = [];
      for (const i of matching) {
        const settled = await findSettlingMarker({ root: message, markers: i.replyMarkers, botUserId: context?.botUserId, botId: context?.botId, readThread });
        if (!settled) { unsettled.push(i); continue; }
        logger.info(`[${i.name}/reaction] ${issueKeys.join(', ')} already settled ("${settled.match}") — nothing written`);
        await services.opsNotifier?.reactionFiltered({ slackUserId: event.user, reason: `${issueKeys.join(', ')} is already "${settled.match}" — nothing written`, integration: i.name });
      }
      matching = unsettled;
      if (matching.length === 0) return;

      // Global pause: say so once in the thread, write nothing.
      const pause = await pauseState(services.db);
      if (pause.paused) {
        logger.info('[reaction] Paused — no Jira update');
        await client.chat.postMessage({ channel: event.item.channel, thread_ts: event.item.ts, text: `⏸ <@${event.user}> — I'm paused by an admin, so I haven't changed anything. React again once I'm back.` }).catch(() => {});
        await services.opsNotifier?.post?.(`⏸ <@${event.user}> reacted while paused — nothing written. ${describePause(pause)}`, { kind: 'paused_refusal', user: event.user });
        return;
      }

      const actorName = await userCache.getName(client, event.user);

      // Resolve OAuth once per event. Writes are made only with the person's own token (SNS-133715,
      // condition 3): there is no bot-account fallback.
      let effectiveJira = null;
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
            // Refresh failed: treated as not connected below.
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
          scope, createdBy,
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

        // OAuth required: no usable token → ask to connect, write nothing
        if (!usingOAuth && !oauthService) {
          logger.warn(`${tag} Jira OAuth is not configured — nothing written`);
          await services.opsNotifier?.reactionFiltered({ slackUserId: event.user, reason: `Jira OAuth is not configured, and writes need the person's own token (*${name}*)`, integration: name });
          continue;
        }
        if (!usingOAuth) {
          logger.info(`${tag} ${event.user} not connected to Jira — asking to connect`);
          sendAuthDm(`🔐 To apply your 👍 on ${issueKeys.map(issueLink).join(', ')} I need your Jira connection: <${authUrl}|connect your Jira account> (10 seconds), then react again.`);
          await client.chat.postMessage({ channel: event.item.channel, thread_ts: event.item.ts, text: `🔐 <@${event.user}> — I've DM'd you a link to connect Jira. Connect once, then react again and I'll make the change under your name.` }).catch(() => {});
          await services.opsNotifier?.reactionFiltered({ slackUserId: event.user, reason: `not connected to Jira (OAuth required) for *${name}*`, integration: name });
          continue;
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

        const outcomes = await Promise.all(issueKeys.map(async (key) => {
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
          return success;
        }));

        // A 👍 on a flagged (❓) post is the decision: once written, swap the bot's ❓ for ✅.
        const flagEmojis = new Set((integration.replyMarkers || []).filter((m) => !isThumbsUp(m.emoji)).map((m) => m.emoji));
        const botFlag = (message.reactions || []).find((r) => flagEmojis.has(r.name) && (r.users || []).includes(context?.botUserId));
        if (botFlag && outcomes.every(Boolean)) {
          await client.reactions.remove({ channel: event.item.channel, timestamp: message.ts, name: botFlag.name }).catch(() => {});
          await client.reactions.add({ channel: event.item.channel, timestamp: message.ts, name: DONE_EMOJI }).catch(() => {});
          logger.info(`${tag} ${issueKeys.join(', ')}: decided by 👍 — :${botFlag.name}: → :${DONE_EMOJI}:`);
        }
      }
    } catch (err) {
      logger.error(`[reaction] Unexpected error: ${err.message}`);
    }
  });
}

module.exports = { registerReactionHandler };
