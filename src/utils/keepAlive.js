'use strict';

const axios = require('axios');

/**
 * Keep a free-tier Render instance awake by pinging our own /health endpoint.
 *
 * Render spins down free web services after 15 minutes without inbound HTTP.
 * Our Slack traffic is an outbound WebSocket (Socket Mode) and doesn't count,
 * so without this the bot — and the Jira poller — go silent after 15 idle
 * minutes. A self-request counts as inbound traffic and resets the timer.
 *
 * Note: this can only keep an awake instance awake. It cannot revive one that
 * is already asleep — pair it with an external pinger or a paid instance.
 *
 * URL resolution: KEEP_ALIVE_URL, else RENDER_EXTERNAL_URL + /health (Render
 * sets RENDER_EXTERNAL_URL automatically). No URL → disabled (local dev).
 *
 * @returns {NodeJS.Timeout|null}
 */
function startKeepAlive({ logger, intervalMs } = {}) {
  const base = process.env.KEEP_ALIVE_URL
    || (process.env.RENDER_EXTERNAL_URL ? `${process.env.RENDER_EXTERNAL_URL.replace(/\/+$/, '')}/health` : null);
  if (!base) {
    logger?.info('[keepAlive] Disabled (no KEEP_ALIVE_URL / RENDER_EXTERNAL_URL)');
    return null;
  }
  if (process.env.KEEP_ALIVE_DISABLED === 'true') {
    logger?.info('[keepAlive] Disabled via KEEP_ALIVE_DISABLED');
    return null;
  }

  const every = intervalMs ?? Math.max(60, parseInt(process.env.KEEP_ALIVE_INTERVAL_SEC || '300', 10) || 300) * 1000;
  let failures = 0;

  const ping = async () => {
    try {
      await axios.get(base, { timeout: 10_000, headers: { 'User-Agent': 'slack-jira-bot-keepalive' } });
      if (failures > 0) logger?.info(`[keepAlive] Recovered after ${failures} failed ping(s)`);
      failures = 0;
    } catch (err) {
      failures += 1;
      // Log the first failure and then every 10th, to avoid noise if the URL is wrong
      if (failures === 1 || failures % 10 === 0) {
        logger?.warn(`[keepAlive] Ping failed (${failures}×): ${err.response?.status || err.message}`);
      }
    }
  };

  logger?.info(`[keepAlive] Pinging ${base} every ${Math.round(every / 1000)}s`);
  const timer = setInterval(ping, every);
  timer.unref?.(); // never keep the process alive just for this timer
  return timer;
}

module.exports = { startKeepAlive };
