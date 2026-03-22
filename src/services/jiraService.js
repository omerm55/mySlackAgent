'use strict';

const axios = require('axios');

class JiraService {
  constructor({ baseUrl, email, apiToken }) {
    this.client = axios.create({
      baseURL: baseUrl,
      auth: { username: email, password: apiToken },
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /**
   * Fetch a Jira issue to confirm it exists and retrieve field metadata.
   * @param {string} issueKey e.g. 'PROJ-123'
   */
  async getIssue(issueKey) {
    const response = await this.client.get(`/rest/api/3/issue/${issueKey}`);
    return response.data;
  }

  /**
   * Update a single field on a Jira issue.
   *
   * The method automatically wraps the value in the correct shape based on
   * the fieldType hint:
   *   - 'select'  → { id } or { value } (option field)
   *   - 'text'    → plain string
   *   - 'array'   → array of { name } objects (e.g. labels, multi-select)
   *   - 'raw'     → value is used as-is (caller controls the shape)
   *
   * @param {string} issueKey
   * @param {string} fieldId   Jira field ID, e.g. 'customfield_10000' or 'status'
   * @param {*}      value     The value to set
   * @param {string} [fieldType='select']
   */
  async updateIssueField(issueKey, fieldId, value, fieldType = 'select') {
    let fieldPayload;
    switch (fieldType) {
      case 'select':
        // Jira option fields accept either { value: "name" } or { id: "..." }
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
