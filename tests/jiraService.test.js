'use strict';

const axios = require('axios');
const JiraService = require('../src/services/jiraService');

jest.mock('axios');

const mockClient = {
  get: jest.fn(),
  put: jest.fn(),
  post: jest.fn(),
};
axios.create.mockReturnValue(mockClient);

const service = new JiraService({
  baseUrl: 'https://test.atlassian.net',
  email: 'user@test.com',
  apiToken: 'token123',
});

beforeEach(() => jest.clearAllMocks());

describe('JiraService.getIssue', () => {
  test('calls the correct endpoint and returns data', async () => {
    mockClient.get.mockResolvedValue({ data: { key: 'PROJ-1', fields: {} } });
    const result = await service.getIssue('PROJ-1');
    expect(mockClient.get).toHaveBeenCalledWith('/rest/api/3/issue/PROJ-1');
    expect(result.key).toBe('PROJ-1');
  });
});

describe('JiraService.updateIssueField', () => {
  test('select type wraps value in { value }', async () => {
    mockClient.put.mockResolvedValue({});
    await service.updateIssueField('PROJ-1', 'customfield_10000', 'In Review', 'select');
    expect(mockClient.put).toHaveBeenCalledWith('/rest/api/3/issue/PROJ-1', {
      fields: { customfield_10000: { value: 'In Review' } },
    });
  });

  test('text type sends the value as-is', async () => {
    mockClient.put.mockResolvedValue({});
    await service.updateIssueField('PROJ-1', 'summary', 'New title', 'text');
    expect(mockClient.put).toHaveBeenCalledWith('/rest/api/3/issue/PROJ-1', {
      fields: { summary: 'New title' },
    });
  });

  test('array type wraps value in [{ name }]', async () => {
    mockClient.put.mockResolvedValue({});
    await service.updateIssueField('PROJ-1', 'labels', 'reviewed', 'array');
    expect(mockClient.put).toHaveBeenCalledWith('/rest/api/3/issue/PROJ-1', {
      fields: { labels: [{ name: 'reviewed' }] },
    });
  });

  test('array type accepts an array of values', async () => {
    mockClient.put.mockResolvedValue({});
    await service.updateIssueField('PROJ-1', 'labels', ['a', 'b'], 'array');
    expect(mockClient.put).toHaveBeenCalledWith('/rest/api/3/issue/PROJ-1', {
      fields: { labels: [{ name: 'a' }, { name: 'b' }] },
    });
  });

  test('raw type passes value through untouched', async () => {
    mockClient.put.mockResolvedValue({});
    const raw = { id: '10001' };
    await service.updateIssueField('PROJ-1', 'priority', raw, 'raw');
    expect(mockClient.put).toHaveBeenCalledWith('/rest/api/3/issue/PROJ-1', {
      fields: { priority: raw },
    });
  });

  test('defaults to select type when fieldType is omitted', async () => {
    mockClient.put.mockResolvedValue({});
    await service.updateIssueField('PROJ-1', 'customfield_10000', 'Done');
    expect(mockClient.put).toHaveBeenCalledWith('/rest/api/3/issue/PROJ-1', {
      fields: { customfield_10000: { value: 'Done' } },
    });
  });
});

describe('JiraService.searchIssues', () => {
  const page = (n, count, nextPageToken) => ({
    data: {
      issues: Array.from({ length: count }, (_, i) => ({ key: `P-${n}${i}`, fields: {} })),
      ...(nextPageToken ? { nextPageToken } : {}),
    },
  });

  test('follows nextPageToken until exhausted and returns every issue', async () => {
    mockClient.post
      .mockResolvedValueOnce(page(1, 50, 'tok-2'))
      .mockResolvedValueOnce(page(2, 40));
    const issues = await service.searchIssues('project = P', ['summary']);
    expect(issues).toHaveLength(90);
    expect(mockClient.post).toHaveBeenCalledTimes(2);
    expect(mockClient.post.mock.calls[0][1]).toMatchObject({ jql: 'project = P', fields: ['summary'], maxResults: 100 });
    expect(mockClient.post.mock.calls[0][1].nextPageToken).toBeUndefined();
    expect(mockClient.post.mock.calls[1][1]).toMatchObject({ nextPageToken: 'tok-2' });
    expect(issues.truncated).toBeUndefined();
  });

  test('stops at maxResults and flags truncation when more pages remain', async () => {
    mockClient.post.mockResolvedValueOnce(page(1, 1, 'more'));
    const issues = await service.searchIssues('project = P', ['summary'], 1);
    expect(issues).toHaveLength(1);
    expect(mockClient.post).toHaveBeenCalledTimes(1);
    expect(mockClient.post.mock.calls[0][1].maxResults).toBe(1);
    expect(issues.truncated).toBe(true);
  });

  test('surfaces Jira error messages', async () => {
    mockClient.post.mockRejectedValueOnce({ response: { status: 400, data: { errorMessages: ["Field 'foo' does not exist"] } } });
    await expect(service.searchIssues('foo = 1')).rejects.toThrow("HTTP 400 — JQL search failed: Field 'foo' does not exist");
  });
});

describe('JiraService.transitionIssue', () => {
  test('matches the target status by destination name and auto-fills a required Resolution', async () => {
    mockClient.get.mockResolvedValueOnce({
      data: {
        transitions: [
          { id: '11', name: 'Start', to: { name: 'In Progress' }, fields: {} },
          {
            id: '31', name: 'Close it', to: { name: 'Done' },
            fields: { resolution: { required: true, name: 'Resolution', allowedValues: [{ id: '1', name: 'Fixed' }, { id: '10000', name: 'Done' }] } },
          },
        ],
      },
    });
    mockClient.post.mockResolvedValueOnce({});
    await service.transitionIssue('PROJ-1', 'done');
    expect(mockClient.get).toHaveBeenCalledWith('/rest/api/3/issue/PROJ-1/transitions', { params: { expand: 'transitions.fields' } });
    expect(mockClient.post).toHaveBeenCalledWith('/rest/api/3/issue/PROJ-1/transitions', {
      transition: { id: '31' },
      fields: { resolution: { id: '10000' } },
    });
  });

  test('names required fields it cannot fill instead of posting', async () => {
    mockClient.get.mockResolvedValueOnce({
      data: { transitions: [{ id: '31', name: 'Done', to: { name: 'Done' }, fields: { customfield_1: { required: true, name: 'Sprint' } } }] },
    });
    await expect(service.transitionIssue('PROJ-1', 'Done')).rejects.toThrow(/requires field\(s\) I can't fill automatically: Sprint/);
    expect(mockClient.post).not.toHaveBeenCalled();
  });

  test('lists available transitions when the target is not reachable', async () => {
    mockClient.get.mockResolvedValueOnce({ data: { transitions: [{ id: '11', name: 'Start', to: { name: 'In Progress' } }] } });
    await expect(service.transitionIssue('PROJ-1', 'Done')).rejects.toThrow('No transition to "Done" from current status (available: In Progress)');
  });
});
