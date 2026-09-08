'use strict';

/** Absolute browse URL for an issue, or null when JIRA_BASE_URL is not configured. */
function issueUrl(issueKey) {
  const base = (process.env.JIRA_BASE_URL || '').replace(/\/+$/, '');
  return base ? `${base}/browse/${issueKey}` : null;
}

/** Slack mrkdwn link `<url|KEY>`, falling back to the bare key. */
function issueLink(issueKey) {
  const url = issueUrl(issueKey);
  return url ? `<${url}|${issueKey}>` : issueKey;
}

module.exports = { issueUrl, issueLink };
