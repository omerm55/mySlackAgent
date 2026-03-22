'use strict';

require('dotenv').config();

const { App } = require('@slack/bolt');
const JiraService = require('./services/jiraService');
const { registerReplyHandler } = require('./handlers/replyHandler');
const { registerReactionHandler } = require('./handlers/reactionHandler');

// Validate required environment variables at startup.
const REQUIRED_VARS = [
  'SLACK_BOT_TOKEN',
  'SLACK_SIGNING_SECRET',
  'SLACK_APP_TOKEN',
  'SLACK_WATCH_CHANNEL_ID',
  'JIRA_BASE_URL',
  'JIRA_USER_EMAIL',
  'JIRA_API_TOKEN',
  'JIRA_FIELD_ID',
  'JIRA_FIELD_VALUE',
];

const missing = REQUIRED_VARS.filter((v) => !process.env[v]);
if (missing.length > 0) {
  console.error(`Missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,            // Uses WebSocket — no public URL needed
  appToken: process.env.SLACK_APP_TOKEN,
});

const jiraService = new JiraService({
  baseUrl: process.env.JIRA_BASE_URL,
  email: process.env.JIRA_USER_EMAIL,
  apiToken: process.env.JIRA_API_TOKEN,
});

const integrationConfig = {
  watchChannelId: process.env.SLACK_WATCH_CHANNEL_ID,
  jiraFieldId: process.env.JIRA_FIELD_ID,
  jiraFieldValue: process.env.JIRA_FIELD_VALUE,
  jiraFieldType: process.env.JIRA_FIELD_TYPE || 'select',
};

registerReplyHandler(app, jiraService, integrationConfig);
registerReactionHandler(app, jiraService, integrationConfig);

(async () => {
  await app.start();
  console.log('Slack-Jira integration bot is running (Socket Mode).');
  console.log(`Watching channel: ${process.env.SLACK_WATCH_CHANNEL_ID}`);
  console.log(`On reply → set "${process.env.JIRA_FIELD_ID}" = "${process.env.JIRA_FIELD_VALUE}"`);
})();
