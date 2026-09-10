-- Pilot list for Jira triggers: when set, only these Slack users receive the ask (and FYIs are only
-- sent to people on the list). Everyone else matched by the JQL is skipped — not recorded as asked —
-- so clearing the list later asks them normally. Lets a trigger run with scope = global for a few
-- named people before opening it to everyone.

alter table public.jira_triggers
  add column if not exists pilot_slack_user_ids text[] null;
