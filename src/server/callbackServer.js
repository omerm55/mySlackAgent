'use strict';

const http = require('http');

/**
 * Minimal HTTP server for the Atlassian OAuth 2.0 callback and test endpoints.
 * Runs alongside the Bolt Socket Mode process.
 *
 * On Render (and other PaaS), PORT env var overrides the oauthPort argument.
 * For local development, set OAUTH_PORT (default 3000) and expose with a tunnel.
 *
 * @param {import('../services/oauthService')} oauthService
 * @param {number} oauthPort  Fallback port (from OAUTH_PORT env var)
 * @param {import('pino').Logger} logger
 * @param {object} [extras]
 * @param {import('@slack/bolt').App['client']} [extras.slackClient]
 * @param {import('../services/pendingQuestions')} [extras.pendingQuestions]
 * @param {import('../utils/dmQuestion').sendDmQuestion} [extras.sendDmQuestion]
 * @returns {http.Server}
 */
function startCallbackServer(oauthService, oauthPort, logger, extras = {}) {
  // Render (and most PaaS) set PORT; fall back to the configured OAUTH_PORT for local dev.
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : oauthPort;

  const { slackClient, pendingQuestions, sendDmQuestion } = extras;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);

    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }

    if (url.pathname === '/send-dm') {
      if (!slackClient || !pendingQuestions || !sendDmQuestion) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'DM service not initialised' }));
        return;
      }
      const user = url.searchParams.get('user');
      const issue = url.searchParams.get('issue');
      const fieldId = url.searchParams.get('fieldId');
      const fieldName = url.searchParams.get('fieldName') || fieldId;
      const value = url.searchParams.get('value');
      const fieldType = url.searchParams.get('fieldType') || 'select';
      const question = url.searchParams.get('question');
      if (!user || !issue || !fieldId || !value || !question) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Missing required params: user, issue, fieldId, value, question' }));
        return;
      }
      try {
        const result = await sendDmQuestion(slackClient, user, {
          issueKey: issue, question, jiraFieldId: fieldId, jiraFieldName: fieldName, jiraFieldValue: value, jiraFieldType: fieldType,
        }, pendingQuestions);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, channelId: result.channelId, messageTs: result.messageTs }));
      } catch (err) {
        logger.error({ err: err.message }, '[send-dm] Error');
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

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
