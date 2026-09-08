'use strict';

/**
 * Publishes the App Home view when a user opens it.
 *
 * Sections:
 *  1. Welcome + OAuth connection status
 *  2. How it works (what the bot does)
 *  3. Your recent activity (last 5 audit log entries for this user)
 *
 * @param {import('@slack/bolt').App} app
 * @param {import('../services/jiraService')} jiraService
 * @param {object} services
 */
function registerHomeHandler(app, jiraService, services) {

  app.event('app_home_opened', async ({ event, client, logger }) => {
    if (event.tab !== 'home') return;

    const userId = event.user;
    const { oauthService, auditLog } = services;

    try {
      // OAuth connection status
      const hasOAuth = oauthService?.hasToken(userId) ?? false;
      const authUrl = oauthService?.generateAuthUrl(userId);

      // Last 5 audit entries for this user
      const userEntries = (auditLog?.entries ?? [])
        .filter((e) => e.slackUserId === userId)
        .slice(-5)
        .reverse();

      const blocks = [
        // ── Header ───────────────────────────────────────────────
        {
          type: 'header',
          text: { type: 'plain_text', text: '🔗 Slack-Jira Bot', emoji: true },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: 'Automatically updates Jira issues from Slack reactions and thread replies — so your team never has to leave Slack to keep Jira in sync.',
          },
        },
        { type: 'divider' },

        // ── Jira connection status ────────────────────────────────
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: hasOAuth
              ? '✅  *Jira account connected*\nYour Jira changes will appear as you, not the bot.'
              : '🔌  *Jira account not connected*\nConnect your Jira account so updates appear under your name instead of the bot account.',
          },
          ...((!hasOAuth && authUrl) ? {
            accessory: {
              type: 'button',
              text: { type: 'plain_text', text: 'Connect Jira', emoji: true },
              style: 'primary',
              url: authUrl,
              action_id: 'home_connect_jira',
            },
          } : {}),
        },
        { type: 'divider' },

        // ── How it works ──────────────────────────────────────────
        {
          type: 'section',
          text: { type: 'mrkdwn', text: '*How it works*' },
        },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: '👍  *React with thumbs-up or ✅*\nUpdates the configured Jira field on the linked issue.' },
            { type: 'mrkdwn', text: '💬  *Reply in a Jira-linked thread*\nSame effect as a reaction — triggers the field update.' },
            { type: 'mrkdwn', text: '📨  *Respond to bot DM questions*\nClick Yes/No or reply in free text — AI interprets your intent.' },
            { type: 'mrkdwn', text: '🔐  *OAuth impersonation*\nAfter connecting Jira, all changes appear as you in the issue history.' },
          ],
        },
        { type: 'divider' },

        // ── Recent activity ───────────────────────────────────────
        {
          type: 'section',
          text: { type: 'mrkdwn', text: '*Your recent activity*' },
        },
        ...(userEntries.length === 0
          ? [{
              type: 'section',
              text: { type: 'mrkdwn', text: '_No activity recorded yet this session. React to a Jira-linked message to get started._' },
            }]
          : userEntries.map((e) => {
              const time = new Date(e.ts).toLocaleString('en-US', {
                month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
              });
              return {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: e.success
                    ? `✅  *${e.issueKey}*  ·  ${e.fieldName} = ${e.fieldValue}  ·  _${e.trigger}_  ·  ${time}`
                    : `❌  *${e.issueKey}*  ·  ${e.error}  ·  ${time}`,
                },
              };
            })
        ),
      ];

      await client.views.publish({
        user_id: userId,
        view: { type: 'home', blocks },
      });

      logger.info(`[home] Published home view for ${userId}`);
    } catch (err) {
      logger.error(`[home] Failed to publish home view for ${userId}: ${err.message}`);
    }
  });
}

module.exports = { registerHomeHandler };
