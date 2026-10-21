'use strict';

/**
 * Decisions in a flagged (❓) thread — see utils/threadDecision.js for the model.
 *
 *   proposeDecision  called by replyHandler for a reply from a decider in an open thread:
 *                    LLM reads the reply → a proposal with [✅ Apply] [Not quite] in the thread.
 *   decision_apply   the decider only: one PUT (decision field + review field) as them, read back,
 *                    then ❓ → ✅ on the root post. Anything else leaves ❓ and says why.
 *   decision_dismiss the decider only: nothing written, proposal closed.
 *
 * Pino logs carry keys, ids and lengths only — the reply text goes to the LLM and the ops channel.
 */

const { pauseState, describePause } = require('../utils/pauseState');
const { issueLink } = require('../utils/jiraLink');
const {
  DONE_EMOJI, normaliseDecision, buildProposalBlocks, buildOutcomeBlocks,
} = require('../utils/threadDecision');

const selectValue = (field) => (field && typeof field === 'object' ? field.value ?? null : field ?? null);

/**
 * @param {object} args
 * @param {object} args.integration  normalised channel trigger with `decision`
 * @param {object} args.message      the decider's reply
 * @param {object} args.root         thread root
 * @param {object} args.flag         { reply, marker, deciders } from findOpenFlag
 * @param {string} args.issueKey     the bug (first key on the root post)
 */
async function proposeDecision({ integration, message, root, flag, issueKey, client, logger, services, jiraService }) {
  const { decision } = integration;
  const tag = `[${integration.name}/decision]`;
  const { llmService } = services;
  if (!llmService) {
    logger.warn(`${tag} ${issueKey}: no LLM configured — cannot read the decision`);
    return;
  }

  let current = null;
  try {
    current = selectValue((await jiraService.getIssue(issueKey))?.fields?.[decision.fieldId]);
  } catch (err) {
    logger.warn(`${tag} ${issueKey}: could not read ${decision.fieldId}: ${err.message}`);
  }

  let read;
  try {
    read = await llmService.interpretDecision({
      issueKey, post: root.text, flag: flag.reply.text, fieldName: decision.fieldName,
      options: decision.options, current, reply: message.text || '',
    });
  } catch (err) {
    logger.error(`${tag} ${issueKey}: LLM failed: ${err.message}`);
    await services.opsNotifier?.post?.(`⚠️ *${integration.name}*: couldn't read <@${message.user}>'s reply on ${issueLink(issueKey)} as a decision (AI error: ${err.message}). They can 👍 the post or set it in Jira.`, { kind: 'decision_failed', user: message.user, issue: issueKey, ok: false });
    return;
  }

  const value = normaliseDecision(read?.decision, decision.options);
  if (!value) {
    logger.info(`${tag} ${issueKey}: reply (${(message.text || '').length} chars) by ${message.user} states no decision`);
    return;
  }

  const ctx = {
    issueKey, channel: message.channel, rootTs: root.ts, decider: message.user,
    trigger: integration.name, fieldId: decision.fieldId, fieldName: decision.fieldName, value,
    reviewFieldId: integration.jiraFieldId, reviewFieldName: integration.jiraFieldName, reviewValue: integration.jiraFieldValue,
    flagEmoji: flag.marker.emoji,
  };
  const msg = buildProposalBlocks(ctx, { current, reason: read.reason });
  await client.chat.postMessage({ channel: message.channel, thread_ts: root.ts, ...msg });
  logger.info(`${tag} ${issueKey}: proposed ${decision.fieldId}=${value} to ${message.user}`);
  await services.opsNotifier?.post?.(`🤔 *${integration.name}*: <@${message.user}> replied on ${issueLink(issueKey)} — proposed *${decision.fieldName}* = *${value}*${current ? ` (now ${current})` : ''}, waiting for their click. Reply: “${(message.text || '').slice(0, 300)}”`, { kind: 'decision_proposed', user: message.user, issue: issueKey });
}

function registerDecisionHandler(app, jiraService, services) {
  const parse = (body) => { try { return JSON.parse(body.actions?.[0]?.value || '{}'); } catch { return {}; } };
  const where = (body) => ({ channel: body.channel?.id || body.container?.channel_id, ts: body.message?.ts || body.container?.message_ts });

  async function notDecider(body, client, ctx) {
    if (body.user.id === ctx.decider) return false;
    const { channel } = where(body);
    await client.chat.postEphemeral({ channel, user: body.user.id, thread_ts: ctx.rootTs, text: `Only <@${ctx.decider}> can answer this one — it reads their reply.` }).catch(() => {});
    return true;
  }

  app.action('decision_apply', async ({ ack, body, client, logger }) => {
    await ack();
    const ctx = parse(body);
    if (!ctx.issueKey || await notDecider(body, client, ctx)) return;
    const { channel, ts } = where(body);
    const tag = `[${ctx.trigger}/decision]`;
    const keepProposal = async (note) => {
      const again = buildProposalBlocks(ctx);
      again.blocks.splice(1, 0, { type: 'context', elements: [{ type: 'mrkdwn', text: note }] });
      await client.chat.update({ channel, ts, ...again }).catch(() => {});
    };

    const pause = await pauseState(services.db);
    if (pause.paused) {
      await keepProposal('⏸ I\'m paused by an admin, so nothing was written. Press Apply again once I\'m back.');
      await services.opsNotifier?.post?.(`⏸ <@${ctx.decider}> pressed Apply on ${issueLink(ctx.issueKey)} while paused — nothing written. ${describePause(pause)}`, { kind: 'paused_refusal', user: ctx.decider });
      return;
    }

    // Write as the decider, with their own token only (SNS-133715, condition 3). An `allowFallback` left
    // in an older proposal's button value is ignored.
    const { oauthService } = services;
    let jira = null;
    if (oauthService?.hasToken(ctx.decider)) {
      try { jira = await oauthService.getJiraService(ctx.decider); } catch { jira = null; }
    }
    if (!jira) {
      const authUrl = await oauthService?.generateAuthUrl(ctx.decider).catch(() => null);
      if (authUrl) await client.chat.postMessage({ channel: ctx.decider, text: `🔐 To apply your decision on ${issueLink(ctx.issueKey)} I need your Jira connection: <${authUrl}|connect your Jira account> (10 seconds), then press Apply again.` }).catch(() => {});
      await keepProposal('🔐 I\'ve DM\'d you a link to connect Jira. Connect once, then press Apply again — the change will be made under your name.');
      await services.opsNotifier?.reactionFiltered?.({ slackUserId: ctx.decider, reason: `not connected to Jira (OAuth required) for *${ctx.trigger}* decision`, integration: ctx.trigger });
      return;
    }

    const summary = `*${ctx.fieldName}* = *${ctx.value}* and *${ctx.reviewFieldName}* = *${ctx.reviewValue}* on ${issueLink(ctx.issueKey)}`;
    try {
      await jira.updateIssueFields(ctx.issueKey, {
        [ctx.fieldId]: { value: ctx.value },
        [ctx.reviewFieldId]: { value: ctx.reviewValue },
      });
    } catch (err) {
      logger.error(`${tag} ${ctx.issueKey}: write failed: ${err.message}`);
      await keepProposal(`❌ Jira refused the change: ${err.message.slice(0, 200)}. Nothing was written; ❓ stays.`);
      await services.opsNotifier?.post?.(`❌ *${ctx.trigger}*: <@${ctx.decider}>'s decision on ${issueLink(ctx.issueKey)} failed: ${err.message}`, { kind: 'decision_failed', user: ctx.decider, issue: ctx.issueKey, ok: false });
      return;
    }

    // Make sure Jira now says what the decider decided before calling the post done.
    let readBack = null;
    try {
      const fields = (await jira.getIssue(ctx.issueKey))?.fields || {};
      readBack = { decision: selectValue(fields[ctx.fieldId]), review: selectValue(fields[ctx.reviewFieldId]) };
    } catch (err) {
      logger.warn(`${tag} ${ctx.issueKey}: read-back failed: ${err.message}`);
    }
    const verified = readBack && readBack.decision === ctx.value && readBack.review === ctx.reviewValue;

    services.auditLog?.addEntry({
      ts: Date.now(), integrationName: ctx.trigger, trigger: 'thread decision', slackUserId: ctx.decider,
      issueKey: ctx.issueKey, fieldName: ctx.fieldName, fieldValue: ctx.value, success: true,
    });

    if (!verified) {
      const seen = readBack ? `Jira now shows ${ctx.fieldName} = ${readBack.decision ?? 'empty'}, ${ctx.reviewFieldName} = ${readBack.review ?? 'empty'}` : 'I couldn\'t read the issue back';
      await client.chat.update({ channel, ts, ...buildOutcomeBlocks(`⚠️ <@${ctx.decider}> I sent ${summary}, but ${seen} — probably a Jira automation changed it. ❓ stays; please check the issue.`) }).catch(() => {});
      await services.opsNotifier?.post?.(`⚠️ *${ctx.trigger}*: wrote <@${ctx.decider}>'s decision on ${issueLink(ctx.issueKey)} but the read-back didn't match (${seen}). ❓ left in place.`, { kind: 'decision_unverified', user: ctx.decider, issue: ctx.issueKey, ok: false });
      return;
    }

    await client.reactions.remove({ channel: ctx.channel, timestamp: ctx.rootTs, name: ctx.flagEmoji }).catch(() => {});
    await client.reactions.add({ channel: ctx.channel, timestamp: ctx.rootTs, name: DONE_EMOJI }).catch((err) => {
      if ((err.data?.error || err.message) !== 'already_reacted') logger.warn(`${tag} could not add ✅: ${err.data?.error || err.message}`);
    });
    await client.chat.update({ channel, ts, ...buildOutcomeBlocks(`✅ Done — ${summary}, set by <@${ctx.decider}> and checked in Jira.`) }).catch(() => {});
    logger.info(`${tag} ${ctx.issueKey}: applied ${ctx.fieldId}=${ctx.value} for ${ctx.decider}, verified`);
    await services.opsNotifier?.post?.(`✅ *${ctx.trigger}*: <@${ctx.decider}> decided ${summary} _(OAuth ✅)_ — ❓ → ✅.`, { kind: 'decision_applied', user: ctx.decider, issue: ctx.issueKey });
  });

  app.action('decision_dismiss', async ({ ack, body, client }) => {
    await ack();
    const ctx = parse(body);
    if (!ctx.issueKey || await notDecider(body, client, ctx)) return;
    const { channel, ts } = where(body);
    await client.chat.update({ channel, ts, ...buildOutcomeBlocks(`Okay <@${ctx.decider}> — nothing changed. Reply again with your decision, or set *${ctx.fieldName}* in Jira and 👍 the post.`) }).catch(() => {});
    await services.opsNotifier?.post?.(`↩️ *${ctx.trigger}*: <@${ctx.decider}> said "not quite" to *${ctx.fieldName}* = *${ctx.value}* on ${issueLink(ctx.issueKey)} — nothing written.`, { kind: 'decision_dismissed', user: ctx.decider, issue: ctx.issueKey });
  });
}

module.exports = { registerDecisionHandler, proposeDecision };
