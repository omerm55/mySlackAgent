'use strict';

// Decisions in a flagged (❓) thread: a decider's reply → LLM → proposal → their click writes,
// read back, ❓ → ✅. Nothing is written without that click.
const {
  parseDecisionConfig, formatDecisionConfig, mentionedUsers, findOpenFlag, normaliseDecision,
} = require('../src/utils/threadDecision');
const { findSettlingMarker } = require('../src/utils/replyMarkers');
const { registerReplyHandler } = require('../src/handlers/replyHandler');
const { registerDecisionHandler } = require('../src/handlers/decisionHandler');
const { registerReactionHandler } = require('../src/handlers/reactionHandler');
const LlmService = require('../src/services/llmService');
const DedupCache = require('../src/utils/dedupCache');
const RateLimiter = require('../src/utils/rateLimiter');

const MARKERS = [{ match: 'Auto-verified', emoji: 'thumbsup' }, { match: 'Needs a decision', emoji: 'question' }];
const DECISION = { fieldId: 'customfield_11228', fieldName: 'Include Release Notes', options: ['Public', 'Internal', 'No'] };
const ROOT = { ts: '111.000', text: 'Bug SNS-134420 / Data Security … was marked as Include Release Notes = Internal. See also SNS-1.', reply_count: 2 };
const FLAG = { ts: '200.000', user: 'UOMER', text: ':triangular_flag_on_post: Needs a decision: <@UOMER|Omer> <@UAYTON|Ayton> <@UMORLI|Morli> - please decide.' };
const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
const context = { botUserId: 'UBOT', botId: 'BBOT' };

describe('threadDecision helpers', () => {
  test('decision config parses, formats and rejects bad lines', () => {
    const { decision, error } = parseDecisionConfig('customfield_11228 | Include Release Notes | Public, Internal, No');
    expect(error).toBeNull();
    expect(decision).toEqual(DECISION);
    expect(parseDecisionConfig(formatDecisionConfig(decision)).decision).toEqual(DECISION);
    expect(parseDecisionConfig('')).toEqual({ decision: null, error: null });
    expect(parseDecisionConfig('Include Release Notes | Public, No').error).toMatch(/field id/);
    expect(parseDecisionConfig('customfield_1 | X | Public').error).toMatch(/two allowed values/);
  });

  test('mentions, normalisation', () => {
    expect(mentionedUsers(FLAG.text)).toEqual(['UOMER', 'UAYTON', 'UMORLI']);
    expect(mentionedUsers('<@UA> <@UA> <@WB>')).toEqual(['UA', 'WB']);
    expect(normaliseDecision(' public ', DECISION.options)).toBe('Public');
    expect(normaliseDecision('Maybe', DECISION.options)).toBeNull();
    expect(normaliseDecision(null, DECISION.options)).toBeNull();
  });

  test('findOpenFlag: the latest flag is open; a later approval marker closes it; the bot never counts', () => {
    expect(findOpenFlag({ thread: [ROOT, FLAG], root: ROOT, markers: MARKERS, ...context }).deciders).toEqual(['UOMER', 'UAYTON', 'UMORLI']);
    expect(findOpenFlag({ thread: [ROOT, FLAG, { ts: '300', user: 'UOMER', text: 'Auto-verified: fine' }], root: ROOT, markers: MARKERS, ...context })).toBeNull();
    expect(findOpenFlag({ thread: [ROOT, { ...FLAG, user: 'UBOT' }], root: ROOT, markers: MARKERS, ...context })).toBeNull();
    expect(findOpenFlag({ thread: [ROOT, { ts: '2', user: 'UPM', text: 'hello' }], root: ROOT, markers: MARKERS, ...context })).toBeNull();
  });

  test('a ✅ from the bot (a recorded decision) settles the post', async () => {
    const root = { ...ROOT, reactions: [{ name: 'white_check_mark', users: ['UBOT'] }] };
    expect(await findSettlingMarker({ root, markers: MARKERS, botUserId: 'UBOT', readThread: jest.fn() })).toEqual({ match: 'decided', emoji: 'white_check_mark' });
  });

  test('interpretDecision sends the prompt, the options, the current value and the reply', async () => {
    const llm = new LlmService('openai', 'k');
    llm._callJson = jest.fn().mockResolvedValue({ decision: 'Public', reason: 'says document it' });
    await llm.interpretDecision({ issueKey: 'SNS-1', post: 'p', flag: 'f', fieldName: 'Include Release Notes', options: ['Public', 'No'], current: 'No', reply: 'make it public' });
    const [prompt, msg] = llm._callJson.mock.calls[0];
    expect(prompt).toBe(LlmService.DECISION_PROMPT);
    expect(msg).toMatch(/Allowed values: "Public", "No"\. Current value: "No"/);
    expect(msg).toMatch(/Reply \(verbatim\): "make it public"/);
  });
});

function makeServices({ trigger = {}, llmAnswer = { decision: 'Public', reason: 'They said to document it publicly.' }, hasToken = true } = {}) {
  const userJira = {
    updateIssueFields: jest.fn().mockResolvedValue(undefined),
    getIssue: jest.fn().mockResolvedValue({ fields: { customfield_11228: { value: 'Public' }, customfield_11296: { value: 'Yes' } } }),
  };
  return {
    userJira,
    dedupCache: new DedupCache(),
    rateLimiter: new RateLimiter(),
    auditLog: { addEntry: jest.fn() },
    userCache: { getName: jest.fn().mockResolvedValue('Morli') },
    opsNotifier: { post: jest.fn(), jiraTriggered: jest.fn(), reactionFiltered: jest.fn() },
    llmService: { interpretDecision: jest.fn().mockResolvedValue(llmAnswer) },
    oauthService: {
      hasToken: jest.fn().mockReturnValue(hasToken),
      getJiraService: jest.fn().mockResolvedValue(userJira),
      generateAuthUrl: jest.fn().mockResolvedValue('https://auth'),
    },
    db: null,
    integrationCache: {
      getAll: async () => [{
        name: 'PM Reviewed', slackChannelId: 'C_WATCH', triggers: ['reaction'], scope: 'global', createdBy: 'UOMER',
        allowedSlackUserIds: [], rateLimitPerHour: 20, jiraFieldId: 'customfield_11296', jiraFieldName: 'PM Reviewed',
        jiraFieldValue: 'Yes', jiraFieldType: 'select', replyMarkers: MARKERS, decision: DECISION, ...trigger,
      }],
    },
  };
}

function makeClient(thread = [ROOT, FLAG]) {
  return {
    conversations: { replies: jest.fn(async ({ limit }) => ({ messages: limit === 1 ? [thread[0]] : thread })) },
    chat: { postMessage: jest.fn().mockResolvedValue({ ts: '999.000' }), update: jest.fn().mockResolvedValue({}), postEphemeral: jest.fn().mockResolvedValue({}) },
    reactions: { add: jest.fn().mockResolvedValue({}), remove: jest.fn().mockResolvedValue({}) },
  };
}

describe('reply in a flagged thread → proposal', () => {
  function setup(opts = {}) {
    const handlers = {};
    const app = { message: (fn) => { handlers.message = fn; } };
    const services = makeServices(opts);
    const serviceJira = { updateIssueField: jest.fn(), getIssue: jest.fn().mockResolvedValue({ fields: { customfield_11228: { value: 'Internal' } } }) };
    registerReplyHandler(app, serviceJira, { postAttributionComment: jest.fn() }, services);
    const client = makeClient(opts.thread);
    const reply = (user, text) => handlers.message({
      message: { channel: 'C_WATCH', ts: '300.000', thread_ts: '111.000', user, text }, client, logger, context,
    });
    return { reply, client, services, serviceJira };
  }

  test('a decider\'s reply is read and proposed with Apply / Not quite; nothing is written', async () => {
    const { reply, client, services, serviceJira } = setup();
    await reply('UMORLI', 'Yes, this should be public');
    expect(services.llmService.interpretDecision).toHaveBeenCalledWith(expect.objectContaining({
      issueKey: 'SNS-134420', options: DECISION.options, current: 'Internal', reply: 'Yes, this should be public', flag: FLAG.text,
    }));
    const posted = client.chat.postMessage.mock.calls[0][0];
    expect(posted.thread_ts).toBe('111.000');
    expect(posted.text).toMatch(/<@UMORLI> I read your reply as: \*Include Release Notes\* = \*Public\* \(now \*Internal\*\) and \*PM Reviewed\* = \*Yes\* on/);
    const actions = posted.blocks.find((b) => b.type === 'actions').elements.map((e) => e.action_id);
    expect(actions).toEqual(['decision_apply', 'decision_dismiss']);
    expect(JSON.parse(posted.blocks.find((b) => b.type === 'actions').elements[0].value)).toEqual(expect.objectContaining({ issueKey: 'SNS-134420', decider: 'UMORLI', value: 'Public', flagEmoji: 'question' }));
    expect(serviceJira.updateIssueField).not.toHaveBeenCalled();
    expect(services.userJira.updateIssueFields).not.toHaveBeenCalled();
  });

  test('someone the flag does not mention is ignored (no LLM call)', async () => {
    const { reply, client, services } = setup();
    await reply('USOMEONE', 'Public please');
    expect(services.llmService.interpretDecision).not.toHaveBeenCalled();
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });

  test('a question or reminder ("WDYT?") states no decision → nothing posted', async () => {
    const { reply, client } = setup({ llmAnswer: { decision: null } });
    await reply('UOMER', '<@UMORLI> WDYT? do we need to publicly document this bug?');
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });

  test('an answer outside the allowed values is dropped', async () => {
    const { reply, client } = setup({ llmAnswer: { decision: 'Maybe' } });
    await reply('UMORLI', 'hmm');
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });

  test('with 💬 Thread reply on, a reply in an open ❓ thread still never writes directly', async () => {
    const { reply, serviceJira, services } = setup({ trigger: { triggers: ['reaction', 'reply'] }, llmAnswer: { decision: null } });
    await reply('USOMEONE', 'any thoughts?');
    await reply('UMORLI', 'still thinking');
    expect(serviceJira.updateIssueField).not.toHaveBeenCalled();
    expect(services.userJira.updateIssueFields).not.toHaveBeenCalled();
  });

  test('a decided (✅) thread is settled: no proposal', async () => {
    const decided = { ...ROOT, reactions: [{ name: 'white_check_mark', users: ['UBOT'] }] };
    const { reply, client, services } = setup({ thread: [decided, FLAG] });
    await reply('UMORLI', 'Public');
    expect(services.llmService.interpretDecision).not.toHaveBeenCalled();
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });
});

describe('decision_apply / decision_dismiss', () => {
  const ctx = {
    issueKey: 'SNS-134420', channel: 'C_WATCH', rootTs: '111.000', decider: 'UMORLI', trigger: 'PM Reviewed',
    fieldId: 'customfield_11228', fieldName: 'Include Release Notes', value: 'Public',
    reviewFieldId: 'customfield_11296', reviewFieldName: 'PM Reviewed', reviewValue: 'Yes', flagEmoji: 'question', allowFallback: false,
  };
  function setup(opts = {}) {
    const handlers = {};
    const app = { action: (id, fn) => { handlers[id] = fn; } };
    const services = makeServices(opts);
    const serviceJira = { updateIssueFields: jest.fn(), getIssue: jest.fn() };
    registerDecisionHandler(app, serviceJira, services);
    const client = makeClient();
    const click = (id, user = 'UMORLI') => handlers[id]({
      ack: jest.fn(), client, logger,
      body: { user: { id: user }, channel: { id: 'C_WATCH' }, message: { ts: '999.000' }, actions: [{ value: JSON.stringify(ctx) }] },
    });
    return { click, client, services, serviceJira };
  }

  test('Apply: one PUT as the decider, read back, then ❓ → ✅ and the proposal closes', async () => {
    const { click, client, services } = setup();
    await click('decision_apply');
    expect(services.userJira.updateIssueFields).toHaveBeenCalledWith('SNS-134420', {
      customfield_11228: { value: 'Public' }, customfield_11296: { value: 'Yes' },
    });
    expect(services.userJira.getIssue).toHaveBeenCalledWith('SNS-134420');
    expect(client.reactions.remove).toHaveBeenCalledWith({ channel: 'C_WATCH', timestamp: '111.000', name: 'question' });
    expect(client.reactions.add).toHaveBeenCalledWith({ channel: 'C_WATCH', timestamp: '111.000', name: 'white_check_mark' });
    expect(client.chat.update).toHaveBeenCalledWith(expect.objectContaining({ ts: '999.000', text: expect.stringMatching(/^✅ Done/) }));
    expect(services.opsNotifier.post).toHaveBeenCalledWith(expect.stringMatching(/❓ → ✅/), expect.objectContaining({ kind: 'decision_applied' }));
  });

  test('Apply by someone else: ephemeral note, nothing written', async () => {
    const { click, client, services } = setup();
    await click('decision_apply', 'UOTHER');
    expect(client.chat.postEphemeral).toHaveBeenCalledWith(expect.objectContaining({ user: 'UOTHER' }));
    expect(services.userJira.updateIssueFields).not.toHaveBeenCalled();
  });

  test('read-back mismatch: ❓ stays and ops is warned', async () => {
    const { click, client, services } = setup();
    services.userJira.getIssue.mockResolvedValue({ fields: { customfield_11228: { value: 'No' }, customfield_11296: { value: 'Yes' } } });
    await click('decision_apply');
    expect(client.reactions.remove).not.toHaveBeenCalled();
    expect(client.reactions.add).not.toHaveBeenCalled();
    expect(client.chat.update).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringMatching(/Include Release Notes = No/) }));
    expect(services.opsNotifier.post).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ kind: 'decision_unverified', ok: false }));
  });

  test('Jira refuses: proposal kept with the reason, ❓ stays', async () => {
    const { click, client, services } = setup();
    services.userJira.updateIssueFields.mockRejectedValue(new Error('Field cannot be set'));
    await click('decision_apply');
    expect(client.reactions.add).not.toHaveBeenCalled();
    const updated = client.chat.update.mock.calls[0][0];
    expect(updated.blocks.some((b) => b.type === 'actions')).toBe(true);
    expect(JSON.stringify(updated.blocks)).toMatch(/Field cannot be set/);
  });

  test('not connected and no fallback: Connect DM, buttons kept, nothing written', async () => {
    const { click, client, services, serviceJira } = setup({ hasToken: false });
    await click('decision_apply');
    expect(serviceJira.updateIssueFields).not.toHaveBeenCalled();
    expect(client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: 'UMORLI', text: expect.stringMatching(/connect your Jira account/) }));
    expect(client.chat.update.mock.calls[0][0].blocks.some((b) => b.type === 'actions')).toBe(true);
    expect(services.opsNotifier.reactionFiltered).toHaveBeenCalled();
  });

  test('Not quite: closes the proposal, writes nothing', async () => {
    const { click, client, services } = setup();
    await click('decision_dismiss');
    expect(services.userJira.updateIssueFields).not.toHaveBeenCalled();
    expect(client.chat.update).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringMatching(/nothing changed/) }));
  });
});

describe('👍 on a flagged post is a decision too', () => {
  test('after the write succeeds, the bot\'s ❓ becomes ✅', async () => {
    const handlers = {};
    const app = { event: (name, fn) => { handlers[name] = fn; } };
    const services = makeServices();
    services.oauthService.getJiraService.mockResolvedValue({ updateIssueField: jest.fn().mockResolvedValue({}) });
    registerReactionHandler(app, {}, { postAttributionComment: jest.fn() }, services);
    const root = { ...ROOT, reply_count: 0, reactions: [{ name: 'question', users: ['UBOT'], count: 1 }] };
    const client = {
      conversations: { history: jest.fn().mockResolvedValue({ messages: [root] }) },
      chat: { postMessage: jest.fn().mockResolvedValue({}) },
      reactions: { add: jest.fn().mockResolvedValue({}), remove: jest.fn().mockResolvedValue({}) },
    };
    await handlers.reaction_added({
      event: { reaction: '+1', user: 'UMORLI', item: { type: 'message', channel: 'C_WATCH', ts: '111.000' } }, client, logger, context,
    });
    expect(client.reactions.remove).toHaveBeenCalledWith({ channel: 'C_WATCH', timestamp: '111.000', name: 'question' });
    expect(client.reactions.add).toHaveBeenCalledWith({ channel: 'C_WATCH', timestamp: '111.000', name: 'white_check_mark' });
  });
});
