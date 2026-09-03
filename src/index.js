'use strict';

require('dotenv').config();

const { App } = require('@slack/bolt');
const JiraService = require('./services/jiraService');
const AttributionService = require('./services/attributionService');
const { registerReplyHandler } = require('./handlers/replyHandler');
const { registerReactionHandler } = require('./handlers/reactionHandler');
const { loadIntegrations } = require('./loadIntegrations');
const { loadSettings } = require('./loadSettings');
const DedupCache = require('./utils/dedupCache');
const RateLimiter = require('./utils/rateLimiter');
const AuditLog = require('./utils/auditLog');
const Alerting = require('./utils/alerting');
const UserCache = require('./utils/userCache');
const OAuthService = require('./services/oauthService');
const { startCallbackServer } = require('./server/callbackServer');
const { logger, boltLogger } = require('./utils/logger');

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
const integrations = loadIntegrations();

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

// OAuth impersonation — active only when JIRA_OAUTH_CLIENT_ID is set.
const oauthService = process.env.JIRA_OAUTH_CLIENT_ID
  ? new OAuthService({
    clientId: process.env.JIRA_OAUTH_CLIENT_ID,
    clientSecret: process.env.JIRA_OAUTH_CLIENT_SECRET,
    redirectUri: process.env.OAUTH_REDIRECT_URI,
    jiraBaseUrl: process.env.JIRA_BASE_URL,
  })
  : null;

// Alerting is initialised after app.start() so app.client is available.
// We declare it here and assign below.
let alerting;

const services = { dedupCache, rateLimiter, auditLog, userCache, oauthService, get alerting() { return alerting; } };

for (const integration of integrations) {
  const config = {
    name: integration.name,
    watchChannelId: integration.slackChannelId,
    allowedSlackUserIds: integration.allowedSlackUserIds || [],
    rateLimitPerHour: integration.rateLimitPerHour ?? settings.rateLimiting.defaultPerHour,
    jiraFieldId: integration.jiraFieldId,
    jiraFieldName: integration.jiraFieldName || integration.jiraFieldId,
    jiraFieldValue: integration.jiraFieldValue,
    jiraFieldType: integration.jiraFieldType || 'select',
  };

  if (integration.triggers.includes('reply')) {
    registerReplyHandler(app, jiraService, attributionService, config, services);
  }
  if (integration.triggers.includes('reaction')) {
    registerReactionHandler(app, jiraService, attributionService, config, services);
  }
}

(async () => {
  await app.start();

  alerting = new Alerting({
    client: app.client,
    channelId: settings.opsChannelId,
    errorThreshold: settings.alerting.errorThreshold,
    errorWindowMs: settings.alerting.errorWindowMinutes * 60 * 1000,
  });

  if (oauthService) {
    const oauthPort = parseInt(process.env.OAUTH_PORT || '3000', 10);
    startCallbackServer(oauthService, oauthPort, logger);
    logger.info({ redirectUri: process.env.OAUTH_REDIRECT_URI }, '[oauth] Impersonation enabled');
  }

  if (settings.dailySummary.enabled) {
    auditLog.scheduleDailySummary(app.client, settings.opsChannelId, settings.dailySummary.utcHour, logger);
  }

  logger.info({ opsChannel: settings.opsChannelId }, 'Slack-Jira integration bot started (Socket Mode)');
  for (const i of integrations) {
    logger.info(
      {
        integration: i.name,
        owner: i.owner,
        channel: i.slackChannelId,
        allowlist: i.allowedSlackUserIds?.length ? i.allowedSlackUserIds : 'open',
        rateLimit: `${i.rateLimitPerHour ?? settings.rateLimiting.defaultPerHour}/hour`,
        field: i.jiraFieldId,
        value: i.jiraFieldValue,
        triggers: i.triggers,
      },
      'Integration registered'
    );
  }
})();
