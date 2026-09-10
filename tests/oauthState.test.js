'use strict';

// The OAuth `state` must be random, single-use and expiring — never the Slack user id.
jest.mock('axios');
const axios = require('axios');
const OAuthService = require('../src/services/oauthService');
const { OAuthStateError, STATE_TTL_MS } = OAuthService;

const opts = { clientId: 'cid', clientSecret: 'sec', redirectUri: 'https://bot/oauth/callback', jiraBaseUrl: 'https://x.atlassian.net' };
const stateOf = (url) => new URL(url).searchParams.get('state');

beforeEach(() => {
  axios.post.mockReset(); axios.get.mockReset();
  axios.post.mockResolvedValue({ data: { access_token: 'at', refresh_token: 'rt', expires_in: 3600 } });
  axios.get.mockResolvedValue({ data: [{ id: 'cloud-1', url: 'https://x.atlassian.net' }] });
});

describe('OAuth state — memory mode (no Supabase)', () => {
  test('URL carries a random state, not the user id; the state is accepted exactly once', async () => {
    const oauth = new OAuthService(opts);
    const url = await oauth.generateAuthUrl('U1');
    const state = stateOf(url);
    expect(state).not.toBe('U1');
    expect(state).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(stateOf(await oauth.generateAuthUrl('U1'))).not.toBe(state); // fresh every time

    await oauth.handleCallback('code-1', state);
    expect(oauth.hasToken('U1')).toBe(true);
    expect(axios.post).toHaveBeenCalledWith('https://auth.atlassian.com/oauth/token', expect.objectContaining({ code: 'code-1' }));

    await expect(oauth.handleCallback('code-2', state)).rejects.toBeInstanceOf(OAuthStateError); // replay
    expect(axios.post).toHaveBeenCalledTimes(1);
  });

  test('unknown, malformed and expired states are rejected before any token exchange', async () => {
    const oauth = new OAuthService(opts);
    await expect(oauth.handleCallback('c', 'U1')).rejects.toMatchObject({ code: 'invalid_state' });
    await expect(oauth.handleCallback('c', '')).rejects.toMatchObject({ code: 'invalid_state' });
    await expect(oauth.handleCallback('c', 'x'.repeat(500))).rejects.toMatchObject({ code: 'invalid_state' });
    const url = await oauth.generateAuthUrl('U2');
    const state = stateOf(url);
    oauth.states.get(state).expiresAt = Date.now() - 1; // simulate 24 h passing
    await expect(oauth.handleCallback('c', state)).rejects.toMatchObject({ reason: 'expired' });
    expect(axios.post).not.toHaveBeenCalled();
    expect(STATE_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe('OAuth state — Supabase mode', () => {
  test('state is inserted, consumed atomically through the DB, and pruning is fire-and-forget', async () => {
    const rows = new Map();
    const db = {
      insertOauthState: jest.fn(async ({ state, slackUserId, expiresAt }) => { rows.set(state, { state, slack_user_id: slackUserId, expires_at: expiresAt, used_at: null }); }),
      consumeOauthState: jest.fn(async (state) => {
        const r = rows.get(state);
        if (!r || r.used_at || r.expires_at < Date.now()) return null;
        r.used_at = Date.now(); return r;
      }),
      pruneOauthStates: jest.fn().mockResolvedValue(undefined),
      upsertToken: jest.fn().mockResolvedValue(undefined),
    };
    const oauth = new OAuthService({ ...opts, supabaseService: db });
    const state = stateOf(await oauth.generateAuthUrl('U9'));
    expect(db.insertOauthState).toHaveBeenCalledWith(expect.objectContaining({ state, slackUserId: 'U9' }));
    expect(oauth.states.size).toBe(0); // DB is the single source of truth

    await oauth.handleCallback('code', state);
    expect(oauth.hasToken('U9')).toBe(true);
    expect(db.upsertToken).toHaveBeenCalledWith('U9', expect.objectContaining({ accessToken: 'at', cloudId: 'cloud-1' }));
    expect(db.pruneOauthStates).toHaveBeenCalled();

    await expect(oauth.handleCallback('code', state)).rejects.toBeInstanceOf(OAuthStateError);
    expect(axios.post).toHaveBeenCalledTimes(1);
  });
});
