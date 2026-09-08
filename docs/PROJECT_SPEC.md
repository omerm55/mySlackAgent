# mySlackAgent — Project Specification

> Slack ↔ Jira agent: turns existing Slack behaviour (👍 reactions, thread replies) and Jira state
> (JQL conditions) into Jira updates, with a human-in-the-loop DM conversation, per-user OAuth so
> changes are attributed to the real person, and an LLM to interpret free-text answers and to
> suggest values (e.g. an epic's Fix Version).
>
> Status: hackathon build (Sept 2026), deployed and in use at Sisense. Branch `claude/slack-jira-integration-nRbia`.
> Production URL: `https://myslackagent.onrender.com`. Tests: `npm test` (121 passing).

This document is written so that a person **or an LLM with no prior context** can understand what the
system does, how it is built, how to operate it, and what remains for production. Every script,
SQL statement and configuration used so far is included verbatim.

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

### 2.3 DM conversation (Yes / No / Reply, LLM-interpreted)

- **Yes** applies the proposed action immediately.
- **No** records a decline.
- **💬 Reply** opens a modal; free text such as *"not yet, waiting on QA"*, *"yes but set it to Needs
  Review"*, *"move it to In Review and assign to Gaby"* is interpreted by an LLM into a structured
  action (update field / transition / comment / assign / no-op) and executed.
- If the user hasn't connected Jira, the question carries a **🔗 Connect Jira** button.

### 2.4 Fix Version assistance

If a transition fails because Jira requires a Fix Version (workflow validator), the bot suggests one
from the epic's child issues, the date it entered its current status, and a release calendar, then
offers **✅ Use X & retry**, **Use Y instead**, and **🏷 Choose another…** (a picker of project
versions). Required *Resolution* is auto-filled (Done → Fixed → Resolved).

### 2.5 Per-user OAuth (Atlassian 3LO)

Users connect once (App Home → Connect Jira, or the button in a DM). Tokens persist in Supabase,
refresh automatically, and survive restarts. Without OAuth the bot acts as a service account and posts
an attribution comment naming the Slack user.

### 2.6 App Home

Shows OAuth status + Connect button; notification preference; channel triggers and Jira triggers
with ➕ Create and per-row ⋯ menus (✏️ Edit, ▶️ Run now, 🔁 Re-ask open matches, 🗑 Delete); how it
works; the user's recent activity.

### 2.7 Notification preferences (digests)

Each user chooses **Immediately** (default), **Hourly**, **Twice a day (09:00 & 15:00)** or
**Once a day (09:00)** in their Slack time zone. Non-immediate users have questions queued and
delivered in a burst (header + one message per question) at their slot.

### 2.8 Operator visibility

Every trigger firing, filtered event, DM sent, button click, LLM decision, digest, trigger
create/edit/delete and Run/Re-ask summary is posted to the ops channel. Errors above a threshold
alert; a daily audit summary is posted.

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
 Browser ─HTTPS─►│  GET /oauth/callback  GET /health  GET /send-dm              │
                 └───────────┬──────────────────┬──────┴───────────┬────────────┘
                             │                  │                  │
                      Jira Cloud REST     Supabase REST        Azure OpenAI
                    (service acct + OAuth)  (Postgres)         (GPT-5.1) / Gemini / Anthropic
```

Key properties:

- **Single process.** Slack Socket Mode (outbound WebSocket) + a tiny HTTP server for the OAuth
  callback, `/health` and a `/send-dm` test endpoint. No inbound Slack HTTP, so no public request
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
    dmHandler.js               Yes / No / Reply, LLM execution, Fix Version offer + picker
    homeHandler.js             App Home builder (publishHome / buildHomeBlocks)
    triggerHandler.js          Create/Edit/Delete/Run/Re-ask for channel + Jira triggers (modals, menus)
    preferencesHandler.js      Notification frequency select
  services/
    jiraService.js             Jira REST: issues, fields, comments, transitions, search (paginated), versions, changelog
    oauthService.js            Atlassian 3LO: auth URL, code exchange, refresh, per-user JiraService; Supabase-backed
    supabaseService.js         Thin axios client over Supabase REST (PostgREST)
    integrationCache.js        Static + DB channel triggers, 60 s TTL
    jiraPoller.js              Evaluates Jira triggers on their cadence; sends or queues DMs
    digestScheduler.js         Delivers queued prompts at users' slots; tz-aware slot math
    fixVersionSuggester.js     Children + acceptance date + release calendar (+ LLM) → Fix Version
    llmService.js              Provider-agnostic JSON calls (OpenAI/Azure, Gemini, Anthropic); prompts
    attributionService.js      Comment on Jira when acting as the service account
    pendingQuestions.js        Legacy in-memory store (kept for API compatibility)
  server/callbackServer.js     HTTP: /oauth/callback, /health, /send-dm
  utils/
    opsNotifier.js  dmQuestion.js  jiraLink.js  jiraLinkParser.js  keepAlive.js  withTimeout.js
    admins.js  logger.js (pino)  dedupCache.js  rateLimiter.js  auditLog.js  alerting.js  userCache.js
supabase/                      SQL for all tables (see §6)
tests/                         Jest (121 tests)
config/*.example.json          Local-dev config templates (legacy path)
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
   the callback HTTP server; start `JiraPoller` and `DigestScheduler` (if Supabase); start keep-alive;
   schedule daily summary.

### 5.2 Handlers

| File | Slack entry points | Responsibility |
|---|---|---|
| `reactionHandler.js` | `reaction_added` | Match channel triggers by channel; fetch message; extract issue keys; per-trigger scope/allowlist/rate/dedup; update field via user OAuth or service account; thread confirmation; audit + ops. |
| `replyHandler.js` | `message` (thread replies, non-bot) | Same for thread replies (root message holds the issue key). |
| `dmHandler.js` | actions `jira_confirm_yes`, `jira_confirm_no`, `jira_reply`, `jira_fixversion_apply(_alt)`, `jira_set_fixversion`, `dm_connect_jira`, `home_connect_jira`; views `jira_response_modal`, `jira_fixversion_modal` | Executes the proposed action (transition or field) as the user; LLM path for free text; Fix Version offer with progress + fallbacks; clears `jira_prompts` on failure so the poller re-asks. |
| `homeHandler.js` | `app_home_opened` | Builds the Home view; exports `publishHome` for other handlers to refresh it. |
| `triggerHandler.js` | actions `home_create_trigger`, `trigger_menu`, `home_create_jira_trigger`, `jira_trigger_menu`; views `create_trigger_modal`, `create_jira_trigger_modal` | CRUD for both trigger kinds; validates JQL against Jira before saving; Run now / Re-ask; all outcomes reported to **ops** (not DM). |
| `preferencesHandler.js` | action `home_set_digest` | Saves digest frequency + Slack tz; flushes queue when switching to immediate. |

Button/menu payloads: the full context (issue key, proposed action, user, question ≤300 chars,
message location) is JSON in the button `value` (≤2000 chars) so clicks work after restarts; modals
carry it in `private_metadata`.

### 5.3 Services

**`jiraService.js`** — `getIssue`, `updateIssueField(key, fieldId, value, type)` (`select` → `{value}`,
`text`, `array` → `[{name}]`, `raw`), `addComment` (ADF paragraphs), `findUser(ByEmail)`, `assignIssue`,
`searchIssues(jql, fields, max=1000)` (POST `/rest/api/3/search/jql`, follows `nextPageToken`, flags
`truncated`), `getTransitions` (with `expand=transitions.fields`), `transitionIssue(key, status)`
(matches destination or transition name; auto-fills required Resolution; names unfillable required
fields), `getProjectVersions`, `getStatusEnteredAt(key, status)` (changelog walk, ≤500 entries),
`static fromOAuthToken(token, cloudId)`. Errors include Jira's `errorMessages`/`errors`.

**`oauthService.js`** — `generateAuthUrl(slackUserId)` (state = Slack user id; scopes
`read:jira-user write:jira-work read:jira-work offline_access`; `prompt=consent`),
`handleCallback(code, state)` (exchange, resolve cloudId matching `JIRA_BASE_URL`, persist),
`hasToken`, `getJiraService(slackUserId)` (refresh if <5 min to expiry), `loadFromDb()`.
In-memory Map is a cache over the `oauth_tokens` table.

**`supabaseService.js`** — PostgREST via axios with `apikey` + `Authorization: Bearer <secret>`.
Methods per table (see §6): tokens (`upsertToken`, `getToken`, `getAllTokens`, `deleteToken`),
integrations (`getActiveIntegrations`, `upsertIntegration`, `updateIntegration`, `deactivateIntegration`),
jira_triggers (`getActiveJiraTriggers`, `insertJiraTrigger`, `updateJiraTrigger`, `deactivateJiraTrigger`),
jira_prompts (`getPromptedIssueKeys`, `recordPrompt(…, {payload, delivered})`, `deletePromptsForIssue`,
`deletePromptsForTrigger`, `getPendingPrompts`, `markPromptsDelivered`), release_calendar
(`getReleaseCalendar`), user_preferences (`getUserPreference`, `getDigestUsers`, `upsertUserPreference`).

**`integrationCache.js`** — merges static integrations with `integrations` rows (normalised to
camelCase), refreshes every 60 s, `invalidate()` on writes.

**`jiraPoller.js`** — tick every `JIRA_POLL_INTERVAL_SEC` (60). For each active Jira trigger due per
its `poll_interval_min`/`last_polled_at`: `searchIssues(jql)`, subtract `jira_prompts`, for each new
issue resolve reporter/assignee email → Slack id (`users.lookupByEmail`, cached), honour
`scope=personal`, honour the user's digest preference (queue vs send), cap
`JIRA_MAX_PROMPTS_PER_RUN` (10) per trigger per run, record prompt, stamp `last_polled_at` even on
failure. Returns per-trigger stats `{matched, fresh, sent, queued, skipped[], sentTo[], queuedFor[]}`.
`runOnce({force, onlyId})` is used by Run now / Re-ask / save.

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
`interpretJiraResponse(...)` and `suggestFixVersion(...)` both call `_callJson(systemPrompt, user)`
and parse strict JSON. Azure OpenAI is detected by `OPENAI_BASE_URL` (uses `api-key` header,
`OPENAI_DEPLOYMENT` as model, `max_completion_tokens`). Prompts in §8.

### 5.4 Utils

`opsNotifier` (all ops messages), `dmQuestion.sendDmQuestion(client, userId, context, _, ops)` (builds
the Yes/No/Reply message, optional Connect block, no key prefix if the question already names the
issue), `jiraLink` (`issueUrl`, `issueLink`, `issueLinkLabelled` with link-safe labels — `|`→`∣`,
`<>&` escaped), `jiraLinkParser.extractJiraIssueKeys`, `keepAlive` (self-GET `/health` every 5 min),
`withTimeout`/`withTimeoutOr`, `admins.isAdmin/canManage` (`ADMIN_SLACK_USER_IDS`), `dedupCache`,
`rateLimiter`, `auditLog` (+ daily summary), `alerting` (error threshold → ops), `userCache`, `logger`.

---

## 6. Data model (Supabase / Postgres)

Project: `https://psmbjacsexnyruhvaxao.supabase.co`. Server uses the **secret (service-role) key**
via REST; RLS is not relied upon. All SQL below has been run in the SQL editor and lives under
`supabase/` (except the first two tables, created earlier by hand and reconstructed here).

### 6.1 `oauth_tokens` — per-Slack-user Atlassian tokens

```sql
create table if not exists public.oauth_tokens (
  slack_user_id  text primary key,
  access_token   text not null,
  refresh_token  text not null,
  expires_at     timestamptz not null,
  cloud_id       text not null,
  updated_at     timestamptz not null default now()
);
```

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
  payload        jsonb null,           -- DM context for queued (digest) prompts
  delivered_at   timestamptz null,     -- null = queued, awaiting a digest
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

---

## 7. End-to-end flows

### 7.1 Reaction → field update

```
reaction_added ─► isThumbsUp? ─► integrationCache.getAll() filter channel+reaction
  ─► conversations.history(1) ─► extractJiraIssueKeys
  ─► resolve Jira client: OAuth token? use it : service account + DM "connect" link
  ─► per trigger: scope/allowlist/rate/dedup ─► updateIssueField ─► thread ✅ ─► attribution comment (svc acct only)
  ─► auditLog.addEntry ─► opsNotifier.jiraTriggered
```

### 7.2 Jira trigger → DM → action

```
JiraPoller tick ─► trigger due? ─► searchIssues(jql) (paginated) ─► minus jira_prompts
  ─► for each new issue (≤ cap): reporter/assignee email ─► users.lookupByEmail ─► scope check
  ─► preference: digest? recordPrompt(queued, payload) : sendDmQuestion(+Connect if no OAuth) + recordPrompt(delivered)
User clicks Yes ─► dmHandler: transitionIssue / updateIssueField as user
  ├─ ok ─► message replaced with ✅ (issue linked) ─► ops
  ├─ "Fix Version is required" ─► offerFixVersion (progress ≤5s/stage) ─► [Use X & retry][Use Y instead][Choose another…]
  └─ other error ─► ❌ + deletePromptsForIssue (poller re-asks next run)
User clicks 💬 Reply ─► modal ─► LLM interpretJiraResponse ─► execute (transition/field/comment/assign) ─► ✅/❌
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
Home "Connect Jira" / DM "🔗 Connect Jira" (URL button) ─► auth.atlassian.com/authorize?state=<slackUserId>
  ─► Atlassian consent ─► GET /oauth/callback?code&state ─► exchange ─► accessible-resources → cloudId
  ─► oauth_tokens upsert ─► HTML "You can close this tab" ─► next Home open shows ✅ connected
```

### 7.5 Trigger management (App Home)

```
➕ Create Trigger / ➕ Create Jira Trigger ─► modal (inline validation; JQL validated against Jira)
  ─► insert ─► invalidate cache ─► conversations.join (public) ─► publishHome ─► ops "<@user> · ✅ created"
⋯ menu ─► edit:<id> (prefilled modal → PATCH) | run:<id> (force runOnce → ops summary)
        | reask:<id> (deletePromptsForTrigger → force run) | delete:<id> (active=false)
Permission: creator or ADMIN_SLACK_USER_IDS. Admins may set scope=global.
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

- Service account API token (`JIRA_USER_EMAIL` + `JIRA_API_TOKEN`) used for polling/reads and as
  write fallback. Reporter/assignee **email visibility** to this account is required for Jira triggers
  to resolve Slack users (Atlassian profile privacy may hide it).
- Existing Jira Automation for epics: when all children are Done → move epic to *Acceptance*.
  Its Slack-notification action should be removed once the bot asks instead.

### 9.4 Supabase

Project created manually; tables per §6; server uses the secret key. Dashboard → Table Editor is the
operator UI for ad-hoc inspection/deletes.

### 9.5 Azure OpenAI

Company endpoint; `OPENAI_BASE_URL` = `https://<resource>.openai.azure.com/openai/deployments/<deployment>`
style base with `OPENAI_DEPLOYMENT` = deployment name (GPT-5.1). Uses `api-key` header.

---

## 10. Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_APP_TOKEN` | yes | Slack Bolt (Socket Mode) |
| `JIRA_BASE_URL`, `JIRA_USER_EMAIL`, `JIRA_API_TOKEN` | yes | Jira service account; base URL also builds issue links |
| `OPS_CHANNEL_ID` | yes (cloud) | Ops channel for all notifications (when `config/settings.json` absent) |
| `JIRA_OAUTH_CLIENT_ID`, `JIRA_OAUTH_CLIENT_SECRET`, `OAUTH_REDIRECT_URI` | for OAuth | Atlassian 3LO |
| `OAUTH_PORT` | no | Local callback port (Render supplies `PORT`) |
| `SUPABASE_URL`, `SUPABASE_SECRET_KEY` | yes (features) | Persistence; without them tokens are in-memory and triggers static |
| `ADMIN_SLACK_USER_IDS` | no | Comma-separated; may create `global` triggers and manage any trigger |
| `INTEGRATIONS_JSON` | legacy | Static channel triggers JSON array (optional now) |
| `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_DEPLOYMENT`, `OPENAI_MODEL` | one provider | LLM (Azure when BASE_URL set) |
| `GEMINI_API_KEY`, `ANTHROPIC_API_KEY` | alt providers | Fallback providers |
| `JIRA_POLL_INTERVAL_SEC` | no (60) | Poller tick; floor for per-trigger cadence |
| `JIRA_MAX_PROMPTS_PER_RUN` | no (10) | Max DMs one trigger sends per run |
| `CURRENT_RELEASE_VERSION` | no | Override "current release" for Fix Version suggestions |
| `KEEP_ALIVE_URL`, `KEEP_ALIVE_INTERVAL_SEC`, `KEEP_ALIVE_DISABLED` | no | Self-ping (defaults from `RENDER_EXTERNAL_URL`, 300 s) |
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

- Auto-deploys on push to `claude/slack-jira-integration-nRbia`.
- **Free tier sleeps after 15 idle minutes of inbound HTTP.** Socket Mode traffic is outbound and
  does not count; when asleep, Slack events and the poller stop. Mitigations: in-app self-ping
  (`keepAlive.js`, 5 min), recommended external monitor (UptimeRobot → `/health` every 5 min), or a
  paid instance (no sleep). A redeploy always revives it.
- Logs: Render dashboard; pino JSON lines, prefixes `[reaction] [reply] [dm] [home] [trigger]
  [jiraTrigger] [jiraPoller/<name>] [digest] [fixVersion] [oauth] [keepAlive] [prefs]`.

### 11.2 Local

```bash
git clone https://github.com/omerm55/mySlackAgent && cd mySlackAgent
git checkout claude/slack-jira-integration-nRbia
npm install
cp .env.example .env   # fill in
npm start              # or: npm run dev (watch)
npm test
```

The OAuth callback needs a public URL locally (tunnel) — corporate networks blocked ngrok, which is why
Render was adopted early.

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

### 12.3 SQL snippets used

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
| Jira trigger matched but nobody DM'd | Reporter email hidden or no Slack user for email | Ops shows the reason; adjust profile visibility or map users |
| Transition fails "A Fix Version is required" | Workflow validator | Bot offers suggestion + picker automatically |
| Only 50 issues found | (fixed) pagination | Now follows `nextPageToken` |
| 400 saving a trigger | Column mismatch / missing migration | Run the relevant SQL in §6 |

---

## 13. Testing

`npm test` → Jest, `tests/*.test.js`, 121 tests:

| Suite | Covers |
|---|---|
| `reactionHandler`, `replyHandler` | Trigger matching, allowlist, rate limit, dedup, personal scope, emoji variants, audit/alerting |
| `jiraService` | Field payload shapes, JQL pagination/truncation/errors, transition matching, Resolution auto-fill, unfillable fields |
| `fixVersionSuggester` | Candidate filtering, calendar windows, timeline/current, LLM adjudication + fallbacks, stage timeouts, progress |
| `digestScheduler` | Time-zone helpers, slot computation, due logic, delivery, flush |
| `jiraPollerQueue` | Send vs queue by preference |
| `dmFixVersionOffer` | Offer rendering, unique action_ids, progress lines, fallback when Slack rejects blocks |
| `dmQuestionFormat` | Template rendering (`{key} ({summary})` → one link, pipe-safety), headline dedup, button context |
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

---

## 15. Known limitations

- **Hosting:** Render free tier sleeps; self-ping mitigates but cannot revive a sleeping instance.
- **Single workspace / single Jira site.** No multi-tenant config.
- **In-memory audit log, dedup and rate limits** reset on restart (Supabase holds the durable state).
- **Email-based user mapping** depends on Atlassian profile visibility; no manual override table yet.
- **Re-ask re-asks everyone**, including users who answered No; outcomes aren't stored per prompt.
- **`/send-dm` test endpoint is unauthenticated** (only useful for demos; remove or protect).
- **Slack rate limits** are not centrally managed (bursts capped only by `JIRA_MAX_PROMPTS_PER_RUN`).
- **Digest slots are fixed** (09:00 / 15:00); no per-user time choice yet.
- **LLM output** is validated structurally, not semantically; reasons are shown to users as-is.
- **Legacy code paths:** `pendingQuestions.js`, `config/*.json` loaders, Docker/pm2 files are kept
  but not exercised in production.

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
- Remove or authenticate `/send-dm`; add a shared-secret header if kept.
- Encrypt OAuth tokens at rest (pgcrypto or app-level) and rotate the Supabase secret key.
- Enable RLS with a service role and audit table access; least-privilege Slack scopes review.
- Secrets scanning in CI; never log tokens (already avoided) — add a test that asserts this.

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
- CI (GitHub Actions): lint, `npm test`, dependency audit, deploy on green.
- ESLint/Prettier config; JSDoc → TypeScript migration or type-checking via `checkJs`.
- Remove legacy paths (`pendingQuestions`, JSON config loaders) once confirmed unused; update README
  to point at this spec.
- Migration tooling for Supabase (numbered SQL files, applied via CI) instead of hand-run scripts.

### 16.9 Compliance & rollout
- Privacy policy/ToS already published for the Atlassian app; add a data-retention policy for
  `jira_prompts`/audit data and a deletion path when a user leaves.
- Rollout guide: pilot group via `scope=personal`/allowlists → team → org; announcement template (used
  in `#product-house-all`) kept in `docs/`.

---

## 17. Glossary

- **Channel trigger / integration** — reaction/reply → field rule scoped to a Slack channel (`integrations` table).
- **Jira trigger** — JQL-polled rule that DMs a person and acts on their answer (`jira_triggers`).
- **Prompt** — one (trigger, issue) question asked of a user (`jira_prompts`); *queued* until a digest, *delivered* otherwise.
- **Scope** — `global` (applies to anyone) vs `personal` (only the creator).
- **OAuth / impersonation** — acting in Jira as the Slack user via their Atlassian token.
- **Service account** — the shared Jira identity used for reads and as write fallback.
- **Timeline fit / current** — release windows from `release_calendar` matched to the acceptance date / today.
- **Ops channel** — Slack channel receiving all operational messages (`OPS_CHANNEL_ID`).
- **Socket Mode** — Slack delivery over an outbound WebSocket; no public request URL needed.
