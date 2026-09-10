-- `collect` ask type (scenario catalog A1: Customer-friendly name + Customer value).
--
--   collect_fields   jsonb array of the fields to fill: [{ "id": "customfield_11822",
--                    "name": "Customer-friendly name", "hint": "External-facing name", "required": true }, ...]
--                    The DM offers Answer / Skip; Answer opens a modal (free text + one input per field);
--                    the LLM extracts values from the free text, the user confirms a preview, and all
--                    fields are written in ONE PUT as the user.

alter table public.jira_triggers
  add column if not exists collect_fields jsonb null;
