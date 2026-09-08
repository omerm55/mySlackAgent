'use strict';

const { isAdmin, canManage } = require('../utils/admins');
const { publishHome } = require('./homeHandler');

// ─────────────────────────────────────────────────────────────────────────────
// Block Kit helpers
// ─────────────────────────────────────────────────────────────────────────────

const plain = (text) => ({ type: 'plain_text', text, emoji: true });

function input(blockId, label, element, extra = {}) {
  return { type: 'input', block_id: blockId, label: plain(label), element: { action_id: 'value', ...element }, ...extra };
}

function textInput(placeholder, { multiline = false, initial } = {}) {
  const el = { type: 'plain_text_input', multiline, placeholder: plain(placeholder) };
  if (typeof initial === 'string' && initial.length > 0) el.initial_value = initial;
  return el;
}

function radios(options, initial) {
  const opts = options.map(([value, label]) => ({ text: plain(label), value }));
  const el = { type: 'radio_buttons', options: opts };
  const init = opts.find((o) => o.value === initial);
  if (init) el.initial_option = init;
  return el;
}

function checkboxes(options, initialValues = []) {
  const opts = options.map(([value, label]) => ({ text: plain(label), value }));
  const el = { type: 'checkboxes', options: opts };
  const init = opts.filter((o) => initialValues.includes(o.value));
  if (init.length > 0) el.initial_options = init;
  return el;
}

const POLL_INTERVALS = [
  [2, 'Every 2 minutes'], [5, 'Every 5 minutes'], [15, 'Every 15 minutes'], [30, 'Every 30 minutes'],
  [60, 'Every hour'], [240, 'Every 4 hours'], [1440, 'Once a day'],
];

function pollIntervalSelect(initialMin) {
  const list = POLL_INTERVALS.some(([m]) => m === initialMin) || !initialMin
    ? POLL_INTERVALS
    : [...POLL_INTERVALS, [initialMin, `Every ${initialMin} minutes`]].sort((a, b) => a[0] - b[0]);
  const opts = list.map(([m, label]) => ({ text: plain(label), value: String(m) }));
  const el = { type: 'static_select', options: opts, placeholder: plain('How often to check') };
  const init = opts.find((o) => o.value === String(initialMin ?? 2));
  if (init) el.initial_option = init;
  return el;
}

function describeInterval(min) {
  const m = Number(min) || 2;
  const known = POLL_INTERVALS.find(([v]) => v === m);
  if (known) return known[1].toLowerCase();
  return m % 60 === 0 ? `every ${m / 60} hours` : `every ${m} minutes`;
}

function parseMenu(body) {
  const value = body.actions?.[0]?.selected_option?.value || '';
  const [op, id] = value.split(':');
  return { op, id };
}

function errDetail(err) {
  return err.response?.data ? JSON.stringify(err.response.data) : err.message;
}

// ─────────────────────────────────────────────────────────────────────────────
// Channel triggers (reaction / reply → set a Jira field)
// ─────────────────────────────────────────────────────────────────────────────

function buildChannelTriggerModal(admin, existing = null) {
  const blocks = [
    input('name_block', 'Trigger name', textInput('e.g. PM Reviewed — Product Bugs', { initial: existing?.name })),
    input('channel_block', 'Slack channel to watch', {
      type: 'conversations_select',
      placeholder: plain('Select a channel (type to search)'),
      filter: { include: ['public', 'private'], exclude_bot_users: true },
      ...(existing?.slackChannelId ? { initial_conversation: existing.slackChannelId } : {}),
    }, { optional: true }),
    input('channel_id_block', '…or paste a channel ID', textInput('e.g. C0123ABCDEF'), {
      optional: true,
      hint: plain('Use this if the channel does not appear in the picker. Channel details → copy the ID at the bottom.'),
    }),
    input('triggers_block', 'Trigger on', checkboxes(
      [['reaction', '👍 Reaction (thumbs up / ✅)'], ['reply', '💬 Thread reply']],
      existing?.triggers ?? [],
    )),
    input('field_id_block', 'Jira field ID', textInput('e.g. customfield_11296', { initial: existing?.jiraFieldId }), {
      hint: plain('Find this in Jira project settings → Fields, or ask your Jira admin.'),
    }),
    input('field_name_block', 'Field display name (optional)', textInput('e.g. PM Reviewed', { initial: existing?.jiraFieldName }), { optional: true }),
    input('field_value_block', 'Value to set', textInput('e.g. Yes', { initial: existing?.jiraFieldValue })),
  ];
  if (admin) {
    blocks.push(input('scope_block', 'Who does this trigger apply to?', radios(
      [['global', 'Everyone in the channel'], ['personal', 'Only me']],
      existing?.scope ?? 'global',
    )));
  }
  return {
    type: 'modal',
    callback_id: 'create_trigger_modal',
    private_metadata: JSON.stringify({ id: existing?.id ?? null }),
    title: plain(existing ? 'Edit Trigger' : 'Create Trigger'),
    submit: plain('Save'),
    close: plain('Cancel'),
    blocks,
  };
}

function registerTriggerHandler(app, services) {
  const { integrationCache } = services;

  app.action('home_create_trigger', async ({ ack, body, client, logger }) => {
    await ack();
    try {
      await client.views.open({ trigger_id: body.trigger_id, view: buildChannelTriggerModal(isAdmin(body.user.id)) });
    } catch (err) {
      logger.error(`[trigger] Failed to open modal: ${err.message}`);
    }
  });

  // ✏️ Edit / 🗑 Delete from the Home tab overflow menu
  app.action('trigger_menu', async ({ ack, body, client, logger }) => {
    await ack();
    const userId = body.user.id;
    const { op, id } = parseMenu(body);
    const all = await integrationCache.getAll();
    const existing = all.find((i) => i.id === id);
    if (!existing || !canManage(existing.createdBy, userId)) {
      await client.chat.postMessage({ channel: userId, text: '🚫 You can only edit or delete triggers you created.' }).catch(() => {});
      return;
    }

    if (op === 'edit') {
      try {
        await client.views.open({ trigger_id: body.trigger_id, view: buildChannelTriggerModal(isAdmin(userId), existing) });
      } catch (err) {
        logger.error(`[trigger] Failed to open edit modal: ${err.message}`);
      }
      return;
    }

    if (op === 'delete') {
      try {
        await services.db.deactivateIntegration(id);
        integrationCache.invalidate();
        logger.info(`[trigger] Deleted integration "${existing.name}" (${id}) by ${userId}`);
        await publishHome(client, userId, services, logger);
        await client.chat.postMessage({ channel: userId, text: `🗑 Trigger *${existing.name}* deleted.` });
      } catch (err) {
        logger.error(`[trigger] Failed to delete ${id}: ${errDetail(err)}`);
        await client.chat.postMessage({ channel: userId, text: `❌ Failed to delete trigger: ${errDetail(err)}` });
      }
    }
  });

  app.view('create_trigger_modal', async ({ ack, body, view, client, logger }) => {
    const userId = body.user.id;
    const admin = isAdmin(userId);
    const v = view.state.values;
    let editId = null;
    try { editId = JSON.parse(view.private_metadata || '{}').id || null; } catch { /* create */ }

    const name = v.name_block.value.value?.trim();
    const manualChannelId = v.channel_id_block?.value?.value?.trim();
    const channelId = manualChannelId || v.channel_block?.value?.selected_conversation;
    const triggers = v.triggers_block.value.selected_options?.map((o) => o.value) ?? [];
    const jiraFieldId = v.field_id_block.value.value?.trim();
    const jiraFieldName = v.field_name_block.value.value?.trim() || jiraFieldId;
    const jiraFieldValue = v.field_value_block.value.value?.trim();

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

    // Scope: admins choose; non-admins keep the existing scope on edit, personal on create
    let existing = null;
    if (editId) existing = (await integrationCache.getAll()).find((i) => i.id === editId) || null;
    if (editId && (!existing || !canManage(existing.createdBy, userId))) {
      await client.chat.postMessage({ channel: userId, text: '🚫 You can only edit triggers you created.' }).catch(() => {});
      return;
    }
    const scope = admin
      ? (v.scope_block?.value?.selected_option?.value ?? existing?.scope ?? 'global')
      : (existing?.scope ?? 'personal');

    const fields = {
      name,
      channel_id: channelId,
      triggers,
      jira_field_id: jiraFieldId,
      jira_field_name: jiraFieldName,
      jira_field_value: jiraFieldValue,
      jira_field_type: 'select',
      scope,
    };

    try {
      if (!services.db) throw new Error('Supabase is not configured');
      if (editId) {
        await services.db.updateIntegration(editId, fields);
        logger.info(`[trigger] Updated integration "${name}" (${editId}) by ${userId}`);
      } else {
        await services.db.upsertIntegration({ ...fields, created_by: userId, active: true });
        logger.info(`[trigger] Created integration "${name}" by ${userId} (scope: ${scope})`);
      }
      integrationCache.invalidate();

      // Make sure the bot is in the channel; private channels need a manual /invite.
      let joinNote = '';
      try {
        await client.conversations.join({ channel: channelId });
      } catch (joinErr) {
        const code = joinErr.data?.error || joinErr.message;
        if (code !== 'already_in_channel') {
          logger.warn(`[trigger] Could not auto-join ${channelId}: ${code}`);
          joinNote = `\n\n⚠️ I couldn't join <#${channelId}> automatically (it's probably private). Please run \`/invite @Slack-Jira Bot\` there, otherwise I won't see reactions.`;
        }
      }

      await publishHome(client, userId, services, logger);

      const when = triggers.map((t) => (t === 'reaction' ? '👍 reactions' : '💬 thread replies')).join(' and ');
      await client.chat.postMessage({
        channel: userId,
        text: `✅ Trigger *${name}* ${editId ? 'updated' : 'created'}! It fires on ${when} in <#${channelId}>, setting *${jiraFieldName}* = *${jiraFieldValue}*.${joinNote}`,
      });
    } catch (err) {
      logger.error(`[trigger] Failed to save integration: ${errDetail(err)}`);
      await client.chat.postMessage({ channel: userId, text: `❌ Failed to save trigger: ${errDetail(err)}` });
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Jira triggers (JQL poll → DM the reporter/assignee → transition or set field)
// ─────────────────────────────────────────────────────────────────────────────

function buildJiraTriggerModal(admin, existing = null) {
  const blocks = [
    input('jt_name', 'Trigger name', textInput('e.g. Epic ready for PM acceptance', { initial: existing?.name })),
    input('jt_jql', 'JQL condition', textInput('issuetype = Epic AND status = Acceptance', { multiline: true, initial: existing?.jql }), {
      hint: plain('Checked every few minutes. Each matching issue is asked about once.'),
    }),
    input('jt_interval', 'Check Jira', pollIntervalSelect(existing?.poll_interval_min), {
      hint: plain('Pick a slower cadence for conditions that change rarely, to keep Jira API usage low.'),
    }),
    input('jt_question', 'Question to ask', textInput('All children of {key} ({summary}) are done. Approve and move to Done?', { multiline: true, initial: existing?.question }), {
      hint: plain('Placeholders: {key} {summary} {status} {reporter} {assignee}'),
    }),
    input('jt_notify', 'Who to DM', radios([['reporter', 'Reporter'], ['assignee', 'Assignee']], existing?.notify ?? 'reporter')),
    input('jt_action', 'On "Yes", do this', radios([['transition', 'Move to a status'], ['field', 'Set a field']], existing?.action_type ?? 'transition')),
    input('jt_transition', 'Target status (for "Move to a status")', textInput('e.g. Done', { initial: existing?.transition_to }), { optional: true }),
    input('jt_field_id', 'Jira field ID (for "Set a field")', textInput('e.g. customfield_11296', { initial: existing?.jira_field_id }), { optional: true }),
    input('jt_field_name', 'Field display name (optional)', textInput('e.g. PM Reviewed', { initial: existing?.jira_field_name }), { optional: true }),
    input('jt_field_value', 'Value to set (for "Set a field")', textInput('e.g. Yes', { initial: existing?.jira_field_value }), { optional: true }),
  ];
  if (admin) {
    blocks.push(input('jt_scope', 'Who does this apply to?', radios(
      [['global', 'Anyone matched by the JQL'], ['personal', 'Only me (DM me only)']],
      existing?.scope ?? 'global',
    )));
  }
  return {
    type: 'modal',
    callback_id: 'create_jira_trigger_modal',
    private_metadata: JSON.stringify({ id: existing?.id ?? null }),
    title: plain(existing ? 'Edit Jira Trigger' : 'Create Jira Trigger'),
    submit: plain('Save'),
    close: plain('Cancel'),
    blocks,
  };
}

function registerJiraTriggerHandler(app, services) {
  async function findJiraTrigger(id) {
    if (!services.db) return null;
    const all = await services.db.getActiveJiraTriggers();
    return all.find((t) => t.id === id) || null;
  }

  app.action('home_create_jira_trigger', async ({ ack, body, client, logger }) => {
    await ack();
    try {
      await client.views.open({ trigger_id: body.trigger_id, view: buildJiraTriggerModal(isAdmin(body.user.id)) });
    } catch (err) {
      logger.error(`[jiraTrigger] Failed to open modal: ${err.message}`);
    }
  });

  app.action('jira_trigger_menu', async ({ ack, body, client, logger }) => {
    await ack();
    const userId = body.user.id;
    const { op, id } = parseMenu(body);
    const existing = await findJiraTrigger(id);
    if (!existing || !canManage(existing.created_by, userId)) {
      await client.chat.postMessage({ channel: userId, text: '🚫 You can only edit or delete Jira triggers you created.' }).catch(() => {});
      return;
    }

    if (op === 'edit') {
      try {
        await client.views.open({ trigger_id: body.trigger_id, view: buildJiraTriggerModal(isAdmin(userId), existing) });
      } catch (err) {
        logger.error(`[jiraTrigger] Failed to open edit modal: ${err.message}`);
      }
      return;
    }

    if (op === 'reask') {
      try {
        const cleared = await services.db.deletePromptsForTrigger(id);
        logger.info(`[jiraTrigger] Re-ask "${existing.name}" (${id}) by ${userId} — cleared ${cleared} prompt(s)`);
        await client.chat.postMessage({
          channel: userId,
          text: `🔁 Re-asking for *${existing.name}*: cleared ${cleared} previous prompt(s). Everyone whose issue still matches \`${existing.jql}\` will get a fresh DM now (up to 10 per run, the rest on following runs).`,
        });
        services.jiraPoller?.runOnce({ force: true, onlyId: id }).catch(() => {});
      } catch (err) {
        logger.error(`[jiraTrigger] Re-ask failed for ${id}: ${errDetail(err)}`);
        await client.chat.postMessage({ channel: userId, text: `❌ Re-ask failed: ${errDetail(err)}` });
      }
      return;
    }

    if (op === 'delete') {
      try {
        await services.db.deactivateJiraTrigger(id);
        logger.info(`[jiraTrigger] Deleted "${existing.name}" (${id}) by ${userId}`);
        await publishHome(client, userId, services, logger);
        await client.chat.postMessage({ channel: userId, text: `🗑 Jira trigger *${existing.name}* deleted.` });
      } catch (err) {
        logger.error(`[jiraTrigger] Failed to delete ${id}: ${errDetail(err)}`);
        await client.chat.postMessage({ channel: userId, text: `❌ Failed to delete Jira trigger: ${errDetail(err)}` });
      }
    }
  });

  app.view('create_jira_trigger_modal', async ({ ack, body, view, client, logger }) => {
    const userId = body.user.id;
    const admin = isAdmin(userId);
    const v = view.state.values;
    let editId = null;
    try { editId = JSON.parse(view.private_metadata || '{}').id || null; } catch { /* create */ }

    const name = v.jt_name.value.value?.trim();
    const jql = v.jt_jql.value.value?.trim();
    const question = v.jt_question.value.value?.trim();
    const notify = v.jt_notify.value.selected_option?.value || 'reporter';
    const pollIntervalMin = parseInt(v.jt_interval?.value?.selected_option?.value || '2', 10) || 2;
    const actionType = v.jt_action.value.selected_option?.value || 'transition';
    const transitionTo = v.jt_transition?.value?.value?.trim();
    const fieldId = v.jt_field_id?.value?.value?.trim();
    const fieldName = v.jt_field_name?.value?.value?.trim();
    const fieldValue = v.jt_field_value?.value?.value?.trim();

    const errors = {};
    if (actionType === 'transition' && !transitionTo) errors.jt_transition = 'Enter the target status, e.g. Done.';
    if (actionType === 'field' && !fieldId) errors.jt_field_id = 'Enter the Jira field ID.';
    if (actionType === 'field' && !fieldValue) errors.jt_field_value = 'Enter the value to set.';
    if (!/\{key\}/.test(question || '')) errors.jt_question = 'Include {key} so the user knows which issue this is about.';
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

    let existing = null;
    if (editId) existing = await findJiraTrigger(editId);
    if (editId && (!existing || !canManage(existing.created_by, userId))) {
      await client.chat.postMessage({ channel: userId, text: '🚫 You can only edit Jira triggers you created.' }).catch(() => {});
      return;
    }
    const scope = admin
      ? (v.jt_scope?.value?.selected_option?.value ?? existing?.scope ?? 'global')
      : (existing?.scope ?? 'personal');

    const fields = {
      name, jql, question, notify, scope,
      poll_interval_min: pollIntervalMin,
      action_type: actionType,
      transition_to: actionType === 'transition' ? transitionTo : null,
      jira_field_id: actionType === 'field' ? fieldId : null,
      jira_field_name: actionType === 'field' ? (fieldName || fieldId) : null,
      jira_field_value: actionType === 'field' ? fieldValue : null,
      jira_field_type: 'select',
    };

    try {
      if (!services.db) throw new Error('Supabase is not configured');
      let savedId = editId;
      if (editId) {
        await services.db.updateJiraTrigger(editId, fields);
        logger.info(`[jiraTrigger] Updated "${name}" (${editId}) by ${userId}`);
      } else {
        const row = await services.db.insertJiraTrigger({ ...fields, created_by: userId, active: true });
        savedId = row?.id ?? null;
        logger.info(`[jiraTrigger] Created "${name}" by ${userId} (scope: ${scope}, every ${pollIntervalMin}m)`);
      }

      await publishHome(client, userId, services, logger);

      const actionText = actionType === 'transition'
        ? `move the issue to *${transitionTo}*`
        : `set *${fieldName || fieldId}* = *${fieldValue}*`;
      await client.chat.postMessage({
        channel: userId,
        text: `✅ Jira trigger *${name}* ${editId ? 'updated' : 'created'}. I'll check \`${jql}\` ${describeInterval(pollIntervalMin)} and DM the *${notify}* of any new match. On *Yes* I'll ${actionText}.`,
      });
      // Evaluate this trigger right away regardless of its cadence
      services.jiraPoller?.runOnce({ force: true, onlyId: savedId }).catch(() => {});
    } catch (err) {
      logger.error(`[jiraTrigger] Failed to save: ${errDetail(err)}`);
      await client.chat.postMessage({ channel: userId, text: `❌ Failed to save Jira trigger: ${errDetail(err)}` });
    }
  });
}

module.exports = { registerTriggerHandler, registerJiraTriggerHandler };
