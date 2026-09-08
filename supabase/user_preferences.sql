-- Per-user notification preferences for bot-initiated DMs (Jira triggers).
-- Default is 'immediate' — behaviour is unchanged unless a user opts into a digest.
--   immediate    → DM as soon as a trigger matches (today's behaviour)
--   hourly       → batch, delivered at the top of each hour
--   twice_daily  → batch, delivered at 09:00 and 15:00 in the user's Slack time zone
--   daily        → batch, delivered at 09:00 in the user's Slack time zone

create table if not exists public.user_preferences (
  slack_user_id     text primary key,
  digest_frequency  text not null default 'immediate',
  tz                text null,                    -- IANA zone from the Slack profile, e.g. 'Asia/Jerusalem'
  last_digest_at    timestamptz null,
  updated_at        timestamptz not null default now()
);

-- Queued (not yet delivered) prompts keep their DM payload until the digest goes out.
alter table public.jira_prompts
  add column if not exists payload      jsonb null,
  add column if not exists delivered_at timestamptz null;

-- Everything recorded before this migration was delivered immediately.
update public.jira_prompts set delivered_at = prompted_at where delivered_at is null;

create index if not exists jira_prompts_pending_idx
  on public.jira_prompts (slack_user_id) where delivered_at is null;
