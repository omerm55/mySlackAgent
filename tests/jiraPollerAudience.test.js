'use strict';

const JiraPoller = require('../src/services/jiraPoller');
const { resolvePerson, fieldsFor } = JiraPoller;
const { FIELDS } = require('../src/utils/riskReviewMessage');

// Dated today so the age filter never makes this fixture stale; mentions red progress so the flag filter passes.
const todayStamp = (() => { const d = new Date(); return `${d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })} ${d.getUTCDate()}`; })();
const NOTIF = `${todayStamp} — Overdue 5d; Progress red 12%/exp 50%. Action: flag at risk; update progress`;
const person = (email, name) => ({ emailAddress: email, displayName: name });

describe('resolvePerson', () => {
  const issue = { fields: { reporter: person('r@x.com', 'Rep'), assignee: person('a@x.com', 'Asg'), [FIELDS.DEV_OWNER]: [person('dev@x.com', 'Dev'), person('dev2@x.com', 'Dev2')] } };
  test('reporter / assignee as before', () => {
    expect(resolvePerson(issue, { notify: 'reporter' }).person.emailAddress).toBe('r@x.com');
    expect(resolvePerson(issue, { notify: 'assignee' }).person.emailAddress).toBe('a@x.com');
  });
  test('user_field → first user of the array', () => {
    const r = resolvePerson(issue, { notify: 'user_field', notify_field_id: FIELDS.DEV_OWNER });
    expect(r.person.emailAddress).toBe('dev@x.com');
    expect(r.source).toBe(FIELDS.DEV_OWNER);
  });
  test('user_field empty → assignee → reporter fallbacks', () => {
    const noDev = { fields: { ...issue.fields, [FIELDS.DEV_OWNER]: [] } };
    expect(resolvePerson(noDev, { notify: 'user_field', notify_field_id: FIELDS.DEV_OWNER })).toMatchObject({ person: { emailAddress: 'a@x.com' }, source: 'assignee (fallback)' });
    const noOne = { fields: { reporter: person('r@x.com', 'Rep') } };
    expect(resolvePerson(noOne, { notify: 'user_field', notify_field_id: FIELDS.DEV_OWNER })).toMatchObject({ person: { emailAddress: 'r@x.com' }, source: 'reporter (fallback)' });
  });
  test('fieldsFor requests the user field, watch field and risk fields', () => {
    const f = fieldsFor({ notify: 'user_field', notify_field_id: FIELDS.DEV_OWNER, watch_field: FIELDS.NOTIFICATION, ask_type: 'risk_review' });
    expect(f).toEqual(expect.arrayContaining(['summary', 'status', 'reporter', 'assignee', FIELDS.DEV_OWNER, FIELDS.NOTIFICATION, FIELDS.TARGET, FIELDS.NOTES]));
  });
});

describe('poller: risk_review + watch_field', () => {
  const trigger = {
    id: 't1', name: 'Risk', jql: 'x', question: '{link} was flagged.', scope: 'global',
    notify: 'user_field', notify_field_id: FIELDS.DEV_OWNER, ask_type: 'risk_review', watch_field: FIELDS.NOTIFICATION,
    poll_interval_min: 60, last_polled_at: null,
  };
  const issue = (notif) => ({
    key: 'PR-1', fields: { summary: 'Smart Alerts', status: { name: 'On Track' }, reporter: person('r@x.com', 'Rep'),
      [FIELDS.DEV_OWNER]: [person('dev@x.com', 'Dev')], [FIELDS.NOTIFICATION]: notif, [FIELDS.TARGET]: '{"start":"2026-06-01","end":"2026-08-31"}' },
  });

  function setup({ rows = [], notif = NOTIF } = {}) {
    const jira = { searchIssues: jest.fn().mockResolvedValue([issue(notif)]) };
    const db = {
      getActiveJiraTriggers: jest.fn().mockResolvedValue([trigger]),
      getPromptsForTrigger: jest.fn().mockResolvedValue(rows),
      getPromptedIssueKeys: jest.fn(),
      recordPrompt: jest.fn().mockResolvedValue(undefined),
      updateJiraTrigger: jest.fn().mockResolvedValue(undefined),
      updatePromptPayload: jest.fn().mockResolvedValue(undefined),
      deletePromptsForIssue: jest.fn().mockResolvedValue(undefined),
      getUserPreference: jest.fn().mockResolvedValue(null),
    };
    const slack = {
      users: { lookupByEmail: jest.fn().mockResolvedValue({ user: { id: 'UDEV' } }) },
      chat: { postMessage: jest.fn().mockResolvedValue({ ts: '1' }) },
      conversations: { open: jest.fn().mockResolvedValue({ channel: { id: 'DDEV' } }) },
    };
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    return { poller: new JiraPoller({ jiraService: jira, db, slackClient: slack, logger }), jira, db, slack };
  }

  test('new issue → DMs the Dev owner with a risk-review message and stores the watched value', async () => {
    const { poller, jira, db, slack } = setup();
    const [stats] = await poller.runOnce({ force: true });
    expect(jira.searchIssues).toHaveBeenCalledWith('x', expect.arrayContaining([FIELDS.DEV_OWNER, FIELDS.NOTIFICATION, FIELDS.TARGET]));
    expect(stats.sent).toBe(1);
    expect(slack.chat.postMessage).toHaveBeenCalledTimes(1);
    const msg = slack.chat.postMessage.mock.calls[0][0];
    expect(msg.channel).toBe('DDEV');
    expect(JSON.stringify(msg.blocks)).toContain(NOTIF);
    expect(msg.blocks.some((b) => b.type === 'actions' && b.elements.some((e) => e.action_id === 'risk_set_status_high'))).toBe(true);
    expect(db.recordPrompt).toHaveBeenCalledWith('t1', 'PR-1', 'UDEV', expect.objectContaining({
      payload: expect.objectContaining({ askType: 'risk_review', watchedValue: NOTIF, risk: expect.objectContaining({ status: 'On Track', targetEnd: '2026-08-31' }) }),
    }));
  });

  test('already asked, watched value unchanged → nothing sent', async () => {
    const { poller, slack, db } = setup({ rows: [{ id: 'p1', issue_key: 'PR-1', slack_user_id: 'UDEV', payload: { watchedValue: NOTIF } }] });
    const [stats] = await poller.runOnce({ force: true });
    expect(stats.fresh).toBe(0);
    expect(slack.chat.postMessage).not.toHaveBeenCalled();
    expect(db.deletePromptsForIssue).not.toHaveBeenCalled();
  });

  test('already asked, watched value changed (new weekly run) → old prompt deleted and re-asked', async () => {
    const { poller, slack, db } = setup({ rows: [{ id: 'p1', issue_key: 'PR-1', slack_user_id: 'UDEV', payload: { watchedValue: 'Sep 1 — Overdue 1d. Action: flag at risk' } }] });
    const [stats] = await poller.runOnce({ force: true });
    expect(db.deletePromptsForIssue).toHaveBeenCalledWith('PR-1', 'UDEV');
    expect(stats.sent).toBe(1);
    expect(stats.skipped).toEqual(expect.arrayContaining([expect.stringMatching(/1 re-asked because/)]));
    expect(slack.chat.postMessage).toHaveBeenCalledTimes(1);
  });

  test('legacy row without watchedValue → remembered, not re-asked', async () => {
    const { poller, slack, db } = setup({ rows: [{ id: 'p1', issue_key: 'PR-1', slack_user_id: 'UDEV', payload: { issueKey: 'PR-1' } }] });
    await poller.runOnce({ force: true });
    expect(db.updatePromptPayload).toHaveBeenCalledWith('p1', expect.objectContaining({ watchedValue: NOTIF }));
    expect(slack.chat.postMessage).not.toHaveBeenCalled();
  });
});

describe('poller: collect ask type', () => {
  const NAME = 'customfield_11822'; const VALUE = 'customfield_15249'; const PM = 'customfield_11909';
  const trigger = {
    id: 't5', name: 'A1', jql: 'x', question: '', scope: 'global', notify: 'user_field', notify_field_id: PM, ask_type: 'collect',
    collect_fields: [{ id: NAME, name: 'Customer-friendly name', hint: 'External-facing name', required: true }, { id: VALUE, name: 'Customer value', required: true }],
    poll_interval_min: 60, last_polled_at: null, fyi_field_id: null,
  };
  test('requests the collect fields, DMs the PM owner an Answer/Skip ask with current values in the payload', async () => {
    const jira = { searchIssues: jest.fn().mockResolvedValue([{ key: 'PR-7', fields: { summary: 'Smart Alerts', status: { name: 'Now' }, reporter: person('r@x.com', 'R'), [PM]: [person('pm@x.com', 'PM')], [NAME]: 'Smart Alerts', [VALUE]: null } }]) };
    const db = {
      getActiveJiraTriggers: jest.fn().mockResolvedValue([trigger]), getPromptsForTrigger: jest.fn().mockResolvedValue([]), getPromptedIssueKeys: jest.fn().mockResolvedValue(new Set()),
      recordPrompt: jest.fn().mockResolvedValue(undefined), updateJiraTrigger: jest.fn().mockResolvedValue(undefined), getUserPreference: jest.fn().mockResolvedValue(null),
    };
    const slack = {
      users: { lookupByEmail: jest.fn().mockResolvedValue({ user: { id: 'UPM' } }) },
      chat: { postMessage: jest.fn().mockResolvedValue({ ts: '1' }) },
      conversations: { open: jest.fn().mockResolvedValue({ channel: { id: 'DPM' } }) },
    };
    const poller = new JiraPoller({ jiraService: jira, db, slackClient: slack, logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } });
    const [stats] = await poller.runOnce({ force: true });
    expect(jira.searchIssues).toHaveBeenCalledWith('x', expect.arrayContaining([PM, NAME, VALUE, 'customfield_12170', 'customfield_14817']));
    expect(stats.sent).toBe(1);
    const msg = slack.chat.postMessage.mock.calls[0][0];
    expect(msg.channel).toBe('DPM');
    expect(msg.blocks.some((b) => b.type === 'actions' && b.elements.some((e) => e.action_id === 'collect_answer'))).toBe(true);
    expect(JSON.stringify(msg.blocks)).toContain('Customer value:* _empty_');
    expect(db.recordPrompt).toHaveBeenCalledWith('t5', 'PR-7', 'UPM', expect.objectContaining({
      payload: expect.objectContaining({ askType: 'collect', allowFallback: false, collect: expect.objectContaining({ summary: 'Smart Alerts', fields: [expect.objectContaining({ id: NAME, current: 'Smart Alerts' }), expect.objectContaining({ id: VALUE, current: '' })] }) }),
    }));
  });
});

describe('poller: FYI to the PM owner', () => {
  const { fyiFieldFor } = JiraPoller;
  test('fyiFieldFor: explicit field wins; risk reviews default to the PM owner; yes/no has none', () => {
    expect(fyiFieldFor({ ask_type: 'risk_review', fyi_field_id: 'customfield_1' })).toBe('customfield_1');
    expect(fyiFieldFor({ ask_type: 'risk_review', fyi_field_id: null })).toBe(FIELDS.PM_OWNER);
    expect(fyiFieldFor({ ask_type: 'yes_no', fyi_field_id: null })).toBeNull();
  });

  const trigger = {
    id: 't2', name: 'Risk', jql: 'x', question: '{link} was flagged.', scope: 'global',
    notify: 'user_field', notify_field_id: FIELDS.DEV_OWNER, ask_type: 'risk_review', watch_field: null,
    poll_interval_min: 60, last_polled_at: null, fyi_field_id: null,
  };
  const issueWith = (pmEmail) => ({
    key: 'PR-2', fields: { summary: 'S', status: { name: 'On Track' }, reporter: person('r@x.com', 'Rep'),
      [FIELDS.DEV_OWNER]: [person('dev@x.com', 'Dev')], [FIELDS.PM_OWNER]: [person(pmEmail, 'PM')],
      [FIELDS.NOTIFICATION]: NOTIF, [FIELDS.TARGET]: null },
  });
  function setup(issue) {
    const jira = { searchIssues: jest.fn().mockResolvedValue([issue]) };
    const db = {
      getActiveJiraTriggers: jest.fn().mockResolvedValue([trigger]),
      getPromptedIssueKeys: jest.fn().mockResolvedValue(new Set()),
      recordPrompt: jest.fn().mockResolvedValue(undefined),
      updateJiraTrigger: jest.fn().mockResolvedValue(undefined),
      getUserPreference: jest.fn().mockResolvedValue(null),
    };
    const ids = { 'dev@x.com': 'UDEV', 'pm@x.com': 'UPM' };
    const slack = {
      users: { lookupByEmail: jest.fn(async ({ email }) => ({ user: { id: ids[email] } })) },
      chat: { postMessage: jest.fn().mockResolvedValue({ ts: '1' }) },
      conversations: { open: jest.fn(async ({ users }) => ({ channel: { id: 'D' + users } })) },
    };
    const ops = { post: jest.fn().mockResolvedValue(undefined), dmQuestionSent: jest.fn().mockResolvedValue(undefined) };
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    return { poller: new JiraPoller({ jiraService: jira, db, slackClient: slack, opsNotifier: ops, logger }), jira, db, slack, ops };
  }

  test('PM owner ≠ Dev owner → Dev gets the ask, PM gets a buttonless FYI, payload carries fyiSlackUserId', async () => {
    const { poller, jira, db, slack, ops } = setup(issueWith('pm@x.com'));
    const [stats] = await poller.runOnce({ force: true });
    expect(jira.searchIssues.mock.calls[0][1]).toEqual(expect.arrayContaining([FIELDS.PM_OWNER]));
    expect(stats.sent).toBe(1);
    expect(stats.fyi).toBe(1);
    const byChannel = Object.fromEntries(slack.chat.postMessage.mock.calls.map((c) => [c[0].channel, c[0]]));
    expect(byChannel.DUDEV.blocks.some((b) => b.type === 'actions')).toBe(true);
    expect(byChannel.DUPM.blocks.some((b) => b.type === 'actions')).toBe(false);
    expect(JSON.stringify(byChannel.DUPM.blocks)).toContain('<@UDEV>');
    expect(JSON.stringify(byChannel.DUPM.blocks)).toContain(NOTIF);
    // the Dev owner's buttons carry the FYI recipient for follow-ups
    const btn = JSON.parse(byChannel.DUDEV.blocks.find((b) => b.type === 'actions').elements[0].value);
    expect(btn.fyiSlackUserId).toBe('UPM');
    expect(db.recordPrompt).toHaveBeenCalledWith('t2', 'PR-2', 'UDEV', expect.objectContaining({ payload: expect.objectContaining({ fyiSlackUserId: 'UPM' }) }));
    expect(ops.post).toHaveBeenCalledWith(expect.stringMatching(/FYI sent to <@UPM>/));
  });

  test('PM owner is the Dev owner → no FYI', async () => {
    const { poller, slack } = setup(issueWith('dev@x.com'));
    const [stats] = await poller.runOnce({ force: true });
    expect(stats.fyi).toBe(0);
    expect(slack.chat.postMessage).toHaveBeenCalledTimes(1);
  });
});

describe('poller: pilot list', () => {
  const base = {
    id: 't3', name: 'Risk', jql: 'x', question: '{link} was flagged.', scope: 'global',
    notify: 'user_field', notify_field_id: FIELDS.DEV_OWNER, ask_type: 'risk_review', watch_field: null,
    poll_interval_min: 60, last_polled_at: null, fyi_field_id: null,
  };
  const issue = (key, devEmail, pmEmail) => ({
    key, fields: { summary: key, status: { name: 'On Track' }, reporter: person('r@x.com', 'Rep'),
      [FIELDS.DEV_OWNER]: [person(devEmail, devEmail)], [FIELDS.PM_OWNER]: [person(pmEmail, pmEmail)],
      [FIELDS.NOTIFICATION]: NOTIF, [FIELDS.TARGET]: null },
  });
  function setup(trigger, issues) {
    const ids = { 'yehuda@x.com': 'UYEHUDA', 'omer@x.com': 'UOMER', 'pm@x.com': 'UPM' };
    const jira = { searchIssues: jest.fn().mockResolvedValue(issues) };
    const db = {
      getActiveJiraTriggers: jest.fn().mockResolvedValue([trigger]),
      getPromptedIssueKeys: jest.fn().mockResolvedValue(new Set()),
      recordPrompt: jest.fn().mockResolvedValue(undefined),
      updateJiraTrigger: jest.fn().mockResolvedValue(undefined),
      getUserPreference: jest.fn().mockResolvedValue(null),
    };
    const slack = {
      users: { lookupByEmail: jest.fn(async ({ email }) => ({ user: { id: ids[email] } })) },
      chat: { postMessage: jest.fn().mockResolvedValue({ ts: '1' }) },
      conversations: { open: jest.fn(async ({ users }) => ({ channel: { id: 'D' + users } })) },
    };
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    return { poller: new JiraPoller({ jiraService: jira, db, slackClient: slack, logger }), db, slack };
  }

  test('only pilot users are asked; others are skipped without being recorded; FYI outside the list is suppressed', async () => {
    const trigger = { ...base, pilot_slack_user_ids: ['UYEHUDA'] };
    const { poller, db, slack } = setup(trigger, [issue('PR-10', 'yehuda@x.com', 'pm@x.com'), issue('PR-11', 'omer@x.com', 'pm@x.com')]);
    const [stats] = await poller.runOnce({ force: true });
    expect(stats.sent).toBe(1);
    expect(stats.fyi).toBe(0); // PM is not on the pilot list
    expect(stats.pilotSkipped).toBe(1);
    expect(stats.skipped).toEqual(expect.arrayContaining([expect.stringMatching(/1 outside the pilot list/)]));
    const channels = slack.chat.postMessage.mock.calls.map((c) => c[0].channel);
    expect(channels).toEqual(['DUYEHUDA']);
    expect(db.recordPrompt).toHaveBeenCalledTimes(1);
    expect(db.recordPrompt).toHaveBeenCalledWith('t3', 'PR-10', 'UYEHUDA', expect.anything());
  });

  test('pilot list including the PM → FYI goes out; empty list → everyone', async () => {
    const withPm = { ...base, pilot_slack_user_ids: ['UYEHUDA', 'UPM'] };
    const a = setup(withPm, [issue('PR-10', 'yehuda@x.com', 'pm@x.com')]);
    const [s1] = await a.poller.runOnce({ force: true });
    expect(s1.sent).toBe(1); expect(s1.fyi).toBe(1);

    const open = { ...base, pilot_slack_user_ids: null };
    const b = setup(open, [issue('PR-10', 'yehuda@x.com', 'pm@x.com'), issue('PR-11', 'omer@x.com', 'pm@x.com')]);
    const [s2] = await b.poller.runOnce({ force: true });
    expect(s2.sent).toBe(2); expect(s2.pilotSkipped).toBe(0);
  });
});

describe('poller: stale notifications are skipped', () => {
  const trigger = {
    id: 't4', name: 'Risk', jql: 'x', question: '{link} was flagged.', scope: 'global',
    notify: 'user_field', notify_field_id: FIELDS.DEV_OWNER, ask_type: 'risk_review', watch_field: FIELDS.NOTIFICATION,
    poll_interval_min: 60, last_polled_at: null, fyi_field_id: null,
  };
  const today = new Date();
  const stamp = (daysAgo) => {
    const d = new Date(today.getTime() - daysAgo * 24 * 3600 * 1000);
    return `${d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })} ${d.getUTCDate()} — Progress red 1%/exp 50%. Action: update progress`;
  };
  const issue = (key, notif) => ({ key, fields: { summary: key, status: { name: 'On Track' }, reporter: person('r@x.com', 'R'), [FIELDS.DEV_OWNER]: [person('dev@x.com', 'Dev')], [FIELDS.NOTIFICATION]: notif, [FIELDS.TARGET]: null } });

  test('only the latest run\'s notifications fire; old ones are counted, not recorded', async () => {
    const jira = { searchIssues: jest.fn().mockResolvedValue([issue('PR-1', stamp(2)), issue('PR-2', stamp(30)), issue('PR-3', stamp(90))]) };
    const db = {
      getActiveJiraTriggers: jest.fn().mockResolvedValue([trigger]),
      getPromptsForTrigger: jest.fn().mockResolvedValue([]),
      recordPrompt: jest.fn().mockResolvedValue(undefined),
      updateJiraTrigger: jest.fn().mockResolvedValue(undefined),
      getUserPreference: jest.fn().mockResolvedValue(null),
    };
    const slack = {
      users: { lookupByEmail: jest.fn().mockResolvedValue({ user: { id: 'UDEV' } }) },
      chat: { postMessage: jest.fn().mockResolvedValue({ ts: '1' }) },
      conversations: { open: jest.fn().mockResolvedValue({ channel: { id: 'D' } }) },
    };
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const poller = new JiraPoller({ jiraService: jira, db, slackClient: slack, logger });
    const [stats] = await poller.runOnce({ force: true });
    expect(stats.sent).toBe(1);
    expect(stats.stale).toBe(2);
    expect(stats.skipped).toEqual(expect.arrayContaining([expect.stringMatching(/2 stale notification/)]));
    expect(db.recordPrompt).toHaveBeenCalledTimes(1);
    expect(db.recordPrompt).toHaveBeenCalledWith('t4', 'PR-1', 'UDEV', expect.anything());
  });

  test('only notifications about "progress red" fire; other flags are counted, not recorded', async () => {
    const fresh = (flags) => stamp(1).replace('Progress red 1%/exp 50%. Action: update progress', flags);
    const jira = { searchIssues: jest.fn().mockResolvedValue([
      issue('PR-1', fresh('Overdue 5d; Progress red 12%/exp 50%. Action: flag at risk; update progress')),
      issue('PR-2', fresh('Progress orange 64%/exp 80%. Action: update progress')),
      issue('PR-3', fresh('Status mismatch. Action: update Status')),
      issue('PR-4', fresh('Overdue 3d. Action: flag at risk')),
    ]) };
    const db = {
      getActiveJiraTriggers: jest.fn().mockResolvedValue([trigger]),
      getPromptsForTrigger: jest.fn().mockResolvedValue([]),
      recordPrompt: jest.fn().mockResolvedValue(undefined),
      updateJiraTrigger: jest.fn().mockResolvedValue(undefined),
      getUserPreference: jest.fn().mockResolvedValue(null),
    };
    const slack = {
      users: { lookupByEmail: jest.fn().mockResolvedValue({ user: { id: 'UDEV' } }) },
      chat: { postMessage: jest.fn().mockResolvedValue({ ts: '1' }) },
      conversations: { open: jest.fn().mockResolvedValue({ channel: { id: 'D' } }) },
    };
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const poller = new JiraPoller({ jiraService: jira, db, slackClient: slack, logger });
    const [stats] = await poller.runOnce({ force: true });
    expect(stats.sent).toBe(1);
    expect(stats.offTopic).toBe(3);
    expect(stats.stale).toBe(0);
    expect(stats.skipped).toEqual(expect.arrayContaining([expect.stringMatching(/3 notification\(s\) not about "progress red"/)]));
    expect(db.recordPrompt).toHaveBeenCalledTimes(1);
    expect(db.recordPrompt).toHaveBeenCalledWith('t4', 'PR-1', 'UDEV', expect.anything());
  });
});
