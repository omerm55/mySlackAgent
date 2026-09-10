'use strict';

const axios = require('axios');

/**
 * Minimal Supabase REST API client using axios (no SDK needed).
 * Uses the secret key for server-side access (bypasses RLS).
 */
class SupabaseService {
  constructor({ url, secretKey }) {
    this.client = axios.create({
      baseURL: `${url}/rest/v1`,
      headers: {
        apikey: secretKey,
        Authorization: `Bearer ${secretKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      timeout: 10_000,
    });
  }

  static fromEnv() {
    const url = process.env.SUPABASE_URL;
    const secretKey = process.env.SUPABASE_SECRET_KEY;
    if (!url || !secretKey) return null;
    return new SupabaseService({ url, secretKey });
  }

  // ── oauth_tokens ────────────────────────────────────────────────

  async upsertToken(slackUserId, { accessToken, refreshToken, expiresAt, cloudId }) {
    await this.client.post('/oauth_tokens', {
      slack_user_id: slackUserId,
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_at: new Date(expiresAt).toISOString(),
      cloud_id: cloudId,
      updated_at: new Date().toISOString(),
    }, { params: { on_conflict: 'slack_user_id' }, headers: { Prefer: 'resolution=merge-duplicates,return=minimal' } });
  }

  async getToken(slackUserId) {
    const res = await this.client.get('/oauth_tokens', {
      params: { slack_user_id: `eq.${slackUserId}`, select: '*', limit: 1 },
    });
    const row = res.data?.[0];
    if (!row) return null;
    return {
      accessToken: row.access_token,
      refreshToken: row.refresh_token,
      expiresAt: new Date(row.expires_at).getTime(),
      cloudId: row.cloud_id,
    };
  }

  async getAllTokens() {
    const res = await this.client.get('/oauth_tokens', { params: { select: '*' } });
    return res.data ?? [];
  }

  async deleteToken(slackUserId) {
    await this.client.delete('/oauth_tokens', {
      params: { slack_user_id: `eq.${slackUserId}` },
    });
  }

  // ── oauth_states (pending Connect links: random, single-use, expiring) ──

  async insertOauthState({ state, slackUserId, expiresAt }) {
    await this.client.post('/oauth_states', {
      state, slack_user_id: slackUserId, expires_at: new Date(expiresAt).toISOString(),
    }, { headers: { Prefer: 'return=minimal' } });
  }

  /**
   * Mark a state used and return its row — atomically, so a second call with the same state (or an
   * expired one) returns null. PostgREST: conditional UPDATE with return=representation.
   */
  async consumeOauthState(state) {
    const now = new Date().toISOString();
    const res = await this.client.patch('/oauth_states', { used_at: now }, {
      params: { state: `eq.${state}`, used_at: 'is.null', expires_at: `gt.${now}` },
      headers: { Prefer: 'return=representation' },
    });
    return res.data?.[0] ?? null;
  }

  /** Delete states that expired more than a day ago (used or not). */
  async pruneOauthStates() {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    await this.client.delete('/oauth_states', { params: { expires_at: `lt.${cutoff}` } });
  }

  // ── integrations ─────────────────────────────────────────────────

  async getActiveIntegrations() {
    const res = await this.client.get('/integrations', {
      params: { active: 'eq.true', select: '*', order: 'created_at.asc' },
    });
    return res.data ?? [];
  }

  async getIntegrationsByUser(slackUserId) {
    const res = await this.client.get('/integrations', {
      params: { created_by: `eq.${slackUserId}`, select: '*', order: 'created_at.asc' },
    });
    return res.data ?? [];
  }

  async upsertIntegration(integration) {
    const res = await this.client.post('/integrations', integration,
      { headers: { Prefer: 'resolution=merge-duplicates,return=representation' } }
    );
    return res.data?.[0];
  }

  async updateIntegration(id, fields) {
    await this.client.patch('/integrations', fields, {
      params: { id: `eq.${id}` },
      headers: { Prefer: 'return=minimal' },
    });
  }

  async deactivateIntegration(id) {
    await this.updateIntegration(id, { active: false });
  }

  // ── jira_triggers (JQL-polled, DM-driven) ─────────────────────────────

  async getActiveJiraTriggers() {
    const res = await this.client.get('/jira_triggers', {
      params: { active: 'eq.true', select: '*', order: 'created_at.asc' },
    });
    return res.data ?? [];
  }

  async insertJiraTrigger(trigger) {
    const res = await this.client.post('/jira_triggers', trigger,
      { headers: { Prefer: 'return=representation' } },
    );
    return res.data?.[0];
  }

  async updateJiraTrigger(id, fields) {
    await this.client.patch('/jira_triggers', fields, {
      params: { id: `eq.${id}` },
      headers: { Prefer: 'return=minimal' },
    });
  }

  async deactivateJiraTrigger(id) {
    await this.updateJiraTrigger(id, { active: false });
  }

  // ── release_calendar (version name → branch-out date) ─────────────────

  /** @returns {Promise<Array<{ version_name: string, branch_out: string, branch_out_end: string|null, release_date: string|null }>>} */
  async getReleaseCalendar() {
    const res = await this.client.get('/release_calendar', {
      params: { select: 'version_name,branch_out,branch_out_end,release_date', order: 'branch_out.asc' },
    });
    return res.data ?? [];
  }

  // ── jira_prompts (one DM per trigger × issue) ─────────────────────────

  /** All prompt rows for a trigger (issue_key, payload, …) — used for watch-field re-asks. */
  async getPromptsForTrigger(triggerId) {
    const res = await this.client.get('/jira_prompts', {
      params: { trigger_id: `eq.${triggerId}`, select: 'id,issue_key,slack_user_id,payload,prompted_at,delivered_at,answered_at' },
    });
    return res.data ?? [];
  }

  async updatePromptPayload(id, payload) {
    await this.client.patch('/jira_prompts', { payload }, {
      params: { id: `eq.${id}` },
      headers: { Prefer: 'return=minimal' },
    });
  }

  /** Mark every prompt for this issue (optionally for this user) as answered. */
  async markPromptAnswered(issueKey, slackUserId = null) {
    const params = { issue_key: `eq.${issueKey}` };
    if (slackUserId) params.slack_user_id = `eq.${slackUserId}`;
    await this.client.patch('/jira_prompts', { answered_at: new Date().toISOString() }, {
      params, headers: { Prefer: 'return=minimal' },
    });
  }

  /** @returns {Promise<Set<string>>} issue keys already prompted for this trigger */
  async getPromptedIssueKeys(triggerId) {
    const res = await this.client.get('/jira_prompts', {
      params: { trigger_id: `eq.${triggerId}`, select: 'issue_key' },
    });
    return new Set((res.data ?? []).map((r) => r.issue_key));
  }

  /**
   * Forget that an issue was asked about, so the next poll re-prompts.
   * Used when the user's "Yes" failed to apply.
   */
  async deletePromptsForIssue(issueKey, slackUserId = null) {
    const params = { issue_key: `eq.${issueKey}` };
    if (slackUserId) params.slack_user_id = `eq.${slackUserId}`;
    await this.client.delete('/jira_prompts', { params, headers: { Prefer: 'return=minimal' } });
  }

  /** Forget every prompt for a trigger so its next run re-asks all current matches. */
  async deletePromptsForTrigger(triggerId) {
    const res = await this.client.delete('/jira_prompts', {
      params: { trigger_id: `eq.${triggerId}` },
      headers: { Prefer: 'return=representation' },
    });
    return Array.isArray(res.data) ? res.data.length : 0;
  }

  /**
   * Record that an issue was handled for a trigger.
   * Delivered immediately (default) → delivered_at = now.
   * Queued for a digest → pass { payload } and delivered = false; the digest
   * scheduler sends it later and marks it delivered.
   */
  async recordPrompt(triggerId, issueKey, slackUserId, { payload = null, delivered = true } = {}) {
    await this.client.post('/jira_prompts', {
      trigger_id: triggerId,
      issue_key: issueKey,
      slack_user_id: slackUserId,
      payload,
      delivered_at: delivered ? new Date().toISOString() : null,
    }, {
      params: { on_conflict: 'trigger_id,issue_key' },
      headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
    });
  }

  /** All queued (undelivered) prompts, oldest first. */
  async getPendingPrompts(slackUserId = null) {
    const params = { delivered_at: 'is.null', select: '*', order: 'prompted_at.asc' };
    if (slackUserId) params.slack_user_id = `eq.${slackUserId}`;
    const res = await this.client.get('/jira_prompts', { params });
    return res.data ?? [];
  }

  async markPromptsDelivered(ids) {
    if (!ids.length) return;
    await this.client.patch('/jira_prompts', { delivered_at: new Date().toISOString() }, {
      params: { id: `in.(${ids.join(',')})` },
      headers: { Prefer: 'return=minimal' },
    });
  }

  // ── activity_log (per-user history for App Home) ──────────────────────

  async insertActivity(e) {
    await this.client.post('/activity_log', {
      ts: new Date(e.ts || Date.now()).toISOString(),
      slack_user_id: e.slackUserId,
      slack_user_name: e.slackUserName ?? null,
      integration_name: e.integrationName ?? null,
      trigger: e.trigger,
      issue_key: e.issueKey,
      field_name: e.fieldName ?? null,
      field_value: e.fieldValue == null ? null : String(e.fieldValue),
      success: e.success !== false,
      error: e.error ?? null,
    }, { headers: { Prefer: 'return=minimal' } });
  }

  /** Newest first, normalised to the audit-entry shape. */
  async getRecentActivity(slackUserId, limit = 5) {
    const res = await this.client.get('/activity_log', {
      params: { slack_user_id: `eq.${slackUserId}`, select: '*', order: 'ts.desc', limit },
    });
    return (res.data ?? []).map((r) => ({
      ts: new Date(r.ts).getTime(),
      slackUserId: r.slack_user_id,
      slackUserName: r.slack_user_name,
      integrationName: r.integration_name,
      trigger: r.trigger,
      issueKey: r.issue_key,
      fieldName: r.field_name,
      fieldValue: r.field_value,
      success: r.success,
      error: r.error,
    }));
  }

  // ── user_preferences (notification digest) ────────────────────────────

  /** @returns {Promise<{ slack_user_id, digest_frequency, tz, last_digest_at }|null>} */
  async getUserPreference(slackUserId) {
    const res = await this.client.get('/user_preferences', {
      params: { slack_user_id: `eq.${slackUserId}`, select: '*', limit: 1 },
    });
    return res.data?.[0] ?? null;
  }

  /** Everyone who opted into a digest (anything other than immediate). */
  async getDigestUsers() {
    const res = await this.client.get('/user_preferences', {
      params: { digest_frequency: 'neq.immediate', select: '*' },
    });
    return res.data ?? [];
  }

  async upsertUserPreference(slackUserId, fields) {
    await this.client.post('/user_preferences', {
      slack_user_id: slackUserId,
      ...fields,
      updated_at: new Date().toISOString(),
    }, {
      params: { on_conflict: 'slack_user_id' },
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    });
  }
}

module.exports = SupabaseService;
