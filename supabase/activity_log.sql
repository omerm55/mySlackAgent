-- Per-user activity: every Jira change the bot made on someone's behalf (reactions, replies,
-- DM Yes / free-text, risk-review actions). Feeds the App Home "Your recent activity" section and
-- survives restarts (the in-memory audit log only feeds the daily ops summary).

create table if not exists public.activity_log (
  id               uuid primary key default gen_random_uuid(),
  ts               timestamptz not null default now(),
  slack_user_id    text not null,
  slack_user_name  text null,
  integration_name text null,
  trigger          text not null,          -- '👍 reaction' | 'thread reply' | 'DM Yes' | 'DM reply' | '🩺 risk review' …
  issue_key        text not null,
  field_name       text null,
  field_value      text null,
  success          boolean not null default true,
  error            text null
);

create index if not exists activity_log_user_ts_idx on public.activity_log (slack_user_id, ts desc);
