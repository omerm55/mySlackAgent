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

/**
 * Make text safe inside a Slack `<url|label>` link. Slack splits on `|` and
 * treats `<`/`>`/`&` specially, so a summary like "A | B" would truncate the link.
 */
function safeLinkLabel(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\|/g, '∣'); // U+2223 DIVIDES — looks like a pipe, doesn't split the link
}

/** Slack mrkdwn link with a custom label, e.g. `<url|SNS-1 (Summary)>`. */
function issueLinkLabelled(issueKey, label) {
  const url = issueUrl(issueKey);
  const text = safeLinkLabel(label || issueKey);
  return url ? `<${url}|${text}>` : text;
}

/** True when the text already references the issue (bare key or a link to it). */
function mentionsIssue(text, issueKey) {
  return typeof text === 'string' && text.includes(issueKey);
}

module.exports = { issueUrl, issueLink, issueLinkLabelled, safeLinkLabel, mentionsIssue };
