-- Pending "Connect Jira" links. The OAuth `state` is a random 256-bit token (base64url) that maps to
-- the Slack user server-side; it is single-use (used_at set atomically on the callback) and expires
-- after 24 hours (links live in App Home and inside asks and are clicked later). Replaces the earlier
-- design where `state` was the Slack user id — predictable and replayable.

create table if not exists public.oauth_states (
  state          text primary key,
  slack_user_id  text not null,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null,
  used_at        timestamptz null
);
create index if not exists oauth_states_expires_idx on public.oauth_states (expires_at);
