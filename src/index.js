'use strict';

require('dotenv').config();

const { App } = require('@slack/bolt');
const JiraService = require('./services/jiraService');
const { registerReplyHandler } = require('./handlers/replyHandler');
const { registerReactionHandler } = require('./handlers/reactionHandler');
const { loadIntegrations } = require('./loadIntegrations');
const DedupCache = require('./utils/dedupCache');

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
  console.error(`Missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

const integrations = loadIntegrations();
const dedupCache = new DedupCache();

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
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
  console.log('Slack-Jira integration bot is running (Socket Mode).');
  console.log(`Loaded ${integrations.length} integration(s):`);
  for (const i of integrations) {
    console.log(`  • [${i.name}] channel=${i.slackChannelId} field=${i.jiraFieldId} → "${i.jiraFieldValue}" triggers=[${i.triggers.join(', ')}]`);
  }
})();
