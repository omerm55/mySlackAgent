'use strict';

require('dotenv').config();

const { App } = require('@slack/bolt');
const JiraService = require('./services/jiraService');
const { registerReplyHandler } = require('./handlers/replyHandler');
const { registerReactionHandler } = require('./handlers/reactionHandler');
const { loadIntegrations } = require('./loadIntegrations');
const DedupCache = require('./utils/dedupCache');
const { logger, boltLogger } = require('./utils/logger');

// Validate required environment variables at startup.
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

const integrations = loadIntegrations();
const dedupCache = new DedupCache();

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

for (const integration of integrations) {
  const config = {
    name: integration.name,
    watchChannelId: integration.slackChannelId,
    jiraFieldId: integration.jiraFieldId,
    jiraFieldName: integration.jiraFieldName || integration.jiraFieldId,
    jiraFieldValue: integration.jiraFieldValue,
    jiraFieldType: integration.jiraFieldType || 'select',
  };

  if (integration.triggers.includes('reply')) {
    registerReplyHandler(app, jiraService, config, dedupCache);
  }
  if (integration.triggers.includes('reaction')) {
    registerReactionHandler(app, jiraService, config, dedupCache);
  }
}

(async () => {
  await app.start();
  logger.info('Slack-Jira integration bot started (Socket Mode)');
  for (const i of integrations) {
    logger.info(
      { integration: i.name, channel: i.slackChannelId, field: i.jiraFieldId, value: i.jiraFieldValue, triggers: i.triggers },
      'Integration registered'
    );
  }
})();
