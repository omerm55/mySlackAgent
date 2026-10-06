#!/usr/bin/env node
'use strict';

/**
 * Apply reply markers to threads answered before the markers were configured (§12.2c).
 *
 *   SLACK_BOT_TOKEN=xoxb-… node scripts/backfill-reply-markers.js \
 *     --channel C0AMJMZHTE2 --since 2026-10-04 \
 *     --marker 'Auto-verified => :thumbsup:' --marker 'Needs a decision => :question:'
 *
 * Dry run by default: prints what it would mark. Add --apply to react.
 *
 * It must run with the BOT token: the reactions then look exactly like the live ones and are ignored
 * by the reaction trigger. A person's 👍 would be read as an approval and write the Jira field.
 *
 * Same rules as the live path (replyHandler): only root posts with a Jira key, every marker-matching
 * reply in the thread except the bot's own, one reaction per emoji. Scope and allowlist are not
 * applied — pass only the markers of a trigger whose replies you mean to honour.
 */

const { extractJiraIssueKeys } = require('../src/utils/jiraLinkParser');
const { parseReplyMarkers, findReplyMarker } = require('../src/utils/replyMarkers');

async function pages(call, args, key) {
  const out = [];
  let cursor;
  do {
    const res = await call({ ...args, cursor, limit: 200 });
    out.push(...(res[key] || []));
    cursor = res.response_metadata?.next_cursor;
  } while (cursor);
  return out;
}

/**
 * @returns {Promise<{ threads: number, marked: Array<{ts:string, keys:string[], emoji:string, match:string, result:string}> }>}
 */
async function backfill({ client, channel, oldest, markers, apply = false, log = () => {} }) {
  const { user_id: botUserId, bot_id: botId } = await client.auth.test();
  const roots = (await pages((a) => client.conversations.history(a), { channel, oldest }, 'messages'))
    .filter((m) => m.reply_count > 0 && extractJiraIssueKeys(m.text).length > 0);
  const marked = [];
  for (const root of roots) {
    const keys = extractJiraIssueKeys(root.text);
    const replies = (await pages((a) => client.conversations.replies(a), { channel, ts: root.ts }, 'messages'))
      .filter((r) => r.ts !== root.ts && r.user !== botUserId && !(botId && r.bot_id === botId));
    const emojis = new Map();
    for (const reply of replies) {
      const marker = findReplyMarker(markers, reply.text);
      if (marker && !emojis.has(marker.emoji)) emojis.set(marker.emoji, marker);
    }
    for (const [emoji, marker] of emojis) {
      const already = (root.reactions || []).some((r) => r.name === emoji && (r.users || []).includes(botUserId));
      let result = already ? 'already marked' : (apply ? 'marked' : 'would mark');
      if (!already && apply) {
        try {
          await client.reactions.add({ channel, timestamp: root.ts, name: emoji });
        } catch (err) {
          const code = err.data?.error || err.message;
          result = code === 'already_reacted' ? 'already marked' : `failed: ${code}`;
        }
      }
      marked.push({ ts: root.ts, keys, emoji, match: marker.match, result });
      log(`${keys.join(', ')}  :${emoji}:  (${marker.match})  ${result}`);
    }
  }
  return { threads: roots.length, marked };
}

function parseArgs(argv) {
  const opts = { markers: [], apply: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') opts.apply = true;
    else if (a === '--channel') opts.channel = argv[++i];
    else if (a === '--since') opts.since = argv[++i];
    else if (a === '--marker') opts.markers.push(argv[++i]);
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

module.exports = { backfill, parseArgs };

if (require.main === module) {
  (async () => {
    const opts = parseArgs(process.argv.slice(2));
    const token = process.env.SLACK_BOT_TOKEN;
    if (!token || !token.startsWith('xoxb-')) throw new Error('set SLACK_BOT_TOKEN to the bot token (xoxb-…) — never a user token');
    if (!opts.channel) throw new Error('--channel is required');
    const since = Date.parse(opts.since || '');
    if (Number.isNaN(since)) throw new Error('--since YYYY-MM-DD is required');
    const { markers, error } = parseReplyMarkers(opts.markers.join('\n'));
    if (error) throw new Error(error);
    if (!markers.length) throw new Error('pass at least one --marker');

    const { WebClient } = require('@slack/bolt').webApi;
    const client = new WebClient(token);
    const { threads, marked } = await backfill({
      client, channel: opts.channel, oldest: String(since / 1000), markers, apply: opts.apply, log: console.log,
    });
    const count = (r) => marked.filter((m) => m.result.startsWith(r)).length;
    console.log(`\n${threads} thread(s) with a Jira key since ${opts.since}; ${marked.length} mark(s): `
      + `${count('marked')} added, ${count('would mark')} to add, ${count('already')} already there, ${count('failed')} failed.`);
    const both = new Set(marked.map((m) => m.ts).filter((ts, i, all) => all.indexOf(ts) !== i));
    if (both.size) console.log(`${both.size} post(s) get more than one mark (e.g. flagged, then auto-verified on a re-run).`);
    if (!opts.apply) console.log('Dry run — re-run with --apply to react.');
  })().catch((err) => { console.error(`✗ ${err.message}`); process.exit(1); });
}
