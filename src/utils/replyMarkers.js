'use strict';

/**
 * Reply markers on a channel trigger — when a thread reply contains a phrase, the bot reacts with an
 * emoji on the thread's root message and writes nothing to Jira.
 *
 * Built for the PM-reviewed channel: a scheduled review replies ":robot_face: Auto-verified …" (it has
 * already set the field) or ":triangular_flag_on_post: Needs a decision …" (the field must stay unset),
 * and the channel should show at a glance which posts are done (👍) and which wait on a person (❓).
 *
 * Trigger config: integrations.reply_markers jsonb = [{ match, emoji }].
 * In the trigger modal it is typed one marker per line: `Auto-verified => :thumbsup:`.
 */

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

module.exports = { parseReplyMarkers, formatReplyMarkers, findReplyMarker };
