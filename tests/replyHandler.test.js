'use strict';

const { registerReplyHandler } = require('../src/handlers/replyHandler');
const DedupCache = require('../src/utils/dedupCache');
const RateLimiter = require('../src/utils/rateLimiter');

const REAL_MESSAGE =
  "Bug SNS-122172 / Customer Hosted Multi-Node POC License Expiration Not Working  was marked as Include Release Notes = No." +
  "The bug is assigned to ** from team 'Cockpit'." +
  "@Adva Almog-Dadush - please take a look and make sure this bug does not require public documentation.";

const config = {
  name: 'doc-review-workflow',
  watchChannelId: 'C_WATCH',
  allowedSlackUserIds: [],
  rateLimitPerHour: 20,
  jiraFieldId: 'customfield_10000',
  jiraFieldName: 'PM reviewed',
  jiraFieldValue: 'Yes',
  jiraFieldType: 'select',
};

const attribution = { postAttributionComment: jest.fn().mockResolvedValue(undefined) };

function makeServices(overrides = {}) {
  return {
    dedupCache: new DedupCache(),
    rateLimiter: new RateLimiter(),
    auditLog: { addEntry: jest.fn() },
    alerting: { recordError: jest.fn().mockResolvedValue(undefined), recordRateLimit: jest.fn().mockResolvedValue(undefined) },
    userCache: { getName: jest.fn().mockResolvedValue('Test User') },
    ...overrides,
  };
}

function makeApp() {
  const handlers = {};
  return {
    message: jest.fn((fn) => { handlers.message = fn; }),
    _trigger: (event) => handlers.message(event),
  };
}

function makeJira() {
  return { updateIssueField: jest.fn().mockResolvedValue({}) };
}

function makeClient(rootMessageText) {
  return {
    conversations: {
      replies: jest.fn().mockResolvedValue({ messages: [{ text: rootMessageText, ts: '111.000' }] }),
    },
    chat: { postMessage: jest.fn().mockResolvedValue({}) },
    users: { info: jest.fn().mockResolvedValue({ user: { profile: { real_name: 'Test User' } } }) },
  };
}

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

describe('replyHandler', () => {
  beforeEach(() => jest.clearAllMocks());

  test('updates Jira on a thread reply and posts Slack confirmation', async () => {
    const app = makeApp();
    const jira = makeJira();
    const client = makeClient(REAL_MESSAGE);
    const services = makeServices();
    registerReplyHandler(app, jira, attribution, config, services);

    await app._trigger({
      message: { channel: 'C_WATCH', ts: '222.000', thread_ts: '111.000', user: 'U123' },
      client,
      logger,
    });

    expect(jira.updateIssueField).toHaveBeenCalledWith('SNS-122172', 'customfield_10000', 'Yes', 'select');
    expect(client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'C_WATCH',
      thread_ts: '111.000',
      text: expect.stringMatching(/SNS-122172.+=.+Yes/),
    }));
    expect(services.auditLog.addEntry).toHaveBeenCalledWith(expect.objectContaining({
      issueKey: 'SNS-122172',
      success: true,
    }));
  });

  test('blocks a user not in the allowlist', async () => {
    const app = makeApp();
    const jira = makeJira();
    const restrictedConfig = { ...config, allowedSlackUserIds: ['U_ALLOWED'] };
    registerReplyHandler(app, jira, attribution, restrictedConfig, makeServices());

    await app._trigger({
      message: { channel: 'C_WATCH', ts: '222.000', thread_ts: '111.000', user: 'U_OTHER' },
      client: makeClient(REAL_MESSAGE),
      logger,
    });

    expect(jira.updateIssueField).not.toHaveBeenCalled();
  });

  test('allows a user in the allowlist', async () => {
    const app = makeApp();
    const jira = makeJira();
    const restrictedConfig = { ...config, allowedSlackUserIds: ['U_ALLOWED'] };
    registerReplyHandler(app, jira, attribution, restrictedConfig, makeServices());

    await app._trigger({
      message: { channel: 'C_WATCH', ts: '222.000', thread_ts: '111.000', user: 'U_ALLOWED' },
      client: makeClient(REAL_MESSAGE),
      logger,
    });

    expect(jira.updateIssueField).toHaveBeenCalled();
  });

  test('drops event and alerts when rate limit is exceeded', async () => {
    const app = makeApp();
    const jira = makeJira();
    const services = makeServices();
    const limitedConfig = { ...config, rateLimitPerHour: 1 };
    registerReplyHandler(app, jira, attribution, limitedConfig, services);

    await app._trigger({
      message: { channel: 'C_WATCH', ts: '222.000', thread_ts: '111.000', user: 'U123' },
      client: makeClient(REAL_MESSAGE),
      logger,
    });
    await app._trigger({
      message: { channel: 'C_WATCH', ts: '333.000', thread_ts: '222.000', user: 'U123' },
      client: makeClient(REAL_MESSAGE),
      logger,
    });

    expect(jira.updateIssueField).toHaveBeenCalledTimes(1);
    expect(services.alerting.recordRateLimit).toHaveBeenCalled();
  });

  test('does not update Jira twice for the same event (deduplication)', async () => {
    const app = makeApp();
    const jira = makeJira();
    registerReplyHandler(app, jira, attribution, config, makeServices());

    const event = {
      message: { channel: 'C_WATCH', ts: '222.000', thread_ts: '111.000', user: 'U123' },
      client: makeClient(REAL_MESSAGE),
      logger,
    };
    await app._trigger(event);
    await app._trigger(event);

    expect(jira.updateIssueField).toHaveBeenCalledTimes(1);
  });

  test('records a failed audit entry and calls alerting on Jira error', async () => {
    const app = makeApp();
    const jira = { updateIssueField: jest.fn().mockRejectedValue(new Error('Jira down')) };
    const services = makeServices();
    registerReplyHandler(app, jira, attribution, config, services);

    await app._trigger({
      message: { channel: 'C_WATCH', ts: '222.000', thread_ts: '111.000', user: 'U123' },
      client: makeClient(REAL_MESSAGE),
      logger,
    });

    expect(services.auditLog.addEntry).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
    expect(services.alerting.recordError).toHaveBeenCalled();
  });

  test('does nothing if the message is not a thread reply', async () => {
    const app = makeApp();
    const jira = makeJira();
    registerReplyHandler(app, jira, attribution, config, makeServices());

    await app._trigger({
      message: { channel: 'C_WATCH', ts: '111.000', thread_ts: '111.000', user: 'U123' },
      client: makeClient(REAL_MESSAGE),
      logger,
    });

    expect(jira.updateIssueField).not.toHaveBeenCalled();
  });

  test('does nothing if the channel does not match', async () => {
    const app = makeApp();
    const jira = makeJira();
    registerReplyHandler(app, jira, attribution, config, makeServices());

    await app._trigger({
      message: { channel: 'C_OTHER', ts: '222.000', thread_ts: '111.000', user: 'U123' },
      client: makeClient(REAL_MESSAGE),
      logger,
    });

    expect(jira.updateIssueField).not.toHaveBeenCalled();
  });

  test('does nothing if the root message has no Jira key', async () => {
    const app = makeApp();
    const jira = makeJira();
    registerReplyHandler(app, jira, attribution, config, makeServices());

    await app._trigger({
      message: { channel: 'C_WATCH', ts: '222.000', thread_ts: '111.000', user: 'U123' },
      client: makeClient('Please take a look at this issue.'),
      logger,
    });

    expect(jira.updateIssueField).not.toHaveBeenCalled();
  });
});
