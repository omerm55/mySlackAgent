'use strict';

// The kill switch. While paused: no trigger is evaluated, no ask is sent, and every write path refuses
// and writes nothing — the ask and its prompt row survive so people can act once it resumes.
const pauseMod = require('../src/utils/pauseState');
const JiraPoller = require('../src/services/jiraPoller');
const { registerDmHandler } = require('../src/handlers/dmHandler');
const { registerReactionHandler } = require('../src/handlers/reactionHandler');
const { buildYesNoBlocks } = require('../src/utils/dmQuestion');
process.env.ADMIN_SLACK_USER_IDS = 'UADMIN';
const { registerHomeHandler, buildHomeBlocks } = require('../src/handlers/homeHandler');

const pausedDb = (on, by = 'UADMIN') => ({ getSetting: jest.fn().mockResolvedValue(on ? { key: 'paused', value: { paused: true }, updated_by: by, updated_at: '2026-09-10T08:00:00Z' } : null) });

beforeEach(() => { pauseMod.invalidate(); delete process.env.BOT_PAUSED; });
afterEach(() => { pauseMod.invalidate(); delete process.env.BOT_PAUSED; });

describe('pauseState', () => {
  test('database flag, environment override, and neither', async () => {
    expect(await pauseMod.isPaused(pausedDb(true))).toBe(true);
    pauseMod.invalidate();
    expect(await pauseMod.isPaused(pausedDb(false))).toBe(false);
    pauseMod.invalidate();
    process.env.BOT_PAUSED = 'true';
    expect(await pauseMod.isPaused(null)).toBe(true);           // env alone pauses, no DB needed
    expect((await pauseMod.pauseState(null)).source).toBe('env');
  });

  test('a database failure does not pause the bot by itself', async () => {
    const db = { getSetting: jest.fn().mockRejectedValue(new Error('PostgREST down')) };
    expect(await pauseMod.isPaused(db)).toBe(false);
  });

  test('the value is cached, and invalidate makes a toggle immediate', async () => {
    const db = pausedDb(true);
    await pauseMod.isPaused(db); await pauseMod.isPaused(db);
    expect(db.getSetting).toHaveBeenCalledTimes(1);
    pauseMod.invalidate();
    await pauseMod.isPaused(db);
    expect(db.getSetting).toHaveBeenCalledTimes(2);
  });

  test('setPaused writes the flag with who did it; without Supabase it explains the env var', async () => {
    const db = { setSetting: jest.fn().mockResolvedValue(undefined) };
    await pauseMod.setPaused(db, true, 'UADMIN');
    expect(db.setSetting).toHaveBeenCalledWith('paused', { paused: true }, 'UADMIN');
    await expect(pauseMod.setPaused({}, true, 'U1')).rejects.toThrow(/BOT_PAUSED/);
  });

  test('describePause names the admin, or the environment variable', async () => {
    expect(pauseMod.describePause(await pauseMod.pauseState(pausedDb(true)))).toMatch(/Paused\* by <@UADMIN>/);
    process.env.BOT_PAUSED = 'true'; pauseMod.invalidate();
    expect(pauseMod.describePause(await pauseMod.pauseState(null))).toMatch(/BOT_PAUSED/);
  });
});

describe('poller while paused', () => {
  test('evaluates nothing, sends nothing, tells ops once', async () => {
    const db = { ...pausedDb(true), getActiveJiraTriggers: jest.fn() };
    const jira = { searchIssues: jest.fn() };
    const slack = { chat: { postMessage: jest.fn() }, conversations: { open: jest.fn() }, users: { lookupByEmail: jest.fn() } };
    const ops = { post: jest.fn().mockResolvedValue(undefined) };
    const poller = new JiraPoller({ jiraService: jira, db, slackClient: slack, opsNotifier: ops, logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } });
    expect(await poller.runOnce({ force: true })).toEqual([]);
    expect(db.getActiveJiraTriggers).not.toHaveBeenCalled();
    expect(jira.searchIssues).not.toHaveBeenCalled();
    expect(slack.chat.postMessage).not.toHaveBeenCalled();
    expect(ops.post).toHaveBeenCalledWith(expect.stringMatching(/not evaluated — the bot is paused/), expect.objectContaining({ kind: 'paused_skip' }));
  });
});

describe('DM write paths while paused', () => {
  function setup() {
    const handlers = {};
    const app = { action: (id, fn) => { handlers[String(id)] = fn; }, view: (id, fn) => { handlers[String(id)] = fn; } };
    const updates = [];
    const client = {
      chat: { update: jest.fn(async (p) => { updates.push(p); return {}; }), postMessage: jest.fn().mockResolvedValue({}) },
      views: { open: jest.fn().mockResolvedValue({}) },
      conversations: { open: jest.fn().mockResolvedValue({ channel: { id: 'D1' } }) },
    };
    const jira = { transitionIssue: jest.fn(), updateIssueField: jest.fn(), updateIssueFields: jest.fn(), getIssue: jest.fn() };
    const db = { ...pausedDb(true), markPromptAnswered: jest.fn(), deletePromptsForIssue: jest.fn() };
    const ops = { post: jest.fn().mockResolvedValue(undefined), dmButtonClicked: jest.fn(), riskReviewAction: jest.fn(), collectAction: jest.fn() };
    registerDmHandler(app, jira, { db, llmService: null, oauthService: { hasToken: () => true, generateAuthUrl: jest.fn(), getJiraService: jest.fn().mockResolvedValue(jira) }, opsNotifier: ops, userCache: { getName: jest.fn() } });
    return { handlers, client, jira, db, ops, updates, logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } };
  }
  const ctx = { issueKey: 'SNS-1', question: 'Approve?', transitionTo: 'Done', slackUserId: 'U1' };
  const body = (c = ctx) => ({ actions: [{ value: JSON.stringify(c) }], channel: { id: 'D1' }, message: { ts: '1', text: 'orig', blocks: buildYesNoBlocks(c, 'U1') }, user: { id: 'U1' }, trigger_id: 'T' });

  test('Yes: nothing written, buttons kept, prompt kept, ops told', async () => {
    const { handlers, client, jira, db, ops, updates, logger } = setup();
    await handlers.jira_confirm_yes({ ack: jest.fn(), body: body(), client, logger });
    expect(jira.transitionIssue).not.toHaveBeenCalled();
    expect(db.deletePromptsForIssue).not.toHaveBeenCalled();
    expect(db.markPromptAnswered).not.toHaveBeenCalled();
    const last = updates[updates.length - 1];
    expect(JSON.stringify(last.blocks)).toMatch(/paused by an admin — nothing was changed/);
    expect(JSON.stringify(last.blocks)).toContain('jira_confirm_yes'); // still actionable after resuming
    expect(ops.post).toHaveBeenCalledWith(expect.stringMatching(/while paused — nothing written/), expect.objectContaining({ kind: 'paused_refusal' }));
  });

  test('risk button and collect Save write nothing; the Reply modal does not open', async () => {
    const s = setup();
    const statusHandler = s.handlers[Object.keys(s.handlers).find((k) => k.startsWith('/^risk_set_status_'))];
    await statusHandler({ ack: jest.fn(), body: body({ askType: 'risk_review', issueKey: 'PR-1', slackUserId: 'U1', status: 'High Risk', risk: { status: 'On Track' } }), client: s.client, logger: s.logger });
    expect(s.jira.transitionIssue).not.toHaveBeenCalled();

    await s.handlers.collect_save({ ack: jest.fn(), body: body({ askType: 'collect', issueKey: 'PR-2', slackUserId: 'U1', collect: { fields: [{ id: 'customfield_1', name: 'N', required: true, current: '' }] }, values: { customfield_1: 'v' } }), client: s.client, logger: s.logger });
    expect(s.jira.updateIssueFields).not.toHaveBeenCalled();

    await s.handlers.jira_reply({ ack: jest.fn(), body: body(), client: s.client, logger: s.logger });
    expect(s.client.views.open).not.toHaveBeenCalled();
  });

  test('not paused → the same click goes through', async () => {
    const { handlers, client, jira, db, logger } = setup();
    db.getSetting.mockResolvedValue(null); pauseMod.invalidate();
    await handlers.jira_confirm_yes({ ack: jest.fn(), body: body(), client, logger });
    expect(jira.transitionIssue).toHaveBeenCalledWith('SNS-1', 'Done');
  });
});

describe('reaction while paused', () => {
  test('thread reply explains it, nothing written', async () => {
    const handlers = {};
    const app = { event: (name, fn) => { handlers[name] = fn; } };
    const jira = { updateIssueField: jest.fn() };
    const services = {
      dedupCache: { isDuplicate: () => false }, rateLimiter: { isAllowed: () => true },
      auditLog: { addEntry: jest.fn() }, userCache: { getName: jest.fn() },
      db: pausedDb(true), opsNotifier: { post: jest.fn().mockResolvedValue(undefined) },
      integrationCache: { getAll: async () => [{ name: 'Docs', slackChannelId: 'C1', triggers: ['reaction'], jiraFieldId: 'customfield_1', jiraFieldName: 'F', jiraFieldValue: 'Yes', scope: 'global', allowedSlackUserIds: [], rateLimitPerHour: 20 }] },
    };
    registerReactionHandler(app, jira, { postAttributionComment: jest.fn() }, services);
    const client = {
      conversations: { history: jest.fn().mockResolvedValue({ messages: [{ text: 'SNS-1 please', ts: '1' }] }) },
      chat: { postMessage: jest.fn().mockResolvedValue({}) },
      users: { info: jest.fn() },
    };
    await handlers.reaction_added({ event: { reaction: '+1', user: 'U1', item: { type: 'message', channel: 'C1', ts: '1' } }, client, logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } });
    expect(jira.updateIssueField).not.toHaveBeenCalled();
    expect(client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({ thread_ts: '1', text: expect.stringMatching(/paused by an admin/) }));
  });
});

describe('App Home controls', () => {
  const svc = (db) => ({ oauthService: { hasToken: () => true, generateAuthUrl: jest.fn() }, db, auditLog: { recentFor: async () => [] }, integrationCache: { getAll: jest.fn().mockResolvedValue([]) } });
  const dbFor = (paused) => ({ ...pausedDb(paused), getActiveJiraTriggers: jest.fn().mockResolvedValue([]), getUserPreference: jest.fn().mockResolvedValue(null), getPendingPrompts: jest.fn().mockResolvedValue([]) });

  test('running: admin sees Pause, nobody sees a banner', async () => {
    const t = JSON.stringify(await buildHomeBlocks('UADMIN', svc(dbFor(false))));
    expect(t).toContain('home_pause_bot');
    expect(t).not.toContain('home_resume_bot');
    expect(t).not.toMatch(/Paused\*/);
  });

  test('paused: everyone sees the banner naming who paused it; only an admin gets Resume', async () => {
    const admin = JSON.stringify(await buildHomeBlocks('UADMIN', svc(dbFor(true))));
    expect(admin).toMatch(/Paused\* by <@UADMIN>/);
    expect(admin).toContain('home_resume_bot');
    expect(admin).not.toContain('home_pause_bot');
    pauseMod.invalidate();
    const user = JSON.stringify(await buildHomeBlocks('UREGULAR', svc(dbFor(true))));
    expect(user).toMatch(/Paused\*/);
    expect(user).not.toContain('home_resume_bot');
  });

  test('pausing writes the flag, tells ops and refreshes Home; a non-admin is refused', async () => {
    const handlers = {};
    const app = { event: (id, fn) => { handlers[String(id)] = fn; }, action: (id, fn) => { handlers[String(id)] = fn; }, view: (id, fn) => { handlers[String(id)] = fn; } };
    const db = { ...dbFor(false), setSetting: jest.fn().mockResolvedValue(undefined) };
    const ops = { post: jest.fn().mockResolvedValue(undefined) };
    const client = { views: { publish: jest.fn().mockResolvedValue({}), open: jest.fn() }, chat: { postMessage: jest.fn().mockResolvedValue({}) } };
    registerHomeHandler(app, {}, { ...svc(db), opsNotifier: ops });
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    await handlers.home_pause_bot({ ack: jest.fn(), body: { user: { id: 'UADMIN' } }, client, logger });
    expect(db.setSetting).toHaveBeenCalledWith('paused', { paused: true }, 'UADMIN');
    expect(ops.post).toHaveBeenCalledWith(expect.stringMatching(/paused the bot/), expect.objectContaining({ kind: 'paused' }));
    expect(client.views.publish).toHaveBeenCalled();

    db.setSetting.mockClear();
    await handlers.home_pause_bot({ ack: jest.fn(), body: { user: { id: 'UREGULAR' } }, client, logger });
    expect(db.setSetting).not.toHaveBeenCalled();
    expect(client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringMatching(/Only an admin/) }));
  });

  test('resuming clears the flag and is audited as resumed', async () => {
    const handlers = {};
    const app = { event: () => {}, action: (id, fn) => { handlers[String(id)] = fn; }, view: () => {} };
    const db = { ...dbFor(true), setSetting: jest.fn().mockResolvedValue(undefined) };
    const ops = { post: jest.fn().mockResolvedValue(undefined) };
    registerHomeHandler(app, {}, { ...svc(db), opsNotifier: ops });
    await handlers.home_resume_bot({ ack: jest.fn(), body: { user: { id: 'UADMIN' } }, client: { views: { publish: jest.fn().mockResolvedValue({}) }, chat: { postMessage: jest.fn() } }, logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } });
    expect(db.setSetting).toHaveBeenCalledWith('paused', { paused: false }, 'UADMIN');
    expect(ops.post).toHaveBeenCalledWith(expect.stringMatching(/resumed the bot/), expect.objectContaining({ kind: 'resumed' }));
  });
});
