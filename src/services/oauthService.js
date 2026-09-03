'use strict';

const axios = require('axios');
const { logger } = require('../utils/logger');
const JiraService = require('./jiraService');

/**
 * Manages Atlassian OAuth 2.0 3LO tokens on a per-Slack-user basis.
 *
 * Flow:
 *   1. generateAuthUrl(slackUserId) → send link to user via DM
 *   2. User consents → Atlassian redirects to OAUTH_REDIRECT_URI?code=...&state=slackUserId
 *   3. handleCallback(code, slackUserId) → exchanges code for tokens + resolves cloudId
 *   4. getJiraService(slackUserId) → returns a JiraService instance authed as that user
 *
 * Tokens are kept in memory. A process restart requires users to re-authorise once.
 */
class OAuthService {
  /**
   * @param {object} opts
   * @param {string} opts.clientId       JIRA_OAUTH_CLIENT_ID
   * @param {string} opts.clientSecret   JIRA_OAUTH_CLIENT_SECRET
   * @param {string} opts.redirectUri    OAUTH_REDIRECT_URI (must match Atlassian dev console)
   * @param {string} opts.jiraBaseUrl    JIRA_BASE_URL — used to match the right cloud resource
   */
  constructor({ clientId, clientSecret, redirectUri, jiraBaseUrl }) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.redirectUri = redirectUri;
    this.jiraBaseUrl = jiraBaseUrl;
    // slackUserId → { accessToken, refreshToken, expiresAt, cloudId }
    this.tokens = new Map();
  }

  /**
   * Build the Atlassian authorization URL to send to a user.
   * @param {string} slackUserId  used as the OAuth `state` parameter
   * @returns {string}
   */
  generateAuthUrl(slackUserId) {
    const params = new URLSearchParams({
      audience: 'api.atlassian.com',
      client_id: this.clientId,
      scope: 'read:jira-user write:jira-work read:jira-work offline_access',
      redirect_uri: this.redirectUri,
      state: slackUserId,
      response_type: 'code',
      prompt: 'consent',
    });
    return `https://auth.atlassian.com/authorize?${params}`;
  }

  /**
   * Exchange an authorization code for tokens and store them.
   * Called by the callback HTTP server.
   * @param {string} code         authorization code from Atlassian
   * @param {string} slackUserId  the `state` value echoed back by Atlassian
   */
  async handleCallback(code, slackUserId) {
    const tokenRes = await axios.post('https://auth.atlassian.com/oauth/token', {
      grant_type: 'authorization_code',
      client_id: this.clientId,
      client_secret: this.clientSecret,
      code,
      redirect_uri: this.redirectUri,
    });
    const { access_token, refresh_token, expires_in } = tokenRes.data;

    const cloudId = await this._resolveCloudId(access_token);

    this.tokens.set(slackUserId, {
      accessToken: access_token,
      refreshToken: refresh_token,
      expiresAt: Date.now() + expires_in * 1000,
      cloudId,
    });
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
      this.tokens.set(slackUserId, {
        ...token,
        accessToken: access_token,
        refreshToken: refresh_token,
        expiresAt: Date.now() + expires_in * 1000,
      });
    } catch (err) {
      logger.error(`[oauth] Token refresh failed for ${slackUserId}: ${err.message}`);
      // Remove the stale token so the user gets re-prompted on next trigger
      this.tokens.delete(slackUserId);
      throw err;
    }
  }
}

module.exports = OAuthService;
