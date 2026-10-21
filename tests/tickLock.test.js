'use strict';

// One evaluator across instances: on Kubernetes a rolling deploy briefly runs two pods, and the poller
// and digest must not both ask the same people. DbService.withTickLock holds a session advisory lock on
// one dedicated connection; the poller and digest scheduler skip a tick when another instance holds it.
const DbService = require('../src/services/dbService');
const JiraPoller = require('../src/services/jiraPoller');
const { DigestScheduler } = require('../src/services/digestScheduler');

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

function fakePool(locked) {
  const client = {
    query: jest.fn(async (sql) => (sql.includes('pg_try_advisory_lock') ? { rows: [{ locked }] } : { rows: [] })),
    release: jest.fn(),
  };
  return { client, pool: { query: jest.fn(), connect: jest.fn(async () => client), on: jest.fn() } };
}

describe('DbService.withTickLock', () => {
  test('lock acquired → runs, unlocks and releases the same connection', async () => {
    const { pool, client } = fakePool(true);
    const db = new DbService({ pool });
    expect(await db.withTickLock('slack-jira-bot:poller', async () => 42)).toEqual({ ran: true, result: 42 });
    expect(client.query).toHaveBeenCalledWith('select pg_try_advisory_lock(hashtext($1)) as locked', ['slack-jira-bot:poller']);
    expect(client.query).toHaveBeenCalledWith('select pg_advisory_unlock(hashtext($1))', ['slack-jira-bot:poller']);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  test('lock held elsewhere → does not run, never unlocks someone else\'s lock, still releases', async () => {
    const { pool, client } = fakePool(false);
    const fn = jest.fn();
    expect(await new DbService({ pool }).withTickLock('x', fn)).toEqual({ ran: false });
    expect(fn).not.toHaveBeenCalled();
    expect(client.query).not.toHaveBeenCalledWith(expect.stringContaining('unlock'), expect.anything());
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  test('the work throws → unlocked and released anyway, error surfaces', async () => {
    const { pool, client } = fakePool(true);
    await expect(new DbService({ pool }).withTickLock('x', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(client.query).toHaveBeenCalledWith('select pg_advisory_unlock(hashtext($1))', ['x']);
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});

describe('ticks skip when another instance holds the lock', () => {
  const heldElsewhere = { withTickLock: jest.fn(async () => ({ ran: false })) };

  test('poller: nothing loaded, nothing evaluated, and the next tick may run', async () => {
    const db = { ...heldElsewhere, getActiveJiraTriggers: jest.fn(), getAppSetting: jest.fn().mockResolvedValue(null) };
    const poller = new JiraPoller({ jiraService: {}, db, slackClient: {}, logger });
    expect(await poller.runOnce()).toEqual([]);
    expect(db.withTickLock).toHaveBeenCalledWith('slack-jira-bot:poller', expect.any(Function));
    expect(db.getActiveJiraTriggers).not.toHaveBeenCalled();
    expect(poller._running).toBe(false);
  });

  test('digest: nothing delivered', async () => {
    const db = { ...heldElsewhere, getDigestUsers: jest.fn() };
    const scheduler = new DigestScheduler({ db, slackClient: {}, logger });
    expect(await scheduler.runOnce()).toEqual([]);
    expect(db.withTickLock).toHaveBeenCalledWith('slack-jira-bot:digest', expect.any(Function));
    expect(db.getDigestUsers).not.toHaveBeenCalled();
  });
});
