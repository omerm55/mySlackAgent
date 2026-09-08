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
    const userId = body.user.id;
    const isAdmin = ADMIN_USER_IDS.has(userId);
    const v = view.state.values;

    const name = v.name_block.trigger_name.value?.trim();
    const manualChannelId = v.channel_id_block?.trigger_channel_id?.value?.trim();
    const channelId = manualChannelId || v.channel_block?.trigger_channel?.selected_conversation;
    const triggers = v.triggers_block.trigger_events.selected_options?.map((o) => o.value) ?? [];
    const jiraFieldId = v.field_id_block.jira_field_id.value?.trim();
    const jiraFieldName = v.field_name_block.jira_field_name.value?.trim() || jiraFieldId;
    const jiraFieldValue = v.field_value_block.jira_field_value.value?.trim();
    const scope = isAdmin
      ? (v.scope_block?.trigger_scope?.selected_option?.value ?? 'personal')
      : 'personal';

    // Inline validation — shown under the offending field in the modal
    const errors = {};
    if (!channelId) errors.channel_block = 'Pick a channel or paste a channel ID below.';
    if (manualChannelId && !/^[CG][A-Z0-9]{8,}$/.test(manualChannelId)) {
      errors.channel_id_block = 'That does not look like a Slack channel ID (should start with C or G).';
    }
    if (triggers.length === 0) errors.triggers_block = 'Select at least one trigger.';
    if (Object.keys(errors).length > 0) {
      await ack({ response_action: 'errors', errors });
      return;
    }
    await ack();

    const integration = {
      name,
      channel_id: channelId,
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

      // Make sure the bot is in the channel, otherwise it receives no events there.
      // conversations.join only works for public channels; private ones need an /invite.
      let joinNote = '';
      try {
        await client.conversations.join({ channel: channelId });
      } catch (joinErr) {
        logger.warn(`[trigger] Could not auto-join ${channelId}: ${joinErr.data?.error || joinErr.message}`);
        joinNote = `\n\n⚠️ I couldn't join <#${channelId}> automatically (it's probably private). Please run \`/invite @Slack-Jira Bot\` in that channel, otherwise I won't see reactions there.`;
      }

      // Refresh App Home so the new integration appears
      await client.views.publish({
        user_id: userId,
        view: { type: 'home', blocks: await buildRefreshBlocks() },
      }).catch(() => {});

      // DM the user a confirmation
      await client.chat.postMessage({
        channel: userId,
        text: `✅ Trigger *${name}* created! It will fire on ${triggers.map((t) => t === 'reaction' ? '👍 reactions' : '💬 thread replies').join(' and ')} in <#${channelId}>, setting *${jiraFieldName}* = *${jiraFieldValue}*.${joinNote}`,
      });
    } catch (err) {
      const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      logger.error(`[trigger] Failed to save integration: ${detail}`);
      await client.chat.postMessage({
        channel: userId,
        text: `❌ Failed to create trigger: ${detail}`,
      });
    }
  });
}

/**
 * Registers the "Create Jira Trigger" button + modal.
 * A Jira trigger polls a JQL and DMs the reporter/assignee a Yes/No/Reply question.
 */
function registerJiraTriggerHandler(app, services) {
  app.action('home_create_jira_trigger', async ({ ack, body, client, logger }) => {
    await ack();
    const isAdmin = ADMIN_USER_IDS.has(body.user.id);
    try {
      await client.views.open({ trigger_id: body.trigger_id, view: buildJiraTriggerModal(isAdmin) });
    } catch (err) {
      logger.error(`[jiraTrigger] Failed to open modal: ${err.message}`);
    }
  });

  app.view('create_jira_trigger_modal', async ({ ack, body, view, client, logger }) => {
    const userId = body.user.id;
    const isAdmin = ADMIN_USER_IDS.has(userId);
    const v = view.state.values;

    const name = v.jt_name.value.value?.trim();
    const jql = v.jt_jql.value.value?.trim();
    const question = v.jt_question.value.value?.trim();
    const notify = v.jt_notify.value.selected_option?.value || 'reporter';
    const actionType = v.jt_action.value.selected_option?.value || 'transition';
    const transitionTo = v.jt_transition?.value?.value?.trim();
    const fieldId = v.jt_field_id?.value?.value?.trim();
    const fieldName = v.jt_field_name?.value?.value?.trim();
    const fieldValue = v.jt_field_value?.value?.value?.trim();
    const scope = isAdmin ? (v.jt_scope?.value?.selected_option?.value ?? 'global') : 'personal';

    const errors = {};
    if (actionType === 'transition' && !transitionTo) errors.jt_transition = 'Enter the target status, e.g. Done.';
    if (actionType === 'field' && !fieldId) errors.jt_field_id = 'Enter the Jira field ID.';
    if (actionType === 'field' && !fieldValue) errors.jt_field_value = 'Enter the value to set.';
    if (!/\{key\}/.test(question || '')) errors.jt_question = 'Include {key} so the user knows which issue this is about.';

    // Validate the JQL against Jira before saving
    if (jql && Object.keys(errors).length === 0) {
      try {
        await services.jiraService.searchIssues(jql, ['summary'], 1);
      } catch (err) {
        errors.jt_jql = `Jira rejected this JQL: ${err.message}`.slice(0, 250);
      }
    }
    if (Object.keys(errors).length > 0) {
      await ack({ response_action: 'errors', errors });
      return;
    }
    await ack();

    const trigger = {
      name, jql, question, notify, scope,
      action_type: actionType,
      transition_to: actionType === 'transition' ? transitionTo : null,
      jira_field_id: actionType === 'field' ? fieldId : null,
      jira_field_name: actionType === 'field' ? (fieldName || fieldId) : null,
      jira_field_value: actionType === 'field' ? fieldValue : null,
      jira_field_type: 'select',
      created_by: userId,
      active: true,
    };

    try {
      if (!services.db) throw new Error('Supabase is not configured');
      await services.db.insertJiraTrigger(trigger);
      logger.info(`[jiraTrigger] Created "${name}" by ${userId} (scope: ${scope})`);
      const actionText = actionType === 'transition'
        ? `move the issue to *${transitionTo}*`
        : `set *${fieldName || fieldId}* = *${fieldValue}*`;
      await client.chat.postMessage({
        channel: userId,
        text: `✅ Jira trigger *${name}* created. Every few minutes I'll check \`${jql}\` and DM the *${notify}* of any new match. On *Yes* I'll ${actionText}.`,
      });
      // Kick off an immediate poll so the demo doesn't wait for the interval
      services.jiraPoller?.runOnce().catch(() => {});
    } catch (err) {
      const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      logger.error(`[jiraTrigger] Failed to save: ${detail}`);
      await client.chat.postMessage({ channel: userId, text: `❌ Failed to create Jira trigger: ${detail}` });
    }
  });
}

function buildJiraTriggerModal(isAdmin) {
  const input = (blockId, label, element, extra = {}) => ({
    type: 'input', block_id: blockId, label: { type: 'plain_text', text: label },
    element: { action_id: 'value', ...element }, ...extra,
  });
  const text = (placeholder, multiline = false) => ({
    type: 'plain_text_input', multiline, placeholder: { type: 'plain_text', text: placeholder },
  });
  const radios = (options, initial) => ({
    type: 'radio_buttons',
    options: options.map(([value, label]) => ({ text: { type: 'plain_text', text: label }, value })),
    initial_option: { text: { type: 'plain_text', text: options.find(([v]) => v === initial)[1] }, value: initial },
  });

  const blocks = [
    input('jt_name', 'Trigger name', text('e.g. Epic ready for PM acceptance')),
    input('jt_jql', 'JQL condition', text('issuetype = Epic AND status = Acceptance', true), {
      hint: { type: 'plain_text', text: 'Checked every few minutes. Each matching issue is asked about once.' },
    }),
    input('jt_question', 'Question to ask', text('All children of {key} ({summary}) are done. Approve and move to Done?', true), {
      hint: { type: 'plain_text', text: 'Placeholders: {key} {summary} {status} {reporter} {assignee}' },
    }),
    input('jt_notify', 'Who to DM', radios([['reporter', 'Reporter'], ['assignee', 'Assignee']], 'reporter')),
    input('jt_action', 'On "Yes", do this', radios([['transition', 'Move to a status'], ['field', 'Set a field']], 'transition')),
    input('jt_transition', 'Target status (for "Move to a status")', text('e.g. Done'), { optional: true }),
    input('jt_field_id', 'Jira field ID (for "Set a field")', text('e.g. customfield_11296'), { optional: true }),
    input('jt_field_name', 'Field display name (optional)', text('e.g. PM Reviewed'), { optional: true }),
    input('jt_field_value', 'Value to set (for "Set a field")', text('e.g. Yes'), { optional: true }),
  ];
  if (isAdmin) {
    blocks.push(input('jt_scope', 'Who does this apply to?', radios([['global', 'Anyone matched by the JQL'], ['personal', 'Only me (DM me only)']], 'global')));
  }

  return {
    type: 'modal',
    callback_id: 'create_jira_trigger_modal',
    title: { type: 'plain_text', text: 'Create Jira Trigger' },
    submit: { type: 'plain_text', text: 'Save' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks,
  };
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
      optional: true,
      element: {
        type: 'conversations_select',
        action_id: 'trigger_channel',
        placeholder: { type: 'plain_text', text: 'Select a channel (type to search)' },
        filter: { include: ['public', 'private'], exclude_bot_users: true },
      },
    },
    {
      type: 'input',
      block_id: 'channel_id_block',
      label: { type: 'plain_text', text: '…or paste a channel ID' },
      optional: true,
      element: { type: 'plain_text_input', action_id: 'trigger_channel_id', placeholder: { type: 'plain_text', text: 'e.g. C0123ABCDEF' } },
      hint: { type: 'plain_text', text: 'Use this if the channel does not appear in the picker. Right-click the channel → View channel details → copy the ID at the bottom.' },
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

module.exports = { registerTriggerHandler, registerJiraTriggerHandler };
