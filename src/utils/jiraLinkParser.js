'use strict';

// Matches Jira browse URLs: https://<domain>.atlassian.net/browse/PROJ-123
// Also handles Slack's link formatting: <https://...|display text>
const JIRA_URL_RE = /https?:\/\/[a-zA-Z0-9-]+\.atlassian\.net\/browse\/([A-Z][A-Z0-9_]+-\d+)/g;

// Matches bare issue keys in plain text, e.g. "Bug SNS-122172 /"
// Requires a word boundary on both sides to avoid partial matches.
const JIRA_KEY_RE = /\b([A-Z][A-Z0-9_]+-\d+)\b/g;

/**
 * Extract all Jira issue keys found in a block of text.
 * Handles both full Atlassian browse URLs and bare issue keys (e.g. "SNS-122172").
 * @param {string} text
 * @returns {string[]} e.g. ['PROJ-123', 'SNS-122172']
 */
function extractJiraIssueKeys(text) {
  if (!text) return [];
  const keys = [];

  let match;
  while ((match = JIRA_URL_RE.exec(text)) !== null) {
    keys.push(match[1]);
  }
  JIRA_URL_RE.lastIndex = 0;

  while ((match = JIRA_KEY_RE.exec(text)) !== null) {
    keys.push(match[1]);
  }
  JIRA_KEY_RE.lastIndex = 0;

  return [...new Set(keys)];
}

module.exports = { extractJiraIssueKeys };
