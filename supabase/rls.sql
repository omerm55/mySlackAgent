-- Row Level Security on every table, with NO policies: the app's secret (service-role) key bypasses
-- RLS and keeps working; the anon / authenticated keys can read or write nothing. Belt and braces:
-- also revoke the table grants those roles get by default.
--
-- Run once in the Supabase SQL editor. Re-run after adding a table.

do $$
declare t text;
begin
  foreach t in array array[
    'oauth_tokens', 'oauth_states', 'integrations', 'jira_triggers', 'jira_prompts',
    'release_calendar', 'user_preferences', 'activity_log', 'audit_events', 'app_settings'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
  end loop;
end $$;
