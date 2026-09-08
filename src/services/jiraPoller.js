'use strict';

const { sendDmQuestion } = require('../utils/dmQuestion');
const { issueLink, issueLinkLabelled } = require('../utils/jiraLink');

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
  constructor({ jiraService, db, slackClient, opsNotifier, logger, intervalMs = 60_000 }) {
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
    this.logger.info(`[jiraPoller] Started, ticking every ${Math.round(this.intervalMs / 1000)}s; each trigger runs on its own poll_interval_min`);
    // First tick shortly after boot, then on the interval
    setTimeout(() => this.runOnce(), 5_000);
    this._timer = setInterval(() => this.runOnce(), this.intervalMs);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
  }

  /**
   * Evaluate all triggers that are due. Pass { force: true } to ignore
   * poll_interval_min, or { onlyId } to run a single trigger (e.g. right
   * after it was created or edited).
   */
  /**
   * @returns {Promise<Array<{ trigger: object, matched: number, fresh: number, sent: number,
   *                            skipped: string[], sentTo: string[], error?: string }>>}
   *          one entry per trigger evaluated (empty if nothing was due)
   */
  async runOnce({ force = false, onlyId = null } = {}) {
    if (this._running) return []; // skip overlapping runs
    this._running = true;
    const results = [];
    try {
      let triggers = await this.db.getActiveJiraTriggers();
      if (onlyId) triggers = triggers.filter((t) => t.id === onlyId);
      const now = Date.now();
      for (const trigger of triggers) {
        if (!force && !isDue(trigger, now)) continue;
        try {
          results.push(await this._evaluateTrigger(trigger));
        } catch (err) {
          this.logger.error(`[jiraPoller] Trigger "${trigger.name}" failed: ${err.message}`);
          results.push({ trigger, matched: 0, fresh: 0, sent: 0, skipped: [], sentTo: [], error: err.message });
        } finally {
          // Record the evaluation even on failure so a broken JQL doesn't hammer Jira every tick
          await this.db.updateJiraTrigger(trigger.id, { last_polled_at: new Date().toISOString() })
            .catch((err) => this.logger.warn(`[jiraPoller] Could not stamp last_polled_at: ${err.message}`));
        }
      }
    } catch (err) {
      this.logger.error(`[jiraPoller] Could not load triggers: ${err.message}`);
    } finally {
      this._running = false;
    }
    return results;
  }

  async _evaluateTrigger(trigger) {
    const tag = `[jiraPoller/${trigger.name}]`;
    const stats = { trigger, matched: 0, fresh: 0, sent: 0, skipped: [], sentTo: [] };

    const issues = await this.jira.searchIssues(trigger.jql, ['summary', 'status', 'reporter', 'assignee']);
    stats.matched = issues.length;
    if (issues.truncated) {
      this.logger.warn(`${tag} JQL matches more than ${issues.length} issues — only the first ${issues.length} were evaluated this run`);
      stats.skipped.push(`JQL matches more than ${issues.length} issues; narrow it down`);
    }
    if (issues.length === 0) return stats;

    const prompted = await this.db.getPromptedIssueKeys(trigger.id);
    const fresh = issues.filter((i) => !prompted.has(i.key));
    stats.fresh = fresh.length;
    if (fresh.length === 0) return stats;

    this.logger.info(`${tag} ${issues.length} match, ${fresh.length} new`);

    let sent = 0;
    for (const issue of fresh) {
      if (sent >= MAX_NEW_PROMPTS_PER_TRIGGER_PER_RUN) {
        this.logger.warn(`${tag} Reached ${MAX_NEW_PROMPTS_PER_TRIGGER_PER_RUN} prompts this run — rest deferred to next run`);
        stats.skipped.push(`${fresh.length - sent} more deferred to the next run (cap ${MAX_NEW_PROMPTS_PER_TRIGGER_PER_RUN}/run)`);
        break;
      }

      const person = trigger.notify === 'assignee' ? issue.fields.assignee : issue.fields.reporter;
      const email = person?.emailAddress;
      const displayName = person?.displayName || trigger.notify;

      if (!email) {
        this.logger.warn(`${tag} ${issue.key}: no email on ${trigger.notify} (${displayName}) — skipping`);
        await this.db.recordPrompt(trigger.id, issue.key, null); // don't retry every run
        await this.ops?.jiraTriggerSkipped?.({ trigger: trigger.name, issueKey: issue.key, reason: `no email for ${trigger.notify} ${displayName}` });
        stats.skipped.push(`${issue.key}: no email for ${trigger.notify} ${displayName}`);
        continue;
      }

      const slackUserId = await this._resolveSlackUser(email);
      if (!slackUserId) {
        this.logger.warn(`${tag} ${issue.key}: no Slack user for ${email} — skipping`);
        await this.db.recordPrompt(trigger.id, issue.key, null);
        await this.ops?.jiraTriggerSkipped?.({ trigger: trigger.name, issueKey: issue.key, reason: `no Slack user for ${email}` });
        stats.skipped.push(`${issue.key}: no Slack user for ${email}`);
        continue;
      }

      // Personal-scope triggers only DM their creator
      if (trigger.scope === 'personal' && slackUserId !== trigger.created_by) {
        stats.skipped.push(`${issue.key}: personal trigger, ${displayName} is not the creator`);
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
        stats.sentTo.push(`${issue.key} → <@${slackUserId}>`);
        this.logger.info(`${tag} DM sent to ${slackUserId} for ${issue.key}`);
      } catch (err) {
        this.logger.error(`${tag} Failed to DM ${slackUserId} for ${issue.key}: ${err.message}`);
        stats.skipped.push(`${issue.key}: DM failed (${err.message})`);
      }
    }
    stats.sent = sent;
    return stats;
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

/** A trigger is due when it has never been polled or its interval has elapsed. */
function isDue(trigger, nowMs) {
  if (!trigger.last_polled_at) return true;
  const intervalMs = Math.max(1, Number(trigger.poll_interval_min) || 2) * 60_000;
  return nowMs - new Date(trigger.last_polled_at).getTime() >= intervalMs - 5_000; // 5s slack for tick jitter
}

// "{key}" immediately followed by "{summary}" with light glue between them:
// "{key} ({summary})", "{key}: {summary}", "{key} - {summary}", "{key} — {summary}", "{key} {summary}"
const KEY_AND_SUMMARY_RE = /\{key\}(\s*(?:[:\-–—|]\s*)?\(?)\{summary\}(\)?)/g;

/**
 * Replace placeholders in a question template.
 *   {key} ({summary}) / {key}: {summary} / … → ONE link labelled "KEY (summary)" etc.
 *   {link}             → link labelled "KEY (summary)"
 *   {key}              → link labelled "KEY"
 *   {summary} {status} {reporter} {assignee} → plain text
 * Summaries containing "|" are made link-safe automatically.
 */
function renderTemplate(template, issue) {
  const f = issue.fields || {};
  const summary = f.summary || '';
  const combined = issueLinkLabelled(issue.key, summary ? `${issue.key} (${summary})` : issue.key);
  return (template || 'Approve {link}?')
    .replace(KEY_AND_SUMMARY_RE, (_m, glue, close) =>
      issueLinkLabelled(issue.key, `${issue.key}${glue}${summary}${close}`))
    .replace(/\{link\}/g, combined)
    .replace(/\{key\}/g, issueLink(issue.key))
    .replace(/\{summary\}/g, summary)
    .replace(/\{status\}/g, f.status?.name || '')
    .replace(/\{reporter\}/g, f.reporter?.displayName || '')
    .replace(/\{assignee\}/g, f.assignee?.displayName || 'unassigned');
}

module.exports = JiraPoller;
module.exports.renderTemplate = renderTemplate;
