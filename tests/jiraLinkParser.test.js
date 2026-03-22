'use strict';

const { extractJiraIssueKeys } = require('../src/utils/jiraLinkParser');

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
