# mySlackAgent — Slack ↔ Jira Integration

A Node.js bot that bridges Slack and Jira.

## Current features

### 1. Thread reply → Jira field update
When a user **replies in a thread** inside a configured Slack channel, and the **root message of that thread contains a Jira issue link**, the bot automatically updates a configurable field on that Jira issue.

### 2. 👍 reaction → Jira field update
When a user **adds a thumbs-up reaction** (👍 / `:+1:` / `:thumbsup:`) to a message in the configured channel that contains a Jira issue link, the same field update is triggered.

### How it works

1. The bot listens (via Socket Mode) for all `message` events in the configured channel.
2. When a thread reply is detected it fetches the root message of that thread.
3. It scans the root message text for Atlassian browse URLs (e.g. `https://yourco.atlassian.net/browse/PROJ-123`).
4. For each found issue key it calls the Jira REST API to set `JIRA_FIELD_ID` = `JIRA_FIELD_VALUE`.

## Setup

### 1. Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and create a new app **from scratch**.
2. Under **Socket Mode**, enable it and generate an **App-Level Token** (`connections:write` scope) — this is your `SLACK_APP_TOKEN`.
3. Under **OAuth & Permissions** add these **Bot Token Scopes**:
   - `channels:history` (read messages in public channels)
   - `groups:history` (read messages in private channels)
   - `channels:read`
   - `reactions:read` (detect emoji reactions)
   - `chat:write` _(optional, for future features)_
4. Under **Event Subscriptions** → **Subscribe to bot events**, add:
   - `message.channels`
   - `message.groups`
   - `reaction_added`
5. Install the app to your workspace and copy the **Bot User OAuth Token** (`SLACK_BOT_TOKEN`).
6. Copy the **Signing Secret** from **Basic Information** (`SLACK_SIGNING_SECRET`).
7. Invite the bot to the channel you want to monitor (`/invite @your-bot`).

### 2. Jira API token

Generate an API token at <https://id.atlassian.com/manage-profile/security/api-tokens>.

### 3. Environment variables

```bash
cp .env.example .env
# Fill in all values in .env
```

| Variable | Description |
|---|---|
| `SLACK_BOT_TOKEN` | Bot token (`xoxb-…`) |
| `SLACK_SIGNING_SECRET` | App signing secret |
| `SLACK_APP_TOKEN` | App-level token (`xapp-…`) for Socket Mode |
| `SLACK_WATCH_CHANNEL_ID` | Channel ID to monitor (e.g. `C0123456789`) |
| `JIRA_BASE_URL` | e.g. `https://yourco.atlassian.net` |
| `JIRA_USER_EMAIL` | Email used for Jira API auth |
| `JIRA_API_TOKEN` | Jira API token |
| `JIRA_FIELD_ID` | Field to update, e.g. `customfield_10000` or `status` |
| `JIRA_FIELD_VALUE` | Value to set, e.g. `In Review` |
| `JIRA_FIELD_TYPE` | _(optional)_ `select` (default), `text`, `array`, or `raw` |

### 4. Run

```bash
npm install
npm start
```

## Project structure

```
src/
  index.js                  # Entry point, wires everything together
  handlers/
    replyHandler.js         # Slack event handler for thread replies
  services/
    jiraService.js          # Jira REST API client
  utils/
    jiraLinkParser.js       # Extracts Jira issue keys from text
.env.example                # Environment variable template
```
