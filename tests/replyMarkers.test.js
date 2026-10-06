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
