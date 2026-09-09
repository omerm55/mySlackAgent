'use strict';

/**
 * `collect` ask type — ask a person to fill one or more Jira fields (catalog A1: Customer-friendly
 * name + Customer value on a PR Initiative).
 *
 * DM:   "📝 KEY (summary) needs: Customer-friendly name, Customer value"  [✍️ Answer] [Skip]
 * Modal: one free-text box ("describe it in your own words") + one optional input per field,
 *        prefilled with the current Jira value. The LLM extracts the field values from the free
 *        text (never inventing); explicit per-field inputs win.
 * Preview in the DM: "*Name:* … / *Value:* …"  [💾 Save] [✏️ Edit] [Cancel]
 * Save = one PUT with every field, as the user (OAuth) — see dmHandler.
 *
 * Trigger config: jira_triggers.collect_fields jsonb = [{ id, name, hint?, required? }].
 * In the trigger modal it is typed one field per line: `customfield_11822 | Customer-friendly name | hint`.
 */

const { issueLink, issueLinkLabelled, mentionsIssue } = require('./jiraLink');

const CF = /^customfield_\d+$/;
const MAX_VALUE = 255;          // both A1 fields are Jira "textfield" (single line, 255 chars)
const CTX_VALUE_CAP = 300;      // keep button values well under Slack's 2000-char cap

/**
 * Parse the trigger modal's "one field per line" text.
 *   customfield_11822 | Customer-friendly name | External-facing name (optional hint) | required
 * @returns {{ fields: Array<{id:string,name:string,hint:string|null,required:boolean}>, error: string|null }}
 */
function parseCollectFields(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return { fields: [], error: 'List at least one field, e.g. customfield_11822 | Customer-friendly name' };
  const fields = [];
  for (const line of lines) {
    const parts = line.split('|').map((p) => p.trim());
    const [id, name, hint, flag] = parts;
    if (!CF.test(id || '')) return { fields: [], error: `"${line.slice(0, 60)}" — each line must start with a field id like customfield_11822` };
    if (fields.some((f) => f.id === id)) return { fields: [], error: `${id} is listed twice` };
    fields.push({
      id,
      name: name || id,
      hint: hint || null,
      required: !/^(optional|no|false)$/i.test(flag || '') ,
    });
  }
  return { fields, error: null };
}

/** Back to the modal's text format (for editing an existing trigger). */
function formatCollectFields(fields) {
  return (fields || []).map((f) => [f.id, f.name, f.hint || '', f.required === false ? 'optional' : ''].join(' | ').replace(/( \| )+$/, '')).join('\n');
}

/** Human list: "Customer-friendly name, Customer value". */
function describeCollectFields(fields) {
  return (fields || []).map((f) => f.name).join(', ');
}

/** Plain string of a Jira field value (text fields only here; anything else is stringified). */
function currentValue(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'object' && v.value) return String(v.value);
  return String(v);
}

/** What the poller stores in the payload: the trigger's fields plus each one's current value. */
function collectContextFor(issue, trigger) {
  const f = issue.fields || {};
  return {
    summary: (f.summary || '').slice(0, 120),
    fields: (trigger.collect_fields || []).map((cf) => ({
      id: cf.id, name: cf.name, hint: cf.hint || null, required: cf.required !== false,
      current: currentValue(f[cf.id]).slice(0, CTX_VALUE_CAP),
    })),
  };
}

/** Compact context for buttons / private_metadata. */
function buttonCtx(context, slackUserId, extra = {}) {
  const c = context.collect || {};
  return JSON.stringify({
    askType: 'collect',
    issueKey: context.issueKey,
    slackUserId,
    question: (context.question || '').slice(0, 300),
    collect: {
      summary: (c.summary || '').slice(0, 120),
      fields: (c.fields || []).map((f) => ({
        id: f.id, name: (f.name || f.id).slice(0, 60), hint: f.hint ? String(f.hint).slice(0, 120) : null,
        required: f.required !== false, current: (f.current || '').slice(0, CTX_VALUE_CAP),
      })),
    },
    ...extra,
  });
}

function fieldLines(fields, values = null) {
  return (fields || []).map((f) => {
    const v = values ? values[f.id] : f.current;
    return `• *${f.name}:* ${v ? v : '_empty_'}`;
  }).join('\n');
}

/** Header (question or default) + current values (no buttons). */
function headerBlocks(context) {
  const c = context.collect || {};
  const label = c.summary ? `${context.issueKey} (${c.summary})` : context.issueKey;
  const headline = context.question && mentionsIssue(context.question, context.issueKey)
    ? context.question
    : `📝 *${issueLinkLabelled(context.issueKey, label)}* needs: *${describeCollectFields(c.fields)}*.`;
  return [
    { type: 'section', text: { type: 'mrkdwn', text: headline } },
    { type: 'section', text: { type: 'mrkdwn', text: fieldLines(c.fields) } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: 'Describe it in your own words — I\'ll fill the fields and show you a preview before anything is saved.' }] },
  ];
}

function askButtons(context, slackUserId) {
  return {
    type: 'actions',
    elements: [
      { type: 'button', style: 'primary', text: { type: 'plain_text', text: '✍️ Answer', emoji: true }, action_id: 'collect_answer', value: buttonCtx(context, slackUserId) },
      { type: 'button', text: { type: 'plain_text', text: 'Skip', emoji: true }, action_id: 'collect_skip', value: buttonCtx(context, slackUserId) },
    ],
  };
}

function buildCollectBlocks(context, slackUserId) {
  return [...headerBlocks(context), askButtons(context, slackUserId)];
}

/**
 * Preview after extraction: proposed values + Save / Edit / Cancel.
 * `values` = { fieldId: string|null }. Required fields without a value are called out.
 */
function previewBlocks(context, slackUserId, values, { note = null } = {}) {
  const c = context.collect || {};
  const missing = (c.fields || []).filter((f) => f.required !== false && !values[f.id]);
  const lines = (c.fields || []).map((f) => {
    const v = values[f.id];
    if (v) return `• *${f.name}:* ${v}`;
    return f.required === false ? `• *${f.name}:* _left as is_` : `• *${f.name}:* ⚠️ _not found in what you wrote_`;
  }).join('\n');
  const ctx = (extra) => buttonCtx(context, slackUserId, { values, ...extra });
  const blocks = [
    { type: 'section', text: { type: 'mrkdwn', text: `*Here's what I'll save to ${issueLink(context.issueKey)}:*\n${lines}${note ? `\n_${note}_` : ''}` } },
  ];
  const buttons = [];
  if (!missing.length) {
    buttons.push({ type: 'button', style: 'primary', text: { type: 'plain_text', text: '💾 Save to Jira', emoji: true }, action_id: 'collect_save', value: ctx() });
  }
  // Edit reopens the modal with the extracted values and the author's text
  buttons.push({ type: 'button', text: { type: 'plain_text', text: missing.length ? '✏️ Add the missing part' : '✏️ Edit', emoji: true }, action_id: 'collect_edit', value: ctx({ freeText: (context.freeText || '').slice(0, 400) }) });
  buttons.push({ type: 'button', text: { type: 'plain_text', text: 'Cancel', emoji: true }, action_id: 'collect_cancel', value: ctx() });
  blocks.push({ type: 'actions', elements: buttons });
  return { blocks, missing };
}

/** Connect-Jira nudge, identical to the yes/no question's. */
function connectBlocks(authUrl) {
  if (!authUrl) return [];
  return [
    { type: 'context', elements: [{ type: 'mrkdwn', text: '🔐 *Not connected to Jira yet.* Connect once (~10 seconds) so these changes appear under your name. Until then they are made by the bot account.' }] },
    { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: '🔗 Connect Jira', emoji: true }, url: authUrl, action_id: 'dm_connect_jira' }] },
  ];
}

/** Send the collect DM. Same contract as sendDmQuestion. */
async function sendCollect(client, slackUserId, context, opsNotifier) {
  const dm = await client.conversations.open({ users: slackUserId });
  const text = `📝 ${context.issueKey} needs: ${describeCollectFields(context.collect?.fields)}`;
  const result = await client.chat.postMessage({
    channel: dm.channel.id,
    text,
    blocks: [...buildCollectBlocks(context, slackUserId), ...connectBlocks(context.authUrl)],
  });
  await opsNotifier?.dmQuestionSent?.({
    slackUserId,
    issueKey: context.issueKey,
    question: text,
    fieldName: describeCollectFields(context.collect?.fields),
    fieldValue: 'collect',
  });
  return { channelId: dm.channel.id, messageTs: result.ts };
}

/**
 * The answer modal: free text + one optional input per field. `values` prefills the per-field inputs
 * (current Jira values on first open; the extracted values when re-opened via Edit).
 */
function buildCollectModal(ctx, values = {}, { freeText = '' } = {}) {
  const c = ctx.collect || {};
  const label = c.summary ? `${ctx.issueKey} (${c.summary})` : ctx.issueKey;
  const blocks = [
    { type: 'section', text: { type: 'mrkdwn', text: `*${issueLinkLabelled(ctx.issueKey, label)}* needs: *${describeCollectFields(c.fields)}*` } },
    {
      type: 'input', block_id: 'free_text', optional: true,
      label: { type: 'plain_text', text: 'In your own words' },
      element: {
        type: 'plain_text_input', action_id: 'value', multiline: true,
        ...(freeText ? { initial_value: freeText.slice(0, 3000) } : {}),
        placeholder: { type: 'plain_text', text: 'e.g. Call it "Smart Alerts". Customers get notified the moment a KPI drifts, instead of finding out in the Monday review.' },
      },
      hint: { type: 'plain_text', text: 'I\'ll pull the field values out of this. Or fill the fields below directly — those always win.' },
    },
    ...(c.fields || []).map((f) => ({
      type: 'input', block_id: `cf_${f.id}`, optional: true,
      label: { type: 'plain_text', text: f.name.slice(0, 150) },
      element: {
        type: 'plain_text_input', action_id: 'value', max_length: MAX_VALUE,
        ...(values[f.id] || f.current ? { initial_value: String(values[f.id] || f.current).slice(0, MAX_VALUE) } : {}),
        placeholder: { type: 'plain_text', text: (f.hint || `Exact value for ${f.name}`).slice(0, 150) },
      },
      ...(f.hint ? { hint: { type: 'plain_text', text: f.hint.slice(0, 150) } } : {}),
    })),
  ];
  return {
    type: 'modal', callback_id: 'collect_modal',
    // values/freeText live in the inputs; keep the metadata small (Slack caps it at 3000 chars)
    private_metadata: JSON.stringify({ ...ctx, values: undefined, freeText: undefined }),
    title: { type: 'plain_text', text: 'Fill in the details' },
    submit: { type: 'plain_text', text: 'Preview' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks,
  };
}

/** Read the modal state: { freeText, explicit: {fieldId: value} } (explicit only where typed and changed). */
function readCollectModal(view, ctx) {
  const v = view.state?.values || {};
  const freeText = v.free_text?.value?.value?.trim() || '';
  const explicit = {};
  for (const f of ctx.collect?.fields || []) {
    const typed = v[`cf_${f.id}`]?.value?.value;
    const val = typeof typed === 'string' ? typed.trim() : '';
    if (val && val !== (f.current || '')) explicit[f.id] = val.slice(0, MAX_VALUE);
  }
  return { freeText, explicit };
}

/**
 * Merge: explicit input > LLM extraction > (nothing). Returns { fieldId: string|null } for every field.
 * Values are trimmed and capped to the Jira text-field limit.
 */
function mergeValues(fields, explicit = {}, extracted = {}) {
  const out = {};
  for (const f of fields || []) {
    const pick = explicit[f.id] || (typeof extracted[f.id] === 'string' ? extracted[f.id].trim() : '');
    out[f.id] = pick ? pick.slice(0, MAX_VALUE) : null;
  }
  return out;
}

module.exports = {
  CF, MAX_VALUE,
  parseCollectFields, formatCollectFields, describeCollectFields, collectContextFor, currentValue,
  buttonCtx, buildCollectBlocks, previewBlocks, sendCollect, buildCollectModal, readCollectModal, mergeValues,
  fieldLines,
};
