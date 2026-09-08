'use strict';

const { sendDmQuestion } = require('../utils/dmQuestion');

const MAX_NEW_PROMPTS_PER_TRIGGER_PER_RUN = 10;

/**
 * Polls Jira on an interval for each active "Jira trigger" stored in Supabase.
 *
 * A Jira trigger = { jql, question, notify: 'reporter'|'assignee',
 *                    action_type: 'transition'|'field', transition_to | jira_field_* }
 *
 * For every issue the JQL returns that has not been prompted before, the
 * target person is resolved to a Slack user by email and sent a Yes/No/Reply
 * DM. The prompt is recorded in jira_prompts so each issue is asked once.
 */
class JiraPoller {
  /**
   * @param {object} deps
   * @param {import('./jiraService')} deps.jiraService     service-account client (for JQL)
   * @param {import('./supabaseService')} deps.db
   * @param {import('@slack/bolt').App['client']} deps.slackClient
   * @param {import('../utils/opsNotifier')} [deps.opsNotifier]
   * @param {import('pino').Logger} deps.logger
   * @param {number} [deps.intervalMs]
   */
  constructor({ jiraService, db, slackClient, opsNotifier, logger, intervalMs = 120_000 }) {
    this.jira = jiraService;
    this.db = db;
    this.slack = slackClient;
    this.ops = opsNotifier;
    this.logger = logger;
    this.intervalMs = intervalMs;
    this.emailToSlack = new Map(); // email → slackUserId | null
    this._timer = null;
    this._running = false;
  }

  start() {
    if (!this.db) {
      this.logger.warn('[jiraPoller] Supabase not configured — Jira triggers disabled');
      return;
    }
    this.logger.info(`[jiraPoller] Started, polling every ${Math.round(this.intervalMs / 1000)}s`);
    // First run shortly after boot, then on the interval
    setTimeout(() => this.runOnce(), 5_000);
    this._timer = setInterval(() => this.runOnce(), this.intervalMs);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
  }

  async runOnce() {
    if (this._running) return; // skip overlapping runs
    this._running = true;
    try {
      const triggers = await this.db.getActiveJiraTriggers();
      for (const trigger of triggers) {
        try {
          await this._evaluateTrigger(trigger);
        } catch (err) {
          this.logger.error(`[jiraPoller] Trigger "${trigger.name}" failed: ${err.message}`);
        }
      }
    } catch (err) {
      this.logger.error(`[jiraPoller] Could not load triggers: ${err.message}`);
    } finally {
      this._running = false;
    }
  }

  async _evaluateTrigger(trigger) {
    const tag = `[jiraPoller/${trigger.name}]`;
    const issues = await this.jira.searchIssues(trigger.jql, ['summary', 'status', 'reporter', 'assignee']);
    if (issues.length === 0) return;

    const prompted = await this.db.getPromptedIssueKeys(trigger.id);
    const fresh = issues.filter((i) => !prompted.has(i.key));
    if (fresh.length === 0) return;

    this.logger.info(`${tag} ${issues.length} match, ${fresh.length} new`);

    let sent = 0;
    for (const issue of fresh) {
      if (sent >= MAX_NEW_PROMPTS_PER_TRIGGER_PER_RUN) {
        this.logger.warn(`${tag} Reached ${MAX_NEW_PROMPTS_PER_TRIGGER_PER_RUN} prompts this run — rest deferred to next run`);
        break;
      }

      const person = trigger.notify === 'assignee' ? issue.fields.assignee : issue.fields.reporter;
      const email = person?.emailAddress;
      const displayName = person?.displayName || trigger.notify;

      if (!email) {
        this.logger.warn(`${tag} ${issue.key}: no email on ${trigger.notify} (${displayName}) — skipping`);
        await this.db.recordPrompt(trigger.id, issue.key, null); // don't retry every run
        await this.ops?.jiraTriggerSkipped?.({ trigger: trigger.name, issueKey: issue.key, reason: `no email for ${trigger.notify} ${displayName}` });
        continue;
      }

      const slackUserId = await this._resolveSlackUser(email);
      if (!slackUserId) {
        this.logger.warn(`${tag} ${issue.key}: no Slack user for ${email} — skipping`);
        await this.db.recordPrompt(trigger.id, issue.key, null);
        await this.ops?.jiraTriggerSkipped?.({ trigger: trigger.name, issueKey: issue.key, reason: `no Slack user for ${email}` });
        continue;
      }

      // Personal-scope triggers only DM their creator
      if (trigger.scope === 'personal' && slackUserId !== trigger.created_by) {
        continue;
      }

      const question = renderTemplate(trigger.question, issue);
      const context = {
        issueKey: issue.key,
        question,
        ...(trigger.action_type === 'transition'
          ? { transitionTo: trigger.transition_to }
          : {
            jiraFieldId: trigger.jira_field_id,
            jiraFieldName: trigger.jira_field_name || trigger.jira_field_id,
            jiraFieldValue: trigger.jira_field_value,
            jiraFieldType: trigger.jira_field_type || 'select',
          }),
      };

      try {
        await sendDmQuestion(this.slack, slackUserId, context, null, this.ops);
        await this.db.recordPrompt(trigger.id, issue.key, slackUserId);
        sent += 1;
        this.logger.info(`${tag} DM sent to ${slackUserId} for ${issue.key}`);
      } catch (err) {
        this.logger.error(`${tag} Failed to DM ${slackUserId} for ${issue.key}: ${err.message}`);
      }
    }
  }

  async _resolveSlackUser(email) {
    const key = email.toLowerCase();
    if (this.emailToSlack.has(key)) return this.emailToSlack.get(key);
    let id = null;
    try {
      const res = await this.slack.users.lookupByEmail({ email });
      id = res.user?.id ?? null;
    } catch (err) {
      if (err.data?.error !== 'users_not_found') {
        this.logger.warn(`[jiraPoller] users.lookupByEmail failed for ${email}: ${err.data?.error || err.message}`);
      }
    }
    this.emailToSlack.set(key, id);
    return id;
  }
}

/** Replace {key}, {summary}, {status}, {reporter}, {assignee} in a question template. */
function renderTemplate(template, issue) {
  const f = issue.fields || {};
  return (template || 'Approve {key}?')
    .replace(/\{key\}/g, issue.key)
    .replace(/\{summary\}/g, f.summary || '')
    .replace(/\{status\}/g, f.status?.name || '')
    .replace(/\{reporter\}/g, f.reporter?.displayName || '')
    .replace(/\{assignee\}/g, f.assignee?.displayName || 'unassigned');
}

module.exports = JiraPoller;
