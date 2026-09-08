'use strict';

const axios = require('axios');

// Jira issue keys must match this pattern — validated before any API call
// to ensure we never pass user-supplied strings directly to the URL path.
const ISSUE_KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/;

/**
 * Turn an axios error from Jira into a readable string that includes
 * Jira's own error messages (errorMessages[] and errors{}), not just the status.
 */
function jiraErrorText(err) {
  if (!err.response) return err.message;
  const { status, data } = err.response;
  const parts = [];
  if (Array.isArray(data?.errorMessages)) parts.push(...data.errorMessages);
  if (data?.errors && typeof data.errors === 'object') {
    parts.push(...Object.entries(data.errors).map(([k, v]) => `${k}: ${v}`));
  }
  return parts.length > 0 ? `HTTP ${status}: ${parts.join('; ')}` : `HTTP ${status}`;
}

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
      throw new Error(`${jiraErrorText(err)} — PUT ${fullUrl}`);
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

  /**
   * Search for a Jira user by display name or email.
   * Returns the first match's accountId, or null if not found.
   * @param {string} nameOrEmail
   * @returns {Promise<string|null>}
   */
  async findUser(nameOrEmail) {
    try {
      const response = await this.client.get('/rest/api/3/user/search', {
        params: { query: nameOrEmail, maxResults: 1 },
      });
      const users = response.data;
      return users && users.length > 0 ? users[0].accountId : null;
    } catch {
      return null;
    }
  }

  /**
   * Run a JQL search. Returns the raw issue objects (key + requested fields).
   * @param {string} jql
   * @param {string[]} [fields]
   * @param {number} [maxResults]
   * @returns {Promise<Array<{ key: string, fields: object }>>}
   */
  async searchIssues(jql, fields = ['summary', 'status', 'reporter', 'assignee'], maxResults = 50) {
    try {
      const response = await this.client.post('/rest/api/3/search/jql', {
        jql, fields, maxResults,
      });
      return response.data.issues ?? [];
    } catch (err) {
      const status = err.response ? `HTTP ${err.response.status}` : err.message;
      const detail = err.response?.data?.errorMessages?.join('; ') || '';
      throw new Error(`${status} — JQL search failed${detail ? `: ${detail}` : ''}`);
    }
  }

  /**
   * List available workflow transitions for an issue.
   * @param {string} issueKey
   * @returns {Promise<Array<{ id: string, name: string, to: { name: string } }>>}
   */
  async getTransitions(issueKey) {
    this._assertValidKey(issueKey);
    // expand fields so we can see which ones the transition screen requires
    const response = await this.client.get(`/rest/api/3/issue/${issueKey}/transitions`, {
      params: { expand: 'transitions.fields' },
    });
    return response.data.transitions ?? [];
  }

  /**
   * Transition an issue to a target status. Matches on the transition's
   * destination status name or the transition name, case-insensitively.
   *
   * If the transition screen has required fields, the ones we can safely
   * auto-fill (currently: resolution) are populated; any others produce a
   * clear error naming them.
   *
   * @param {string} issueKey
   * @param {string} targetStatus  e.g. 'Done'
   */
  async transitionIssue(issueKey, targetStatus) {
    this._assertValidKey(issueKey);
    const transitions = await this.getTransitions(issueKey);
    const want = targetStatus.trim().toLowerCase();
    const match = transitions.find(
      (t) => t.to?.name?.toLowerCase() === want || t.name?.toLowerCase() === want,
    );
    if (!match) {
      const available = transitions.map((t) => t.to?.name || t.name).join(', ') || 'none';
      throw new Error(`No transition to "${targetStatus}" from current status (available: ${available})`);
    }

    const fields = {};
    const unfillable = [];
    for (const [fieldId, meta] of Object.entries(match.fields || {})) {
      if (!meta.required || meta.hasDefaultValue) continue;
      if (fieldId === 'resolution') {
        const allowed = meta.allowedValues || [];
        const pick = allowed.find((r) => /^(done|fixed|resolved)$/i.test(r.name)) || allowed[0];
        if (pick) fields.resolution = { id: pick.id };
        else unfillable.push(meta.name || fieldId);
      } else {
        unfillable.push(meta.name || fieldId);
      }
    }
    if (unfillable.length > 0) {
      throw new Error(
        `Transition to "${targetStatus}" requires field(s) I can't fill automatically: ${unfillable.join(', ')}. Please move it in Jira.`,
      );
    }

    try {
      await this.client.post(`/rest/api/3/issue/${issueKey}/transitions`, {
        transition: { id: match.id },
        ...(Object.keys(fields).length > 0 ? { fields } : {}),
      });
    } catch (err) {
      throw new Error(`${jiraErrorText(err)} — transition ${issueKey} → ${targetStatus}`);
    }
  }

  /**
   * Assign a Jira issue to a user by accountId.
   * @param {string} issueKey
   * @param {string} accountId
   */
  async assignIssue(issueKey, accountId) {
    this._assertValidKey(issueKey);
    try {
      await this.client.put(`/rest/api/3/issue/${issueKey}/assignee`, { accountId });
    } catch (err) {
      const status = err.response ? `HTTP ${err.response.status}` : err.message;
      throw new Error(`${status} — PUT assignee on ${issueKey}`);
    }
  }
}

module.exports = JiraService;
