'use strict';

const {
  DigestScheduler, localParts, zonedTimeToUtc, currentSlotStart, isDigestDue,
} = require('../src/services/digestScheduler');

const TZ = 'Asia/Jerusalem'; // UTC+3 in September (IDT)

describe('time-zone helpers', () => {
  test('localParts converts a UTC instant to wall-clock in the zone', () => {
    expect(localParts(new Date('2026-09-08T06:30:00Z'), TZ)).toEqual({ y: 2026, m: 9, d: 8, hour: 9, minute: 30 });
    expect(localParts(new Date('2026-09-08T22:30:00Z'), TZ)).toEqual({ y: 2026, m: 9, d: 9, hour: 1, minute: 30 });
  });

  test('zonedTimeToUtc is the inverse: 09:00 Jerusalem = 06:00Z in September', () => {
    expect(zonedTimeToUtc(2026, 9, 8, 9, TZ).toISOString()).toBe('2026-09-08T06:00:00.000Z');
    expect(zonedTimeToUtc(2026, 1, 8, 9, TZ).toISOString()).toBe('2026-01-08T07:00:00.000Z'); // IST (UTC+2) in winter
  });
});

describe('currentSlotStart', () => {
  test('hourly → top of the current hour (zone-independent)', () => {
    expect(currentSlotStart(new Date('2026-09-08T10:47:12Z'), 'hourly', TZ).toISOString()).toBe('2026-09-08T10:00:00.000Z');
  });

  test('daily → today 09:00 local once passed, else yesterday 09:00', () => {
    // 10:30 local (07:30Z) → today's 09:00 local
    expect(currentSlotStart(new Date('2026-09-08T07:30:00Z'), 'daily', TZ).toISOString()).toBe('2026-09-08T06:00:00.000Z');
    // 08:30 local (05:30Z) → yesterday's 09:00 local
    expect(currentSlotStart(new Date('2026-09-08T05:30:00Z'), 'daily', TZ).toISOString()).toBe('2026-09-07T06:00:00.000Z');
  });

  test('twice_daily → latest of 09:00 / 15:00 local not in the future', () => {
    expect(currentSlotStart(new Date('2026-09-08T09:00:00Z'), 'twice_daily', TZ).toISOString()).toBe('2026-09-08T06:00:00.000Z'); // 12:00 local → 09:00 slot
    expect(currentSlotStart(new Date('2026-09-08T13:00:00Z'), 'twice_daily', TZ).toISOString()).toBe('2026-09-08T12:00:00.000Z'); // 16:00 local → 15:00 slot
    expect(currentSlotStart(new Date('2026-09-08T04:00:00Z'), 'twice_daily', TZ).toISOString()).toBe('2026-09-07T12:00:00.000Z'); // 07:00 local → yesterday 15:00
  });

  test('immediate / unknown → null; bad tz falls back to UTC instead of throwing', () => {
    expect(currentSlotStart(new Date(), 'immediate', TZ)).toBeNull();
    expect(currentSlotStart(new Date(), 'weekly', TZ)).toBeNull();
    expect(currentSlotStart(new Date('2026-09-08T10:00:00Z'), 'daily', 'Not/AZone').toISOString()).toBe('2026-09-08T09:00:00.000Z');
  });
});

describe('isDigestDue', () => {
  const now = new Date('2026-09-08T07:30:00Z'); // 10:30 Jerusalem
  test('never sent → due; sent before this slot → due; sent after this slot started → not due', () => {
    expect(isDigestDue({ digest_frequency: 'daily', tz: TZ, last_digest_at: null }, now)).toBe(true);
    expect(isDigestDue({ digest_frequency: 'daily', tz: TZ, last_digest_at: '2026-09-07T06:05:00Z' }, now)).toBe(true);
    expect(isDigestDue({ digest_frequency: 'daily', tz: TZ, last_digest_at: '2026-09-08T06:05:00Z' }, now)).toBe(false);
  });
  test('immediate is never "due"', () => {
    expect(isDigestDue({ digest_frequency: 'immediate', tz: TZ, last_digest_at: null }, now)).toBe(false);
  });
});

describe('DigestScheduler', () => {
  function setup({ users = [], pending = {} } = {}) {
    const db = {
      getDigestUsers: jest.fn().mockResolvedValue(users),
      getPendingPrompts: jest.fn(async (uid) => pending[uid] || []),
      markPromptsDelivered: jest.fn().mockResolvedValue(undefined),
      upsertUserPreference: jest.fn().mockResolvedValue(undefined),
    };
    const slack = {
      chat: { postMessage: jest.fn().mockResolvedValue({ ts: '1' }) },
      conversations: { open: jest.fn().mockResolvedValue({ channel: { id: 'D1' } }) },
    };
    const ops = { post: jest.fn().mockResolvedValue(undefined), dmQuestionSent: jest.fn().mockResolvedValue(undefined) };
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const scheduler = new DigestScheduler({ db, slackClient: slack, opsNotifier: ops, logger });
    return { db, slack, ops, scheduler };
  }
  const row = (id, key, payload = {}) => ({ id, issue_key: key, slack_user_id: 'U1', payload: { issueKey: key, question: `Approve ${key}?`, transitionTo: 'Done', ...payload } });

  test('delivers a header plus one question message per pending prompt, then marks them delivered', async () => {
    const { db, slack, scheduler } = setup({
      users: [{ slack_user_id: 'U1', digest_frequency: 'daily', tz: TZ, last_digest_at: null }],
      pending: { U1: [row('a', 'SNS-1'), row('b', 'SNS-2')] },
    });
    const res = await scheduler.runOnce(new Date('2026-09-08T07:30:00Z'));
    expect(res).toEqual([{ slackUserId: 'U1', count: 2 }]);
    const texts = slack.chat.postMessage.mock.calls.map((c) => c[0].text);
    expect(texts[0]).toMatch(/Your daily digest.*2 items/);
    expect(texts[1]).toMatch(/SNS-1/);
    expect(texts[2]).toMatch(/SNS-2/);
    // each question carries Yes/No/Reply buttons with the stored payload
    const ctx = JSON.parse(slack.chat.postMessage.mock.calls[1][0].blocks[1].elements[0].value);
    expect(ctx).toMatchObject({ issueKey: 'SNS-1', transitionTo: 'Done', slackUserId: 'U1' });
    expect(db.markPromptsDelivered).toHaveBeenCalledWith(['a', 'b']);
    expect(db.upsertUserPreference).toHaveBeenCalledWith('U1', expect.objectContaining({ last_digest_at: expect.any(String) }));
  });

  test('skips users whose slot has not come yet', async () => {
    const { slack, scheduler } = setup({
      users: [{ slack_user_id: 'U1', digest_frequency: 'daily', tz: TZ, last_digest_at: '2026-09-08T06:10:00Z' }],
      pending: { U1: [row('a', 'SNS-1')] },
    });
    const res = await scheduler.runOnce(new Date('2026-09-08T07:30:00Z'));
    expect(res).toEqual([]);
    expect(slack.chat.postMessage).not.toHaveBeenCalled();
  });

  test('due user with nothing pending → no messages, but last_digest_at advances', async () => {
    const { slack, db, scheduler } = setup({
      users: [{ slack_user_id: 'U1', digest_frequency: 'hourly', tz: TZ, last_digest_at: null }],
    });
    await scheduler.runOnce(new Date('2026-09-08T07:30:00Z'));
    expect(slack.chat.postMessage).not.toHaveBeenCalled();
    expect(db.upsertUserPreference).toHaveBeenCalled();
  });

  test('deliverTo(user, null) flushes immediately without a frequency label (switch back to immediate)', async () => {
    const { slack, scheduler } = setup({ pending: { U1: [row('a', 'SNS-1')] } });
    const n = await scheduler.deliverTo('U1', null);
    expect(n).toBe(1);
    expect(slack.chat.postMessage.mock.calls[0][0].text).toMatch(/^🔔 1 item waiting/);
  });
});
