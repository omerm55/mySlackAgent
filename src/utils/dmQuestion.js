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

module.exports = { sendDmQuestion, buildYesNoBlocks, connectBlocks, yesNoHeadline };
