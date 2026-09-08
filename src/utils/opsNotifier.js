'use strict';

class OpsNotifier {
  constructor(client, channelId) {
    this.client = client;
    this.channelId = channelId;
  }

  async post(text) {
    if (!this.channelId || !this.client) return;
    await this.client.chat.postMessage({ channel: this.channelId, text }).catch(() => {});
  }

  // 👍 reaction or thread reply triggered a Jira update
  async jiraTriggered({ trigger, actorName, slackUserId, issueKey, fieldName, fieldValue, success, error }) {
    const who = actorName ? `*${actorName}*` : `<@${slackUserId}>`;
    const icon = trigger === '👍 reaction' ? '👍' : '💬';
    if (success) {
      await this.post(`${icon} ${who} triggered via ${trigger} → *${issueKey}* updated: *${fieldName}* = *${fieldValue}*`);
    } else {
      await this.post(`${icon} ${who} triggered via ${trigger} → ❌ failed to update *${issueKey}*: ${error}`);
    }
  }

  // Bot sent a DM question to a user
  async dmQuestionSent({ slackUserId, issueKey, question, fieldName, fieldValue }) {
    await this.post(
      `📨 Bot asked <@${slackUserId}> about *${issueKey}*: "${question}" _(${fieldName} → ${fieldValue})_`
    );
  }

  // User clicked Yes/No on a DM question
  async dmButtonClicked({ action, slackUserId, issueKey, fieldName, fieldValue, error }) {
    if (action === 'yes') {
      if (!error) {
        await this.post(`✅ <@${slackUserId}> clicked *Yes* → *${issueKey}* *${fieldName}* = *${fieldValue}* updated`);
      } else {
        await this.post(`✅ <@${slackUserId}> clicked *Yes* → ❌ failed to update *${issueKey}*: ${error}`);
      }
    } else {
      await this.post(`🚫 <@${slackUserId}> clicked *No* → no changes to *${issueKey}*`);
    }
  }

  // User submitted a free-text reply; LLM interpreted it
  async dmLlmDecision({ slackUserId, issueKey, userText, decision, error }) {
    if (error) {
      await this.post(`🤖 <@${slackUserId}> replied to *${issueKey}*: "${userText}" → ❌ LLM error: ${error}`);
      return;
    }
    const parts = [`action: *${decision.action}*`];
    if (decision.fieldValue) parts.push(`value: *${decision.fieldValue}*`);
    if (decision.comment) parts.push(`comment: "${decision.comment}"`);
    if (decision.assignee) parts.push(`assign to: *${decision.assignee}*`);
    await this.post(
      `🤖 <@${slackUserId}> replied to *${issueKey}*: "${userText}"\n→ LLM: ${parts.join(' | ')}\n→ ${decision.confirmationMessage || 'Done'}`
    );
  }
}

module.exports = OpsNotifier;
