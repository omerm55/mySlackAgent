'use strict';

const { issueLink, issueLinkLabelled, mentionsIssue } = require('./jiraLink');

/**
 * "Risk review" ask type — closes the loop the rd-initiative-notifier skill leaves open.
 *
 * The notifier writes a one-line diagnosis onto every flagged PR Initiative in the
 * `Latest notification` field (cf 15525), e.g.
 *   "Sep 8 — Overdue 5d; Progress red 12%/exp 50%. Action: flag at risk; update progress"
 * We DM the Dev owner with that text and let them act as themselves:
 *   set a risk status · update Notes · move / clear the Project target · mark handled.
 */

// PR (Product Roadmap, Jira Product Discovery) field ids — see pr-sns-knowledge
const FIELDS = {
  NOTIFICATION: process.env.PR_LATEST_NOTIFICATION_FIELD || 'customfield_15525', // Latest notification (text ≤255)
  NOTES:        process.env.PR_NOTES_FIELD || 'customfield_12958',               // Notes (multi-line text)
  TARGET:       process.env.PR_TARGET_FIELD || 'customfield_11818',              // Project target (Polaris interval JSON string)
  DEV_OWNER:    process.env.PR_DEV_OWNER_FIELD || 'customfield_11962',           // PR Dev Owner/FC Sponsor (user array)
  PM_OWNER:     process.env.PR_PM_OWNER_FIELD || 'customfield_11909',            // PR PM owner (user array) — FYI recipient
};

const RISK_STATUSES = ['Low Risk', 'High Risk', 'Off Track'];
const AT_RISK = new Set(RISK_STATUSES);
const ON_TRACK = 'On Track';

/** Polaris interval fields arrive as a JSON string {"start":"YYYY-MM-DD","end":"YYYY-MM-DD"} (or an object). */
function parseInterval(value) {
  if (!value) return null;
  try {
    const obj = typeof value === 'string' ? JSON.parse(value) : value;
    if (!obj || typeof obj !== 'object') return null;
    return { start: obj.start || null, end: obj.end || null };
  } catch {
    return null;
  }
}

/** Plain text from a Jira text field that may arrive as a string or as an ADF document. */
function plainText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'object') {
    const out = [];
    const walk = (n) => {
      if (!n || typeof n !== 'object') return;
      if (n.type === 'text' && typeof n.text === 'string') out.push(n.text);
      if (n.type === 'paragraph' || n.type === 'hardBreak') out.push('\n');
      (n.content || []).forEach(walk);
    };
    walk(value);
    return out.join('').replace(/\n{3,}/g, '\n\n').trim();
  }
  return String(value).trim();
}

const NOTES_PREVIEW_CHARS = 400;
function notesPreview(notes) {
  const t = plainText(notes);
  if (!t) return '';
  return t.length > NOTES_PREVIEW_CHARS ? `${t.slice(0, NOTES_PREVIEW_CHARS).trimEnd()}…` : t;
}

/** Build the risk part of a Jira-trigger payload from a searched issue. */
function riskContextFor(issue) {
  const f = issue.fields || {};
  const target = parseInterval(f[FIELDS.TARGET]);
  return {
    notification: String(f[FIELDS.NOTIFICATION] || '').trim().slice(0, 255),
    status: f.status?.name || '',
    summary: String(f.summary || '').slice(0, 120),
    targetStart: target?.start || null,
    targetEnd: target?.end || null,
    notes: notesPreview(f[FIELDS.NOTES]),
  };
}

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/**
 * The notifier's text starts with "{Mmm DD} — …" (no year). Resolve it to a date, assuming the
 * current year and rolling back a year if that would land more than 2 days in the future.
 * @returns {Date|null} null when the text doesn't start with a recognisable stamp
 */
function parseNotificationDate(text, now = new Date()) {
  const m = /^\s*([A-Za-z]{3})\.?\s+(\d{1,2})\b/.exec(String(text || ''));
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase()];
  const day = parseInt(m[2], 10);
  if (month === undefined || day < 1 || day > 31) return null;
  let d = new Date(Date.UTC(now.getUTCFullYear(), month, day));
  if (d.getTime() - now.getTime() > 2 * 24 * 3600 * 1000) d = new Date(Date.UTC(now.getUTCFullYear() - 1, month, day));
  return d;
}

/**
 * Is this notification older than `maxAgeDays`? The notifier never clears the field, so an old
 * stamp means "was flagged once, not any more". Unparseable text is treated as fresh (never drop
 * something we can't read) — callers may log it.
 * @returns {{ stale: boolean, ageDays: number|null }}
 */
function notificationAge(text, now = new Date(), maxAgeDays = 8) {
  const d = parseNotificationDate(text, now);
  if (!d) return { stale: false, ageDays: null };
  const ageDays = Math.floor((now.getTime() - d.getTime()) / (24 * 3600 * 1000));
  return { stale: ageDays > maxAgeDays, ageDays };
}

/**
 * Does the notification talk about the condition we care about? `pattern` is a case-insensitive
 * regular expression (env RISK_NOTIFICATION_MATCH, default "progress red"); an invalid regex falls
 * back to a plain substring match, and an empty pattern matches everything.
 */
function notificationMatches(text, pattern) {
  if (!pattern) return true;
  const hay = plainText(text) || '';
  try {
    return new RegExp(pattern, 'i').test(hay);
  } catch {
    return hay.toLowerCase().includes(String(pattern).toLowerCase());
  }
}

/** "*Notes:* …" block — quoted preview or an explicit "empty". */
function notesBlock(notes) {
  const text = notes
    ? `*Notes:*\n${notes.split('\n').map((l) => `> ${l}`).join('\n')}`
    : '*Notes:* _empty_';
  return { type: 'section', text: { type: 'mrkdwn', text } };
}

/** Which status buttons to offer, per the notifier's "already at risk" and "On hold" rules. */
function statusChoices(currentStatus) {
  if (!currentStatus) return RISK_STATUSES;
  if (currentStatus === 'On hold') return [];
  if (AT_RISK.has(currentStatus)) return [ON_TRACK];
  return RISK_STATUSES;
}

const STATUS_BUTTON = {
  'Low Risk':  { id: 'risk_set_status_low',     label: '🟡 Low Risk' },
  'High Risk': { id: 'risk_set_status_high',    label: '🔴 High Risk' },
  'Off Track': { id: 'risk_set_status_off',     label: '⛔ Off Track' },
  [ON_TRACK]:  { id: 'risk_set_status_ontrack', label: '🟢 Back On Track' },
};

/** Compact context carried in every button (Slack caps button values at 2000 chars). */
function buttonCtx(context, slackUserId, extra = {}) {
  const r = context.risk || {};
  return JSON.stringify({
    askType: 'risk_review',
    issueKey: context.issueKey,
    slackUserId,
    question: (context.question || '').slice(0, 300),
    fyiSlackUserId: context.fyiSlackUserId || null,
    risk: {
      notification: (r.notification || '').slice(0, 255),
      status: r.status || '',
      summary: (r.summary || '').slice(0, 120),
      targetStart: r.targetStart || null,
      targetEnd: r.targetEnd || null,
    },
    ...extra,
  });
}

/** Header + diagnosis + status/target line (no buttons). */
function headerBlocks(context) {
  const r = context.risk || {};
  const label = r.summary ? `${context.issueKey} (${r.summary})` : context.issueKey;
  const headline = context.question && mentionsIssue(context.question, context.issueKey)
    ? context.question
    : `⚠️ *${issueLinkLabelled(context.issueKey, label)}* was flagged by the weekly R&D Initiative Notifier.`;
  const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: headline } }];
  if (r.notification) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `> ${r.notification}` } });
  }
  blocks.push({
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: `Status: *${r.status || 'unknown'}*  ·  Target: *${r.targetEnd || 'none'}*`,
    }],
  });
  blocks.push(notesBlock(r.notes));
  return blocks;
}

/** The action buttons: status choices (0–3) in one block, then Notes / target / handled. */
function actionBlocks(context, slackUserId, { includeStatus = true, includeTarget = true, includeHandled = true } = {}) {
  const ctx = (extra) => buttonCtx(context, slackUserId, extra);
  const blocks = [];
  const statuses = includeStatus ? statusChoices(context.risk?.status) : [];
  if (statuses.length) {
    blocks.push({
      type: 'actions',
      elements: statuses.map((s) => ({
        type: 'button',
        text: { type: 'plain_text', text: STATUS_BUTTON[s].label, emoji: true },
        action_id: STATUS_BUTTON[s].id,
        value: ctx({ status: s }),
        ...(s === 'High Risk' || s === 'Off Track' ? { style: 'danger' } : {}),
      })),
    });
  }
  const rest = [
    { type: 'button', text: { type: 'plain_text', text: '📝 Update Notes', emoji: true }, action_id: 'risk_update_notes', value: ctx(), style: 'primary' },
  ];
  if (includeTarget) rest.push({ type: 'button', text: { type: 'plain_text', text: '📅 Move / clear target', emoji: true }, action_id: 'risk_move_target', value: ctx() });
  if (includeHandled) rest.push({ type: 'button', text: { type: 'plain_text', text: '✅ Handled', emoji: true }, action_id: 'risk_handled', value: ctx() });
  blocks.push({ type: 'actions', elements: rest });
  return blocks;
}

function buildRiskReviewBlocks(context, slackUserId) {
  return [
    ...headerBlocks(context),
    { type: 'section', text: { type: 'mrkdwn', text: 'What would you like to do?' } },
    ...actionBlocks(context, slackUserId),
  ];
}

/** Connect-Jira nudge, identical to the yes/no question's. */
function connectBlocks(authUrl) {
  if (!authUrl) return [];
  return [
    { type: 'context', elements: [{ type: 'mrkdwn', text: '🔐 *Not connected to Jira yet.* Connect once (~10 seconds) so these changes appear under your name. Until then they are made by the bot account.' }] },
    { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: '🔗 Connect Jira', emoji: true }, url: authUrl, action_id: 'dm_connect_jira' }] },
  ];
}

/** Send the risk-review DM. Same contract as sendDmQuestion. */
async function sendRiskReview(client, slackUserId, context, opsNotifier) {
  const dm = await client.conversations.open({ users: slackUserId });
  const text = `⚠️ ${context.issueKey} was flagged by the R&D Initiative Notifier${context.risk?.notification ? `: ${context.risk.notification}` : ''}`;
  const result = await client.chat.postMessage({
    channel: dm.channel.id,
    text,
    blocks: [...buildRiskReviewBlocks(context, slackUserId), ...connectBlocks(context.authUrl)],
  });
  await opsNotifier?.dmQuestionSent?.({
    slackUserId,
    issueKey: context.issueKey,
    question: context.risk?.notification || 'risk review',
    fieldName: 'risk review',
    fieldValue: context.risk?.status || '',
  });
  return { channelId: dm.channel.id, messageTs: result.ts };
}

/**
 * Informational DM to a second person (e.g. the PM owner) when the main person is asked.
 * No buttons — they are being kept in the loop, not asked to act.
 */
async function sendFyi(client, fyiSlackUserId, context, askedSlackUserId, opsNotifier) {
  const r = context.risk || {};
  const label = r.summary ? `${context.issueKey} (${r.summary})` : context.issueKey;
  const link = issueLinkLabelled(context.issueKey, label);
  const blocks = context.askType === 'risk_review'
    ? [
      { type: 'section', text: { type: 'mrkdwn', text: `ℹ️ *FYI* — *${link}* was flagged by the weekly R&D Initiative Notifier. I've asked the Dev owner <@${askedSlackUserId}> to act; you'll get a note here when they do.` } },
      ...(r.notification ? [{ type: 'section', text: { type: 'mrkdwn', text: `> ${r.notification}` } }] : []),
      { type: 'context', elements: [{ type: 'mrkdwn', text: `Status: *${r.status || 'unknown'}*  ·  Target: *${r.targetEnd || 'none'}*` }] },
      notesBlock(r.notes),
    ]
    : [
      { type: 'section', text: { type: 'mrkdwn', text: `ℹ️ *FYI* — I've asked <@${askedSlackUserId}> about *${issueLink(context.issueKey)}*:\n> ${(context.question || '').replace(/^\W*/, '')}` } },
    ];
  const dm = await client.conversations.open({ users: fyiSlackUserId });
  const text = `ℹ️ FYI — ${context.issueKey} flagged; asked <@${askedSlackUserId}> to act`;
  const result = await client.chat.postMessage({ channel: dm.channel.id, text, blocks });
  await opsNotifier?.post?.(`ℹ️ FYI sent to <@${fyiSlackUserId}> about *${context.issueKey}* (asked <@${askedSlackUserId}>)`);
  return { channelId: dm.channel.id, messageTs: result.ts };
}

/**
 * After a status change: offer Notes (the notifier's ask is "flag at risk AND refresh Notes")
 * but always with a way out.
 */
function afterStatusBlocks(context, slackUserId) {
  const ctx = (extra) => buttonCtx(context, slackUserId, extra);
  return [{
    type: 'actions',
    elements: [
      { type: 'button', text: { type: 'plain_text', text: '📝 Update Notes', emoji: true }, action_id: 'risk_update_notes', value: ctx(), style: 'primary' },
      { type: 'button', text: { type: 'plain_text', text: 'Skip', emoji: true }, action_id: 'risk_skip_notes', value: ctx() },
    ],
  }];
}

/** Notes entry line prepended to the Notes field. */
function notesEntry(note, authorName, date = new Date()) {
  const d = date.toISOString().slice(0, 10);
  return `${d}${authorName ? ` (${authorName})` : ''}: ${note.trim()}`;
}

function prependNotes(existing, entry) {
  const rest = String(existing || '').trim();
  return rest ? `${entry}\n\n${rest}` : entry;
}

module.exports = {
  FIELDS, RISK_STATUSES, AT_RISK, ON_TRACK, STATUS_BUTTON,
  parseInterval, riskContextFor, statusChoices, buildRiskReviewBlocks, actionBlocks, afterStatusBlocks,
  sendRiskReview, sendFyi, notesEntry, prependNotes, issueLink, plainText, notesPreview, notesBlock,
  parseNotificationDate, notificationAge, notificationMatches,
};
