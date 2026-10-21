'use strict';

const { extractJiraIssueKeys } = require('../utils/jiraLinkParser');
const { issueLink } = require('../utils/jiraLink');
const { pauseState, describePause } = require('../utils/pauseState');
const { findReplyMarker, threadReader, findSettlingMarker } = require('../utils/replyMarkers');
const { findOpenFlag } = require('../utils/threadDecision');
const { proposeDecision } = require('./decisionHandler');

function registerReplyHandler(app, jiraService, services) {
  const { dedupCache, rateLimiter, auditLog, userCache, integrationCache } = services;

  /** React on the root message for each matched marker; scope and allowlist apply as for writes. */
  async function applyMarkers(marking, message, issueKeys, client, logger) {
    const added = new Set();
    for (const { integration, marker } of marking) {
      const { name, scope, createdBy, allowedSlackUserIds } = integration;
      const tag = `[${name}/marker]`;
      if (scope === 'personal' && message.user !== createdBy) continue;
      if (allowedSlackUserIds.length > 0 && !allowedSlackUserIds.includes(message.user)) continue;
      if (added.has(marker.emoji)) continue;
      if (dedupCache.isDuplicate(`marker:${name}:${message.channel}:${message.thread_ts}:${message.ts}`)) continue;
      added.add(marker.emoji);
      try {
        await client.reactions.add({ channel: message.channel, timestamp: message.thread_ts, name: marker.emoji });
        logger.info(`${tag} "${marker.match}" reply on ${issueKeys.join(', ')} → :${marker.emoji}: on the root message`);
      } catch (err) {
        const code = err.data?.error || err.message;
        if (code === 'already_reacted') continue;
        logger.error(`${tag} Could not add :${marker.emoji}: in ${message.channel}: ${code}`);
        await services.opsNotifier?.post?.(
          `⚠️ *${name}*: a "${marker.match}" reply on ${issueKeys.map(issueLink).join(', ')} should have marked the post :${marker.emoji}:, but Slack refused: \`${code}\`${code === 'missing_scope' ? ' — the app needs the `reactions:write` scope (reinstall it).' : '.'}`,
          { kind: 'reply_marker_failed', user: message.user },
        );
      }
    }
  }

  app.message(async ({ message, client, logger, context }) => {
    try {
      if (!message.thread_ts || message.thread_ts === message.ts) return;
      const own = (context?.botUserId && message.user === context.botUserId)
        || (context?.botId && message.bot_id === context.botId);
      if (own) return;

      const all = await integrationCache.getAll();
      const inChannel = all.filter((i) => i.slackChannelId === message.channel);
      // A reply matching a trigger's marker only marks the root message; it never writes the field.
      const marking = inChannel
        .map((integration) => ({ integration, marker: findReplyMarker(integration.replyMarkers, message.text) }))
        .filter((m) => m.marker);
      const marked = new Set(marking.map((m) => m.integration));
      // Field writes stay human-only; markers also follow other apps' replies (e.g. a scheduled review).
      let matching = message.bot_id ? [] : inChannel.filter(
        (i) => i.triggers.includes('reply') && !marked.has(i),
      );
      // Triggers that can read a decision out of a reply in a flagged (❓) thread.
      const decisionCandidates = message.bot_id ? [] : inChannel.filter((i) => i.decision && !marked.has(i));
      if (matching.length === 0 && marking.length === 0 && decisionCandidates.length === 0) return;

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

      const readThread = threadReader(client, message.channel, message.thread_ts);
      const who = { botUserId: context?.botUserId, botId: context?.botId };

      // An open ❓ thread is decided through a confirmed proposal, never by a raw reply — whoever writes it.
      const deciding = [];
      for (const i of decisionCandidates) {
        if (await findSettlingMarker({ root: rootMessage, markers: i.replyMarkers, ...who, readThread })) continue;
        const flag = findOpenFlag({ thread: await readThread(), root: rootMessage, markers: i.replyMarkers, ...who });
        if (!flag) continue;
        matching = matching.filter((m) => m !== i);
        if (!flag.deciders.includes(message.user)) {
          logger.info(`[${i.name}/decision] ${issueKeys[0]}: reply by ${message.user}, not among the flag's deciders — ignored`);
          continue;
        }
        if (dedupCache.isDuplicate(`decision:${i.name}:${message.channel}:${message.ts}`)) continue;
        deciding.push({ integration: i, flag });
      }
      if (matching.length === 0 && marking.length === 0 && deciding.length === 0) return;

      // Already approved (e.g. auto-verified): a reply there — agreement or disagreement — writes nothing.
      if (matching.length > 0) {
        const unsettled = [];
        for (const i of matching) {
          const settled = await findSettlingMarker({ root: rootMessage, markers: i.replyMarkers, botUserId: context?.botUserId, botId: context?.botId, readThread });
          if (!settled) { unsettled.push(i); continue; }
          logger.info(`[${i.name}/reply] ${issueKeys.join(', ')} already settled ("${settled.match}") — nothing written`);
          await services.opsNotifier?.reactionFiltered({ slackUserId: message.user, reason: `reply on ${issueKeys.join(', ')}, which is already "${settled.match}" — nothing written`, integration: i.name });
        }
        matching = unsettled;
        if (matching.length === 0 && marking.length === 0 && deciding.length === 0) return;
      }

      // Global pause: say so once in the thread, write nothing. A marker-only reply has nobody to tell.
      const pause = await pauseState(services.db);
      if (pause.paused) {
        logger.info('[reply] Paused — no Jira update');
        if (matching.length > 0) {
          await client.chat.postMessage({ channel: message.channel, thread_ts: message.thread_ts, text: `⏸ <@${message.user}> — I'm paused by an admin, so I haven't changed anything. Reply again once I'm back.` }).catch(() => {});
        }
        await services.opsNotifier?.post?.(`⏸ <@${message.user}> replied while paused — nothing written. ${describePause(pause)}`, { kind: 'paused_refusal', user: message.user });
        return;
      }

      await applyMarkers(marking, message, issueKeys, client, logger);
      for (const { integration, flag } of deciding) {
        await proposeDecision({ integration, message, root: rootMessage, flag, issueKey: issueKeys[0], client, logger, services, jiraService });
      }
      if (matching.length === 0) return;

      const actorName = await userCache.getName(client, message.user);

      // Resolve OAuth once per event
      // Writes are made only with the person's own token (SNS-133715, condition 3): no bot-account fallback.
      let effectiveJira = null;
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
            // Refresh failed: treated as not connected below.
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
          scope, createdBy,
        } = integration;
        const tag = `[${name}/reply]`;

        // Personal scope: only fires for the creator
        if (scope === 'personal' && message.user !== createdBy) continue;

        // Allowlist
        if (allowedSlackUserIds.length > 0 && !allowedSlackUserIds.includes(message.user)) {
          logger.info(`${tag} User ${message.user} not in allowlist — ignoring`);
          continue;
        }

        // OAuth required: no usable token → ask to connect, write nothing
        if (!usingOAuth && !oauthService) {
          logger.warn(`${tag} Jira OAuth is not configured — nothing written`);
          await services.opsNotifier?.reactionFiltered({ slackUserId: message.user, reason: `Jira OAuth is not configured, and writes need the person's own token (*${name}*)`, integration: name });
          continue;
        }
        if (!usingOAuth) {
          logger.info(`${tag} ${message.user} not connected to Jira — asking to connect`);
          sendAuthDm(`🔐 To apply your reply on ${issueKeys.map(issueLink).join(', ')} I need your Jira connection: <${authUrl}|connect your Jira account> (10 seconds), then reply again.`);
          await client.chat.postMessage({ channel: message.channel, thread_ts: message.thread_ts, text: `🔐 <@${message.user}> — I've DM'd you a link to connect Jira. Connect once, then reply again and I'll make the change under your name.` }).catch(() => {});
          await services.opsNotifier?.reactionFiltered({ slackUserId: message.user, reason: `not connected to Jira (OAuth required) for *${name}*`, integration: name });
          continue;
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
