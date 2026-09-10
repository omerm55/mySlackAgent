-- R&D Initiative risk review + two generic Jira-trigger features.
--
--   ask_type         'yes_no' (default, today's behaviour) | 'risk_review'
--                    risk_review: DM the owner with the notifier's "Latest notification" text and
--                    offer: set risk status / update Notes / move or clear target / handled.
--   notify_field_id  when notify = 'user_field': the user-picker custom field that names the
--                    person to DM (e.g. customfield_11962 = PR Dev Owner/FC Sponsor).
--   watch_field      re-ask about an issue when this field's value changes (e.g. customfield_15525,
--                    which the rd-initiative-notifier rewrites on every weekly run).
--   answered_at      set when the user acted on a prompt (any button / modal), for reporting.

alter table public.jira_triggers
  add column if not exists ask_type        text not null default 'yes_no',
  add column if not exists notify_field_id text null,
  add column if not exists watch_field     text null;

alter table public.jira_prompts
  add column if not exists answered_at timestamptz null;
