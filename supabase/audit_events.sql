-- Durable operator record. Every line the bot posts to the ops channel is also written here, so the
-- audit trail outlives Slack's retention and can be queried: who changed what, when, and as whom.
--
--   kind    event type — 'reaction_write' | 'reply_write' | 'ask_sent' | 'dm_yes' | 'dm_no' |
--           'risk_action' | 'collect_action' | 'llm_proposed' | 'llm_applied' | 'llm_error' |
--           'trigger_skipped' | 'reaction_filtered' | 'ops' (anything posted directly)
--   ok      false for failures (the text carries Jira's error)
--   text    the ops-channel message, verbatim
--   detail  structured extras: field, value, identity used ('user (OAuth)' | 'bot account'), reason
--
-- Writes are fire-and-forget from the app; a database hiccup never blocks an operator message.

create table if not exists public.audit_events (
  id             uuid primary key default gen_random_uuid(),
  ts             timestamptz not null default now(),
  kind           text not null,
  slack_user_id  text null,
  issue_key      text null,
  ok             boolean not null default true,
  text           text null,
  detail         jsonb null
);

create index if not exists audit_events_ts_idx    on public.audit_events (ts desc);
create index if not exists audit_events_issue_idx on public.audit_events (issue_key, ts desc);
create index if not exists audit_events_user_idx  on public.audit_events (slack_user_id, ts desc);
create index if not exists audit_events_kind_idx  on public.audit_events (kind, ts desc);

-- Same posture as every other table: only the server's key may read or write.
alter table public.audit_events enable row level security;
revoke all on table public.audit_events from anon, authenticated;
