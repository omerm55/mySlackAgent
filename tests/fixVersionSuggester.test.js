'use strict';

const { suggestFixVersion, candidateVersions, buildTimeline, firstOnOrAfter } = require('../src/services/fixVersionSuggester');

const V = {
  r3: { id: '3', name: '2026.3.0', released: false, archived: false, releaseDate: '2026-08-03' },
  r4: { id: '4', name: '2026.4.0', released: false, archived: false, releaseDate: '2026-10-19' },
  r5: { id: '5', name: '2026.5.0', released: false, archived: false, releaseDate: '2027-01-11' },
  old: { id: '1', name: '2024.1', released: true, archived: false, releaseDate: '2024-01-10' },
  arch: { id: '2', name: 'Archived', released: true, archived: true, releaseDate: '2024-02-10' },
};
const CALENDAR = [
  { version_name: '2026.3.0', branch_out: '2026-07-06', release_date: '2026-08-03' },
  { version_name: '2026.4.0', branch_out: '2026-09-21', release_date: '2026-10-19' },
  { version_name: '2026.5.0', branch_out: '2026-12-07', release_date: '2027-01-11' },
];
const NOW = new Date('2026-09-08T10:00:00Z');

function child(key, versions, status = 'Done') {
  return { key, fields: { summary: `Child ${key}`, status: { name: status }, fixVersions: versions } };
}

function makeJira({ children = [], versions = Object.values(V), acceptedAt = null } = {}) {
  return {
    getIssue: jest.fn().mockResolvedValue({ fields: { summary: 'The epic', status: { name: 'Acceptance' } } }),
    searchIssues: jest.fn().mockResolvedValue(children),
    getProjectVersions: jest.fn().mockResolvedValue(versions),
    getStatusEnteredAt: jest.fn().mockResolvedValue(acceptedAt),
  };
}
const makeDb = (calendar = CALENDAR) => ({ getReleaseCalendar: jest.fn().mockResolvedValue(calendar) });

afterEach(() => { delete process.env.CURRENT_RELEASE_VERSION; });

describe('candidateVersions', () => {
  test('keeps unreleased first, drops archived and old released', () => {
    const c = candidateVersions(Object.values(V));
    expect(c.map((v) => v.id)).toEqual(['5', '4', '3']);
  });
});

describe('buildTimeline / firstOnOrAfter', () => {
  test('uses the calendar when present and matches names case-insensitively', () => {
    const tl = buildTimeline(candidateVersions(Object.values(V)), [{ version_name: '2026.4.0', branch_out: '2026-09-21' }]);
    expect(tl.map((e) => e.version.id)).toEqual(['4']);
    expect(tl[0].source).toBe('calendar');
  });
  test('falls back to Jira dates when the calendar is empty', () => {
    const tl = buildTimeline(candidateVersions(Object.values(V)), []);
    expect(tl.map((e) => e.version.id)).toEqual(['3', '4', '5']);
    expect(tl[0].source).toBe('jira-release');
  });
  test('firstOnOrAfter picks the first branch-out on/after the date', () => {
    const tl = buildTimeline(candidateVersions(Object.values(V)), CALENDAR);
    expect(firstOnOrAfter(tl, new Date('2026-08-12')).version.name).toBe('2026.4.0');
    expect(firstOnOrAfter(tl, new Date('2026-07-06')).version.name).toBe('2026.3.0');
    expect(firstOnOrAfter(tl, null)).toBeNull();
  });
});

describe('suggestFixVersion', () => {
  test('unanimous children → picks that version without the LLM, offers timeline as alternative', async () => {
    const llm = { suggestFixVersion: jest.fn() };
    const jira = makeJira({ children: [child('A', [V.r3]), child('B', [V.r3])], acceptedAt: new Date('2026-08-12') });
    const res = await suggestFixVersion({ jira, llm, db: makeDb(), issueKey: 'SNS-1', now: NOW });
    expect(res.pick.id).toBe('3');
    expect(res.usedLlm).toBe(false);
    expect(llm.suggestFixVersion).not.toHaveBeenCalled();
    expect(res.reason).toMatch(/all 2/);
    expect(res.alternative.pick.id).toBe('4');
    expect(res.alternative.reason).toMatch(/entered Acceptance on Aug 12, 2026/);
  });

  test('mixed children → asks the LLM with timeline + current evidence and uses its pick', async () => {
    const llm = { suggestFixVersion: jest.fn().mockResolvedValue({ versionId: '4', reason: 'last child ships in 2026.4.0' }) };
    const jira = makeJira({ children: [child('A', [V.r3]), child('B', [V.r4]), child('C', [])], acceptedAt: new Date('2026-08-12') });
    const res = await suggestFixVersion({ jira, llm, db: makeDb(), issueKey: 'SNS-1', now: NOW });
    expect(llm.suggestFixVersion).toHaveBeenCalledWith(expect.objectContaining({
      epicKey: 'SNS-1',
      statusName: 'Acceptance',
      acceptedAt: '2026-08-12',
      timelineFit: expect.objectContaining({ name: '2026.4.0', branchOut: '2026-09-21' }),
      current: expect.objectContaining({ name: '2026.4.0' }),
      children: expect.arrayContaining([expect.objectContaining({ key: 'C', fixVersions: [] })]),
    }));
    expect(res.pick.id).toBe('4');
    expect(res.usedLlm).toBe(true);
    expect(res.reason).toBe('last child ships in 2026.4.0');
  });

  test('no children, no LLM → timeline fit from acceptance date, current as alternative', async () => {
    const jira = makeJira({ children: [], acceptedAt: new Date('2026-06-01') });
    const res = await suggestFixVersion({ jira, llm: null, db: makeDb(), issueKey: 'SNS-1', now: NOW });
    expect(res.pick.name).toBe('2026.3.0'); // first branch-out after Jun 1 is Jul 6
    expect(res.reason).toMatch(/first release branching after/);
    expect(res.alternative.pick.name).toBe('2026.4.0'); // current: first branch-out after Sep 8
    expect(res.alternative.reason).toMatch(/currently in progress/);
  });

  test('CURRENT_RELEASE_VERSION env overrides the computed current release', async () => {
    process.env.CURRENT_RELEASE_VERSION = '2026.5.0';
    const jira = makeJira({ children: [], acceptedAt: null });
    const res = await suggestFixVersion({ jira, llm: null, db: makeDb(), issueKey: 'SNS-1', now: NOW });
    expect(res.pick.name).toBe('2026.5.0');
    expect(res.reason).toMatch(/currently in progress/);
  });

  test('LLM returns an unknown id → deterministic fallback to timeline fit', async () => {
    const llm = { suggestFixVersion: jest.fn().mockResolvedValue({ versionId: '999', reason: 'nope' }) };
    const jira = makeJira({ children: [child('A', [V.r3]), child('B', [V.r4])], acceptedAt: new Date('2026-09-01') });
    const res = await suggestFixVersion({ jira, llm, db: makeDb(), issueKey: 'SNS-1', now: NOW });
    expect(res.pick.name).toBe('2026.4.0');
  });

  test('LLM throws, no calendar/dates → most common child version', async () => {
    const llm = { suggestFixVersion: jest.fn().mockRejectedValue(new Error('boom')) };
    const noDates = Object.values(V).map((v) => ({ ...v, releaseDate: undefined }));
    const jira = makeJira({ children: [child('A', [V.r4]), child('B', [V.r4]), child('C', [V.r3])], versions: noDates, acceptedAt: null });
    const res = await suggestFixVersion({ jira, llm, db: makeDb([]), issueKey: 'SNS-1', now: NOW, logger: { warn: jest.fn() } });
    expect(res.pick.id).toBe('4');
    expect(res.reason).toMatch(/2 of 3/);
  });

  test('nothing to go on → no pick', async () => {
    const jira = makeJira({ children: [], versions: [], acceptedAt: null });
    const res = await suggestFixVersion({ jira, llm: { suggestFixVersion: jest.fn() }, db: makeDb([]), issueKey: 'SNS-1', now: NOW });
    expect(res.pick).toBeNull();
    expect(res.alternative).toBeNull();
  });

  test('falls back to "Epic Link" JQL when parent= fails', async () => {
    const jira = makeJira();
    jira.searchIssues
      .mockRejectedValueOnce(new Error('bad field parent'))
      .mockResolvedValueOnce([child('A', [V.r3])]);
    const res = await suggestFixVersion({ jira, llm: null, issueKey: 'SNS-1', now: NOW });
    expect(jira.searchIssues).toHaveBeenCalledTimes(2);
    expect(jira.searchIssues.mock.calls[1][0]).toMatch(/Epic Link/);
    expect(res.pick.id).toBe('3');
  });
});
