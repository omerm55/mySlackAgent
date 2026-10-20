'use strict';

// Security review SNS-133715, condition 1: `state` proves who started the flow, not who consented. The
// consenting Atlassian account must be the Jira user found for the Slack user's e-mail; otherwise the
// callback is rejected and nothing is stored.
jest.mock('axios');
const axios = require('axios');
const OAuthService = require('../src/services/oauthService');
const { AccountBindingError } = OAuthService;

const base = { clientId: 'cid', clientSecret: 'sec', redirectUri: 'https://bot/oauth/callback', jiraBaseUrl: 'https://x.atlassian.net' };
const stateOf = (url) => new URL(url).searchParams.get('state');

let consenting; let slackEmail; let candidates; let serviceJira; let slackClient;

beforeEach(() => {
  consenting = 'acc-me'; slackEmail = 'me@sisense.com'; candidates = ['acc-me'];
  axios.post.mockReset(); axios.get.mockReset();
  axios.post.mockResolvedValue({ data: { access_token: 'at', refresh_token: 'rt', expires_in: 3600 } });
  axios.get.mockImplementation(async (url, cfg) => {
    if (url === 'https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/myself') {
      expect(cfg.headers.Authorization).toBe('Bearer at'); // the user's own token, not the service account
      return { data: { accountId: consenting } };
    }
    return { data: [{ id: 'cloud-1', url: 'https://x.atlassian.net' }] };
  });
  serviceJira = { findAccountIdsByEmail: jest.fn(async () => candidates) };
  slackClient = { users: { info: jest.fn(async () => ({ user: { profile: { email: slackEmail } } })) } };
});

async function connect(oauth, user = 'U1') {
  return oauth.handleCallback('code', stateOf(await oauth.generateAuthUrl(user)));
}

describe('account binding on the OAuth callback', () => {
  test('the consenting account is the Slack user\'s own → stored', async () => {
    const oauth = new OAuthService({ ...base, serviceJira, slackClient });
    await connect(oauth);
    expect(oauth.hasToken('U1')).toBe(true);
    expect(slackClient.users.info).toHaveBeenCalledWith({ user: 'U1' });
    expect(serviceJira.findAccountIdsByEmail).toHaveBeenCalledWith('me@sisense.com');
  });

  test.each([
    ['mismatch', () => { consenting = 'acc-someone-else'; }],
    ['not_found', () => { candidates = []; }],
    ['ambiguous', () => { candidates = ['acc-me', 'acc-twin']; }],
    ['no_slack_email', () => { slackEmail = undefined; }],
  ])('%s → AccountBindingError, nothing stored in memory or the database', async (reason, arrange) => {
    arrange();
    const db = {
      insertOauthState: jest.fn(async ({ state, slackUserId }) => { db.row = { state, slack_user_id: slackUserId }; }),
      consumeOauthState: jest.fn(async () => db.row),
      upsertToken: jest.fn().mockResolvedValue(undefined),
    };
    const oauth = new OAuthService({ ...base, db, serviceJira, slackClient });
    const err = await connect(oauth).catch((e) => e);
    expect(err).toBeInstanceOf(AccountBindingError);
    expect(err).toMatchObject({ code: 'account_mismatch', reason, slackUserId: 'U1' });
    expect(oauth.hasToken('U1')).toBe(false);
    expect(db.upsertToken).not.toHaveBeenCalled();
  });

  test('a failing lookup rejects (lookup_failed) rather than letting the token through', async () => {
    serviceJira.findAccountIdsByEmail.mockRejectedValue(new Error('403'));
    const oauth = new OAuthService({ ...base, serviceJira, slackClient });
    await expect(connect(oauth)).rejects.toMatchObject({ reason: 'lookup_failed' });
    expect(oauth.hasToken('U1')).toBe(false);
  });

  test('without the lookup dependencies every callback is rejected — the check is not optional', async () => {
    const oauth = new OAuthService(base);
    await expect(connect(oauth)).rejects.toMatchObject({ reason: 'not_configured' });
    expect(oauth.hasToken('U1')).toBe(false);
  });
});

describe('verifyStoredBindings — connections made before the check existed', () => {
  const stored = (oauth, ids) => ids.forEach((id) => oauth.tokens.set(id, { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600e3, cloudId: 'cloud-1' }));

  test('ok tokens stay, a mismatch is disconnected, an unverifiable one is kept and reported', async () => {
    const db = { deleteToken: jest.fn().mockResolvedValue(undefined) };
    const oauth = new OAuthService({ ...base, db, serviceJira, slackClient });
    stored(oauth, ['U_OK', 'U_BAD', 'U_HIDDEN']);
    serviceJira.findAccountIdsByEmail.mockImplementation(async () => candidates);
    slackClient.users.info.mockImplementation(async ({ user }) => {
      candidates = { U_OK: ['acc-me'], U_BAD: ['acc-other'], U_HIDDEN: [] }[user];
      return { user: { profile: { email: `${user}@sisense.com` } } };
    });

    const res = await oauth.verifyStoredBindings();
    expect(res).toEqual({ checked: 3, ok: 1, removed: ['U_BAD'], unverified: [{ slackUserId: 'U_HIDDEN', reason: 'not_found' }] });
    expect(oauth.hasToken('U_OK')).toBe(true);
    expect(oauth.hasToken('U_BAD')).toBe(false);
    expect(db.deleteToken).toHaveBeenCalledWith('U_BAD');
    expect(oauth.hasToken('U_HIDDEN')).toBe(true);
  });
});

describe('JiraService.findAccountIdsByEmail', () => {
  const JiraService = jest.requireActual('../src/services/jiraService');
  const svc = Object.create(JiraService.prototype);

  test('keeps human, active accounts whose e-mail matches or is hidden; drops prefix matches and apps', async () => {
    svc.client = { get: jest.fn().mockResolvedValue({ data: [
      { accountId: 'a', accountType: 'atlassian', emailAddress: 'Me@Sisense.com' },
      { accountId: 'b', accountType: 'atlassian' }, // e-mail hidden by profile privacy
      { accountId: 'c', accountType: 'atlassian', emailAddress: 'me@sisense.com.au' }, // prefix match
      { accountId: 'd', accountType: 'app' },
      { accountId: 'e', accountType: 'atlassian', emailAddress: 'me@sisense.com', active: false },
    ] }) };
    expect(await svc.findAccountIdsByEmail(' me@sisense.com ')).toEqual(['a', 'b']);
    expect(svc.client.get).toHaveBeenCalledWith('/rest/api/3/user/search', { params: { query: 'me@sisense.com', maxResults: 10 } });
  });

  test('throws on API errors (the binding must not mistake an outage for "nobody")', async () => {
    svc.client = { get: jest.fn().mockRejectedValue(new Error('500')) };
    await expect(svc.findAccountIdsByEmail('me@sisense.com')).rejects.toThrow('500');
  });
});
