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

/**
 * Suggest a Fix Version for an epic from its children.
 *
 * 1. Tally the children's fix versions.
 * 2. If every versioned child agrees on one candidate → use it (no LLM call).
 * 3. Otherwise ask the LLM to pick among candidates, given children + tally.
 * 4. Fall back to the most common child version, else nothing.
 *
 * @returns {Promise<{ pick: {id:string,name:string,released:boolean}|null, reason: string,
 *                     candidates: Array, children: Array, usedLlm: boolean }>}
 */
async function suggestFixVersion({ jira, llm, issueKey, logger }) {
  const projectKey = issueKey.split('-')[0];
  const [epic, children, versions] = await Promise.all([
    jira.getIssue(issueKey).catch(() => null),
    getEpicChildren(jira, issueKey),
    jira.getProjectVersions(projectKey),
  ]);
  const candidates = candidateVersions(versions);
  const byId = new Map(candidates.map((c) => [c.id, c]));

  // Tally children's fix versions
  const tally = new Map(); // versionId → { id, name, count }
  for (const child of children) {
    for (const fv of child.fields?.fixVersions || []) {
      const t = tally.get(fv.id) || { id: fv.id, name: fv.name, count: 0 };
      t.count += 1;
      tally.set(fv.id, t);
    }
  }
  const ranked = [...tally.values()].sort((a, b) => b.count - a.count);
  const versionedChildren = children.filter((c) => (c.fields?.fixVersions || []).length > 0).length;

  let pick = null;
  let reason = '';
  let usedLlm = false;

  // Unanimous case — no need for the LLM
  if (ranked.length === 1 && byId.has(ranked[0].id)) {
    pick = byId.get(ranked[0].id);
    reason = `all ${ranked[0].count} versioned child issue(s) are in ${pick.name}`;
    return { pick, reason, candidates, children, usedLlm };
  }

  // Mixed / missing versions → ask the LLM
  if (llm && candidates.length > 0 && children.length > 0) {
    try {
      const res = await llm.suggestFixVersion({
        epicKey: issueKey,
        epicSummary: epic?.fields?.summary || '',
        children: children.map((c) => ({
          key: c.key,
          summary: c.fields?.summary || '',
          status: c.fields?.status?.name || '',
          fixVersions: (c.fields?.fixVersions || []).map((v) => v.name),
        })),
        tally: ranked.map((t) => ({ name: t.name, count: t.count })),
        candidates: candidates.map((c) => ({ id: c.id, name: c.name, released: Boolean(c.released), releaseDate: c.releaseDate || null })),
      });
      usedLlm = true;
      if (res?.versionId && byId.has(String(res.versionId))) {
        pick = byId.get(String(res.versionId));
        reason = res.reason || 'chosen from the children\'s versions';
        return { pick, reason, candidates, children, usedLlm };
      }
      logger?.warn(`[fixVersion] LLM returned no usable versionId for ${issueKey}: ${JSON.stringify(res)}`);
    } catch (err) {
      logger?.warn(`[fixVersion] LLM suggestion failed for ${issueKey}: ${err.message}`);
    }
  }

  // Heuristic fallback: most common child version that is a valid candidate
  const top = ranked.find((t) => byId.has(t.id));
  if (top) {
    pick = byId.get(top.id);
    reason = `${top.count} of ${versionedChildren} versioned child issue(s) are in ${pick.name}`;
  }
  return { pick, reason, candidates, children, usedLlm };
}

module.exports = { suggestFixVersion, getEpicChildren, candidateVersions };
