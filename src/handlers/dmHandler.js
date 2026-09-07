'use strict';

/**
 * Handles interactive button responses to bot-initiated DM questions.
 * Uses block_actions (app.action) instead of message.im replies so the
 * user clicks Yes/No rather than typing — works even when messaging the
 * bot is disabled in the workspace.
 *
 * @param {import('@slack/bolt').App} app
 * @param {import('../services/jiraService')} jiraService
 * @param {object} services
 * @param {import('../services/oauthService')} [services.oauthService]
 */
function registerDmHandler(app, jiraService, services) {
  app.action('jira_confirm_yes', async ({ ack, body, client, logger }) => {
    await ack();
    let context;
    try {
      context = JSON.parse(body.actions[0].value);
    } catch {
      logger.error('[dm] Could not parse button context');
      return;
    }

    const { issueKey, jiraFieldId, jiraFieldName, jiraFieldValue, jiraFieldType, slackUserId } = context;
    const channelId = body.channel?.id;
    const messageTs = body.message?.ts;

    // Remove buttons immediately so double-clicks are harmless
    if (channelId && messageTs) {
      await client.chat.update({
        channel: channelId,
        ts: messageTs,
        text: `*${issueKey}*: ${body.message.text}`,
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: `*${issueKey}*: ${body.message.text}` } },
          { type: 'section', text: { type: 'mrkdwn', text: '_Processing…_' } },
        ],
      }).catch(() => {});
    }

    // Resolve OAuth or fall back to service account
    let effectiveJira = jiraService;
    const { oauthService } = services;
    if (oauthService && slackUserId) {
      if (oauthService.hasToken(slackUserId)) {
        try {
          effectiveJira = await oauthService.getJiraService(slackUserId);
        } catch {
          effectiveJira = jiraService;
        }
      }
    }

    try {
      await effectiveJira.updateIssueField(issueKey, jiraFieldId, jiraFieldValue, jiraFieldType || 'select');
      logger.info(`[dm] Updated ${issueKey} ${jiraFieldId}=${jiraFieldValue} ✓`);
      if (channelId && messageTs) {
        await client.chat.update({
          channel: channelId,
          ts: messageTs,
          text: `✅ Done — *${issueKey}* updated: *${jiraFieldName}* = *${jiraFieldValue}*`,
          blocks: [
            {
              type: 'section',
              text: { type: 'mrkdwn', text: `✅ Done — *${issueKey}* updated: *${jiraFieldName}* = *${jiraFieldValue}*` },
            },
          ],
        });
      }
    } catch (err) {
      logger.error(`[dm] Failed to update ${issueKey}: ${err.message}`);
      if (channelId && messageTs) {
        await client.chat.update({
          channel: channelId,
          ts: messageTs,
          text: `❌ Failed to update *${issueKey}*: ${err.message}`,
          blocks: [
            {
              type: 'section',
              text: { type: 'mrkdwn', text: `❌ Failed to update *${issueKey}*: ${err.message}` },
            },
          ],
        });
      }
    }
  });

  app.action('jira_confirm_no', async ({ ack, body, client, logger }) => {
    await ack();
    let context;
    try {
      context = JSON.parse(body.actions[0].value);
    } catch {
      logger.error('[dm] Could not parse button context');
      return;
    }

    const { issueKey } = context;
    const channelId = body.channel?.id;
    const messageTs = body.message?.ts;

    logger.info(`[dm] User declined update for ${issueKey}`);

    if (channelId && messageTs) {
      await client.chat.update({
        channel: channelId,
        ts: messageTs,
        text: `OK, no changes made to *${issueKey}*.`,
        blocks: [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: `OK, no changes made to *${issueKey}*.` },
          },
        ],
      });
    }
  });
}

module.exports = { registerDmHandler };
