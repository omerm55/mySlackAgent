'use strict';

const { issueLink, mentionsIssue } = require('./jiraLink');

/**
 * Send a Yes/No question to a Slack user via DM using interactive buttons.
 * The full context is embedded in the button values so no in-memory lookup
 * is needed when the user clicks — works even if the process restarts.
 *
 * @param {import('@slack/bolt').App['client']} client
 * @param {string} slackUserId
 * @param {{ issueKey: string, question: string, jiraFieldId: string, jiraFieldName: string, jiraFieldValue: string, jiraFieldType: string }} context
 * @param {null} _pendingQuestions  legacy positional argument, always null (kept so callers need not change)
 * @returns {Promise<{ channelId: string, messageTs: string }>}
 */
/** Headline: only prefix the key when the question doesn't already name the issue. */
function yesNoHeadline(context) {
  return mentionsIssue(context.question, context.issueKey)
    ? context.question
    : `*${issueLink(context.issueKey)}*: ${context.question}`;
}

/**
 * The Yes / No / Reply ask (no Connect nudge). Button values are capped at 2000 chars — keep the
 * question short in ctx. `allowFallback` tells the click handlers whether the bot account may act
 * for a person who has not connected Jira (per-trigger admin setting; default no).
 */
function buildYesNoBlocks(context, slackUserId) {
  const ctx = JSON.stringify({
    issueKey: context.issueKey,
    question: (context.question || '').slice(0, 300),
    ...(context.transitionTo
      ? { transitionTo: context.transitionTo }
      : {
        jiraFieldId: context.jiraFieldId,
        jiraFieldName: context.jiraFieldName || context.jiraFieldId,
        jiraFieldValue: context.jiraFieldValue,
        jiraFieldType: context.jiraFieldType || 'select',
      }),
    slackUserId,
    allowFallback: !!context.allowFallback,
  });
  return [
    { type: 'section', text: { type: 'mrkdwn', text: yesNoHeadline(context) } },
    {
      type: 'actions',
      elements: [
        { type: 'button', text: { type: 'plain_text', text: 'Yes' }, style: 'primary', action_id: 'jira_confirm_yes', value: ctx },
        { type: 'button', text: { type: 'plain_text', text: 'No' }, action_id: 'jira_confirm_no', value: ctx },
        { type: 'button', text: { type: 'plain_text', text: '💬 Reply' }, action_id: 'jira_reply', value: ctx },
      ],
    },
  ];
}

/**
 * First contact with someone who hasn't connected Jira: nudge them to connect right here, so the
 * action is done as them rather than as the bot account.
 */
function connectBlocks(authUrl) {
  if (!authUrl) return [];
  return [
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: '🔐 *Not connected to Jira yet.* Connect once (takes ~10 seconds) so this and future changes appear under your name.',
      }],
    },
    {
      type: 'actions',
      elements: [{
        type: 'button',
        text: { type: 'plain_text', text: '🔗 Connect Jira', emoji: true },
        url: authUrl,
        action_id: 'dm_connect_jira',
      }],
    },
  ];
}

async function sendDmQuestion(client, slackUserId, context, _pendingQuestions, opsNotifier) {
  // Other ask types render their own message; same delivery contract.
  if (context.askType === 'risk_review') {
    // lazy require to avoid a circular import (riskReviewMessage → jiraLink only)
    const { sendRiskReview } = require('./riskReviewMessage');
    return sendRiskReview(client, slackUserId, context, opsNotifier);
  }
  if (context.askType === 'collect') {
    const { sendCollect } = require('./collectMessage');
    return sendCollect(client, slackUserId, context, opsNotifier);
  }

  const dm = await client.conversations.open({ users: slackUserId });
  const headline = yesNoHeadline(context);
  const result = await client.chat.postMessage({
    channel: dm.channel.id,
    text: headline,
    blocks: [...buildYesNoBlocks(context, slackUserId), ...connectBlocks(context.authUrl)],
  });

  await opsNotifier?.dmQuestionSent({
    slackUserId,
    issueKey: context.issueKey,
    question: context.question,
    fieldName: context.transitionTo ? 'status' : (context.jiraFieldName || context.jiraFieldId),
    fieldValue: context.transitionTo || context.jiraFieldValue,
  });

  return { channelId: dm.channel.id, messageTs: result.ts };
}

/**
 * Human-readable list of what an LLM decision would do to the issue (nothing is executed here).
 * @returns {string[]} mrkdwn lines; empty when the decision changes nothing
 */
function describeDecision(decision, context) {
  const d = decision || {};
  const lines = [];
  if (d.action === 'transition') {
    lines.push(`Move *${issueLink(context.issueKey)}* to *${d.transitionTo || context.transitionTo}*`);
  } else if (d.action === 'update_field') {
    if (context.transitionTo && !context.jiraFieldId) lines.push(`Move *${issueLink(context.issueKey)}* to *${context.transitionTo}*`);
    else lines.push(`Set *${context.jiraFieldName || context.jiraFieldId}* = *${d.fieldValue ?? context.jiraFieldValue}*`);
  }
  if (d.comment) lines.push(`Add a comment: "${String(d.comment).slice(0, 300)}"`);
  if (d.assignee) lines.push(`Assign to *${d.assignee}*`);
  return lines;
}

/**
 * Preview of an LLM-interpreted reply: what will happen, with Confirm / Edit reply / Cancel.
 * Nothing is written until Confirm. The compact decision rides in the button values.
 */
function buildReplyPreviewBlocks(context, decision, userText, slackUserId) {
  const lines = describeDecision(decision, context);
  const compact = {
    issueKey: context.issueKey,
    question: (context.question || '').slice(0, 200),
    transitionTo: context.transitionTo, jiraFieldId: context.jiraFieldId, jiraFieldName: context.jiraFieldName,
    jiraFieldValue: context.jiraFieldValue, jiraFieldType: context.jiraFieldType,
    slackUserId, allowFallback: !!context.allowFallback,
    dmChannelId: context.dmChannelId, messageTs: context.messageTs, originalText: (context.originalText || '').slice(0, 300),
    userText: (userText || '').slice(0, 400),
    decision: {
      action: decision.action, fieldValue: decision.fieldValue, transitionTo: decision.transitionTo,
      comment: decision.comment ? String(decision.comment).slice(0, 300) : undefined,
      assignee: decision.assignee, confirmationMessage: decision.confirmationMessage ? String(decision.confirmationMessage).slice(0, 200) : undefined,
    },
  };
  const value = JSON.stringify(compact);
  return [
    { type: 'section', text: { type: 'mrkdwn', text: `🤖 *Here's what I understood — nothing is changed yet:*\n${lines.map((l) => `• ${l}`).join('\n')}` } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `Your reply: "${(userText || '').slice(0, 200)}"` }] },
    {
      type: 'actions',
      elements: [
        { type: 'button', style: 'primary', text: { type: 'plain_text', text: '✅ Confirm', emoji: true }, action_id: 'jira_reply_confirm', value },
        { type: 'button', text: { type: 'plain_text', text: '✏️ Edit reply', emoji: true }, action_id: 'jira_reply_edit', value },
        { type: 'button', text: { type: 'plain_text', text: 'Cancel', emoji: true }, action_id: 'jira_reply_cancel', value },
      ],
    },
  ];
}

module.exports = { sendDmQuestion, buildYesNoBlocks, connectBlocks, yesNoHeadline, describeDecision, buildReplyPreviewBlocks };
