'use strict';

const { isAdmin, canManage } = require('../utils/admins');
const { publishHome } = require('./homeHandler');
const { parseCollectFields, formatCollectFields, describeCollectFields } = require('../utils/collectMessage');

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

/**
 * Trigger management is an admin activity: report it in the ops channel,
 * tagged with who did it. The bot's DMs stay reserved for conversations
 * with the user (questions, action results, OAuth). Falls back to a DM only
 * when no ops channel is configured.
 */
async function notifyOps(services, client, userId, text) {
  const ops = services.opsNotifier;
  if (ops?.channelId) {
    await ops.post(`<@${userId}> · ${text}`);
    return;
  }
  await client.chat.postMessage({ channel: userId, text }).catch(() => {});
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
      await notifyOps(services, client, userId, '🚫 You can only edit or delete triggers you created.');
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
        await notifyOps(services, client, userId, `🗑 Trigger *${existing.name}* deleted.`);
      } catch (err) {
        logger.error(`[trigger] Failed to delete ${id}: ${errDetail(err)}`);
        await notifyOps(services, client, userId, `❌ Failed to delete trigger: ${errDetail(err)}`);
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

    // Scope: admins choose; non-admins keep the existing scope on edit, personal on create
    let existing = null;
    if (editId) existing = (await integrationCache.getAll()).find((i) => i.id === editId) || null;
    if (editId && (!existing || !canManage(existing.createdBy, userId))) {
      await ack({ response_action: 'errors', errors: { name_block: 'You can only edit triggers you created.' } });
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

    // Save BEFORE acknowledging, so a failed write keeps the modal open with the reason
    // instead of closing and looking like a silent revert.
    try {
      if (!services.db) throw new Error('Supabase is not configured');
      if (editId) {
        await services.db.updateIntegration(editId, fields);
        logger.info(`[trigger] Updated integration "${name}" (${editId}) by ${userId}`);
      } else {
        await services.db.upsertIntegration({ ...fields, created_by: userId, active: true });
        logger.info(`[trigger] Created integration "${name}" by ${userId} (scope: ${scope})`);
      }
    } catch (err) {
      logger.error(`[trigger] Failed to save integration: ${errDetail(err)}`);
      await ack({ response_action: 'errors', errors: { name_block: `Could not save: ${errDetail(err)}`.slice(0, 250) } });
      await notifyOps(services, client, userId, `❌ Failed to save trigger *${name}*: ${errDetail(err)}`);
      return;
    }
    await ack();

    try {
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
      await notifyOps(services, client, userId, `✅ Trigger *${name}* ${editId ? 'updated' : 'created'}! It fires on ${when} in <#${channelId}>, setting *${jiraFieldName}* = *${jiraFieldValue}*.${joinNote}`);
    } catch (err) {
      // Saved fine; only the follow-ups (join / Home refresh / ops) hiccuped
      logger.warn(`[trigger] Post-save step failed for "${name}": ${errDetail(err)}`);
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
    input('jt_ask_type', 'What kind of ask?', radios([
      ['yes_no', 'Yes / No question → move to a status or set a field'],
      ['risk_review', 'Risk review — R&D Initiative Notifier flag → Dev owner acts (status / Notes / target)'],
      ['collect', 'Collect field values — they describe it in their words, AI fills the fields, they confirm, one save'],
    ], existing?.ask_type ?? 'yes_no')),
    input('jt_collect_fields', 'Fields to collect (for "Collect field values")', textInput('customfield_11822 | Customer-friendly name | External-facing name\ncustomfield_15249 | Customer value | One line on what the customer gets', { multiline: true, initial: formatCollectFields(existing?.collect_fields) }), {
      optional: true,
      hint: plain('One per line: field id | label | hint (optional) | "optional" to not require it. Text fields only.'),
    }),
    input('jt_notify', 'Who to DM', radios([
      ['reporter', 'Reporter'], ['assignee', 'Assignee'], ['user_field', 'A user field (enter its id below)'],
    ], existing?.notify ?? 'reporter')),
    input('jt_notify_field', 'User field id (for "A user field")', textInput('e.g. customfield_11962 (PR Dev Owner/FC Sponsor)', { initial: existing?.notify_field_id }), { optional: true }),
    input('jt_watch_field', 'Re-ask when this field changes (optional)', textInput('e.g. customfield_15525 (Latest notification)', { initial: existing?.watch_field }), {
      optional: true,
      hint: plain('Normally each issue is asked about once. With a watch field, a new value re-asks — e.g. every weekly notifier run.'),
    }),
    input('jt_fyi_field', 'Also FYI the user in this field (optional)', textInput('e.g. customfield_11909 (PR PM owner)', { initial: existing?.fyi_field_id }), {
      optional: true,
      hint: plain('They get an informational DM when the main person is asked, and a note when they act. Risk reviews default to the PR PM owner.'),
    }),
    input('jt_pilot_users', 'Pilot: only DM these people (optional)', {
      type: 'multi_users_select',
      placeholder: plain('Pick people to pilot with'),
      ...(existing?.pilot_slack_user_ids?.length ? { initial_users: existing.pilot_slack_user_ids } : {}),
    }, {
      optional: true,
      hint: plain('Requires "Anyone matched by the JQL" below — "Only me" always wins. While set, only these people are asked (and FYI\'d); everyone else matched is skipped, not marked as asked, until you clear this.'),
    }),
    input('jt_action', 'On "Yes", do this (Yes / No asks only)', radios([['transition', 'Move to a status'], ['field', 'Set a field']], existing?.action_type ?? 'transition')),
    input('jt_transition', 'Target status (for "Move to a status")', textInput('e.g. Done', { initial: existing?.transition_to }), { optional: true }),
    input('jt_field_id', 'Jira field ID (for "Set a field")', textInput('e.g. customfield_11296', { initial: existing?.jira_field_id }), { optional: true }),
    input('jt_field_name', 'Field display name (optional)', textInput('e.g. PM Reviewed', { initial: existing?.jira_field_name }), { optional: true }),
    input('jt_field_value', 'Value to set (for "Set a field")', textInput('e.g. Yes', { initial: existing?.jira_field_value }), { optional: true }),
  ];
  if (admin) {
    blocks.push(input('jt_scope', 'Who does this apply to?', radios(
      [['global', 'Anyone matched by the JQL (narrow with the pilot list above)'], ['personal', 'Only me (DM me only — ignores the pilot list)']],
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
      await notifyOps(services, client, userId, '🚫 You can only edit or delete Jira triggers you created.');
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

    if (op === 'run') {
      if (!services.jiraPoller) {
        await notifyOps(services, client, userId, '⚠️ The Jira poller is not running (Supabase not configured).');
        return;
      }
      try {
        const [stats] = await services.jiraPoller.runOnce({ force: true, onlyId: id });
        if (!stats) {
          await notifyOps(services, client, userId, `⏳ *${existing.name}* is already being evaluated — try again in a moment.`);
          return;
        }
        const lines = [`▶️ Ran *${existing.name}* — \`${existing.jql}\``];
        if (stats.error) {
          lines.push(`❌ ${stats.error}`);
        } else {
          lines.push(`${stats.matched} issue(s) match · ${stats.fresh} not yet asked · ${stats.sent} DM(s) sent${stats.queued ? ` · ${stats.queued} queued for digests` : ''}${stats.fyi ? ` · ${stats.fyi} FYI` : ''}`);
          if (stats.sentTo.length) lines.push(...stats.sentTo.map((s) => `  • ${s}`));
          if (stats.queuedFor?.length) lines.push(...stats.queuedFor.map((s) => `  🔔 ${s}`));
          if (stats.skipped.length) lines.push(...stats.skipped.slice(0, 10).map((s) => `  ⏭ ${s}`));
          if (stats.matched > 0 && stats.fresh === 0) lines.push('_Everyone matching has already been asked. Use 🔁 Re-ask open matches to ask again._');
        }
        await notifyOps(services, client, userId, lines.join('\n'));
      } catch (err) {
        logger.error(`[jiraTrigger] Run now failed for ${id}: ${errDetail(err)}`);
        await notifyOps(services, client, userId, `❌ Run failed: ${errDetail(err)}`);
      }
      return;
    }

    if (op === 'reask') {
      try {
        const cleared = await services.db.deletePromptsForTrigger(id);
        logger.info(`[jiraTrigger] Re-ask "${existing.name}" (${id}) by ${userId} — cleared ${cleared} prompt(s)`);
        const [stats] = services.jiraPoller ? await services.jiraPoller.runOnce({ force: true, onlyId: id }) : [];
        const summary = stats && !stats.error
          ? `${stats.matched} issue(s) match · ${stats.sent} DM(s) sent${stats.queued ? ` · ${stats.queued} queued for digests` : ''}${stats.skipped.length ? ` · ${stats.skipped.length} skipped` : ''}`
          : (stats?.error ? `❌ ${stats.error}` : 'poller not available');
        await notifyOps(services, client, userId, `🔁 Re-asked *${existing.name}*: cleared ${cleared} previous prompt(s).\n${summary}${stats?.sentTo?.length ? `\n${stats.sentTo.map((s) => `  • ${s}`).join('\n')}` : ''}`);
      } catch (err) {
        logger.error(`[jiraTrigger] Re-ask failed for ${id}: ${errDetail(err)}`);
        await notifyOps(services, client, userId, `❌ Re-ask failed: ${errDetail(err)}`);
      }
      return;
    }

    if (op === 'delete') {
      try {
        await services.db.deactivateJiraTrigger(id);
        logger.info(`[jiraTrigger] Deleted "${existing.name}" (${id}) by ${userId}`);
        await publishHome(client, userId, services, logger);
        await notifyOps(services, client, userId, `🗑 Jira trigger *${existing.name}* deleted.`);
      } catch (err) {
        logger.error(`[jiraTrigger] Failed to delete ${id}: ${errDetail(err)}`);
        await notifyOps(services, client, userId, `❌ Failed to delete Jira trigger: ${errDetail(err)}`);
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
    const askType = v.jt_ask_type?.value?.selected_option?.value || 'yes_no';
    const notifyFieldId = v.jt_notify_field?.value?.value?.trim() || null;
    const watchField = v.jt_watch_field?.value?.value?.trim() || null;
    const fyiFieldId = v.jt_fyi_field?.value?.value?.trim() || null;
    const pilotUsers = v.jt_pilot_users?.value?.selected_users || [];
    const pollIntervalMin = parseInt(v.jt_interval?.value?.selected_option?.value || '2', 10) || 2;
    const actionType = v.jt_action.value.selected_option?.value || 'transition';
    const transitionTo = v.jt_transition?.value?.value?.trim();
    const fieldId = v.jt_field_id?.value?.value?.trim();
    const fieldName = v.jt_field_name?.value?.value?.trim();
    const fieldValue = v.jt_field_value?.value?.value?.trim();
    const collectParsed = askType === 'collect' ? parseCollectFields(v.jt_collect_fields?.value?.value) : { fields: [], error: null };

    const errors = {};
    if (askType === 'collect' && collectParsed.error) errors.jt_collect_fields = collectParsed.error.slice(0, 250);
    const CF = /^customfield_\d+$/;
    if (notify === 'user_field' && !CF.test(notifyFieldId || '')) errors.jt_notify_field = 'Enter the user field id, e.g. customfield_11962.';
    if (watchField && !CF.test(watchField)) errors.jt_watch_field = 'Field ids look like customfield_15525.';
    if (fyiFieldId && !CF.test(fyiFieldId)) errors.jt_fyi_field = 'Field ids look like customfield_11909.';
    if (askType === 'yes_no') {
      if (actionType === 'transition' && !transitionTo) errors.jt_transition = 'Enter the target status, e.g. Done.';
      if (actionType === 'field' && !fieldId) errors.jt_field_id = 'Enter the Jira field ID.';
      if (actionType === 'field' && !fieldValue) errors.jt_field_value = 'Enter the value to set.';
      if (!/\{key\}|\{link\}/.test(question || '')) errors.jt_question = 'Include {key} or {link} so the user knows which issue this is about.';
    }
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

    let existing = null;
    if (editId) existing = await findJiraTrigger(editId);
    if (editId && (!existing || !canManage(existing.created_by, userId))) {
      await ack({ response_action: 'errors', errors: { jt_name: 'You can only edit Jira triggers you created.' } });
      return;
    }
    const scope = admin
      ? (v.jt_scope?.value?.selected_option?.value ?? existing?.scope ?? 'global')
      : (existing?.scope ?? 'personal');

    const fields = {
      name, jql, notify, scope,
      question: question || (askType === 'risk_review' ? '{link} was flagged by the weekly R&D Initiative Notifier.'
        : askType === 'collect' ? `{link} needs: ${describeCollectFields(collectParsed.fields)}.` : ''),
      ask_type: askType,
      collect_fields: askType === 'collect' ? collectParsed.fields : null,
      notify_field_id: notify === 'user_field' ? notifyFieldId : null,
      watch_field: watchField,
      fyi_field_id: fyiFieldId,
      pilot_slack_user_ids: pilotUsers.length ? pilotUsers : null,
      poll_interval_min: pollIntervalMin,
      action_type: actionType,
      transition_to: askType === 'yes_no' && actionType === 'transition' ? transitionTo : null,
      jira_field_id: askType === 'yes_no' && actionType === 'field' ? fieldId : null,
      jira_field_name: askType === 'yes_no' && actionType === 'field' ? (fieldName || fieldId) : null,
      jira_field_value: askType === 'yes_no' && actionType === 'field' ? fieldValue : null,
      jira_field_type: 'select',
    };

    // Save BEFORE acknowledging: a failed write keeps the modal open with the reason.
    let savedId = editId;
    try {
      if (!services.db) throw new Error('Supabase is not configured');
      if (editId) {
        await services.db.updateJiraTrigger(editId, fields);
        logger.info(`[jiraTrigger] Updated "${name}" (${editId}) by ${userId}`);
      } else {
        const row = await services.db.insertJiraTrigger({ ...fields, created_by: userId, active: true });
        savedId = row?.id ?? null;
        logger.info(`[jiraTrigger] Created "${name}" by ${userId} (scope: ${scope}, every ${pollIntervalMin}m)`);
      }
    } catch (err) {
      logger.error(`[jiraTrigger] Failed to save: ${errDetail(err)}`);
      await ack({ response_action: 'errors', errors: { jt_name: `Could not save: ${errDetail(err)}`.slice(0, 250) } });
      await notifyOps(services, client, userId, `❌ Failed to save Jira trigger *${name}*: ${errDetail(err)}`);
      return;
    }
    await ack();

    try {
      await publishHome(client, userId, services, logger);

      const who = notify === 'user_field' ? `user in \`${notifyFieldId}\`` : notify;
      const outcome = askType === 'risk_review'
        ? 'They can set a risk status, update Notes, move or clear the target, or mark it handled.'
        : askType === 'collect'
        ? `They describe it in their words, AI fills *${describeCollectFields(collectParsed.fields)}*, they confirm a preview, and it's saved in one update.`
        : `On *Yes* I'll ${actionType === 'transition' ? `move the issue to *${transitionTo}*` : `set *${fieldName || fieldId}* = *${fieldValue}*`}.`;
      const watch = watchField ? ` Re-asks whenever \`${watchField}\` changes.` : '';
      const fyiField = fyiFieldId || (askType === 'risk_review' ? 'customfield_11909' : null);
      const fyi = fyiField ? ` FYI DM to the user in \`${fyiField}\`.` : '';
      const pilotNote = pilotUsers.length ? ` 🧪 Pilot: only ${pilotUsers.map((u) => `<@${u}>`).join(', ')} will be asked.` : '';
      await notifyOps(services, client, userId, `✅ Jira trigger *${name}* ${editId ? 'updated' : 'created'}. I'll check \`${jql}\` ${describeInterval(pollIntervalMin)} and DM the *${who}* of any new match. ${outcome}${watch}${fyi}${pilotNote}`);
      // Evaluate this trigger right away regardless of its cadence
      services.jiraPoller?.runOnce({ force: true, onlyId: savedId }).catch(() => {});
    } catch (err) {
      // Saved fine; only the follow-ups (Home refresh / ops / immediate run) hiccuped
      logger.warn(`[jiraTrigger] Post-save step failed for "${name}": ${errDetail(err)}`);
    }
  });
}

module.exports = { registerTriggerHandler, registerJiraTriggerHandler };
