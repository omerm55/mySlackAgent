# Slack ↔ Jira Bot — Security summary (September 2026)

> For the security review thread of 30 March – 15 April 2026 (Dennis Ong, Abhishek Rath, Jeffrey Kinum,
> Lauren Bauman, Yael Lev). It answers two questions: **what we did about each point of the March
> feedback, and what still remains.** Owner: Omer Meshar (PH Ops). Technical detail is in
> [`PROJECT_SPEC.md`](PROJECT_SPEC.md); the March design is preserved in [`architecture.md`](architecture.md).

## 0. Status, stated plainly

- **The March review ended with "please don't deploy anything to production"** (Abhishek, 15 April),
  pending a proper review the security team had no bandwidth for at the time.
- **Since 8 September the rebuilt bot runs on Render and is in use** by about ten people in Product
  (PMs, a few Dev owners) as part of a hackathon. It writes to the SNS and PR Jira projects. **No
  security sign-off has been obtained for this.** This document is the input for that review; the ask
  is a decision on §5 and §6, not a retroactive approval.
- The system is materially different from the one reviewed in March. The two headline changes:
  **Jira writes happen as the real user through their own Atlassian consent**, and the bot now
  **initiates conversations** (polls Jira, DMs the person an issue concerns, asks them to act) instead
  of only reacting to Slack.

## 1. What March asked for

The March version: a Socket-Mode bot with no inbound ports; a 👍 reaction or thread reply on a message
containing a Jira key set one Jira field via a **single Jira service account**; configuration in JSON
files on the server; allowlists, per-integration hourly rate limit, dedup cache, attribution comment on
the issue, daily audit summary and alerts to an ops channel (added on 30–31 March in response to the
review).

Abhishek's five expectations, plus Lauren's question:

| # | Feedback (30 March) | In our words |
|---|---|---|
| F1 | *Authorization model.* "Any Slack user triggers actions via a single service account … effectively removing RBAC." | Writes must be bound to the acting person's own Jira permissions, or scoped equivalently. |
| F2 | *Ownership & accountability.* A named owner for behaviour, correctness, incidents. | Someone answers for it. |
| F3 | *Audit & traceability.* "Who triggered what and why", scoped to few projects. | Every write attributable to a person, with the reason, in a place auditors can query. |
| F4 | *Operational controls.* Monitoring, alerting, rate limiting, constraints — "not an unbounded automation". | Caps and alarms. |
| F5 | *Governance.* New use cases go through review, not ad-hoc expansion; how is it monitored. | A change-control path and a scope boundary. |
| F6 | *Data* (Lauren). Does Jira ticket content reach Slack? Support tickets may contain customer data. | Which Jira data leaves Jira, to where. |

## 2. What the system is today, compared with March

| Area | March | Today |
|---|---|---|
| Identity for Jira writes | One service account (`JIRA_API_TOKEN`) | **Per-user Atlassian OAuth 2.0 (3LO), required for writes.** The service account reads and polls; it writes only on triggers an admin has explicitly marked, with an attribution comment |
| Trigger sources | Slack reactions / replies | + **Jira triggers**: a JQL condition polled on a cadence → DM the reporter / assignee / a named owner field → Yes/No/Reply, a risk review, or a "fill these fields" ask |
| Configuration | JSON files in git / on the server | **App Home modals** (admins only) → **Supabase** tables |
| Hosting | systemd / Docker on a company host (design) | **Render** (PaaS, free tier) with a public HTTPS endpoint for the OAuth callback |
| State | In memory | **Supabase** (Postgres): OAuth tokens (encrypted), triggers, prompts, preferences, activity log |
| LLM | none | **Azure OpenAI (GPT-5.1)** interprets free-text replies, suggests Fix Versions, tidies Notes, extracts field values |
| Jira scope | SNS only ("only the Sisense project") | **SNS and PR** (Product Roadmap, incl. two customer-visible text fields) |
| Slack scopes | `channels:history reactions:read chat:write users:read users:read.email` | + `groups:history channels:read groups:read channels:join im:history im:write` |

## 3. Feedback → what we did → what remains

### F1 — Authorization model (the core objection)

**What we did.**
- **Every write runs as the person, through their own Atlassian consent.** Each user connects once
  (Atlassian OAuth 3LO, scopes `read:jira-user read:jira-work write:jira-work offline_access`,
  `prompt=consent`). A button click or modal submit resolves *their* token and calls Jira as them, so
  **Jira's own permission scheme, workflow validators and field-level rules apply unchanged** — the bot
  cannot make a user do in Jira what they could not do themselves. Seen in practice: PR workflow
  validators (Planned release / PM owner required) reject bot-initiated transitions exactly as they
  reject a human, and the *Included in Certified Roadmap* revert automation is untouched because the
  bot never writes that field.
- **A person who has not connected Jira cannot trigger a write.** They see "Connect Jira first, then
  press the button again"; the ask stays open and nothing is written for them. Channel reactions get a
  thread reply asking them to connect and react again. The service account acts for unconnected people
  only on triggers where an admin ticked *Allow the bot account to act for people who haven't connected*
  — off by default and for every existing trigger, shown as 🤖 in App Home, and always with an
  attribution comment on the issue and an "acting as bot" line in the ops channel.
- **Audience is a property of the trigger, not "anyone in Slack".** Channel triggers: channel membership
  plus an optional allowlist of Slack users. Jira triggers: the DM goes only to the reporter, assignee,
  or the person named in a specific Jira user field (e.g. PR Dev Owner, PR PM Owner) of that issue;
  nobody else can act on that ask. Two roll-out gates on top: `scope = personal` (only the trigger's
  creator is ever DM'd) and a **pilot list** (only named Slack users are asked; everyone else is skipped
  without being recorded).
- **Trigger management is admin-only** (`ADMIN_SLACK_USER_IDS`). Regular users see only their own
  connection, notification preference and activity in App Home; editing someone else's trigger is refused.

**What remains.**
- The service account's own Jira permissions have not been reduced to the minimum set (IT action).
- The admin list is an environment variable with two names, not a managed group.
- Whether the per-trigger bot-account exception should exist at all is a decision for Security (§6).

### F2 — Ownership & accountability

**What we did.** Owner: Omer Meshar / PH Ops, named in the spec header and here. The spec carries a
runbook (setup, SQL, symptoms, key rotation) and the repository rule that every behaviour change updates
the spec in the same commit. Each trigger records who created it.

**What remains.** No on-call or incident procedure beyond "the ops channel alerts Omer"; no kill switch
other than deleting the trigger in App Home or suspending the Render service.

### F3 — Audit & traceability

**What we did.**
- **Jira's own changelog names the real person** for every write, because the write is made as them.
  Where the bot account is allowed to act, an attribution comment ("changed by X via Slack") is added.
- **The ops channel** (`#ph-ops-ops`, private) receives every ask sent, every click (with the identity
  used), every LLM decision with the user's text, every trigger create/edit/delete/run, digests and FYIs
  sent, and a daily summary. Trigger management output goes only there, never to user DMs.
- **An `activity_log` table** holds each user's history of what they did through the bot (shown in
  their App Home); `jira_prompts` records who was asked about which issue, when, and when they answered.
- **The "why" lands in Jira for the owner loops**: the risk review writes a dated line into the
  Initiative's Notes; the field-collection ask writes the values themselves.
- **Application logs carry no user content** — issue key, action and text length only.

**What remains.**
- For plain Yes/No asks the *reason* exists only in the Slack thread and the ops channel, not in Jira.
- The ops channel is the de-facto audit log: a private Slack channel with Slack's retention, not an
  immutable store.

### F4 — Operational controls

**What we did.** Per-channel-trigger hourly rate limit with an alert; error-threshold alerting in a
rolling window; dedup of Slack redeliveries; at most 10 new asks per Jira trigger per run; 5-second
caps on each LLM/Jira lookup stage so a message never hangs on a progress line; every failure ends in an
actionable message; JQL validated against Jira before a trigger is saved; a keep-alive against Render's
idle sleep.

**What remains.** Jira triggers have no hourly cap beyond 10 asks per run (a 2-minute cadence allows
300/hour). Rate limits and dedup are in memory and reset on restart. Slack API rate limits are not
managed centrally. No external uptime monitor. No dry-run: on 8 September a trigger saved with the wrong
scope DM'd many PMs before we were ready, which is what led to the personal-scope → pilot-list → global
roll-out path; a "who would be asked" preview before saving would close this properly.

### F5 — Governance

**What we did.** Scope is explicit per trigger (JQL, audience, action, identity) and visible to admins
in App Home; creation/edit/delete is admin-only and reported to the ops channel; the spec is the change
log (31 numbered design decisions); a catalog of 35 candidate asks is triaged in writing before anything
is built, each with its Jira-side dependency named.

**What remains.** There is no second pair of eyes: the same two admins design, build and approve
triggers. The Jira scope grew from "SNS only" to SNS + PR without a review step. Proposal: a short
**trigger review checklist** (audience, projects, fields written, bot account allowed?, pilot first) that
an admin fills in the ops channel before a trigger goes global, and a quarterly review of active triggers
with Security.

### F6 — Data leaving Jira

**What we did / what is unchanged.** The bot only DMs the person the issue already concerns (reporter,
assignee, a named owner field), with the issue key, summary, status, target dates, the notifier's
one-line diagnosis, a 400-character Notes preview, and current field values. No issue descriptions,
comments or attachments are sent. Channel triggers only post a one-line confirmation in the thread.

**What remains — new since March and not yet reviewed.** Jira content now also goes to **Azure OpenAI**:
the user's free text, the issue summary, the notifier's diagnosis, child issues' keys/status/summaries
(Fix Version suggestion), and current field values. Prompts are in the spec (§8). This needs a
data-processing decision — which Azure tenant, no-training terms, data residency. It is the same class of
question as Lauren's, one hop further.

## 4. Additional precautions we took (not asked for in March; listed for completeness)

- **OAuth connect links are random, single-use and expire after 24 hours.** A reused, stale or forged
  link gets a "this link has expired or was already used" page and nothing is stored.
- **OAuth tokens are encrypted at rest** (AES-256-GCM) with a key that lives only in the runtime
  environment; the database holds ciphertext. The bot refuses to start if tokens exist and the key is
  missing, rather than run with unreadable or unprotected tokens. Key rotation is a two-deploy runbook.
- **Row Level Security is enabled on every table with no policies**, so only the server's key can read
  or write; the public keys get nothing. **The server's database key was rotated** after the encryption
  change and the previous key revoked.
- **Users can disconnect** from App Home at any time; the tokens are deleted and the confirmation links
  to Atlassian's own "Connected apps" page for revocation on their side.
- **The public HTTP surface is two paths**: `/health` and the OAuth callback. Everything else is 404, and
  a test pins this. Slack traffic is outbound Socket Mode; no inbound Slack endpoint exists.
- **No user content in application logs**; a test asserts it.
- **Preview before any LLM-driven write.** Both places where an LLM interprets free text — the
  field-collection ask and the free-text reply to a question — show the person exactly what will change
  and require an explicit Confirm; Cancel restores the original ask and nothing is written. A value the
  person typed always beats one the model extracted. **The LLM never writes to Jira on its own.**
- **Roll-out gates**: a new trigger is created as *only me* by default, so its first run reaches only its
  author; a pilot list then limits it to a few named people before it is opened to everyone matched.
- **Volume caps that survive restarts**: besides the per-run limit, each trigger has a 24-hour budget
  counted in the database, so a mis-scoped or looping trigger cannot keep messaging people; reaching it
  is reported to the ops channel.
- **Time-boxed operations**: every lookup stage is capped at 5 seconds and every message ends in an
  actionable state.
- **Automated checks on every change**: tests, a dependency audit that fails on high or critical
  advisories, a secret scan over every tracked file, and a check that the specification was updated with
  the code. The dependency gate immediately surfaced and fixed a high-severity advisory in our HTTP
  client; the tree is currently clean.

## 5. What still remains, and the risks we see

In rough priority order, each with the mitigation we propose.

| # | Open item | Why it matters | Proposed mitigation |
|---|---|---|---|
| 1 | **Hosting on Render (free tier) with production secrets** | No SLA, instance sleeps, region not chosen by us; Slack/Jira/OAuth/Supabase/OpenAI secrets live in Render's environment; not reviewed by IT/Security | Decide with IT: company infrastructure, or an approved Render tier and region; secrets in a managed store |
| 2 | **Azure OpenAI data flow** (F6) | Jira summaries, Notes previews and users' free text leave Jira and Slack | Data-processing approval: tenant, retention, no-training terms |
| 3 | **Service-account permissions not minimised** (F1) | The account can do more in Jira than the bot needs | Least-privilege pass with IT |
| 4 | **No "who would be asked" preview before a trigger is saved** (F4) | An admin cannot see the audience a JQL resolves to until it runs; volume is now capped and new triggers start as *only me*, so the blast radius is small, but the list is still not shown up front | Render the resolved audience in the trigger modal before saving |
| 5 | **No second approver for triggers; scope grew SNS → PR without review** (F5) | Governance rests on two people | Trigger review checklist; quarterly review with Security |
| 6 | **Customer-visible fields are written from Slack** | *Customer-friendly name* / *Customer value* appear on the certified roadmap | Preview is mandatory today; consider a second approver for certified Initiatives |
| 7 | **Broader Slack scopes than March** | Six more bot scopes, incl. private-channel history | Needed for private-channel triggers; each scope is mapped to a feature in the spec (§9.1) |
| 8 | **Audit trail lives in Slack** (F3) | Retention and immutability are Slack's | Immutable store for the audit events (post-pilot) |

## 6. Decisions we need from Security

1. **May the pilot continue** (about ten users, SNS + PR, every write as the user and confirmed by them,
   no service-account writes unless an admin enables it per trigger) while items 1–2 above are decided?
2. **Hosting**: is Render acceptable at all (paid tier, EU/US region), or must this move to company
   infrastructure before general availability?
3. **Azure OpenAI data flow**: is the current tenant/contract acceptable for Jira summaries, Notes
   previews and users' free text?
4. **Bot-account exception**: should the per-trigger "allow the bot account to act for unconnected
   people" option exist at all, or should we remove it so that OAuth is the only path?

## 7. Reference — environment facts

| Item | Value |
|---|---|
| Code | GitHub `omerm55/mySlackAgent`, branch `claude/slack-jira-integration-nRbia` (auto-deploys) |
| Runtime | Node 22, `@slack/bolt` (Socket Mode), `axios`, `pino`; 228 Jest tests |
| Hosting | Render web service, free plan; public URL `https://myslackagent.onrender.com` — endpoints `/oauth/callback` and `/health` only |
| Data store | Supabase Postgres: `oauth_tokens` (ciphertext), `oauth_states`, `integrations`, `jira_triggers`, `jira_prompts`, `release_calendar`, `user_preferences`, `activity_log`; accessed with the server key; RLS enabled on all tables, no policies |
| Secrets (Render env) | Slack bot + app tokens, signing secret; Jira service-account email + API token; Atlassian OAuth client id + secret; Supabase URL + secret key; token-encryption key; Azure OpenAI key/endpoint; admin Slack ids; ops channel id |
| Slack scopes | `channels:history groups:history channels:read groups:read channels:join reactions:read chat:write im:history im:write users:read users:read.email` + app-level `connections:write` |
| Atlassian OAuth | 3LO app, scopes `read:jira-user read:jira-work write:jira-work offline_access`, distribution "Sharing", callback on Render; access tokens 1 h, refresh tokens rotated on use |
| Jira projects written | SNS (epic acceptance flow), PR (risk review: status / Notes / Project target; field collection: Customer-friendly name / Customer value) |
| External data flows | Slack ⇄ bot; bot → Jira Cloud (as the user; service account for reads); bot → Azure OpenAI (prompts in spec §8); bot ⇄ Supabase |
| People | Owner Omer Meshar (PH Ops); admins per `ADMIN_SLACK_USER_IDS`; ~10 pilot users |
