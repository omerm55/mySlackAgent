'use strict';

const { Pool } = require('pg');
const { TokenCrypto } = require('../utils/tokenCrypto');

/**
 * Postgres access layer. Speaks the Postgres wire protocol directly (node-postgres), so the database
 * can be Supabase, RDS, Azure Flexible Server or anything else that is Postgres: only DATABASE_URL
 * changes. It replaced a client that spoke Supabase's PostgREST API over HTTP (§14.41).
 *
 * OAuth tokens are encrypted at rest with TokenCrypto when TOKEN_ENCRYPTION_KEY is set.
 *
 * Every method here is the same name, signature and return shape as the PostgREST version it
 * replaced — callers were not changed.
 */

/**
 * Columns that are jsonb: a JS array or object must be sent as JSON text, or node-postgres encodes it
 * as a Postgres array literal. Columns that are genuinely Postgres arrays — `integrations.triggers`
 * (text[]) and `jira_triggers.pilot_slack_user_ids` (text[]) — are deliberately NOT listed, and are
 * passed through as JS arrays.
 */
const JSONB_COLUMNS = {
  jira_triggers: new Set(['collect_fields']),
  jira_prompts: new Set(['payload']),
  audit_events: new Set(['detail']),
  app_settings: new Set(['value']),
};

/** Column names reaching the dynamic builders come from our own code; refuse anything else. */
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function assertIdentifier(name) {
  if (!IDENTIFIER.test(name)) throw new Error(`unsafe column name: ${name}`);
  return name;
}

/** Drop undefined (absent) keys — null is meaningful and kept. */
function definedKeys(obj) {
  return Object.keys(obj).filter((k) => obj[k] !== undefined).map(assertIdentifier);
}

function encodeValue(table, column, value) {
  if (JSONB_COLUMNS[table]?.has(column) && value != null && typeof value === 'object') {
    return JSON.stringify(value);
  }
  return value;
}

/**
 * TLS for hosted Postgres. `require` encrypts but does not verify the chain — hosted providers
 * present their own CA, and that is what a Supabase/RDS connection string means by `sslmode=require`.
 * Set DATABASE_CA_CERT (PEM) to verify properly, which is what we want once the database is ours.
 */
function sslFromEnv(connectionString) {
  const mode = process.env.DATABASE_SSL
    || (/@(localhost|127\.0\.0\.1|postgres)[:/]/.test(connectionString) ? 'disable' : 'require');
  if (mode === 'disable') return false;
  const ca = process.env.DATABASE_CA_CERT;
  if (ca) return { ca, rejectUnauthorized: true };
  return { rejectUnauthorized: mode === 'verify' };
}

class DbService {
  /**
   * @param {{ connectionString?: string, pool?: import('pg').Pool, tokenCrypto?: TokenCrypto|null }} opts
   *   `pool` is for tests; normal callers pass a connection string.
   */
  constructor({ connectionString, pool = null, tokenCrypto = null }) {
    this.tokenCrypto = tokenCrypto;
    this.pool = pool || new Pool({
      connectionString,
      ssl: sslFromEnv(connectionString || ''),
      max: 5,                          // one process, a poll every 60s — a small pool is plenty
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000, // same bound the HTTP client had
      statement_timeout: 10_000,       // no query may hang a handler
      application_name: 'slack-jira-bot',
    });
    // A pool error (server restart, idle connection dropped) must never take the process down.
    // Guarded because tests inject a plain object with just `query`.
    if (typeof this.pool.on === 'function') {
      this.pool.on('error', (err) => {
        // eslint-disable-next-line no-console
        console.error(`[db] idle client error: ${err.message}`);
      });
    }
  }

  static fromEnv() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) return null;
    return new DbService({ connectionString, tokenCrypto: TokenCrypto.fromEnv() });
  }

  /** @returns {Promise<import('pg').QueryResult>} */
  _query(text, params = []) {
    return this.pool.query(text, params);
  }

  async _rows(text, params = []) {
    const res = await this._query(text, params);
    return res.rows ?? [];
  }

  async _row(text, params = []) {
    const rows = await this._rows(text, params);
    return rows[0] ?? null;
  }

  /** insert into <table> (…) values (…) [on conflict …] [returning *] */
  async _insert(table, row, { onConflict = null, returning = false } = {}) {
    const keys = definedKeys(row);
    const values = keys.map((k) => encodeValue(table, k, row[k]));
    const placeholders = keys.map((_, i) => `$${i + 1}`);
    const sql = `insert into ${table} (${keys.join(', ')}) values (${placeholders.join(', ')})`
      + (onConflict ? ` ${onConflict}` : '')
      + (returning ? ' returning *' : '');
    const res = await this._query(sql, values);
    return returning ? (res.rows?.[0] ?? null) : undefined;
  }

  /** update <table> set … where id = $n */
  async _updateById(table, id, fields) {
    const keys = definedKeys(fields);
    if (!keys.length) return;
    const assignments = keys.map((k, i) => `${k} = $${i + 1}`);
    const values = keys.map((k) => encodeValue(table, k, fields[k]));
    await this._query(
      `update ${table} set ${assignments.join(', ')} where id = $${keys.length + 1}`,
      [...values, id],
    );
  }

  /** Release every connection — called on shutdown so the process can exit cleanly. */
  async close() {
    await this.pool.end();
  }

  _enc(v) { return this.tokenCrypto ? this.tokenCrypto.encrypt(v) : v; }

  /** Decrypt a stored token; without a key, encrypted rows are unusable → fail loudly, never silently. */
  _dec(v) {
    if (this.tokenCrypto) return this.tokenCrypto.decrypt(v);
    if (TokenCrypto.isEncrypted(v)) {
      const err = new Error('oauth_tokens are encrypted but TOKEN_ENCRYPTION_KEY is not set');
      err.code = 'encryption_key_missing';
      throw err;
    }
    return v;
  }

  // ── oauth_tokens ────────────────────────────────────────────────

  async upsertToken(slackUserId, { accessToken, refreshToken, expiresAt, cloudId }) {
    await this._query(
      `insert into oauth_tokens (slack_user_id, access_token, refresh_token, expires_at, cloud_id, updated_at)
       values ($1, $2, $3, $4, $5, now())
       on conflict (slack_user_id) do update set
         access_token  = excluded.access_token,
         refresh_token = excluded.refresh_token,
         expires_at    = excluded.expires_at,
         cloud_id      = excluded.cloud_id,
         updated_at    = excluded.updated_at`,
      [slackUserId, this._enc(accessToken), this._enc(refreshToken), new Date(expiresAt), cloudId],
    );
  }

  async getToken(slackUserId) {
    const row = await this._row(
      'select * from oauth_tokens where slack_user_id = $1 limit 1', [slackUserId]);
    if (!row) return null;
    return {
      accessToken: this._dec(row.access_token),
      refreshToken: this._dec(row.refresh_token),
      expiresAt: new Date(row.expires_at).getTime(),
      cloudId: row.cloud_id,
    };
  }

  /**
   * All token rows, decrypted. `needsRewrite` is true for rows that are plaintext or encrypted with a
   * previous key, so the caller can re-encrypt them once (lazy migration / rotation).
   */
  async getAllTokens() {
    const rows = await this._rows('select * from oauth_tokens');
    return rows.map((row) => ({
      ...row,
      access_token: this._dec(row.access_token),
      refresh_token: this._dec(row.refresh_token),
      needsRewrite: !!this.tokenCrypto && !(this.tokenCrypto.isCurrent(row.access_token) && this.tokenCrypto.isCurrent(row.refresh_token)),
    }));
  }

  async deleteToken(slackUserId) {
    await this._query('delete from oauth_tokens where slack_user_id = $1', [slackUserId]);
  }

  // ── oauth_states (pending Connect links: random, single-use, expiring) ──

  async insertOauthState({ state, slackUserId, expiresAt }) {
    await this._query(
      'insert into oauth_states (state, slack_user_id, expires_at) values ($1, $2, $3)',
      [state, slackUserId, new Date(expiresAt)],
    );
  }

  /**
   * Mark a state used and return its row — atomically, so a second call with the same state (or an
   * expired one) returns null. One statement: the row is matched and stamped under the same lock,
   * and `now()` is the database's clock rather than this process's.
   */
  async consumeOauthState(state) {
    return this._row(
      `update oauth_states set used_at = now()
        where state = $1 and used_at is null and expires_at > now()
        returning *`,
      [state],
    );
  }

  /** Delete states that expired more than a day ago (used or not). */
  async pruneOauthStates() {
    await this._query("delete from oauth_states where expires_at < now() - interval '1 day'");
  }

  // ── integrations ─────────────────────────────────────────────────

  async getActiveIntegrations() {
    return this._rows('select * from integrations where active = true order by created_at asc');
  }

  async getIntegrationsByUser(slackUserId) {
    return this._rows(
      'select * from integrations where created_by = $1 order by created_at asc', [slackUserId]);
  }

  async upsertIntegration(integration) {
    return this._insert('integrations', integration, { returning: true });
  }

  async updateIntegration(id, fields) {
    await this._updateById('integrations', id, fields);
  }

  async deactivateIntegration(id) {
    await this.updateIntegration(id, { active: false });
  }

  // ── jira_triggers (JQL-polled, DM-driven) ─────────────────────────────

  async getActiveJiraTriggers() {
    return this._rows('select * from jira_triggers where active = true order by created_at asc');
  }

  async insertJiraTrigger(trigger) {
    return this._insert('jira_triggers', trigger, { returning: true });
  }

  async updateJiraTrigger(id, fields) {
    await this._updateById('jira_triggers', id, fields);
  }

  async deactivateJiraTrigger(id) {
    await this.updateJiraTrigger(id, { active: false });
  }

  // ── release_calendar (version name → branch-out date) ─────────────────

  /**
   * Dates are returned as `YYYY-MM-DD` strings (::text), not Date objects: the suggester compares
   * and formats them as strings, and a date column read as a Date would land at local midnight.
   * @returns {Promise<Array<{ version_name: string, branch_out: string, branch_out_end: string|null, release_date: string|null }>>}
   */
  async getReleaseCalendar() {
    return this._rows(
      `select version_name,
              branch_out::text     as branch_out,
              branch_out_end::text as branch_out_end,
              release_date::text   as release_date
         from release_calendar
        order by branch_out asc`,
    );
  }

  // ── jira_prompts (one DM per trigger × issue) ─────────────────────────

  /** All prompt rows for a trigger (issue_key, payload, …) — used for watch-field re-asks. */
  async getPromptsForTrigger(triggerId) {
    return this._rows(
      `select id, issue_key, slack_user_id, payload, prompted_at, delivered_at, answered_at
         from jira_prompts where trigger_id = $1`,
      [triggerId],
    );
  }

  /**
   * How many prompts this trigger recorded since `since` — the durable daily cap (a restart used to
   * reset the in-memory limits).
   */
  async countPromptsSince(triggerId, since) {
    const row = await this._row(
      'select count(*)::int as n from jira_prompts where trigger_id = $1 and prompted_at >= $2',
      [triggerId, new Date(since)],
    );
    return row?.n ?? 0;
  }

  async updatePromptPayload(id, payload) {
    await this._query('update jira_prompts set payload = $1::jsonb where id = $2',
      [payload == null ? null : JSON.stringify(payload), id]);
  }

  /** Mark every prompt for this issue (optionally for this user) as answered. */
  async markPromptAnswered(issueKey, slackUserId = null) {
    await this._query(
      `update jira_prompts set answered_at = now()
        where issue_key = $1 and ($2::text is null or slack_user_id = $2)`,
      [issueKey, slackUserId],
    );
  }

  /** @returns {Promise<Set<string>>} issue keys already prompted for this trigger */
  async getPromptedIssueKeys(triggerId) {
    const rows = await this._rows(
      'select issue_key from jira_prompts where trigger_id = $1', [triggerId]);
    return new Set(rows.map((r) => r.issue_key));
  }

  /**
   * Forget that an issue was asked about, so the next poll re-prompts.
   * Used when the user's "Yes" failed to apply.
   */
  async deletePromptsForIssue(issueKey, slackUserId = null) {
    await this._query(
      `delete from jira_prompts
        where issue_key = $1 and ($2::text is null or slack_user_id = $2)`,
      [issueKey, slackUserId],
    );
  }

  /** Forget every prompt for a trigger so its next run re-asks all current matches. */
  async deletePromptsForTrigger(triggerId) {
    const res = await this._query('delete from jira_prompts where trigger_id = $1', [triggerId]);
    return res.rowCount ?? 0;
  }

  /**
   * Record that an issue was handled for a trigger.
   * Delivered immediately (default) → delivered_at = now.
   * Queued for a digest → pass { payload } and delivered = false; the digest
   * scheduler sends it later and marks it delivered.
   */
  async recordPrompt(triggerId, issueKey, slackUserId, { payload = null, delivered = true } = {}) {
    await this._query(
      `insert into jira_prompts (trigger_id, issue_key, slack_user_id, payload, delivered_at)
       values ($1, $2, $3, $4::jsonb, $5)
       on conflict (trigger_id, issue_key) do nothing`,
      [triggerId, issueKey, slackUserId,
        payload == null ? null : JSON.stringify(payload),
        delivered ? new Date() : null],
    );
  }

  /** All queued (undelivered) prompts, oldest first. */
  async getPendingPrompts(slackUserId = null) {
    return this._rows(
      `select * from jira_prompts
        where delivered_at is null and ($1::text is null or slack_user_id = $1)
        order by prompted_at asc`,
      [slackUserId],
    );
  }

  async markPromptsDelivered(ids) {
    if (!ids.length) return;
    await this._query(
      'update jira_prompts set delivered_at = now() where id = any($1::uuid[])', [ids]);
  }

  // ── activity_log (per-user history for App Home) ──────────────────────

  async insertActivity(e) {
    await this._insert('activity_log', {
      ts: new Date(e.ts || Date.now()),
      slack_user_id: e.slackUserId,
      slack_user_name: e.slackUserName ?? null,
      integration_name: e.integrationName ?? null,
      trigger: e.trigger,
      issue_key: e.issueKey,
      field_name: e.fieldName ?? null,
      field_value: e.fieldValue == null ? null : String(e.fieldValue),
      success: e.success !== false,
      error: e.error ?? null,
    });
  }

  // ── app_settings (small key/value operational state, e.g. the global pause) ──

  async getSetting(key) {
    return this._row('select * from app_settings where key = $1 limit 1', [key]);
  }

  async setSetting(key, value, byUser = null) {
    await this._query(
      `insert into app_settings (key, value, updated_at, updated_by)
       values ($1, $2::jsonb, now(), $3)
       on conflict (key) do update set
         value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      [key, JSON.stringify(value), byUser],
    );
  }

  // ── audit_events (durable operator record; mirrors every ops-channel line) ──

  async insertAuditEvent({ kind, slackUserId, issueKey, ok, text, detail }) {
    await this._query(
      `insert into audit_events (kind, slack_user_id, issue_key, ok, text, detail)
       values ($1, $2, $3, $4, $5, $6::jsonb)`,
      [kind, slackUserId ?? null, issueKey ?? null, ok !== false,
        text == null ? null : String(text).slice(0, 4000),
        detail == null ? null : JSON.stringify(detail)],
    );
  }

  /**
   * Audit events, newest first. Filter by issue, user or kind — the "who changed what, when" query.
   * @param {{issueKey?: string, slackUserId?: string, kind?: string, since?: number|string, limit?: number}} [f]
   */
  async getAuditEvents({ issueKey, slackUserId, kind, since, limit = 50 } = {}) {
    const where = [];
    const params = [];
    const add = (clause, value) => { params.push(value); where.push(clause.replace('?', `$${params.length}`)); };
    if (issueKey) add('issue_key = ?', issueKey);
    if (slackUserId) add('slack_user_id = ?', slackUserId);
    if (kind) add('kind = ?', kind);
    if (since) add('ts >= ?', new Date(since));
    params.push(limit);
    return this._rows(
      `select * from audit_events
        ${where.length ? `where ${where.join(' and ')}` : ''}
        order by ts desc limit $${params.length}`,
      params,
    );
  }

  /** Newest first, normalised to the audit-entry shape. */
  async getRecentActivity(slackUserId, limit = 5) {
    const rows = await this._rows(
      'select * from activity_log where slack_user_id = $1 order by ts desc limit $2',
      [slackUserId, limit],
    );
    return rows.map((r) => ({
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
    return this._row(
      'select * from user_preferences where slack_user_id = $1 limit 1', [slackUserId]);
  }

  /** Everyone who opted into a digest (anything other than immediate). */
  async getDigestUsers() {
    return this._rows("select * from user_preferences where digest_frequency <> 'immediate'");
  }

  async upsertUserPreference(slackUserId, fields) {
    const row = { slack_user_id: slackUserId, ...fields, updated_at: new Date() };
    const keys = definedKeys(row);
    const values = keys.map((k) => row[k]);
    const placeholders = keys.map((_, i) => `$${i + 1}`);
    const updates = keys
      .filter((k) => k !== 'slack_user_id')
      .map((k) => `${k} = excluded.${k}`);
    await this._query(
      `insert into user_preferences (${keys.join(', ')}) values (${placeholders.join(', ')})
       on conflict (slack_user_id) do update set ${updates.join(', ')}`,
      values,
    );
  }
}

module.exports = DbService;
