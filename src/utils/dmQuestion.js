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

  // Button values are capped at 2000 chars — keep the question short in ctx.
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
  });

  // Only prefix the key when the question doesn't already name the issue
  const headline = mentionsIssue(context.question, context.issueKey)
    ? context.question
    : `*${issueLink(context.issueKey)}*: ${context.question}`;
  // First contact with someone who hasn't connected Jira: nudge them to connect
  // right here, so the action is done as them rather than as the bot account.
  const connectBlocks = context.authUrl ? [
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: '🔐 *Not connected to Jira yet.* Connect once (takes ~10 seconds) so this and future changes appear under your name. Until then, changes are made by the bot account.',
      }],
    },
    {
      type: 'actions',
      elements: [{
        type: 'button',
        text: { type: 'plain_text', text: '🔗 Connect Jira', emoji: true },
        url: context.authUrl,
        action_id: 'dm_connect_jira',
      }],
    },
  ] : [];

  const result = await client.chat.postMessage({
    channel: dm.channel.id,
    text: headline,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: headline },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Yes' },
            style: 'primary',
            action_id: 'jira_confirm_yes',
            value: ctx,
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'No' },
            action_id: 'jira_confirm_no',
            value: ctx,
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: '💬 Reply' },
            action_id: 'jira_reply',
            value: ctx,
          },
        ],
      },
      ...connectBlocks,
    ],
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

module.exports = { sendDmQuestion };
