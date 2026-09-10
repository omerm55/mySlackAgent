-- Channel triggers: a 👍 reaction or a thread reply on a message containing a Jira key sets a field
-- on that issue. Created and edited from App Home; `triggers` holds which of reaction / reply fire it.
-- The legacy INTEGRATIONS_JSON environment variable feeds the same shape without a database.
--
-- This table predates the SQL files in this directory — it was created by hand in the Supabase editor
-- and the definition lived only in §6.2 of the specification. Written down here in Sept 2026 so a new
-- environment can be provisioned from the repository (§12.7); it is the same DDL as §6.2.
--
-- `allow_bot_fallback` is also added by require_oauth.sql (`add column if not exists`), which is
-- idempotent — the column is defined here because the live table has it.

create table if not exists public.integrations (
  id                 uuid not null default gen_random_uuid(),
  created_by         text not null,                     -- Slack user id
  scope              text not null,                     -- 'global' | 'personal'
  name               text not null,
  description        text null,
  channel_id         text not null,
  jira_field_id      text not null,
  jira_field_name    text null,
  jira_field_value   text not null,
  jira_field_type    text null default 'select',
  triggers           text[] not null,                   -- {'reaction','reply'}
  allow_bot_fallback boolean not null default false,    -- admin exception: bot account may act for unconnected users
  active             boolean null default true,
  created_at         timestamptz null default now(),
  constraint integrations_pkey primary key (id)
);

create index if not exists integrations_user_idx    on public.integrations (created_by, active);
create index if not exists integrations_channel_idx on public.integrations (channel_id, active);
