'use strict';

// The public HTTP surface is exactly: /oauth/callback and /health. Nothing else — in particular the
// old unauthenticated /send-dm test endpoint must stay gone (it let anyone make the bot DM any
// employee a real-looking ask).
const http = require('http');
const { startCallbackServer } = require('../src/server/callbackServer');

function get(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

describe('callback server surface', () => {
  let server; let port;
  const oauth = { handleCallback: jest.fn().mockResolvedValue(undefined) };
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

  beforeAll(async () => {
    delete process.env.PORT;
    server = startCallbackServer(oauth, 0, logger); // 0 = ephemeral port
    await new Promise((r) => server.once('listening', r));
    port = server.address().port;
  });
  afterAll(() => new Promise((r) => server.close(r)));

  test('/health → 200 ok', async () => {
    expect(await get(port, '/health')).toEqual({ status: 200, body: 'ok' });
  });

  test('/send-dm is gone → 404, and nothing is sent', async () => {
    const res = await get(port, '/send-dm?user=U1&issue=SNS-1&fieldId=customfield_1&value=Yes&question=hi');
    expect(res.status).toBe(404);
    expect(oauth.handleCallback).not.toHaveBeenCalled();
  });

  test('unknown paths → 404', async () => {
    expect((await get(port, '/anything')).status).toBe(404);
  });

  test('/oauth/callback without code/state → 400; with both → handleCallback(code, state)', async () => {
    expect((await get(port, '/oauth/callback')).status).toBe(400);
    const ok = await get(port, '/oauth/callback?code=abc&state=xyz');
    expect(ok.status).toBe(200);
    expect(oauth.handleCallback).toHaveBeenCalledWith('abc', 'xyz');
  });
});
