'use strict';

const http = require('http');

/**
 * Minimal HTTP server for the Atlassian OAuth 2.0 callback.
 * Runs alongside the Bolt Socket Mode process on OAUTH_PORT (default 3000).
 *
 * For local development, expose it with:
 *   ngrok http 3000
 * then set OAUTH_REDIRECT_URI=https://<your-ngrok-url>/oauth/callback
 *
 * @param {import('../services/oauthService')} oauthService
 * @param {number} port
 * @param {import('pino').Logger} logger
 * @returns {http.Server}
 */
function startCallbackServer(oauthService, port, logger) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);

    if (url.pathname !== '/oauth/callback') {
      res.writeHead(404);
      res.end();
      return;
    }

    const code = url.searchParams.get('code');
    const slackUserId = url.searchParams.get('state');

    if (!code || !slackUserId) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(page('400 Bad Request', 'Missing <code>code</code> or <code>state</code> parameter.'));
      return;
    }

    try {
      await oauthService.handleCallback(code, slackUserId);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(page(
        '✅ Jira connected!',
        'You can close this tab. Future Jira changes you trigger will appear as your own account.',
      ));
    } catch (err) {
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

function page(heading, body) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${heading}</title>
<style>body{font-family:system-ui,sans-serif;max-width:480px;margin:80px auto;padding:0 24px;color:#1a1f2e}h1{font-size:1.5rem}p{color:#5a6478}</style>
</head><body><h1>${heading}</h1><p>${body}</p></body></html>`;
}

module.exports = { startCallbackServer };
