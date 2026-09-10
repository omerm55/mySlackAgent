'use strict';

require('dotenv').config();

const { App } = require('@slack/bolt');
const JiraService = require('./services/jiraService');
const AttributionService = require('./services/attributionService');
const { registerReplyHandler } = require('./handlers/replyHandler');
const { registerReactionHandler } = require('./handlers/reactionHandler');
const { registerTriggerHandler, registerJiraTriggerHandler } = require('./handlers/triggerHandler');
const JiraPoller = require('./services/jiraPoller');
const { DigestScheduler } = require('./services/digestScheduler');
const { registerPreferencesHandler } = require('./handlers/preferencesHandler');
const { loadIntegrations } = require('./loadIntegrations');
const { loadSettings } = require('./loadSettings');
const DedupCache = require('./utils/dedupCache');
const RateLimiter = require('./utils/rateLimiter');
const AuditLog = require('./utils/auditLog');
const Alerting = require('./utils/alerting');
const UserCache = require('./utils/userCache');
const OAuthService = require('./services/oauthService');
const DbService = require('./services/dbService');
const IntegrationCache = require('./services/integrationCache');
const LlmService = require('./services/llmService');
const { startCallbackServer } = require('./server/callbackServer');
const { registerDmHandler } = require('./handlers/dmHandler');
const { registerHomeHandler } = require('./handlers/homeHandler');
const { logger, boltLogger } = require('./utils/logger');
const OpsNotifier = require('./utils/opsNotifier');
const { startKeepAlive } = require('./utils/keepAlive');

const REQUIRED_VARS = [
  'SLACK_BOT_TOKEN',
  'SLACK_SIGNING_SECRET',
  'SLACK_APP_TOKEN',
  'JIRA_BASE_URL',
  'JIRA_USER_EMAIL',
  'JIRA_API_TOKEN',
];

const missing = REQUIRED_VARS.filter((v) => !process.env[v]);
if (missing.length > 0) {
  logger.error({ missing }, 'Missing required environment variables');
  process.exit(1);
}

const settings = loadSettings();
const staticIntegrations = loadIntegrations();

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
  logger: boltLogger,
});

const jiraService = new JiraService({
  baseUrl: process.env.JIRA_BASE_URL,
  email: process.env.JIRA_USER_EMAIL,
  apiToken: process.env.JIRA_API_TOKEN,
});

const attributionService = new AttributionService(jiraService);

const dedupCache = new DedupCache();
const rateLimiter = new RateLimiter();
const auditLog = new AuditLog();
const userCache = new UserCache();

const db = DbService.fromEnv();
auditLog.setDb(db); // persist per-user activity for the App Home

// OAuth impersonation — active only when JIRA_OAUTH_CLIENT_ID is set.
const oauthService = process.env.JIRA_OAUTH_CLIENT_ID
  ? new OAuthService({
    clientId: process.env.JIRA_OAUTH_CLIENT_ID,
    clientSecret: process.env.JIRA_OAUTH_CLIENT_SECRET,
    redirectUri: process.env.OAUTH_REDIRECT_URI,
    jiraBaseUrl: process.env.JIRA_BASE_URL,
    db,
  })
  : null;

// Normalize static integrations to the same shape as DB rows
const normalizedStatic = staticIntegrations.map((i) => ({
  id: null,
  name: i.name,
  slackChannelId: i.slackChannelId,
  triggers: i.triggers || [],
  jiraFieldId: i.jiraFieldId,
  jiraFieldName: i.jiraFieldName || i.jiraFieldId,
  jiraFieldValue: i.jiraFieldValue,
  jiraFieldType: i.jiraFieldType || 'select',
  allowedSlackUserIds: i.allowedSlackUserIds || [],
  rateLimitPerHour: i.rateLimitPerHour ?? settings.rateLimiting.defaultPerHour,
  allowBotFallback: i.allowBotFallback === true,
  scope: 'global',
  createdBy: null,
}));

const integrationCache = new IntegrationCache(db, normalizedStatic);

const llmService = LlmService.fromEnv();

// Alerting, opsNotifier and jiraPoller are initialised after app.start() so app.client is available.
let alerting;
let opsNotifier;
let jiraPoller;
let digestScheduler;

const services = {
  dedupCache, rateLimiter, auditLog, userCache, oauthService, llmService, attributionService,
  integrationCache, jiraService,
  db,
  get alerting() { return alerting; },
  get opsNotifier() { return opsNotifier; },
  get jiraPoller() { return jiraPoller; },
  get digestScheduler() { return digestScheduler; },
};

// Single generic handlers — each queries integrationCache at event time
registerReactionHandler(app, jiraService, attributionService, services);
registerReplyHandler(app, jiraService, attributionService, services);
registerDmHandler(app, jiraService, services);
registerHomeHandler(app, jiraService, services);
registerTriggerHandler(app, services);
registerJiraTriggerHandler(app, services);
registerPreferencesHandler(app, services);

(async () => {
  await app.start();

  alerting = new Alerting({
    client: app.client,
    channelId: settings.opsChannelId,
    errorThreshold: settings.alerting.errorThreshold,
    errorWindowMs: settings.alerting.errorWindowMinutes * 60 * 1000,
  });
  opsNotifier = new OpsNotifier(app.client, settings.opsChannelId, db);

  if (oauthService) {
    try {
      await oauthService.loadFromDb();
    } catch (err) {
      if (err.code === 'encryption_key_missing') {
        logger.error('oauth_tokens are encrypted but TOKEN_ENCRYPTION_KEY is not set — refusing to start (see PROJECT_SPEC §12.5)');
        process.exit(1);
      }
      throw err;
    }
    const oauthPort = parseInt(process.env.OAUTH_PORT || '3000', 10);
    startCallbackServer(oauthService, oauthPort, logger);
    logger.info({ redirectUri: process.env.OAUTH_REDIRECT_URI }, '[oauth] Impersonation enabled');
  }

  // Which Jira identity are we polling (and, where a trigger allows it, writing) as? A personal admin
  // account is easy to leave in Render by accident; say so plainly at boot and in the ops channel.
  jiraService.whoAmI()
    .then(async (me) => {
      const expected = (process.env.JIRA_SERVICE_ACCOUNT_EMAIL || '').trim().toLowerCase();
      const actual = (me.email || '').toLowerCase();
      const mismatch = expected && actual && expected !== actual;
      logger.info({ jiraAccount: me.displayName, jiraAccountId: me.accountId }, '[jira] Service identity');
      if (mismatch || !expected) {
        await opsNotifier?.post(
          `🔑 Jira service identity: *${me.displayName}*${me.email ? ` (${me.email})` : ''}` +
          (mismatch ? ` — ⚠️ expected *${expected}* (JIRA_SERVICE_ACCOUNT_EMAIL). Reads and any bot-account writes are made as this user.` : ' — set `JIRA_SERVICE_ACCOUNT_EMAIL` to the intended service account and I will flag a mismatch here.'),
          { kind: 'service_identity', detail: { displayName: me.displayName, accountId: me.accountId, expected: expected || null, mismatch: !!mismatch } },
        );
      }
    })
    .catch((err) => logger.warn(`[jira] Could not read the service identity: ${err.message}`));

  // Keep the (free-tier) Render instance from spinning down between Slack events.
  startKeepAlive({ logger });

  // Jira triggers: poll JQL conditions and DM the relevant person
  if (db) {
    // Tick cadence — the floor for per-trigger poll_interval_min (default 60s)
    const intervalSec = parseInt(process.env.JIRA_POLL_INTERVAL_SEC || '60', 10);
    jiraPoller = new JiraPoller({
      jiraService, db, slackClient: app.client, opsNotifier, oauthService, logger,
      intervalMs: intervalSec * 1000,
    });
    jiraPoller.start();

    // Deliver queued prompts to users who chose an hourly / daily digest
    digestScheduler = new DigestScheduler({
      db, slackClient: app.client, opsNotifier, oauthService, logger,
    });
    digestScheduler.start();
  }

  if (settings.dailySummary.enabled) {
    auditLog.scheduleDailySummary(app.client, settings.opsChannelId, settings.dailySummary.utcHour, logger);
  }

  logger.info({ opsChannel: settings.opsChannelId }, 'Slack-Jira integration bot started (Socket Mode)');
  const allIntegrations = await integrationCache.getAll();
  for (const i of allIntegrations) {
    logger.info(
      { integration: i.name, channel: i.slackChannelId, scope: i.scope, triggers: i.triggers },
      'Integration active',
    );
  }
})();
