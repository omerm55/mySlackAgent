'use strict';

// OAuth tokens at rest: encrypted on write, decrypted on read, legacy plaintext rows re-encrypted once
// on load, boot refuses to run when rows are encrypted but the key is missing, Disconnect deletes.
const crypto = require('crypto');
const DbService = require('../src/services/dbService');
const OAuthService = require('../src/services/oauthService');
const { TokenCrypto } = require('../src/utils/tokenCrypto');

const KEY = crypto.randomBytes(32).toString('base64');
const opts = { clientId: 'cid', clientSecret: 'sec', redirectUri: 'https://bot/cb', jiraBaseUrl: 'https://x.atlassian.net' };

// A fake pool answering the four statements DbService issues for oauth_tokens — enough to test what
// this file is about (encryption at rest). The SQL itself runs against a real Postgres in
// dbService.integration.test.js.
function fakeDb(rows, tokenCrypto) {
  const pool = {
    query: jest.fn(async (sql, params = []) => {
      if (sql.startsWith('insert into oauth_tokens')) {
        const [slack_user_id, access_token, refresh_token, expires_at, cloud_id] = params;
        rows.set(slack_user_id, { slack_user_id, access_token, refresh_token, expires_at, cloud_id });
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('select * from oauth_tokens where slack_user_id')) {
        const r = rows.get(params[0]);
        return { rows: r ? [r] : [], rowCount: r ? 1 : 0 };
      }
      if (sql.startsWith('select * from oauth_tokens')) {
        return { rows: [...rows.values()], rowCount: rows.size };
      }
      if (sql.startsWith('delete from oauth_tokens')) {
        rows.delete(params[0]);
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    }),
  };
  const db = new DbService({ pool, tokenCrypto });
  db.writes = () => pool.query.mock.calls.filter(([sql]) => sql.startsWith('insert into oauth_tokens')).length;
  return db;
}
const row = (id, at, rt) => ({ slack_user_id: id, access_token: at, refresh_token: rt, expires_at: new Date(Date.now() + 3600e3), cloud_id: 'c1' });

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
  const oauth = new OAuthService({ ...opts, db });
  await oauth.loadFromDb();
  expect(oauth.hasToken('U1')).toBe(true); expect(oauth.hasToken('U2')).toBe(true);
  expect(oauth.tokens.get('U1').accessToken).toBe('plain-at');
  expect(rows.get('U1').access_token).toMatch(/^enc:v1:/);              // rewritten
  expect(db.writes()).toBe(1);                                           // only the plaintext row
  await oauth.loadFromDb();
  expect(db.writes()).toBe(1);                                           // second load: nothing to do
});

test('rotation: rows under the previous key are readable and rewritten with the current key', async () => {
  const oldKey = crypto.randomBytes(32).toString('base64');
  const rows = new Map([['U1', row('U1', new TokenCrypto(oldKey).encrypt('at'), new TokenCrypto(oldKey).encrypt('rt'))]]);
  const db = fakeDb(rows, new TokenCrypto(KEY, oldKey));
  const oauth = new OAuthService({ ...opts, db });
  await oauth.loadFromDb();
  expect(oauth.tokens.get('U1').accessToken).toBe('at');
  expect(new TokenCrypto(KEY).decrypt(rows.get('U1').access_token)).toBe('at'); // now under the current key alone
});

test('encrypted rows without a key → loadFromDb throws encryption_key_missing (boot must fail)', async () => {
  const rows = new Map([['U1', row('U1', new TokenCrypto(KEY).encrypt('at'), new TokenCrypto(KEY).encrypt('rt'))]]);
  const db = fakeDb(rows, null);
  const oauth = new OAuthService({ ...opts, db });
  await expect(oauth.loadFromDb()).rejects.toMatchObject({ code: 'encryption_key_missing' });
});

test('without a key and only plaintext rows (local dev) loading still works', async () => {
  const rows = new Map([['U1', row('U1', 'at', 'rt')]]);
  const oauth = new OAuthService({ ...opts, db: fakeDb(rows, null) });
  await oauth.loadFromDb();
  expect(oauth.tokens.get('U1').accessToken).toBe('at');
});

test('disconnect forgets the token in memory and in the DB', async () => {
  const rows = new Map([['U1', row('U1', 'at', 'rt')]]);
  const db = fakeDb(rows, new TokenCrypto(KEY));
  const oauth = new OAuthService({ ...opts, db });
  await oauth.loadFromDb();
  await oauth.disconnect('U1');
  expect(oauth.hasToken('U1')).toBe(false);
  expect(rows.has('U1')).toBe(false);
});
