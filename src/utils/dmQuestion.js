'use strict';

/**
 * Send a Yes/No question to a Slack user via DM using interactive buttons.
 * The full context is embedded in the button values so no in-memory lookup
 * is needed when the user clicks — works even if the process restarts.
 *
 * @param {import('@slack/bolt').App['client']} client
 * @param {string} slackUserId
 * @param {{ issueKey: string, question: string, jiraFieldId: string, jiraFieldName: string, jiraFieldValue: string, jiraFieldType: string }} context
 * @param {import('../services/pendingQuestions')} _pendingQuestions  kept for API compat, unused
 * @returns {Promise<{ channelId: string, messageTs: string }>}
 */
async function sendDmQuestion(client, slackUserId, context, _pendingQuestions) {
  const dm = await client.conversations.open({ users: slackUserId });

  const ctx = JSON.stringify({
    issueKey: context.issueKey,
    jiraFieldId: context.jiraFieldId,
    jiraFieldName: context.jiraFieldName || context.jiraFieldId,
    jiraFieldValue: context.jiraFieldValue,
    jiraFieldType: context.jiraFieldType || 'select',
    slackUserId,
  });

  const result = await client.chat.postMessage({
    channel: dm.channel.id,
    text: `*${context.issueKey}*: ${context.question}`,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*${context.issueKey}*: ${context.question}` },
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
    ],
  });

  return { channelId: dm.channel.id, messageTs: result.ts };
}

module.exports = { sendDmQuestion };
