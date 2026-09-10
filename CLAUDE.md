# Working rules for this repository

## The spec is part of every change

`docs/PROJECT_SPEC.md` is the source of truth for what this bot does and how. **Every commit that
changes behaviour, schema, configuration, prompts or operations must update the spec in the same
commit.** Documentation-only follow-ups are not acceptable; "I'll update the spec later" is a bug.

Before committing, walk this checklist and touch every section that applies:

| If the change… | Update |
|---|---|
| adds/changes a user-visible feature | §2 feature inventory (and §7 flows if a new path) |
| adds/renames a file | §4 repository layout |
| adds/changes a handler, service or util | §5 runtime components (method lists, Slack entry points) |
| touches a table or adds a migration | §6 data model — full SQL, plus the migration under `supabase/` |
| adds/changes an LLM prompt | §8 — prompt verbatim |
| needs a Slack scope/event, Atlassian setting, Supabase or Azure change | §9 external configuration |
| adds/changes an env var | §10 table **and** `.env.example` **and** `render.yaml` |
| changes how to operate or debug it | §12 runbook (setup steps, SQL snippets, symptoms table) |
| adds/removes tests | §13 inventory and the counts in the header and §4 |
| is a design decision worth remembering | §14 history (numbered, one paragraph, with rationale) |
| leaves something knowingly incomplete | §15 known limitations |
| defers work | §16 productization plan |
| relates to a catalog scenario | §18 / `docs/SCENARIO_CATALOG.md` status column |

Also keep the header line current: test count, suite count, deployment URL.

## Other conventions

- Tests: `npm test` must be green before pushing. New behaviour gets a test in `tests/`.
- Ops vs DM: anything about *running or managing triggers* goes to the ops channel; the bot's DMs are
  only for conversations with the user (questions, results, OAuth nudge).
- Never leave a progress message up: every long operation must end in an actionable state.
- Field ids for PR/SNS come from the `pr-sns-knowledge` skill; reference them by id in JQL (`cf[NNNNN]`).
- Deploys: pushing to `claude/slack-jira-integration-nRbia` auto-deploys to Render. Migrations are
  run by hand in the Supabase SQL editor — say so explicitly whenever a change needs one.
