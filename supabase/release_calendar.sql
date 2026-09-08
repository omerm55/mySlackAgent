-- Release calendar: which Jira version branches out when.
-- Used to suggest an epic's Fix Version from the date it entered Acceptance:
--   "timeline fit" = the first version whose branch_out is on/after that date
--   "current"      = the first version whose branch_out is on/after today
-- version_name must match the Jira version name exactly (case-insensitive), e.g. '2026.4.0'.
-- Optional: when this table is empty, Jira's own version start/release dates are used instead.

create table if not exists public.release_calendar (
  version_name  text primary key,
  branch_out    date not null,
  release_date  date null,
  notes         text null
);

-- Example rows — replace with your branch-out page:
-- insert into public.release_calendar (version_name, branch_out, release_date) values
--   ('2026.3.0', '2026-07-06', '2026-08-03'),
--   ('2026.4.0', '2026-09-21', '2026-10-19'),
--   ('2026.5.0', '2026-12-07', '2027-01-11')
-- on conflict (version_name) do update set branch_out = excluded.branch_out, release_date = excluded.release_date;
