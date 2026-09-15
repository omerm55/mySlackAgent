'use strict';

const { issueLink, issueLinkLabelled, mentionsIssue } = require('./jiraLink');

/**
 * "Risk review" ask type — closes the loop the rd-initiative-notifier skill leaves open.
 *
 * The notifier's weekly STAMP pass writes a one-line verdict onto a PR Initiative's
 * `Latest notification` field (cf 15525), e.g.
 *   "2026-09-14T06:03Z — Overdue 5d; Progress red 12%/exp 50%. Action: flag at risk; update progress"
 * Since its 2026-09-14 contract change it writes **only when the risk set changes** — the four risk
 * flags being Overdue, Target {N}d, Progress red and Progress orange — and once more when the last
 * risk clears (the reserved literal `No flags`, or a hygiene-only verdict). The ISO-8601 UTC stamp
 * records *when the risk began*, not when the notifier last looked, so an old stamp is a long-running
 * risk rather than a leftover. Hygiene flags (`Missing: …`, `Status mismatch`, `Placeholder target`)
 * ride along inside a verdict but never cause one on their own.
 *
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

// The only four flags the notifier treats as a risk, by the phrase it renders for each (its Stamp
// step 3). Anything else in a verdict is a data-hygiene flag, which never triggers a notification.
const RISK_FLAG_PATTERNS = {
  overdue:          /\bOverdue\s+\d+\s*d\b/i,
  target_within_15: /\bTarget\s+\d+\s*d\b/i,
  progress_red:     /\bProgress\s+red\b/i,
  progress_orange:  /\bProgress\s+orange\b/i,
};

// Verdicts that say "nothing to act on": the reserved literal the notifier writes when the last risk
// clears, plus `Not tracked`, retired on 2026-09-14 but still sitting on fields written before it.
const CLEARED_VERDICTS = new Set(['no flags', 'not tracked']);

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

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/**
 * Every verdict is "{stamp} — {body}" (space, em-dash, space; the separator is part of the
 * notifier's contract). Text without one has no stamp and is all body.
 * @returns {{ stamp: string, body: string }}
 */
function splitNotification(text) {
  const t = plainText(text);
  const m = /^([^\n]*?)\s+—\s+([\s\S]*)$/.exec(t);
  return m ? { stamp: m[1].trim(), body: m[2].trim() } : { stamp: '', body: t };
}

/** ISO-8601 stamp, the current format: `2026-09-14T06:03Z` (or `…+03:00`). Missing zone = UTC. */
function parseIsoStamp(stamp) {
  const m = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/.exec(stamp);
  if (!m) return null;
  const d = new Date(m[1] ? stamp.replace(/([+-]\d{2})(\d{2})$/, '$1:$2') : `${stamp}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Legacy "Mmm DD" stamp (pre-2026-09-14, no year). Resolve it assuming the current year, rolling
 * back a year if that would land more than 2 days in the future.
 */
function parseLegacyStamp(stamp, now) {
  const m = /^([A-Za-z]{3})\.?\s+(\d{1,2})$/.exec(stamp);
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase()];
  const day = parseInt(m[2], 10);
  if (month === undefined || day < 1 || day > 31) return null;
  let d = new Date(Date.UTC(now.getUTCFullYear(), month, day));
  if (d.getTime() - now.getTime() > 2 * 24 * 3600 * 1000) d = new Date(Date.UTC(now.getUTCFullYear() - 1, month, day));
  return d;
}

/**
 * The stamp on a verdict, and which of the notifier's two formats wrote it.
 * @returns {{ date: Date|null, format: 'iso'|'legacy'|null }} format null = no recognisable stamp
 */
function notificationStamp(text, now = new Date()) {
  const { stamp } = splitNotification(text);
  if (!stamp) return { date: null, format: null };
  const iso = parseIsoStamp(stamp);
  if (iso) return { date: iso, format: 'iso' };
  const legacy = parseLegacyStamp(stamp, now);
  return legacy ? { date: legacy, format: 'legacy' } : { date: null, format: null };
}

/** @returns {Date|null} when this verdict was written — for an ISO stamp, when the risk began. */
function parseNotificationDate(text, now = new Date()) {
  return notificationStamp(text, now).date;
}

/**
 * How old is the stamp, and is it a leftover to ignore?
 *
 * An ISO stamp is **never** stale, however old: since 2026-09-14 the notifier writes only when the
 * risk set changes and clears explicitly, so the stamp says when the risk began and a months-old one
 * means a months-old risk that is still live. The `maxAgeDays` cutoff applies only to legacy
 * "Mmm DD" stamps, written under the old contract where nothing was ever cleared; they disappear as
 * the notifier migrates or clears them. Unstamped text is treated as fresh (never drop something we
 * can't read) — callers may log it.
 * @returns {{ stale: boolean, ageDays: number|null, format: 'iso'|'legacy'|null }}
 */
function notificationAge(text, now = new Date(), maxAgeDays = 8) {
  const { date, format } = notificationStamp(text, now);
  if (!date) return { stale: false, ageDays: null, format: null };
  const ageDays = Math.floor((now.getTime() - date.getTime()) / (24 * 3600 * 1000));
  return { stale: format === 'legacy' && ageDays > maxAgeDays, ageDays, format };
}

/**
 * Which of the notifier's four risk flags this verdict carries. Only the flag section is read — the
 * "Action: …" tail repeats the same conditions in different words. An empty result means the verdict
 * is hygiene-only (or clear): evaluated, but nothing anyone has to act on.
 * @returns {string[]} subset of overdue | target_within_15 | progress_red | progress_orange
 */
function riskFlagsIn(text) {
  const { body } = splitNotification(text);
  const flagSection = body.split(/\.\s*Action\s*:/i)[0];
  return Object.keys(RISK_FLAG_PATTERNS).filter((k) => RISK_FLAG_PATTERNS[k].test(flagSection));
}

/**
 * Build the risk part of a Jira-trigger payload from a searched issue. `since` is the day the risk
 * began, per the notifier's stamp — worth showing, because the verdict no longer moves week to week.
 */
function riskContextFor(issue) {
  const f = issue.fields || {};
  const target = parseInterval(f[FIELDS.TARGET]);
  const notification = String(f[FIELDS.NOTIFICATION] || '').trim().slice(0, 255);
  const since = parseNotificationDate(notification);
  return {
    notification,
    status: f.status?.name || '',
    summary: String(f.summary || '').slice(0, 120),
    targetStart: target?.start || null,
    targetEnd: target?.end || null,
    notes: notesPreview(f[FIELDS.NOTES]),
    since: since ? since.toISOString().slice(0, 10) : null,
  };
}

/**
 * Is this the notifier's clearing write — the reserved literal `No flags` (or the retired
 * `Not tracked`)? It means "we looked and the risk is gone", so nobody should be asked about it.
 */
function isClearedNotification(text) {
  const { body } = splitNotification(text);
  return CLEARED_VERDICTS.has(body.replace(/[.\s]+$/, '').toLowerCase());
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
    allowFallback: !!context.allowFallback,
    risk: {
      notification: (r.notification || '').slice(0, 255),
      status: r.status || '',
      summary: (r.summary || '').slice(0, 120),
      targetStart: r.targetStart || null,
      targetEnd: r.targetEnd || null,
      since: r.since || null,
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
      text: `Status: *${r.status || 'unknown'}*  ·  Target: *${r.targetEnd || 'none'}*${r.since ? `  ·  Flagged since: *${r.since}*` : ''}`,
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
      { type: 'context', elements: [{ type: 'mrkdwn', text: `Status: *${r.status || 'unknown'}*  ·  Target: *${r.targetEnd || 'none'}*${r.since ? `  ·  Flagged since: *${r.since}*` : ''}` }] },
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
  parseNotificationDate, notificationAge, notificationMatches, connectBlocks,
  RISK_FLAG_PATTERNS, splitNotification, notificationStamp, riskFlagsIn, isClearedNotification,
};
