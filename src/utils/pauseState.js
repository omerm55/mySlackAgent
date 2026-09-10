'use strict';

/**
 * Global pause — the kill switch.
 *
 * When paused the bot stops *acting*: no trigger is evaluated, no ask is sent, and every write path
 * refuses and writes nothing (the ask and its prompt row are left intact, so people can act once it
 * resumes). Reading Slack events, App Home and the operator channel keep working, so an admin can see
 * what is happening and resume.
 *
 * Two independent switches, either of which pauses:
 *   - `app_settings.paused` in Supabase — an admin toggles it from App Home, no deploy needed.
 *   - `BOT_PAUSED=true` in the environment — break-glass for when Supabase itself is the problem.
 *
 * The DB value is cached for CACHE_MS so a paused bot does not query on every event; toggling from Home
 * calls `invalidate()`, so the switch is immediate for the person flipping it.
 */

const KEY = 'paused';
const CACHE_MS = 30_000;

let cache = { at: 0, value: null }; // value: {paused, by, at} | null

const envPaused = () => String(process.env.BOT_PAUSED || '').toLowerCase() === 'true';

/** Clear the cache — call right after writing the flag. */
function invalidate() {
  cache = { at: 0, value: null };
}

/**
 * Current pause state, including who set it (for the Home text and the ops line).
 * A database failure is treated as "not paused": the switch must never take the bot down by itself.
 * @returns {Promise<{paused: boolean, by: string|null, at: string|null, source: 'env'|'db'|'none'}>}
 */
async function pauseState(db) {
  if (envPaused()) return { paused: true, by: null, at: null, source: 'env' };
  if (!db?.getSetting) return { paused: false, by: null, at: null, source: 'none' };
  if (Date.now() - cache.at < CACHE_MS && cache.value !== null) {
    const v = cache.value;
    return { paused: !!v.paused, by: v.by ?? null, at: v.at ?? null, source: v.paused ? 'db' : 'none' };
  }
  try {
    const row = await db.getSetting(KEY);
    const v = { paused: !!row?.value?.paused, by: row?.updated_by ?? null, at: row?.updated_at ?? null };
    cache = { at: Date.now(), value: v };
    return { ...v, source: v.paused ? 'db' : 'none' };
  } catch {
    return { paused: false, by: null, at: null, source: 'none' };
  }
}

/** @returns {Promise<boolean>} */
async function isPaused(db) {
  return (await pauseState(db)).paused;
}

/** Flip the flag (App Home). `byUser` is a Slack user id, recorded for the audit trail. */
async function setPaused(db, on, byUser = null) {
  if (!db?.setSetting) throw new Error('Supabase is not configured — use the BOT_PAUSED environment variable');
  await db.setSetting(KEY, { paused: !!on }, byUser);
  invalidate();
}

/** One line for App Home / the ops channel. */
function describePause(state) {
  if (!state.paused) return '▶️ *Running* — triggers are evaluated and actions are applied.';
  if (state.source === 'env') return '⏸ *Paused* by the `BOT_PAUSED` environment variable. Nothing is sent and no change is written.';
  const who = state.by ? `<@${state.by}>` : 'an admin';
  const when = state.at ? ` on ${new Date(state.at).toISOString().slice(0, 16).replace('T', ' ')} UTC` : '';
  return `⏸ *Paused* by ${who}${when}. Nothing is sent and no change is written.`;
}

module.exports = { KEY, CACHE_MS, isPaused, pauseState, setPaused, invalidate, describePause, envPaused };
