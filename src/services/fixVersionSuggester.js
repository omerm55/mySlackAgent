'use strict';

const RECENT_RELEASED_DAYS = 180;

/**
 * Children of an epic. Modern Jira Cloud uses `parent`; older company-managed
 * projects use the "Epic Link" field. Try both, return the first that works.
 */
async function getEpicChildren(jira, epicKey) {
  for (const jql of [`parent = ${epicKey}`, `"Epic Link" = ${epicKey}`]) {
    try {
      return await jira.searchIssues(jql, ['summary', 'status', 'fixVersions', 'issuetype'], 100);
    } catch { /* try the next form */ }
  }
  return [];
}

/** Versions worth offering: all unreleased, plus anything released recently. */
function candidateVersions(versions) {
  const cutoff = Date.now() - RECENT_RELEASED_DAYS * 24 * 3600 * 1000;
  return versions
    .filter((v) => !v.archived)
    .filter((v) => !v.released || (v.releaseDate && new Date(v.releaseDate).getTime() >= cutoff))
    .sort((a, b) => {
      if (a.released !== b.released) return a.released ? 1 : -1; // unreleased first
      return (b.releaseDate || '').localeCompare(a.releaseDate || '') || b.name.localeCompare(a.name);
    })
    .slice(0, 100);
}

const norm = (s) => String(s || '').trim().toLowerCase();

/** Parse 'YYYY-MM-DD' as a UTC date at start of day; end-of-window dates get 23:59:59. */
const dayStart = (s) => new Date(`${String(s).slice(0, 10)}T00:00:00Z`);
const dayEnd = (s) => new Date(`${String(s).slice(0, 10)}T23:59:59Z`);

/**
 * Build the release timeline: [{ version, start, end, source }] sorted by start.
 * Prefers the Supabase release_calendar (branch_out … branch_out_end window);
 * falls back to Jira's version startDate, then releaseDate (single-day windows).
 */
function buildTimeline(candidates, calendar) {
  const byName = new Map(candidates.map((c) => [norm(c.name), c]));
  const entries = [];

  for (const row of calendar || []) {
    const version = byName.get(norm(row.version_name));
    if (!version || !row.branch_out) continue;
    entries.push({
      version,
      start: dayStart(row.branch_out),
      end: dayEnd(row.branch_out_end || row.branch_out),
      source: 'calendar',
    });
  }
  if (entries.length === 0) {
    for (const v of candidates) {
      const d = v.startDate || v.releaseDate;
      if (!d) continue;
      entries.push({ version: v, start: dayStart(d), end: dayEnd(d), source: v.startDate ? 'jira-start' : 'jira-release' });
    }
  }
  return entries.sort((a, b) => a.start - b.start);
}

/**
 * The release "in progress" on `date`: the entry whose window contains it,
 * otherwise the next window after it (dates in a gap roll forward).
 */
function releaseFor(timeline, date) {
  if (!date) return null;
  const d = date instanceof Date ? date : new Date(date);
  return timeline.find((e) => e.start <= d && d <= e.end)
    || timeline.find((e) => e.start > d)
    || null;
}

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '');
const fmtMonth = (d) => (d ? new Date(d).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }) : '');
const windowLabel = (e) => {
  if (!e) return '';
  const sameMonth = e.start.getUTCFullYear() === e.end.getUTCFullYear() && e.start.getUTCMonth() === e.end.getUTCMonth();
  return sameMonth ? fmtMonth(e.start) : `${fmtDate(e.start)} – ${fmtDate(e.end)}`;
};

/**
 * Suggest a Fix Version for an epic.
 *
 * Evidence, strongest first:
 *   1. The children's own fix versions (unanimous → decided, no LLM).
 *   2. Timeline fit: first release branching after the epic entered its
 *      current status (e.g. Acceptance), from release_calendar or Jira dates.
 *   3. The release currently in progress (first branch-out on/after today,
 *      or CURRENT_RELEASE_VERSION env).
 * When evidence is mixed the LLM adjudicates; otherwise deterministic order.
 *
 * @returns {Promise<{
 *   pick: object|null, reason: string,
 *   alternative: { pick: object, reason: string }|null,
 *   acceptedAt: Date|null, statusName: string,
 *   candidates: Array, children: Array, usedLlm: boolean }>}
 */
async function suggestFixVersion({ jira, llm, db, issueKey, logger, now = new Date() }) {
  const projectKey = issueKey.split('-')[0];
  const t0 = Date.now();
  const timed = (label, p) => p.then((v) => { logger?.info?.(`[fixVersion] ${issueKey} ${label}: ${Date.now() - t0}ms`); return v; });

  const [epic, children, versions, calendar] = await Promise.all([
    timed('issue', jira.getIssue(issueKey).catch(() => null)),
    timed('children', getEpicChildren(jira, issueKey)),
    timed('versions', jira.getProjectVersions(projectKey)),
    timed('calendar', db?.getReleaseCalendar ? db.getReleaseCalendar().catch(() => []) : Promise.resolve([])),
  ]);
  const statusName = epic?.fields?.status?.name || '';
  const acceptedAt = statusName && typeof jira.getStatusEnteredAt === 'function'
    ? await timed('changelog', jira.getStatusEnteredAt(issueKey, statusName).catch(() => null))
    : null;

  const candidates = candidateVersions(versions);
  const byId = new Map(candidates.map((c) => [String(c.id), c]));

  // Children's versions
  const tally = new Map();
  for (const child of children) {
    for (const fv of child.fields?.fixVersions || []) {
      const t = tally.get(fv.id) || { id: fv.id, name: fv.name, count: 0 };
      t.count += 1;
      tally.set(fv.id, t);
    }
  }
  const ranked = [...tally.values()].sort((a, b) => b.count - a.count);
  const versionedChildren = children.filter((c) => (c.fields?.fixVersions || []).length > 0).length;

  // Timeline evidence
  const timeline = buildTimeline(candidates, calendar);
  const timelineFit = releaseFor(timeline, acceptedAt);
  const currentEntry = releaseFor(timeline, now);
  let current = null;
  const envCurrent = process.env.CURRENT_RELEASE_VERSION;
  if (envCurrent) current = candidates.find((c) => norm(c.name) === norm(envCurrent)) || null;
  if (!current) current = currentEntry?.version || null;

  const reasons = {
    children: (t) => `all ${t.count} versioned child issue(s) are in ${t.name}`,
    mostCommon: (t) => `${t.count} of ${versionedChildren} versioned child issue(s) are in ${t.name}`,
    timeline: () => `the release in progress when the epic entered ${statusName} on ${fmtDate(acceptedAt)}`
      + (timelineFit?.source === 'calendar' ? ` (branch-out ${windowLabel(timelineFit)})` : ''),
    current: () => 'the release currently in progress'
      + (current && currentEntry?.version?.id === current.id && currentEntry.source === 'calendar' ? ` (branch-out ${windowLabel(currentEntry)})` : ''),
  };

  const result = {
    pick: null, reason: '', alternative: null,
    acceptedAt, statusName, candidates, children, usedLlm: false,
  };
  const setAlternative = (primaryId) => {
    const alts = [
      timelineFit && { pick: timelineFit.version, reason: reasons.timeline() },
      current && { pick: current, reason: reasons.current() },
    ].filter(Boolean).filter((a) => String(a.pick.id) !== String(primaryId));
    result.alternative = alts[0] || null;
  };

  // 1. Unanimous children — decided
  if (ranked.length === 1 && byId.has(String(ranked[0].id))) {
    result.pick = byId.get(String(ranked[0].id));
    result.reason = reasons.children(ranked[0]);
    setAlternative(result.pick.id);
    return result;
  }

  // 2. Mixed evidence → LLM
  if (llm && candidates.length > 0 && (children.length > 0 || timelineFit || current)) {
    try {
      const res = await timed('llm', llm.suggestFixVersion({
        epicKey: issueKey,
        epicSummary: epic?.fields?.summary || '',
        statusName,
        acceptedAt: acceptedAt ? acceptedAt.toISOString().slice(0, 10) : null,
        today: now.toISOString().slice(0, 10),
        timelineFit: timelineFit ? {
          id: timelineFit.version.id, name: timelineFit.version.name,
          branchOut: `${timelineFit.start.toISOString().slice(0, 10)}..${timelineFit.end.toISOString().slice(0, 10)}`,
        } : null,
        current: current ? { id: current.id, name: current.name } : null,
        children: children.map((c) => ({
          key: c.key,
          summary: c.fields?.summary || '',
          status: c.fields?.status?.name || '',
          fixVersions: (c.fields?.fixVersions || []).map((v) => v.name),
        })),
        tally: ranked.map((t) => ({ name: t.name, count: t.count })),
        candidates: candidates.map((c) => ({ id: c.id, name: c.name, released: Boolean(c.released), releaseDate: c.releaseDate || null })),
      }));
      result.usedLlm = true;
      if (res?.versionId && byId.has(String(res.versionId))) {
        result.pick = byId.get(String(res.versionId));
        result.reason = res.reason || 'chosen from the children and the release timeline';
        setAlternative(result.pick.id);
        return result;
      }
      logger?.warn(`[fixVersion] LLM returned no usable versionId for ${issueKey}: ${JSON.stringify(res)}`);
    } catch (err) {
      logger?.warn(`[fixVersion] LLM suggestion failed for ${issueKey}: ${err.message}`);
    }
  }

  // 3. Deterministic fallback: timeline → current → most common child version
  if (timelineFit) {
    result.pick = timelineFit.version;
    result.reason = reasons.timeline();
  } else if (current) {
    result.pick = current;
    result.reason = reasons.current();
  } else {
    const top = ranked.find((t) => byId.has(String(t.id)));
    if (top) {
      result.pick = byId.get(String(top.id));
      result.reason = reasons.mostCommon(top);
    }
  }
  if (result.pick) setAlternative(result.pick.id);
  return result;
}

module.exports = { suggestFixVersion, getEpicChildren, candidateVersions, buildTimeline, releaseFor };
