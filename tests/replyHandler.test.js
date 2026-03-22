'use strict';

const { registerReplyHandler } = require('../src/handlers/replyHandler');

const config = {
  watchChannelId: 'C_WATCH',
  jiraFieldId: 'customfield_10000',
  jiraFieldValue: 'In Review',
  jiraFieldType: 'select',
};

// Minimal mock of Slack Bolt App
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
  };
}

const logger = { info: jest.fn(), error: jest.fn() };

describe('replyHandler', () => {
  test('updates Jira when a reply is posted and root message has a Jira link', async () => {
    const app = makeApp();
    const jira = makeJira();
    registerReplyHandler(app, jira, config);

    await app._trigger({
      message: {
        channel: 'C_WATCH',
        ts: '222.000',
        thread_ts: '111.000',
        text: 'Looks good!',
      },
      client: makeClient('Please review https://myco.atlassian.net/browse/PROJ-99'),
      logger,
    });

    expect(jira.updateIssueField).toHaveBeenCalledWith(
      'PROJ-99', 'customfield_10000', 'In Review', 'select'
    );
  });

  test('does nothing if the message is not a thread reply', async () => {
    const app = makeApp();
    const jira = makeJira();
    registerReplyHandler(app, jira, config);

    await app._trigger({
      message: { channel: 'C_WATCH', ts: '111.000', thread_ts: '111.000' }, // root message
      client: makeClient('https://myco.atlassian.net/browse/PROJ-1'),
      logger,
    });

    expect(jira.updateIssueField).not.toHaveBeenCalled();
  });

  test('does nothing if the channel does not match', async () => {
    const app = makeApp();
    const jira = makeJira();
    registerReplyHandler(app, jira, config);

    await app._trigger({
      message: { channel: 'C_OTHER', ts: '222.000', thread_ts: '111.000' },
      client: makeClient('https://myco.atlassian.net/browse/PROJ-1'),
      logger,
    });

    expect(jira.updateIssueField).not.toHaveBeenCalled();
  });

  test('does nothing if the root message has no Jira link', async () => {
    const app = makeApp();
    const jira = makeJira();
    registerReplyHandler(app, jira, config);

    await app._trigger({
      message: { channel: 'C_WATCH', ts: '222.000', thread_ts: '111.000' },
      client: makeClient('No links here'),
      logger,
    });

    expect(jira.updateIssueField).not.toHaveBeenCalled();
  });

  test('logs an error if the Jira update fails, without throwing', async () => {
    const app = makeApp();
    const jira = { updateIssueField: jest.fn().mockRejectedValue(new Error('Jira down')) };
    registerReplyHandler(app, jira, config);

    await expect(
      app._trigger({
        message: { channel: 'C_WATCH', ts: '222.000', thread_ts: '111.000' },
        client: makeClient('https://myco.atlassian.net/browse/PROJ-1'),
        logger,
      })
    ).resolves.not.toThrow();

    expect(logger.error).toHaveBeenCalled();
  });
});
