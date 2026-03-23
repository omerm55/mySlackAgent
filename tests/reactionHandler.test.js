'use strict';

const { registerReactionHandler } = require('../src/handlers/reactionHandler');
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
    event: jest.fn((name, fn) => { handlers[name] = fn; }),
    _trigger: (name, payload) => handlers[name](payload),
  };
}

function makeJira() {
  return { updateIssueField: jest.fn().mockResolvedValue({}) };
}

function makeClient(messageText) {
  return {
    conversations: {
      history: jest.fn().mockResolvedValue({
        messages: [{ text: messageText, ts: '111.000' }],
      }),
    },
    chat: { postMessage: jest.fn().mockResolvedValue({}) },
  };
}

const logger = { info: jest.fn(), error: jest.fn() };

describe('reactionHandler', () => {
  beforeEach(() => jest.clearAllMocks());

  test.each(['+1', 'thumbsup', 'thumbs_up'])(
    'updates Jira on "%s" reaction',
    async (emoji) => {
      const app = makeApp();
      const jira = makeJira();
      const client = makeClient(REAL_MESSAGE);
      registerReactionHandler(app, jira, config, new DedupCache());

      await app._trigger('reaction_added', {
        event: { reaction: emoji, user: 'U123', item: { type: 'message', channel: 'C_WATCH', ts: '111.000' } },
        client,
        logger,
      });

      expect(jira.updateIssueField).toHaveBeenCalledWith('SNS-122172', 'customfield_10000', 'In Review', 'select');
      expect(client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({
        channel: 'C_WATCH',
        thread_ts: '111.000',
        text: expect.stringMatching(/SNS-122172.+=.+In Review/),
      }));
    }
  );

  test('does not update Jira twice for the same reaction (deduplication)', async () => {
    const app = makeApp();
    const jira = makeJira();
    registerReactionHandler(app, jira, config, new DedupCache());

    const payload = {
      event: { reaction: '+1', user: 'U123', item: { type: 'message', channel: 'C_WATCH', ts: '111.000' } },
      client: makeClient(REAL_MESSAGE),
      logger,
    };

    await app._trigger('reaction_added', payload);
    await app._trigger('reaction_added', payload);

    expect(jira.updateIssueField).toHaveBeenCalledTimes(1);
  });

  test('does nothing for a non-thumbs-up reaction', async () => {
    const app = makeApp();
    const jira = makeJira();
    registerReactionHandler(app, jira, config, new DedupCache());

    await app._trigger('reaction_added', {
      event: { reaction: 'heart', user: 'U123', item: { type: 'message', channel: 'C_WATCH', ts: '111.000' } },
      client: makeClient(REAL_MESSAGE),
      logger,
    });

    expect(jira.updateIssueField).not.toHaveBeenCalled();
  });

  test('does nothing if the channel does not match', async () => {
    const app = makeApp();
    const jira = makeJira();
    registerReactionHandler(app, jira, config, new DedupCache());

    await app._trigger('reaction_added', {
      event: { reaction: '+1', user: 'U123', item: { type: 'message', channel: 'C_OTHER', ts: '111.000' } },
      client: makeClient(REAL_MESSAGE),
      logger,
    });

    expect(jira.updateIssueField).not.toHaveBeenCalled();
  });

  test('does nothing if the reacted item is not a message', async () => {
    const app = makeApp();
    const jira = makeJira();
    registerReactionHandler(app, jira, config, new DedupCache());

    await app._trigger('reaction_added', {
      event: { reaction: '+1', user: 'U123', item: { type: 'file', channel: 'C_WATCH', ts: '111.000' } },
      client: makeClient(REAL_MESSAGE),
      logger,
    });

    expect(jira.updateIssueField).not.toHaveBeenCalled();
  });

  test('does nothing if the message has no Jira key', async () => {
    const app = makeApp();
    const jira = makeJira();
    registerReactionHandler(app, jira, config, new DedupCache());

    await app._trigger('reaction_added', {
      event: { reaction: '+1', user: 'U123', item: { type: 'message', channel: 'C_WATCH', ts: '111.000' } },
      client: makeClient('Please take a look at this issue.'),
      logger,
    });

    expect(jira.updateIssueField).not.toHaveBeenCalled();
  });

  test('logs an error if the Jira update fails, without throwing', async () => {
    const app = makeApp();
    const jira = { updateIssueField: jest.fn().mockRejectedValue(new Error('Jira down')) };
    registerReactionHandler(app, jira, config, new DedupCache());

    await expect(
      app._trigger('reaction_added', {
        event: { reaction: '+1', user: 'U123', item: { type: 'message', channel: 'C_WATCH', ts: '111.000' } },
        client: makeClient(REAL_MESSAGE),
        logger,
      })
    ).resolves.not.toThrow();

    expect(logger.error).toHaveBeenCalled();
  });
});
