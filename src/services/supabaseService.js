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

  async deactivateIntegration(id) {
    await this.client.patch('/integrations', { active: false }, {
      params: { id: `eq.${id}` },
      headers: { Prefer: 'return=minimal' },
    });
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

  async deactivateJiraTrigger(id) {
    await this.client.patch('/jira_triggers', { active: false }, {
      params: { id: `eq.${id}` },
      headers: { Prefer: 'return=minimal' },
    });
  }

  // ── jira_prompts (one DM per trigger × issue) ─────────────────────────

  /** @returns {Promise<Set<string>>} issue keys already prompted for this trigger */
  async getPromptedIssueKeys(triggerId) {
    const res = await this.client.get('/jira_prompts', {
      params: { trigger_id: `eq.${triggerId}`, select: 'issue_key' },
    });
    return new Set((res.data ?? []).map((r) => r.issue_key));
  }

  async recordPrompt(triggerId, issueKey, slackUserId) {
    await this.client.post('/jira_prompts', {
      trigger_id: triggerId,
      issue_key: issueKey,
      slack_user_id: slackUserId,
    }, {
      params: { on_conflict: 'trigger_id,issue_key' },
      headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
    });
  }
}

module.exports = SupabaseService;
