'use strict';

// OAuth tokens at rest: encrypted on write, decrypted on read, legacy plaintext rows re-encrypted once
// on load, boot refuses to run when rows are encrypted but the key is missing, Disconnect deletes.
const crypto = require('crypto');
const SupabaseService = require('../src/services/supabaseService');
const OAuthService = require('../src/services/oauthService');
const { TokenCrypto } = require('../src/utils/tokenCrypto');

const KEY = crypto.randomBytes(32).toString('base64');
const opts = { clientId: 'cid', clientSecret: 'sec', redirectUri: 'https://bot/cb', jiraBaseUrl: 'https://x.atlassian.net' };

function fakeDb(rows, tokenCrypto) {
  const db = new SupabaseService({ url: 'https://s.example', secretKey: 'k', tokenCrypto });
  db.client = {
    post: jest.fn(async (path, body) => { if (path === '/oauth_tokens') rows.set(body.slack_user_id, body); return { data: [] }; }),
    get: jest.fn(async (path, cfg) => {
      if (cfg?.params?.slack_user_id) { const id = cfg.params.slack_user_id.replace('eq.', ''); return { data: rows.has(id) ? [rows.get(id)] : [] }; }
      return { data: [...rows.values()] };
    }),
    delete: jest.fn(async (path, cfg) => { rows.delete(cfg.params.slack_user_id.replace('eq.', '')); return {}; }),
    patch: jest.fn(),
  };
  return db;
}
const row = (id, at, rt) => ({ slack_user_id: id, access_token: at, refresh_token: rt, expires_at: new Date(Date.now() + 3600e3).toISOString(), cloud_id: 'c1' });

test('upsertToken stores ciphertext; getToken / getAllTokens return plaintext', async () => {
  const rows = new Map();
  const db = fakeDb(rows, new TokenCrypto(KEY));
  await db.upsertToken('U1', { accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1000, cloudId: 'c1' });
  const stored = rows.get('U1');
  expect(stored.access_token).toMatch(/^enc:v1:/); expect(stored.refresh_token).toMatch(/^enc:v1:/);
  expect(JSON.stringify(stored)).not.toMatch(/"AT"|"RT"/);
  expect(await db.getToken('U1')).toMatchObject({ accessToken: 'AT', refreshToken: 'RT', cloudId: 'c1' });
  const all = await db.getAllTokens();
  expect(all[0]).toMatchObject({ access_token: 'AT', refresh_token: 'RT', needsRewrite: false });
});

test('loadFromDb re-encrypts legacy plaintext rows exactly once, keeps them usable', async () => {
  const rows = new Map([['U1', row('U1', 'plain-at', 'plain-rt')], ['U2', row('U2', new TokenCrypto(KEY).encrypt('e-at'), new TokenCrypto(KEY).encrypt('e-rt'))]]);
  const db = fakeDb(rows, new TokenCrypto(KEY));
  const oauth = new OAuthService({ ...opts, supabaseService: db });
  await oauth.loadFromDb();
  expect(oauth.hasToken('U1')).toBe(true); expect(oauth.hasToken('U2')).toBe(true);
  expect(oauth.tokens.get('U1').accessToken).toBe('plain-at');
  expect(rows.get('U1').access_token).toMatch(/^enc:v1:/);              // rewritten
  expect(db.client.post).toHaveBeenCalledTimes(1);                       // only the plaintext row
  await oauth.loadFromDb();
  expect(db.client.post).toHaveBeenCalledTimes(1);                       // second load: nothing to do
});

test('rotation: rows under the previous key are readable and rewritten with the current key', async () => {
  const oldKey = crypto.randomBytes(32).toString('base64');
  const rows = new Map([['U1', row('U1', new TokenCrypto(oldKey).encrypt('at'), new TokenCrypto(oldKey).encrypt('rt'))]]);
  const db = fakeDb(rows, new TokenCrypto(KEY, oldKey));
  const oauth = new OAuthService({ ...opts, supabaseService: db });
  await oauth.loadFromDb();
  expect(oauth.tokens.get('U1').accessToken).toBe('at');
  expect(new TokenCrypto(KEY).decrypt(rows.get('U1').access_token)).toBe('at'); // now under the current key alone
});

test('encrypted rows without a key → loadFromDb throws encryption_key_missing (boot must fail)', async () => {
  const rows = new Map([['U1', row('U1', new TokenCrypto(KEY).encrypt('at'), new TokenCrypto(KEY).encrypt('rt'))]]);
  const db = fakeDb(rows, null);
  const oauth = new OAuthService({ ...opts, supabaseService: db });
  await expect(oauth.loadFromDb()).rejects.toMatchObject({ code: 'encryption_key_missing' });
});

test('without a key and only plaintext rows (local dev) loading still works', async () => {
  const rows = new Map([['U1', row('U1', 'at', 'rt')]]);
  const oauth = new OAuthService({ ...opts, supabaseService: fakeDb(rows, null) });
  await oauth.loadFromDb();
  expect(oauth.tokens.get('U1').accessToken).toBe('at');
});

test('disconnect forgets the token in memory and in the DB', async () => {
  const rows = new Map([['U1', row('U1', 'at', 'rt')]]);
  const db = fakeDb(rows, new TokenCrypto(KEY));
  const oauth = new OAuthService({ ...opts, supabaseService: db });
  await oauth.loadFromDb();
  await oauth.disconnect('U1');
  expect(oauth.hasToken('U1')).toBe(false);
  expect(rows.has('U1')).toBe(false);
});
