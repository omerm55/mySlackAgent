-- Release calendar: each Jira version's branch-out window.
-- Used to suggest an epic's Fix Version from the date it entered Acceptance:
--   "timeline fit" = the version whose window contains that date (or the next window after it)
--   "current"      = the version whose window contains today
-- version_name must match the Jira version name (case-insensitive), e.g. '2026.4.0'.
-- When this table is empty, Jira's own version start/release dates are used instead.

create table if not exists public.release_calendar (
  version_name    text primary key,
  branch_out      date not null,          -- window start
  branch_out_end  date null,              -- window end (inclusive); null = single day
  release_date    date null,
  notes           text null
);

alter table public.release_calendar
  add column if not exists branch_out_end date null;

insert into public.release_calendar (version_name, branch_out, branch_out_end) values
  ('2026.1.0', '2025-12-01', '2025-12-31'),
  ('2026.1.2', '2026-02-01', '2026-02-28'),
  ('2026.2.0', '2026-03-01', '2026-03-31'),
  ('2026.2.1', '2026-04-01', '2026-04-30'),
  ('2026.2.2', '2026-05-01', '2026-05-31'),
  ('2026.3.0', '2026-06-01', '2026-06-30'),
  ('2026.3.1', '2026-07-01', '2026-07-31'),
  ('2026.3.2', '2026-08-01', '2026-08-31'),
  ('2026.4.0', '2026-09-01', '2026-09-30'),
  ('2026.4.1', '2026-10-01', '2026-10-31'),
  ('2026.4.2', '2026-11-01', '2026-11-30'),
  ('2027.1.0', '2026-12-01', '2026-12-31'),
  ('2027.1.1', '2027-01-01', '2027-01-31'),
  ('2027.1.2', '2027-02-01', '2027-02-28'),
  ('2027.2.0', '2027-03-01', '2027-03-31'),
  ('2027.2.1', '2027-04-01', '2027-04-30'),
  ('2027.2.2', '2027-05-01', '2027-05-31'),
  ('2027.3.0', '2027-06-01', '2027-06-30')
on conflict (version_name) do update
  set branch_out = excluded.branch_out, branch_out_end = excluded.branch_out_end;
