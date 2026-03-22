'use strict';

const { registerReactionHandler } = require('../src/handlers/reactionHandler');

const config = {
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
  };
}

const logger = { info: jest.fn(), error: jest.fn() };

describe('reactionHandler', () => {
  test.each(['+1', 'thumbsup', 'thumbs_up'])(
    'updates Jira on "%s" reaction when message has a Jira link',
    async (emoji) => {
      const app = makeApp();
      const jira = makeJira();
      registerReactionHandler(app, jira, config);

      await app._trigger('reaction_added', {
        event: { reaction: emoji, user: 'U123', item: { type: 'message', channel: 'C_WATCH', ts: '111.000' } },
        client: makeClient('Fix tracked at https://myco.atlassian.net/browse/PROJ-55'),
        logger,
      });

      expect(jira.updateIssueField).toHaveBeenCalledWith(
        'PROJ-55', 'customfield_10000', 'In Review', 'select'
      );
    }
  );

  test('does nothing for a non-thumbs-up reaction', async () => {
    const app = makeApp();
    const jira = makeJira();
    registerReactionHandler(app, jira, config);

    await app._trigger('reaction_added', {
      event: { reaction: 'heart', user: 'U123', item: { type: 'message', channel: 'C_WATCH', ts: '111.000' } },
      client: makeClient('https://myco.atlassian.net/browse/PROJ-1'),
      logger,
    });

    expect(jira.updateIssueField).not.toHaveBeenCalled();
  });

  test('does nothing if the channel does not match', async () => {
    const app = makeApp();
    const jira = makeJira();
    registerReactionHandler(app, jira, config);

    await app._trigger('reaction_added', {
      event: { reaction: '+1', user: 'U123', item: { type: 'message', channel: 'C_OTHER', ts: '111.000' } },
      client: makeClient('https://myco.atlassian.net/browse/PROJ-1'),
      logger,
    });

    expect(jira.updateIssueField).not.toHaveBeenCalled();
  });

  test('does nothing if the reacted item is not a message', async () => {
    const app = makeApp();
    const jira = makeJira();
    registerReactionHandler(app, jira, config);

    await app._trigger('reaction_added', {
      event: { reaction: '+1', user: 'U123', item: { type: 'file', channel: 'C_WATCH', ts: '111.000' } },
      client: makeClient('https://myco.atlassian.net/browse/PROJ-1'),
      logger,
    });

    expect(jira.updateIssueField).not.toHaveBeenCalled();
  });

  test('does nothing if the message has no Jira link', async () => {
    const app = makeApp();
    const jira = makeJira();
    registerReactionHandler(app, jira, config);

    await app._trigger('reaction_added', {
      event: { reaction: '+1', user: 'U123', item: { type: 'message', channel: 'C_WATCH', ts: '111.000' } },
      client: makeClient('Just a normal message'),
      logger,
    });

    expect(jira.updateIssueField).not.toHaveBeenCalled();
  });

  test('logs an error if the Jira update fails, without throwing', async () => {
    const app = makeApp();
    const jira = { updateIssueField: jest.fn().mockRejectedValue(new Error('Jira down')) };
    registerReactionHandler(app, jira, config);

    await expect(
      app._trigger('reaction_added', {
        event: { reaction: '+1', user: 'U123', item: { type: 'message', channel: 'C_WATCH', ts: '111.000' } },
        client: makeClient('https://myco.atlassian.net/browse/PROJ-1'),
        logger,
      })
    ).resolves.not.toThrow();

    expect(logger.error).toHaveBeenCalled();
  });
});
