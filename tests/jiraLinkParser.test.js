'use strict';

const { extractJiraIssueKeys } = require('../src/utils/jiraLinkParser');

describe('extractJiraIssueKeys', () => {
  test('extracts a single issue key from a plain URL', () => {
    const text = 'See https://myco.atlassian.net/browse/PROJ-123 for details';
    expect(extractJiraIssueKeys(text)).toEqual(['PROJ-123']);
  });

  test('extracts multiple issue keys from the same text', () => {
    const text =
      'Linked: https://myco.atlassian.net/browse/PROJ-1 and https://myco.atlassian.net/browse/PROJ-2';
    expect(extractJiraIssueKeys(text)).toEqual(['PROJ-1', 'PROJ-2']);
  });

  test('handles Slack-formatted links (<url|label>)', () => {
    const text = '<https://myco.atlassian.net/browse/ABC-42|ABC-42>';
    expect(extractJiraIssueKeys(text)).toEqual(['ABC-42']);
  });

  test('deduplicates repeated links to the same issue', () => {
    const text =
      'https://myco.atlassian.net/browse/PROJ-7 and https://myco.atlassian.net/browse/PROJ-7';
    expect(extractJiraIssueKeys(text)).toEqual(['PROJ-7']);
  });

  test('returns empty array when no Jira links are present', () => {
    expect(extractJiraIssueKeys('Hello world')).toEqual([]);
  });

  test('returns empty array for null/undefined input', () => {
    expect(extractJiraIssueKeys(null)).toEqual([]);
    expect(extractJiraIssueKeys(undefined)).toEqual([]);
  });

  test('ignores non-Atlassian URLs', () => {
    const text = 'See https://github.com/org/repo/issues/123';
    expect(extractJiraIssueKeys(text)).toEqual([]);
  });

  test('handles issue keys with underscores in project name', () => {
    const text = 'https://myco.atlassian.net/browse/MY_PROJ-10';
    expect(extractJiraIssueKeys(text)).toEqual(['MY_PROJ-10']);
  });
});
