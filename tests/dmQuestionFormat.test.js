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

  // The summary's "|" must not split the Slack link — it is swapped for a look-alike (∣).
  const LABEL = 'SNS-128269 (Clean Slate ∣ Deploy only relevant components)';

  test('{key} ({summary}) becomes a single link labelled "KEY (summary)" with a link-safe pipe', () => {
    const out = renderTemplate('All children of {key} ({summary}) are done. Approve?', issue);
    expect(out).toBe(`All children of <https://x.atlassian.net/browse/SNS-128269|${LABEL}> are done. Approve?`);
    // exactly one "|" in the whole link → Slack keeps the full label
    expect(out.match(/\|/g)).toHaveLength(1);
  });

  test.each([
    ['{key}: {summary}', 'SNS-128269: Clean Slate ∣ Deploy only relevant components'],
    ['{key} - {summary}', 'SNS-128269 - Clean Slate ∣ Deploy only relevant components'],
    ['{key} — {summary}', 'SNS-128269 — Clean Slate ∣ Deploy only relevant components'],
    ['{key} {summary}', 'SNS-128269 Clean Slate ∣ Deploy only relevant components'],
  ])('other key+summary glues (%s) also become one link', (tpl, label) => {
    expect(renderTemplate(tpl, issue)).toBe(`<https://x.atlassian.net/browse/SNS-128269|${label}>`);
  });

  test('{link} is the combined link; bare {key} links the key only', () => {
    expect(renderTemplate('{link}', issue)).toBe(`<https://x.atlassian.net/browse/SNS-128269|${LABEL}>`);
    expect(renderTemplate('Approve {key}?', issue)).toBe('Approve <https://x.atlassian.net/browse/SNS-128269|SNS-128269>?');
  });

  test('summary with <, > and & is escaped inside the link label', () => {
    const weird = { key: 'SNS-1', fields: { summary: 'a <b> & c' } };
    expect(renderTemplate('{link}', weird)).toBe('<https://x.atlassian.net/browse/SNS-1|SNS-1 (a &lt;b&gt; &amp; c)>');
  });

  test('other placeholders render as plain text', () => {
    expect(renderTemplate('{status} by {reporter} ({assignee})', issue)).toBe('Acceptance by Omer (unassigned)');
  });

  test('without JIRA_BASE_URL, falls back to plain text (pipe still swapped for consistency)', () => {
    delete process.env.JIRA_BASE_URL;
    expect(renderTemplate('{key} ({summary})', issue)).toBe('SNS-128269 (Clean Slate ∣ Deploy only relevant components)');
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
