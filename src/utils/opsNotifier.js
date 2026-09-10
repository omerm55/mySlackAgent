'use strict';

/**
 * Everything the operator sees, in one place: a line in the ops channel **and** a durable row in
 * `audit_events` (Supabase). The channel is where people look; the table is the record that outlives
 * Slack retention and can be queried ("who changed what, when, as whom").
 *
 * Every method funnels through `post(text, meta)`. `meta` is what makes the row queryable:
 *   kind   — event type, e.g. 'reaction_write', 'dm_yes', 'risk_action', 'llm_applied'
 *   user   — Slack user id the event is about
 *   issue  — Jira issue key
 *   ok     — false for failures
 *   detail — small structured extras (field, value, identity used, reason)
 * Neither the Slack post nor the insert is allowed to throw into the caller.
 */
class OpsNotifier {
  /**
   * @param {import('@slack/bolt').App['client']} client
   * @param {string} channelId
   * @param {import('../services/supabaseService')} [db]  durable audit sink
   */
  constructor(client, channelId, db = null) {
    this.client = client;
    this.channelId = channelId;
    this.db = db;
  }

  /** Attach the durable sink after construction. */
  setDb(db) { this.db = db; }

  /**
   * @param {string} text  the ops-channel message (mrkdwn)
   * @param {{kind?: string, user?: string|null, issue?: string|null, ok?: boolean, detail?: object}} [meta]
   */
  async post(text, meta = {}) {
    if (this.db?.insertAuditEvent) {
      // Fire and forget: the audit row must never delay or break the operator message.
      this.db.insertAuditEvent({
        kind: meta.kind || 'ops',
        slackUserId: meta.user ?? null,
        issueKey: meta.issue ?? null,
        ok: meta.ok !== false,
        text,
        detail: meta.detail ?? null,
      }).catch(() => {});
    }
    if (!this.channelId || !this.client) return;
    await this.client.chat.postMessage({ channel: this.channelId, text }).catch(() => {});
  }

  /** Identity marker shared by the action messages. */
  static _auth(usingOAuth) {
    return usingOAuth === true ? '_(OAuth ✅)_' : usingOAuth === false ? '_(no OAuth — acting as bot)_' : '';
  }
  static _identity(usingOAuth) {
    return usingOAuth === true ? 'user (OAuth)' : usingOAuth === false ? 'bot account' : 'unknown';
  }

  // 👍 reaction or thread reply triggered a Jira update
  async jiraTriggered({ trigger, actorName, slackUserId, issueKey, fieldName, fieldValue, success, error, usingOAuth }) {
    const who = actorName ? `*${actorName}*` : `<@${slackUserId}>`;
    const icon = trigger === '👍 reaction' ? '👍' : '💬';
    const auth = OpsNotifier._auth(usingOAuth);
    const meta = {
      kind: trigger === '👍 reaction' ? 'reaction_write' : 'reply_write',
      user: slackUserId, issue: issueKey, ok: !!success,
      detail: { trigger, fieldName, fieldValue, identity: OpsNotifier._identity(usingOAuth), ...(error ? { error } : {}) },
    };
    if (success) {
      await this.post(`${icon} ${who} triggered via ${trigger} → *${issueKey}* updated: *${fieldName}* = *${fieldValue}* ${auth}`.trim(), meta);
    } else {
      await this.post(`${icon} ${who} triggered via ${trigger} → ❌ failed to update *${issueKey}*: ${error}`, meta);
    }
  }

  // Dev owner acted on a risk-review DM (R&D Initiative Notifier loop)
  async riskReviewAction({ slackUserId, issueKey, action, detail, usingOAuth, error }) {
    const auth = OpsNotifier._auth(usingOAuth);
    const meta = {
      kind: 'risk_action', user: slackUserId, issue: issueKey, ok: !error,
      detail: { action, detail: detail ?? null, identity: OpsNotifier._identity(usingOAuth), ...(error ? { error } : {}) },
    };
    if (error) {
      await this.post(`🩺 <@${slackUserId}> · *${issueKey}* · ${action} → ❌ ${error}`, meta);
      return;
    }
    await this.post(`🩺 <@${slackUserId}> · *${issueKey}* · ${action}${detail ? ` — ${detail}` : ''} ${auth}`.trim(), meta);
  }

  // Someone answered (or skipped) a collect ask — fields filled from free text
  async collectAction({ slackUserId, issueKey, action, detail, usingOAuth, error }) {
    const auth = OpsNotifier._auth(usingOAuth);
    const meta = {
      kind: 'collect_action', user: slackUserId, issue: issueKey, ok: !error,
      detail: { action, detail: detail ?? null, identity: OpsNotifier._identity(usingOAuth), ...(error ? { error } : {}) },
    };
    if (error) {
      await this.post(`📝 <@${slackUserId}> · *${issueKey}* · ${action} → ❌ ${error}`, meta);
      return;
    }
    await this.post(`📝 <@${slackUserId}> · *${issueKey}* · ${action}${detail ? ` — ${detail}` : ''} ${auth}`.trim(), meta);
  }

  // Jira poller matched an issue but could not DM anyone
  async jiraTriggerSkipped({ trigger, issueKey, reason }) {
    await this.post(`🔍 Jira trigger *${trigger}* matched *${issueKey}* — skipped: ${reason}`,
      { kind: 'trigger_skipped', issue: issueKey, detail: { trigger, reason } });
  }

  // Reaction caught but filtered before Jira update (debug visibility)
  async reactionFiltered({ slackUserId, reason, integration }) {
    await this.post(`👍 <@${slackUserId}> reacted in *${integration}* — filtered: ${reason}`,
      { kind: 'reaction_filtered', user: slackUserId, detail: { integration, reason } });
  }

  // Bot sent a DM question to a user
  async dmQuestionSent({ slackUserId, issueKey, question, fieldName, fieldValue }) {
    await this.post(
      `📨 Bot asked <@${slackUserId}> about *${issueKey}*: "${question}" _(${fieldName} → ${fieldValue})_`,
      { kind: 'ask_sent', user: slackUserId, issue: issueKey, detail: { fieldName, fieldValue } },
    );
  }

  // User clicked Yes/No on a DM question
  async dmButtonClicked({ action, slackUserId, issueKey, fieldName, fieldValue, error, usingOAuth }) {
    const auth = OpsNotifier._auth(usingOAuth);
    const meta = {
      kind: action === 'yes' ? 'dm_yes' : 'dm_no', user: slackUserId, issue: issueKey, ok: !error,
      detail: { fieldName, fieldValue, identity: OpsNotifier._identity(usingOAuth), ...(error ? { error } : {}) },
    };
    if (action === 'yes') {
      if (!error) {
        await this.post(`✅ <@${slackUserId}> clicked *Yes* → *${issueKey}* *${fieldName}* = *${fieldValue}* updated ${auth}`.trim(), meta);
      } else {
        await this.post(`✅ <@${slackUserId}> clicked *Yes* → ❌ failed to update *${issueKey}*: ${error}`, meta);
      }
    } else {
      await this.post(`🚫 <@${slackUserId}> clicked *No* → no changes to *${issueKey}*`, meta);
    }
  }

  /** Compact "action: X | value: Y | …" used by both LLM lines. */
  static _decisionParts(decision) {
    const parts = [`action: *${decision.action}*`];
    if (decision.fieldValue) parts.push(`value: *${decision.fieldValue}*`);
    if (decision.transitionTo) parts.push(`move to: *${decision.transitionTo}*`);
    if (decision.comment) parts.push(`comment: "${decision.comment}"`);
    if (decision.assignee) parts.push(`assign to: *${decision.assignee}*`);
    return parts;
  }

  // Free-text reply interpreted; the person is looking at the preview (nothing written yet)
  async dmLlmProposed({ slackUserId, issueKey, userText, decision }) {
    await this.post(
      `🤖 <@${slackUserId}> replied to *${issueKey}*: "${userText}"\n→ LLM proposes: ${OpsNotifier._decisionParts(decision).join(' | ')} — waiting for their Confirm`,
      { kind: 'llm_proposed', user: slackUserId, issue: issueKey, detail: { decision, userText } },
    );
  }

  // Free-text reply confirmed and applied (or the LLM failed)
  async dmLlmDecision({ slackUserId, issueKey, userText, decision, error, usingOAuth }) {
    if (error) {
      await this.post(`🤖 <@${slackUserId}> replied to *${issueKey}*: "${userText}" → ❌ LLM error: ${error}`,
        { kind: 'llm_error', user: slackUserId, issue: issueKey, ok: false, detail: { error, userText } });
      return;
    }
    await this.post(
      `🤖 <@${slackUserId}> replied to *${issueKey}*: "${userText}"\n→ LLM: ${OpsNotifier._decisionParts(decision).join(' | ')}\n→ ${decision.confirmationMessage || 'Done'}`,
      { kind: 'llm_applied', user: slackUserId, issue: issueKey, detail: { decision, userText, identity: OpsNotifier._identity(usingOAuth) } },
    );
  }
}

module.exports = OpsNotifier;
