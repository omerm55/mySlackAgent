'use strict';

/**
 * Decisions in a flagged thread — the second half of reply markers (§2.1).
 *
 * A non-approval marker (❓ "Needs a decision") leaves a post open. When one of the people mentioned in
 * that flag replies, the LLM reads the reply against the trigger's *decision field* (e.g. Include
 * Release Notes: Public / Internal / No) and the bot proposes, in the thread:
 *   "<@PM> I read this as Include Release Notes = Public and PM Reviewed = Yes on SNS-1. [Apply] [Not quite]"
 * Only that decider's click writes — as them — and the bot swaps ❓ for ✅ once Jira reads back right.
 *
 * Trigger config: integrations.decision jsonb = { fieldId, fieldName, options: [..] }.
 * In the trigger modal it is one line: `customfield_11228 | Include Release Notes | Public, Internal, No`.
 */

const { findReplyMarker, isApprovalReaction } = require('./replyMarkers');
const { issueLink } = require('./jiraLink');

const DONE_EMOJI = 'white_check_mark';
const CF = /^customfield_\d+$/;
const MENTION = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g;

/** @returns {{ decision: {fieldId,fieldName,options}|null, error: string|null }} */
function parseDecisionConfig(text) {
  const line = String(text || '').trim();
  if (!line) return { decision: null, error: null };
  const [fieldId, fieldName, opts] = line.split('|').map((p) => (p || '').trim());
  if (!CF.test(fieldId || '')) return { decision: null, error: 'Start with the field id, e.g. customfield_11228 | Include Release Notes | Public, Internal, No' };
  const options = (opts || '').split(',').map((o) => o.trim()).filter(Boolean);
  if (options.length < 2) return { decision: null, error: 'List at least two allowed values after the second |, comma-separated' };
  return { decision: { fieldId, fieldName: fieldName || fieldId, options }, error: null };
}

function formatDecisionConfig(decision) {
  return decision ? `${decision.fieldId} | ${decision.fieldName} | ${decision.options.join(', ')}` : '';
}

/** Slack user ids mentioned in a message, in order, without duplicates. */
function mentionedUsers(text) {
  return [...new Set([...String(text || '').matchAll(MENTION)].map((m) => m[1]))];
}

const isOwn = (msg, botUserId, botId) => (botUserId && msg.user === botUserId) || (botId && msg.bot_id === botId);

/**
 * The flag that leaves this thread open, or null: the latest non-bot reply matching a non-approval
 * marker, provided no later reply matches an approval marker.
 * @returns {{ reply: object, marker: {match,emoji}, deciders: string[] }|null}
 */
function findOpenFlag({ thread, root, markers, botUserId, botId }) {
  let open = null;
  for (const msg of thread || []) {
    if (msg.ts === root?.ts || isOwn(msg, botUserId, botId)) continue;
    const marker = findReplyMarker(markers, msg.text);
    if (!marker) continue;
    open = isApprovalReaction(marker.emoji) ? null : { reply: msg, marker, deciders: mentionedUsers(msg.text) };
  }
  return open;
}

/** The decision's allowed value matching the LLM's answer (case-insensitive), or null. */
function normaliseDecision(value, options) {
  if (typeof value !== 'string') return null;
  return (options || []).find((o) => o.toLowerCase() === value.trim().toLowerCase()) || null;
}

/** Proposal in the thread. ctx goes into both button values (≤2000 chars, so keep it lean). */
function buildProposalBlocks(ctx, { current, reason } = {}) {
  const change = current && current !== ctx.value ? ` (now *${current}*)` : current ? ' (unchanged)' : '';
  const text = `<@${ctx.decider}> I read your reply as: *${ctx.fieldName}* = *${ctx.value}*${change} and *${ctx.reviewFieldName}* = *${ctx.reviewValue}* on ${issueLink(ctx.issueKey)}.`;
  const value = JSON.stringify(ctx);
  return {
    text,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text } },
      ...(reason ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: `_${String(reason).slice(0, 200)}_` }] }] : []),
      {
        type: 'actions',
        elements: [
          { type: 'button', action_id: 'decision_apply', style: 'primary', text: { type: 'plain_text', text: '✅ Apply' }, value },
          { type: 'button', action_id: 'decision_dismiss', text: { type: 'plain_text', text: 'Not quite' }, value },
        ],
      },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `Only <@${ctx.decider}> can apply this. Nothing changes in Jira until then.` }] },
    ],
  };
}

/** A finished proposal: same message, no buttons. */
function buildOutcomeBlocks(text) {
  return { text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] };
}

module.exports = {
  DONE_EMOJI,
  parseDecisionConfig,
  formatDecisionConfig,
  mentionedUsers,
  findOpenFlag,
  normaliseDecision,
  buildProposalBlocks,
  buildOutcomeBlocks,
};
