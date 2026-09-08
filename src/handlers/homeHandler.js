'use strict';

const { canManage } = require('../utils/admins');

/**
 * Overflow menu (✏️ Edit / 🗑 Delete) for a trigger row.
 * @param {string} actionId  'trigger_menu' | 'jira_trigger_menu'
 * @param {string} id
 */
function manageMenu(actionId, id) {
  return {
    type: 'overflow',
    action_id: actionId,
    options: [
      { text: { type: 'plain_text', text: '✏️ Edit', emoji: true }, value: `edit:${id}` },
      { text: { type: 'plain_text', text: '🗑 Delete', emoji: true }, value: `delete:${id}` },
    ],
  };
}

/**
 * Build the full App Home block list for a user.
 * Shared by the app_home_opened handler and by trigger create/edit/delete
 * so the Home tab refreshes with real content, not a placeholder.
 */
async function buildHomeBlocks(userId, services, logger) {
  const { oauthService, auditLog, integrationCache } = services;

  const hasOAuth = oauthService?.hasToken(userId) ?? false;
  const authUrl = oauthService?.generateAuthUrl(userId);

  const allIntegrations = integrationCache ? await integrationCache.getAll() : [];
  const visibleIntegrations = allIntegrations.filter(
    (i) => i.scope !== 'personal' || i.createdBy === userId,
  );

  let jiraTriggers = [];
  if (services.db) {
    try {
      jiraTriggers = (await services.db.getActiveJiraTriggers())
        .filter((t) => t.scope !== 'personal' || t.created_by === userId);
    } catch (err) {
      logger?.warn(`[home] Could not load Jira triggers: ${err.message}`);
    }
  }

  const userEntries = (auditLog?.entries ?? [])
    .filter((e) => e.slackUserId === userId)
    .slice(-5)
    .reverse();

  return [
    // ── Header ───────────────────────────────────────────────
    { type: 'header', text: { type: 'plain_text', text: '🔗 Slack-Jira Bot', emoji: true } },
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

    // ── Channel triggers ─────────────────────────────────────
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '*Channel triggers*\n_React 👍 or reply in a thread on a Jira-linked message to update the issue._' },
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: '➕ Create Trigger', emoji: true },
        action_id: 'home_create_trigger',
      },
    },
    ...(visibleIntegrations.length > 0 ? visibleIntegrations.map((i) => {
      const triggerLabels = [];
      if (i.triggers?.includes('reaction')) triggerLabels.push('👍 reaction');
      if (i.triggers?.includes('reply')) triggerLabels.push('💬 thread reply');
      const scopeLabel = i.scope === 'personal' ? ' _(personal)_' : '';
      const block = {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${i.name}*${scopeLabel} — <#${i.slackChannelId}>\n_Triggers: ${triggerLabels.join(', ')} → sets *${i.jiraFieldName || i.jiraFieldId}* = *${i.jiraFieldValue}*_`,
        },
      };
      if (i.id && canManage(i.createdBy, userId)) block.accessory = manageMenu('trigger_menu', i.id);
      return block;
    }) : [{
      type: 'section',
      text: { type: 'mrkdwn', text: '_No channel triggers yet. Click *➕ Create Trigger* to set one up._' },
    }]),
    { type: 'divider' },

    // ── Jira triggers (JQL → DM) ─────────────────────────────
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '*Jira triggers*\n_Watch Jira with a JQL and DM the right person a Yes / No / Reply question._' },
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: '➕ Create Jira Trigger', emoji: true },
        action_id: 'home_create_jira_trigger',
      },
    },
    ...(jiraTriggers.length > 0 ? jiraTriggers.map((t) => {
      const action = t.action_type === 'transition'
        ? `move to *${t.transition_to}*`
        : `set *${t.jira_field_name || t.jira_field_id}* = *${t.jira_field_value}*`;
      const scopeLabel = t.scope === 'personal' ? ' _(personal)_' : '';
      const every = (() => {
        const m = Number(t.poll_interval_min) || 2;
        if (m >= 1440) return 'daily';
        if (m % 60 === 0) return m === 60 ? 'hourly' : `every ${m / 60}h`;
        return `every ${m}m`;
      })();
      const block = {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${t.name}*${scopeLabel} · ⏱ ${every}\n\`${t.jql}\`\n_DMs the ${t.notify} → on Yes: ${action}_`,
        },
      };
      if (canManage(t.created_by, userId)) block.accessory = manageMenu('jira_trigger_menu', t.id);
      return block;
    }) : [{
      type: 'section',
      text: { type: 'mrkdwn', text: '_No Jira triggers yet._' },
    }]),
    { type: 'divider' },

    // ── How it works ──────────────────────────────────────────
    { type: 'section', text: { type: 'mrkdwn', text: '*How it works*' } },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: '📨  *Bot-initiated DM questions*\nClick Yes/No or reply in free text — AI interprets your intent and updates Jira accordingly.' },
        { type: 'mrkdwn', text: '🔐  *OAuth impersonation*\nAfter connecting Jira above, all changes appear as you in the issue history — not the bot account.' },
      ],
    },
    { type: 'divider' },

    // ── Recent activity ───────────────────────────────────────
    { type: 'section', text: { type: 'mrkdwn', text: '*Your recent activity*' } },
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
}

/** Build and publish the Home tab for a user. Errors are logged, never thrown. */
async function publishHome(client, userId, services, logger) {
  try {
    const blocks = await buildHomeBlocks(userId, services, logger);
    await client.views.publish({ user_id: userId, view: { type: 'home', blocks } });
    logger?.info(`[home] Published home view for ${userId}`);
  } catch (err) {
    logger?.error(`[home] Failed to publish home view for ${userId}: ${err.message}`);
  }
}

function registerHomeHandler(app, jiraService, services) {
  app.event('app_home_opened', async ({ event, client, logger }) => {
    if (event.tab !== 'home') return;
    await publishHome(client, event.user, services, logger);
  });
}

module.exports = { registerHomeHandler, publishHome, buildHomeBlocks };
