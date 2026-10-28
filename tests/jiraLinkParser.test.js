'use strict';

const { extractJiraIssueKeys, extractSubjectIssueKey } = require('../src/utils/jiraLinkParser');

const REAL_MESSAGE =
  "Bug SNS-122172 / Customer Hosted Multi-Node POC License Expiration Not Working  was marked as Include Release Notes = No." +
  "The bug is assigned to ** from team 'Cockpit'." +
  "@Adva Almog-Dadush - please take a look and make sure this bug does not require public documentation.";

describe('extractJiraIssueKeys', () => {
  test('extracts issue key from real-world Slack message with bare key', () => {
    expect(extractJiraIssueKeys(REAL_MESSAGE)).toEqual(['SNS-122172']);
  });

  test('extracts a single issue key from a plain URL', () => {
    const text = 'See https://myco.atlassian.net/browse/PROJ-123 for details';
    expect(extractJiraIssueKeys(text)).toEqual(['PROJ-123']);
  });

  test('extracts a bare issue key from plain text', () => {
    expect(extractJiraIssueKeys('Bug PROJ-99 needs attention')).toEqual(['PROJ-99']);
  });

  test('extracts multiple issue keys from the same text', () => {
    const text = 'Bug SNS-1 and Bug SNS-2 are both affected';
    expect(extractJiraIssueKeys(text)).toEqual(['SNS-1', 'SNS-2']);
  });

  test('handles Slack-formatted links (<url|label>)', () => {
    const text = '<https://myco.atlassian.net/browse/ABC-42|ABC-42>';
    // URL match and bare key match both find ABC-42; dedup keeps one
    expect(extractJiraIssueKeys(text)).toEqual(['ABC-42']);
  });

  test('deduplicates the same key appearing multiple times', () => {
    const text = 'SNS-122172 is a duplicate of SNS-122172';
    expect(extractJiraIssueKeys(text)).toEqual(['SNS-122172']);
  });

  test('returns empty array when no Jira keys are present', () => {
    expect(extractJiraIssueKeys('Hello world')).toEqual([]);
  });

  test('returns empty array for null/undefined input', () => {
    expect(extractJiraIssueKeys(null)).toEqual([]);
    expect(extractJiraIssueKeys(undefined)).toEqual([]);
  });

  test('ignores non-Atlassian URLs with no bare key', () => {
    const text = 'See https://github.com/org/repo/issues/123';
    expect(extractJiraIssueKeys(text)).toEqual([]);
  });

  test('handles issue keys with underscores in project name', () => {
    const text = 'See MY_PROJ-10 for context';
    expect(extractJiraIssueKeys(text)).toEqual(['MY_PROJ-10']);
  });
});

// The PM-reviewed post for SNS-125104 also linked its follow-up SNS-125106; a 👍 wrote to both.
const POST_WITH_REFERENCE =
  "Bug <https://sisenseglobal.atlassian.net/browse/SNS-125104|SNS-125104 / seismic-us14.sisense.com | Pivot deployment hung up>  was marked as Include Release Notes = No.\n" +
  "*   **Mitigation Strategy:** the team implemented cloud alerts and automatic restarts ([SNS-125106](<https://sisenseglobal.atlassian.net/browse/SNS-125106>)).";

describe('extractSubjectIssueKey', () => {
  test('returns the post\'s subject, not keys it references further down', () => {
    expect(extractSubjectIssueKey(POST_WITH_REFERENCE)).toBe('SNS-125104');
  });

  test('prefers the first Jira link over an earlier bare key-like token', () => {
    expect(extractSubjectIssueKey('Encoding UTF-8: see https://myco.atlassian.net/browse/SNS-7')).toBe('SNS-7');
  });

  test('falls back to the first bare key when there is no link', () => {
    expect(extractSubjectIssueKey(REAL_MESSAGE)).toBe('SNS-122172');
    expect(extractSubjectIssueKey('Bug SNS-1, duplicate of SNS-2')).toBe('SNS-1');
  });

  test('returns null when there is no key', () => {
    expect(extractSubjectIssueKey('Hello world')).toBeNull();
    expect(extractSubjectIssueKey(undefined)).toBeNull();
  });
});
