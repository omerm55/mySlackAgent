'use strict';

// OAuth is required for every write (SNS-133715, condition 3). Without a token nothing is written: the
// ask is put back with a Connect nudge (same buttons), the prompt row is untouched. With a token, the
// user's own client is used. Asks sent before the change still carry `allowFallback: true` in their
// buttons; it is ignored.
const { registerDmHandler } = require('../src/handlers/dmHandler');
const { buildYesNoBlocks } = require('../src/utils/dmQuestion');
const rr = require('../src/utils/riskReviewMessage');

const actionIds = (blocks) => (blocks || []).filter((b) => b.type === 'actions').flatMap((b) => b.elements.map((e) => e.action_id));

function setup({ hasToken = false, oauth = true } = {}) {
  const handlers = {};
  const app = { action: (id, fn) => { handlers[String(id)] = fn; }, view: (id, fn) => { handlers[String(id)] = fn; } };
  const updates = [];
  const client = {
    chat: { update: jest.fn(async (p) => { updates.push(p); return {}; }), postMessage: jest.fn().mockResolvedValue({}) },
    views: { open: jest.fn().mockResolvedValue({}) },
    conversations: { open: jest.fn().mockResolvedValue({ channel: { id: 'D1' } }) },
  };
  const botJira = { updateIssueField: jest.fn().mockResolvedValue(undefined), transitionIssue: jest.fn().mockResolvedValue(undefined), updateIssueFields: jest.fn(), getIssue: jest.fn().mockResolvedValue({ fields: {} }), getProjectVersions: jest.fn().mockResolvedValue([]) };
  const userJira = { updateIssueField: jest.fn().mockResolvedValue(undefined), transitionIssue: jest.fn().mockResolvedValue(undefined), updateIssueFields: jest.fn(), getIssue: jest.fn().mockResolvedValue({ fields: {} }) };
  const oauthService = { hasToken: jest.fn(() => hasToken), generateAuthUrl: jest.fn().mockResolvedValue('https://auth?state=r'), getJiraService: jest.fn().mockResolvedValue(userJira) };
  const db = { markPromptAnswered: jest.fn().mockResolvedValue(undefined), deletePromptsForIssue: jest.fn().mockResolvedValue(undefined) };
  const ops = { post: jest.fn().mockResolvedValue(undefined), dmButtonClicked: jest.fn(), riskReviewAction: jest.fn(), collectAction: jest.fn(), dmLlmDecision: jest.fn(), dmLlmProposed: jest.fn() };
  registerDmHandler(app, botJira, { db, llmService: null, oauthService: oauth ? oauthService : null, opsNotifier: ops, userCache: { getName: jest.fn().mockResolvedValue('Omer') } });
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { handlers, client, botJira, userJira, oauthService, db, ops, updates, logger };
}

const yesCtx = (extra = {}) => ({ issueKey: 'SNS-1', question: 'Approve?', transitionTo: 'Done', slackUserId: 'U1', ...extra });
const yesBody = (ctx) => ({ actions: [{ value: JSON.stringify(ctx) }], channel: { id: 'D1' }, message: { ts: '1', text: 'orig', blocks: buildYesNoBlocks(ctx, 'U1') }, user: { id: 'U1' }, trigger_id: 'T' });

describe('Yes button', () => {
  test('no token → nothing written, ask restored with its buttons + Connect, prompt kept, ops told', async () => {
    const { handlers, client, botJira, userJira, db, ops, updates, logger } = setup();
    await handlers.jira_confirm_yes({ ack: jest.fn(), body: yesBody(yesCtx()), client, logger });
    expect(botJira.transitionIssue).not.toHaveBeenCalled();
    expect(userJira.transitionIssue).not.toHaveBeenCalled();
    const last = updates[updates.length - 1];
    expect(actionIds(last.blocks)).toEqual(['jira_confirm_yes', 'jira_confirm_no', 'jira_reply', 'dm_connect_jira']);
    expect(JSON.stringify(last.blocks)).toMatch(/Connect Jira first, then press the button again/);
    expect(db.deletePromptsForIssue).not.toHaveBeenCalled();
    expect(ops.post).toHaveBeenCalledWith(expect.stringMatching(/without a Jira connection — asked to connect, nothing written/));
  });

  test('no token, an older ask still carrying allowFallback → still nothing written, Connect nudge', async () => {
    const { handlers, client, botJira, userJira, updates, logger } = setup();
    await handlers.jira_confirm_yes({ ack: jest.fn(), body: yesBody(yesCtx({ allowFallback: true })), client, logger });
    expect(botJira.transitionIssue).not.toHaveBeenCalled();
    expect(userJira.transitionIssue).not.toHaveBeenCalled();
    expect(JSON.stringify(updates[updates.length - 1].blocks)).toMatch(/Connect Jira first/);
  });

  test('OAuth not configured at all → nothing written (no bot-account path)', async () => {
    const { handlers, client, botJira, logger } = setup({ oauth: false });
    await handlers.jira_confirm_yes({ ack: jest.fn(), body: yesBody(yesCtx()), client, logger });
    expect(botJira.transitionIssue).not.toHaveBeenCalled();
  });

  test('with a token → the user\'s own client writes, regardless of the flag', async () => {
    const { handlers, client, botJira, userJira, logger } = setup({ hasToken: true });
    await handlers.jira_confirm_yes({ ack: jest.fn(), body: yesBody(yesCtx()), client, logger });
    expect(userJira.transitionIssue).toHaveBeenCalledWith('SNS-1', 'Done');
    expect(botJira.transitionIssue).not.toHaveBeenCalled();
  });

  test('a second nudge does not stack Connect blocks', async () => {
    const { handlers, client, updates, logger } = setup();
    const ctx = yesCtx();
    await handlers.jira_confirm_yes({ ack: jest.fn(), body: yesBody(ctx), client, logger });
    const nudged = updates[updates.length - 1].blocks;
    await handlers.jira_confirm_yes({ ack: jest.fn(), body: { ...yesBody(ctx), message: { ts: '1', text: 'x', blocks: nudged } }, client, logger });
    expect(actionIds(updates[updates.length - 1].blocks).filter((a) => a === 'dm_connect_jira')).toHaveLength(1);
  });
});

describe('older asks carrying allowFallback never write as the bot', () => {
  test('risk status and collect save without a token → nothing written, Connect nudge', async () => {
    const statusHandler = (h) => h[Object.keys(h).find((k) => k.startsWith('/^risk_set_status_'))];
    const s1 = setup();
    await statusHandler(s1.handlers)({ ack: jest.fn(), body: { actions: [{ value: JSON.stringify({ askType: 'risk_review', issueKey: 'PR-1', slackUserId: 'U1', status: 'High Risk', allowFallback: true, risk: { status: 'On Track' } }) }], channel: { id: 'D1' }, message: { ts: '1', text: 'o' } }, client: s1.client, logger: s1.logger });
    expect(s1.botJira.transitionIssue).not.toHaveBeenCalled();
    expect(s1.ops.post).toHaveBeenCalledWith(expect.stringMatching(/asked to connect, nothing written/));

    const c = setup();
    const ctx = { askType: 'collect', issueKey: 'PR-2', slackUserId: 'U1', allowFallback: true, collect: { fields: [{ id: 'customfield_11822', name: 'Customer-friendly name', required: true, current: '' }] }, values: { customfield_11822: 'Smart Alerts' } };
    await c.handlers.collect_save({ ack: jest.fn(), body: { actions: [{ value: JSON.stringify(ctx) }], channel: { id: 'D1' }, message: { ts: '1', text: 'o' } }, client: c.client, logger: c.logger });
    expect(c.botJira.updateIssueFields).not.toHaveBeenCalled();
    expect(c.userJira.updateIssueFields).not.toHaveBeenCalled();
  });
});

describe('modal openers and view submissions', () => {
  test('Reply / Update Notes / Answer without a token → modal not opened, nudge shown instead', async () => {
    const { handlers, client, logger, updates } = setup();
    await handlers.jira_reply({ ack: jest.fn(), body: yesBody(yesCtx()), client, logger });
    const riskCtx = { askType: 'risk_review', issueKey: 'PR-1', slackUserId: 'U1', risk: { status: 'On Track', notification: 'n', summary: 's' } };
    await handlers.risk_update_notes({ ack: jest.fn(), body: { actions: [{ value: JSON.stringify(riskCtx) }], channel: { id: 'D1' }, message: { ts: '2', text: 'o', blocks: rr.buildRiskReviewBlocks(riskCtx, 'U1') }, trigger_id: 'T' }, client, logger });
    expect(client.views.open).not.toHaveBeenCalled();
    expect(updates).toHaveLength(2);
    expect(actionIds(updates[1].blocks)).toContain('risk_set_status_high');
    expect(actionIds(updates[1].blocks)).toContain('dm_connect_jira');
  });

  test('risk Notes modal submitted without a token → ask rebuilt from context with Connect, nothing written', async () => {
    const { handlers, client, botJira, userJira, logger, updates } = setup();
    const meta = JSON.stringify({ askType: 'risk_review', issueKey: 'PR-1', slackUserId: 'U1', dmChannelId: 'D1', messageTs: '3', originalText: 'o', risk: { status: 'On Track', notification: 'n', summary: 's' } });
    await handlers.risk_notes_modal({ ack: jest.fn(), body: {}, view: { private_metadata: meta, state: { values: { note_block: { note: { value: 'doing things' } } } } }, client, logger });
    expect(botJira.updateIssueField).not.toHaveBeenCalled(); expect(userJira.updateIssueField).not.toHaveBeenCalled();
    const last = updates[updates.length - 1];
    expect(last.ts).toBe('3');
    expect(actionIds(last.blocks)).toEqual(expect.arrayContaining(['risk_update_notes', 'risk_handled', 'dm_connect_jira']));
  });

  test('risk status: an older ask with allowFallback and no token → nothing; with a token → the user transitions', async () => {
    const statusHandler = (h) => h[Object.keys(h).find((k) => k.startsWith('/^risk_set_status_'))];
    const ctx = { askType: 'risk_review', issueKey: 'PR-1', slackUserId: 'U1', status: 'High Risk', risk: { status: 'On Track' } };
    const body = (c) => ({ actions: [{ value: JSON.stringify(c) }], channel: { id: 'D1' }, message: { ts: '1', text: 'o' } });
    let s = setup();
    await statusHandler(s.handlers)({ ack: jest.fn(), body: body({ ...ctx, allowFallback: true }), client: s.client, logger: s.logger });
    expect(s.botJira.transitionIssue).not.toHaveBeenCalled();
    s = setup({ hasToken: true });
    await statusHandler(s.handlers)({ ack: jest.fn(), body: body(ctx), client: s.client, logger: s.logger });
    expect(s.userJira.transitionIssue).toHaveBeenCalledWith('PR-1', 'High Risk');
    expect(s.botJira.transitionIssue).not.toHaveBeenCalled();
  });

  test('read-only buttons (No, Handled) still work without a token', async () => {
    const { handlers, client, db, logger, updates } = setup();
    await handlers.jira_confirm_no({ ack: jest.fn(), body: yesBody(yesCtx()), client, logger });
    const riskCtx = { askType: 'risk_review', issueKey: 'PR-1', slackUserId: 'U1', risk: {} };
    await handlers.risk_handled({ ack: jest.fn(), body: { actions: [{ value: JSON.stringify(riskCtx) }], channel: { id: 'D1' }, message: { ts: '2', text: 'o' } }, client, logger });
    expect(db.markPromptAnswered).toHaveBeenCalledWith('PR-1', 'U1');
    expect(updates.some((u) => /Connect Jira first/.test(JSON.stringify(u.blocks)))).toBe(false);
  });
});

describe('ctx builders no longer carry allowFallback', () => {
  test('yes/no, risk and collect button contexts', () => {
    const yes = JSON.parse(buildYesNoBlocks({ issueKey: 'SNS-1', question: 'q', transitionTo: 'Done', allowFallback: true }, 'U1')[1].elements[0].value);
    expect(yes).not.toHaveProperty('allowFallback');
    const risk = rr.buildRiskReviewBlocks({ askType: 'risk_review', issueKey: 'PR-1', allowFallback: true, risk: { status: 'On Track' } }, 'U1');
    expect(JSON.parse(risk.find((b) => b.type === 'actions').elements[0].value)).not.toHaveProperty('allowFallback');
    const collect = require('../src/utils/collectMessage').buildCollectBlocks({ askType: 'collect', issueKey: 'PR-1', allowFallback: true, collect: { fields: [] } }, 'U1');
    expect(JSON.parse(collect.find((b) => b.type === 'actions').elements[0].value)).not.toHaveProperty('allowFallback');
  });
});
