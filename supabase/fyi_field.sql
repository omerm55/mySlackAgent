-- Optional second recipient for a Jira trigger: the user in this field gets an informational DM
-- (no buttons) when the main person is asked, and a one-line follow-up when they act.
-- For ask_type = 'risk_review' this defaults to the PR PM owner (customfield_11909) when null.

alter table public.jira_triggers
  add column if not exists fyi_field_id text null;
