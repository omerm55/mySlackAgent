'use strict';

const axios = require('axios');

// Jira issue keys must match this pattern — validated before any API call
// to ensure we never pass user-supplied strings directly to the URL path.
const ISSUE_KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/;

class JiraService {
  constructor({ baseUrl, email, apiToken }) {
    this.client = axios.create({
      baseURL: baseUrl,
      auth: { username: email, password: apiToken },
      headers: { 'Content-Type': 'application/json' },
      // Prevent requests from hanging indefinitely
      timeout: 10_000,
    });
  }

  /**
   * Validate that an issue key looks like a real Jira key before using it
   * in a URL path. Throws if invalid.
   * @param {string} issueKey
   */
  _assertValidKey(issueKey) {
    if (!ISSUE_KEY_RE.test(issueKey)) {
      throw new Error(`Invalid Jira issue key: "${issueKey}"`);
    }
  }

  /**
   * Fetch a Jira issue.
   * @param {string} issueKey e.g. 'PROJ-123'
   */
  async getIssue(issueKey) {
    this._assertValidKey(issueKey);
    const response = await this.client.get(`/rest/api/3/issue/${issueKey}`);
    return response.data;
  }

  /**
   * Update a single field on a Jira issue.
   *
   * fieldType controls how the value is shaped in the request body:
   *   'select' (default) → { value: "..." }
   *   'text'             → plain string
   *   'array'            → [{ name: "..." }, ...]
   *   'raw'              → value passed through as-is
   *
   * @param {string} issueKey
   * @param {string} fieldId
   * @param {*}      value
   * @param {string} [fieldType='select']
   */
  async updateIssueField(issueKey, fieldId, value, fieldType = 'select') {
    this._assertValidKey(issueKey);

    let fieldPayload;
    switch (fieldType) {
      case 'select':
        fieldPayload = { value };
        break;
      case 'text':
        fieldPayload = value;
        break;
      case 'array':
        fieldPayload = Array.isArray(value)
          ? value.map((v) => ({ name: v }))
          : [{ name: value }];
        break;
      case 'raw':
        fieldPayload = value;
        break;
      default:
        fieldPayload = { value };
    }

    const path = `/rest/api/3/issue/${issueKey}`;
    try {
      await this.client.put(path, { fields: { [fieldId]: fieldPayload } });
    } catch (err) {
      const fullUrl = `${this.client.defaults.baseURL}${path}`;
      const status = err.response ? `HTTP ${err.response.status}` : err.message;
      throw new Error(`${status} — PUT ${fullUrl}`);
    }
  }

  /**
   * Add a plain-text comment to a Jira issue.
   * Supports [~accountId:xxx] mentions in the text.
   * Errors are non-fatal — callers should catch and log.
   * @param {string} issueKey
   * @param {string} text
   */
  async addComment(issueKey, text) {
    this._assertValidKey(issueKey);
    // ADF requires each line to be a separate paragraph node.
    // A single text node with \n characters is invalid and silently rejected.
    const paragraphs = text
      .split('\n')
      .map((line) => ({
        type: 'paragraph',
        content: line ? [{ type: 'text', text: line }] : [],
      }));
    await this.client.post(`/rest/api/3/issue/${issueKey}/comment`, {
      body: { type: 'doc', version: 1, content: paragraphs },
    });
  }

  /**
   * Create a JiraService instance that authenticates with a user's OAuth Bearer token
   * instead of the global service-account Basic Auth credentials.
   *
   * OAuth API calls use the api.atlassian.com gateway, which requires the site's
   * cloudId in the path rather than a direct instance hostname.
   *
   * @param {string} accessToken  OAuth 2.0 access token for the user
   * @param {string} cloudId      Atlassian site cloudId (from accessible-resources)
   * @returns {JiraService}
   */
  static fromOAuthToken(accessToken, cloudId) {
    const svc = Object.create(JiraService.prototype);
    svc.client = axios.create({
      baseURL: `https://api.atlassian.com/ex/jira/${cloudId}`,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      timeout: 10_000,
    });
    return svc;
  }

  /**
   * Find a Jira user by email address.
   * Returns the first match's accountId, or null if not found.
   * @param {string} email
   * @returns {Promise<string|null>}
   */
  async findUserByEmail(email) {
    try {
      const response = await this.client.get('/rest/api/3/user/search', {
        params: { query: email, maxResults: 1 },
      });
      const users = response.data;
      return users && users.length > 0 ? users[0].accountId : null;
    } catch {
      return null; // non-fatal — attribution will fall back to name only
    }
  }
}

module.exports = JiraService;
