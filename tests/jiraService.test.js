'use strict';

const axios = require('axios');
const JiraService = require('../src/services/jiraService');

jest.mock('axios');

const mockClient = {
  get: jest.fn(),
  put: jest.fn(),
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
