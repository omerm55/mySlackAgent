'use strict';

// Matches Jira browse URLs: https://<domain>.atlassian.net/browse/PROJ-123
// Also handles Slack's link formatting: <https://...|display text>
const JIRA_LINK_RE = /https?:\/\/[a-zA-Z0-9-]+\.atlassian\.net\/browse\/([A-Z][A-Z0-9_]+-\d+)/g;

/**
 * Extract all Jira issue keys found in a block of text.
 * @param {string} text
 * @returns {string[]} e.g. ['PROJ-123', 'PROJ-456']
 */
function extractJiraIssueKeys(text) {
  if (!text) return [];
  const keys = [];
  let match;
  while ((match = JIRA_LINK_RE.exec(text)) !== null) {
    keys.push(match[1]);
  }
  // Reset lastIndex for reuse
  JIRA_LINK_RE.lastIndex = 0;
  return [...new Set(keys)];
}

module.exports = { extractJiraIssueKeys };
