'use strict';

// Every ops-channel line is also a durable row in audit_events, with enough structure to answer
// "who changed what, when, and as whom" without reading Slack.
const OpsNotifier = require('../src/utils/opsNotifier');
const SupabaseService = require('../src/services/supabaseService');

function setup() {
  const posted = [];
  const rows = [];
  const client = { chat: { postMessage: jest.fn(async (p) => { posted.push(p); return {}; }) } };
  const db = { insertAuditEvent: jest.fn(async (e) => { rows.push(e); }) };
  return { ops: new OpsNotifier(client, 'COPS', db), posted, rows, client, db };
}

describe('audit events mirror the ops channel', () => {
  test('a reaction write records kind, user, issue, identity and the message', async () => {
    const { ops, posted, rows } = setup();
    await ops.jiraTriggered({ trigger: '👍 reaction', actorName: 'Omer', slackUserId: 'U1', issueKey: 'SNS-1', fieldName: 'PM reviewed', fieldValue: 'Yes', success: true, usingOAuth: true });
    expect(posted).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'reaction_write', slackUserId: 'U1', issueKey: 'SNS-1', ok: true,
      detail: expect.objectContaining({ fieldName: 'PM reviewed', fieldValue: 'Yes', identity: 'user (OAuth)' }),
    });
    expect(rows[0].text).toBe(posted[0].text);
  });

  test('failures are recorded with ok:false and the error', async () => {
    const { ops, rows } = setup();
    await ops.jiraTriggered({ trigger: 'thread reply', slackUserId: 'U1', issueKey: 'SNS-2', fieldName: 'f', fieldValue: 'v', success: false, error: 'HTTP 400' });
    await ops.dmButtonClicked({ action: 'yes', slackUserId: 'U1', issueKey: 'SNS-3', fieldName: 'status', fieldValue: 'Done', error: 'nope' });
    await ops.dmLlmDecision({ slackUserId: 'U1', issueKey: 'SNS-4', userText: 't', decision: {}, error: 'boom' });
    expect(rows.map((r) => [r.kind, r.ok])).toEqual([['reply_write', false], ['dm_yes', false], ['llm_error', false]]);
    expect(rows[0].detail.error).toBe('HTTP 400');
  });

  test('the bot-account identity is captured, so RBAC exceptions are auditable', async () => {
    const { ops, rows } = setup();
    await ops.dmButtonClicked({ action: 'yes', slackUserId: 'U1', issueKey: 'SNS-1', fieldName: 'status', fieldValue: 'Done', usingOAuth: false });
    await ops.riskReviewAction({ slackUserId: 'U2', issueKey: 'PR-1', action: 'set status', detail: 'High Risk', usingOAuth: true });
    expect(rows[0].detail.identity).toBe('bot account');
    expect(rows[1]).toMatchObject({ kind: 'risk_action', issueKey: 'PR-1', detail: expect.objectContaining({ identity: 'user (OAuth)' }) });
  });

  test('proposed and applied LLM decisions are distinct kinds', async () => {
    const { ops, rows } = setup();
    const decision = { action: 'transition', transitionTo: 'Done', confirmationMessage: 'Moved.' };
    await ops.dmLlmProposed({ slackUserId: 'U1', issueKey: 'SNS-1', userText: 'go', decision });
    await ops.dmLlmDecision({ slackUserId: 'U1', issueKey: 'SNS-1', userText: 'go', decision, usingOAuth: true });
    expect(rows.map((r) => r.kind)).toEqual(['llm_proposed', 'llm_applied']);
    expect(rows[1].detail.decision.transitionTo).toBe('Done');
  });

  test('every other notifier method also lands a row; a plain post is kind "ops"', async () => {
    const { ops, rows } = setup();
    await ops.dmQuestionSent({ slackUserId: 'U1', issueKey: 'SNS-1', question: 'q', fieldName: 'f', fieldValue: 'v' });
    await ops.collectAction({ slackUserId: 'U1', issueKey: 'PR-1', action: 'saved', detail: 'x' });
    await ops.jiraTriggerSkipped({ trigger: 'T', issueKey: 'SNS-9', reason: 'no email' });
    await ops.reactionFiltered({ slackUserId: 'U1', integration: 'Docs', reason: 'not in allowlist' });
    await ops.post('▶️ Ran *T*');
    expect(rows.map((r) => r.kind)).toEqual(['ask_sent', 'collect_action', 'trigger_skipped', 'reaction_filtered', 'ops']);
  });

  test('a failing audit sink never breaks the operator message', async () => {
    const { ops, posted, db } = setup();
    db.insertAuditEvent.mockRejectedValue(new Error('PostgREST down'));
    await ops.post('still posted');
    expect(posted[0].text).toBe('still posted');
  });

  test('no channel configured: rows are still written (audit does not depend on Slack)', async () => {
    const rows = [];
    const ops = new OpsNotifier(null, null, { insertAuditEvent: async (e) => { rows.push(e); } });
    await ops.post('recorded anyway', { kind: 'ops', issue: 'SNS-1' });
    expect(rows[0]).toMatchObject({ kind: 'ops', issueKey: 'SNS-1' });
  });
});

describe('SupabaseService audit_events', () => {
  function svc() {
    const s = new SupabaseService({ url: 'https://x', secretKey: 'k' });
    s.client = { post: jest.fn().mockResolvedValue({}), get: jest.fn().mockResolvedValue({ data: [{ id: 'a' }] }) };
    return s;
  }
  test('insert truncates very long text and passes detail through as jsonb', async () => {
    const s = svc();
    await s.insertAuditEvent({ kind: 'ops', slackUserId: 'U1', issueKey: 'SNS-1', ok: true, text: 'x'.repeat(5000), detail: { a: 1 } });
    const body = s.client.post.mock.calls[0][1];
    expect(body.text).toHaveLength(4000);
    expect(body.detail).toEqual({ a: 1 });
    expect(body.slack_user_id).toBe('U1');
  });
  test('query filters by issue, user, kind and time, newest first', async () => {
    const s = svc();
    await s.getAuditEvents({ issueKey: 'SNS-1', slackUserId: 'U1', kind: 'dm_yes', since: '2026-09-01T00:00:00Z', limit: 10 });
    expect(s.client.get).toHaveBeenCalledWith('/audit_events', {
      params: expect.objectContaining({ issue_key: 'eq.SNS-1', slack_user_id: 'eq.U1', kind: 'eq.dm_yes', order: 'ts.desc', limit: 10, ts: 'gte.2026-09-01T00:00:00.000Z' }),
    });
  });
});
