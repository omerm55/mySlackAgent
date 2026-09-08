'use strict';

const ADMIN_USER_IDS = new Set(
  (process.env.ADMIN_SLACK_USER_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
);

/**
 * Registers the "Create Trigger" button action and modal submission handler.
 *
 * App Home "➕ Create Trigger" button → action home_create_trigger
 *   → opens create_trigger_modal
 *   → on submit: save to Supabase, invalidate integrationCache, refresh Home
 */
function registerTriggerHandler(app, services) {
  const { integrationCache } = services;

  // Open the modal when the button is clicked
  app.action('home_create_trigger', async ({ ack, body, client, logger }) => {
    await ack();
    const userId = body.user.id;
    const isAdmin = ADMIN_USER_IDS.has(userId);

    try {
      await client.views.open({
        trigger_id: body.trigger_id,
        view: buildCreateModal(isAdmin),
      });
    } catch (err) {
      logger.error(`[trigger] Failed to open modal: ${err.message}`);
    }
  });

  // Handle modal submission
  app.view('create_trigger_modal', async ({ ack, body, view, client, logger }) => {
    await ack();
    const userId = body.user.id;
    const isAdmin = ADMIN_USER_IDS.has(userId);
    const v = view.state.values;

    const name = v.name_block.trigger_name.value?.trim();
    const channelId = v.channel_block.trigger_channel.selected_channel;
    const triggers = v.triggers_block.trigger_events.selected_options?.map((o) => o.value) ?? [];
    const jiraFieldId = v.field_id_block.jira_field_id.value?.trim();
    const jiraFieldName = v.field_name_block.jira_field_name.value?.trim() || jiraFieldId;
    const jiraFieldValue = v.field_value_block.jira_field_value.value?.trim();
    const scope = isAdmin
      ? (v.scope_block?.trigger_scope?.selected_option?.value ?? 'personal')
      : 'personal';

    if (!name || !channelId || triggers.length === 0 || !jiraFieldId || !jiraFieldValue) {
      logger.warn('[trigger] Modal submitted with missing fields');
      return;
    }

    const integration = {
      name,
      slack_channel_id: channelId,
      triggers,
      jira_field_id: jiraFieldId,
      jira_field_name: jiraFieldName,
      jira_field_value: jiraFieldValue,
      jira_field_type: 'select',
      scope,
      created_by: userId,
      active: true,
    };

    try {
      if (services.db) {
        await services.db.upsertIntegration(integration);
      }
      integrationCache.invalidate();
      logger.info(`[trigger] Created integration "${name}" by ${userId} (scope: ${scope})`);

      // Refresh App Home so the new integration appears
      await client.views.publish({
        user_id: userId,
        view: { type: 'home', blocks: await buildRefreshBlocks() },
      }).catch(() => {});

      // DM the user a confirmation
      await client.chat.postMessage({
        channel: userId,
        text: `✅ Trigger *${name}* created! It will fire on ${triggers.map((t) => t === 'reaction' ? '👍 reactions' : '💬 thread replies').join(' and ')} in <#${channelId}>, setting *${jiraFieldName}* = *${jiraFieldValue}*.`,
      });
    } catch (err) {
      logger.error(`[trigger] Failed to save integration: ${err.message}`);
      await client.chat.postMessage({
        channel: userId,
        text: `❌ Failed to create trigger: ${err.message}`,
      });
    }
  });
}

function buildCreateModal(isAdmin) {
  const blocks = [
    {
      type: 'input',
      block_id: 'name_block',
      label: { type: 'plain_text', text: 'Trigger name' },
      element: { type: 'plain_text_input', action_id: 'trigger_name', placeholder: { type: 'plain_text', text: 'e.g. PM Reviewed — Product Bugs' } },
    },
    {
      type: 'input',
      block_id: 'channel_block',
      label: { type: 'plain_text', text: 'Slack channel to watch' },
      element: { type: 'channels_select', action_id: 'trigger_channel', placeholder: { type: 'plain_text', text: 'Select a channel' } },
    },
    {
      type: 'input',
      block_id: 'triggers_block',
      label: { type: 'plain_text', text: 'Trigger on' },
      element: {
        type: 'checkboxes',
        action_id: 'trigger_events',
        options: [
          { text: { type: 'plain_text', text: '👍 Reaction (thumbs up / ✅)' }, value: 'reaction' },
          { text: { type: 'plain_text', text: '💬 Thread reply' }, value: 'reply' },
        ],
      },
    },
    {
      type: 'input',
      block_id: 'field_id_block',
      label: { type: 'plain_text', text: 'Jira field ID' },
      element: { type: 'plain_text_input', action_id: 'jira_field_id', placeholder: { type: 'plain_text', text: 'e.g. customfield_11296' } },
      hint: { type: 'plain_text', text: 'Find this in Jira project settings → Fields, or ask your Jira admin.' },
    },
    {
      type: 'input',
      block_id: 'field_name_block',
      label: { type: 'plain_text', text: 'Field display name (optional)' },
      optional: true,
      element: { type: 'plain_text_input', action_id: 'jira_field_name', placeholder: { type: 'plain_text', text: 'e.g. PM Reviewed' } },
    },
    {
      type: 'input',
      block_id: 'field_value_block',
      label: { type: 'plain_text', text: 'Value to set' },
      element: { type: 'plain_text_input', action_id: 'jira_field_value', placeholder: { type: 'plain_text', text: 'e.g. Yes' } },
    },
  ];

  if (isAdmin) {
    blocks.push({
      type: 'input',
      block_id: 'scope_block',
      label: { type: 'plain_text', text: 'Who does this trigger apply to?' },
      element: {
        type: 'radio_buttons',
        action_id: 'trigger_scope',
        options: [
          { text: { type: 'plain_text', text: 'Everyone in the channel' }, value: 'global' },
          { text: { type: 'plain_text', text: 'Only me' }, value: 'personal' },
        ],
        initial_option: { text: { type: 'plain_text', text: 'Everyone in the channel' }, value: 'global' },
      },
    });
  }

  return {
    type: 'modal',
    callback_id: 'create_trigger_modal',
    title: { type: 'plain_text', text: 'Create Trigger' },
    submit: { type: 'plain_text', text: 'Save' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks,
  };
}

// Minimal placeholder while the real home rebuilds via app_home_opened
async function buildRefreshBlocks() {
  return [
    { type: 'header', text: { type: 'plain_text', text: '🔗 Slack-Jira Bot', emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text: '✅ Trigger saved! Click *Home* to refresh and see your new trigger.' } },
  ];
}

module.exports = { registerTriggerHandler };
