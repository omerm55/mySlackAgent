'use strict';

const { sendDmQuestion } = require('../utils/dmQuestion');
const { issueLink, issueLinkLabelled } = require('../utils/jiraLink');
const { FIELDS: RISK_FIELDS, riskContextFor, sendFyi, notificationAge, notificationMatches } = require('../utils/riskReviewMessage');
const { collectContextFor, ROADMAP_FIELDS } = require('../utils/collectMessage');

// Risk reviews only act on a notification from the latest weekly notifier run; older stamps are
// leftovers the notifier never clears (env RISK_NOTIFICATION_MAX_AGE_DAYS, default 8).
const RISK_MAX_AGE_DAYS = Math.max(1, parseInt(process.env.RISK_NOTIFICATION_MAX_AGE_DAYS || '8', 10) || 8);
// …and only when the notification is about the condition we focus on (case-insensitive regex; set the
// env var to an empty string to review every flagged Initiative).
const RISK_MATCH = process.env.RISK_NOTIFICATION_MATCH === undefined ? 'progress red' : process.env.RISK_NOTIFICATION_MATCH.trim();

const normalizeWatched = (v) => (v === null || v === undefined ? '' : String(typeof v === 'object' ? JSON.stringify(v) : v).trim());
const firstUser = (v) => (Array.isArray(v) ? v[0] : v) || null;

/** The user-picker field whose person gets an FYI (explicit, else PM owner for risk reviews). */
function fyiFieldFor(trigger) {
  return trigger.fyi_field_id || (trigger.ask_type === 'risk_review' ? RISK_FIELDS.PM_OWNER : null);
}

/**
 * Who to DM for an issue, per the trigger's `notify`:
 *   reporter | assignee | user_field (notify_field_id → first user → fallback assignee → reporter)
 * @returns {{ person: object|null, source: string }}
 */
function resolvePerson(issue, trigger) {
  const f = issue.fields || {};
  const first = (v) => (Array.isArray(v) ? v[0] : v) || null;
  if (trigger.notify === 'user_field' && trigger.notify_field_id) {
    const p = first(f[trigger.notify_field_id]);
    if (p?.emailAddress) return { person: p, source: trigger.notify_field_id };
    if (f.assignee?.emailAddress) return { person: f.assignee, source: 'assignee (fallback)' };
    return { person: f.reporter || null, source: 'reporter (fallback)' };
  }
  if (trigger.notify === 'assignee') return { person: f.assignee || null, source: 'assignee' };
  return { person: f.reporter || null, source: 'reporter' };
}

/** Fields to request from Jira for a trigger. */
function fieldsFor(trigger) {
  const fields = new Set(['summary', 'status', 'reporter', 'assignee']);
  if (trigger.notify === 'user_field' && trigger.notify_field_id) fields.add(trigger.notify_field_id);
  if (trigger.watch_field) fields.add(trigger.watch_field);
  if (trigger.ask_type === 'risk_review') { fields.add(RISK_FIELDS.NOTIFICATION); fields.add(RISK_FIELDS.TARGET); fields.add(RISK_FIELDS.NOTES); }
  if (trigger.ask_type === 'collect') {
    for (const cf of trigger.collect_fields || []) if (cf?.id) fields.add(cf.id);
    fields.add(ROADMAP_FIELDS.CERTIFIED); fields.add(ROADMAP_FIELDS.TIMING); // for the "why this matters" line
  }
  const fyi = fyiFieldFor(trigger);
  if (fyi) fields.add(fyi);
  return [...fields];
}

// How many people one trigger may DM per run (env JIRA_MAX_PROMPTS_PER_RUN, default 10).
const MAX_NEW_PROMPTS_PER_TRIGGER_PER_RUN = Math.max(1, parseInt(process.env.JIRA_MAX_PROMPTS_PER_RUN || '10', 10) || 10);

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
  constructor({ jiraService, db, slackClient, opsNotifier, oauthService = null, logger, intervalMs = 60_000 }) {
    this.jira = jiraService;
    this.db = db;
    this.slack = slackClient;
    this.ops = opsNotifier;
    this.oauth = oauthService;
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

  /** Per-run cache of user notification preferences (immediate vs digest). */
  async _digestFrequency(slackUserId, cache) {
    if (cache.has(slackUserId)) return cache.get(slackUserId);
    let freq = 'immediate';
    try {
      const pref = await this.db.getUserPreference?.(slackUserId);
      if (pref?.digest_frequency) freq = pref.digest_frequency;
    } catch (err) {
      this.logger.warn(`[jiraPoller] Could not read preference for ${slackUserId}: ${err.message}`);
    }
    cache.set(slackUserId, freq);
    return freq;
  }

  async _evaluateTrigger(trigger) {
    const tag = `[jiraPoller/${trigger.name}]`;
    const stats = { trigger, matched: 0, fresh: 0, sent: 0, queued: 0, fyi: 0, pilotSkipped: 0, stale: 0, offTopic: 0, skipped: [], sentTo: [], queuedFor: [] };
    const prefCache = new Map();
    // Pilot list: only these Slack users are asked / FYI'd while it is set
    const pilot = Array.isArray(trigger.pilot_slack_user_ids) && trigger.pilot_slack_user_ids.length
      ? new Set(trigger.pilot_slack_user_ids) : null;
    const inPilot = (id) => !pilot || pilot.has(id);

    const issues = await this.jira.searchIssues(trigger.jql, fieldsFor(trigger));
    stats.matched = issues.length;
    if (issues.truncated) {
      this.logger.warn(`${tag} JQL matches more than ${issues.length} issues — only the first ${issues.length} were evaluated this run`);
      stats.skipped.push(`JQL matches more than ${issues.length} issues; narrow it down`);
    }
    if (issues.length === 0) return stats;

    // Which issues were already asked about? With a watch_field, an issue whose watched value
    // changed since we asked is asked again (e.g. the notifier rewrote "Latest notification").
    let fresh;
    if (trigger.watch_field) {
      const rows = await this.db.getPromptsForTrigger(trigger.id);
      const byKey = new Map(rows.map((r) => [r.issue_key, r]));
      fresh = [];
      let reasked = 0;
      for (const issue of issues) {
        const row = byKey.get(issue.key);
        const current = normalizeWatched(issue.fields?.[trigger.watch_field]);
        if (!row) { fresh.push(issue); continue; }
        const stored = row.payload?.watchedValue;
        if (stored === undefined) {
          // Row predates watch_field: remember the current value, don't re-ask now
          await this.db.updatePromptPayload(row.id, { ...(row.payload || {}), watchedValue: current }).catch(() => {});
          continue;
        }
        if (normalizeWatched(stored) !== current) {
          await this.db.deletePromptsForIssue(issue.key, row.slack_user_id || null);
          fresh.push(issue);
          reasked += 1;
        }
      }
      if (reasked) stats.skipped.push(`${reasked} re-asked because ${trigger.watch_field} changed`);
    } else {
      const prompted = await this.db.getPromptedIssueKeys(trigger.id);
      fresh = issues.filter((i) => !prompted.has(i.key));
    }
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

      // Risk review: ignore notifications older than the latest weekly run (not recorded, so a
      // fresh stamp next week asks normally)
      if (trigger.ask_type === 'risk_review') {
        const text = issue.fields?.[RISK_FIELDS.NOTIFICATION];
        const { stale, ageDays } = notificationAge(text, new Date(), RISK_MAX_AGE_DAYS);
        if (ageDays === null) this.logger.warn(`${tag} ${issue.key}: notification has no recognisable date stamp — treating as fresh: "${String(text).slice(0, 60)}"`);
        if (stale) {
          stats.stale += 1;
          this.logger.info(`${tag} ${issue.key}: notification is ${ageDays}d old (> ${RISK_MAX_AGE_DAYS}d) — skipping`);
          continue;
        }
        if (!notificationMatches(text, RISK_MATCH)) {
          stats.offTopic += 1;
          this.logger.info(`${tag} ${issue.key}: notification does not mention /${RISK_MATCH}/i — skipping: "${String(text).slice(0, 80)}"`);
          continue;
        }
      }

      const { person, source } = resolvePerson(issue, trigger);
      const email = person?.emailAddress;
      const displayName = person?.displayName || source;
      const watchedValue = trigger.watch_field ? normalizeWatched(issue.fields?.[trigger.watch_field]) : undefined;
      const skipPayload = watchedValue === undefined ? null : { watchedValue };

      if (!email) {
        this.logger.warn(`${tag} ${issue.key}: no email on ${source} (${displayName}) — skipping`);
        await this.db.recordPrompt(trigger.id, issue.key, null, { payload: skipPayload }); // don't retry every run
        await this.ops?.jiraTriggerSkipped?.({ trigger: trigger.name, issueKey: issue.key, reason: `no email for ${source} ${displayName}` });
        stats.skipped.push(`${issue.key}: no email for ${source} ${displayName}`);
        continue;
      }

      const slackUserId = await this._resolveSlackUser(email);
      if (!slackUserId) {
        this.logger.warn(`${tag} ${issue.key}: no Slack user for ${email} — skipping`);
        await this.db.recordPrompt(trigger.id, issue.key, null, { payload: skipPayload });
        await this.ops?.jiraTriggerSkipped?.({ trigger: trigger.name, issueKey: issue.key, reason: `no Slack user for ${email}` });
        stats.skipped.push(`${issue.key}: no Slack user for ${email}`);
        continue;
      }

      // Personal-scope triggers only DM their creator
      if (trigger.scope === 'personal' && slackUserId !== trigger.created_by) {
        stats.skipped.push(`${issue.key}: personal trigger, ${displayName} is not the creator`);
        continue;
      }

      // Pilot list: skip (without recording) anyone not on it, so they are asked once the list is cleared
      if (!inPilot(slackUserId)) {
        stats.pilotSkipped += 1;
        continue;
      }

      const question = renderTemplate(trigger.question, issue);
      const payload = trigger.ask_type === 'risk_review'
        ? {
          askType: 'risk_review',
          issueKey: issue.key,
          question,
          risk: riskContextFor(issue),
        }
        : trigger.ask_type === 'collect'
          ? {
            askType: 'collect',
            issueKey: issue.key,
            question,
            collect: collectContextFor(issue, trigger),
          }
          : {
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
      if (watchedValue !== undefined) payload.watchedValue = watchedValue;

      // Optional FYI to a second person (e.g. the PM owner): informational, sent right away,
      // skipped when it's the same person we're asking. Carried in the payload so the
      // Dev owner's actions can be echoed to them later.
      const fyiFieldId = fyiFieldFor(trigger);
      let fyiSlackUserId = null;
      if (fyiFieldId) {
        const fyiPerson = firstUser(issue.fields?.[fyiFieldId]);
        if (fyiPerson?.emailAddress) {
          const id = await this._resolveSlackUser(fyiPerson.emailAddress);
          if (id && id !== slackUserId && inPilot(id)) fyiSlackUserId = id;
        }
      }
      if (fyiSlackUserId) {
        payload.fyiSlackUserId = fyiSlackUserId;
        try {
          await sendFyi(this.slack, fyiSlackUserId, payload, slackUserId, this.ops);
          stats.fyi += 1;
        } catch (err) {
          this.logger.warn(`${tag} FYI to ${fyiSlackUserId} for ${issue.key} failed: ${err.message}`);
        }
      }

      // Respect the user's notification preference: queue for a digest, or send now.
      const frequency = await this._digestFrequency(slackUserId, prefCache);
      if (frequency !== 'immediate') {
        try {
          await this.db.recordPrompt(trigger.id, issue.key, slackUserId, { payload, delivered: false });
          stats.queued += 1;
          stats.queuedFor.push(`${issue.key} → <@${slackUserId}> (${frequency})`);
          this.logger.info(`${tag} Queued ${issue.key} for ${slackUserId}'s ${frequency} digest`);
        } catch (err) {
          this.logger.error(`${tag} Failed to queue ${issue.key} for ${slackUserId}: ${err.message}`);
          stats.skipped.push(`${issue.key}: queue failed (${err.message})`);
        }
        continue;
      }

      // Not connected yet? Put a Connect button right in the question DM.
      const authUrl = this.oauth && !this.oauth.hasToken(slackUserId)
        ? this.oauth.generateAuthUrl(slackUserId)
        : null;
      const context = { ...payload, ...(authUrl ? { authUrl } : {}) };

      try {
        await sendDmQuestion(this.slack, slackUserId, context, null, this.ops);
        await this.db.recordPrompt(trigger.id, issue.key, slackUserId, { payload });
        sent += 1;
        stats.sentTo.push(`${issue.key} → <@${slackUserId}>`);
        this.logger.info(`${tag} DM sent to ${slackUserId} for ${issue.key}`);
      } catch (err) {
        this.logger.error(`${tag} Failed to DM ${slackUserId} for ${issue.key}: ${err.message}`);
        stats.skipped.push(`${issue.key}: DM failed (${err.message})`);
      }
    }
    stats.sent = sent;
    if (stats.pilotSkipped) stats.skipped.push(`${stats.pilotSkipped} outside the pilot list (not recorded)`);
    if (stats.stale) stats.skipped.push(`${stats.stale} stale notification(s) older than ${RISK_MAX_AGE_DAYS} days (not recorded)`);
    if (stats.offTopic) stats.skipped.push(`${stats.offTopic} notification(s) not about "${RISK_MATCH}" (not recorded)`);
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
module.exports.resolvePerson = resolvePerson;
module.exports.fieldsFor = fieldsFor;
module.exports.fyiFieldFor = fyiFieldFor;
