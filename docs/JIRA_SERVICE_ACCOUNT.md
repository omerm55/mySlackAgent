# Jira service account for the Slack ↔ Jira bot — request for IT

> What to create, which permissions it needs and why, and how we switch over. Requested by Omer Meshar
> (PH Ops), owner of the bot. Context for reviewers: [`SECURITY_SUMMARY.md`](SECURITY_SUMMARY.md);
> technical detail: [`PROJECT_SPEC.md`](PROJECT_SPEC.md).

## Why we are asking

The bot authenticates to Jira with **one** account, and **only to read**: it runs JQL searches every
minute or two, reads issues, project versions, transitions and changelogs, and looks up users by e-mail.
**It never writes.** Every Jira change is made with the acting person's own Atlassian OAuth token — since
October 2026 without exception, as the security review (SNS-133715) required.

**Today that account is a personal Jira admin account** (the bot owner's). That is wrong in three ways:
the audit trail attributes the bot's reads to a person who did not perform them, the bot
holds far more permission than it needs, and the credential cannot be revoked without disrupting a real
user. We would like a dedicated, non-human account instead.

## What we would like created

| Item | Value |
|---|---|
| Account type | Atlassian account for automation (not a person's account), e.g. `svc-slack-jira-bot@sisense.com` |
| Display name | `Slack-Jira Bot` — it may appear in Jira's access logs, so it should read as a system |
| Product access | **Jira Software** (and Jira Product Discovery if PR needs its own seat) — nothing else |
| Admin rights | **None.** Not site admin, not org admin, not Jira admin |
| Groups | Only what the permissions below require. Not `site-admins`, not `jira-administrators` |
| Credential | API token created on the account, given to the bot owner to place in the runtime environment |
| Ownership | Owned by IT, used by PH Ops; token rotatable by IT at any time without affecting any person |

## Permissions it actually needs

Scoped to **two projects only**: `SNS` (Sisense) and `PR` (Product Roadmap). No other project.
**Read-only.**

| Jira permission | Why |
|---|---|
| Browse Projects (SNS, PR) | The JQL polling that finds issues to ask about |
| View Development Tools / — | not needed |
| Browse users and groups (global) | Resolve an issue's reporter, assignee or owner field to an e-mail so we can find the right person in Slack; and find the Jira user for a Slack user's e-mail, which is how the bot checks that a person connecting Jira signed in as themselves (security review condition 1) |

The account must also be able to **see users' e-mail addresses**. Atlassian profile visibility can hide
them; when it does, the bot cannot map a Jira person to a Slack person and simply skips that issue. If
org policy forbids exposing e-mail to a service account, tell us and we will use `accountId` mapping
instead, which needs a table we maintain by hand.

**Not needed, please do not grant:** any write permission — Edit, Transition, Assign, Create, Delete or
Move Issues, Add or Delete Comments, Manage Sprints or Watchers, Work On Issues, attachments — and
Administer Projects.

If it is easier to grant a project role than individual permissions, a read-only (browse) role is fine.

## How we switch over

1. IT creates the account and the API token, and grants the read permissions above on SNS and PR.
2. We set three values in the bot's runtime environment: the account's e-mail, its API token, and
   `JIRA_SERVICE_ACCOUNT_EMAIL` (the same address) so the bot can flag a mismatch.
3. On start the bot reports its Jira identity to the operator channel: *"🔑 Jira service identity: Slack-Jira
   Bot (svc-slack-jira-bot@sisense.com)"*, and warns loudly if the live identity is not the expected one.
   That is how we will notice if a personal account is ever left in place again.
4. We watch one polling cycle. If a permission is missing, the poller reports the exact Jira error in the
   operator channel (for example "does not have permission to view this issue"), and we come back with
   the specific gap rather than asking for more up front.
5. The bot owner's personal API token is deleted from the environment and revoked in Atlassian.

Nothing else changes for users: their own actions were already made with their own Atlassian consent.

## What this does not cover

- **The Atlassian OAuth app** (`read:jira-user`, `read:jira-work`, `write:jira-work`, `offline_access`)
  is how users' own writes happen. It is unrelated to this account and needs no change.
- **License cost.** If a service seat is a licensing problem, say so and we will discuss reducing the
  polling scope instead.
