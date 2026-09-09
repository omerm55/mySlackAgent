'use strict';

const JiraPoller = require('../src/services/jiraPoller');
const { resolvePerson, fieldsFor } = JiraPoller;
const { FIELDS } = require('../src/utils/riskReviewMessage');

const NOTIF = 'Sep 8 — Overdue 5d. Action: flag at risk';
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
    expect(f).toEqual(expect.arrayContaining(['summary', 'status', 'reporter', 'assignee', FIELDS.DEV_OWNER, FIELDS.NOTIFICATION, FIELDS.TARGET]));
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
