-- Small key/value operational state that must be changeable without a deploy. Today one key:
--
--   'paused'  {"paused": true|false}  the global kill switch. While set, no Jira trigger is evaluated,
--             no ask is sent, and every write path refuses and writes nothing — the asks already in
--             people's DMs stay intact and work again after resuming. Toggled by an admin from App
--             Home; `updated_by` / `updated_at` record who and when, and both transitions are written
--             to audit_events. The BOT_PAUSED environment variable is an independent break-glass switch
--             for when the database itself is the problem.

create table if not exists public.app_settings (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now(),
  updated_by  text null                       -- Slack user id
);

alter table public.app_settings enable row level security;
revoke all on table public.app_settings from anon, authenticated;
