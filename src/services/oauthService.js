'use strict';

const crypto = require('crypto');
const axios = require('axios');
const { logger } = require('../utils/logger');
const JiraService = require('./jiraService');

// Connect links live in App Home and inside asks and are clicked later — a day, not the usual
// ten minutes. Single-use closes the replay window regardless of the TTL.
const STATE_TTL_MS = 24 * 60 * 60 * 1000;

/** Thrown by handleCallback when the `state` is unknown, expired or already used. */
class OAuthStateError extends Error {
  constructor(reason) {
    super(`OAuth state ${reason}`);
    this.code = 'invalid_state';
    this.reason = reason;
  }
}

/**
 * Thrown by handleCallback when the Atlassian account that consented is not the one that belongs to the
 * Slack user who started the flow (security review SNS-133715, condition 1). `state` proves who
 * *started* the flow; this proves who *consented*. Nothing is stored when it is thrown.
 * Reasons: mismatch (the lookup found someone else), not_found (no Jira user for the Slack e-mail),
 * ambiguous (more than one), no_slack_email, lookup_failed (an API call failed), not_configured.
 */
class AccountBindingError extends Error {
  constructor(reason, slackUserId) {
    super(`OAuth account binding failed: ${reason}`);
    this.code = 'account_mismatch';
    this.reason = reason;
    this.slackUserId = slackUserId;
  }
}

/**
 * Manages Atlassian OAuth 2.0 3LO tokens on a per-Slack-user basis.
 *
 * Flow:
 *   1. generateAuthUrl(slackUserId) → random single-use `state` stored (`oauth_states` in Postgres, or
 *      memory when there is no DB) → link shown in Home / DM
 *   2. User consents → Atlassian redirects to OAUTH_REDIRECT_URI?code=...&state=<random>
 *   3. handleCallback(code, state) → state consumed (unknown / expired / used → OAuthStateError)
 *      → exchanges code for tokens + resolves cloudId → account binding checked (the consenting
 *      accountId must be the Jira user found for the Slack user's e-mail, else AccountBindingError)
 *      → stored for the mapped Slack user
 *   4. getJiraService(slackUserId) → returns a JiraService instance authed as that user
 *
 * Tokens are cached in memory and persisted in Postgres (see loadFromDb).
 */
class OAuthService {
  /**
   * @param {object} opts
   * @param {string} opts.clientId       JIRA_OAUTH_CLIENT_ID
   * @param {string} opts.clientSecret   JIRA_OAUTH_CLIENT_SECRET
   * @param {string} opts.redirectUri    OAUTH_REDIRECT_URI (must match Atlassian dev console)
   * @param {string} opts.jiraBaseUrl    JIRA_BASE_URL — used to match the right cloud resource
   * @param {import('./jiraService')} opts.serviceJira  the service account, for the user lookup by e-mail
   * @param {object} opts.slackClient   Bolt's WebClient, for the Slack user's e-mail
   *   Without both, every callback is rejected (binding `not_configured`): the check is not optional.
   */
  constructor({ clientId, clientSecret, redirectUri, jiraBaseUrl, db = null, serviceJira = null, slackClient = null }) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.redirectUri = redirectUri;
    this.jiraBaseUrl = jiraBaseUrl;
    this.db = db;
    this.serviceJira = serviceJira;
    this.slackClient = slackClient;
    // In-memory cache — populated from the database at startup and on each write
    this.tokens = new Map();
    // Pending OAuth states when there is no DB (single process, lost on restart)
    this.states = new Map();
  }

  /**
   * Load all tokens from the database into the in-memory cache.
   * Called once at startup so hasToken() works without a DB round-trip per event.
   */
  async loadFromDb() {
    if (!this.db) return;
    try {
      const rows = await this.db.getAllTokens();
      let rewritten = 0;
      for (const row of rows) {
        const token = {
          accessToken: row.access_token,
          refreshToken: row.refresh_token,
          expiresAt: new Date(row.expires_at).getTime(),
          cloudId: row.cloud_id,
        };
        this.tokens.set(row.slack_user_id, token);
        // Lazy migration: plaintext rows (pre-encryption) and rows under a previous key are rewritten
        // once with the current key. Values are never logged.
        if (row.needsRewrite) {
          await this.db.upsertToken(row.slack_user_id, token)
            .then(() => { rewritten += 1; })
            .catch((err) => logger.warn(`[oauth] Could not re-encrypt token for ${row.slack_user_id}: ${err.message}`));
        }
      }
      logger.info(`[oauth] Loaded ${rows.length} token(s) from the database${rewritten ? ` (${rewritten} re-encrypted with the current key)` : ''}`);
    } catch (err) {
      if (err.code === 'encryption_key_missing') throw err; // boot must fail: tokens exist but cannot be read
      logger.warn(`[oauth] Could not load tokens from the database: ${err.message}`);
    }
  }

  /**
   * Forget a user's tokens (App Home → Disconnect). Atlassian 3LO has no revocation endpoint for
   * refresh tokens; the user revokes the app under id.atlassian.com → Connected apps if they want to.
   */
  async disconnect(slackUserId) {
    this.tokens.delete(slackUserId);
    if (this.db) await this.db.deleteToken(slackUserId);
    logger.info(`[oauth] Disconnected Slack user ${slackUserId}`);
  }

  /**
   * Build the Atlassian consent URL for a Slack user. The `state` is a fresh 256-bit random token
   * that maps to the user server-side, is single-use and expires after STATE_TTL_MS.
   * @param {string} slackUserId
   * @returns {Promise<string>}
   */
  async generateAuthUrl(slackUserId) {
    const state = crypto.randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + STATE_TTL_MS;
    if (this.db?.insertOauthState) {
      await this.db.insertOauthState({ state, slackUserId, expiresAt });
    } else {
      this.states.set(state, { slackUserId, expiresAt });
    }
    const params = new URLSearchParams({
      audience: 'api.atlassian.com',
      client_id: this.clientId,
      scope: 'read:jira-user write:jira-work read:jira-work offline_access',
      redirect_uri: this.redirectUri,
      state,
      response_type: 'code',
      prompt: 'consent',
    });
    return `https://auth.atlassian.com/authorize?${params}`;
  }

  /**
   * Resolve and burn a `state`. Returns the Slack user id, or throws OAuthStateError.
   * With a DB the row is consumed atomically (conditional UPDATE); otherwise the memory map is used.
   */
  async _consumeState(state) {
    if (!state || typeof state !== 'string' || state.length > 200) throw new OAuthStateError('malformed');
    if (this.db?.consumeOauthState) {
      const row = await this.db.consumeOauthState(state);
      this.db.pruneOauthStates?.().catch(() => {});
      if (!row) throw new OAuthStateError('unknown, expired or already used');
      return row.slack_user_id;
    }
    const entry = this.states.get(state);
    this.states.delete(state);
    if (!entry) throw new OAuthStateError('unknown or already used');
    if (entry.expiresAt < Date.now()) throw new OAuthStateError('expired');
    return entry.slackUserId;
  }

  /**
   * Exchange an authorization code for tokens and store them.
   * Called by the callback HTTP server. The `state` is consumed first (OAuthStateError if it is
   * unknown, expired or already used) and tells us which Slack user the tokens belong to. The tokens
   * are stored only if the consenting account is that user's own (AccountBindingError otherwise).
   * @param {string} code   authorization code from Atlassian
   * @param {string} state  the random `state` echoed back by Atlassian
   */
  async handleCallback(code, state) {
    const slackUserId = await this._consumeState(state);
    const tokenRes = await axios.post('https://auth.atlassian.com/oauth/token', {
      grant_type: 'authorization_code',
      client_id: this.clientId,
      client_secret: this.clientSecret,
      code,
      redirect_uri: this.redirectUri,
    });
    const { access_token, refresh_token, expires_in } = tokenRes.data;

    const cloudId = await this._resolveCloudId(access_token);
    await this._verifyAccount(slackUserId, access_token, cloudId);

    const tokenData = {
      accessToken: access_token,
      refreshToken: refresh_token,
      expiresAt: Date.now() + expires_in * 1000,
      cloudId,
    };
    this.tokens.set(slackUserId, tokenData);
    if (this.db) {
      await this.db.upsertToken(slackUserId, tokenData).catch((err) =>
        logger.warn(`[oauth] Failed to persist token to the database: ${err.message}`)
      );
    }
    logger.info(`[oauth] Token stored for Slack user ${slackUserId} (cloudId: ${cloudId})`);
  }

  /** @param {string} slackUserId */
  hasToken(slackUserId) {
    return this.tokens.has(slackUserId);
  }

  /**
   * Returns a JiraService instance authenticated as the given Slack user.
   * Automatically refreshes the token if it is within 5 minutes of expiry.
   * @param {string} slackUserId
   * @returns {Promise<import('./jiraService')|null>}
   */
  async getJiraService(slackUserId) {
    const token = this.tokens.get(slackUserId);
    if (!token) return null;

    if (Date.now() > token.expiresAt - 5 * 60 * 1000) {
      await this._refreshToken(slackUserId, token);
    }

    const current = this.tokens.get(slackUserId);
    return JiraService.fromOAuthToken(current.accessToken, current.cloudId);
  }

  /**
   * Check that the account behind `accessToken` belongs to `slackUserId`: its accountId (Jira
   * `/myself`, with the user's own token — same accountId as `api.atlassian.com/me`, without the extra
   * `read:me` scope) must be the single Jira user the service account finds for the Slack e-mail.
   * @returns {Promise<string>} the bound accountId
   * @throws {AccountBindingError}
   */
  async _verifyAccount(slackUserId, accessToken, cloudId) {
    if (!this.serviceJira || !this.slackClient) throw new AccountBindingError('not_configured', slackUserId);

    let consenting; let email; let candidates;
    try {
      const me = await axios.get(`https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/myself`, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      });
      consenting = me.data?.accountId;
      const info = await this.slackClient.users.info({ user: slackUserId });
      email = info.user?.profile?.email;
      if (!email) throw new AccountBindingError('no_slack_email', slackUserId);
      candidates = await this.serviceJira.findAccountIdsByEmail(email);
    } catch (err) {
      if (err instanceof AccountBindingError) throw err;
      logger.warn(`[oauth] Account binding lookup failed for ${slackUserId}: ${err.message}`);
      throw new AccountBindingError('lookup_failed', slackUserId);
    }

    if (!consenting) throw new AccountBindingError('lookup_failed', slackUserId);
    if (candidates.length === 0) throw new AccountBindingError('not_found', slackUserId);
    if (candidates.length > 1) throw new AccountBindingError('ambiguous', slackUserId);
    if (candidates[0] !== consenting) throw new AccountBindingError('mismatch', slackUserId);
    return consenting;
  }

  /**
   * Run the binding check over every stored token — connections made before the check existed were
   * never verified. A `mismatch` (the token is provably someone else's account) is disconnected; every
   * other failure is only reported, because it cannot tell a hijack from a hidden or aliased e-mail and
   * removing it would lock a legitimate user out. The operator decides those (spec §12.4).
   * @returns {Promise<{checked: number, ok: number, removed: string[], unverified: {slackUserId: string, reason: string}[]}>}
   */
  async verifyStoredBindings() {
    const result = { checked: 0, ok: 0, removed: [], unverified: [] };
    for (const slackUserId of [...this.tokens.keys()]) {
      result.checked += 1;
      try {
        const token = this.tokens.get(slackUserId);
        if (Date.now() > token.expiresAt - 5 * 60 * 1000) await this._refreshToken(slackUserId, token);
        const current = this.tokens.get(slackUserId);
        await this._verifyAccount(slackUserId, current.accessToken, current.cloudId);
        result.ok += 1;
      } catch (err) {
        if (err.reason === 'mismatch') {
          await this.disconnect(slackUserId).catch((e) => logger.warn(`[oauth] Could not remove ${slackUserId}: ${e.message}`));
          result.removed.push(slackUserId);
        } else {
          result.unverified.push({ slackUserId, reason: err.reason || 'refresh_failed' });
        }
      }
    }
    logger.info(`[oauth] Account binding of stored tokens: ${result.ok}/${result.checked} ok, ${result.removed.length} removed, ${result.unverified.length} unverified`);
    return result;
  }

  /**
   * Fetch the Jira cloudId for the user's accessible resources.
   * Prefers the resource whose URL matches JIRA_BASE_URL; falls back to first.
   * @param {string} accessToken
   * @returns {Promise<string>}
   */
  async _resolveCloudId(accessToken) {
    const res = await axios.get('https://api.atlassian.com/oauth/token/accessible-resources', {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
    const resources = res.data;
    if (!resources || resources.length === 0) {
      throw new Error('[oauth] No accessible Jira resources found for this user');
    }
    const match = this.jiraBaseUrl
      ? resources.find((r) => r.url && this.jiraBaseUrl.startsWith(r.url))
      : null;
    return (match || resources[0]).id;
  }

  async _refreshToken(slackUserId, token) {
    logger.info(`[oauth] Refreshing token for Slack user ${slackUserId}`);
    try {
      const res = await axios.post('https://auth.atlassian.com/oauth/token', {
        grant_type: 'refresh_token',
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: token.refreshToken,
      });
      const { access_token, refresh_token, expires_in } = res.data;
      const refreshed = {
        ...token,
        accessToken: access_token,
        refreshToken: refresh_token,
        expiresAt: Date.now() + expires_in * 1000,
      };
      this.tokens.set(slackUserId, refreshed);
      if (this.db) {
        await this.db.upsertToken(slackUserId, refreshed).catch((err) =>
          logger.warn(`[oauth] Failed to persist refreshed token: ${err.message}`)
        );
      }
    } catch (err) {
      logger.error(`[oauth] Token refresh failed for ${slackUserId}: ${err.message}`);
      // Remove the stale token so the user gets re-prompted on next trigger
      this.tokens.delete(slackUserId);
      throw err;
    }
  }
}

module.exports = OAuthService;
module.exports.OAuthStateError = OAuthStateError;
module.exports.AccountBindingError = AccountBindingError;
module.exports.STATE_TTL_MS = STATE_TTL_MS;
