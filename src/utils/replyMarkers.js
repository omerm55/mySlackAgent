'use strict';

/**
 * Reply markers on a channel trigger — when a thread reply contains a phrase, the bot reacts with an
 * emoji on the thread's root message and writes nothing to Jira.
 *
 * Built for the PM-reviewed channel: a scheduled review replies ":robot_face: Auto-verified …" (it has
 * already set the field) or ":triangular_flag_on_post: Needs a decision …" (the field must stay unset),
 * and the channel should show at a glance which posts are done (👍) and which wait on a person (❓).
 *
 * A marker whose emoji is itself an approval (👍 / ✅) *settles* the post: it is already approved, so a
 * person's 👍 or reply there writes nothing — see findSettlingMarker.
 *
 * Trigger config: integrations.reply_markers jsonb = [{ match, emoji }].
 * In the trigger modal it is typed one marker per line: `Auto-verified => :thumbsup:`.
 */

const APPROVAL_REACTIONS = new Set(['+1', 'thumbsup', 'thumbs_up', 'white_check_mark']);
const isApprovalReaction = (name) => APPROVAL_REACTIONS.has(name) || APPROVAL_REACTIONS.has(String(name).split('::')[0]);

const SEPARATOR = /\s*(?:=>|→)\s*/;
const EMOJI = /^[a-z0-9_+'-]+(?:::skin-tone-[2-6])?$/;

/**
 * Parse the modal's "one marker per line" text. Empty text is valid (no markers).
 * @returns {{ markers: Array<{match:string,emoji:string}>, error: string|null }}
 */
function parseReplyMarkers(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const markers = [];
  for (const line of lines) {
    const parts = line.split(SEPARATOR);
    const match = (parts[0] || '').trim();
    const emoji = (parts[1] || '').trim().replace(/^:|:$/g, '').toLowerCase();
    if (parts.length !== 2 || !match || !emoji) {
      return { markers: [], error: `"${line.slice(0, 60)}" — write each line as  text => :emoji:` };
    }
    if (!EMOJI.test(emoji)) return { markers: [], error: `"${emoji.slice(0, 40)}" is not an emoji name (e.g. :thumbsup: or :question:)` };
    markers.push({ match, emoji });
  }
  return { markers, error: null };
}

/** Back to the modal's text format (for editing an existing trigger). */
function formatReplyMarkers(markers) {
  return (markers || []).map((m) => `${m.match} => :${m.emoji}:`).join('\n');
}

/** The first marker whose phrase appears in the reply (case-insensitive), or null. */
function findReplyMarker(markers, text) {
  const haystack = String(text || '').toLowerCase();
  if (!haystack) return null;
  return (markers || []).find((m) => haystack.includes(m.match.toLowerCase())) || null;
}

/** Memoised reader for a thread's messages (root included), so several triggers share one fetch. */
function threadReader(client, channel, ts) {
  let pending = null;
  return () => {
    pending = pending || (async () => {
      const out = [];
      let cursor;
      do {
        const res = await client.conversations.replies({ channel, ts, cursor, limit: 200 });
        out.push(...(res.messages || []));
        cursor = res.response_metadata?.next_cursor;
      } while (cursor);
      return out;
    })();
    return pending;
  };
}

/**
 * The approval marker that already settles this post, or null: the bot reacted on the root with an
 * approval marker's emoji, or a reply in the thread (not the bot's own) matches one. Fetches the thread
 * only when the trigger has an approval marker and the root carries no bot approval.
 * @param {{ root: object, markers: Array, botUserId?: string, botId?: string, readThread: () => Promise<object[]> }} args
 */
async function findSettlingMarker({ root, markers, botUserId, botId, readThread }) {
  const approvals = (markers || []).filter((m) => isApprovalReaction(m.emoji));
  if (!approvals.length || !root) return null;
  if (botUserId) {
    const mine = (root.reactions || []).filter((r) => isApprovalReaction(r.name) && (r.users || []).includes(botUserId));
    const byEmoji = mine.map((r) => approvals.find((m) => m.emoji === r.name.split('::')[0])).find(Boolean);
    if (byEmoji) return byEmoji;
  }
  if (!root.reply_count) return null;
  const replies = (await readThread()).filter((r) => r.ts !== root.ts
    && !(botUserId && r.user === botUserId) && !(botId && r.bot_id === botId));
  for (const reply of replies) {
    const marker = findReplyMarker(approvals, reply.text);
    if (marker) return marker;
  }
  return null;
}

module.exports = {
  parseReplyMarkers, formatReplyMarkers, findReplyMarker, isApprovalReaction, threadReader, findSettlingMarker,
};
