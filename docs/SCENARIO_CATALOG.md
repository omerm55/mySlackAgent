# Scenario catalog — "Jira asks in Slack"

Source: Claude Cowork catalog (artifact `32e5b730-dfb7-46dd-bbe9-3b5513f148b9`, September 2026), built
from the Jira Makeover backlog (JM-2 → JM-354), the *Jira Automations Documentation* library (160
SNS-scoped rules), live Slack history to 8 Sept 2026 and the `pr-sns-knowledge` field reference.
Thirty-five places where Jira currently asks a person for something through a comment, an e-mail, or a
read-only feed. Each is a candidate for a Slack ask that reaches a real human and writes the answer back
as them. This file maps each one onto what **this app** needs; the reasoning lives in
[`PROJECT_SPEC.md` §18](PROJECT_SPEC.md#18-scenario-catalog-and-requirements).

## Vocabulary used in the tables

**Ask type** (what the app must be able to send and act on):

| Ask type | Meaning | App status |
|---|---|---|
| `yes_no_transition` | Yes/No/Reply → transition the issue | ✅ have |
| `yes_no_field` | Yes/No/Reply → set one field | ✅ have |
| `choose` | Pick one of N options (buttons or select) → set a field / transition | ❌ planned |
| `collect` | Free text (or per-field inputs) → LLM extracts ≥1 field values → preview → write | ✅ have for text fields (A1 built 2026-09-09); typed fields / regex planned |
| `claim` | Channel post; first click assigns the issue and edits the message | ❌ planned |
| `acknowledge` | Record an acknowledgement / undo; may write a marker field | ❌ planned |
| `create` | Slack-originated issue creation via modal | ❌ planned |
| `inform` | No write; contextual message only | ✅ trivial |

**Audience:** `reporter`, `assignee`, `user_field:<cf>` (a user-picker custom field, e.g. PM
owner — ✅ have), `channel:<id>` (❌ planned for asks; ✅ for confirmations), `user_list` (fixed set,
❌ planned), `mapping` (team → PM / domain → lead lookup table, ❌ planned).

**Trigger:** `jql` (poll, ✅ have), `webhook` (Jira Automation → app, ❌ planned), `slack` (reaction /
command, ✅ reactions have).

**Jira dependency:** what must change in Jira *before* the ask moves to Slack (the catalog's "gate
first" rule). `—` means none known.

## A — Fill in the field a machine can't know

| Id | Scenario | Today | Proposed Slack ask | Fields | Ask type | Audience | Trigger | Jira dependency | Refs |
|---|---|---|---|---|---|---|---|---|---|
| **A1** ✅ built | Customer-friendly name & Customer value missing on a PR Initiative (moves to *Now* or flagged Certified Roadmap) | JPD comment | DM to PM owner; free text or two-field modal; preview; writes both in one PUT (`PROJECT_SPEC.md` §2.10) | `cf[11822]`, `cf[15249]` (both `textfield`) | `collect` | `user_field` `cf[11909]` (PM owner) → fallback assignee → reporter | `jql` | — (confirmed) | JM-352 |
| A2 | Regression bug has no *Regression from build* | Two Jira comments (create + update) | DM to reporter with a validated input and a live example | `cf[12859]` | `collect` + regex validation | reporter | `jql` | Reconcile the rule's regex (`L2025.2.0.249`) with the asked format (`2026.2.2-build.1`) | rules "Notify on Regression bugs without regression from build" |
| A3 | Bug has no Scrum team | Weekly Jira comment (Mon 09:00) | Channel post to the domain's lead with a 14-option team picker | `cf[11277]` | `choose` | `channel` / lead | `jql` | — | JM-47 |
| A4 | Story/Task resolved with no parent | DM + `#ph-ops-orphans` (works) | Same, plus an Epic picker and an "unplanned, no parent" acknowledgement | parent | `choose` (epic search) + `acknowledge` | assignee + reporter | `webhook` | Extend the existing rule, don't rebuild | JM-174 |
| A5 | Escalation raised without a Customer blocker | Escalation reverted + e-mail to 4 people | DM to the escalator: pick a blocker and the escalation stands; revert only if unanswered after 1 h | `cf[12298]`, `cf[12067]` | `choose` + TTL | `user_field` (escalated by) | `webhook` | Change the rule from instant revert to 1 h grace | rule "Enforce Customer Blocker on escalations" |
| A6 | Bug missing *Bug Type* (empty on ~⅔ of SNS bugs) | No ask exists | Three buttons (Field / Internal / Security) on the triage post in the team's channel | `cf[12064]` | `choose` (3) | `channel` | `jql` / `webhook` | Team → channel mapping | — |

## B — Ratify what the machine guessed

| Id | Scenario | Today | Proposed Slack ask | Fields | Ask type | Audience | Trigger | Jira dependency | Refs |
|---|---|---|---|---|---|---|---|---|---|
| **B1** | Confirm the release-notes decision the agent made (Public / Internal / No) | Jira comment + `#documentation-pms-tws-resolved-bugs` | DM to the team's PM, three buttons | `cf[11228]`, `cf[11296]` | `choose` (3) | `mapping` (team → PM) | `jql` | Write gate is `is EMPTY` → must allow correction; 443/654 comments mention a non-existent field; retires G3 | JM-188 |
| B2 | Accept/reject the scrum-team advisor's suggestion | Comment as the advisor account | DM: Accept / Keep mine / Wrong suggestion; log the outcome | `cf[11277]` | `choose` (3) + outcome log | whoever set the team (changelog) | `webhook` | — | JM-185 #1 |
| B3 | Re-check a disputed Critical/Highway severity | Daily Slack DM with no way to answer (86/154) | Confirm / Lower buttons writing severity; log which way it went | `cf[11246]`, `cf[11206]` | `choose` (2) | reporter + assignee | `jql` | Agent should read comments for a workaround first | JM-185 #3–4 |
| B4 | Confirm a known limitation the agent found | E-mail + DM to one hard-coded user | DM to the actual reporter and assignee: Confirm / Not a limitation | — | `choose` (2) | reporter + assignee | `jql` | Fix audience and gate together (gate loses 11/20) | rules "Automated known limitation check" |
| B5 | Confirm a story split the agent proposes | Not built | Post listing proposed Stories: Create-all / Pick / Discard | — | `choose` (multi) → `create` | epic owner | agent output | Agent must exist | JM-185 #6 |

## C — Chase the update that has gone stale

| Id | Scenario | Today | Proposed Slack ask | Fields | Ask type | Audience | Trigger | Jira dependency | Refs |
|---|---|---|---|---|---|---|---|---|---|
| C1 | Initiative in *Now* has stale Notes | Weekly digest in `#ph-tracking-initiatives` + `Auto: Latest notification` | Threaded reply on the digest writes Notes and clears `Auto: Unknown Status` | `cf[12958]`, `cf[12010]`, `cf[13832]`, `cf[15525]` | `collect` (reply-to-update) | `user_field` (Dev owner) | `jql` scheduled | `Auto: Latest notification` capped at 255 chars | rd-initiative-notifier |
| **C2** | Escalation has had no comment for two days | One Jira comment, ever (`addCommentOnce: true`) | Thread in `#escalations-managment`, re-pinged every 2 days, escalating to the DPM | — | `collect` / `acknowledge` with repeat + escalation | assignee + `user_field` (Escalated By) | `jql` recurring | Fix `addCommentOnce`; include Escalated By | JM-108 |
| C3 | P1/P2 bug past due date and still open | On hold | Thread in `#shielders` off the SLA post: still working / blocked / re-scope / can close; escalate on silence | duedate | `choose` (4) + escalation | assignee | `jql` on real elapsed time | Compute SLA from creation, not `duedate` (re-score restarts the clock) | JM-113 |
| C4 | Resolved issue sitting unclosed | Public Jira comment every 2 days | Weekly per-person digest "close these N" with per-issue Close | status | `yes_no_transition` (batched) | assignee | `jql` + digest | — | rule "Remind Assignees to Close Resolved Issues" |
| C5 | Parked Initiative's Project target is coming up | Closed as idea (JM-302) | Monthly post to the domain lead: promote to *Next* / clear target / set new | `cf[14817]`, `cf[11818]`, `cf[12170]` | `choose` (3) incl. date input | `mapping` (domain → lead) | `jql` monthly | Only Certified Roadmap Initiatives need asking | JM-302 |
| C6 | Certified Roadmap Initiative slipped past its original target | No ask exists | DM to PM owner: confirm the new date + one-line reason; summary in the weekly roadmap draft | `cf[12991]`, `cf[11818]`, `cf[12170]` (+ reason → a Notes field) | `collect` (date + reason) | `user_field` (PM owner) | `jql` (`Auto: Original target` vs target) | Decide which field holds the reason | weekly-roadmap-update |

## D — Ask before the guardrail bites

| Id | Scenario | Today | Proposed Slack ask | Fields | Ask type | Audience | Trigger | Jira dependency | Refs |
|---|---|---|---|---|---|---|---|---|---|
| **D1** | Someone outside the allowed list changed Global Priority | Unflagged entry in read-only `#initiative-updates` | ⚠️ alert @mentioning the owners with Approve / Revert | `cf[14750]` | `choose` (2) in channel | `user_list` (owners) | `webhook` (rule has `{{initiator}}`) | Allowlist must include the automation actor and bulk clears (change *to empty*); app writes need a marker so the rule doesn't re-fire | JM-353 |
| D2 | Bulk renumber about to fire one alert per Initiative | Dozens of posts | One summary post "42 renumbered, order unchanged" with Undo | `cf[15901]`, `cf[14750]` | `acknowledge` / undo | operator | `webhook` | Keep `Auto: Renumbered` marker exactly as is | JM-354 |
| D3 | *Included in Certified Roadmap* changed by a non-director | Automation reverts silently | DM to the directors: Approve / Keep reverted; note back to the editor | `cf[12170]` | `choose` (2) | `user_list` (directors) | `webhook` | Write as the user so the field's own gate enforces itself (`require_oauth`) | — |
| D4 | Epic being closed with unfinished children | DM to Epic assignee and DPM | Same DM listing the open children with per-child Close | status | `yes_no_transition` per child (batched) | assignee + DPM | `webhook` | E-mail path behind a dead kill-switch; argue against JM-136's hard block | JM-136 |
| D5 | Child created/reopened under a closed Epic | Two e-mail rules (one cannot fire) | DM to initiator with a "pick a live Epic" picker | parent | `choose` (epic search) | initiator | `webhook` | Fix rule statuses (on-creation names unreachable statuses) | JM-59 |
| D6 | Manual priority override on a bug is about to be undone | E-mail to initiator + 2 people | Ephemeral DM: "this will revert on the next Grade change — set severity / regression / workaround instead" | priority, `cf[11560]`, `cf[14447]` | `inform` | initiator | `webhook` | — | rule "Notify on change of Priority on Bug" |
| D7 | A fixVersion assignment looks wrong | `#fixversions-on-jira`, ~1 post/month | Same channel, working gate, with a version picker | fixVersions | `choose` (version) | `channel` / release manager | `jql` | Fix gate blind to every `2026.x` version (7 reachable vs 848 invisible); fixVersions is replace-not-append; preserve the `Develop` placeholder | versions 10594 / 10638 |

## E — Find the owner and get a claim

| Id | Scenario | Today | Proposed Slack ask | Fields | Ask type | Audience | Trigger | Jira dependency | Refs |
|---|---|---|---|---|---|---|---|---|---|
| E1 | New P1 / Major regression needs a shielder | Post to `#shielders` (+ `#ai-shielders` for Core AI) | Same post with **Claim** — assigns in Jira and edits the message to show the owner | assignee | `claim` | `channel` | `webhook` | Manual variant posts only to `#shielders`; mention built from display name pings nobody | rules "P1 / Major regression bugs — Calculate dates and send to Slack" |
| E2 | Inquiry needs a PM verdict on whether it's a bug | Comment with the agent's quality verdict on *every* inquiry | Team-channel post: Bug / Not a bug / Need more detail; converts or closes on click | issuetype (Inquiry 10742) | `choose` (3) → convert/close | `channel` / owning PM | `webhook` | Stay silent on passes | rule "Support Review Inquiry Quality On Create" |
| E3 | Initiative declares a Required Domain that hasn't acknowledged it | No ask exists | DM to that domain's lead: Acknowledged / Not feasible this release / Need a conversation | `cf[14751]`, `cf[12052]`, `cf[15558]` | `choose` (3) | `mapping` (domain → lead) | `jql` | Domain → lead mapping | — |
| E4 | Bug above a severity threshold has no assignee | No ask exists | Team-channel post with Claim, escalating to the DPM after 48 h | assignee | `claim` + escalation | `channel` | `jql` | Team → channel mapping | `cf[11560]`, `cf[11246]` |

## F — Let Slack write into Jira

| Id | Scenario | Today | Proposed Slack ask | Fields | Ask type | Audience | Trigger | Jira dependency | Refs |
|---|---|---|---|---|---|---|---|---|---|
| F1 | File an escalation from the Slack thread where it was raised | Not built | Slash command / message action → required-field modal | `cf[12298]`, `cf[12067]` | `create` | anyone | `slack` | Mirror the manual *Escalate This Bug* rule's required fields (0/260 malformed) | — |
| F2 | An emoji marks a Slack message as needing a Jira issue | Not built | Reaction → pre-filled create modal with the thread linked | — | `create` | anyone in scoped channels | `slack` reaction | Scope to `#jira-created-by-cs`, `#ts_jira_created_by_analytics` only | — |
| F3 | Salesforce clone conversation happens in Slack | On hold (JM-105) | One thread per clone: request / provisioned / expiring in 72 h, Extend button on the last | — | thread updates + `acknowledge` | reporter + CSM | `webhook` | — | JM-105, SNS-109414 |

## G — Clear the room so an ask can be heard (Jira-side hygiene, not app work)

| Id | Item | Action | Refs |
|---|---|---|---|
| G1 | Initiative record fidelity: debounce rapid re-edits (PR-438 ×3 in 90 s), render cancellations with real content; `#initiative-release-changes` is a duplicate subset | Jira Automation change | JM-283 |
| G2 | Stop announcing the same issue twice in CS/TS feeds; drop `Open ⟶ Open` non-transitions | Pick one publisher per channel | rule "Send Slack for Inquiries and Issues created by CS team" |
| G3 | Stop the release-notes bulk edit from e-mailing every watcher | Resolved by B1 (decision surfaces once in Slack) | JM-188 |
| G4 | Retire dead/untraceable rules: *Blocked issue notification* (unknown webhook, `jira.sisense.com` links), *[Scheduled] Decide whether to document a bug* (0 matches), *[Manual] Test slack message* | Identify destinations or disable | 3 rules |

## Catalog's suggested order ("if you only build five")

| # | Scenario | Depends on |
|---|---|---|
| 1 | A1 — Customer-friendly name & value ✅ built | — (written mandate JM-352) |
| 2 | B1 — ratify release-notes decision | Gate change on `cf[11228]` |
| 3 | C2 — chase quiet escalations | `addCommentOnce` fix |
| 4 | D1 — flag unauthorized priority changes | Allowlist incl. the automation actor |
| 5 | A2 — Regression from build | Reconcile regex with the asked format |

Our recommended order and the reasoning are in `PROJECT_SPEC.md` §18.
