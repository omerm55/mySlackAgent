-- Reply markers on channel triggers: a thread reply containing a phrase makes the bot react with an
-- emoji on the thread's root message, and write nothing to Jira. Each element is
-- { "match": "Auto-verified", "emoji": "thumbsup" }; the first phrase found in the reply wins.
-- Built for the PM-reviewed channel, where a scheduled review replies "Auto-verified" (👍) or
-- "Needs a decision" (❓). Empty for existing rows, so nothing changes until a trigger is edited.

alter table public.integrations add column if not exists reply_markers jsonb not null default '[]'::jsonb;
