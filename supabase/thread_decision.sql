-- Decisions in flagged threads: when a post carries a non-approval marker (❓ "Needs a decision") and
-- someone mentioned in that flag replies, the bot reads the reply for this field and proposes a value
-- they confirm; on confirm it writes this field plus the trigger's own field, reads both back, and
-- swaps ❓ for ✅. Shape: { "fieldId": "customfield_11228", "fieldName": "Include Release Notes",
-- "options": ["Public", "Internal", "No"] }. Null (the default) = feature off.

alter table public.integrations add column if not exists decision jsonb null;
