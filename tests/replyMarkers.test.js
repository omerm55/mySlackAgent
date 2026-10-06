'use strict';

// Reply markers: in the PM-reviewed channel a scheduled review replies "Auto-verified" (it already set
// the field) or "Needs a decision" (the field must stay unset). The bot marks the root post 👍 / ❓ and
// writes nothing to Jira for either.
const { parseReplyMarkers, formatReplyMarkers, findReplyMarker } = require('../src/utils/replyMarkers');
const { registerReplyHandler } = require('../src/handlers/replyHandler');
const DedupCache = require('../src/utils/dedupCache');
const RateLimiter = require('../src/utils/rateLimiter');

const MARKERS = [{ match: 'Auto-verified', emoji: 'thumbsup' }, { match: 'Needs a decision', emoji: 'question' }];
const ROOT = 'Bug SNS-134117 / Pivot widget error when using Grand Total with multiple rows was marked as Include Release Notes = No.';
const VERIFIED = ':robot_face: Auto-verified: safe not to document (Include Release Notes = No). PM Reviewed set to Yes in Jira.';
const UNSAFE = ':triangular_flag_on_post: Needs a decision: <@U1> <@U2> - the review could not confirm that SNS-134420 is safe to leave undocumented.';

describe('replyMarkers parsing', () => {
  test('parses one marker per line, with or without colons, either arrow', () => {
    const { markers, error } = parseReplyMarkers('Auto-verified => :thumbsup:\n\n  Needs a decision → question  ');
    expect(error).toBeNull();
    expect(markers).toEqual(MARKERS);
  });

  test('empty text is no markers, not an error', () => {
    expect(parseReplyMarkers('')).toEqual({ markers: [], error: null });
    expect(parseReplyMarkers(undefined)).toEqual({ markers: [], error: null });
  });

  test('rejects a line without an arrow or with a bad emoji name', () => {
    expect(parseReplyMarkers('Auto-verified :thumbsup:').error).toMatch(/text => :emoji:/);
    expect(parseReplyMarkers('Auto-verified => 👍').error).toMatch(/not an emoji name/);
  });

  test('format round-trips', () => {
    expect(parseReplyMarkers(formatReplyMarkers(MARKERS)).markers).toEqual(MARKERS);
  });

  test('matches case-insensitively, first marker wins, null when nothing matches', () => {
    expect(findReplyMarker(MARKERS, 'auto-VERIFIED: fine')).toEqual(MARKERS[0]);
    expect(findReplyMarker(MARKERS, UNSAFE)).toEqual(MARKERS[1]);
    expect(findReplyMarker(MARKERS, 'Looks good to me')).toBeNull();
    expect(findReplyMarker(undefined, VERIFIED)).toBeNull();
  });
});

describe('replyHandler with reply markers', () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

  function setup(triggerOverrides = {}) {
    const handlers = {};
    const app = { message: (fn) => { handlers.message = fn; } };
    const jira = { updateIssueField: jest.fn().mockResolvedValue({}) };
    const ops = { post: jest.fn().mockResolvedValue(undefined), jiraTriggered: jest.fn() };
    const services = {
      dedupCache: new DedupCache(),
      rateLimiter: new RateLimiter(),
      auditLog: { addEntry: jest.fn() },
      userCache: { getName: jest.fn().mockResolvedValue('Omer') },
      opsNotifier: ops,
      integrationCache: {
        getAll: async () => [{
          name: 'PM Reviewed', slackChannelId: 'C_WATCH', triggers: ['reaction', 'reply'], scope: 'global',
          createdBy: 'UOMER', allowedSlackUserIds: [], rateLimitPerHour: 20,
          jiraFieldId: 'customfield_1', jiraFieldName: 'PM Reviewed', jiraFieldValue: 'Yes', jiraFieldType: 'select',
          replyMarkers: MARKERS, ...triggerOverrides,
        }],
      },
    };
    registerReplyHandler(app, jira, { postAttributionComment: jest.fn() }, services);
    const client = {
      conversations: { replies: jest.fn().mockResolvedValue({ messages: [{ text: ROOT, ts: '111.000' }] }) },
      chat: { postMessage: jest.fn().mockResolvedValue({}) },
      reactions: { add: jest.fn().mockResolvedValue({ ok: true }) },
    };
    const reply = (text, extra = {}) => handlers.message({
      message: { channel: 'C_WATCH', ts: '222.000', thread_ts: '111.000', user: 'UOMER', text, ...extra },
      client, logger, context: { botUserId: 'UBOT', botId: 'BBOT' },
    });
    return { reply, client, jira, ops };
  }

  test('"Auto-verified" → 👍 on the root post, no Jira write, no thread message', async () => {
    const { reply, client, jira } = setup();
    await reply(VERIFIED);
    expect(client.reactions.add).toHaveBeenCalledWith({ channel: 'C_WATCH', timestamp: '111.000', name: 'thumbsup' });
    expect(jira.updateIssueField).not.toHaveBeenCalled();
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });

  test('"Needs a decision" → ❓ on the root post, and PM Reviewed is NOT set', async () => {
    const { reply, client, jira } = setup();
    await reply(UNSAFE);
    expect(client.reactions.add).toHaveBeenCalledWith({ channel: 'C_WATCH', timestamp: '111.000', name: 'question' });
    expect(jira.updateIssueField).not.toHaveBeenCalled();
  });

  test('works on a reaction-only trigger and for a reply posted through another app', async () => {
    const { reply, client } = setup({ triggers: ['reaction'] });
    await reply(VERIFIED, { bot_id: 'BCLAUDE' });
    expect(client.reactions.add).toHaveBeenCalledWith(expect.objectContaining({ name: 'thumbsup' }));
  });

  test('an ordinary reply still sets the field on a reply trigger', async () => {
    const { reply, client, jira } = setup();
    await reply('Reviewed, no docs needed');
    expect(client.reactions.add).not.toHaveBeenCalled();
    expect(jira.updateIssueField).toHaveBeenCalledWith('SNS-134117', 'customfield_1', 'Yes', 'select');
  });

  test('the bot\'s own replies are ignored', async () => {
    const { reply, client, jira } = setup();
    await reply(`✅ Auto-verified echo`, { user: 'UBOT', bot_id: 'BBOT' });
    expect(client.reactions.add).not.toHaveBeenCalled();
    expect(jira.updateIssueField).not.toHaveBeenCalled();
  });

  test('already_reacted is quiet; a missing scope is reported to ops', async () => {
    const { reply, client, ops } = setup();
    client.reactions.add.mockRejectedValueOnce(Object.assign(new Error('x'), { data: { error: 'already_reacted' } }));
    await reply(VERIFIED);
    expect(ops.post).not.toHaveBeenCalled();
    client.reactions.add.mockRejectedValueOnce(Object.assign(new Error('x'), { data: { error: 'missing_scope' } }));
    await reply(UNSAFE, { ts: '333.000' });
    expect(ops.post).toHaveBeenCalledWith(expect.stringMatching(/reactions:write/), expect.objectContaining({ kind: 'reply_marker_failed' }));
  });

  test('personal scope: someone else\'s marker reply does nothing', async () => {
    const { reply, client } = setup({ scope: 'personal' });
    await reply(VERIFIED, { user: 'USOMEONE' });
    expect(client.reactions.add).not.toHaveBeenCalled();
  });
});

describe('settled posts: an approval marker means a person\'s 👍 or reply writes nothing', () => {
  const { registerReactionHandler } = require('../src/handlers/reactionHandler');
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const trigger = {
    name: 'PM Reviewed', slackChannelId: 'C_WATCH', triggers: ['reaction', 'reply'], scope: 'global',
    createdBy: 'UOMER', allowedSlackUserIds: [], rateLimitPerHour: 20,
    jiraFieldId: 'customfield_1', jiraFieldName: 'PM Reviewed', jiraFieldValue: 'Yes', jiraFieldType: 'select',
    replyMarkers: MARKERS,
  };

  function services(overrides = {}) {
    return {
      dedupCache: new DedupCache(),
      rateLimiter: new RateLimiter(),
      auditLog: { addEntry: jest.fn() },
      userCache: { getName: jest.fn().mockResolvedValue('PM') },
      opsNotifier: { post: jest.fn(), jiraTriggered: jest.fn(), reactionFiltered: jest.fn() },
      integrationCache: { getAll: async () => [{ ...trigger, ...overrides }] },
    };
  }

  function react(root, thread = [], overrides = {}) {
    const handlers = {};
    const app = { event: (name, fn) => { handlers[name] = fn; } };
    const jira = { updateIssueField: jest.fn().mockResolvedValue({}) };
    const svc = services(overrides);
    registerReactionHandler(app, jira, { postAttributionComment: jest.fn() }, svc);
    const client = {
      conversations: {
        history: jest.fn().mockResolvedValue({ messages: [{ ts: '111.000', text: ROOT, ...root }] }),
        replies: jest.fn().mockResolvedValue({ messages: [{ ts: '111.000', text: ROOT }, ...thread] }),
      },
      chat: { postMessage: jest.fn().mockResolvedValue({}) },
    };
    const run = handlers.reaction_added({
      event: { reaction: '+1', user: 'UPM', item: { type: 'message', channel: 'C_WATCH', ts: '111.000' } },
      client, logger, context: { botUserId: 'UBOT', botId: 'BBOT' },
    });
    return run.then(() => ({ jira, client, ops: svc.opsNotifier }));
  }

  test('👍 on a post the bot already marked 👍 → nothing written, no thread message, no thread fetch', async () => {
    const { jira, client, ops } = await react({ reply_count: 1, reactions: [{ name: 'thumbsup', users: ['UBOT'], count: 1 }] });
    expect(jira.updateIssueField).not.toHaveBeenCalled();
    expect(client.chat.postMessage).not.toHaveBeenCalled();
    expect(client.conversations.replies).not.toHaveBeenCalled();
    expect(ops.reactionFiltered).toHaveBeenCalledWith(expect.objectContaining({ reason: expect.stringMatching(/already "Auto-verified"/) }));
  });

  test('👍 on an auto-verified post the bot has not marked yet → nothing written', async () => {
    const { jira, client } = await react({ reply_count: 1 }, [{ ts: '222.000', user: 'UOMER', text: VERIFIED }]);
    expect(jira.updateIssueField).not.toHaveBeenCalled();
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });

  test('👍 on a "Needs a decision" post is the decision → the field is set', async () => {
    const { jira } = await react({ reply_count: 1, reactions: [{ name: 'question', users: ['UBOT'], count: 1 }] }, [{ ts: '222.000', user: 'UOMER', text: UNSAFE }]);
    expect(jira.updateIssueField).toHaveBeenCalledWith('SNS-134117', 'customfield_1', 'Yes', 'select');
  });

  test('a person\'s own 👍 or the bot echoing the phrase does not settle a post', async () => {
    const { jira } = await react(
      { reply_count: 1, reactions: [{ name: '+1', users: ['USOMEONE'], count: 1 }] },
      [{ ts: '222.000', user: 'UBOT', bot_id: 'BBOT', text: 'Auto-verified echo' }],
    );
    expect(jira.updateIssueField).toHaveBeenCalled();
  });

  test('a trigger without an approval marker behaves as before', async () => {
    const { jira, client } = await react({ reply_count: 1 }, [{ ts: '222.000', user: 'UOMER', text: VERIFIED }], { replyMarkers: [{ match: 'Needs a decision', emoji: 'question' }] });
    expect(jira.updateIssueField).toHaveBeenCalled();
    expect(client.conversations.replies).not.toHaveBeenCalled();
  });

  test('a reply on an auto-verified thread ("I disagree…") writes nothing', async () => {
    const handlers = {};
    const app = { message: (fn) => { handlers.message = fn; } };
    const jira = { updateIssueField: jest.fn().mockResolvedValue({}) };
    const svc = services();
    registerReplyHandler(app, jira, { postAttributionComment: jest.fn() }, svc);
    const thread = [{ ts: '111.000', text: ROOT, reply_count: 2 }, { ts: '222.000', user: 'UOMER', text: VERIFIED }, { ts: '333.000', user: 'UPM', text: 'I disagree, this needs a note' }];
    const client = {
      conversations: { replies: jest.fn().mockResolvedValue({ messages: thread }) },
      chat: { postMessage: jest.fn().mockResolvedValue({}) },
      reactions: { add: jest.fn() },
    };
    await handlers.message({
      message: { channel: 'C_WATCH', ts: '333.000', thread_ts: '111.000', user: 'UPM', text: 'I disagree, this needs a note' },
      client, logger, context: { botUserId: 'UBOT', botId: 'BBOT' },
    });
    expect(jira.updateIssueField).not.toHaveBeenCalled();
    expect(client.chat.postMessage).not.toHaveBeenCalled();
    expect(svc.opsNotifier.reactionFiltered).toHaveBeenCalledWith(expect.objectContaining({ reason: expect.stringMatching(/already "Auto-verified"/) }));
  });
});
