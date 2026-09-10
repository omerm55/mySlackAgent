-- Jira triggers: a JQL condition polled every few minutes. Each new matching
-- issue triggers a Yes / No / Reply DM to the issue's reporter or assignee.
-- Run this once in the Supabase SQL editor.

create table if not exists public.jira_triggers (
  id                uuid primary key default gen_random_uuid(),
  created_by        text not null,                          -- Slack user ID
  scope             text not null default 'global',         -- 'global' | 'personal'
  name              text not null,
  jql               text not null,
  question          text not null,                          -- supports {key} {summary} {status} {reporter} {assignee}
  notify            text not null default 'reporter',       -- 'reporter' | 'assignee'
  action_type       text not null default 'transition',     -- 'transition' | 'field'
  transition_to     text null,                              -- e.g. 'Done' (when action_type = 'transition')
  jira_field_id     text null,                              -- when action_type = 'field'
  jira_field_name   text null,
  jira_field_value  text null,
  jira_field_type   text null default 'select',
  poll_interval_min integer not null default 2,               -- how often to evaluate this trigger
  last_polled_at    timestamptz null,                         -- set by the poller after each evaluation
  active            boolean not null default true,
  created_at        timestamptz not null default now()
);

-- Migration for tables created before poll_interval_min existed:
alter table public.jira_triggers
  add column if not exists poll_interval_min integer not null default 2,
  add column if not exists last_polled_at timestamptz null;

create index if not exists jira_triggers_active_idx
  on public.jira_triggers (active, created_at);

-- One row per (trigger, issue) that has already been asked about,
-- so a user is never DM'd twice for the same issue by the same trigger.
create table if not exists public.jira_prompts (
  id             uuid primary key default gen_random_uuid(),
  trigger_id     uuid not null references public.jira_triggers (id) on delete cascade,
  issue_key      text not null,
  slack_user_id  text null,                                 -- null = matched but nobody could be DM'd
  prompted_at    timestamptz not null default now(),
  unique (trigger_id, issue_key)
);

create index if not exists jira_prompts_trigger_idx
  on public.jira_prompts (trigger_id);
