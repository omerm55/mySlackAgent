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

    await this.client.put(`/rest/api/3/issue/${issueKey}`, {
      fields: { [fieldId]: fieldPayload },
    });
  }
}

module.exports = JiraService;
