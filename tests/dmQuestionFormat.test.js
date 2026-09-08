'use strict';

const { renderTemplate } = require('../src/services/jiraPoller');
const { sendDmQuestion } = require('../src/utils/dmQuestion');

const issue = {
  key: 'SNS-128269',
  fields: { summary: 'Clean Slate | Deploy only relevant components', status: { name: 'Acceptance' }, reporter: { displayName: 'Omer' } },
};

describe('renderTemplate', () => {
  beforeEach(() => { process.env.JIRA_BASE_URL = 'https://x.atlassian.net'; });
  afterEach(() => { delete process.env.JIRA_BASE_URL; });

  test('{key} ({summary}) becomes a single link labelled "KEY (summary)"', () => {
    const out = renderTemplate('All children of {key} ({summary}) are done. Approve?', issue);
    expect(out).toBe('All children of <https://x.atlassian.net/browse/SNS-128269|SNS-128269 (Clean Slate | Deploy only relevant components)> are done. Approve?');
  });

  test('{link} is the same combined link; bare {key} links the key only', () => {
    expect(renderTemplate('{link}', issue)).toBe('<https://x.atlassian.net/browse/SNS-128269|SNS-128269 (Clean Slate | Deploy only relevant components)>');
    expect(renderTemplate('Approve {key}?', issue)).toBe('Approve <https://x.atlassian.net/browse/SNS-128269|SNS-128269>?');
  });

  test('other placeholders render as plain text', () => {
    expect(renderTemplate('{status} by {reporter} ({assignee})', issue)).toBe('Acceptance by Omer (unassigned)');
  });

  test('without JIRA_BASE_URL, falls back to plain text', () => {
    delete process.env.JIRA_BASE_URL;
    expect(renderTemplate('{key} ({summary})', issue)).toBe('SNS-128269 (Clean Slate | Deploy only relevant components)');
  });
});

describe('sendDmQuestion headline', () => {
  function makeClient() {
    return {
      conversations: { open: jest.fn().mockResolvedValue({ channel: { id: 'D1' } }) },
      chat: { postMessage: jest.fn().mockResolvedValue({ ts: '1.0' }) },
    };
  }
  const base = { issueKey: 'SNS-1', transitionTo: 'Done' };

  test('does not prefix the key when the question already names the issue', async () => {
    const client = makeClient();
    await sendDmQuestion(client, 'U1', { ...base, question: 'Move <https://x/browse/SNS-1|SNS-1 (Thing)> to Done?' }, null);
    const { text } = client.chat.postMessage.mock.calls[0][0];
    expect(text).toBe('Move <https://x/browse/SNS-1|SNS-1 (Thing)> to Done?');
  });

  test('prefixes the key when the question does not mention it', async () => {
    const client = makeClient();
    await sendDmQuestion(client, 'U1', { ...base, question: 'Approve and close?' }, null);
    const { text } = client.chat.postMessage.mock.calls[0][0];
    expect(text).toBe('*SNS-1*: Approve and close?');
  });

  test('button context carries transitionTo instead of field info', async () => {
    const client = makeClient();
    await sendDmQuestion(client, 'U1', { ...base, question: 'Approve SNS-1?' }, null);
    const { blocks } = client.chat.postMessage.mock.calls[0][0];
    const ctx = JSON.parse(blocks[1].elements[0].value);
    expect(ctx).toMatchObject({ issueKey: 'SNS-1', transitionTo: 'Done', slackUserId: 'U1' });
    expect(ctx.jiraFieldId).toBeUndefined();
  });
});
