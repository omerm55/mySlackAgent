# mySlackAgent — Project Specification

> Slack ↔ Jira agent: turns existing Slack behaviour (👍 reactions, thread replies) and Jira state
> (JQL conditions) into Jira updates, with a human-in-the-loop DM conversation, per-user OAuth so
> changes are attributed to the real person, and an LLM to interpret free-text answers and to
> suggest values (e.g. an epic's Fix Version).
>
> Status: hackathon build (Sept 2026), deployed and in use at Sisense. Repository and source of
> truth: `gitlab.rnd.sisense.com/Omer.Meshar/jira-slack-bot` (moved from GitHub, §11.4). Trunk:
> `main`. Render deploys `main` through the GitHub push mirror — Render cannot reach the internal
> GitLab (§11.4).
> Production URL: `https://myslackagent.onrender.com`. Tests: `npm test` (267 passing, 28 suites).

This document is written so that a person **or an LLM with no prior context** can understand what the
system does, how it is built, how to operate it, and what remains for production. Every script,
SQL statement and configuration used so far is included verbatim.

**Maintenance rule:** this spec is updated in the same commit as any change to behaviour, schema,
configuration, prompts or operations. The per-section checklist lives in the repository root
`CLAUDE.md`; a change without its spec update is treated as incomplete.

---

## Table of contents

1. [Problem and goals](#1-problem-and-goals)
2. [What it does (feature inventory)](#2-what-it-does-feature-inventory)
3. [Architecture](#3-architecture)
4. [Repository layout](#4-repository-layout)
5. [Runtime components](#5-runtime-components)
6. [Data model (Supabase / Postgres)](#6-data-model-supabase--postgres)
7. [End-to-end flows](#7-end-to-end-flows)
8. [LLM usage](#8-llm-usage)
9. [External configuration](#9-external-configuration)
10. [Environment variables](#10-environment-variables)
11. [Deployment](#11-deployment)
12. [Operations runbook](#12-operations-runbook)
13. [Testing](#13-testing)
14. [Design decisions and history](#14-design-decisions-and-history)
15. [Known limitations](#15-known-limitations)
16. [Productization plan](#16-productization-plan)
17. [Glossary](#17-glossary)
18. [Scenario catalog and requirements](#18-scenario-catalog-and-requirements)

---

## 1. Problem and goals

PMs, CSMs and R&D leads triage and discuss work in Slack, but the system of record is Jira. Every
"👍 this bug is reviewed" or "yes, this epic is done" still requires opening Jira and editing a
field, which is a small interruption dozens of times a week and frequently just doesn't happen, so
Jira drifts from reality.

**Goal:** the Slack action *is* the Jira update, attributed to the real person, with the bot asking
first when the change is consequential.

Design principles that shaped the build:

- **Trigger from behaviour people already have** (reactions, replies) rather than slash commands.
- **Human in the loop for anything non-trivial:** the bot DMs a question with Yes / No / Reply.
- **Attribution matters:** use the user's own Jira identity via OAuth; fall back to a service account
  and say so.
- **Self-service configuration from Slack:** triggers are created and edited from the App Home, not
  by redeploying.
- **Operator visibility:** every event the bot handles is echoed to an ops channel.
- **Never leave a stuck message:** every long operation reports progress and always ends in an
  actionable state.

---

## 2. What it does (feature inventory)

### 2.1 Channel triggers (reaction / reply → set a Jira field)

A *channel trigger* watches one Slack channel. When a message there contains a Jira issue key or
browse URL and someone reacts 👍 / ✅ (or replies in its thread), the bot sets a configured Jira field
on that issue and confirms in the thread.

- Accepted reactions: `+1`, `thumbsup`, `thumbs_up`, `white_check_mark`, including skin-tone
  variants (`+1::skin-tone-3`).
- Per-trigger: name, channel, trigger types (reaction and/or reply), Jira field id, display name,
  value, scope (`global` = anyone in channel; `personal` = only the creator), rate limit, allowlist.
- Deduplication per (trigger, message, user); hourly rate limit per trigger.
- Bot auto-joins public channels when a trigger is created; private channels need `/invite`.

### 2.2 Jira triggers (JQL condition → DM the right person → act on their answer)

A *Jira trigger* polls a JQL on a per-trigger cadence (2 min … daily). For every newly matching
issue it resolves the reporter or assignee to a Slack user (by email) and DMs them a question with
**Yes / No / 💬 Reply** buttons. On Yes it either transitions the issue to a target status or sets a
field, as that user via OAuth. Each issue is asked about once per trigger (`jira_prompts`), and
re-asked automatically if the Yes fails.

Flagship use-case: *epics in Acceptance* — a Jira Automation moves an epic to Acceptance when all
children are Done; the bot asks the reporting PM to approve and move it to Done.

**Rolling out safely.** **New triggers default to `scope = personal`** — the first run reaches only the
creator, so a mis-typed JQL cannot surprise the company (that is exactly what happened on 8 Sept). Two
controls: `scope` (`personal` = only the creator is ever DM'd; `global` = anyone matched) and an optional
**pilot list** of Slack users. While a pilot list is set, only those
people are asked (and FYI'd); everyone else the JQL matches is skipped *without* being recorded, so
clearing the list later asks them normally. `scope=personal` is checked first and wins: a pilot list
only has an effect together with `scope=global`. Typical path: personal → global + pilot list → global.

### 2.3 DM conversation (Yes / No / Reply, LLM-interpreted)

- **Yes** applies the proposed action immediately.
- **No** records a decline.
- **💬 Reply** opens a modal; free text such as *"not yet, waiting on QA"*, *"yes but set it to Needs
  Review"*, *"move it to In Review and assign to Gaby"* is interpreted by an LLM into a structured
  action (update field / transition / comment / assign / no-op) and shown back as a **preview**:
  *"🤖 Here's what I understood — nothing is changed yet"* with the bullet list of intended changes,
  the person's own words quoted, and **✅ Confirm · ✏️ Edit reply · Cancel**. Nothing reaches Jira until
  Confirm. *Edit reply* reopens the modal with their text; *Cancel* restores the original Yes/No/Reply
  ask; a `no_action` decision needs no confirmation and just finalises the message; an LLM failure leaves
  the Yes/No/Reply buttons in place. **The LLM never writes to Jira on its own** — this and the collect
  ask both require an explicit human confirmation of the exact change.
- If the user hasn't connected Jira, the question carries a **🔗 Connect Jira** button.
- **OAuth is required for writes.** Pressing Yes / a risk button / Save / Reply without a connection
  writes nothing: the ask is put back exactly as it was, with its buttons, plus *"🔐 Connect Jira first,
  then press the button again."* Connect (10 s) and press the same button — the write then happens under
  your name. Read-only buttons (No, Skip, Handled, Cancel) always work. An admin may tick **"Allow the
  bot account to act for people who haven't connected"** on a specific trigger; then the old behaviour
  applies for that trigger (bot writes, attribution comment, "acting as bot" in ops).

### 2.4 Fix Version assistance

If a transition fails because Jira requires a Fix Version (workflow validator), the bot suggests one
from the epic's child issues, the date it entered its current status, and a release calendar, then
offers **✅ Use X & retry**, **Use Y instead**, and **🏷 Choose another…** (a picker of project
versions). Required *Resolution* is auto-filled (Done → Fixed → Resolved).

### 2.5 Per-user OAuth (Atlassian 3LO)

Users connect once (App Home → Connect Jira, or the button in a DM). Every Connect link carries a
**random, single-use `state`** that maps to the Slack user server-side and expires after 24 hours; a
reused, stale or forged link gets a "This link has expired or was already used" page and nothing is
stored. Tokens persist in Supabase **encrypted at rest** (AES-256-GCM, key only in the runtime
environment — `TOKEN_ENCRYPTION_KEY`), refresh automatically, and survive restarts. **Disconnect** in
App Home forgets the tokens at any time (Atlassian-side revocation is a link in the confirmation). **Writes
need the person's own token**: without one the bot asks them to connect and keeps the ask open; only
triggers an admin has marked `allow_bot_fallback` let the service account act instead (with an
attribution comment naming the Slack user). Reads and polling always use the service account.

### 2.6 App Home

Everyone sees: OAuth status + Connect button (or **Disconnect** when connected, with a confirm modal); notification preference; how it works; **their recent
activity** (last 5 Jira changes the bot made on their behalf — reactions, replies, DM Yes / free-text,
risk-review actions — read from the persistent `activity_log` table, so it survives restarts).
**Admins only** (`ADMIN_SLACK_USER_IDS`) additionally see channel triggers and Jira triggers with
➕ Create and per-row ⋯ menus (✏️ Edit, ▶️ Run now, 🔁 Re-ask open matches, 🗑 Delete). Non-admins
cannot create or see triggers at all.

### 2.7 Notification preferences (digests)

Each user chooses **Immediately** (default), **Hourly**, **Twice a day (09:00 & 15:00)** or
**Once a day (09:00)** in their Slack time zone. Non-immediate users have questions queued and
delivered in a burst (header + one message per question) at their slot.

### 2.9 R&D Initiative risk review (notifier → Dev owner loop)

The `rd-initiative-notifier` Claude skill runs weekly per domain, flags PR Initiatives (Overdue, Progress
red/orange, Missing inputs, Status mismatch, Placeholder target), posts to the leads' channel and writes a
one-line diagnosis onto each flagged Initiative in **`Latest notification`** (`customfield_15525`), e.g.
`Sep 8 — Overdue 5d; Progress red 12%/exp 50%. Action: flag at risk; update progress`. It does not DM owners.

A Jira trigger with **ask type `risk_review`** reads that field and DMs the **Dev owner** (`PR Dev
Owner/FC Sponsor`, `customfield_11962`, fallback assignee → reporter) with the diagnosis, current status,
target and the **current Notes** (first 400 chars, or "_empty_"), and buttons:

- **🟡 Low Risk / 🔴 High Risk / ⛔ Off Track** — transition as the owner. When the status is already one
  of those, **🟢 Back On Track** is offered instead (the skill's *already-at-risk* rule); when `On hold`,
  no status buttons.
- **📝 Update Notes** — modal; the text is tidied by the LLM (meaning preserved, never invents; raw text
  on failure) and **prepended** to `Notes` (`customfield_12958`) as `YYYY-MM-DD (Name): …`, keeping history.
- **📅 Move / clear target** — modal with a date picker or "clear"; writes `Project target`
  (`customfield_11818`) as a Polaris interval JSON string, or `null`.
- **✅ Handled** — records the acknowledgement; no Jira write.

After a status change the message offers *📝 Update Notes* and *Skip* (the notifier's ask is "flag at
risk **and** refresh Notes", but nobody is forced). The Notes modal shows the current Notes above the
input. The trigger uses **`watch_field = customfield_15525`**, so each weekly rewrite re-asks;
an unchanged value never does. Field ids are overridable via `PR_*_FIELD` env vars.

**Only the latest run counts.** The notifier never clears `Latest notification`, so an Initiative
flagged once keeps the text for months. The bot parses the stamp the notifier writes (`Mmm DD — …`,
current year, rolling back a year if that lands in the future) and skips notifications older than
`RISK_NOTIFICATION_MAX_AGE_DAYS` (default 8, one weekly run plus slack) without recording them; a fresh
stamp next week asks normally. Unparseable stamps are treated as fresh and logged.

**Only red progress counts (for now).** The notifier stamps every actionable Initiative — Overdue,
Stale Notes, Progress red/orange, Missing inputs, Status mismatch, Placeholder target — but the pilot
focuses on Initiatives that are *significantly behind pace*. The stamp must match
`RISK_NOTIFICATION_MATCH` (case-insensitive regex, default `progress red`; the notifier writes the
phrase `Progress red {actual}%/exp {expected}%`). Non-matching stamps are skipped without recording and
counted in the Run-now summary ("N notification(s) not about …"). Set the variable to an empty string
to review every flag, or e.g. `progress (red|orange)` to widen it. The filter is global to all
risk-review triggers (see §15).

**FYI to the PM owner.** When the Dev owner is asked, the **PR PM owner** (`customfield_11909`) gets an
informational DM at the same time — the same diagnosis, status, target and Notes, no buttons — and a one-line
follow-up whenever the Dev owner acts ("set to High Risk", "updated Notes: …", "changed the target",
"marked handled"). Skipped when PM and Dev owner are the same person. Generic: any Jira trigger can
name an FYI user field (`fyi_field_id`); risk reviews default to the PM owner when unset. FYIs are sent
immediately (they don't go through the recipient's digest preference).

### 2.10 Collect field values — Customer-friendly name & Customer value (catalog A1)

The first `collect` ask: a Jira trigger whose JQL finds PR Initiatives that lack a **Customer-friendly
name** (`customfield_11822`) or a **Customer value** (`customfield_15249`) — both plain single-line text
fields — and DMs the **PR PM owner** (`customfield_11909`, `notify = user_field`):

> 📝 *PR-1234 (Smart Alerts)* needs: *Customer-friendly name, Customer value*.
> 🌐 This Initiative is included in our *Certified Roadmap* — these fields are shown to customers as they are written here.
> • Customer-friendly name: _empty_ · • Customer value: _empty_ — **✍️ Answer** · **Skip**

The second line is read from the Initiative, never assumed: *Included in Certified Roadmap* = Yes
(`customfield_12170`) gives the customer-visibility line; otherwise *Timing* = Now (`customfield_14817`)
gives "appears on the customer-facing roadmap once it is certified"; otherwise no line. The same line
sits at the top of the answer modal. Field ids are overridable (`PR_CERTIFIED_FIELD`, `PR_TIMING_FIELD`).

**Answer** opens a modal with one free-text box ("in your own words") and one optional input per field,
prefilled with the current Jira value. On *Preview* the LLM extracts each field from the free text
(`extractFields`, §8.4 — never inventing, `null` when not stated); anything typed directly into a
field input wins over the extraction. The DM is rewritten as a **preview** — the proposed values with
**💾 Save to Jira / ✏️ Edit / Cancel**. A required field the text didn't cover shows "⚠️ not found in
what you wrote" and the Save button is withheld until *Add the missing part* fills it. **Save** writes
every field in **one PUT as the user** (`updateIssueFields`), replaces the DM with ✅ and the values,
marks the prompt answered, reports to ops and echoes to the FYI recipient if the trigger names one.
**Edit** reopens the modal prefilled with the extracted values and the author's text; **Cancel** puts
the original Answer/Skip ask back (nothing saved); **Skip** marks it answered without a write. A
failed save shows Jira's error and clears the prompt so the poller asks again. If no LLM is configured
or the call fails, the preview says so and the person fills the fields directly.

Generic: a trigger's field list (`collect_fields`, one per line in the modal —
`customfield_11822 | Customer-friendly name | hint | optional`) can name any plain-text fields; the
PM-owner audience, pilot list, digests, Connect nudge and ops reporting are the shared machinery.
Text fields only for now (§15).

### 2.11 Emergency stop (global pause)

One switch stops the bot **acting** without stopping it **listening**: no trigger is evaluated, no ask is
sent, and every write path refuses and writes nothing. Asks already in people's DMs are left exactly as
they were — the buttons work again after resuming, and no prompt row is consumed, so nothing is lost.
App Home, Slack events and the ops channel keep working so an admin can see what is happening.

Two independent switches, either of which pauses:

- **App Home → ⏸ Pause everything** (admins only; ▶️ Resume while paused). Stored in `app_settings`, so
  it takes effect within 30 seconds and needs no deploy. Everyone's Home shows a banner naming who paused
  it and when; both transitions go to the ops channel and to `audit_events` (`paused` / `resumed`).
- **`BOT_PAUSED=true`** in the environment — break-glass for when Supabase itself is the problem. It
  cannot be undone from Home (the banner says so); clear the variable and redeploy.

A database failure never pauses the bot by itself: an unreadable flag reads as "running".

### 2.8 Operator visibility

Every trigger firing, filtered event, DM sent, button click, LLM proposal and decision, digest, trigger
create/edit/delete and Run/Re-ask summary is posted to the ops channel **and written to the durable
`audit_events` table** — same text, plus `kind`, Slack user, issue key, success flag and a structured
`detail` (field, value, the identity used: user OAuth or bot account). That makes "who changed what, when,
as whom" a query rather than a Slack search, and it outlives Slack's retention. The insert is
fire-and-forget: a database hiccup never delays or breaks the operator message, and rows are written even
if no ops channel is configured. Errors above a threshold alert; a daily audit summary is posted.

---

## 3. Architecture

```
                 ┌──────────────────────────────────────────────────────────────┐
                 │                      Render web service                      │
                 │  Node 20 · @slack/bolt (Socket Mode) · http callback server   │
                 │                                                              │
 Slack ◄─WS─────►│  handlers/           services/             utils/            │
  events,        │   reactionHandler     jiraService (REST)    opsNotifier      │
  actions,       │   replyHandler        oauthService (3LO)    dmQuestion       │
  views,         │   dmHandler           supabaseService       jiraLink         │
  app_home       │   homeHandler         integrationCache      keepAlive        │
                 │   triggerHandler      jiraPoller  ──┐       withTimeout      │
                 │   preferencesHandler  digestScheduler│      admins, logger   │
                 │                       fixVersionSuggester   dedup, rateLimit │
                 │                       llmService     │      auditLog, alert  │
                 │                                      │                       │
 Browser ─HTTPS─►│  GET /oauth/callback  GET /health                            │
                 └───────────┬──────────────────┬──────┴───────────┬────────────┘
                             │                  │                  │
                      Jira Cloud REST     Supabase REST        Azure OpenAI
                    (service acct + OAuth)  (Postgres)         (GPT-5.1) / Gemini / Anthropic
```

Key properties:

- **Single process.** Slack Socket Mode (outbound WebSocket) + a tiny HTTP server for the OAuth
  callback and `/health` — **nothing else**; every other path is 404 (the unauthenticated `/send-dm`
  test endpoint was removed in Sept 2026, see §14 #28). No inbound Slack HTTP, so no public request
  URL/signing verification path is exercised (signing secret still configured).
- **Stateless-ish.** All durable state (tokens, triggers, prompts, preferences, release calendar) is
  in Supabase. In-memory caches: integrations (60 s TTL), dedup (5 min), rate limits, audit log
  (process lifetime), email→Slack id.
- **Two Jira identities.** A service account (Basic auth) for reads/polling and as fallback; the
  user's OAuth token (Bearer via `api.atlassian.com/ex/jira/{cloudId}`) for writes when connected.
- **Everything reports to ops.** `OpsNotifier` is injected into all handlers.

---

## 4. Repository layout

```
src/
  index.js                     Boot: env validation, service wiring, handler registration, timers
  loadIntegrations.js          Static integrations from config/integrations.json or INTEGRATIONS_JSON (legacy)
  loadSettings.js              config/settings.json or env (OPS_CHANNEL_ID etc.)
  handlers/
    reactionHandler.js         reaction_added → channel triggers
    replyHandler.js            message (thread reply) → channel triggers
    dmHandler.js               Yes / No / Reply, LLM execution, Fix Version offer + picker, risk review, collect
    homeHandler.js             App Home builder (publishHome / buildHomeBlocks)
    triggerHandler.js          Create/Edit/Delete/Run/Re-ask for channel + Jira triggers (modals, menus)
    preferencesHandler.js      Notification frequency select
  services/
    jiraService.js             Jira REST: issues, fields, comments, transitions, search (paginated), versions, changelog
    oauthService.js            Atlassian 3LO: random single-use state, auth URL, code exchange, refresh, per-user JiraService; Supabase-backed
    supabaseService.js         Thin axios client over Supabase REST (PostgREST)
    integrationCache.js        Static + DB channel triggers, 60 s TTL
    jiraPoller.js              Evaluates Jira triggers on their cadence; sends or queues DMs
    digestScheduler.js         Delivers queued prompts at users' slots; tz-aware slot math
    fixVersionSuggester.js     Children + acceptance date + release calendar (+ LLM) → Fix Version
    llmService.js              Provider-agnostic JSON calls (OpenAI/Azure, Gemini, Anthropic); prompts
    attributionService.js      Comment on Jira naming the human, whenever the service account acts for them
  server/callbackServer.js     HTTP: /oauth/callback, /health (and nothing else)
  utils/
    pauseState.js (global kill switch)  opsNotifier.js (ops channel + audit_events)  dmQuestion.js  riskReviewMessage.js  collectMessage.js  jiraLink.js  jiraLinkParser.js  keepAlive.js  withTimeout.js
    tokenCrypto.js (AES-256-GCM for OAuth tokens at rest, key rotation)
    admins.js  logger.js (pino)  dedupCache.js  rateLimiter.js  auditLog.js (+ activity_log)  alerting.js  userCache.js
docs/                          PROJECT_SPEC.md (this file), SCENARIO_CATALOG.md, SECURITY_SUMMARY.md (for the security review), JIRA_SERVICE_ACCOUNT.md (permission request for IT), architecture.md (March design)
supabase/                      SQL for all tables and migrations (see §6)
tests/                         Jest (267 tests, 28 suites)
config/*.example.json          Local-dev config templates (legacy path)
.github/workflows/ci.yml       CI on GitHub: tests · npm audit (high+) · secret scan · spec-updated check (PRs)
.gitlab-ci.yml                 The same four gates on GitLab (for the move to gitlab.rnd.sisense.com)
scripts/scan-secrets.sh        Secret scan over tracked files (Slack / Atlassian / Supabase / OpenAI / keys)
render.yaml  Dockerfile  docker-compose.yml  ecosystem.config.js  .env.example
```

Dependencies: `@slack/bolt ^4`, `axios`, `dotenv`, `pino`; dev: `jest ^30`. No Slack/Jira/Supabase SDKs beyond Bolt.

---

## 5. Runtime components

### 5.1 `index.js` (boot sequence)

1. Load `.env`; require `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_APP_TOKEN`, `JIRA_BASE_URL`,
   `JIRA_USER_EMAIL`, `JIRA_API_TOKEN`; exit(1) if missing.
2. `loadSettings()` (ops channel, alert thresholds, rate-limit default, daily summary hour).
3. `loadIntegrations()` → static channel triggers (may be `[]`).
4. Construct `App` (Socket Mode), `JiraService` (service account), `AttributionService`, caches,
   `SupabaseService.fromEnv()`, `OAuthService` (if `JIRA_OAUTH_CLIENT_ID`), `IntegrationCache`,
   `LlmService.fromEnv()`.
5. Build a `services` bag (with getters for late-bound `alerting`, `opsNotifier`, `jiraPoller`,
   `digestScheduler`) and register **one** handler per concern.
6. `await app.start()`; then create `Alerting`, `OpsNotifier`; `oauthService.loadFromDb()`; start
   the callback HTTP server; report the Jira service identity to ops (`whoAmI`, warns on a
   `JIRA_SERVICE_ACCOUNT_EMAIL` mismatch); start `JiraPoller` and `DigestScheduler` (if Supabase); start
   keep-alive; schedule daily summary.

### 5.2 Handlers

| File | Slack entry points | Responsibility |
|---|---|---|
| `reactionHandler.js` | `reaction_added` | Match channel triggers by channel; fetch message; extract issue keys; per-trigger scope/allowlist/**OAuth gate** (no token and `allowBotFallback` false → thread reply "connect, then react again" + auth DM + ops `reactionFiltered`, nothing written)/rate/dedup; update field via user OAuth (or the service account when the trigger allows it, with attribution comment); thread confirmation; audit + ops. |
| `replyHandler.js` | `message` (thread replies, non-bot) | Same for thread replies (root message holds the issue key), including the OAuth gate. |
| `dmHandler.js` | **`attributeIfBot`** adds the attribution comment after any successful write made by the bot account (never when the user's own token was used; a failed comment never fails the action) · actions `jira_confirm_yes`, `jira_confirm_no`, `jira_reply`, `jira_reply_confirm`, `jira_reply_edit`, `jira_reply_cancel`, `jira_fixversion_apply(_alt)`, `jira_set_fixversion`, `risk_set_status_*`, `risk_update_notes`, `risk_skip_notes`, `risk_move_target`, `risk_handled`, `collect_answer`, `collect_edit`, `collect_save`, `collect_cancel`, `collect_skip`, `dm_connect_jira`, `home_connect_jira`; views `jira_response_modal`, `jira_fixversion_modal`, `risk_notes_modal`, `risk_target_modal`, `collect_modal` | Executes the proposed action (transition or field) as the user; LLM path for free text is **preview-then-confirm** (`buildReplyPreviewBlocks` → `executeDecision`; the LLM never writes unconfirmed); Fix Version offer with progress + fallbacks; risk-review actions (status / Notes prepend / target interval / handled) with `answered_at`; collect flow (modal → `extractFields` → preview → one `updateIssueFields` PUT); **`resolveJira(user, client, ctx)`** returns the user's client, the service account only when `ctx.allowFallback`, else `null` → **`needsConnect`** re-renders the ask (the message's own blocks, or rebuilt from ctx) with a Connect nudge and leaves `jira_prompts` alone; modal openers check `canWrite` before opening; clears `jira_prompts` on failure so the poller re-asks. Pino logs carry issue keys, actions and text *lengths* only — never the user's text or extracted values (those go to the ops channel). |
| `homeHandler.js` | `app_home_opened`; actions `home_disconnect_jira`, `home_pause_bot`, `home_resume_bot`; view `home_disconnect_jira_modal` | Builds the Home view (connection with Connect / Disconnect, notifications, how it works, persistent recent activity; trigger sections **admin-only**); Disconnect → confirm modal → `oauthService.disconnect` → DM + ops line + Home refresh; exports `publishHome` for other handlers to refresh it. |
| `triggerHandler.js` | actions `home_create_trigger`, `trigger_menu`, `home_create_jira_trigger`, `jira_trigger_menu`; views `create_trigger_modal`, `create_jira_trigger_modal` | CRUD for both trigger kinds (both modals: admin-only **Jira identity** checkbox `allow_bot_fallback`, default off; Jira-trigger modal: ask type yes/no / risk review / collect (+ field list, one per line), notify reporter/assignee/user field + field id, re-ask watch field, FYI user field, pilot users (multi-user select), cadence, action); validates JQL against Jira before saving; **saves before acknowledging the modal**, so a failed write (e.g. missing migration) keeps the modal open with the reason instead of closing; runs the trigger once right after saving and posts the same summary as Run now (`runSummaryLines`: matched · not yet asked · already asked or waiting in a digest · sent · queued, with 🔔 lines for matches held for a digest); Run now / Re-ask; all outcomes reported to **ops** (not DM). |
| `preferencesHandler.js` | action `home_set_digest` | Saves digest frequency + Slack tz; flushes queue when switching to immediate. |

Button/menu payloads: the full context (issue key, proposed action, user, question ≤300 chars,
message location) is JSON in the button `value` (≤2000 chars) so clicks work after restarts; modals
carry it in `private_metadata`.

### 5.3 Services

**`jiraService.js`** — `getIssue`, `updateIssueField(key, fieldId, value, type)` (`select` → `{value}`,
`text`, `array` → `[{name}]`, `raw`), `updateIssueFields(key, {fieldId: value})` (several fields, one PUT,
values sent as given), `addComment` (ADF paragraphs), `findUser(ByEmail)`, `assignIssue`,
`whoAmI()` (`/myself` — the identity reported at boot),
`searchIssues(jql, fields, max=1000)` (POST `/rest/api/3/search/jql`, follows `nextPageToken`, flags
`truncated`), `getTransitions` (with `expand=transitions.fields`), `transitionIssue(key, status)`
(matches destination or transition name; auto-fills required Resolution; names unfillable required
fields), `getProjectVersions`, `getStatusEnteredAt(key, status)` (changelog walk, ≤500 entries),
`static fromOAuthToken(token, cloudId)`. Errors include Jira's `errorMessages`/`errors`.

**`oauthService.js`** — `async generateAuthUrl(slackUserId)` (creates a 256-bit random `state`
stored in `oauth_states` with a 24 h expiry — memory Map when there is no DB; scopes
`read:jira-user write:jira-work read:jira-work offline_access`; `prompt=consent`),
`handleCallback(code, state)` (`_consumeState` burns the state atomically → Slack user id, else throws
`OAuthStateError` with `code: 'invalid_state'`; then exchange, resolve cloudId matching `JIRA_BASE_URL`,
persist; prunes old states fire-and-forget), `hasToken`, `getJiraService(slackUserId)` (refresh if
<5 min to expiry), `loadFromDb()` (loads decrypted rows; rewrites any row that is plaintext or under a
previous key — lazy migration and rotation; rethrows `encryption_key_missing` so boot fails instead of
running with unreadable tokens), `disconnect(slackUserId)` (memory + `deleteToken`). In-memory Map is a
cache over the `oauth_tokens` table. Exports `OAuthStateError` and `STATE_TTL_MS`.

**`supabaseService.js`** — PostgREST via axios with `apikey` + `Authorization: Bearer <secret>`. Constructed
with an optional `tokenCrypto` (`TokenCrypto.fromEnv()`): `upsertToken` encrypts `access_token` /
`refresh_token`, `getToken` / `getAllTokens` decrypt (`getAllTokens` also flags `needsRewrite`); reading an
`enc:` row without a key throws `encryption_key_missing`.
Methods per table (see §6): tokens (`upsertToken`, `getToken`, `getAllTokens`, `deleteToken`),
oauth_states (`insertOauthState`, `consumeOauthState` — conditional PATCH `used_at is null and expires_at > now()` with `return=representation`, so single-use is atomic — `pruneOauthStates`),
integrations (`getActiveIntegrations`, `upsertIntegration`, `updateIntegration`, `deactivateIntegration`),
jira_triggers (`getActiveJiraTriggers`, `insertJiraTrigger`, `updateJiraTrigger`, `deactivateJiraTrigger`),
jira_prompts (`getPromptedIssueKeys`, `getPromptsForTrigger`, `recordPrompt(…, {payload, delivered})`,
`updatePromptPayload`, `markPromptAnswered`, `deletePromptsForIssue`, `deletePromptsForTrigger`,
`getPendingPrompts`, `markPromptsDelivered`, `countPromptsSince` — PostgREST `count=exact` header), release_calendar (`getReleaseCalendar`), user_preferences
(`getUserPreference`, `getDigestUsers`, `upsertUserPreference`), activity_log (`insertActivity`,
`getRecentActivity`), audit_events (`insertAuditEvent`, `getAuditEvents({issueKey, slackUserId, kind, since, limit})`).

**`integrationCache.js`** — merges static integrations with `integrations` rows (normalised to
camelCase, incl. `allowBotFallback`), refreshes every 60 s, `invalidate()` on writes.

**`jiraPoller.js`** — tick every `JIRA_POLL_INTERVAL_SEC` (60). For each active Jira trigger due per
its `poll_interval_min`/`last_polled_at`: `searchIssues(jql, fieldsFor(trigger))`, decide which issues
are new (see below), for each resolve the person via `resolvePerson` — `reporter` | `assignee` |
`user_field` (`notify_field_id`, first user of an array; fallback assignee → reporter) — → email →
Slack id (`users.lookupByEmail`, cached), honour `scope=personal`, honour the **pilot list**
(`pilot_slack_user_ids`: others are skipped and not recorded; FYIs only to listed users), honour the
user's digest preference (queue vs send), cap `JIRA_MAX_PROMPTS_PER_RUN` (10) per trigger per run **and `JIRA_MAX_PROMPTS_PER_DAY` (50) per trigger per rolling 24 h** (counted from `jira_prompts` via `countPromptsSince`, so it survives restarts and spans Run-now clicks; hitting it posts to ops and leaves the matches for later; a failed count falls back to the per-run cap rather than blocking), record prompt, stamp
`last_polled_at` even on failure. **Watch field:** when `trigger.watch_field` is set, the poller stores
the field's value in `jira_prompts.payload.watchedValue`; on later runs an issue whose current value
differs is deleted from prompts and asked again (rows predating the feature are backfilled, not re-asked).
Payloads: `yes_no` as before; `risk_review` = `{askType, issueKey, question, risk:{notification, status,
summary, targetStart, targetEnd}}`; `collect` = `{askType, issueKey, question, collect:{summary,
fields:[{id, name, hint, required, current}]}}` (`fieldsFor` requests every `collect_fields` id so the
current values ride along); all carry `allowFallback` (= `trigger.allow_bot_fallback`) and may carry `fyiSlackUserId`. **FYI:** `fyiFieldFor(trigger)`
(explicit `fyi_field_id`, else PM owner for risk reviews) → first user → Slack id; if different from the
person asked, `sendFyi` posts an informational DM right away and the id rides in the payload/button
context so `dmHandler` can echo actions to them. Returns per-trigger stats `{matched, fresh, sent, queued,
fyi, pilotSkipped, stale, offTopic, dayCapped, skipped[], sentTo[], queuedFor[]}`. `runOnce({force, onlyId})` is used by Run now / Re-ask / save.

**`attributionService.js`** — `postAttributionComment(client, slackUserId, issueKey, fieldId, fieldName,
fieldValue, trigger, integrationName)`: resolves the Slack user's name and e-mail, finds their Jira
account (`[~accountId:…]` mention, else "Name (email)"), and comments "Automated update via Slack …
Triggered by: X via <trigger> … Field 'F' set to 'V'". Called by the channel handlers *and* by
`dmHandler.attributeIfBot` for every bot-account write from a DM ask — so an action the service account
performed on someone's behalf always names that person on the issue itself, whichever surface it came from.

**`riskReviewMessage.js`** (utils) — builds the `risk_review` DM (`buildRiskReviewBlocks`,
`sendRiskReview`, `afterStatusBlocks` = Update Notes + Skip), the buttonless `sendFyi` (risk-review and
generic variants), `statusChoices(status)`, `parseInterval`, `riskContextFor(issue)` (incl. a 400-char
Notes preview), `plainText` (string or ADF → text), `notesPreview`/`notesBlock`, `notesEntry`/`prependNotes`,
and the `FIELDS` constants (env-overridable, incl. `PM_OWNER`). `sendDmQuestion` delegates to it
when `context.askType === 'risk_review'`, so digests, the Connect nudge and ops reporting are unchanged.

**`collectMessage.js`** (utils) — the `collect` ask: `parseCollectFields` / `formatCollectFields`
(trigger-modal text ⇄ `[{id, name, hint, required}]`), `collectContextFor(issue, trigger)` (current
values, capped, plus `certified` / `timing` from the PR roadmap fields), `visibilityLine(ctx)` (why the
fields matter — certified → "shown to customers", Now → "once it is certified", else nothing), `buildCollectBlocks` / `sendCollect` (Answer + Skip), `buildCollectModal(ctx, values,
{freeText})` (free text + one optional input per field, prefilled; metadata drops values/free text to stay
under Slack's 3000-char cap), `readCollectModal` (explicit values only where typed and changed),
`mergeValues(fields, explicit, extracted)` (explicit wins, 255-char cap, `null` when neither),
`previewBlocks(ctx, user, values, {note})` → Save / Edit (carries values + free text) / Cancel, Save
withheld while a required field is missing. `sendDmQuestion` delegates when `askType === 'collect'`.

**`digestScheduler.js`** — tick every 60 s. For each `user_preferences` row with
`digest_frequency != immediate`, compute the latest slot (hourly: top of hour; daily: 09:00 local;
twice_daily: 09:00/15:00 local; time zone from Slack profile) and deliver pending prompts if
`last_digest_at < slot`. Delivery = header DM + one `sendDmQuestion` per prompt (so existing button
handlers work). Exposes pure helpers `localParts`, `zonedTimeToUtc`, `currentSlotStart`, `isDigestDue`.

**`fixVersionSuggester.js`** — `suggestFixVersion({jira, llm, db, issueKey, stageTimeoutMs=5000,
onProgress})`. Stages (each capped, skipped on timeout, recorded in `degraded[]`): issue + children
(`parent = KEY`, fallback `"Epic Link" = KEY`) + project versions + release calendar (parallel);
changelog for when the epic entered its current status; LLM adjudication when evidence is mixed.
Decision order: unanimous children → LLM → timeline fit → current release → most common child version.
Returns `{pick, reason, alternative, acceptedAt, statusName, candidates, children, usedLlm, degraded}`.
"Timeline fit" = release whose branch-out window contains the acceptance date (or the next window);
"current" = window containing today (or `CURRENT_RELEASE_VERSION`).

**`llmService.js`** — `fromEnv()` picks provider by key precedence OpenAI → Gemini → Anthropic.
`interpretJiraResponse(...)`, `suggestFixVersion(...)`, `tidyNote(...)` and `extractFields(...)` all call
`_callJson(systemPrompt, user)` and parse strict JSON. Azure OpenAI is detected by `OPENAI_BASE_URL` (uses `api-key` header,
`OPENAI_DEPLOYMENT` as model, `max_completion_tokens`). Prompts in §8.

### 5.4 Utils

`pauseState` (`isPaused(db)` / `pauseState(db)` → `{paused, by, at, source}` with a 30 s cache,
`setPaused(db, on, byUser)`, `invalidate()`, `describePause(state)`; `BOT_PAUSED` or the `app_settings`
row pauses; a DB error reads as running), `opsNotifier` funnels every message through `post(text, meta)`; `meta` (`kind`, `user`, `issue`, `ok`,
`detail`) becomes the `audit_events` row, and `setDb` attaches the sink after construction.
`tokenCrypto.TokenCrypto` (`encrypt` → `enc:v1:<iv>:<tag>:<data>` base64url, `decrypt` with legacy plaintext passthrough and previous-key fallback, `isEncrypted`, `isCurrent`, `fromEnv`), `opsNotifier` (all ops messages, incl. `riskReviewAction` and `collectAction`), `dmQuestion` (`sendDmQuestion`, `buildYesNoBlocks`, `connectBlocks`, `describeDecision` → human-readable list of an LLM decision's effects, `buildReplyPreviewBlocks` → preview + Confirm/Edit/Cancel with a compacted decision in the button value) (builds
the Yes/No/Reply message, optional Connect block, no key prefix if the question already names the
issue), `jiraLink` (`issueUrl`, `issueLink`, `issueLinkLabelled` with link-safe labels — `|`→`∣`,
`<>&` escaped), `jiraLinkParser.extractJiraIssueKeys`, `keepAlive` (self-GET `/health` every 5 min),
`withTimeout`/`withTimeoutOr`, `admins.isAdmin/canManage` (`ADMIN_SLACK_USER_IDS`), `dedupCache`,
`rateLimiter`, `auditLog` (in-memory list for the daily ops summary **plus** fire-and-forget persistence
to `activity_log`; `recentFor(user)` feeds the Home tab), `alerting` (error threshold → ops), `userCache`,
`logger`.

---

## 6. Data model (Supabase / Postgres)

Project: `https://psmbjacsexnyruhvaxao.supabase.co`. Server uses the **secret (service-role) key**
via REST; RLS is not relied upon. All SQL below has been run in the SQL editor and lives under
`supabase/` (except the first two tables, created earlier by hand and reconstructed here).

### 6.1 `oauth_tokens` — per-Slack-user Atlassian tokens

```sql
create table if not exists public.oauth_tokens (
  slack_user_id  text primary key,
  access_token   text not null,   -- ciphertext: enc:v1:<iv>:<tag>:<data> (AES-256-GCM, TOKEN_ENCRYPTION_KEY)
  refresh_token  text not null,   -- same
  expires_at     timestamptz not null,
  cloud_id       text not null,
  updated_at     timestamptz not null default now()
);
```

Both token columns hold ciphertext since Sept 2026 (§14 #30). Rows written before that (plaintext) are
rewritten on the first start with a key; nothing needs a SQL migration. **RLS is enabled on every table
with no policies** (`supabase/rls.sql`) — the service-role key the app uses bypasses it, the anon key
gets nothing.

### 6.2 `integrations` — channel triggers

```sql
create table public.integrations (
  id               uuid not null default gen_random_uuid(),
  created_by       text not null,               -- Slack user id
  scope            text not null,               -- 'global' | 'personal'
  name             text not null,
  description      text null,
  channel_id       text not null,
  jira_field_id    text not null,
  jira_field_name  text null,
  jira_field_value text not null,
  jira_field_type  text null default 'select',
  triggers         text[] not null,             -- {'reaction','reply'}
  allow_bot_fallback boolean not null default false, -- admin exception: bot account may act for unconnected users
  active           boolean null default true,
  created_at       timestamptz null default now(),
  constraint integrations_pkey primary key (id)
);
create index if not exists integrations_user_idx    on public.integrations (created_by, active);
create index if not exists integrations_channel_idx on public.integrations (channel_id, active);
```

### 6.3 `jira_triggers` + `jira_prompts` — JQL-driven DMs (`supabase/jira_triggers.sql`)

```sql
create table if not exists public.jira_triggers (
  id                uuid primary key default gen_random_uuid(),
  created_by        text not null,
  scope             text not null default 'global',       -- 'global' | 'personal'
  name              text not null,
  jql               text not null,
  question          text not null,                        -- {key} {summary} {link} {status} {reporter} {assignee}
  notify            text not null default 'reporter',     -- 'reporter' | 'assignee'
  action_type       text not null default 'transition',   -- 'transition' | 'field'
  transition_to     text null,
  jira_field_id     text null,
  jira_field_name   text null,
  jira_field_value  text null,
  jira_field_type   text null default 'select',
  poll_interval_min integer not null default 2,
  last_polled_at    timestamptz null,
  ask_type          text not null default 'yes_no',      -- 'yes_no' | 'risk_review' | 'collect'
  notify_field_id   text null,                           -- when notify = 'user_field'
  watch_field       text null,                           -- re-ask when this field's value changes
  fyi_field_id      text null,                           -- user field to FYI (risk reviews default to PM owner)
  pilot_slack_user_ids text[] null,                      -- while set, only these Slack users are asked / FYI'd
  collect_fields    jsonb null,                          -- collect asks: [{id, name, hint, required}]
  allow_bot_fallback boolean not null default false,    -- admin exception: bot account may act for unconnected users
  active            boolean not null default true,
  created_at        timestamptz not null default now()
);
create index if not exists jira_triggers_active_idx on public.jira_triggers (active, created_at);

create table if not exists public.jira_prompts (
  id             uuid primary key default gen_random_uuid(),
  trigger_id     uuid not null references public.jira_triggers (id) on delete cascade,
  issue_key      text not null,
  slack_user_id  text null,            -- null = matched but nobody could be DM'd
  prompted_at    timestamptz not null default now(),
  payload        jsonb null,           -- DM context; also holds watchedValue for watch_field triggers
  delivered_at   timestamptz null,     -- null = queued, awaiting a digest
  answered_at    timestamptz null,     -- set when the user acted (button / modal)
  unique (trigger_id, issue_key)
);
create index if not exists jira_prompts_trigger_idx on public.jira_prompts (trigger_id);
create index if not exists jira_prompts_pending_idx on public.jira_prompts (slack_user_id) where delivered_at is null;
```

Migrations applied to pre-existing rows:

```sql
alter table public.jira_triggers
  add column if not exists poll_interval_min integer not null default 2,
  add column if not exists last_polled_at timestamptz null;
alter table public.jira_prompts
  add column if not exists payload jsonb null,
  add column if not exists delivered_at timestamptz null;
update public.jira_prompts set delivered_at = prompted_at where delivered_at is null;
-- supabase/risk_review.sql
alter table public.jira_triggers
  add column if not exists ask_type        text not null default 'yes_no',
  add column if not exists notify_field_id text null,
  add column if not exists watch_field     text null;
alter table public.jira_prompts add column if not exists answered_at timestamptz null;
-- supabase/fyi_field.sql
alter table public.jira_triggers add column if not exists fyi_field_id text null;
-- supabase/pilot_users.sql
alter table public.jira_triggers add column if not exists pilot_slack_user_ids text[] null;
-- supabase/collect_fields.sql
alter table public.jira_triggers add column if not exists collect_fields jsonb null;
-- supabase/require_oauth.sql
alter table public.integrations  add column if not exists allow_bot_fallback boolean not null default false;
alter table public.jira_triggers add column if not exists allow_bot_fallback boolean not null default false;
```

### 6.4 `release_calendar` — branch-out windows (`supabase/release_calendar.sql`)

```sql
create table if not exists public.release_calendar (
  version_name    text primary key,   -- must match the Jira version name (case-insensitive)
  branch_out      date not null,      -- window start
  branch_out_end  date null,          -- window end (inclusive)
  release_date    date null,
  notes           text null
);
insert into public.release_calendar (version_name, branch_out, branch_out_end) values
  ('2026.1.0','2025-12-01','2025-12-31'), ('2026.1.2','2026-02-01','2026-02-28'),
  ('2026.2.0','2026-03-01','2026-03-31'), ('2026.2.1','2026-04-01','2026-04-30'),
  ('2026.2.2','2026-05-01','2026-05-31'), ('2026.3.0','2026-06-01','2026-06-30'),
  ('2026.3.1','2026-07-01','2026-07-31'), ('2026.3.2','2026-08-01','2026-08-31'),
  ('2026.4.0','2026-09-01','2026-09-30'), ('2026.4.1','2026-10-01','2026-10-31'),
  ('2026.4.2','2026-11-01','2026-11-30'), ('2027.1.0','2026-12-01','2026-12-31'),
  ('2027.1.1','2027-01-01','2027-01-31'), ('2027.1.2','2027-02-01','2027-02-28'),
  ('2027.2.0','2027-03-01','2027-03-31'), ('2027.2.1','2027-04-01','2027-04-30'),
  ('2027.2.2','2027-05-01','2027-05-31'), ('2027.3.0','2027-06-01','2027-06-30')
on conflict (version_name) do update
  set branch_out = excluded.branch_out, branch_out_end = excluded.branch_out_end;
```

Semantics: a release is "worked on" during its branch-out month; an epic accepted on a date ships in
the release whose window contains that date (gaps roll forward). Sept 8 2026 → current = 2026.4.0.

### 6.6 `activity_log` — per-user history for App Home (`supabase/activity_log.sql`)

```sql
create table if not exists public.activity_log (
  id               uuid primary key default gen_random_uuid(),
  ts               timestamptz not null default now(),
  slack_user_id    text not null,
  slack_user_name  text null,
  integration_name text null,
  trigger          text not null,   -- '👍 reaction' | 'thread reply' | 'DM Yes' | 'DM reply' | '🩺 risk review'
  issue_key        text not null,
  field_name       text null,
  field_value      text null,
  success          boolean not null default true,
  error            text null
);
create index if not exists activity_log_user_ts_idx on public.activity_log (slack_user_id, ts desc);
```

`AuditLog.addEntry` writes here (fire-and-forget) in addition to the in-memory list used for the daily
ops summary; `AuditLog.recentFor(user)` reads the newest 5 for the Home tab, falling back to memory.

### 6.5 `user_preferences` — notification digests (`supabase/user_preferences.sql`)

```sql
create table if not exists public.user_preferences (
  slack_user_id     text primary key,
  digest_frequency  text not null default 'immediate',   -- immediate | hourly | twice_daily | daily
  tz                text null,                           -- IANA, from Slack profile
  last_digest_at    timestamptz null,
  updated_at        timestamptz not null default now()
);
```

### 6.9 `app_settings` — operational state changeable without a deploy (`supabase/app_settings.sql`)

```sql
create table if not exists public.app_settings (
  key         text primary key,      -- today only 'paused'
  value       jsonb not null,        -- {"paused": true|false}
  updated_at  timestamptz not null default now(),
  updated_by  text null              -- Slack user id
);
```

**Migration to run by hand.** RLS on, anon revoked; included in `supabase/rls.sql`.

### 6.8 `audit_events` — durable operator record (`supabase/audit_events.sql`)

```sql
create table if not exists public.audit_events (
  id             uuid primary key default gen_random_uuid(),
  ts             timestamptz not null default now(),
  kind           text not null,   -- reaction_write | reply_write | ask_sent | dm_yes | dm_no |
                                  -- risk_action | collect_action | llm_proposed | llm_applied |
                                  -- llm_error | trigger_skipped | reaction_filtered | ops
  slack_user_id  text null,
  issue_key      text null,
  ok             boolean not null default true,
  text           text null,       -- the ops-channel message, verbatim (≤4000 chars)
  detail         jsonb null       -- field, value, identity ('user (OAuth)' | 'bot account'), reason, decision
);
create index if not exists audit_events_ts_idx    on public.audit_events (ts desc);
create index if not exists audit_events_issue_idx on public.audit_events (issue_key, ts desc);
create index if not exists audit_events_user_idx  on public.audit_events (slack_user_id, ts desc);
create index if not exists audit_events_kind_idx  on public.audit_events (kind, ts desc);
```

Written by `opsNotifier.post` for every operator message (§2.8). Migration applied 10 Sept; it also
enables RLS on itself, and `supabase/rls.sql` includes it for future re-runs.

### 6.7 `oauth_states` — pending Connect links (`supabase/oauth_states.sql`)

```sql
create table if not exists public.oauth_states (
  state          text primary key,          -- 32 random bytes, base64url
  slack_user_id  text not null,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null,      -- created_at + 24 h
  used_at        timestamptz null           -- set atomically by the callback; a used row is never reused
);
create index if not exists oauth_states_expires_idx on public.oauth_states (expires_at);
```

Rows older than a day past expiry are pruned on each callback. Without Supabase the same map lives in
process memory (lost on restart — the user simply presses Connect again).

---

## 7. End-to-end flows

### 7.1 Reaction → field update

```
reaction_added ─► isThumbsUp? ─► integrationCache.getAll() filter channel+reaction
  ─► conversations.history(1) ─► extractJiraIssueKeys
  ─► resolve Jira client: OAuth token? use it : (no token)
  ─► per trigger: scope/allowlist ─► no token & !allowBotFallback? thread "🔐 connect, then react again" + auth DM + ops, skip
                                   ─► no token & allowBotFallback? service account + auth DM ("made by the bot account")
  ─► rate/dedup ─► updateIssueField ─► thread ✅ ─► attribution comment (bot-account writes only)
  ─► auditLog.addEntry ─► opsNotifier.jiraTriggered
```

### 7.2 Jira trigger → DM → action

```
JiraPoller tick ─► paused? ─► ops line (≤1/h) + stop
  ─► trigger due? ─► searchIssues(jql) (paginated) ─► minus jira_prompts
  ─► for each new issue (≤ cap): reporter/assignee email ─► users.lookupByEmail ─► scope check
  ─► preference: digest? recordPrompt(queued, payload) : sendDmQuestion(+Connect if no OAuth) + recordPrompt(delivered)
User clicks Yes ─► dmHandler.resolveJira(user, ctx): own token → as user · no token & ctx.allowFallback → bot · else null
  ├─ null ─► needsConnect: ask re-rendered with its buttons + "🔐 Connect Jira first, then press again" (nothing written, prompt kept) ─► ops
  ├─ ok ─► message replaced with ✅ (issue linked) ─► attribution comment if the bot account acted ─► ops
  ├─ "Fix Version is required" ─► offerFixVersion (progress ≤5s/stage) ─► [Use X & retry][Use Y instead][Choose another…]
  └─ other error ─► ❌ + deletePromptsForIssue (poller re-asks next run)
User clicks 💬 Reply ─► modal ─► LLM interpretJiraResponse ─► *preview* (nothing written) + ops "proposes"
  ├─ [✅ Confirm]    ─► execute (transition/field/comment/assign) as the user ─► ✅/❌ ─► ops decision
  ├─ [✏️ Edit reply] ─► modal again, prefilled with their text
  ├─ [Cancel]        ─► original Yes/No/Reply ask restored (nothing written) ─► ops
  └─ no_action / LLM error ─► message finalised / Yes-No buttons kept, nothing written
```

### 7.3 Digest delivery

```
DigestScheduler tick ─► getDigestUsers ─► isDigestDue(pref, now)?
  ─► getPendingPrompts(user) ─► header DM ─► sendDmQuestion per prompt (+Connect if needed)
  ─► markPromptsDelivered ─► upsert last_digest_at ─► ops "Digest delivered"
Switching preference to immediate ─► deliverTo(user) flushes the queue now.
```

### 7.4 OAuth connect

```
Home "Connect Jira" / DM "🔗 Connect Jira" (URL button) ─► generateAuthUrl: random state → oauth_states (24 h)
  ─► auth.atlassian.com/authorize?state=<random> ─► Atlassian consent ─► GET /oauth/callback?code&state
  ─► consumeOauthState (atomic; unknown / expired / used → 400 "expired or already used" page, nothing stored)
  ─► exchange ─► accessible-resources → cloudId ─► oauth_tokens upsert for the mapped Slack user
  ─► HTML "You can close this tab" ─► next Home open shows ✅ connected
```

### 7.5 Trigger management (App Home)

```
➕ Create Trigger / ➕ Create Jira Trigger ─► modal (inline validation; JQL validated against Jira)
  ─► insert ─► invalidate cache ─► conversations.join (public) ─► publishHome ─► ops "<@user> · ✅ created"
⋯ menu ─► edit:<id> (prefilled modal → PATCH) | run:<id> (force runOnce → ops summary)
        | reask:<id> (deletePromptsForTrigger → force run) | delete:<id> (active=false)
Permission: creator or ADMIN_SLACK_USER_IDS. Admins may set scope=global.
```

### 7.6 Risk review (notifier flag → Dev owner → act)

```
rd-initiative-notifier (weekly, Claude scheduled task) ─► writes cf[15525] "Latest notification" on flagged Initiatives
JiraPoller tick ─► trigger ask_type=risk_review, watch_field=cf[15525]
  ─► searchIssues(jql, + notify_field_id + watch field + target + Notes) ─► for each issue:
       stored watchedValue == current? skip : deletePromptsForIssue + treat as new
  ─► resolvePerson: user_field cf[11962] → first user → email → Slack id (fallback assignee → reporter)
  ─► scope=personal? only creator · pilot list set? only listed users (others skipped, not recorded)
  ─► notificationAge(cf[15525]) > RISK_NOTIFICATION_MAX_AGE_DAYS? skip (stale leftover, not recorded)
  ─► !notificationMatches(cf[15525], RISK_NOTIFICATION_MATCH)? skip (not a red-progress flag, not recorded)
  ─► FYI: fyiFieldFor → PM owner cf[11909] → Slack id ≠ Dev owner? sendFyi (no buttons) + payload.fyiSlackUserId
  ─► sendDmQuestion(payload{askType:'risk_review', risk:{notification,status,target}}) → sendRiskReview
Dev owner clicks:
  [Low/High Risk | Off Track | Back On Track] ─► transitionIssue as user ─► ✅ + [📝 Update Notes] [Skip]
  [📝 Update Notes] ─► modal (shows current Notes) ─► llm.tidyNote (fallback raw) ─► prepend "YYYY-MM-DD (Name): …" to cf[12958]
  [Skip] ─► ✅ "Notes left unchanged"
  [📅 Move / clear target] ─► modal (date | clear) ─► cf[11818] = {"start","end"} JSON string | null
  [✅ Handled] ─► answered_at only
Every action ─► markPromptAnswered ─► ops riskReviewAction ─► activity_log ─► FYI follow-up DM to fyiSlackUserId
No token (and trigger doesn't allow the bot) ─► needsConnect before the modal opens / before the write ─► ask stays open
Failure ─► ❌ with Jira's error ─► deletePromptsForIssue (re-asked next run)
```

### 7.7 Collect (A1: Customer-friendly name & Customer value)

```
JiraPoller tick ─► trigger ask_type=collect, collect_fields=[cf 11822, cf 15249], notify=user_field cf[11909]
  ─► searchIssues(jql, + collect field ids + cf[12170] Certified + cf[14817] Timing) ─► new issues only (jira_prompts) ─► PM owner → Slack id
  ─► scope / pilot list / digest preference as for every trigger
  ─► sendDmQuestion(payload{askType:'collect', collect:{summary, certified, timing, fields:[{id,name,hint,required,current}]}}) → sendCollect
       (DM + modal carry visibilityLine: certified → "shown to customers"; Now → "once it is certified")
PM clicks:
  [✍️ Answer] ─► collect_modal (free text + one input per field, prefilled with current values)
     Preview ─► nothing entered? inline error
             ─► free text covers untyped fields? "_Reading what you wrote…_" ─► llm.extractFields (15 s cap; failure → note)
             ─► mergeValues (typed > extracted) ─► preview: values · [💾 Save] [✏️ Edit] [Cancel]
                 required field missing ─► "ℹ️ Almost there — I still need …" · [✏️ Add the missing part] [Cancel] (no Save)
  [💾 Save]   ─► updateIssueFields(key, {cf11822: …, cf15249: …}) as user (ONE PUT) ─► ✅ + values
              ─► markPromptAnswered ─► ops collectAction ─► activity_log ─► FYI follow-up if fyiSlackUserId
  [✏️ Edit]   ─► modal again, prefilled with the extracted values and the author's text
  [Cancel]    ─► original Answer/Skip ask restored (nothing saved)
  [Skip]      ─► answered_at only
No token (and trigger doesn't allow the bot) ─► Answer / Save become the Connect nudge; the ask (or preview) stays as it was
Failure ─► ❌ with Jira's error ─► deletePromptsForIssue (re-asked next run)
```

---

## 8. LLM usage

Provider selection (`LlmService.fromEnv`): `OPENAI_API_KEY` (+ `OPENAI_BASE_URL` → Azure) →
`GEMINI_API_KEY` → `ANTHROPIC_API_KEY`. Current production: **Azure OpenAI, GPT-5.1 deployment**,
`max_completion_tokens: 512`, `temperature: 0.1`, 15 s HTTP timeout (5 s stage cap in the suggester).
Responses must be strict JSON; code fences are stripped defensively.

### 8.1 Free-text reply interpretation (`SYSTEM_PROMPT`)

```
You are a Jira automation assistant embedded in a Slack bot.
A Slack user has responded in free text to a yes/no question about updating a Jira issue.
Interpret their intent and return a JSON action.

The bot's proposed change is either (a) setting a field to a value, or (b) transitioning the issue to a status.

Primary action (choose one):
- "update_field": Apply the proposed field change. You may change the value if the user specifies something different.
- "transition": Move the issue to a status. Use when the proposed change is a transition and the user approves, or when the user asks to move it somewhere else (set "transitionTo" to that status name).
- "add_comment": Only add a comment, no field update or transition.
- "no_action": The user doesn't want the proposed change right now.

Optional extras (include alongside any primary action):
- "comment": a string — add this as a Jira comment (use when the user provides explanation, context, or asks to add a note)
- "assignee": a name or email string — assign the issue to this person (e.g. "Gaby", "gaby@company.com")

Respond ONLY with valid JSON (no markdown fences):
{
  "action": "update_field" | "transition" | "add_comment" | "no_action",
  "fieldValue": "<value to set, for update_field>",
  "transitionTo": "<target status name, for transition>",
  "comment": "<comment text>",
  "assignee": "<name or email of person to assign>",
  "confirmationMessage": "<one short sentence summarising what was done>"
}

Omit keys that don't apply. Always include confirmationMessage.
```

User message: issue key, the bot's question, the proposed change (field or transition), the user's text.

### 8.2 Fix Version suggestion (`FIX_VERSION_PROMPT`)

```
You are a Jira release-planning assistant.
An epic must be given a Fix Version before it can be closed. You are given:
- the epic, the status it is in, and the date it entered that status (its work was complete by then)
- its child issues with their statuses and fix versions, plus a tally of those versions
- "timelineFit": the release whose branch-out window contains the date the epic entered its status
  (releases are worked on during their branch-out window, so work finished then ships in that release)
- "current": the release whose branch-out window contains today
- the list of candidate versions that exist in the project

Choose the single most appropriate Fix Version for the epic, weighing evidence in this order:
1. The children's actual fix versions are the strongest evidence of where the code landed. If they
   span several versions, the epic ships with the LAST of them.
2. Otherwise the timelineFit release: work finished on date D ships in the release being worked on at D.
3. Otherwise the current release.
Only pick from the candidates list and answer with the candidate's "id".

Respond ONLY with valid JSON (no markdown fences):
{ "versionId": "<candidate id>", "reason": "<one short sentence a PM would find useful, mention the evidence used>" }
```

The LLM is **not** called when children are unanimous (deterministic), and its answer is validated
against the candidate list; any failure falls back to deterministic rules.

### 8.3 Notes tidy-up for risk reviews (`TIDY_NOTE_PROMPT`)

```
You tidy a short status update written by the owner of an R&D Initiative so it reads well in the
Initiative's Notes field. Rules:
- Keep the author's meaning, facts, names and dates exactly. Never add, infer or soften anything.
- Keep first person if they used it. One or two plain sentences, no bullet points, no markdown.
- Fix grammar and remove filler. If the text is already clean, return it unchanged.

Respond ONLY with valid JSON (no markdown fences):
{ "note": "<the tidied update>" }
```

User message: Initiative key + summary, the notifier's diagnosis, and the owner's text verbatim. Any
error or empty result → the raw text is written unchanged.

The reply interpretation (§8.1) is **never executed directly**: its decision is rendered as a preview the
person must confirm (§2.3, §7.2).

### 8.4 Field extraction for collect asks (`COLLECT_FIELDS_PROMPT`)

```
You extract Jira field values from a short message written by a product manager about a roadmap
Initiative. You are given the list of fields wanted (id, name, hint) and the author's text. Rules:
- Only use what the author actually said. Never invent, guess or pad. If a field is not stated, return null for it.
- Keep the author's wording and meaning; you may fix grammar and casing and drop filler such as
  "call it" / "the value is". Do not add facts, adjectives or marketing language.
- Each value is a single line of plain text, at most 255 characters, no markdown, no quotes around it.
- A "name" style field is a short noun phrase (2-6 words). A "value" style field is one sentence about
  what the customer gets, written for customers.

Respond ONLY with valid JSON (no markdown fences):
{ "values": { "<field id>": "<value or null>", ... }, "note": "<one short sentence if something was ambiguous, else null>" }
```

User message: Initiative key + summary, one line per wanted field (`id`, `name`, `hint`, `current`
value if any) and the author's text verbatim. The result is merged with the modal's explicit inputs
(explicit wins) and always shown as a preview before the single PUT; a `note` is rendered in italics
under the preview. Any error → preview without extracted values and a "couldn't read that
automatically" note.

---

## 9. External configuration

### 9.1 Slack app (api.slack.com/apps)

- **Socket Mode:** enabled; app-level token with `connections:write` → `SLACK_APP_TOKEN`.
- **Bot token scopes:** `channels:history`, `groups:history`, `channels:read`, `groups:read`,
  `channels:join`, `reactions:read`, `chat:write`, `im:history`, `im:write`, `users:read`,
  `users:read.email`.
- **Event subscriptions (bot):** `message.channels`, `message.groups`, `message.im`,
  `reaction_added`, `app_home_opened`.
- **Interactivity & Shortcuts:** enabled (Socket Mode delivers block_actions/view_submission).
- **App Home:** Home tab enabled, Messages tab enabled.
- Install to workspace → `SLACK_BOT_TOKEN`; Basic Information → `SLACK_SIGNING_SECRET`.
- The bot must be a **member** of any channel it watches (`/invite @bot`); public channels are
  auto-joined on trigger creation.

### 9.2 Atlassian OAuth 2.0 (3LO) app (developer.atlassian.com)

- Permissions: Jira API — `read:jira-user`, `read:jira-work`, `write:jira-work`; plus `offline_access`.
- Authorization → Callback URL: `https://myslackagent.onrender.com/oauth/callback`.
- **Distribution → Sharing** (required so users other than the app owner can consent), with vendor
  name, Privacy Policy URL (`https://www.termsfeed.com/live/8d31a5cc-4fad-4f5e-b586-1e52fbfa06f8`)
  and Terms of Service URL.
- Client ID / Secret → `JIRA_OAUTH_CLIENT_ID`, `JIRA_OAUTH_CLIENT_SECRET`.

### 9.3 Jira

- Service account API token (`JIRA_USER_EMAIL` + `JIRA_API_TOKEN`) used for polling/reads, and for
  writes only on triggers an admin marked `allow_bot_fallback`. **Until IT provisions a dedicated
  account this is still the bot owner's personal admin account** — the exact permissions to request and
  the switchover steps are in [`JIRA_SERVICE_ACCOUNT.md`](JIRA_SERVICE_ACCOUNT.md). At boot the bot calls
  `myself` and posts its Jira identity to the ops channel, warning when it differs from
  `JIRA_SERVICE_ACCOUNT_EMAIL` — that is how a personal account left in place gets noticed. Reporter/assignee **email visibility** to this account is required for Jira triggers
  to resolve Slack users (Atlassian profile privacy may hide it).
- Existing Jira Automation for epics: when all children are Done → move epic to *Acceptance*.
  Its Slack-notification action should be removed once the bot asks instead.

### 9.4 Supabase

Project created manually; tables per §6; server uses the secret (service-role) key. **RLS enabled on all
tables, no policies** (`supabase/rls.sql`) so only that key can read or write. OAuth tokens are
ciphertext in the table (§6.1); Dashboard → Table Editor is the operator UI for ad-hoc inspection/deletes,
and token values are not readable there — by design. Key rotation: §12.5.

### 9.5 Azure OpenAI

Company endpoint; `OPENAI_BASE_URL` = `https://<resource>.openai.azure.com/openai/deployments/<deployment>`
style base with `OPENAI_DEPLOYMENT` = deployment name (GPT-5.1). Uses `api-key` header.

---

## 10. Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_APP_TOKEN` | yes | Slack Bolt (Socket Mode) |
| `JIRA_BASE_URL`, `JIRA_USER_EMAIL`, `JIRA_API_TOKEN` | yes | Jira service account; base URL also builds issue links |
| `JIRA_SERVICE_ACCOUNT_EMAIL` | no | The account the bot is *expected* to be; a mismatch with the live identity is reported to ops at every start |
| `BOT_PAUSED` | no | `true` stops the bot acting (independent of the App Home switch; needs a redeploy to change) |
| `OPS_CHANNEL_ID` | yes (cloud) | Ops channel for all notifications (when `config/settings.json` absent) |
| `JIRA_OAUTH_CLIENT_ID`, `JIRA_OAUTH_CLIENT_SECRET`, `OAUTH_REDIRECT_URI` | for OAuth | Atlassian 3LO |
| `OAUTH_PORT` | no | Local callback port (Render supplies `PORT`) |
| `SUPABASE_URL`, `SUPABASE_SECRET_KEY` | yes (features) | Persistence; without them tokens are in-memory and triggers static |
| `TOKEN_ENCRYPTION_KEY` | yes (with Supabase) | 32 random bytes, base64 (`openssl rand -base64 32`); encrypts OAuth tokens at rest. Once any encrypted row exists the bot refuses to start without it |
| `TOKEN_ENCRYPTION_KEY_PREVIOUS` | during rotation | Old key, decrypt-only; rows are rewritten with the current key on start (§12.5) |
| `ADMIN_SLACK_USER_IDS` | no | Comma-separated; may create `global` triggers and manage any trigger |
| `INTEGRATIONS_JSON` | legacy | Static channel triggers JSON array (optional now) |
| `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_DEPLOYMENT`, `OPENAI_MODEL` | one provider | LLM (Azure when BASE_URL set) |
| `GEMINI_API_KEY`, `ANTHROPIC_API_KEY` | alt providers | Fallback providers |
| `JIRA_POLL_INTERVAL_SEC` | no (60) | Poller tick; floor for per-trigger cadence |
| `JIRA_MAX_PROMPTS_PER_RUN` | no (10) | Max DMs one trigger sends per run |
| `JIRA_MAX_PROMPTS_PER_DAY` | no (50) | Max DMs one trigger sends per rolling 24 h, counted in the database (0 = no cap) |
| `CURRENT_RELEASE_VERSION` | no | Override "current release" for Fix Version suggestions |
| `KEEP_ALIVE_URL`, `KEEP_ALIVE_INTERVAL_SEC`, `KEEP_ALIVE_DISABLED` | no | Self-ping (defaults from `RENDER_EXTERNAL_URL`, 300 s) |
| `PR_LATEST_NOTIFICATION_FIELD`, `PR_NOTES_FIELD`, `PR_TARGET_FIELD`, `PR_DEV_OWNER_FIELD`, `PR_PM_OWNER_FIELD` | no | PR field ids for the risk review (defaults `customfield_15525` / `12958` / `11818` / `11962` / `11909`) |
| `PR_CERTIFIED_FIELD`, `PR_TIMING_FIELD` | no | PR field ids the collect ask reads for its "why this matters" line (defaults `customfield_12170` / `14817`). Like the other `PR_*` ids, not listed in `render.yaml`: the defaults are the live ids |
| `RISK_NOTIFICATION_MAX_AGE_DAYS` | no (8) | Risk reviews ignore `Latest notification` stamps older than this |
| `RISK_NOTIFICATION_MATCH` | no (`progress red`) | Case-insensitive regex the `Latest notification` stamp must match for a risk review to fire; empty = every flag |
| `RENDER_EXTERNAL_URL`, `PORT` | set by Render | |

`.env.example` documents all of these; `render.yaml` declares them (`sync: false` for secrets).

---

## 11. Deployment

### 11.1 Render (current)

`render.yaml`:

```yaml
services:
  - type: web
    name: slack-jira-bot
    runtime: node
    plan: free
    buildCommand: npm install
    startCommand: npm start
    healthCheckPath: /health
    envVars: [ …all variables in §10, secrets with sync: false… ]
```

- Auto-deploys on push to **`main`** — but from the **GitHub mirror**, not from GitLab: Render cannot
  reach `gitlab.rnd.sisense.com` (§11.4). The chain is push to GitLab `main` → push mirror → GitHub
  `main` → Render. Expect the mirror's lag; if a deploy does not start, check the mirror row in
  GitLab → Settings → Repository before suspecting Render.
- **Free tier sleeps after 15 idle minutes of inbound HTTP.** Socket Mode traffic is outbound and
  does not count; when asleep, Slack events and the poller stop. Mitigations: in-app self-ping
  (`keepAlive.js`, 5 min), recommended external monitor (UptimeRobot → `/health` every 5 min), or a
  paid instance (no sleep). A redeploy always revives it.
- Logs: Render dashboard; pino JSON lines, prefixes `[reaction] [reply] [dm] [home] [trigger]
  [jiraTrigger] [jiraPoller/<name>] [digest] [fixVersion] [oauth] [keepAlive] [prefs]`.

### 11.2 Local

```bash
git clone https://gitlab.rnd.sisense.com/Omer.Meshar/jira-slack-bot.git && cd jira-slack-bot
# main is the trunk and what Render deploys (via the GitHub mirror, §11.4)
git checkout main
npm install
cp .env.example .env   # fill in
npm start              # or: npm run dev (watch)
npm test
```

The OAuth callback needs a public URL locally (tunnel) — corporate networks blocked ngrok, which is why
Render was adopted early.

### 11.2a Continuous integration (`.github/workflows/ci.yml`)

Four jobs on every push and pull request (Node 22, `npm ci`):

| Job | What it does | Fails when |
|---|---|---|
| Tests | `npm test` | any test fails |
| Dependency audit | `npm audit --audit-level=high` | a high or critical advisory exists (low/moderate in dev dependencies do not block) |
| Secret scan | `scripts/scan-secrets.sh` over every tracked file | anything matching a Slack (`xox…`), Atlassian (`ATATT3…`), Supabase (`sb_secret_…`, `sb_publishable_…`), JWT, OpenAI (`sk-…`), private-key or `TOKEN_ENCRYPTION_KEY=` pattern is committed. `.env.example` is exempt (placeholders); the script prints file and line only, never the value |
| Spec updated | on PRs: compares changed paths against the base branch | `src/` or `supabase/` changed without `docs/PROJECT_SPEC.md` — the `CLAUDE.md` rule, enforced |

Run the secret scan locally with `bash scripts/scan-secrets.sh`. Deployment stays Render's own
auto-deploy on push; CI is a gate for review, not for the deploy.

**On GitLab** (`.gitlab-ci.yml`) the same four gates run as one `verify` stage on `node:22`, with the
spec check limited to merge-request pipelines (`CI_PIPELINE_SOURCE == "merge_request_event"`, `GIT_DEPTH: 0`
so the base branch can be diffed). Both files are kept while the repository is mirrored on GitHub; the
GitHub workflow goes away once GitLab is the only remote (§11.4).

### 11.4 The repository move to GitLab (done)

The move is complete. **`gitlab.rnd.sisense.com/Omer.Meshar/jira-slack-bot`** — imported from GitHub
`omerm55/mySlackAgent` on 10 Sept — is the source of truth. Nothing in the app changed.

**How work flows now:**

- **Development** happens in a local clone (Claude Code in VS Code). Cloud sessions **cannot reach
  `gitlab.rnd.sisense.com`** — it resolves only inside the corporate network — so they can neither
  fetch nor push. The practical rule is **one writer per branch**: a branch is being advanced either
  locally or in a cloud session, never both, and handing work from a cloud session to the local clone
  means a `git bundle`, not a push (§14.40).
- **GitLab → GitHub push mirroring is live**, authenticated with an **SSH deploy key** that has write
  access on the GitHub repository. GitHub is **only a deploy copy** — nobody works there, and the
  mirror **force-updates** its `main`. Never commit to GitHub directly; the next mirror run discards it.
- **Render deploys `main`.** The switch was made once `main`'s tree was identical to the branch tip
  `431109d`, so repointing changed no running code.
- **Deploy chain:** push to GitLab `main` → mirror → GitHub `main` → Render auto-deploy. A deploy is
  therefore never instant on a GitLab push; if nothing happens, check the mirror row before Render.

**⚠️ Render cannot deploy from this GitLab.** Render's builders are on the public internet;
`gitlab.rnd.sisense.com` resolves only inside the corporate network, and Render's Git integrations are
GitHub, GitLab.com and Bitbucket — a self-managed instance is not among them. "Repoint Render at
GitLab" is **not possible**. That is why the GitHub mirror exists: it is not a convenience but the
only way Render sees the code, and it is why the GitHub repository cannot be archived while Render
deploys from it. The proper fix is to move hosting inside the network, which is open item 1 of the
security review (`SECURITY_SUMMARY.md` §5) — a runner inside the network reaches both the code and the
target, and the Render questions (free tier, secrets, region) disappear with it. Fold this into that
decision rather than solving deployment twice.

**Mirror configuration, for rebuilding or rotating it.** GitLab → Settings → Repository →
*Mirroring repositories*, direction **Push**. The URL goes in *Git repository URL* and GitLab
validates it as a URL, so it needs the scheme: `ssh://git@github.com/omerm55/mySlackAgent.git` — a
slash after the host, not GitHub's `git@github.com:owner/repo.git` copy-paste form, which is rejected.
Authentication method *SSH public key*, then *Detect host keys* and check the fingerprint against
GitHub's own two channels — the docs page *GitHub's SSH key fingerprints*
(`docs.github.com/en/authentication/keeping-your-ssh-keys-and-github-account-secure/githubs-ssh-key-fingerprints`)
or `curl -s https://api.github.com/meta | jq .ssh_key_fingerprints`, run from a machine with plain
internet access. Only after **Mirror repository** is saved does GitLab generate the key: reopen the
row, copy the public key, and add it in GitHub → the repository → Settings → *Deploy keys* → Add, with
**Allow write access** ticked. Then *Update now*. A deploy key does not expire, which is why it was
chosen over HTTPS + a personal-access token (fine-grained tokens expire within a year and the mirror
then fails silently apart from the error on the mirror row).

**A wrinkle worth keeping.** The project has *Delete source branch* on by default
(`remove_source_branch_after_merge: true`), so the **first** merge request deleted its own source
branch and GitLab was left holding only `main` (merge commit `7e5f4694`). The last commits of that
branch existed only in a cloud session that cannot push to GitLab, so they were recovered as a
`git bundle`, the branch was re-pushed, and a second merge request brought them in — GitLab `main` is
now `6ba23d9`. The mirror then force-pushed, so **GitHub `main` is the same commit, `6ba23d9`**;
GitHub's earlier merge commit `6c3fd70` is superseded. The lesson is the one above: with no path from a
cloud session to GitLab, a deleted branch is only as recoverable as the bundle someone thought to make.

**Remaining:**

- Delete `claude/slack-jira-integration-nRbia` — it is fully merged into `main` on both hosts, and the
  mirror carries the deletion through to GitHub. (GitLab's default branch is already `main`, so nothing
  depends on the branch any more.)
- **Namespace:** the project sits in a personal namespace (`Omer.Meshar/`). For a company-owned service
  under security review it belongs in the same group as Jira Manager — Settings → General → Advanced →
  Transfer project. Ownership then survives any change of role (see `SECURITY_SUMMARY.md` F2).
- Keep both CI files (§11.2a): `.gitlab-ci.yml` gates the real work, and `.github/workflows/ci.yml`
  stays as long as GitHub is the deploy target. Neither can be dropped while the mirror is load-bearing.
- External references are updated: `SECURITY_SUMMARY.md` §7 names GitLab as the code location, and the
  *SR Reference Materials* field of SNS-133715 (`customfield_15386`) now gives the GitLab project, with
  a comment on that ticket answering the security review's repository precondition — it states the new
  location, that the GitHub repository survives only as the deploy mirror, and that the project is still
  in a personal namespace. Still owed to Security there: adding Vahagn Israyelyan and Elinoy Pasternak
  to the GitLab project (they were asked for their handles) and onboarding it into Orca scanning.

Nothing secret is in the history — `scripts/scan-secrets.sh` passes over every tracked file, and all
credentials live in the runtime environment (§10).

### 11.3 Other artefacts

`Dockerfile`, `docker-compose.yml`, `ecosystem.config.js` (pm2) and `deploy/slack-jira-bot.service`
(systemd unit) exist from earlier iterations and are usable for self-hosting on a VM or container
host; Render is the path exercised in practice. `docs/architecture.md` is an earlier, narrower
architecture note superseded by this document.

---

## 12. Operations runbook

### 12.1 Daily operation

- Watch the **ops channel**: every trigger firing, filtered reaction (with reason), DM sent,
  Yes/No/LLM decision (with OAuth ✅ / bot-account marker), digest, skip reason ("no email for
  reporter X", "no Slack user for email"), trigger create/edit/delete, Run/Re-ask summaries.
- Alerting posts when errors exceed the threshold in a window; a daily audit summary posts at
  `dailySummary.utcHour`.

### 12.2 App Home controls (admin/creator)

| Menu item | Effect |
|---|---|
| ✏️ Edit | Prefilled modal; PATCH row |
| ▶️ Run now | `runOnce({force, onlyId})`; respects `jira_prompts`; summary → ops |
| 🔁 Re-ask open matches | `deletePromptsForTrigger` then force run — re-DMs everyone still matching (including those who answered No) |
| 🗑 Delete | `active = false` |

**⏸ Pause everything / ▶️ Resume** sits above the trigger sections (§2.11) — the answer to "stop it now".

Both trigger modals default a **new** trigger to *Only me*; open it up by editing after a Run now.

Both trigger modals (admins): **Jira identity** checkbox — *Allow the bot account to act for people who
haven't connected Jira*. Off by default and for every existing trigger; Home rows show 🤖 when on. Leave
it off for anything that writes PR fields (the risk review and A1 triggers).

Everyone (not only admins): **Disconnect** next to the connection status → confirm → tokens forgotten,
DM with the Atlassian revocation link, ops line; Connect reappears.

### 12.2a Creating the R&D risk-review trigger (App Home → ➕ Create Jira Trigger)

| Field | Value |
|---|---|
| Name | `R&D Initiative risk review` |
| Ask type | **Risk review** |
| JQL | `project = PR AND issuetype = Initiative AND cf[15525] is not EMPTY AND status not in (Done, Acceptance, Cancelled)` |
| Who to DM | **A user field** → `customfield_11962` |
| Re-ask when this field changes | `customfield_15525` |
| Also FYI the user in this field | leave empty (risk reviews default to the PR PM owner, `customfield_11909`) |
| Question | `{link} was flagged by the weekly R&D Initiative Notifier.` (optional; the diagnosis is rendered by the ask type) |
| Check Jira | hourly (the notifier runs weekly) |
| Scope | `personal` to test on yourself; then `global` **with a pilot list**; then `global` alone |
| Pilot: only DM these people | the few Dev owners to start with (e.g. Yehuda). Clear it to open up. |

The first run asks about every Initiative that currently carries a `Latest notification`; later runs
only ask again when the notifier rewrites it. To pilot with one Initiative, edit its `Latest
notification` in Jira and **▶️ Run now**. To pilot with one *person* while the JQL stays broad, set
scope to Everyone and put only them on the pilot list; the Run-now summary reports how many matches
were "outside the pilot list".

### 12.2b Creating the A1 collect trigger (App Home → ➕ Create Jira Trigger)

Run `supabase/collect_fields.sql` first (Supabase SQL editor).

| Field | Value |
|---|---|
| Name | `Customer-friendly name & value` |
| Ask type | **Collect field values** |
| Fields to collect | `customfield_11822 \| Customer-friendly name \| External-facing name, 2–6 words` ⏎ `customfield_15249 \| Customer value \| One sentence on what the customer gets` |
| JQL | `project = PR AND issuetype = Initiative AND (cf[14817] = "Now" OR cf[12170] = "Yes") AND (cf[11822] is EMPTY OR cf[15249] is EMPTY) AND status not in (Done, Acceptance, Cancelled)` |
| Who to DM | **A user field** → `customfield_11909` (PR PM owner; falls back to assignee, then reporter) |
| Question | leave empty (defaults to `{link} needs: Customer-friendly name, Customer value.`) |
| Check Jira | every 4 hours or daily — the condition changes slowly |
| Scope / pilot | `personal` to test on an Initiative you PM-own; then `global` + pilot list; then `global` |

Test path: pick an Initiative where you are the PM owner, blank one of the two fields in Jira,
**▶️ Run now**, answer in free text ("Call it Smart Alerts. Customers get pinged the moment a KPI
drifts.") → preview → Save → both fields set in one changelog entry under your name.

### 12.3 SQL snippets used

Who changed what on an issue, newest first (the audit query):

```sql
select ts, kind, slack_user_id, ok, detail->>'identity' as identity, text
from public.audit_events
where issue_key = 'SNS-128269'
order by ts desc;
```

Everything one person did in the last week, and every write made by the bot account rather than a user:

```sql
select ts, kind, issue_key, text from public.audit_events
where slack_user_id = 'U06QZMVLHNJ' and ts > now() - interval '7 days' order by ts desc;

select ts, kind, slack_user_id, issue_key, text from public.audit_events
where detail->>'identity' = 'bot account' order by ts desc limit 100;
```

Re-ask a single issue:

```sql
delete from public.jira_prompts where issue_key = 'SNS-128269';
```

Inspect today's prompt batches and delete only an earlier batch:

```sql
select date_trunc('minute', prompted_at) as minute_utc, count(*) as prompts,
       string_agg(issue_key, ', ' order by issue_key) as issues
from public.jira_prompts where prompted_at >= current_date
group by 1 order by 1;

delete from public.jira_prompts
where prompted_at < '2026-09-08 13:00:00+00'      -- cutoff between batches (UTC)
  and slack_user_id is not null;                  -- keep "nobody to DM" markers
```

Everyone's OAuth status / preferences:

```sql
select slack_user_id, expires_at, updated_at from public.oauth_tokens order by updated_at desc;
select * from public.user_preferences order by updated_at desc;
select slack_user_id, count(*) pending from public.jira_prompts where delivered_at is null group by 1;
```

### 12.4 Common symptoms

| Symptom | Cause | Fix |
|---|---|---|
| Reaction ignored, log "no integration matches (known channels: …)" | Bot not in channel / wrong channel id | `/invite @bot`; check channel id in trigger |
| Slack shows ⚠️ on a click, nothing happens | App not connected (Render asleep or redeploying) | Wait for deploy / keep-alive; retry |
| "You don't have access to this app" on Atlassian consent | OAuth app not shared | Distribution → Sharing |
| Ops says "hit its daily cap (50 asks / 24 h)" and matches are left unasked | The trigger has already recorded 50 prompts in the last 24 h (`JIRA_MAX_PROMPTS_PER_DAY`) | Expected safety valve. The matches are asked as the window rolls; raise the variable in Render if a trigger legitimately needs more |
| Someone pressed Yes / High Risk / Save and got "🔐 Connect Jira first, then press the button again" | They have no Jira connection and the trigger does not allow the bot account to act for them (the default) | Expected: they connect (10 s) and press the same button; nothing was written. If the bot *should* act for unconnected people on this trigger, an admin ticks the Jira identity checkbox |
| 👍 reaction answered with "I've DM'd you a link to connect Jira" and no update | Same, for channel triggers | Same |
| Callback page says "This link has expired or was already used" | Connect link older than 24 h, clicked twice, or not issued by us (`oauth_states` has no live row) | Open the bot's Home tab and press Connect Jira again; Home issues a fresh link on every open |
| Saving a Connect link fails / Home shows no Connect button after deploy | `oauth_states` table missing | Run `supabase/oauth_states.sql` |
| Nothing fires and ops says "not evaluated — the bot is paused" | Someone pressed ⏸ Pause everything, or `BOT_PAUSED=true` is set | App Home → ▶️ Resume (the banner names who paused it). If it was the environment variable, clear it in Render and redeploy |
| A button answers "the bot is paused by an admin" | Same | Same; the ask is intact and the same button works after resuming |
| Ops says "🔑 Jira service identity: <a person>" or warns about a mismatch | `JIRA_USER_EMAIL` / `JIRA_API_TOKEN` are not the intended service account (a personal account left in place) | Switch to the dedicated account per `JIRA_SERVICE_ACCOUNT.md`; set `JIRA_SERVICE_ACCOUNT_EMAIL` so a future mismatch is flagged |
| Boot fails: "oauth_tokens are encrypted but TOKEN_ENCRYPTION_KEY is not set" | Key removed from Render (or wrong service) while encrypted rows exist | Restore the key in Render; never "fix" by deleting rows — users would have to reconnect |
| Boot fails: "Could not decrypt token (wrong TOKEN_ENCRYPTION_KEY or tampered value)" | Key changed without keeping the old one | Put the old key in `TOKEN_ENCRYPTION_KEY_PREVIOUS`, deploy, then clear it (§12.5) |
| Jira trigger matched but nobody DM'd | Reporter email hidden or no Slack user for email | Ops shows the reason; adjust profile visibility or map users |
| Transition fails "A Fix Version is required" | Workflow validator | Bot offers suggestion + picker automatically |
| Only 50 issues found | (fixed) pagination | Now follows `nextPageToken` |
| Saving a trigger shows "Could not save: … column … does not exist" inline in the modal | A migration in §6 hasn't been run yet (the modal stays open and the ops channel gets the same error) | Run the relevant SQL in §6, then Save again |
| Risk button fails: "Planned release is empty; PR PM owner is empty" | PR workflow validators on the target status | Set those fields on the Initiative (any status transition in PR requires them); consider a picker like Fix Version |
| Home "recent activity" empty after a deploy | `activity_log` table missing → falls back to memory | Run `supabase/activity_log.sql` |
| Risk review fired on Initiatives that aren't flagged any more | `Latest notification` is never cleared by the notifier; stamps older than the last run are leftovers | Handled: stamps older than `RISK_NOTIFICATION_MAX_AGE_DAYS` are skipped (Run-now summary shows "N stale notification(s)"); ask the recipients to press Handled on the ones already sent |
| Run now says "N already asked or waiting in a digest" and the person got nothing | Their notification preference is a digest (hourly / daily); the match was queued, not dropped. The bot confirms a preference change in the person's DM ("You'll now get questions as a *hourly* digest") | Wait for the slot, or have them switch to *Immediate* in App Home — that flushes their queue at once. The first run after saving a trigger now reports queued matches with a 🔔 line |
| Collect preview says "not found in what you wrote" / no Save button | The LLM couldn't find a required field in the text (or AI isn't configured) | Press *Add the missing part* and type the value into its field directly — typed values always win |
| Collect ask arrived but the modal has no field inputs | Trigger saved with an empty `collect_fields` (migration not run → save failed → see modal error) | Run `supabase/collect_fields.sql`, edit the trigger, re-enter the field list |
| Risk review fired on an Initiative that is only Overdue / Status mismatch / orange | Every notifier flag writes the stamp; the pilot wants red progress only | Handled: the stamp must match `RISK_NOTIFICATION_MATCH` (default `progress red`); the Run-now summary shows "N notification(s) not about …". Widen the regex if other flags should fire |

---

### 12.5 Key rotation runbooks

**Supabase secret key** (compromise, or on a schedule):
1. Supabase → Project Settings → API → *Rotate* the secret (service-role) key.
2. Render → Environment → `SUPABASE_SECRET_KEY` = new value → save (Render redeploys).
3. Watch `/health` and the ops channel for the boot line; anything else is a paste error.

**`TOKEN_ENCRYPTION_KEY`** (tokens stay valid throughout):
1. `openssl rand -base64 32` → new key.
2. Render: `TOKEN_ENCRYPTION_KEY_PREVIOUS` = current key, `TOKEN_ENCRYPTION_KEY` = new key → deploy.
   On start every row still under the old key is rewritten (log line "N re-encrypted with the current key").
3. After that deploy: clear `TOKEN_ENCRYPTION_KEY_PREVIOUS` → deploy again.

**Atlassian OAuth client secret**: developer.atlassian.com → the app → Settings → regenerate; Render
`JIRA_OAUTH_CLIENT_SECRET`. Existing refresh tokens keep working.

**Offboarding a user**: they press Disconnect, or an admin runs
`delete from public.oauth_tokens where slack_user_id = 'U…';` (Table Editor works too).

### 12.6 Incident response and data retention

**Who.** Owner: Omer Meshar / PH Ops. The **ops channel** is the alarm (every action, every failure,
alerting above the error threshold). There is no formal on-call: an incident found outside working hours
is handled at the next opportunity, which is acceptable because the blast radius is bounded by §2.11
(pause), the per-trigger caps (§5.3) and OAuth-required writes (§2.5).

**First move in every case: pause.** App Home → ⏸ Pause everything (or `BOT_PAUSED=true` if Supabase is
implicated). Nothing is lost — asks stay put and work after resuming.

**A credential may have leaked.** Pause. Rotate what leaked: Supabase secret key or
`TOKEN_ENCRYPTION_KEY` per §12.5; Slack tokens in the Slack app (Basic Information → regenerate);
Atlassian OAuth client secret in the developer console; the Jira service-account API token in Atlassian.
Then check what was done with it: `select * from audit_events where ts > '<window start>' order by ts;`
and Jira's own issue history for the projects in §9.3. Update the environment, resume, and post the
timeline in the ops channel.

**An unintended burst of writes.** Pause. List exactly what changed and by whom:

```sql
select ts, kind, slack_user_id, issue_key, detail->>'identity' as identity, text
from public.audit_events where ts > now() - interval '2 hours' and ok order by ts;
```

Revert in Jira (the changelog gives the previous value per field), then remove the cause: deactivate the
trigger in App Home, and `delete from public.jira_prompts where trigger_id = '<id>';` only if those
issues should be asked about again. Resume once the trigger is off.

**A trigger misbehaves (wrong audience, wrong field, loops).** Deactivate it (App Home → 🗑, which sets
`active = false`) rather than deleting the row, so the audit trail keeps its configuration. Fix it on a
copy with `scope = personal`, verify with ▶️ Run now, then open it up again.

**Retention.** Nothing is deleted automatically today except expired OAuth states. Intended policy, to be
applied quarterly by hand until it is scheduled:

| Table | Holds | Keep |
|---|---|---|
| `audit_events` | Every operator event, incl. who acted and as whom | 12 months |
| `activity_log` | Per-user history shown in App Home | 12 months |
| `jira_prompts` | Who was asked about which issue, and when they answered | 12 months |
| `oauth_states` | Pending Connect links | Pruned automatically (24 h) |
| `oauth_tokens` | Encrypted Atlassian tokens | Until the user disconnects or is offboarded |
| `integrations`, `jira_triggers`, `user_preferences`, `release_calendar`, `app_settings` | Configuration | Life of the service |

```sql
delete from public.audit_events where ts < now() - interval '12 months';
delete from public.activity_log where ts < now() - interval '12 months';
delete from public.jira_prompts where prompted_at < now() - interval '12 months';
```

## 13. Testing

`npm test` → Jest, `tests/*.test.js`, 267 tests in 28 suites:

| Suite | Covers |
|---|---|
| `reactionHandler`, `replyHandler` | Trigger matching, allowlist, rate limit, dedup, personal scope, emoji variants, audit/alerting; OAuth gate: no token + no fallback → thread reply + auth DM + ops, nothing written; fallback allowed → bot writes with attribution; token → user writes, no attribution |
| `jiraService` | Field payload shapes, JQL pagination/truncation/errors, transition matching, Resolution auto-fill, unfillable fields |
| `fixVersionSuggester` | Candidate filtering, calendar windows, timeline/current, LLM adjudication + fallbacks, stage timeouts, progress |
| `digestScheduler` | Time-zone helpers, slot computation, due logic, delivery, flush |
| `jiraPollerQueue` | Send vs queue by preference |
| `dmFixVersionOffer` | Offer rendering, unique action_ids, progress lines, fallback when Slack rejects blocks |
| `dmQuestionFormat` | Template rendering (`{key} ({summary})` → one link, pipe-safety), headline dedup, button context |
| `riskReview` | Interval parsing, status-button rules (already at risk / On hold), block layout + unique action_ids, handlers: status transition, Notes prepend (LLM + fallback), target move/clear/validation, handled, failure → re-ask; FYI follow-up echoed to the PM (and not without one); Notes preview in DM/FYI (string or ADF, 400-char cap, "empty"); Skip after a status change; `parseNotificationDate` / `notificationAge` (current year, year roll-back, unparseable = fresh, 8-day cutoff); `notificationMatches` (case-insensitive regex, empty = all, invalid regex = substring) |
| `jiraPollerAudience` | `resolvePerson` for reporter/assignee/`user_field` with fallbacks, `fieldsFor`, risk-review payload, `watch_field` unchanged / changed / legacy row; `fyiFieldFor` defaults; FYI sent to a distinct PM owner (buttonless, carries `fyiSlackUserId`) and skipped when PM = Dev owner; pilot list restricts asks and FYIs, skips are not recorded, empty list = everyone; stale `Latest notification` stamps (older than `RISK_NOTIFICATION_MAX_AGE_DAYS`) are skipped without recording and counted in the Run-now summary; stamps that don't match `RISK_NOTIFICATION_MATCH` (orange, Overdue, Status mismatch…) are skipped the same way; collect trigger requests its field ids and DMs the PM owner an Answer/Skip ask with current values in the payload; every payload carries `allowFallback`; durable daily cap: budget spent → nothing sent or recorded + ops warning, partial budget → only that many asked, counting failure → per-run cap still applies |
| `collect` | Trigger field list parse/format round-trip + errors; `collectContextFor` current values + certified/timing; `visibilityLine`; certified line in DM and modal, absent otherwise; ask blocks (Answer/Skip, unique ids, ctx < 2000 chars); preview Save/Edit/Cancel vs missing-required (no Save); `mergeValues` precedence + 255 cap; modal prefill + slim metadata; `readCollectModal`; `sendDmQuestion` delegation; handlers: Answer opens modal with DM location, empty submit → inline error, explicit-only → no LLM, free text → LLM with typed field winning, LLM partial → "Almost there", LLM failure → note, Save → ONE `updateIssueFields` PUT + ✅ + answered + ops + FYI, save failure → ❌ + re-ask, Edit prefilled, Cancel restores ask, Skip |
| `dmReplyPreview` | Modal submit previews and writes nothing (ops "proposed", not "decision"); Confirm applies transition + comment + assignee and reports to ops; Cancel restores the Yes/No/Reply ask; Edit reply reopens the modal prefilled; `no_action` finalises without buttons; LLM failure keeps the ask actionable; the preview button value stays under Slack's 2000-char cap; `describeDecision` renders each change kind |
| `dmRequireOauth` | Attribution: a bot-account write from a DM ask comments naming the person and the change (Yes, risk status, collect save), a write as the user does not, and a failing comment never breaks the write; Yes without token/fallback → nothing written, ask restored with its buttons + Connect, prompt kept, ops told; with fallback → bot writes + nudge; with token → user writes; a second nudge does not stack; Reply / Update Notes / Answer without token → modal not opened; Notes modal submitted without token → ask rebuilt from ctx; risk status with fallback / token; No and Handled still work; all three ctx builders carry `allowFallback` |
| `triggerModalSave` | Trigger modals save before ack: DB failure → inline modal error + ops line, no follow-ups; success → plain ack, Home refresh, pilot list persisted; editing someone else's trigger → inline error; collect: bad field list → inline error, valid → `collect_fields` JSON + default question; a new trigger with no scope choice defaults to `personal`; save-time run posts the Run-now summary with queued matches called out; Jira identity checkbox → `allow_bot_fallback` on both trigger kinds (default false; ops line says OAuth required / bot may act) |
| `pauseSwitch` | `pauseState`: DB flag, `BOT_PAUSED` override, DB failure reads as running, 30 s cache + `invalidate`, `setPaused` records who, `describePause` wording; poller evaluates nothing and warns ops once; DM paths (Yes, risk status, collect Save, Reply modal) write nothing and keep the ask and prompt; reaction answers in-thread; Home banner and admin-only Pause / Resume, both audited; not paused → the same click goes through |
| `auditEvents` | Every notifier method writes a row mirroring the ops line (kind, user, issue, identity, structured detail); failures recorded with `ok:false` and the error; bot-account identity captured; proposed vs applied LLM decisions are distinct kinds; a plain `post` is kind `ops`; a failing sink never breaks the message; rows are written even with no ops channel; insert truncates long text; the query filters by issue / user / kind / time |
| `homeVisibility` | Admin vs regular-user Home sections (no DB calls for hidden sections), Connect (async URL) vs Disconnect by connection state, persistent recent activity from Supabase, in-memory fallback, `addEntry` persistence |
| `callbackServer` | Public HTTP surface is exactly `/health` (200) and `/oauth/callback` (400 without code/state, else `handleCallback(code, state)`; `invalid_state` → 400 "expired or already used" page, not 500); `/send-dm` and unknown paths → 404 |
| `tokenCrypto` | Round trip, prefixed random ciphertext, legacy plaintext passthrough, wrong key / tampering / malformed detected, rotation (previous key decrypts, `isCurrent` distinguishes), `fromEnv` |
| `oauthTokens` | `upsertToken` stores ciphertext and reads back plaintext; `loadFromDb` re-encrypts legacy plaintext rows exactly once; previous-key rows rewritten under the current key; encrypted rows without a key → `encryption_key_missing`; plaintext-only without a key still loads (local dev); `disconnect` forgets memory + DB |
| `oauthState` | Memory mode: URL carries a random state (never the user id), fresh per call, accepted once, replay / unknown / malformed / expired rejected before any token exchange; Supabase mode: state inserted, consumed atomically through the DB, tokens persisted for the mapped user, prune called |
| `noContentLogging` | A sentinel typed into the reply modal / collect modal reaches the ops channel but never any pino log call |
| `loadIntegrations`, `dedupCache`, `rateLimiter`, `auditLog`, `alerting`, `jiraLinkParser` | Utilities |

Tests mock Slack/Jira/Supabase clients; no network. Ad-hoc harnesses used during development live
only in the session scratchpad and are superseded by the suites above.

---

## 14. Design decisions and history

Chronological, with rationale (see `git log` for commits):

1. **Reaction/reply triggers with service account + attribution comment** — baseline.
2. **OAuth 2.0 3LO per user** so Jira history shows the real person; service account kept as fallback
   with an explicit "made by the bot account" note.
3. **Render instead of ngrok** — corporate network blocks tunnels; Render gives a stable public
   callback URL. `PORT` from Render overrides `OAUTH_PORT`.
4. **Env-var fallbacks for config files** (`OPS_CHANNEL_ID`, `INTEGRATIONS_JSON`) since config JSON
   is gitignored.
5. **DM question flow with Block Kit buttons** (context in button values, restart-safe) replacing
   text replies; **LLM interpretation** of free text via a modal. Providers: Gemini → OpenAI → Azure
   OpenAI GPT-5.1 (`max_completion_tokens` required).
6. **Ops channel notifications** for every event; skin-tone emoji fix; `white_check_mark` accepted.
7. **App Home** with OAuth status; fixed the post-OAuth Home overwrite.
8. **Supabase persistence** for tokens (survive redeploys) and **dynamic triggers** created from Home;
   handlers refactored from N registrations to one generic listener reading a cache;
   `INTEGRATIONS_JSON` made optional; `scope` global/personal; admins via env.
9. **Jira triggers (JQL poll)** chosen over implementing "all children done" ourselves: Jira Automation
   already detects and transitions; the bot owns the human loop. Webhook mode deferred.
10. **Transition support** end-to-end; Resolution auto-fill; **Fix Version** validator handled with a
    picker, then **LLM-assisted suggestion** from children, then **timeline-aware** suggestion using a
    release calendar with branch-out *windows* (semantics from the user's release page).
11. **Robustness after incidents:** Slack rejected a message with duplicate `action_id`s and the DM
    stayed on a progress line → per-stage 5 s caps, progress updates, logged `chat.update`
    failures, guaranteed fallback to the picker, regression tests.
12. **Pagination bug** (`search/jql` default 50) found in production → paginate to 1000 and flag truncation.
13. **Ops vs DM separation:** trigger management output moved to the ops channel; DMs reserved for
    user conversations. **Connect Jira** button embedded in first-contact DMs.
14. **Render sleep** diagnosed → self-ping keep-alive; external monitor recommended.
15. **Per-user notification digests** with tz-aware slots; default remains immediate.
16. **Scenario catalog absorbed** (§18, `SCENARIO_CATALOG.md`): 35 Jira "asks" mapped to ask types,
    audiences, triggers and Jira-side dependencies; nine requirements checked against the app. Decision:
    **no new capabilities before the 9 Sept demo**; A1 (`collect` ask type with LLM-extracted field
    values) is the first build afterwards, then A2, B1, D1/D3, claims.
17. **Risk review ask type** (built the morning of the demo, reversing #16's freeze for one feature):
    the notifier's `Latest notification` field is the handoff — no skill change, no new secret. First
    non-yes/no ask type; introduced the generic `user_field` audience and `watch_field` re-ask, both
    reused by the A1/A2 plan. Supabase ingest endpoint for richer flags deferred.
18. **Home tab split by role; activity made persistent.** Trigger management is hidden from
    non-admins; "recent activity" moved from the restart-prone in-memory audit log to an
    `activity_log` table and now also records DM Yes / free-text / risk-review actions.
19. **FYI recipient for Jira triggers.** The PM owner is kept in the loop on risk reviews: an
    informational DM when the Dev owner is asked and a follow-up when they act. Implemented as a
    generic per-trigger `fyi_field_id` (defaulting to the PM owner for risk reviews) rather than a
    risk-review special case, so other asks can copy a second person too.
20. **Notes in the loop; Skip.** First live test showed two gaps: people act on Notes without seeing
    them, and the post-status follow-up offered only "Update Notes". The DM, the FYI and the Notes modal
    now show the current Notes (or "empty"), and a Skip button ends the flow without a write.
21. **Pilot list on Jira triggers.** Needed to run the risk review for one Dev owner without
    narrowing the JQL or going global. Skipped people are deliberately *not* recorded as asked, so
    clearing the list is all it takes to widen the rollout.
22. **Save before ack.** Editing a trigger before its migration had run made the modal close and look
    like a silent revert (the error only reached ops). Both trigger modals now write to Supabase first
    and, on failure, answer the submission with an inline error so the modal stays open.
23. **Stale notifications.** The first pilot run asked about six Initiatives of which four carried
    stamps from June, July and August — flagged once, never cleared. The risk review now parses the
    notifier's date stamp and only acts on notifications from the latest weekly run (8-day window).
24. **Red progress only.** The notifier stamps every actionable condition (Overdue, Stale Notes,
    orange progress, Status mismatch…), but the Dev-owner loop is meant for Initiatives that are
    significantly behind pace. Rather than hard-coding the phrase, the stamp must match
    `RISK_NOTIFICATION_MATCH` (default `progress red`), so widening to orange or Overdue later is a
    config change, not a deploy. Global for now; per-trigger patterns deferred (§15).
25. **`collect` ask type, A1 first.** Built as planned in §18.4 with three simplifications: the field
    list is typed one-per-line in the trigger modal (no fields editor), the marker field / TTL /
    `require_oauth` extras are deferred (both A1 fields are unguarded text fields), and *Cancel* restores
    the original ask instead of ending the conversation. The preview step is non-negotiable: the LLM
    never writes to Jira on its own, and a typed value always beats an extracted one.
26. **Save-time run reports to ops.** Testing A1 with an hourly digest preference made the first
    match "disappear": the run right after saving queued it silently, and the next Run now counted it
    as already asked. The save-time run now posts the Run-now summary, and the summary distinguishes
    "already asked or waiting in a digest" and marks queued matches with 🔔.
27. **Say why the fields matter, from the data.** The A1 ask now tells the PM that the Initiative is on
    the Certified Roadmap and that the two fields are customer-visible — but only when *Included in
    Certified Roadmap* actually says Yes; a *Now* Initiative gets the softer "once it is certified" line.
    Reading the field beats putting the claim in the trigger's question text, which would be wrong for
    half the JQL's matches.
28. **Security P0 (1/5): `/send-dm` removed, no user text in logs.** The endpoint dated from the day
    the DM flow was built (7 Sept), when Jira Automation was going to call the bot over HTTP; JQL-polled
    triggers replaced that a day later and nothing called it since — but anyone on the internet could
    have used it to make the bot DM any employee a real-looking ask. Removed together with the legacy
    `pendingQuestions` store; the HTTP surface is now `/health` + `/oauth/callback` only, locked by a
    test. Same commit: pino log lines no longer include what people typed or what the LLM extracted
    (the ops channel keeps that as the audit trail). See `SECURITY_SUMMARY.md` R1, R4, R7.
29. **Security P0 (2/5): OAuth `state` is random, single-use and expiring.** It used to be the Slack
    user id, so a consent flow could be bound to the wrong Slack account. Now a 256-bit random token
    stored in `oauth_states` (24 h TTL — links sit in Home and in asks and are clicked later; single-use
    closes the replay window) is consumed atomically on the callback; anything else gets a clear
    "expired or already used" page. `generateAuthUrl` became async; all six call sites await it.
    **Migration `supabase/oauth_states.sql` must be run before this deploys**, otherwise Connect links
    cannot be issued. See `SECURITY_SUMMARY.md` R3.
30. **Security P0 (3/5): tokens encrypted at rest, RLS, rotation, Disconnect.** Application-level
    AES-256-GCM (`tokenCrypto`) rather than pgcrypto, so Supabase never holds the key: a database leak
    yields ciphertext, a Render leak yields a key without data. Legacy plaintext rows are rewritten
    lazily on the first start with a key (no SQL migration, no user action); a previous-key slot makes
    rotation a two-deploy affair with tokens valid throughout. Boot refuses to run when encrypted rows
    exist and the key is missing — silently falling back to plaintext would be worse than downtime.
    RLS with no policies (`supabase/rls.sql`) turns the anon key into a no-op. Disconnect gives users
    the exit the March review implied under "accountability". **Manual: add `TOKEN_ENCRYPTION_KEY` in
    Render before this deploys; run `supabase/rls.sql`; then rotate the Supabase secret key (§12.5).**
31. **Security P0 (5/5): OAuth required for writes; the bot account is a per-trigger exception.** This was
    the March review's core objection — a shared identity writing on behalf of whoever clicked. Now
    `resolveJira` returns `null` for a person without a token unless the trigger's `allow_bot_fallback`
    is set, and `needsConnect` puts the ask back *with its buttons* under a Connect nudge, so the person
    loses nothing: connect, press again, done under their name. The prompt row is untouched (no re-ask
    storm), read-only buttons keep working, and channel triggers answer in-thread instead of writing.
    The exception is a visible admin checkbox (Home shows 🤖), off for every existing trigger.
    **Migration `supabase/require_oauth.sql` must be run before this deploys.** See
    `SECURITY_SUMMARY.md` F1 and §5 item 5.
32. **Preview before every LLM-driven write.** The free-text Reply path used to interpret and execute in
    one step — the last place where the LLM changed Jira without a human seeing the exact change. It now
    renders the decision ("Move PR-1 to Needs Review · Add a comment: … · Assign to Gaby") with Confirm /
    Edit reply / Cancel, reusing the shape the collect ask already had. `no_action` needs no confirmation;
    an LLM error leaves the Yes/No buttons; Cancel restores the ask. The ops channel now distinguishes
    *proposed* from *applied*. Closes the security summary's open item on unpreviewed LLM writes.
33. **CI: tests, dependency audit, secret scan, spec-updated check.** The repository had no automated
    checks, so the `CLAUDE.md` spec rule relied on memory and a committed credential would have gone
    unnoticed. Four jobs now run on every push and PR (§11.2a). The audit gate is set at *high* so
    low/moderate advisories in Jest's transitive tree do not block work; setting it up surfaced a real
    high-severity axios advisory (credential theft via prototype pollution in config merge), fixed in
    the same commit by moving to axios 1.20 — 0 vulnerabilities now.
34. **Durable daily cap, and new triggers start personal.** The per-run cap of 10 was the only brake, and
    a 2-minute cadence made that 300 asks an hour; the in-memory rate limits also reset on every restart.
    A trigger now also has a 24-hour budget counted in `jira_prompts` (`JIRA_MAX_PROMPTS_PER_DAY`, 50),
    which survives restarts and spans Run-now clicks; hitting it posts to ops and leaves the matches for
    the next window rather than dropping them. Counting failures fall back to the per-run cap instead of
    blocking a trigger. Separately, both modals now default a **new** trigger to *Only me* — the 8 Sept
    surprise was a trigger saved as global on the first try. Closes two security-summary open items.
35. **Durable audit events.** The ops channel was the de-facto audit log: a private Slack channel with
    Slack's retention and no way to query it. Every operator message now also becomes an `audit_events`
    row with the same text plus `kind`, user, issue, success and a structured `detail` — including which
    identity made the write, which is what makes the bot-account exception auditable. Chosen over a
    write-ahead log or an external SIEM because it reuses the store we already have and needs no new
    credential; it is durable and queryable, not immutable (the server key could still delete rows),
    which the security summary says plainly. Migration `supabase/audit_events.sql` applied 10 Sept.
36. **Say which Jira identity we are running as.** The bot's Jira credential is still the owner's
    personal admin account, which the March review would rightly object to twice over (attribution and
    least privilege). Provisioning a real service account is IT's action, so the code contribution is
    visibility: `whoAmI` at boot, the identity posted to ops, and a loud warning when it differs from
    `JIRA_SERVICE_ACCOUNT_EMAIL`. `JIRA_SERVICE_ACCOUNT.md` is the request for IT — the exact permission
    list derived from what the code actually calls (browse + user lookup always; edit, transition,
    comment, assign only for allowed-fallback triggers; explicitly *not* delete or administer), scoped to
    SNS and PR, with the switchover steps and the e-mail-visibility caveat.
37. **Attribution for bot-account writes from DM asks.** Found while checking the security summary against
    the code: `postAttributionComment` was wired only into the channel handlers, so a bot-account write
    from a DM ask (Yes, a risk button, collect Save, a confirmed reply) left nothing on the issue naming
    the human — only the service account in the changelog. Not yet reachable in practice (the fallback is
    off everywhere), but the summary asserted it as a property. `attributeIfBot` now covers all seven DM
    write paths; a write with the person's own token adds no comment because the changelog already names
    them, and a failed comment is logged without failing the action.
38. **Emergency stop.** "How do you stop it right now?" had no good answer: delete triggers one by one or
    suspend the host. A global pause now stops the bot *acting* while it keeps *listening*, so an admin
    can still see and resume. Two switches on purpose: an App Home toggle in `app_settings` (no deploy,
    names who paused it, audited) and `BOT_PAUSED` for when the database is the problem. Refusals leave
    the ask and its prompt row untouched, so a pause costs nothing but time. A database error deliberately
    reads as "running" — the switch must not be able to take the bot down on its own.
    **Migration `supabase/app_settings.sql` must be run.**
39. **Incident response and retention written down (§12.6).** The security summary had to admit there was
    no procedure and no retention statement. Three playbooks (leaked credential, unintended write burst,
    misbehaving trigger), each starting with "pause", each with the `audit_events` query that answers what
    happened; and a retention table with the prune SQL, honest that it is quarterly by hand for now.

40. **GitLab is the source of truth; GitHub is a deploy mirror (§11.4).** Render's builders are on the
    public internet and cannot resolve `gitlab.rnd.sisense.com`, and Render integrates only with GitHub,
    GitLab.com and Bitbucket — so "move to GitLab and repoint Render" was never available. The shape that
    works is GitLab for people, a push mirror to GitHub for machines: push to GitLab `main` → mirror →
    GitHub `main` → Render. The mirror uses an SSH deploy key with write access because deploy keys do not
    expire, where a personal-access token would fail silently within the year. The same network boundary
    has a second consequence worth stating: cloud sessions cannot reach GitLab either, so a branch has one
    writer at a time and work comes back from a cloud session as a `git bundle`. That was learned the hard
    way — the first merge request deleted its source branch (the project default), stranding commits that
    lived only in a session with no way to push, recoverable only from a bundle.

---

## 15. Known limitations

- **Retention is manual:** the prune SQL in §12.6 is run by hand; `audit_events`, `activity_log` and
  `jira_prompts` grow until then.
- **Hosting:** Render free tier sleeps; self-ping mitigates but cannot revive a sleeping instance.
- **Single workspace / single Jira site.** No multi-tenant config.
- **Dedup and the per-channel hourly rate limit are in memory** and reset on restart. The limit that
  matters for blast radius is durable: the per-trigger 24-hour budget is counted in `jira_prompts`
  (§5.3). Per-user activity is persisted in `activity_log` and every operator event in `audit_events`;
  only the daily ops summary still uses the in-memory list.
- **Email-based user mapping** depends on Atlassian profile visibility; no manual override table yet.
- **Re-ask re-asks everyone**, including users who answered No; outcomes aren't stored per prompt.
- **Slack rate limits** are not centrally managed (bursts capped by `JIRA_MAX_PROMPTS_PER_RUN` and the
  daily `JIRA_MAX_PROMPTS_PER_DAY`).
- **PR workflow validators** ("Planned release" and "PR PM owner" must be set for any status change)
  are surfaced as Jira's error text on the risk-review buttons but not yet offered a fix-up picker.
- **Risk review re-asks track the field, not the outcome:** a Dev owner who clicks Handled is asked
  again on the next notifier run if the field is rewritten (by design — new run, new ask).
- **Digest slots are fixed** (09:00 / 15:00); no per-user time choice yet.
- **Collect asks write plain-text fields only** (values sent as strings in one PUT). Selects, users
  and dates need per-field type handling; no marker field / expiry yet (§16.10).
- **The risk-review flag filter is global** (`RISK_NOTIFICATION_MATCH` applies to every `risk_review`
  trigger). A per-trigger pattern (e.g. one trigger for red progress, another for Overdue) needs a
  `jira_triggers.notification_match` column + modal input — deferred until a second trigger exists.
- **LLM output** is validated structurally, not semantically; reasons are shown to users as-is. Every
  LLM-derived change is confirmed by the person before it is written (reply preview, collect preview).
- **Legacy code paths:** `config/*.json` loaders, Docker/pm2 files are kept but not exercised in production.

---

## 16. Productization plan

Ordered by value ÷ effort; each item is independently shippable.

### 16.1 Reliability & hosting
- Move to a non-sleeping host (Render Starter or equivalent) and add an external uptime monitor on `/health`.
- Graceful shutdown (drain in-flight handlers on SIGTERM) and a startup self-check (Slack auth test,
  Jira `/myself`, Supabase ping) posted to ops.
- Persist `auditLog`, dedup and rate-limit state (or accept reset and document it).
- Retries with backoff for Jira/Slack 429/5xx; central Slack rate-limit queue.

### 16.2 Security

[`SECURITY_SUMMARY.md`](SECURITY_SUMMARY.md) is the document shared with the security team: the March
2026 feedback (authorization, ownership, audit, operational controls, governance, data) → what the system
does today about each point → what still remains, plus the precautions taken on our own initiative and
the decisions we need from Security. It deliberately does not use our internal "P0" labels (those live
in §14 #28–#31). The five internal P0 items — remove `/send-dm`, random single-use OAuth `state`,
encrypted tokens + RLS + rotation + Disconnect, no user text in logs, OAuth required for writes — are
all implemented; the Supabase secret key has been rotated (10 Sept); the remaining operator steps
(migrations, encryption key in Render) are in §12.5.

- ~~Encrypt OAuth tokens at rest and rotate the Supabase secret key~~ (done, #30; rotation is a runbook, §12.5).
- ~~Enable RLS~~ (done, #30); audit table access; least-privilege Slack scopes review.
- Secrets scanning in CI; ~~never log tokens~~ (tests: `noContentLogging`, `tokenCrypto`).

### 16.3 Multi-tenancy
- Slack OAuth install flow (Bolt `installationStore` in Supabase) instead of a single bot token;
  per-workspace Jira site + service account; tenant id on every table.
- Per-tenant ops channel and admin list.

### 16.4 User mapping & identity
- `user_mappings` table (Jira accountId ↔ Slack user id) with a Home-tab "link my Jira account"
  fallback when email lookup fails; use accountId from OAuth to fill it automatically.

### 16.5 Trigger model
- Store prompt **outcomes** (yes/no/failed/expired) → smarter Re-ask (skip No), reminders after N days,
  metrics.
- Jira **webhook** endpoint so Automation can call the bot directly (instant, no polling) alongside JQL polling.
- Trigger templates ("epic acceptance", "PM reviewed") and natural-language trigger creation via the LLM
  (planned earlier, deferred).
- Per-trigger required-OAuth option (refuse to act as the bot account).
- Support more action types: multiple fields, labels/components, sprint, custom validators picker
  generalised beyond Fix Version.

### 16.6 Digests & UX
- User-chosen digest times and quiet hours; snooze on a question; "remind me tomorrow".
- Digest as a single message with per-item buttons (needs handler changes to update one item at a time).
- Localisation of dates (currently `en-US`).

### 16.7 Observability
- Structured metrics (triggers evaluated, DMs sent, acceptance rate, LLM latency/cost) to a dashboard;
  request ids across Slack → Jira calls; error budget alerts.
- LLM prompt/response logging with PII controls for evaluation.

### 16.8 Engineering hygiene
- ~~CI guard for the maintenance rule~~ and ~~CI (tests, dependency audit, secret scan)~~ — done, §11.2a.
- Make Render's deploy wait for CI (deploy on green) instead of deploying on push.
- ESLint/Prettier config; JSDoc → TypeScript migration or type-checking via `checkJs`.
- Remove legacy paths (JSON config loaders) once confirmed unused; update README
  to point at this spec.
- Migration tooling for Supabase (numbered SQL files, applied via CI) instead of hand-run scripts.

### 16.9 Compliance & rollout
- Privacy policy/ToS already published for the Atlassian app; add a data-retention policy for
  `jira_prompts`/audit data and a deletion path when a user leaves.
- Rollout guide: pilot group via `scope=personal`/allowlists → team → org; announcement template (used
  in `#product-house-all`) kept in `docs/`.

### 16.10 From the scenario catalog (see §18)
- **Generalised ask model:** `ask_type` on Jira triggers — `yes_no`, `risk_review`, `collect` (text
  fields; built), then `choose` (N options), `collect` for typed fields (select / user / date + regex
  validation), `claim` (channel, atomic first click), `acknowledge`, `create`.
- **Audiences beyond reporter/assignee:** `user_field:<cf>` (e.g. PM owner), `channel:<id>`, fixed
  `user_list`, and lookup tables (team → PM, domain → lead).
- **Writes distinguishable from human edits:** optional per-trigger marker field written in the same
  PUT (precedent: `Auto: Renumbered`), so rules watching the field can exclude the bot's answers.
- ~~**`require_oauth` per trigger**~~ — done (#31) as the inverse: OAuth required by default, `allow_bot_fallback` per trigger.
- **Ask expiry:** `ask_ttl_hours`; buttons refuse after `expires_at`; `answered_at` recorded so an ask
  goes inert once answered and Re-ask can skip answered ones.
- **Context in the question:** changelog-derived placeholders (e.g. previous value and when it changed)
  so an ask is answerable without opening Jira.
- **Jira webhook trigger** so Automation rules can call the app directly, alongside JQL polling.

---

## 17. Glossary

- **Channel trigger / integration** — reaction/reply → field rule scoped to a Slack channel (`integrations` table).
- **Jira trigger** — JQL-polled rule that DMs a person and acts on their answer (`jira_triggers`).
- **Prompt** — one (trigger, issue) question asked of a user (`jira_prompts`); *queued* until a digest, *delivered* otherwise.
- **Scope** — `global` (applies to anyone) vs `personal` (only the creator).
- **OAuth / impersonation** — acting in Jira as the Slack user via their Atlassian token.
- **Service account** — the shared Jira identity used for reads/polling, and for writes only on triggers with `allow_bot_fallback`.
- **Timeline fit / current** — release windows from `release_calendar` matched to the acceptance date / today.
- **Ops channel** — Slack channel receiving all operational messages (`OPS_CHANNEL_ID`).
- **Socket Mode** — Slack delivery over an outbound WebSocket; no public request URL needed.
- **Ask type** — the interaction shape of a bot-initiated question (`yes_no`, `choose`, `collect`,
  `claim`, `acknowledge`, `create`); see §18.

---

## 18. Scenario catalog and requirements

In September 2026 a Claude Cowork pass over the Jira Makeover backlog, the automation library and live
Slack history produced **"Jira asks in Slack"** — 35 places where Jira currently asks a person for
something via a comment, an e-mail, or a read-only feed (artifact
`32e5b730-dfb7-46dd-bbe9-3b5513f148b9`). The full scenario table is in
[`SCENARIO_CATALOG.md`](SCENARIO_CATALOG.md). This section records what the catalog asks of the app,
where we stand, and the order we intend to build.

### 18.1 Four caveats from the catalog, in our terms

1. **Gate first.** Several of the loudest comment-asks are broken at the *condition*, not the medium
   (a rule mentions a field that doesn't exist; a fix-version rule is blind to every `2026.x`; an
   invalid smart value drops the name). Moving them to Slack unfixed ships the same silence in a nicer
   envelope. → Every scenario we adopt carries its Jira-side fix as a dependency (column in the catalog).
2. **Write-back loops.** An impersonated write is indistinguishable from the person editing Jira, so
   every rule watching that field fires. Right for C1, wrong for D1 (an answered ask would re-trigger
   the notification that raised it). → Optional **marker field in the same PUT** per trigger, and the
   corresponding exclusion added to the watching rule before the ask goes live.
3. **Read-only feeds are archives.** `#initiative-updates` and friends are searchable history by
   design; asks must not be routed there. → Pattern G is Jira hygiene, not app work.
4. **Attribution closes the audit trail, except for the reason.** The changelog records the value,
   never *why*. → Where the reason matters (C2, C6, D3), the answer must land in a field (Notes /
   Planning Notes), not only in the Slack thread. This is what the `collect` ask type is for.

### 18.2 Requirements vs. current state

| Requirement (catalog) | Status today | Planned change |
|---|---|---|
| Impersonated write for text, single-select, 3-option select, long text, date + reason | ✅ `updateIssueField` (select/text/array/raw), transitions, `updateIssueFields()` (several fields, one PUT) | Typed handling per field in `collect` |
| Writes distinguishable from a human edit | ❌ | Per-trigger `marker_field_id` / `marker_value` in the same PUT |
| Defer to the field's own permission gate | ✅ OAuth required for every write (#31); the service account acts only on triggers an admin marked `allow_bot_fallback` | — |
| Path for people who haven't authorised | ✅ Connect nudge on the ask itself; press again after connecting (nothing lost); bot fallback only where an admin allowed it | — |
| One answer only; message goes inert once answered | ✅ DMs (buttons replaced on click) · ⚠️ channel asks can race | `answered_at` on prompts; atomic first-click for `claim` |
| Asks expire | ❌ | `ask_ttl_hours` → `expires_at`; handlers refuse stale clicks |
| Batched asks with per-row action | ✅ digests: one message per item, each independent | Single-message digest later (needs per-item update) |
| Read Jira as the user to state *why* | ⚠️ partial (status-entered date, children) | Changelog placeholders in question templates |
| Answer lands in a field, not only the thread | ✅ field/transition asks · ✅ free text → fields via `collect` (A1) · ✅ Notes via risk review | Typed `collect` variants (A2 regex, C6 date + reason) |

### 18.3 Our build order

1. ~~**A1 — Customer-friendly name & Customer value**~~ — **built** (first `collect` ask; written
   mandate JM-352; no Jira fix needed). See §2.10 and §18.4.
2. **A2 — Regression from build** (`collect` + per-field regex validation; largest comment volume).
3. **B1 — Ratify release-notes decision** (`choose`; blocked on the `is EMPTY` write gate in Jira and a
   team → PM mapping).
4. **D1 / D3** (need the marker field).
5. **E1 / E4 — Claim** (channel asks with atomic first click; a separate mini-project).
6. **Pattern G** — Jira Automation hygiene; tracked, not built here.

The catalog's own top five is A1, B1, C2, D1, A2; we swap A2 forward because it reuses A1's machinery
with two hours of extra work, and C2 depends on a Jira rule fix (`addCommentOnce`) we don't control.

### 18.3a Built: R&D risk review (owner loop for the notifier)

Not one of the 35 rows, but the same shape as C1/C6 (chase the owner, answer lands in a field) and the
first non-yes/no ask type. See §2.9. It delivered two of the §18.2 planned changes early: the
`user_field` audience and re-ask-on-change (`watch_field`). C1 (stale Notes → reply writes Notes) can
now be a `risk_review`-style trigger with a different JQL; C6 needs the date+reason `collect` variant.

### 18.4 Built: A1 with LLM-extracted values (design record)

Implemented 2026-09-09 as §2.10 / §7.7 / §8.4. Differences from the plan below: field list typed
one-per-line in the trigger modal (no fields editor); `marker_field_id`, `ask_ttl_hours`,
`require_oauth` and `expires_at` deferred (§16.10); *Cancel* restores the ask. The PM-owner field is
`customfield_11909` (confirmed via `expand=names,schema`; both target fields are `textfield`).

**User experience.** The PM owner of an Initiative that moved to *Now* (or was flagged for the
Certified Roadmap) and lacks a customer-friendly name or customer value gets a DM:

> *[PR-1234 (Smart Alerts for KPI drift)] needs a customer-friendly name and a one-line customer
> value before it reaches the roadmap.* — **✍️ Answer** · **Skip**

**Answer** opens a modal with one free-text box ("describe it in your own words") plus one optional
input per field, prefilled with current values. The LLM extracts the two values from the free text
(never inventing; `null` when not stated); the bot shows a **preview** — *Name: … / Value: …* — with
**Save / Edit / Cancel**. **Save** writes both fields **in one PUT as the user** (plus the optional marker
field), replaces the DM with ✅ and a link, records `answered_at`, and reports to ops.

**Trigger.** Jira trigger, `ask_type = collect`, cadence hourly/daily:
`project = PR AND issuetype = Initiative AND (status = Now OR "Included in Certified Roadmap" = Yes)
AND ("Customer-friendly name" is EMPTY OR "Customer value" is EMPTY)`; audience
`user_field:<PM owner cf>` with fallback to reporter.

**Data.** `jira_triggers`: `ask_type`, `collect_fields jsonb` (`[{id, name, type, required, hint,
validation_regex?, options?}]`), `marker_field_id`, `marker_value`, `ask_ttl_hours`, `require_oauth`;
`notify` accepts `user_field:<cf>`. `jira_prompts`: `answered_at`, `expires_at`.

**Code.** `jiraService.updateIssueFields` + `getIssueFieldNames`; poller audience resolver for
`user_field:`; `dmQuestion` renders Answer/Skip for `collect`; `dmHandler` adds
`jira_collect_answer` → `jira_collect_modal` → preview → `jira_collect_save`; `llmService.extractFields`
with a `COLLECT_FIELDS_PROMPT`; trigger modal gains ask type, fields editor, audience "user field",
marker, TTL, require-OAuth; ops `collectSaved`.

**Open items before building** (resolved): `cf[11822]` and `cf[15249]` are plain text
(`com.atlassian.jira.plugin.system.customfieldtypes:textfield`); PM owner = `customfield_11909`
(`people`, multi). A2 remains about two hours on top (regex validation per field).
