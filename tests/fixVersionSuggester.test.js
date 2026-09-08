'use strict';

const { suggestFixVersion, candidateVersions, buildTimeline, releaseFor } = require('../src/services/fixVersionSuggester');

// Mirrors the real release calendar: each version is worked on during its branch-out month.
const V = {
  r32: { id: '32', name: '2026.3.2', released: false, archived: false, releaseDate: '2026-09-15' },
  r40: { id: '40', name: '2026.4.0', released: false, archived: false, releaseDate: '2026-10-15' },
  r41: { id: '41', name: '2026.4.1', released: false, archived: false, releaseDate: '2026-11-15' },
  old: { id: '1', name: '2024.1', released: true, archived: false, releaseDate: '2024-01-10' },
  arch: { id: '2', name: 'Archived', released: true, archived: true, releaseDate: '2024-02-10' },
};
const CALENDAR = [
  { version_name: '2026.3.2', branch_out: '2026-08-01', branch_out_end: '2026-08-31' },
  { version_name: '2026.4.0', branch_out: '2026-09-01', branch_out_end: '2026-09-30' },
  { version_name: '2026.4.1', branch_out: '2026-10-01', branch_out_end: '2026-10-31' },
];
const NOW = new Date('2026-09-08T10:00:00Z'); // → current = 2026.4.0

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
    expect(c.map((v) => v.id)).toEqual(['41', '40', '32']);
  });
});

describe('buildTimeline / releaseFor', () => {
  const tl = () => buildTimeline(candidateVersions(Object.values(V)), CALENDAR);

  test('calendar windows are inclusive, matched by name case-insensitively', () => {
    const t = buildTimeline(candidateVersions(Object.values(V)), [{ version_name: '2026.4.0', branch_out: '2026-09-01', branch_out_end: '2026-09-30' }]);
    expect(t).toHaveLength(1);
    expect(t[0].source).toBe('calendar');
    expect(releaseFor(t, new Date('2026-09-01T00:00:00Z')).version.name).toBe('2026.4.0');
    expect(releaseFor(t, new Date('2026-09-30T20:00:00Z')).version.name).toBe('2026.4.0');
  });

  test('a date inside a window → that release; today Sep 8 → 2026.4.0', () => {
    expect(releaseFor(tl(), new Date('2026-08-12')).version.name).toBe('2026.3.2');
    expect(releaseFor(tl(), NOW).version.name).toBe('2026.4.0');
  });

  test('a date in a gap rolls forward to the next window; after the last window → null', () => {
    const gappy = buildTimeline(candidateVersions(Object.values(V)), [CALENDAR[0], CALENDAR[2]]); // no September
    expect(releaseFor(gappy, new Date('2026-09-08')).version.name).toBe('2026.4.1');
    expect(releaseFor(tl(), new Date('2027-03-01'))).toBeNull();
    expect(releaseFor(tl(), null)).toBeNull();
  });

  test('falls back to Jira release dates as single-day windows when the calendar is empty', () => {
    const t = buildTimeline(candidateVersions(Object.values(V)), []);
    expect(t.map((e) => e.version.id)).toEqual(['32', '40', '41']);
    expect(t[0].source).toBe('jira-release');
    expect(releaseFor(t, new Date('2026-09-20')).version.name).toBe('2026.4.0'); // next after Sep 15
  });
});

describe('suggestFixVersion', () => {
  test('unanimous children → decided without the LLM; timeline fit offered as alternative', async () => {
    const llm = { suggestFixVersion: jest.fn() };
    const jira = makeJira({ children: [child('A', [V.r40]), child('B', [V.r40])], acceptedAt: new Date('2026-08-12') });
    const res = await suggestFixVersion({ jira, llm, db: makeDb(), issueKey: 'SNS-1', now: NOW });
    expect(res.pick.name).toBe('2026.4.0');
    expect(res.usedLlm).toBe(false);
    expect(llm.suggestFixVersion).not.toHaveBeenCalled();
    expect(res.alternative.pick.name).toBe('2026.3.2');
    expect(res.alternative.reason).toBe('the release in progress when the epic entered Acceptance on Aug 12, 2026 (branch-out Aug 2026)');
  });

  test('mixed children → LLM gets window-based timelineFit + current and its pick wins', async () => {
    const llm = { suggestFixVersion: jest.fn().mockResolvedValue({ versionId: '40', reason: 'last child ships in 2026.4.0' }) };
    const jira = makeJira({ children: [child('A', [V.r32]), child('B', [V.r40]), child('C', [])], acceptedAt: new Date('2026-08-12') });
    const res = await suggestFixVersion({ jira, llm, db: makeDb(), issueKey: 'SNS-1', now: NOW });
    expect(llm.suggestFixVersion).toHaveBeenCalledWith(expect.objectContaining({
      acceptedAt: '2026-08-12',
      timelineFit: expect.objectContaining({ name: '2026.3.2', branchOut: '2026-08-01..2026-08-31' }),
      current: expect.objectContaining({ name: '2026.4.0' }),
    }));
    expect(res.pick.name).toBe('2026.4.0');
    expect(res.usedLlm).toBe(true);
    expect(res.alternative.pick.name).toBe('2026.3.2');
  });

  test('no children, no LLM → timeline fit is primary, current is the alternative', async () => {
    const jira = makeJira({ children: [], acceptedAt: new Date('2026-08-12') });
    const res = await suggestFixVersion({ jira, llm: null, db: makeDb(), issueKey: 'SNS-1', now: NOW });
    expect(res.pick.name).toBe('2026.3.2');
    expect(res.reason).toMatch(/in progress when the epic entered Acceptance on Aug 12, 2026 \(branch-out Aug 2026\)/);
    expect(res.alternative.pick.name).toBe('2026.4.0');
    expect(res.alternative.reason).toBe('the release currently in progress (branch-out Sep 2026)');
  });

  test('accepted this month → timeline fit equals current, so no alternative from those two', async () => {
    const jira = makeJira({ children: [], acceptedAt: new Date('2026-09-03') });
    const res = await suggestFixVersion({ jira, llm: null, db: makeDb(), issueKey: 'SNS-1', now: NOW });
    expect(res.pick.name).toBe('2026.4.0');
    expect(res.alternative).toBeNull();
  });

  test('CURRENT_RELEASE_VERSION env overrides the computed current release', async () => {
    process.env.CURRENT_RELEASE_VERSION = '2026.4.1';
    const jira = makeJira({ children: [], acceptedAt: null });
    const res = await suggestFixVersion({ jira, llm: null, db: makeDb(), issueKey: 'SNS-1', now: NOW });
    expect(res.pick.name).toBe('2026.4.1');
    expect(res.reason).toBe('the release currently in progress');
  });

  test('LLM returns an unknown id → deterministic fallback to timeline fit', async () => {
    const llm = { suggestFixVersion: jest.fn().mockResolvedValue({ versionId: '999', reason: 'nope' }) };
    const jira = makeJira({ children: [child('A', [V.r32]), child('B', [V.r40])], acceptedAt: new Date('2026-09-01') });
    const res = await suggestFixVersion({ jira, llm, db: makeDb(), issueKey: 'SNS-1', now: NOW });
    expect(res.pick.name).toBe('2026.4.0');
  });

  test('LLM throws, no calendar/dates → most common child version', async () => {
    const llm = { suggestFixVersion: jest.fn().mockRejectedValue(new Error('boom')) };
    const noDates = Object.values(V).map((v) => ({ ...v, releaseDate: undefined }));
    const jira = makeJira({ children: [child('A', [V.r40]), child('B', [V.r40]), child('C', [V.r32])], versions: noDates, acceptedAt: null });
    const res = await suggestFixVersion({ jira, llm, db: makeDb([]), issueKey: 'SNS-1', now: NOW, logger: { warn: jest.fn() } });
    expect(res.pick.id).toBe('40');
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
      .mockResolvedValueOnce([child('A', [V.r32])]);
    const res = await suggestFixVersion({ jira, llm: null, issueKey: 'SNS-1', now: NOW });
    expect(jira.searchIssues).toHaveBeenCalledTimes(2);
    expect(jira.searchIssues.mock.calls[1][0]).toMatch(/Epic Link/);
    expect(res.pick.id).toBe('32');
  });
});

describe('suggestFixVersion — stage timeouts and progress', () => {
  const never = () => new Promise(() => {});

  test('a hanging stage is skipped after stageTimeoutMs and the rest proceeds', async () => {
    const jira = makeJira({ children: [], acceptedAt: new Date('2026-08-12') });
    jira.getStatusEnteredAt = jest.fn(never); // changelog hangs
    const llm = { suggestFixVersion: jest.fn(never) }; // LLM hangs too
    const t0 = Date.now();
    const res = await suggestFixVersion({ jira, llm, db: makeDb(), issueKey: 'SNS-1', now: NOW, stageTimeoutMs: 50 });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(res.degraded).toEqual(expect.arrayContaining([
      expect.stringMatching(/^changelog: changelog timed out/),
      expect.stringMatching(/^llm: llm timed out/),
    ]));
    // No acceptance date → no timeline fit; falls back to current release
    expect(res.pick.name).toBe('2026.4.0');
    expect(res.usedLlm).toBe(false);
  });

  test('reports progress as stages start', async () => {
    const seen = [];
    const jira = makeJira({ children: [child('A', [V.r32]), child('B', [V.r40])], acceptedAt: new Date('2026-08-12') });
    const llm = { suggestFixVersion: jest.fn().mockResolvedValue({ versionId: '40', reason: 'ok' }) };
    await suggestFixVersion({ jira, llm, db: makeDb(), issueKey: 'SNS-1', now: NOW, onProgress: (l) => seen.push(l) });
    expect(seen).toEqual([
      'Checking child issues and project versions…',
      'Reading when the epic entered Acceptance…',
      'Asking AI to weigh the evidence…',
    ]);
  });

  test('a failing stage is recorded and skipped, not fatal', async () => {
    const jira = makeJira({ children: [child('A', [V.r40])], acceptedAt: null });
    jira.getProjectVersions = jest.fn().mockRejectedValue(new Error('Jira 502'));
    const res = await suggestFixVersion({ jira, llm: null, db: makeDb(), issueKey: 'SNS-1', now: NOW });
    expect(res.degraded).toEqual([expect.stringMatching(/^versions: Jira 502/)]);
    expect(res.candidates).toEqual([]);
    expect(res.pick).toBeNull();
  });
});
