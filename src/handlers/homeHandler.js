'use strict';

const { canManage, isAdmin } = require('../utils/admins');
const { FREQUENCIES } = require('../services/digestScheduler');

/**
 * Overflow menu (✏️ Edit / 🗑 Delete) for a trigger row.
 * @param {string} actionId  'trigger_menu' | 'jira_trigger_menu'
 * @param {string} id
 */
function manageMenu(actionId, id, extraOptions = []) {
  return {
    type: 'overflow',
    action_id: actionId,
    options: [
      { text: { type: 'plain_text', text: '✏️ Edit', emoji: true }, value: `edit:${id}` },
      ...extraOptions.map(([value, label]) => ({ text: { type: 'plain_text', text: label, emoji: true }, value: `${value}:${id}` })),
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
  // Trigger management is an admin surface; everyone else gets connection, notifications, activity.
  const admin = isAdmin(userId);

  const hasOAuth = oauthService?.hasToken(userId) ?? false;
  const authUrl = (!hasOAuth && oauthService) ? await oauthService.generateAuthUrl(userId) : null;

  let visibleIntegrations = [];
  let jiraTriggers = [];
  if (admin) {
    const allIntegrations = integrationCache ? await integrationCache.getAll() : [];
    visibleIntegrations = allIntegrations.filter((i) => i.scope !== 'personal' || i.createdBy === userId);
    if (services.db) {
      try {
        jiraTriggers = (await services.db.getActiveJiraTriggers())
          .filter((t) => t.scope !== 'personal' || t.created_by === userId);
      } catch (err) {
        logger?.warn(`[home] Could not load Jira triggers: ${err.message}`);
      }
    }
  }

  // Persistent per-user history when Supabase is configured; in-memory otherwise
  let userEntries = [];
  try {
    userEntries = auditLog?.recentFor
      ? await auditLog.recentFor(userId, 5)
      : (auditLog?.entries ?? []).filter((e) => e.slackUserId === userId).slice(-5).reverse();
  } catch (err) {
    logger?.warn(`[home] Could not load recent activity: ${err.message}`);
  }

  // Notification preference + how many prompts are waiting in the next digest
  let frequency = 'immediate';
  let pendingCount = 0;
  if (services.db) {
    try {
      const pref = await services.db.getUserPreference(userId);
      if (pref?.digest_frequency && FREQUENCIES[pref.digest_frequency]) frequency = pref.digest_frequency;
      if (frequency !== 'immediate') pendingCount = (await services.db.getPendingPrompts(userId)).length;
    } catch (err) {
      logger?.warn(`[home] Could not load preferences: ${err.message}`);
    }
  }
  const freqOptions = Object.entries(FREQUENCIES).map(([value, { label }]) => ({
    text: { type: 'plain_text', text: label, emoji: true }, value,
  }));

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
      ...((hasOAuth && oauthService) ? {
        accessory: {
          type: 'button',
          text: { type: 'plain_text', text: 'Disconnect', emoji: true },
          action_id: 'home_disconnect_jira',
          value: userId,
        },
      } : {}),
    },
    { type: 'divider' },

    // ── Notifications ────────────────────────────────────────
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `🔔  *Notifications*\nHow often should I DM you with questions?${
          frequency !== 'immediate' && pendingCount > 0
            ? `\n_${pendingCount} question${pendingCount === 1 ? '' : 's'} waiting for your next digest._`
            : ''
        }`,
      },
      accessory: {
        type: 'static_select',
        action_id: 'home_set_digest',
        options: freqOptions,
        initial_option: freqOptions.find((o) => o.value === frequency),
      },
    },
    { type: 'divider' },

    // ── Admin only: trigger management ───────────────────────
    ...(admin ? [
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
      const who = t.notify === 'user_field' ? `user in \`${t.notify_field_id}\`` : t.notify;
      const fyiField = t.fyi_field_id || (t.ask_type === 'risk_review' ? 'customfield_11909' : null);
      const action = t.ask_type === 'risk_review'
        ? `🩺 risk review (status / Notes / target)${t.watch_field ? `, re-asks when \`${t.watch_field}\` changes` : ''}${fyiField ? `, FYI → \`${fyiField}\`` : ''}`
        : t.ask_type === 'collect'
        ? `📝 collect: *${(t.collect_fields || []).map((f) => f.name).join(', ') || 'no fields'}* (free text → AI → preview → save)${fyiField ? `, FYI → \`${fyiField}\`` : ''}`
        : (t.action_type === 'transition'
          ? `on Yes: move to *${t.transition_to}*`
          : `on Yes: set *${t.jira_field_name || t.jira_field_id}* = *${t.jira_field_value}*`);
      const pilot = Array.isArray(t.pilot_slack_user_ids) && t.pilot_slack_user_ids.length
        ? ` _(🧪 pilot: ${t.pilot_slack_user_ids.map((u) => `<@${u}>`).join(', ')})_` : '';
      const scopeLabel = (t.scope === 'personal' ? ' _(personal)_' : '') + pilot;
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
          text: `*${t.name}*${scopeLabel} · ⏱ ${every}\n\`${t.jql}\`\n_DMs the ${who} → ${action}_`,
        },
      };
      if (canManage(t.created_by, userId)) {
        block.accessory = manageMenu('jira_trigger_menu', t.id, [
          ['run', '▶️ Run now'],
          ['reask', '🔁 Re-ask open matches'],
        ]);
      }
      return block;
    }) : [{
      type: 'section',
      text: { type: 'mrkdwn', text: '_No Jira triggers yet._' },
    }]),
    { type: 'divider' },
    ] : []),

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
          text: { type: 'mrkdwn', text: '_No activity yet. It fills in as you react to Jira-linked messages or answer the bot\'s questions._' },
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

  // Disconnect Jira: confirm, then forget the user's tokens (they can reconnect any time).
  app.action('home_disconnect_jira', async ({ ack, body, client, logger }) => {
    await ack();
    try {
      await client.views.open({
        trigger_id: body.trigger_id,
        view: {
          type: 'modal', callback_id: 'home_disconnect_jira_modal',
          title: { type: 'plain_text', text: 'Disconnect Jira?' },
          submit: { type: 'plain_text', text: 'Disconnect' },
          close: { type: 'plain_text', text: 'Cancel' },
          blocks: [
            { type: 'section', text: { type: 'mrkdwn', text: 'I will forget your Jira connection. Until you connect again, actions you take here cannot be made under your name.\n\nTo also revoke the app on Atlassian\'s side, open <https://id.atlassian.com/manage-profile/apps|id.atlassian.com → Connected apps>.' } },
          ],
        },
      });
    } catch (err) {
      logger.error(`[home] Failed to open disconnect modal: ${err.data?.error || err.message}`);
    }
  });

  app.view('home_disconnect_jira_modal', async ({ ack, body, client, logger }) => {
    await ack();
    const userId = body.user.id;
    try {
      await services.oauthService?.disconnect(userId);
      await client.chat.postMessage({ channel: userId, text: '🔌 Jira disconnected. Press *Connect Jira* in my Home tab whenever you want to reconnect. To revoke the app on Atlassian\'s side too: https://id.atlassian.com/manage-profile/apps' }).catch(() => {});
      await services.opsNotifier?.post?.(`🔌 <@${userId}> disconnected their Jira account`);
      logger.info(`[home] ${userId} disconnected Jira`);
    } catch (err) {
      logger.error(`[home] Disconnect failed for ${userId}: ${err.message}`);
      await client.chat.postMessage({ channel: userId, text: `❌ Couldn't disconnect: ${err.message}` }).catch(() => {});
    }
    await publishHome(client, userId, services, logger);
  });
}

module.exports = { registerHomeHandler, publishHome, buildHomeBlocks };
