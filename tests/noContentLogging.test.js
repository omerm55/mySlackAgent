'use strict';

// Render logs must never carry what people typed (or what the LLM extracted from it). The ops
// channel is the audit trail for that; pino logs get issue keys, actions and lengths only.
const { registerDmHandler } = require('../src/handlers/dmHandler');

const SENTINEL = 'ZEBRA-QUOKKA-7731';
const NAME = 'customfield_11822'; const VALUE = 'customfield_15249';

function setup() {
  const handlers = {};
  const app = { action: (id, fn) => { handlers[String(id)] = fn; }, view: (id, fn) => { handlers[String(id)] = fn; } };
  const client = {
    chat: { update: jest.fn().mockResolvedValue({}), postMessage: jest.fn().mockResolvedValue({}) },
    views: { open: jest.fn().mockResolvedValue({}) },
    conversations: { open: jest.fn().mockResolvedValue({ channel: { id: 'D1' } }) },
  };
  const jira = { updateIssueField: jest.fn().mockResolvedValue(undefined), transitionIssue: jest.fn().mockResolvedValue(undefined), addComment: jest.fn(), updateIssueFields: jest.fn() };
  const llm = {
    interpretJiraResponse: jest.fn().mockResolvedValue({ action: 'update_field', fieldValue: 'Yes', confirmationMessage: 'done' }),
    extractFields: jest.fn().mockResolvedValue({ values: { [NAME]: `Name ${SENTINEL}`, [VALUE]: `Value ${SENTINEL}` } }),
  };
  const ops = { dmLlmDecision: jest.fn(), dmLlmProposed: jest.fn(), collectAction: jest.fn(), dmButtonClicked: jest.fn() };
  const db = { markPromptAnswered: jest.fn(), deletePromptsForIssue: jest.fn() };
  registerDmHandler(app, jira, { db, llmService: llm, oauthService: null, opsNotifier: ops, userCache: { getName: jest.fn() } });
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const logged = () => [...logger.info.mock.calls, ...logger.warn.mock.calls, ...logger.error.mock.calls].map((c) => JSON.stringify(c)).join('\n');
  return { handlers, client, logger, logged, ops };
}

test('free-text reply: sentinel reaches the ops channel, never the logs', async () => {
  const { handlers, client, logger, logged, ops } = setup();
  const meta = JSON.stringify({ issueKey: 'SNS-1', question: 'q', jiraFieldId: 'customfield_1', jiraFieldName: 'F', jiraFieldValue: 'Yes', jiraFieldType: 'select', slackUserId: 'U1', dmChannelId: 'D1', messageTs: '1', originalText: 'orig' });
  await handlers.jira_response_modal({ ack: jest.fn(), body: {}, view: { private_metadata: meta, state: { values: { response_block: { response_input: { value: `yes please ${SENTINEL}` } } } } }, client, logger });
  expect(logger.info).toHaveBeenCalled();
  expect(logged()).not.toContain(SENTINEL);
  // The reply is previewed (not executed), so the ops line is the "proposed" one
  expect(JSON.stringify(ops.dmLlmProposed.mock.calls)).toContain(SENTINEL);
});

test('collect modal: extracted values are never logged', async () => {
  const { handlers, client, logger, logged } = setup();
  const meta = JSON.stringify({ askType: 'collect', issueKey: 'PR-1', slackUserId: 'U1', dmChannelId: 'D1', messageTs: '1', originalText: 'orig',
    collect: { summary: 'S', fields: [{ id: NAME, name: 'Name', required: true, current: '' }, { id: VALUE, name: 'Value', required: true, current: '' }] } });
  await handlers.collect_modal({ ack: jest.fn(), body: {}, view: { private_metadata: meta, state: { values: { free_text: { value: { value: `call it ${SENTINEL}` } } } } }, client, logger });
  expect(logger.info).toHaveBeenCalled();
  expect(logged()).not.toContain(SENTINEL);
});
