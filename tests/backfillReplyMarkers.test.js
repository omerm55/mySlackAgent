'use strict';

// Back-filling reply markers onto threads answered before the markers were configured (§12.2c).
const { backfill, parseArgs } = require('../scripts/backfill-reply-markers');

const MARKERS = [{ match: 'Auto-verified', emoji: 'thumbsup' }, { match: 'Needs a decision', emoji: 'question' }];

function makeClient() {
  const history = [
    { ts: '1.0', text: 'Bug SNS-1 was marked as Include Release Notes = No.', reply_count: 1 },
    { ts: '2.0', text: 'Bug SNS-2 was marked as Include Release Notes = No.', reply_count: 1 },
    { ts: '3.0', text: 'Bug SNS-3 …', reply_count: 1, reactions: [{ name: 'thumbsup', users: ['UBOT'] }] },
    { ts: '4.0', text: 'No key here', reply_count: 1 },
    { ts: '5.0', text: 'Bug SNS-5 …', reply_count: 0 },
    { ts: '6.0', text: 'Bug SNS-6 …', reply_count: 2 },
  ];
  const threads = {
    '1.0': [{ ts: '1.1', user: 'UOMER', text: ':robot_face: Auto-verified: safe not to document.' }],
    '2.0': [{ ts: '2.1', user: 'UOMER', text: ':triangular_flag_on_post: Needs a decision: <@U1>' }],
    '3.0': [{ ts: '3.1', user: 'UOMER', text: 'Auto-verified: safe' }],
    '6.0': [{ ts: '6.1', user: 'UBOT', bot_id: 'BBOT', text: '✅ Auto-verified echo' }, { ts: '6.2', user: 'UPM', text: 'thanks' }],
  };
  return {
    auth: { test: jest.fn().mockResolvedValue({ user_id: 'UBOT', bot_id: 'BBOT' }) },
    conversations: {
      history: jest.fn().mockResolvedValue({ messages: history }),
      replies: jest.fn(async ({ ts }) => ({ messages: [{ ts, text: 'root' }, ...(threads[ts] || [])] })),
    },
    reactions: { add: jest.fn().mockResolvedValue({ ok: true }) },
  };
}

describe('backfill-reply-markers', () => {
  test('dry run reports what it would mark and reacts to nothing', async () => {
    const client = makeClient();
    const { threads, marked } = await backfill({ client, channel: 'C1', oldest: '0', markers: MARKERS });
    expect(threads).toBe(4); // keyed roots with replies: 1, 2, 3, 6
    expect(marked).toEqual([
      expect.objectContaining({ ts: '1.0', emoji: 'thumbsup', result: 'would mark' }),
      expect.objectContaining({ ts: '2.0', emoji: 'question', result: 'would mark' }),
      expect.objectContaining({ ts: '3.0', emoji: 'thumbsup', result: 'already marked' }),
    ]);
    expect(client.reactions.add).not.toHaveBeenCalled();
  });

  test('--apply reacts on the root post; the bot\'s own replies never count', async () => {
    const client = makeClient();
    await backfill({ client, channel: 'C1', oldest: '0', markers: MARKERS, apply: true });
    expect(client.reactions.add.mock.calls.map((c) => c[0])).toEqual([
      { channel: 'C1', timestamp: '1.0', name: 'thumbsup' },
      { channel: 'C1', timestamp: '2.0', name: 'question' },
    ]);
  });

  test('a Slack refusal is reported per post, not thrown', async () => {
    const client = makeClient();
    client.reactions.add.mockRejectedValueOnce(Object.assign(new Error('x'), { data: { error: 'missing_scope' } }));
    const { marked } = await backfill({ client, channel: 'C1', oldest: '0', markers: MARKERS, apply: true });
    expect(marked[0].result).toBe('failed: missing_scope');
    expect(marked[1].result).toBe('marked');
  });

  test('arguments', () => {
    expect(parseArgs(['--channel', 'C1', '--since', '2026-10-04', '--marker', 'a => :b:', '--apply']))
      .toEqual({ channel: 'C1', since: '2026-10-04', markers: ['a => :b:'], apply: true });
    expect(() => parseArgs(['--nope'])).toThrow(/unknown argument/);
  });
});
