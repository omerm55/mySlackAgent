'use strict';

// A free-text reply is interpreted and then PREVIEWED. Nothing is written until the person confirms:
// Confirm applies it, Edit reply reopens the modal with their text, Cancel restores the original ask.
const { registerDmHandler } = require('../src/handlers/dmHandler');
const { buildYesNoBlocks, describeDecision } = require('../src/utils/dmQuestion');

const actionIds = (blocks) => (blocks || []).filter((b) => b.type === 'actions').flatMap((b) => b.elements.map((e) => e.action_id));
const CTX = { issueKey: 'SNS-1', question: 'All children done. Approve?', transitionTo: 'Done', slackUserId: 'U1' };

function setup({ decision = { action: 'transition', transitionTo: 'Needs Review', comment: 'waiting on QA', confirmationMessage: 'Moved to Needs Review.' }, llmError = null } = {}) {
  const handlers = {};
  const app = { action: (id, fn) => { handlers[String(id)] = fn; }, view: (id, fn) => { handlers[String(id)] = fn; } };
  const updates = [];
  const client = {
    chat: { update: jest.fn(async (p) => { updates.push(p); return {}; }), postMessage: jest.fn().mockResolvedValue({}) },
    views: { open: jest.fn().mockResolvedValue({}) },
    conversations: { open: jest.fn().mockResolvedValue({ channel: { id: 'D1' } }) },
  };
  const jira = {
    transitionIssue: jest.fn().mockResolvedValue(undefined), updateIssueField: jest.fn().mockResolvedValue(undefined),
    addComment: jest.fn().mockResolvedValue(undefined), assignIssue: jest.fn().mockResolvedValue(undefined),
    findUser: jest.fn().mockResolvedValue('acc-1'),
  };
  const llmService = { interpretJiraResponse: llmError ? jest.fn().mockRejectedValue(new Error(llmError)) : jest.fn().mockResolvedValue(decision) };
  const ops = { dmLlmProposed: jest.fn(), dmLlmDecision: jest.fn(), post: jest.fn(), dmButtonClicked: jest.fn() };
  const db = { deletePromptsForIssue: jest.fn(), markPromptAnswered: jest.fn() };
  registerDmHandler(app, jira, { db, llmService, oauthService: null, opsNotifier: ops, userCache: { getName: jest.fn() } });
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const meta = JSON.stringify({ ...CTX, dmChannelId: 'D1', messageTs: '1', originalText: 'orig' });
  const submit = (text) => ({ ack: jest.fn(), body: {}, view: { private_metadata: meta, state: { values: { response_block: { response_input: { value: text } } } } }, client, logger });
  return { handlers, client, jira, llmService, ops, db, updates, logger, submit };
}
const lastPreviewValue = (updates) => JSON.parse(updates[updates.length - 1].blocks.find((b) => b.type === 'actions').elements[0].value);

describe('reply → preview', () => {
  test('modal submit shows what will happen, writes nothing, tells ops it is only proposed', async () => {
    const { handlers, jira, ops, updates, submit } = setup();
    await handlers.jira_response_modal(submit('not yet, waiting on QA — move it to Needs Review'));
    expect(jira.transitionIssue).not.toHaveBeenCalled();
    expect(jira.addComment).not.toHaveBeenCalled();
    const last = updates[updates.length - 1];
    expect(JSON.stringify(last.blocks)).toMatch(/nothing is changed yet/);
    expect(JSON.stringify(last.blocks)).toMatch(/Needs Review/);
    expect(JSON.stringify(last.blocks)).toMatch(/waiting on QA/);
    expect(actionIds(last.blocks)).toEqual(['jira_reply_confirm', 'jira_reply_edit', 'jira_reply_cancel']);
    expect(ops.dmLlmProposed).toHaveBeenCalledWith(expect.objectContaining({ issueKey: 'SNS-1' }));
    expect(ops.dmLlmDecision).not.toHaveBeenCalled();
    expect(updates[0].text).toMatch(/Thinking/);
  });

  test('Confirm applies transition + comment + assignee and reports the decision to ops', async () => {
    const { handlers, client, jira, ops, updates, logger, submit } = setup({ decision: { action: 'transition', transitionTo: 'Needs Review', comment: 'waiting on QA', assignee: 'Gaby', confirmationMessage: 'Moved to Needs Review.' } });
    await handlers.jira_response_modal(submit('move to Needs Review, assign Gaby'));
    const value = updates[updates.length - 1].blocks.find((b) => b.type === 'actions').elements[0].value;
    await handlers.jira_reply_confirm({ ack: jest.fn(), body: { actions: [{ value }], channel: { id: 'D1' }, message: { ts: '1', text: 'x' } }, client, logger });
    expect(jira.transitionIssue).toHaveBeenCalledWith('SNS-1', 'Needs Review');
    expect(jira.addComment).toHaveBeenCalledWith('SNS-1', 'waiting on QA');
    expect(jira.assignIssue).toHaveBeenCalledWith('SNS-1', 'acc-1');
    expect(updates[updates.length - 1].text).toMatch(/✅ Moved to Needs Review/);
    expect(ops.dmLlmDecision).toHaveBeenCalledWith(expect.objectContaining({ issueKey: 'SNS-1', decision: expect.objectContaining({ transitionTo: 'Needs Review' }) }));
  });

  test('Cancel writes nothing and puts the original Yes/No/Reply ask back', async () => {
    const { handlers, client, jira, ops, updates, logger, submit } = setup();
    await handlers.jira_response_modal(submit('hmm, actually no'));
    const value = updates[updates.length - 1].blocks.find((b) => b.type === 'actions').elements[2].value;
    await handlers.jira_reply_cancel({ ack: jest.fn(), body: { actions: [{ value }], channel: { id: 'D1' }, message: { ts: '1', text: 'x' } }, client, logger });
    expect(jira.transitionIssue).not.toHaveBeenCalled();
    expect(actionIds(updates[updates.length - 1].blocks)).toEqual(['jira_confirm_yes', 'jira_confirm_no', 'jira_reply']);
    expect(ops.post).toHaveBeenCalledWith(expect.stringMatching(/cancelled the proposed change/));
  });

  test('Edit reply reopens the modal prefilled with what they wrote; nothing written', async () => {
    const { handlers, client, jira, updates, logger, submit } = setup();
    await handlers.jira_response_modal(submit('waiting on QA'));
    const value = updates[updates.length - 1].blocks.find((b) => b.type === 'actions').elements[1].value;
    await handlers.jira_reply_edit({ ack: jest.fn(), body: { actions: [{ value }], channel: { id: 'D1' }, message: { ts: '1', text: 'x' }, trigger_id: 'T' }, client, logger });
    const view = client.views.open.mock.calls[0][0].view;
    expect(view.callback_id).toBe('jira_response_modal');
    expect(view.blocks[1].element.initial_value).toBe('waiting on QA');
    expect(jira.transitionIssue).not.toHaveBeenCalled();
  });

  test('no_action needs no confirmation: message finalised, nothing written', async () => {
    const { handlers, jira, ops, updates, submit } = setup({ decision: { action: 'no_action', confirmationMessage: 'OK, leaving it as it is.' } });
    await handlers.jira_response_modal(submit('not now'));
    expect(jira.transitionIssue).not.toHaveBeenCalled();
    expect(updates[updates.length - 1].text).toBe('OK, leaving it as it is.');
    expect(actionIds(updates[updates.length - 1].blocks)).toEqual([]);
    expect(ops.dmLlmDecision).toHaveBeenCalled();
    expect(ops.dmLlmProposed).not.toHaveBeenCalled();
  });

  test('LLM failure leaves the Yes/No/Reply buttons so the ask is still actionable', async () => {
    const { handlers, jira, updates, submit } = setup({ llmError: 'upstream 500' });
    await handlers.jira_response_modal(submit('anything'));
    expect(jira.transitionIssue).not.toHaveBeenCalled();
    const last = updates[updates.length - 1];
    expect(last.text).toMatch(/AI failed to interpret/);
    expect(actionIds(last.blocks)).toEqual(['jira_confirm_yes', 'jira_confirm_no', 'jira_reply']);
  });

  test('preview button value stays well under Slack\'s 2000-char cap even with long text', async () => {
    const { handlers, updates, submit } = setup({ decision: { action: 'update_field', fieldValue: 'Yes', comment: 'x'.repeat(2000), confirmationMessage: 'y'.repeat(500) } });
    await handlers.jira_response_modal(submit('z'.repeat(3000)));
    const el = updates[updates.length - 1].blocks.find((b) => b.type === 'actions').elements[0];
    expect(el.value.length).toBeLessThan(2000);
    expect(JSON.parse(el.value).decision.comment).toHaveLength(300);
  });
});

describe('describeDecision', () => {
  test('renders each kind of change and nothing for no_action', () => {
    expect(describeDecision({ action: 'transition', transitionTo: 'Done' }, CTX)[0]).toMatch(/Move .*SNS-1.*to \*Done\*/);
    expect(describeDecision({ action: 'update_field', fieldValue: 'Yes' }, { issueKey: 'SNS-1', jiraFieldId: 'customfield_1', jiraFieldName: 'PM reviewed' })[0]).toMatch(/Set \*PM reviewed\* = \*Yes\*/);
    expect(describeDecision({ action: 'update_field' }, CTX)[0]).toMatch(/Move .*to \*Done\*/); // transition ask, LLM said update_field
    expect(describeDecision({ action: 'no_action' }, CTX)).toEqual([]);
    expect(describeDecision({ action: 'no_action', comment: 'c', assignee: 'Gaby' }, CTX)).toHaveLength(2);
  });
});
