-- OAuth is required for writes. A person who has not connected Jira is asked to connect and press the
-- button again; nothing is written on their behalf. Admins may allow the bot (service) account to act
-- for not-yet-connected people on a specific trigger — an explicit, labelled exception (attribution
-- comment on the issue, "acting as bot" in the ops channel). Default: not allowed, for existing rows too.

alter table public.integrations  add column if not exists allow_bot_fallback boolean not null default false;
alter table public.jira_triggers add column if not exists allow_bot_fallback boolean not null default false;
