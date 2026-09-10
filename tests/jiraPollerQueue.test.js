'use strict';
// Poller: users with a digest preference get queued, not DM'd
const JiraPoller = require('../src/services/jiraPoller');

test('poller queues for digest users and DMs immediate users', async () => {
  const issues = [
    { key: 'SNS-1', fields: { summary: 'A', status: { name: 'Acceptance' }, reporter: { emailAddress: 'a@x.com', displayName: 'A' } } },
    { key: 'SNS-2', fields: { summary: 'B', status: { name: 'Acceptance' }, reporter: { emailAddress: 'b@x.com', displayName: 'B' } } },
  ];
  const jira = { searchIssues: jest.fn().mockResolvedValue(issues) };
  const db = {
    getActiveJiraTriggers: jest.fn().mockResolvedValue([{ id: 't1', name: 'Epics', jql: 'x', question: 'Approve {key}?', notify: 'reporter', action_type: 'transition', transition_to: 'Done', scope: 'global', poll_interval_min: 2, last_polled_at: null }]),
    getPromptedIssueKeys: jest.fn().mockResolvedValue(new Set()),
    recordPrompt: jest.fn().mockResolvedValue(undefined),
    updateJiraTrigger: jest.fn().mockResolvedValue(undefined),
    getUserPreference: jest.fn(async (uid) => (uid === 'UB' ? { digest_frequency: 'daily' } : null)),
  };
  const slack = {
    users: { lookupByEmail: jest.fn(async ({ email }) => ({ user: { id: email.startsWith('a') ? 'UA' : 'UB' } })) },
    chat: { postMessage: jest.fn().mockResolvedValue({ ts: '1' }) },
    conversations: { open: jest.fn(async ({ users }) => ({ channel: { id: 'D' + users } })) },
  };
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const poller = new JiraPoller({ jiraService: jira, db, slackClient: slack, logger });
  const [stats] = await poller.runOnce({ force: true });

  expect(stats.sent).toBe(1);
  expect(stats.queued).toBe(1);
  expect(stats.queuedFor[0]).toMatch(/SNS-2 → <@UB> \(daily\)/);
  // UA got a DM, UB did not
  expect(slack.chat.postMessage).toHaveBeenCalledTimes(1);
  expect(slack.chat.postMessage.mock.calls[0][0].channel).toBe('DUA');
  // UA recorded as delivered with payload; UB recorded as queued (delivered:false)
  expect(db.recordPrompt).toHaveBeenCalledWith('t1', 'SNS-1', 'UA', expect.objectContaining({ payload: expect.objectContaining({ issueKey: 'SNS-1' }) }));
  expect(db.recordPrompt).toHaveBeenCalledWith('t1', 'SNS-2', 'UB', expect.objectContaining({ delivered: false, payload: expect.objectContaining({ transitionTo: 'Done' }) }));
});
