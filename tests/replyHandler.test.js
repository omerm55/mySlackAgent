'use strict';

const { registerReplyHandler } = require('../src/handlers/replyHandler');
const DedupCache = require('../src/utils/dedupCache');

const REAL_MESSAGE =
  "Bug SNS-122172 / Customer Hosted Multi-Node POC License Expiration Not Working  was marked as Include Release Notes = No." +
  "The bug is assigned to ** from team 'Cockpit'." +
  "@Adva Almog-Dadush - please take a look and make sure this bug does not require public documentation.";

const config = {
  name: 'doc-review-workflow',
  watchChannelId: 'C_WATCH',
  jiraFieldId: 'customfield_10000',
  jiraFieldValue: 'In Review',
  jiraFieldType: 'select',
};

function makeApp() {
  const handlers = {};
  return {
    message: jest.fn((fn) => { handlers.message = fn; }),
    _trigger: (event) => handlers.message(event),
  };
}

function makeJira() {
  return { updateIssueField: jest.fn().mockResolvedValue({}) };
}

function makeClient(rootMessageText) {
  return {
    conversations: {
      replies: jest.fn().mockResolvedValue({
        messages: [{ text: rootMessageText, ts: '111.000' }],
      }),
    },
    chat: { postMessage: jest.fn().mockResolvedValue({}) },
  };
}

const logger = { info: jest.fn(), error: jest.fn() };

describe('replyHandler', () => {
  beforeEach(() => jest.clearAllMocks());

  test('updates Jira when a reply is posted and root message contains an issue key', async () => {
    const app = makeApp();
    const jira = makeJira();
    const client = makeClient(REAL_MESSAGE);
    registerReplyHandler(app, jira, config, new DedupCache());

    await app._trigger({
      message: { channel: 'C_WATCH', ts: '222.000', thread_ts: '111.000', user: 'U123', text: 'Looks good!' },
      client,
      logger,
    });

    expect(jira.updateIssueField).toHaveBeenCalledWith('SNS-122172', 'customfield_10000', 'In Review', 'select');
    expect(client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'C_WATCH',
      thread_ts: '111.000',
      text: expect.stringContaining('SNS-122172'),
    }));
  });

  test('does not update Jira twice for the same event (deduplication)', async () => {
    const app = makeApp();
    const jira = makeJira();
    registerReplyHandler(app, jira, config, new DedupCache());

    const event = {
      message: { channel: 'C_WATCH', ts: '222.000', thread_ts: '111.000', user: 'U123', text: 'Looks good!' },
      client: makeClient(REAL_MESSAGE),
      logger,
    };

    await app._trigger(event);
    await app._trigger(event);

    expect(jira.updateIssueField).toHaveBeenCalledTimes(1);
  });

  test('does nothing if the message is not a thread reply', async () => {
    const app = makeApp();
    const jira = makeJira();
    registerReplyHandler(app, jira, config, new DedupCache());

    await app._trigger({
      message: { channel: 'C_WATCH', ts: '111.000', thread_ts: '111.000', user: 'U123' },
      client: makeClient(REAL_MESSAGE),
      logger,
    });

    expect(jira.updateIssueField).not.toHaveBeenCalled();
  });

  test('does nothing if the channel does not match', async () => {
    const app = makeApp();
    const jira = makeJira();
    registerReplyHandler(app, jira, config, new DedupCache());

    await app._trigger({
      message: { channel: 'C_OTHER', ts: '222.000', thread_ts: '111.000', user: 'U123' },
      client: makeClient(REAL_MESSAGE),
      logger,
    });

    expect(jira.updateIssueField).not.toHaveBeenCalled();
  });

  test('does nothing if the root message has no Jira key', async () => {
    const app = makeApp();
    const jira = makeJira();
    registerReplyHandler(app, jira, config, new DedupCache());

    await app._trigger({
      message: { channel: 'C_WATCH', ts: '222.000', thread_ts: '111.000', user: 'U123' },
      client: makeClient('Please take a look at this issue.'),
      logger,
    });

    expect(jira.updateIssueField).not.toHaveBeenCalled();
  });

  test('logs an error if the Jira update fails, without throwing', async () => {
    const app = makeApp();
    const jira = { updateIssueField: jest.fn().mockRejectedValue(new Error('Jira down')) };
    registerReplyHandler(app, jira, config, new DedupCache());

    await expect(
      app._trigger({
        message: { channel: 'C_WATCH', ts: '222.000', thread_ts: '111.000', user: 'U123' },
        client: makeClient(REAL_MESSAGE),
        logger,
      })
    ).resolves.not.toThrow();

    expect(logger.error).toHaveBeenCalled();
  });
});
