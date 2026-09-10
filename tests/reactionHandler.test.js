'use strict';

const { registerReactionHandler } = require('../src/handlers/reactionHandler');
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
    event: jest.fn((name, fn) => { handlers[name] = fn; }),
    _trigger: (name, payload) => handlers[name](payload),
  };
}

function makeJira() {
  return { updateIssueField: jest.fn().mockResolvedValue({}) };
}

function makeClient(messageText) {
  return {
    conversations: {
      history: jest.fn().mockResolvedValue({ messages: [{ text: messageText, ts: '111.000' }] }),
    },
    chat: { postMessage: jest.fn().mockResolvedValue({}) },
    users: { info: jest.fn().mockResolvedValue({ user: { profile: { real_name: 'Test User' } } }) },
  };
}

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

// The handler is registered once and reads integrations from services.integrationCache
// at event time. Wrap a legacy-style config in a fake cache for these tests.
function register(app, jira, cfg, services) {
  services.integrationCache = {
    getAll: async () => [{
      ...cfg,
      slackChannelId: cfg.watchChannelId,
      triggers: cfg.triggers || ['reaction'],
      scope: cfg.scope || 'global',
    }],
  };
  registerReactionHandler(app, jira, attribution, services);
}

describe('reactionHandler', () => {
  beforeEach(() => jest.clearAllMocks());

  test('personal-scope integration only fires for its creator', async () => {
    const app = makeApp();
    const jira = makeJira();
    register(app, jira, { ...config, scope: 'personal', createdBy: 'U_OWNER' }, makeServices());

    const base = { client: makeClient(REAL_MESSAGE), logger };
    await app._trigger('reaction_added', { ...base,
      event: { reaction: '+1', user: 'U_OTHER', item: { type: 'message', channel: 'C_WATCH', ts: '111.000' } } });
    expect(jira.updateIssueField).not.toHaveBeenCalled();

    await app._trigger('reaction_added', { ...base,
      event: { reaction: '+1', user: 'U_OWNER', item: { type: 'message', channel: 'C_WATCH', ts: '111.000' } } });
    expect(jira.updateIssueField).toHaveBeenCalledTimes(1);
  });

  test.each(['+1', 'thumbsup', 'thumbs_up', 'white_check_mark', '+1::skin-tone-3'])(
    'updates Jira on "%s" reaction and posts Slack confirmation',
    async (emoji) => {
      const app = makeApp();
      const jira = makeJira();
      const client = makeClient(REAL_MESSAGE);
      const services = makeServices();
      register(app, jira, config, services);

      await app._trigger('reaction_added', {
        event: { reaction: emoji, user: 'U123', item: { type: 'message', channel: 'C_WATCH', ts: '111.000' } },
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
    }
  );

  test('no token + fallback not allowed → nothing written, thread asks to connect, auth DM sent, ops told', async () => {
    const app = makeApp();
    const jira = makeJira();
    const client = makeClient(REAL_MESSAGE);
    client.conversations.open = jest.fn().mockResolvedValue({ channel: { id: 'DUSER' } });
    const services = makeServices({
      oauthService: { hasToken: () => false, generateAuthUrl: jest.fn().mockResolvedValue('https://auth?state=r'), getJiraService: jest.fn() },
      opsNotifier: { reactionFiltered: jest.fn().mockResolvedValue(undefined), jiraTriggered: jest.fn() },
    });
    register(app, jira, { ...config, allowBotFallback: false }, services);
    await app._trigger('reaction_added', { event: { reaction: '+1', user: 'U123', item: { type: 'message', channel: 'C_WATCH', ts: '111.000' } }, client, logger });
    await new Promise((r) => setImmediate(r));
    expect(jira.updateIssueField).not.toHaveBeenCalled();
    expect(attribution.postAttributionComment).not.toHaveBeenCalled();
    expect(client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: 'C_WATCH', thread_ts: '111.000', text: expect.stringMatching(/connect Jira.*react again/i) }));
    expect(client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: 'DUSER', text: expect.stringMatching(/https:\/\/auth\?state=r/) }));
    expect(services.opsNotifier.reactionFiltered).toHaveBeenCalledWith(expect.objectContaining({ reason: expect.stringMatching(/not connected to Jira/) }));
  });

  test('no token + fallback allowed → bot account writes with attribution comment; with token → user writes, no attribution', async () => {
    const mk = (hasToken) => {
      const app = makeApp(); const jira = makeJira(); const client = makeClient(REAL_MESSAGE);
      client.conversations.open = jest.fn().mockResolvedValue({ channel: { id: 'DUSER' } });
      const userJira = { updateIssueField: jest.fn().mockResolvedValue({}) };
      const services = makeServices({ oauthService: { hasToken: () => hasToken, generateAuthUrl: jest.fn().mockResolvedValue('https://auth'), getJiraService: jest.fn().mockResolvedValue(userJira) }, opsNotifier: { reactionFiltered: jest.fn(), jiraTriggered: jest.fn() } });
      register(app, jira, { ...config, allowBotFallback: true }, services);
      return { app, jira, userJira, client, services };
    };
    let t = mk(false);
    await t.app._trigger('reaction_added', { event: { reaction: '+1', user: 'U123', item: { type: 'message', channel: 'C_WATCH', ts: '111.000' } }, client: t.client, logger });
    expect(t.jira.updateIssueField).toHaveBeenCalledTimes(1);
    expect(attribution.postAttributionComment).toHaveBeenCalledTimes(1);
    expect(t.services.opsNotifier.jiraTriggered).toHaveBeenCalledWith(expect.objectContaining({ usingOAuth: false, success: true }));
    jest.clearAllMocks();
    t = mk(true);
    await t.app._trigger('reaction_added', { event: { reaction: '+1', user: 'U123', item: { type: 'message', channel: 'C_WATCH', ts: '111.000' } }, client: t.client, logger });
    expect(t.userJira.updateIssueField).toHaveBeenCalledTimes(1);
    expect(t.jira.updateIssueField).not.toHaveBeenCalled();
    expect(attribution.postAttributionComment).not.toHaveBeenCalled();
    expect(t.services.opsNotifier.jiraTriggered).toHaveBeenCalledWith(expect.objectContaining({ usingOAuth: true }));
  });

  test('blocks a user not in the allowlist', async () => {
    const app = makeApp();
    const jira = makeJira();
    const restrictedConfig = { ...config, allowedSlackUserIds: ['U_ALLOWED'] };
    register(app, jira, restrictedConfig, makeServices());

    await app._trigger('reaction_added', {
      event: { reaction: '+1', user: 'U_OTHER', item: { type: 'message', channel: 'C_WATCH', ts: '111.000' } },
      client: makeClient(REAL_MESSAGE),
      logger,
    });

    expect(jira.updateIssueField).not.toHaveBeenCalled();
  });

  test('allows a user in the allowlist', async () => {
    const app = makeApp();
    const jira = makeJira();
    const restrictedConfig = { ...config, allowedSlackUserIds: ['U_ALLOWED'] };
    register(app, jira, restrictedConfig, makeServices());

    await app._trigger('reaction_added', {
      event: { reaction: '+1', user: 'U_ALLOWED', item: { type: 'message', channel: 'C_WATCH', ts: '111.000' } },
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
    register(app, jira, limitedConfig, services);

    const payload = {
      event: { reaction: '+1', user: 'U123', item: { type: 'message', channel: 'C_WATCH', ts: '111.000' } },
      client: makeClient(REAL_MESSAGE),
      logger,
    };
    await app._trigger('reaction_added', payload);       // allowed
    await app._trigger('reaction_added', { ...payload,  // rate limited (different ts to bypass dedup)
      event: { ...payload.event, item: { ...payload.event.item, ts: '222.000' } },
    });

    expect(jira.updateIssueField).toHaveBeenCalledTimes(1);
    expect(services.alerting.recordRateLimit).toHaveBeenCalled();
  });

  test('does not update Jira twice for the same event (deduplication)', async () => {
    const app = makeApp();
    const jira = makeJira();
    register(app, jira, config, makeServices());

    const payload = {
      event: { reaction: '+1', user: 'U123', item: { type: 'message', channel: 'C_WATCH', ts: '111.000' } },
      client: makeClient(REAL_MESSAGE),
      logger,
    };
    await app._trigger('reaction_added', payload);
    await app._trigger('reaction_added', payload);

    expect(jira.updateIssueField).toHaveBeenCalledTimes(1);
  });

  test('records a failed audit entry and calls alerting on Jira error', async () => {
    const app = makeApp();
    const jira = { updateIssueField: jest.fn().mockRejectedValue(new Error('Jira down')) };
    const services = makeServices();
    register(app, jira, config, services);

    await app._trigger('reaction_added', {
      event: { reaction: '+1', user: 'U123', item: { type: 'message', channel: 'C_WATCH', ts: '111.000' } },
      client: makeClient(REAL_MESSAGE),
      logger,
    });

    expect(services.auditLog.addEntry).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
    expect(services.alerting.recordError).toHaveBeenCalled();
  });

  test('does nothing for a non-thumbs-up reaction', async () => {
    const app = makeApp();
    const jira = makeJira();
    register(app, jira, config, makeServices());

    await app._trigger('reaction_added', {
      event: { reaction: 'heart', user: 'U123', item: { type: 'message', channel: 'C_WATCH', ts: '111.000' } },
      client: makeClient(REAL_MESSAGE),
      logger,
    });

    expect(jira.updateIssueField).not.toHaveBeenCalled();
  });

  test('does nothing if the channel does not match', async () => {
    const app = makeApp();
    const jira = makeJira();
    register(app, jira, config, makeServices());

    await app._trigger('reaction_added', {
      event: { reaction: '+1', user: 'U123', item: { type: 'message', channel: 'C_OTHER', ts: '111.000' } },
      client: makeClient(REAL_MESSAGE),
      logger,
    });

    expect(jira.updateIssueField).not.toHaveBeenCalled();
  });

  test('does nothing if the message has no Jira key', async () => {
    const app = makeApp();
    const jira = makeJira();
    register(app, jira, config, makeServices());

    await app._trigger('reaction_added', {
      event: { reaction: '+1', user: 'U123', item: { type: 'message', channel: 'C_WATCH', ts: '111.000' } },
      client: makeClient('Please take a look at this issue.'),
      logger,
    });

    expect(jira.updateIssueField).not.toHaveBeenCalled();
  });
});
