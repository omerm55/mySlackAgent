# mySlackAgent — Slack ↔ Jira Integration

A Node.js bot that turns existing Slack behaviour (👍 reactions, thread replies) and Jira state (JQL
conditions) into Jira updates — with a human-in-the-loop DM conversation, per-user OAuth so every
change is attributed to the real person, and an LLM to interpret free-text answers.

Status: hackathon build (Sept 2026), deployed and in use at Sisense.
Production: <https://myslackagent.onrender.com> · Tests: `npm test` (267 passing, 28 suites).

> **Full detail lives in [`docs/PROJECT_SPEC.md`](docs/PROJECT_SPEC.md).** This README is the short
> orientation; the spec is the source of truth for architecture, data model, flows, prompts and
> operations. Section references below (§n) point into it.

## What it does

| | |
|---|---|
| **Channel triggers** (§2.1) | Watch a channel; a 👍 / ✅ reaction or a thread reply on a message containing a Jira key sets a configured field on that issue and confirms in the thread. Per-trigger field, value, scope, rate limit and allowlist. |
| **Jira triggers** (§2.2) | Poll a JQL on a per-trigger cadence. Each newly matching issue resolves to a Slack user by email, who gets a DM asking to approve a transition or field change. Asked once per issue per trigger. New triggers default to `scope = personal` so a mis-typed JQL cannot surprise the company. |
| **DM conversation** (§2.3) | **Yes** applies the action · **No** declines · **💬 Reply** takes free text ("yes but set it to Needs Review"), which an LLM turns into a structured action and shows back as a preview. Nothing reaches Jira until the person confirms — the LLM never writes on its own. |
| **Per-user OAuth** (§2.5) | Atlassian 3LO, single-use `state`, tokens encrypted at rest (AES-256-GCM) in Supabase and auto-refreshed. Writes use the person's own token; reads and polling use the service account. |
| **App Home** (§2.6) | OAuth status, notification preference, recent activity. Admins also get trigger management (create / edit / run now / re-ask / delete). |
| **Digests** (§2.7) | Immediately (default), hourly, twice daily or daily, in the user's Slack time zone. |
| **Risk review** (§2.9) | Reads the weekly `Latest notification` stamp on PR Initiatives and asks the Dev owner to re-flag risk, update Notes or move the target; FYIs the PM owner. |
| **Collect fields** (§2.10) | Asks the PM owner to fill missing Customer-friendly name / Customer value, extracting them from free text via the LLM and saving in one write after confirmation. |
| **Fix Version help** (§2.4) | When a transition fails a Fix Version validator, suggests one from the epic's children and a release calendar, and retries. |

## Setup

### 1. Slack app

Create an app from scratch at [api.slack.com/apps](https://api.slack.com/apps), then (§9.1):

- **Socket Mode** — enable, generate an app-level token with `connections:write` → `SLACK_APP_TOKEN`.
- **Bot token scopes** — `channels:history`, `groups:history`, `channels:read`, `groups:read`,
  `channels:join`, `reactions:read`, `chat:write`, `im:history`, `im:write`, `users:read`,
  `users:read.email`.
- **Event subscriptions (bot)** — `message.channels`, `message.groups`, `message.im`,
  `reaction_added`, `app_home_opened`.
- **Interactivity & Shortcuts** — enabled (Socket Mode delivers the button and modal events).
- **App Home** — Home tab and Messages tab both enabled.
- Install to the workspace → `SLACK_BOT_TOKEN`; Basic Information → `SLACK_SIGNING_SECRET`.

The bot must be a **member** of any channel it watches (`/invite @bot`). Public channels are joined
automatically when a trigger is created; private channels need the invite.

### 2. Atlassian

- **Service account** — API token at <https://id.atlassian.com/manage-profile/security/api-tokens>,
  used for all reads and polling (§9.3).
- **OAuth 2.0 (3LO) app** at [developer.atlassian.com](https://developer.atlassian.com) for per-user
  writes (§9.2): scopes `read:jira-user`, `read:jira-work`, `write:jira-work`, `offline_access`;
  callback `https://<your-host>/oauth/callback`; **Distribution → Sharing** enabled so people other
  than the app owner can consent.

### 3. Supabase and the LLM

Supabase holds triggers, OAuth tokens, prompts and the activity log (§6) — without it tokens are
in-memory and triggers static. Run the SQL in [`supabase/`](supabase/) by hand in the SQL editor;
migrations are never applied automatically.

One LLM provider is required for free-text interpretation: OpenAI / Azure OpenAI, Gemini or
Anthropic (§8).

### 4. Environment

```bash
cp .env.example .env   # fill in
```

`.env.example` documents every variable and [`render.yaml`](render.yaml) declares them for deploys;
**§10 of the spec is the annotated table**. The ones you cannot start without:

| Variable | Purpose |
|---|---|
| `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_APP_TOKEN` | Slack Bolt (Socket Mode) |
| `JIRA_BASE_URL`, `JIRA_USER_EMAIL`, `JIRA_API_TOKEN` | Jira service account; also builds issue links |
| `SUPABASE_URL`, `SUPABASE_SECRET_KEY` | Persistence |
| `TOKEN_ENCRYPTION_KEY` | 32 random bytes, base64 (`openssl rand -base64 32`) — encrypts OAuth tokens at rest. Once any encrypted row exists the bot refuses to start without it |
| `JIRA_OAUTH_CLIENT_ID`, `JIRA_OAUTH_CLIENT_SECRET`, `OAUTH_REDIRECT_URI` | Per-user OAuth |
| `OPS_CHANNEL_ID` | Channel for operational notifications |
| `ADMIN_SLACK_USER_IDS` | Comma-separated; who may manage triggers |
| one of `OPENAI_API_KEY` / `GEMINI_API_KEY` / `ANTHROPIC_API_KEY` | LLM provider |

### 5. Run

```bash
npm install
npm start        # or: npm run dev (watch)
npm test
```

The OAuth callback needs a public URL locally (a tunnel); corporate networks blocked ngrok, which is
why Render was adopted early (§11.2).

## Project structure

```
src/
  index.js                    # Entry point, wires handlers, poller and schedulers
  loadIntegrations.js         # Static channel triggers (legacy INTEGRATIONS_JSON path)
  loadSettings.js
  handlers/
    reactionHandler.js        # 👍 / ✅ on a message with a Jira key
    replyHandler.js           # Thread reply on a message with a Jira key
    dmHandler.js              # The DM conversation: Yes / No / Reply, previews, modals
    homeHandler.js            # App Home, trigger management
    triggerHandler.js         # Create / edit / run / delete triggers
    preferencesHandler.js     # Digest preferences
  services/
    jiraService.js            # Jira REST client
    jiraPoller.js             # JQL polling per Jira trigger
    oauthService.js           # Atlassian 3LO, token refresh
    supabaseService.js        # Persistence
    llmService.js             # Free-text → structured action, field extraction
    digestScheduler.js        # Queued question delivery
    fixVersionSuggester.js    # Fix Version suggestions on validator failure
    attributionService.js     # "acting on behalf of" comments
    integrationCache.js
  server/callbackServer.js    # OAuth callback + /health
  utils/                      # logger, admins, rate limiting, dedup, audit log,
                              # token crypto, alerting, keep-alive, ops notifier, …
docs/                         # PROJECT_SPEC.md and friends
supabase/                     # SQL for every table and migration (§6)
tests/                        # Jest — 267 tests, 28 suites
render.yaml  Dockerfile  docker-compose.yml  ecosystem.config.js  .env.example
```

## Deploying

Render deploys `main`, but **indirectly** (§11.4). The source of truth is
`gitlab.rnd.sisense.com/Omer.Meshar/jira-slack-bot`; Render cannot reach the internal GitLab, so the
chain is:

```
push to GitLab main  →  GitLab push mirror  →  GitHub main  →  Render
```

Allow for the mirror's lag, and never push to GitHub directly — the mirror force-updates its `main`.
If a deploy does not start, check the mirror row in GitLab → Settings → Repository before suspecting
Render. Database migrations are **run by hand** in the Supabase SQL editor.

## Documentation

- **Full project specification** (architecture, data model, flows, LLM prompts, external
  configuration, operations runbook, productization plan): [`docs/PROJECT_SPEC.md`](docs/PROJECT_SPEC.md)
- Scenario catalog (Jira asks mapped to app capabilities): [`docs/SCENARIO_CATALOG.md`](docs/SCENARIO_CATALOG.md)
- Security summary: [`docs/SECURITY_SUMMARY.md`](docs/SECURITY_SUMMARY.md)
- Jira service account permissions (request for IT): [`docs/JIRA_SERVICE_ACCOUNT.md`](docs/JIRA_SERVICE_ACCOUNT.md)
- Earlier architecture notes (March design): [`docs/architecture.md`](docs/architecture.md)
- Working rules for contributors and AI sessions (spec-maintenance checklist): [`CLAUDE.md`](CLAUDE.md)
