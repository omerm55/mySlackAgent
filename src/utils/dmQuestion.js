'use strict';

/**
 * Send a Yes/No question to a Slack user via DM and register the pending context.
 *
 * @param {import('@slack/bolt').App['client']} client
 * @param {string} slackUserId
 * @param {{ issueKey: string, question: string, jiraFieldId: string, jiraFieldName: string, jiraFieldValue: string, jiraFieldType: string }} context
 * @param {import('../services/pendingQuestions')} pendingQuestions
 * @returns {Promise<{ channelId: string, messageTs: string }>}
 */
async function sendDmQuestion(client, slackUserId, context, pendingQuestions) {
  const dm = await client.conversations.open({ users: slackUserId });
  const result = await client.chat.postMessage({
    channel: dm.channel.id,
    text: `*${context.issueKey}*: ${context.question}\n\nReply *Yes* or *No*.`,
  });
  pendingQuestions.add(dm.channel.id, result.ts, { ...context, slackUserId });
  return { channelId: dm.channel.id, messageTs: result.ts };
}

module.exports = { sendDmQuestion };
