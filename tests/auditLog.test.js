'use strict';

const AuditLog = require('../src/utils/auditLog');

function makeClient() {
  return { chat: { postMessage: jest.fn().mockResolvedValue({}) } };
}

const CHANNEL = 'C_OPS';

describe('AuditLog', () => {
  test('postDailySummary posts a message and clears the log', async () => {
    const log = new AuditLog();
    log.addEntry({ ts: Date.now(), integrationName: 'my-workflow', trigger: '👍 reaction',
      slackUserId: 'U1', slackUserName: 'Alice', issueKey: 'PROJ-1',
      fieldName: 'Status', fieldValue: 'Done', success: true });

    const client = makeClient();
    await log.postDailySummary(client, CHANNEL);

    expect(client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      channel: CHANNEL,
      text: expect.stringContaining('PROJ-1'),
    }));
    expect(log.entries).toHaveLength(0); // cleared after posting
  });

  test('posts a "no activity" message when there are no entries', async () => {
    const log = new AuditLog();
    const client = makeClient();
    await log.postDailySummary(client, CHANNEL);

    expect(client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('No updates'),
    }));
  });

  test('marks failed entries with ❌ and successful ones with ✅', async () => {
    const log = new AuditLog();
    const base = { ts: Date.now(), integrationName: 'wf', trigger: 'thread reply',
      slackUserId: 'U1', slackUserName: 'Bob', issueKey: 'PROJ-2',
      fieldName: 'F', fieldValue: 'V' };

    log.addEntry({ ...base, success: true });
    log.addEntry({ ...base, issueKey: 'PROJ-3', success: false, error: 'HTTP 404' });

    const client = makeClient();
    await log.postDailySummary(client, CHANNEL);

    const { text } = client.chat.postMessage.mock.calls[0][0];
    expect(text).toContain('✅');
    expect(text).toContain('❌');
    expect(text).toContain('HTTP 404');
  });

  test('groups entries by integration name', async () => {
    const log = new AuditLog();
    const entry = (name, key) => ({
      ts: Date.now(), integrationName: name, trigger: '👍 reaction',
      slackUserId: 'U1', slackUserName: 'Carol', issueKey: key,
      fieldName: 'F', fieldValue: 'V', success: true,
    });
    log.addEntry(entry('workflow-a', 'A-1'));
    log.addEntry(entry('workflow-b', 'B-1'));
    log.addEntry(entry('workflow-a', 'A-2'));

    const client = makeClient();
    await log.postDailySummary(client, CHANNEL);

    const { text } = client.chat.postMessage.mock.calls[0][0];
    expect(text.indexOf('workflow-a')).toBeLessThan(text.indexOf('workflow-b'));
    expect(text).toContain('A-1');
    expect(text).toContain('A-2');
    expect(text).toContain('B-1');
  });
});
