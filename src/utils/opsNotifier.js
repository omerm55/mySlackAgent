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
  async jiraTriggered({ trigger, actorName, slackUserId, issueKey, fieldName, fieldValue, success, error, usingOAuth }) {
    const who = actorName ? `*${actorName}*` : `<@${slackUserId}>`;
    const icon = trigger === '👍 reaction' ? '👍' : '💬';
    const auth = usingOAuth === true ? '_(OAuth ✅)_' : usingOAuth === false ? '_(no OAuth — acting as bot)_' : '';
    if (success) {
      await this.post(`${icon} ${who} triggered via ${trigger} → *${issueKey}* updated: *${fieldName}* = *${fieldValue}* ${auth}`.trim());
    } else {
      await this.post(`${icon} ${who} triggered via ${trigger} → ❌ failed to update *${issueKey}*: ${error}`);
    }
  }

  // Dev owner acted on a risk-review DM (R&D Initiative Notifier loop)
  async riskReviewAction({ slackUserId, issueKey, action, detail, usingOAuth, error }) {
    const auth = usingOAuth === true ? '_(OAuth ✅)_' : usingOAuth === false ? '_(no OAuth — acting as bot)_' : '';
    if (error) {
      await this.post(`🩺 <@${slackUserId}> · *${issueKey}* · ${action} → ❌ ${error}`);
      return;
    }
    await this.post(`🩺 <@${slackUserId}> · *${issueKey}* · ${action}${detail ? ` — ${detail}` : ''} ${auth}`.trim());
  }

  // Someone answered (or skipped) a collect ask — fields filled from free text
  async collectAction({ slackUserId, issueKey, action, detail, usingOAuth, error }) {
    const auth = usingOAuth === true ? '_(OAuth ✅)_' : usingOAuth === false ? '_(no OAuth — acting as bot)_' : '';
    if (error) {
      await this.post(`📝 <@${slackUserId}> · *${issueKey}* · ${action} → ❌ ${error}`);
      return;
    }
    await this.post(`📝 <@${slackUserId}> · *${issueKey}* · ${action}${detail ? ` — ${detail}` : ''} ${auth}`.trim());
  }

  // Jira poller matched an issue but could not DM anyone
  async jiraTriggerSkipped({ trigger, issueKey, reason }) {
    await this.post(`🔍 Jira trigger *${trigger}* matched *${issueKey}* — skipped: ${reason}`);
  }

  // Reaction caught but filtered before Jira update (debug visibility)
  async reactionFiltered({ slackUserId, reason, integration }) {
    await this.post(`👍 <@${slackUserId}> reacted in *${integration}* — filtered: ${reason}`);
  }

  // Bot sent a DM question to a user
  async dmQuestionSent({ slackUserId, issueKey, question, fieldName, fieldValue }) {
    await this.post(
      `📨 Bot asked <@${slackUserId}> about *${issueKey}*: "${question}" _(${fieldName} → ${fieldValue})_`
    );
  }

  // User clicked Yes/No on a DM question
  async dmButtonClicked({ action, slackUserId, issueKey, fieldName, fieldValue, error, usingOAuth }) {
    const auth = usingOAuth === true ? '_(OAuth ✅)_' : usingOAuth === false ? '_(no OAuth — acting as bot)_' : '';
    if (action === 'yes') {
      if (!error) {
        await this.post(`✅ <@${slackUserId}> clicked *Yes* → *${issueKey}* *${fieldName}* = *${fieldValue}* updated ${auth}`.trim());
      } else {
        await this.post(`✅ <@${slackUserId}> clicked *Yes* → ❌ failed to update *${issueKey}*: ${error}`);
      }
    } else {
      await this.post(`🚫 <@${slackUserId}> clicked *No* → no changes to *${issueKey}*`);
    }
  }

  // User submitted a free-text reply; LLM interpreted it and the person is looking at the preview
  async dmLlmProposed({ slackUserId, issueKey, userText, decision }) {
    const parts = [`action: *${decision.action}*`];
    if (decision.fieldValue) parts.push(`value: *${decision.fieldValue}*`);
    if (decision.transitionTo) parts.push(`move to: *${decision.transitionTo}*`);
    if (decision.comment) parts.push(`comment: "${decision.comment}"`);
    if (decision.assignee) parts.push(`assign to: *${decision.assignee}*`);
    await this.post(`🤖 <@${slackUserId}> replied to *${issueKey}*: "${userText}"\n→ LLM proposes: ${parts.join(' | ')} — waiting for their Confirm`);
  }

  // User submitted a free-text reply; LLM interpreted it
  async dmLlmDecision({ slackUserId, issueKey, userText, decision, error }) {
    if (error) {
      await this.post(`🤖 <@${slackUserId}> replied to *${issueKey}*: "${userText}" → ❌ LLM error: ${error}`);
      return;
    }
    const parts = [`action: *${decision.action}*`];
    if (decision.fieldValue) parts.push(`value: *${decision.fieldValue}*`);
    if (decision.transitionTo) parts.push(`move to: *${decision.transitionTo}*`);
    if (decision.comment) parts.push(`comment: "${decision.comment}"`);
    if (decision.assignee) parts.push(`assign to: *${decision.assignee}*`);
    await this.post(
      `🤖 <@${slackUserId}> replied to *${issueKey}*: "${userText}"\n→ LLM: ${parts.join(' | ')}\n→ ${decision.confirmationMessage || 'Done'}`
    );
  }
}

module.exports = OpsNotifier;
