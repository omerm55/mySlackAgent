'use strict';

// The SQL itself, executed against a real Postgres — the part a mocked pool cannot check:
// upserts, the atomic single-use OAuth state, jsonb columns that must not become Postgres arrays,
// uuid[] parameters, and the date columns the Fix Version suggester reads as strings.
//
// Skipped unless TEST_DATABASE_URL is set. CI provides one (a postgres service); locally:
//   docker run --rm -d -p 5432:5432 -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=bot postgres:16
//   TEST_DATABASE_URL=postgres://postgres:pw@localhost:5432/bot npm test

const crypto = require('crypto');
const DbService = require('../src/services/dbService');
const { TokenCrypto } = require('../src/utils/tokenCrypto');
const { applySchema } = require('../scripts/apply-schema');

const url = process.env.TEST_DATABASE_URL;
const KEY = crypto.randomBytes(32).toString('base64');
const withDb = url ? describe : describe.skip;

withDb('DbService against a real Postgres', () => {
  let db;

  beforeAll(async () => {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: url, ssl: false, max: 4 });
    await applySchema(pool);
    db = new DbService({ pool, tokenCrypto: new TokenCrypto(KEY) });
  }, 60_000);

  afterAll(async () => { if (db) await db.close(); });

  beforeEach(async () => {
    await db._query(`truncate oauth_tokens, oauth_states, integrations, jira_triggers,
      jira_prompts, activity_log, audit_events, app_settings, user_preferences cascade`);
  });

  const newTrigger = (fields = {}) => db.insertJiraTrigger({
    created_by: 'U1', name: 'trigger', jql: 'project = SNS', question: 'ready?', ...fields,
  });

  test('upsertToken replaces the row, stores ciphertext, and getToken decrypts', async () => {
    await db.upsertToken('U1', { accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 3600e3, cloudId: 'c1' });
    await db.upsertToken('U1', { accessToken: 'AT2', refreshToken: 'RT2', expiresAt: Date.now() + 7200e3, cloudId: 'c2' });

    const raw = await db._rows('select * from oauth_tokens');
    expect(raw).toHaveLength(1);
    expect(raw[0].access_token).toMatch(/^enc:v1:/);
    expect(JSON.stringify(raw[0])).not.toMatch(/AT2|RT2/);

    expect(await db.getToken('U1')).toMatchObject({ accessToken: 'AT2', refreshToken: 'RT2', cloudId: 'c2' });
    expect(await db.getToken('nobody')).toBeNull();

    await db.deleteToken('U1');
    expect(await db.getAllTokens()).toHaveLength(0);
  });

  test('consumeOauthState succeeds exactly once, and never for an expired state', async () => {
    await db.insertOauthState({ state: 's1', slackUserId: 'U1', expiresAt: Date.now() + 60_000 });
    expect(await db.consumeOauthState('s1')).toMatchObject({ slack_user_id: 'U1' });
    expect(await db.consumeOauthState('s1')).toBeNull();          // single use
    expect(await db.consumeOauthState('never-issued')).toBeNull();

    await db.insertOauthState({ state: 's2', slackUserId: 'U1', expiresAt: Date.now() - 1000 });
    expect(await db.consumeOauthState('s2')).toBeNull();          // expired
  });

  test('pruneOauthStates removes states expired over a day ago and keeps the rest', async () => {
    await db.insertOauthState({ state: 'old', slackUserId: 'U1', expiresAt: Date.now() - 48 * 3600e3 });
    await db.insertOauthState({ state: 'recent', slackUserId: 'U1', expiresAt: Date.now() - 3600e3 });
    await db.pruneOauthStates();
    const left = await db._rows('select state from oauth_states');
    expect(left.map((r) => r.state)).toEqual(['recent']);
  });

  test('an integration round-trips: triggers stays a text[], not a JSON string', async () => {
    const saved = await db.upsertIntegration({
      name: 'PM reviewed', scope: 'global', channel_id: 'C1', triggers: ['reaction', 'reply'],
      jira_field_id: 'customfield_1', jira_field_name: 'PM reviewed', jira_field_value: 'Yes',
      created_by: 'U1', active: true,
    });
    expect(saved.triggers).toEqual(['reaction', 'reply']);          // not '["reaction","reply"]'

    const [row] = await db.getActiveIntegrations();
    expect(row.triggers).toEqual(['reaction', 'reply']);
    expect(await db.getIntegrationsByUser('U1')).toHaveLength(1);

    await db.updateIntegration(saved.id, { jira_field_value: 'No', triggers: ['reaction'] });
    expect((await db.getActiveIntegrations())[0]).toMatchObject({ jira_field_value: 'No', triggers: ['reaction'] });

    await db.deactivateIntegration(saved.id);
    expect(await db.getActiveIntegrations()).toHaveLength(0);
  });

  test('a jira trigger keeps collect_fields as jsonb and the pilot list as a text array', async () => {
    const t = await newTrigger({
      collect_fields: [{ id: 'customfield_11822', name: 'Customer-friendly name', required: true }],
      pilot_slack_user_ids: ['U1', 'U2'],
      ask_type: 'collect',
    });
    expect(t.collect_fields).toEqual([{ id: 'customfield_11822', name: 'Customer-friendly name', required: true }]);
    expect(t.pilot_slack_user_ids).toEqual(['U1', 'U2']);

    expect(await db.getActiveJiraTriggers()).toHaveLength(1);
    await db.updateJiraTrigger(t.id, { last_polled_at: new Date() });
    await db.deactivateJiraTrigger(t.id);
    expect(await db.getActiveJiraTriggers()).toHaveLength(0);
  });

  test('one prompt per (trigger, issue); the daily count survives a restart because it is a query', async () => {
    const t = await newTrigger();
    await db.recordPrompt(t.id, 'SNS-1', 'U1');
    await db.recordPrompt(t.id, 'SNS-1', 'U1');                    // same issue → ignored
    await db.recordPrompt(t.id, 'SNS-2', 'U2');

    expect(await db.countPromptsSince(t.id, Date.now() - 60_000)).toBe(2);
    expect(await db.countPromptsSince(t.id, Date.now() + 60_000)).toBe(0);
    expect([...(await db.getPromptedIssueKeys(t.id))].sort()).toEqual(['SNS-1', 'SNS-2']);
    expect(await db.getPromptsForTrigger(t.id)).toHaveLength(2);

    await db.deletePromptsForIssue('SNS-1');
    expect([...(await db.getPromptedIssueKeys(t.id))]).toEqual(['SNS-2']);
    expect(await db.deletePromptsForTrigger(t.id)).toBe(1);        // the count of rows removed
  });

  test('queued prompts keep their payload until they are marked delivered', async () => {
    const t = await newTrigger();
    await db.recordPrompt(t.id, 'SNS-3', 'U2', { payload: { question: 'ready?', fields: ['a'] }, delivered: false });

    const pending = await db.getPendingPrompts('U2');
    expect(pending).toHaveLength(1);
    expect(pending[0].payload).toEqual({ question: 'ready?', fields: ['a'] });
    expect(await db.getPendingPrompts('U-other')).toHaveLength(0);

    await db.updatePromptPayload(pending[0].id, { question: 'still ready?' });
    expect((await db.getPendingPrompts())[0].payload).toEqual({ question: 'still ready?' });

    await db.markPromptsDelivered(pending.map((p) => p.id));       // uuid[] parameter
    expect(await db.getPendingPrompts('U2')).toHaveLength(0);
    await expect(db.markPromptsDelivered([])).resolves.toBeUndefined();
  });

  test('markPromptAnswered stamps every prompt for an issue, or only one user\'s', async () => {
    const t = await newTrigger();
    await db.recordPrompt(t.id, 'SNS-4', 'U1');
    const t2 = await newTrigger({ name: 'second' });
    await db.recordPrompt(t2.id, 'SNS-4', 'U2');

    await db.markPromptAnswered('SNS-4', 'U1');
    const answered = await db._rows('select slack_user_id, answered_at from jira_prompts order by slack_user_id');
    expect(answered[0].answered_at).not.toBeNull();
    expect(answered[1].answered_at).toBeNull();

    await db.markPromptAnswered('SNS-4');
    expect((await db._rows('select answered_at from jira_prompts')).every((r) => r.answered_at)).toBe(true);
  });

  test('app settings round-trip jsonb and record who changed them', async () => {
    await db.setSetting('paused', { paused: true }, 'UADMIN');
    await db.setSetting('paused', { paused: false }, 'UADMIN2');
    const row = await db.getSetting('paused');
    expect(row.value).toEqual({ paused: false });
    expect(row.updated_by).toBe('UADMIN2');
    expect(await db.getSetting('missing')).toBeNull();
  });

  test('audit events truncate long text, keep detail as jsonb, and filter newest first', async () => {
    await db.insertAuditEvent({ kind: 'ops', slackUserId: 'U1', issueKey: 'SNS-1', ok: true, text: 'x'.repeat(5000), detail: { identity: 'user (OAuth)' } });
    await db.insertAuditEvent({ kind: 'dm_yes', slackUserId: 'U2', issueKey: 'SNS-2', ok: false, text: 'failed' });

    const all = await db.getAuditEvents({});
    expect(all).toHaveLength(2);
    expect(all[0].ts.getTime()).toBeGreaterThanOrEqual(all[1].ts.getTime());   // newest first

    const [one] = await db.getAuditEvents({ issueKey: 'SNS-1' });
    expect(one.text).toHaveLength(4000);
    expect(one.detail).toEqual({ identity: 'user (OAuth)' });

    expect(await db.getAuditEvents({ kind: 'dm_yes' })).toHaveLength(1);
    expect(await db.getAuditEvents({ slackUserId: 'U2', kind: 'dm_yes' })).toHaveLength(1);
    expect(await db.getAuditEvents({ since: Date.now() + 60_000 })).toHaveLength(0);
    expect(await db.getAuditEvents({ limit: 1 })).toHaveLength(1);
  });

  test('activity is stored and read back in the audit-entry shape', async () => {
    await db.insertActivity({ slackUserId: 'U1', trigger: '👍 reaction', issueKey: 'SNS-1', fieldName: 'PM reviewed', fieldValue: 'Yes' });
    await db.insertActivity({ slackUserId: 'U1', trigger: 'DM Yes', issueKey: 'SNS-2', success: false, error: 'Jira 403' });

    const recent = await db.getRecentActivity('U1', 5);
    expect(recent).toHaveLength(2);
    expect(typeof recent[0].ts).toBe('number');
    expect(recent.map((r) => r.issueKey).sort()).toEqual(['SNS-1', 'SNS-2']);
    expect(recent.find((r) => r.issueKey === 'SNS-2')).toMatchObject({ success: false, error: 'Jira 403' });
    expect(await db.getRecentActivity('U-nobody')).toEqual([]);
  });

  test('user preferences upsert, and the digest list excludes immediate', async () => {
    await db.upsertUserPreference('U1', { digest_frequency: 'daily', tz: 'Asia/Jerusalem' });
    await db.upsertUserPreference('U1', { digest_frequency: 'hourly' });          // update, not a second row
    await db.upsertUserPreference('U2', { digest_frequency: 'immediate' });

    expect(await db.getUserPreference('U1')).toMatchObject({ digest_frequency: 'hourly', tz: 'Asia/Jerusalem' });
    const digest = await db.getDigestUsers();
    expect(digest.map((r) => r.slack_user_id)).toEqual(['U1']);
    expect(await db.getUserPreference('U-nobody')).toBeNull();
  });

  test('release calendar dates are YYYY-MM-DD strings, ordered by branch-out', async () => {
    const rows = await db.getReleaseCalendar();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].branch_out).toMatch(/^\d{4}-\d{2}-\d{2}$/);     // a Date here would break the suggester
    expect(rows[0].branch_out_end).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const dates = rows.map((r) => r.branch_out);
    expect(dates).toEqual([...dates].sort());
  });
});
