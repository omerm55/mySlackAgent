'use strict';

/**
 * Fix Version checked before asking someone to close an issue: when Jira will want one the issue
 * doesn't have, the ask suggests one and Yes sets it; when it is already set, the ask is unchanged.
 */
const { fixVersionNeeded, fixVersionForAsk } = require('../src/services/fixVersionSuggester');
const { buildYesNoBlocks } = require('../src/utils/dmQuestion');
const { registerDmHandler } = require('../src/handlers/dmHandler');
const { DigestScheduler } = require('../src/services/digestScheduler');
const JiraPoller = require('../src/services/jiraPoller');
const { connectedAs } = require('./helpers/connectedAs');

const doneTransition = { id: '361', name: 'Done', to: { name: 'Done', statusCategory: { key: 'done' } }, fields: { fixVersions: { name: 'Fix versions', required: false } } };
const cancelTransition = { id: '261', name: 'Cancelled', to: { name: 'Canceled', statusCategory: { key: 'done' } }, fields: {} };
const acceptanceTransition = { id: '291', name: 'Acceptance', to: { name: 'Acceptance', statusCategory: { key: 'indeterminate' } }, fields: { fixVersions: { name: 'Fix versions', required: false } } };

/** Jira read client for an epic in Acceptance whose children are all in 2026.4.0. */
function readJira({ fixVersions = [], transitions = [doneTransition, cancelTransition, acceptanceTransition] } = {}) {
  return {
    getIssue: jest.fn().mockResolvedValue({ fields: { summary: 'Epic', status: { name: 'Acceptance' }, fixVersions } }),
    getTransitions: jest.fn().mockResolvedValue(transitions),
    searchIssues: jest.fn().mockResolvedValue([
      { key: 'SNS-2', fields: { summary: 'c', status: { name: 'Done' }, fixVersions: [{ id: '40', name: '2026.4.0' }] } },
    ]),
    getProjectVersions: jest.fn().mockResolvedValue([{ id: '40', name: '2026.4.0' }, { id: '32', name: '2026.3.2' }]),
  };
}
const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
const actionIds = (blocks) => blocks.filter((b) => b.type === 'actions').flatMap((b) => b.elements.map((e) => e.action_id));

describe('fixVersionNeeded', () => {
  test('closing transition with Fix Version on its screen, issue has none → needed', async () => {
    expect(await fixVersionNeeded(readJira(), 'SNS-1', 'Done')).toBe(true);
  });
  test('Fix Version already set → not needed', async () => {
    expect(await fixVersionNeeded(readJira({ fixVersions: [{ id: '40', name: '2026.4.0' }] }), 'SNS-1', 'Done')).toBe(false);
  });
  test('a closing transition without the field on its screen (Cancel) → not needed', async () => {
    expect(await fixVersionNeeded(readJira(), 'SNS-1', 'Canceled')).toBe(false);
  });
  test('a transition that does not close the issue → not needed', async () => {
    expect(await fixVersionNeeded(readJira(), 'SNS-1', 'Acceptance')).toBe(false);
  });
  test('no such transition → not needed (the normal Yes reports it)', async () => {
    expect(await fixVersionNeeded(readJira(), 'SNS-1', 'Released')).toBe(false);
  });
});

describe('fixVersionForAsk', () => {
  test('needed → a compact suggestion with the basis', async () => {
    const fv = await fixVersionForAsk({ jira: readJira(), llm: null, db: null, issueKey: 'SNS-1', transitionTo: 'Done', logger });
    expect(fv.pick).toEqual({ id: '40', name: '2026.4.0', released: false });
    expect(fv.reason).toMatch(/child issue/);
    expect(fv.basis).toMatch(/1 child issue/);
  });
  test('already set → null, so the ask is unchanged', async () => {
    const fv = await fixVersionForAsk({ jira: readJira({ fixVersions: [{ id: '40' }] }), issueKey: 'SNS-1', transitionTo: 'Done', logger });
    expect(fv).toBeNull();
  });
  test('the check fails → null (ask as before; a refusal still gets the offer)', async () => {
    const jira = readJira();
    jira.getTransitions.mockRejectedValue(new Error('HTTP 500'));
    expect(await fixVersionForAsk({ jira, issueKey: 'SNS-1', transitionTo: 'Done', logger })).toBeNull();
  });
  test('needed but the suggestion fails → picker only', async () => {
    const jira = readJira();
    jira.getProjectVersions.mockImplementation(() => new Promise(() => {})); // never answers
    const fv = await fixVersionForAsk({ jira, issueKey: 'SNS-1', transitionTo: 'Done', logger, budgetMs: 20, stageTimeoutMs: 40 });
    expect(fv).toEqual({ pick: null, reason: '', alternative: null, basis: '' });
  });
  test('field asks (no transition) are never checked', async () => {
    const jira = readJira();
    expect(await fixVersionForAsk({ jira, issueKey: 'SNS-1', transitionTo: undefined, logger })).toBeNull();
    expect(jira.getIssue).not.toHaveBeenCalled();
  });
});

describe('the ask', () => {
  const ctx = { issueKey: 'SNS-1', question: 'Close SNS-1?', transitionTo: 'Done' };
  const fv = {
    pick: { id: '40', name: '2026.4.0', released: false }, reason: 'all 3 versioned child issue(s) are in 2026.4.0',
    alternative: { id: '41', name: '2026.4.1', reason: 'the release currently in progress' }, basis: '3 child issue(s)',
  };

  test('without a Fix Version need: plain Yes / No / Reply', () => {
    expect(actionIds(buildYesNoBlocks(ctx, 'U1'))).toEqual(['jira_confirm_yes', 'jira_confirm_no', 'jira_reply']);
  });

  test('with one: Yes sets the suggestion, the alternative, or another version', () => {
    const blocks = buildYesNoBlocks({ ...ctx, fixVersion: fv }, 'U1');
    const ids = actionIds(blocks);
    expect(ids).toEqual(['jira_fixversion_apply', 'jira_fixversion_apply_alt', 'jira_set_fixversion', 'jira_confirm_no', 'jira_reply']);
    expect(new Set(ids).size).toBe(ids.length);
    expect(blocks[0].text.text).toMatch(/needs a \*Fix Version\* to move it to \*Done\*/);
    expect(blocks[0].text.text).toMatch(/Suggested: \*2026\.4\.0\*/);
    expect(blocks[0].text.text).toMatch(/Alternative: \*2026\.4\.1\*/);
    const [apply, alt, pick] = blocks[1].elements;
    expect(apply.text.text).toBe('✅ Yes, with 2026.4.0');
    expect(JSON.parse(apply.value)).toMatchObject({ issueKey: 'SNS-1', transitionTo: 'Done', versionId: '40', versionName: '2026.4.0', slackUserId: 'U1' });
    expect(JSON.parse(alt.value)).toMatchObject({ versionId: '41', versionName: '2026.4.1' });
    expect(JSON.parse(pick.value)).toMatchObject({ suggestedId: '40' });
    for (const b of blocks[1].elements) expect(b.value.length).toBeLessThan(2000);
  });

  test('needed with no suggestion: Yes opens the picker', () => {
    const blocks = buildYesNoBlocks({ ...ctx, fixVersion: { pick: null, reason: '', alternative: null, basis: '' } }, 'U1');
    expect(actionIds(blocks)).toEqual(['jira_set_fixversion', 'jira_confirm_no', 'jira_reply']);
    expect(blocks[1].elements[0].style).toBe('primary');
    expect(blocks[0].text.text).toMatch(/couldn't suggest one/);
  });

  test('field asks ignore a stray fixVersion', () => {
    const blocks = buildYesNoBlocks({ issueKey: 'SNS-1', question: 'q', jiraFieldId: 'cf', jiraFieldValue: 'v', fixVersion: fv }, 'U1');
    expect(actionIds(blocks)[0]).toBe('jira_confirm_yes');
  });
});

describe('poller', () => {
  function run(jiraOverrides) {
    const jira = {
      ...readJira(jiraOverrides),
      searchIssues: jest.fn(async (jql) => (jql === 'x'
        ? [{ key: 'SNS-1', fields: { summary: 'A', status: { name: 'Acceptance' }, reporter: { emailAddress: 'a@x.com', displayName: 'A' } } }]
        : [{ key: 'SNS-2', fields: { summary: 'c', status: { name: 'Done' }, fixVersions: [{ id: '40', name: '2026.4.0' }] } }])),
    };
    const db = {
      getActiveJiraTriggers: jest.fn().mockResolvedValue([{ id: 't1', name: 'Epics', jql: 'x', question: 'Close {key}?', notify: 'reporter', action_type: 'transition', transition_to: 'Done', scope: 'global', poll_interval_min: 2, last_polled_at: null }]),
      getPromptedIssueKeys: jest.fn().mockResolvedValue(new Set()),
      recordPrompt: jest.fn().mockResolvedValue(undefined),
      updateJiraTrigger: jest.fn().mockResolvedValue(undefined),
      getUserPreference: jest.fn().mockResolvedValue(null),
    };
    const slack = {
      users: { lookupByEmail: jest.fn().mockResolvedValue({ user: { id: 'UA' } }) },
      chat: { postMessage: jest.fn().mockResolvedValue({ ts: '1' }) },
      conversations: { open: jest.fn().mockResolvedValue({ channel: { id: 'DUA' } }) },
    };
    const poller = new JiraPoller({ jiraService: jira, db, slackClient: slack, logger });
    return poller.runOnce({ force: true }).then(() => ({ slack, db }));
  }

  test('closing needs a Fix Version → the DM suggests one', async () => {
    const { slack, db } = await run();
    const msg = slack.chat.postMessage.mock.calls[0][0];
    expect(actionIds(msg.blocks)[0]).toBe('jira_fixversion_apply');
    expect(msg.blocks[0].text.text).toMatch(/Suggested: \*2026\.4\.0\*/);
    // the suggestion is worked out per delivery, not stored with the prompt
    expect(db.recordPrompt.mock.calls[0][3].payload.fixVersion).toBeUndefined();
  });

  test('Fix Version already set → the DM is the plain ask', async () => {
    const { slack } = await run({ fixVersions: [{ id: '40', name: '2026.4.0' }] });
    expect(actionIds(slack.chat.postMessage.mock.calls[0][0].blocks)[0]).toBe('jira_confirm_yes');
  });
});

test('digest delivery checks the Fix Version when it sends, not when it queued', async () => {
  const db = {
    getPendingPrompts: jest.fn().mockResolvedValue([{ id: 'a', issue_key: 'SNS-1', payload: { issueKey: 'SNS-1', question: 'Close SNS-1?', transitionTo: 'Done' } }]),
    markPromptsDelivered: jest.fn().mockResolvedValue(undefined),
    upsertUserPreference: jest.fn().mockResolvedValue(undefined),
  };
  const slack = {
    chat: { postMessage: jest.fn().mockResolvedValue({ ts: '1' }) },
    conversations: { open: jest.fn().mockResolvedValue({ channel: { id: 'D1' } }) },
  };
  const scheduler = new DigestScheduler({ db, slackClient: slack, jiraService: readJira(), logger });
  await scheduler.deliverTo('U1');
  const question = slack.chat.postMessage.mock.calls[1][0];
  expect(actionIds(question.blocks)[0]).toBe('jira_fixversion_apply');
});

describe('clicking Yes, with <version> on the ask', () => {
  function setup() {
    const handlers = {};
    const app = { action: (id, fn) => { handlers[String(id)] = fn; }, view: (id, fn) => { handlers[String(id)] = fn; } };
    const client = {
      chat: { update: jest.fn().mockResolvedValue({}), postMessage: jest.fn().mockResolvedValue({}) },
      views: { open: jest.fn().mockResolvedValue({}) },
    };
    const jira = {
      updateIssueField: jest.fn().mockResolvedValue(undefined),
      transitionIssue: jest.fn().mockResolvedValue(undefined),
      getProjectVersions: jest.fn().mockResolvedValue([{ id: '40', name: '2026.4.0' }]),
    };
    const db = { getAppSetting: jest.fn().mockResolvedValue(null), deletePromptsForIssue: jest.fn().mockResolvedValue(undefined) };
    registerDmHandler(app, jira, { db, oauthService: connectedAs(jira) });
    const blocks = buildYesNoBlocks({
      issueKey: 'SNS-1', question: 'Close SNS-1?', transitionTo: 'Done',
      fixVersion: { pick: { id: '40', name: '2026.4.0', released: false }, reason: 'r', alternative: null, basis: '' },
    }, 'U1');
    const body = (el) => ({ actions: [{ value: el.value }], channel: { id: 'D1' }, message: { ts: '9', text: 'Close SNS-1?', blocks }, trigger_id: 'T' });
    const applyKey = Object.keys(handlers).find((k) => k.startsWith('/^jira_fixversion_apply'));
    return { handlers, client, jira, blocks, body, applyKey };
  }

  test('sets the Fix Version, then closes, and updates the same message', async () => {
    const { handlers, client, jira, blocks, body, applyKey } = setup();
    await handlers[applyKey]({ ack: jest.fn(), body: body(blocks[1].elements[0]), client, logger });
    expect(jira.updateIssueField).toHaveBeenCalledWith('SNS-1', 'fixVersions', [{ id: '40' }], 'raw');
    expect(jira.transitionIssue).toHaveBeenCalledWith('SNS-1', 'Done');
    expect(jira.updateIssueField.mock.invocationCallOrder[0]).toBeLessThan(jira.transitionIssue.mock.invocationCallOrder[0]);
    const last = client.chat.update.mock.calls.at(-1)[0];
    expect(last).toMatchObject({ channel: 'D1', ts: '9' });
    expect(last.text).toMatch(/Fix Version set to \*2026\.4\.0\*.*moved to \*Done\*/);
  });

  test('"another version" opens the picker with the suggestion preselected and the message location kept', async () => {
    const { handlers, client, blocks, body } = setup();
    await handlers.jira_set_fixversion({ ack: jest.fn(), body: body(blocks[1].elements[1]), client, logger });
    const view = client.views.open.mock.calls[0][0].view;
    expect(view.blocks[1].element.initial_option.value).toBe('40');
    expect(JSON.parse(view.private_metadata)).toMatchObject({ dmChannelId: 'D1', messageTs: '9', transitionTo: 'Done' });
  });
});
