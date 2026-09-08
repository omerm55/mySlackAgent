'use strict';

const { suggestFixVersion, candidateVersions } = require('../src/services/fixVersionSuggester');

const V = {
  r10: { id: '10', name: '2025.10', released: false, archived: false, releaseDate: '2025-10-15' },
  r11: { id: '11', name: '2025.11', released: false, archived: false, releaseDate: '2025-11-15' },
  old: { id: '1', name: '2024.1', released: true, archived: false, releaseDate: '2024-01-10' },
  arch: { id: '2', name: 'Archived', released: true, archived: true, releaseDate: '2024-02-10' },
};

function child(key, versions, status = 'Done') {
  return { key, fields: { summary: `Child ${key}`, status: { name: status }, fixVersions: versions } };
}

function makeJira({ children = [], versions = Object.values(V) } = {}) {
  return {
    getIssue: jest.fn().mockResolvedValue({ fields: { summary: 'The epic' } }),
    searchIssues: jest.fn().mockResolvedValue(children),
    getProjectVersions: jest.fn().mockResolvedValue(versions),
  };
}

describe('candidateVersions', () => {
  test('keeps unreleased first, drops archived and old released', () => {
    const c = candidateVersions(Object.values(V));
    expect(c.map((v) => v.id)).toEqual(['11', '10']);
  });
});

describe('suggestFixVersion', () => {
  test('unanimous children → picks that version without calling the LLM', async () => {
    const llm = { suggestFixVersion: jest.fn() };
    const jira = makeJira({ children: [child('A', [V.r10]), child('B', [V.r10])] });
    const res = await suggestFixVersion({ jira, llm, issueKey: 'SNS-1' });
    expect(res.pick.id).toBe('10');
    expect(res.usedLlm).toBe(false);
    expect(llm.suggestFixVersion).not.toHaveBeenCalled();
    expect(res.reason).toMatch(/all 2/);
  });

  test('mixed children → asks the LLM and uses its pick', async () => {
    const llm = { suggestFixVersion: jest.fn().mockResolvedValue({ versionId: '11', reason: 'last child ships in 2025.11' }) };
    const jira = makeJira({ children: [child('A', [V.r10]), child('B', [V.r11]), child('C', [])] });
    const res = await suggestFixVersion({ jira, llm, issueKey: 'SNS-1' });
    expect(llm.suggestFixVersion).toHaveBeenCalledWith(expect.objectContaining({
      epicKey: 'SNS-1',
      children: expect.arrayContaining([expect.objectContaining({ key: 'C', fixVersions: [] })]),
      candidates: expect.arrayContaining([expect.objectContaining({ id: '11' })]),
    }));
    expect(res.pick.id).toBe('11');
    expect(res.usedLlm).toBe(true);
    expect(res.reason).toBe('last child ships in 2025.11');
  });

  test('LLM returns an unknown id → falls back to most common child version', async () => {
    const llm = { suggestFixVersion: jest.fn().mockResolvedValue({ versionId: '999', reason: 'nope' }) };
    const jira = makeJira({ children: [child('A', [V.r10]), child('B', [V.r10]), child('C', [V.r11])] });
    const res = await suggestFixVersion({ jira, llm, issueKey: 'SNS-1' });
    expect(res.pick.id).toBe('10');
    expect(res.reason).toMatch(/2 of 3/);
  });

  test('LLM throws → still returns heuristic pick', async () => {
    const llm = { suggestFixVersion: jest.fn().mockRejectedValue(new Error('boom')) };
    const jira = makeJira({ children: [child('A', [V.r11]), child('B', [])] });
    const res = await suggestFixVersion({ jira, llm, issueKey: 'SNS-1', logger: { warn: jest.fn() } });
    expect(res.pick.id).toBe('11');
  });

  test('no children → no pick, no LLM call', async () => {
    const llm = { suggestFixVersion: jest.fn() };
    const jira = makeJira({ children: [] });
    const res = await suggestFixVersion({ jira, llm, issueKey: 'SNS-1' });
    expect(res.pick).toBeNull();
    expect(res.children).toEqual([]);
    expect(llm.suggestFixVersion).not.toHaveBeenCalled();
  });

  test('falls back to "Epic Link" JQL when parent= fails', async () => {
    const jira = makeJira();
    jira.searchIssues
      .mockRejectedValueOnce(new Error('bad field parent'))
      .mockResolvedValueOnce([child('A', [V.r10])]);
    const res = await suggestFixVersion({ jira, llm: null, issueKey: 'SNS-1' });
    expect(jira.searchIssues).toHaveBeenCalledTimes(2);
    expect(jira.searchIssues.mock.calls[1][0]).toMatch(/Epic Link/);
    expect(res.pick.id).toBe('10');
  });
});
