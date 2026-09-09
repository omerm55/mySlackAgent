# Slack ↔ Jira Bot — Security summary (September 2026)

> Written for the security review thread of 30 March – 15 April 2026 (Dennis Ong, Abhishek Rath,
> Jeffrey Kinum, Lauren Bauman, Yael Lev). It answers three questions: what the March feedback asked
> for, what the September rebuild did about each point, and what is still open — including risks the
> rebuild introduced. Owner: Omer Meshar (PH Ops). Technical detail is in
> [`PROJECT_SPEC.md`](PROJECT_SPEC.md); the March design is preserved in [`architecture.md`](architecture.md).

## 0. Status, stated plainly

- **The March review ended with "please don't deploy anything to production"** (Abhishek, 15 April),
  pending a proper review the security team had no bandwidth for at the time.
- **Since 8 September the rebuilt bot runs on Render and is in use** by about ten people in Product
  (PMs, a few Dev owners) during the hackathon. It writes to the SNS and PR Jira projects. **No
  security sign-off has been obtained for this.** This document is the input for that sign-off; the
  ask is a decision on §5 (P0 items) and §6 (decisions needed), not a retroactive approval.
- The architecture is materially different from the one reviewed in March. The two headline changes
  are the reason for this rewrite: **writes now happen as the real user via Atlassian OAuth**, and the
  bot now **initiates conversations** (polls Jira, DMs people, asks them to act) instead of only
  reacting to Slack.

## 1. What was reviewed in March, and what it asked for

The March version: a Socket-Mode bot with no inbound ports; a 👍 reaction or thread reply on a message
containing a Jira key set one Jira field via a **single Jira service account**; configuration in JSON
files on the server; allowlists, per-integration hourly rate limit, dedup cache, attribution comment
on the issue, daily audit summary and alerts to an ops channel (added on 30–31 March in response to
the review).

Abhishek's five expectations, plus Lauren's question:

| # | Feedback (30 March) | In our words |
|---|---|---|
| F1 | *Authorization model.* "Any Slack user triggers actions via a single service account … effectively removing RBAC." | Writes must be bound to the acting person's own Jira permissions, or scoped equivalently. |
| F2 | *Ownership & accountability.* A named owner for behaviour, correctness, incidents. | Someone answers for it. |
| F3 | *Audit & traceability.* "Who triggered what and why", scoped to few projects. | Every write attributable to a person, with the reason, in a place auditors can query. |
| F4 | *Operational controls.* Monitoring, alerting, rate limiting, constraints — "not an unbounded automation". | Caps and alarms. |
| F5 | *Governance.* New use cases go through review, not ad-hoc expansion; how is it monitored. | A change-control path and a scope boundary. |
| F6 | *Data* (Lauren). Does Jira ticket content reach Slack? Support tickets may contain customer data. | Which Jira data leaves Jira, to where. |

## 2. What changed in the September rebuild

| Area | March | September |
|---|---|---|
| Identity for Jira writes | One service account (`JIRA_API_TOKEN`) | **Per-user Atlassian OAuth 2.0 (3LO)**; service account only as read/poll identity and as an explicit, labelled fallback |
| Trigger sources | Slack reactions / replies | + **Jira triggers**: JQL polled on a cadence → DM the reporter / assignee / a user field → Yes/No/Reply, risk review, or collect fields |
| Configuration | JSON files in git / on the server | **App Home modals** (admins only) → **Supabase** tables |
| Hosting | systemd / Docker on a company host (design) | **Render** (free tier, PaaS) with a public HTTPS endpoint for the OAuth callback |
| State | In memory | **Supabase** (Postgres): OAuth tokens, triggers, prompts, preferences, activity log |
| LLM | none | **Azure OpenAI (GPT-5.1)** interprets free-text replies, suggests Fix Versions, tidies Notes, extracts field values |
| Jira scope | SNS only ("only the Sisense project") | **SNS and PR** (Product Roadmap, incl. two customer-visible text fields) |
| Slack scopes | `channels:history reactions:read chat:write users:read users:read.email` | + `groups:history channels:read groups:read channels:join im:history im:write` |

## 3. Feedback → what we did → what is still open

### F1 — Authorization model (the core objection)

**Done.**
- **Writes run as the person, through their own Atlassian consent.** Each user connects once
  (Atlassian OAuth 3LO, scopes `read:jira-user read:jira-work write:jira-work offline_access`,
  `prompt=consent`). Every button click or modal submit resolves *their* token and calls Jira as them.
  **Jira's own permission scheme, workflow validators and field-level rules apply unchanged** — the
  bot cannot make a user do in Jira what they could not do themselves. Observed in practice: PR
  workflow validators (Planned release / PM owner required) rejected bot-initiated transitions exactly
  as they reject a human, and the *Included in Certified Roadmap* revert automation is untouched
  because the bot never writes that field.
- **Audience is a property of the trigger, not "anyone in Slack".** Channel triggers: channel
  membership + optional `allowedSlackUserIds`. Jira triggers: the DM goes only to the reporter,
  assignee, or the person named in a specific Jira user field (e.g. PR Dev Owner, PR PM Owner) of the
  issue in question; nobody else can act on that ask. Two roll-out gates on top: `scope = personal`
  (only the trigger's creator is ever DM'd) and a **pilot list** (only named Slack users are asked;
  everyone else is skipped without being recorded).
- **Trigger management is admin-only** (`ADMIN_SLACK_USER_IDS`); regular users see only their
  connection, notification preference and activity in App Home. Editing someone else's trigger is
  refused.

**Still open.**
- **The service-account fallback still exists.** A user who has not connected Jira gets a "🔐 Connect
  Jira" nudge, but if they click Yes anyway the write is made by the service account with an
  attribution comment and an ops line "no OAuth — acting as bot". That is precisely the RBAC bypass
  the March review objected to, now opt-in and labelled rather than default. **Recommendation: make
  OAuth mandatory for writes** (`require_oauth`, planned in spec §16.10) — at minimum for the PR project
  and for any field that Jira guards by role. Reads/polling would still use the service account.
- The service account's own Jira permissions have not been reduced to the minimum set (IT action).
- The list of admins is an environment variable with two names, not a managed group.

### F2 — Ownership & accountability

**Done.** Owner: Omer Meshar / PH Ops, named in the spec header and in this document. The spec
carries a runbook (§12: setup, SQL snippets, symptoms), and the repository rule that every behaviour
change updates the spec in the same commit (`CLAUDE.md`). Each Jira trigger records `created_by`.

**Still open.** No on-call or incident procedure beyond "the ops channel alerts Omer"; no documented
kill switch other than deleting the trigger in App Home or suspending the Render service.

### F3 — Audit & traceability

**Done.**
- **Jira's changelog now names the real person** for every OAuth write; no attribution comment is
  needed. For the fallback path the attribution comment ("changed by X via Slack") remains.
- **Ops channel** (`#ph-ops-ops`) receives every ask sent, every click (with OAuth yes/no), every LLM
  decision with the user's text, every trigger create/edit/delete/run, digests delivered, FYIs sent, and
  a daily summary. Trigger management output goes only there, never to user DMs.
- **`activity_log` table** in Supabase: per-user history of what they did through the bot (surfaced in
  their App Home). `jira_prompts` records who was asked about which issue, when, and `answered_at`.
- **"Why" lands in Jira for the two owner loops**: risk review writes a dated line into the
  Initiative's Notes; the collect ask writes the values themselves.

**Still open.**
- For plain Yes/No asks the *reason* exists only in the Slack thread and the ops channel, not in Jira.
- **Render logs contain more than the March design promised**: the LLM-decision log line includes the
  user's free text and the collect log line includes the extracted values (`logger.info({... userText})`).
  March said logs never contain message text. Fix: log lengths/hashes, not content.
- Ops-channel history is the de-facto audit log; it is a private Slack channel with Slack's retention,
  not an immutable store.

### F4 — Operational controls

**Done.** Per-channel-trigger hourly rate limit with alert; error-threshold alerting in a rolling
window; dedup of Slack redeliveries; `JIRA_MAX_PROMPTS_PER_RUN` (10) caps how many new asks one trigger
can send per run; per-stage 5-second timeouts on the LLM/Jira lookups so a DM never hangs on a
progress line; every failure ends in an actionable message; keep-alive against Render sleep; JQL is
validated against Jira before a trigger is saved; poller stamps `last_polled_at` even on failure.

**Still open.** Jira triggers have no per-hour cap beyond 10 asks per run per trigger (a 2-minute
cadence allows 300/hour). Rate limits and dedup are in memory and reset on restart. Nothing manages
Slack API rate limits centrally. No external uptime monitor. No dry-run mode for a new trigger — the
8 September incident (a trigger accidentally saved as global DM'd many PMs before we were ready) is
what motivated `scope=personal` → pilot list → global; a **preview of "who would be asked"** before
saving would close this properly.

### F5 — Governance

**Done.** Scope is explicit per trigger (JQL, audience, action) and visible to admins in App Home;
creation/edit/delete is admin-only and reported to ops; the spec is the change log (§14 history, 27
numbered decisions); the scenario catalog (35 candidate asks) is triaged in writing before anything is
built, each with its Jira-side dependency named.

**Still open.** There is no second pair of eyes: the same two admins design, build and approve
triggers. The Jira scope grew from "SNS only" to SNS + PR without a review step. Proposal: a short
**trigger review checklist** (audience, projects, fields written, fallback allowed?, pilot first) that
an admin fills in the ops channel before flipping a trigger to global, and a quarterly review of active
triggers with Security.

### F6 — Data leaving Jira

**Done / unchanged.** The bot only DMs the person the issue already concerns (reporter, assignee, a
named owner field), with the issue key, summary, status, target dates, the notifier's one-line
diagnosis, a 400-character Notes preview, and current field values. No issue descriptions, comments or
attachments are sent. Channel triggers only ever post a one-line confirmation in the thread.

**New in September and not yet reviewed.** Jira content now also goes to **Azure OpenAI**: the user's
free text, the issue summary, the notifier's diagnosis, child issues' keys/status/summaries (Fix Version
suggestion), and current field values (collect). Prompts are in spec §8. This needs a data-processing
decision (which Azure tenant, no-training terms, data residency) — it is the same class of question as
Lauren's, one hop further.

## 4. Risks introduced by the rebuild (not present in March)

Ranked by what an attacker could do with them.

| # | Risk | Detail | Fix |
|---|---|---|---|
| R1 | **Unauthenticated `/send-dm` endpoint on the public URL** | `GET https://myslackagent.onrender.com/send-dm?user=…&issue=…&fieldId=…&value=…&question=…` makes the bot DM any Slack user a genuine-looking Yes/No question; on *Yes* the field is written to Jira **as that user** (or as the service account). A demo shortcut that became a phishing primitive. | **Remove it** (or require a shared-secret header and an allowlist of callers). P0. |
| R2 | **OAuth tokens stored in plaintext** | `oauth_tokens` holds access *and refresh* tokens (`offline_access`) for every connected user, readable with the Supabase secret key, which the app holds and which bypasses RLS. A Supabase or Render env leak = long-lived Jira write access as every connected user. | Encrypt at rest (pgcrypto or app-level key held only in Render); enable RLS; rotate the Supabase key; add a **Disconnect** button and delete tokens on offboarding. P0. |
| R3 | **OAuth `state` is the Slack user id** | Predictable, no nonce, no expiry. An attacker can complete the consent flow with *their* Atlassian account and `state=<victim>`, binding their Jira identity to the victim's Slack account: the victim's subsequent clicks are executed and audited as the attacker (audit poisoning), or vice-versa. | Random, single-use, time-limited `state` stored server-side and mapped to the Slack user. P0. |
| R4 | **Inbound HTTP exists again** | March's "no inbound exposure" no longer holds: `/oauth/callback`, `/health`, `/send-dm` are public. Only the callback is needed. | Remove `/send-dm`; keep `/health` unauthenticated but trivial; rate-limit the callback. |
| R5 | **Third-party hosting with production data** | Render free tier (no SLA, sleeps, US region unknown to us), Supabase, Azure OpenAI. Secrets (Slack tokens, Jira API token, OAuth client secret, Supabase key, OpenAI key) live in Render's environment. Not reviewed by IT/Security; company hosting policy unknown. | Decide hosting with IT (company Kubernetes / Azure) or approve Render paid tier + region; secrets manager. |
| R6 | **LLM-driven writes without a preview on the Yes/No path** | `interpretJiraResponse` may transition, set a field, **add a comment or assign the issue** from the user's free text; only the collect ask shows a preview before writing. Jira content in prompts (child summaries, Notes) is an injection surface. | Preview-then-confirm for every LLM decision (as collect does); constrain the JSON schema (no assignee/comment unless the trigger allows). |
| R7 | **Logs contain user text** | See F3. | Redact. |
| R8 | **Bot can DM anyone in the workspace** | `im:write` + `users:read.email` let the bot look up any employee by Jira email and message them. Correct for the product, but the blast radius of a mis-scoped trigger is the whole company (8 September incident). | Pilot list + personal scope are the current controls; add a "who would be asked" preview and a hard cap per trigger per day. |
| R9 | **Customer-visible fields are now written from Slack** | The collect ask writes *Customer-friendly name* and *Customer value* on PR Initiatives — text that the certified roadmap shows to customers. It is written as the PM, after a preview, but a typo or an LLM paraphrase becomes customer-facing. | Keep the preview mandatory (it is); consider a second approver for certified Initiatives. |
| R10 | **Broader Slack scopes** | Six more bot scopes than March, including private-channel history (`groups:history`) so triggers can run in private channels. | Reviewed and needed; document per scope which feature uses it (spec §9.1 does). |
| R11 | **Free-tier operational fragility** | Render sleeps after 15 min without HTTP; the bot self-pings to stay up. A sleeping bot loses in-memory dedup/rate-limit state and misses reactions. | Paid tier or company hosting; external monitor. |

## 5. What we still need to do — prioritised

**P0 — before opening beyond the pilot group**
1. Remove `/send-dm` (R1). Half a day.
2. Random single-use `state` with expiry for OAuth (R3). Half a day.
3. Encrypt OAuth tokens at rest, enable RLS, rotate the Supabase secret key, add Disconnect (R2). One to two days.
4. Stop logging user free text and extracted values (R7). One hour.
5. `require_oauth` per trigger, on by default for PR; the service-account fallback becomes an explicit exception (F1). One day.

**P1 — before general availability**
6. Hosting decision with IT/Security: company infrastructure or approved PaaS tier and region; secrets in a managed store (R5).
7. Data-processing approval for the Azure OpenAI flow; confirm tenant, retention and no-training terms (F6).
8. Preview-then-confirm for all LLM-driven writes; restrict the decision schema (R6).
9. Per-trigger daily cap and a "who would be asked" preview before saving (F4, R8).
10. Trigger review checklist and quarterly active-trigger review with Security (F5).
11. Least-privilege pass on the Jira service account with IT (F1).
12. CI: dependency and secrets scanning; a test asserting no token/text is logged.

**P2 — productisation (spec §16)**
13. Slack app install flow (multi-workspace), tenant id on every table, external monitoring, immutable audit store, SSO for the admin surface.

## 6. Decisions we need from Security

1. **May the current pilot continue** (about ten users, SNS + PR, OAuth writes, service-account fallback labelled) while P0 is done this week — or must it pause until P0 lands?
2. **Hosting**: is Render acceptable at all (paid tier, EU/US region), or must this move to company infrastructure before GA?
3. **Azure OpenAI data flow**: is the current tenant/contract acceptable for Jira summaries, Notes previews and users' free text?
4. **Fallback policy**: is a labelled service-account write ever acceptable, or is OAuth mandatory for all writes?

## 7. Reference — environment facts

| Item | Value |
|---|---|
| Code | GitHub `omerm55/mySlackAgent`, branch `claude/slack-jira-integration-nRbia` (auto-deploys) |
| Runtime | Node 22, `@slack/bolt` (Socket Mode), `axios`, `pino`; 193 Jest tests |
| Hosting | Render web service, free plan; public URL `https://myslackagent.onrender.com` (`/oauth/callback`, `/health`, `/send-dm`) |
| Data store | Supabase Postgres: `oauth_tokens`, `integrations`, `jira_triggers`, `jira_prompts`, `release_calendar`, `user_preferences`, `activity_log`; accessed with the secret (service-role) key; no RLS |
| Secrets (Render env) | Slack bot + app tokens, signing secret; Jira service-account email + API token; Atlassian OAuth client id + secret; Supabase URL + secret key; Azure OpenAI key/endpoint; admin Slack ids; ops channel id |
| Slack scopes | `channels:history groups:history channels:read groups:read channels:join reactions:read chat:write im:history im:write users:read users:read.email` + app-level `connections:write` |
| Atlassian OAuth | 3LO app, scopes `read:jira-user read:jira-work write:jira-work offline_access`, distribution "Sharing", callback on Render |
| Jira projects written | SNS (epic acceptance flow), PR (risk review: status / Notes / Project target; collect: Customer-friendly name / Customer value) |
| External data flows | Slack ⇄ bot; bot → Jira Cloud (as user or service account); bot → Azure OpenAI (prompts in spec §8); bot ⇄ Supabase |
| People | Owner Omer Meshar (PH Ops); admins per `ADMIN_SLACK_USER_IDS`; ~10 pilot users |
