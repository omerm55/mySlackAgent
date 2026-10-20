'use strict';

const http = require('http');

/**
 * Minimal HTTP server for the Atlassian OAuth 2.0 callback and the health check.
 * Runs alongside the Bolt Socket Mode process. Deliberately nothing else: every other path is 404.
 * (A `/send-dm` test endpoint existed until Sept 2026 — unauthenticated, it let anyone make the bot
 * DM any employee a real-looking ask. Removed; test asks are done with a personal-scope trigger.)
 *
 * On Render (and other PaaS), PORT env var overrides the oauthPort argument.
 * For local development, set OAUTH_PORT (default 3000) and expose with a tunnel.
 *
 * @param {import('../services/oauthService')} oauthService
 * @param {number} oauthPort  Fallback port (from OAUTH_PORT env var)
 * @param {import('pino').Logger} logger
 * @param {import('../utils/opsNotifier')} [opsNotifier]  told about every rejected account binding
 * @returns {http.Server}
 */
function startCallbackServer(oauthService, oauthPort, logger, opsNotifier = null) {
  // Render (and most PaaS) set PORT; fall back to the configured OAUTH_PORT for local dev.
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : oauthPort;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);

    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }

    if (url.pathname !== '/oauth/callback') {
      res.writeHead(404);
      res.end();
      return;
    }

    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');

    if (!code || !state) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(page('400 Bad Request', 'Missing <code>code</code> or <code>state</code> parameter.'));
      return;
    }

    try {
      await oauthService.handleCallback(code, state);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(page(
        '✅ Jira connected!',
        'You can close this tab. Future Jira changes you trigger will appear as your own account.',
      ));
    } catch (err) {
      if (err.code === 'invalid_state') {
        // Not an error on our side: a reused, stale or forged link. Say so and point at the fix.
        logger.warn(`[oauth] Callback with ${err.reason} state`);
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(page('⏳ This link has expired or was already used', 'Open the bot\'s Home tab in Slack and press <b>Connect Jira</b> again to get a fresh link.'));
        return;
      }
      if (err.code === 'account_mismatch') {
        // The person consented as an Atlassian account that is not theirs (or we could not prove it is).
        // Nothing was stored. Reason only — never the e-mail addresses involved.
        logger.warn(`[oauth] Callback rejected for ${err.slackUserId}: account ${err.reason}`);
        opsNotifier?.post(
          `⛔ Jira connect rejected for <@${err.slackUserId}>: ${BINDING_REASONS[err.reason] || err.reason}. Nothing was stored.`,
          { kind: 'oauth_binding_rejected', user: err.slackUserId, ok: false, detail: { reason: err.reason } },
        ).catch(() => {});
        res.writeHead(403, { 'Content-Type': 'text/html' });
        res.end(page(
          '⛔ This Atlassian account is not yours',
          'The Atlassian account you signed in with does not match your Slack account, so nothing was connected. ' +
          'Sign in to Atlassian with your own Sisense account and press <b>Connect Jira</b> again in the bot\'s Home tab. ' +
          'If you already did, your Slack and Atlassian e-mail addresses may differ — ask the bot\'s owner (PH Ops).',
        ));
        return;
      }
      logger.error({ err: err.message }, '[oauth] Callback error');
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end(page('❌ Authorization failed', 'Something went wrong. Please try connecting again.'));
    }
  });

  server.listen(port, () => {
    logger.info({ port }, '[oauth] Callback server listening');
  });


  return server;
}

// Ops-channel wording for AccountBindingError reasons (oauthService).
const BINDING_REASONS = {
  mismatch: 'the Atlassian account belongs to someone else',
  not_found: 'no Jira user matches their Slack e-mail',
  ambiguous: 'more than one Jira user matches their Slack e-mail',
  no_slack_email: 'their Slack profile has no e-mail',
  lookup_failed: 'the account check could not complete (Slack or Jira API error)',
  not_configured: 'the account check is not configured',
};

function page(heading, body) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${heading}</title>
<style>body{font-family:system-ui,sans-serif;max-width:480px;margin:80px auto;padding:0 24px;color:#1a1f2e}h1{font-size:1.5rem}p{color:#5a6478}</style>
</head><body><h1>${heading}</h1><p>${body}</p></body></html>`;
}

module.exports = { startCallbackServer, BINDING_REASONS };
