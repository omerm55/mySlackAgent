#!/usr/bin/env node
'use strict';

/**
 * Apply the schema in supabase/ to a Postgres database, in dependency order.
 *
 *   node scripts/apply-schema.js "postgres://user:pass@host:5432/db"
 *   node scripts/apply-schema.js            # uses DATABASE_URL
 *
 * Every file is idempotent (`create table if not exists`, `add column if not exists`), so this is
 * safe to re-run and is how a new environment is provisioned — the migration to a database outside
 * Supabase starts here, followed by the data copy (§12.7).
 *
 * Order matters: jira_triggers.sql creates the table that the later alters extend, and it also
 * creates jira_prompts. Alphabetical order does not work, which is why the list is explicit.
 *
 * rls.sql is deliberately NOT in the list: it grants against Supabase's `anon` / `authenticated`
 * roles, which exist only there. On Supabase it is run by hand (§12.2); elsewhere the equivalent is
 * a least-privilege role for the application (§12.7).
 */

const fs = require('fs');
const path = require('path');

const SCHEMA_DIR = path.join(__dirname, '..', 'supabase');

const FILES = [
  'oauth_tokens.sql',
  'integrations.sql',
  'jira_triggers.sql',      // also creates jira_prompts
  'oauth_states.sql',
  'release_calendar.sql',
  'activity_log.sql',
  'audit_events.sql',
  'app_settings.sql',
  'user_preferences.sql',   // also alters jira_prompts (payload, delivered_at)
  'risk_review.sql',        // alters jira_triggers, jira_prompts
  'collect_fields.sql',
  'fyi_field.sql',
  'pilot_users.sql',
  'require_oauth.sql',
];

/**
 * @param {import('pg').Pool|import('pg').Client} db  an open pool/client
 * @param {(msg: string) => void} [log]
 */
async function applySchema(db, log = () => {}) {
  for (const file of FILES) {
    const sql = fs.readFileSync(path.join(SCHEMA_DIR, file), 'utf8');
    await db.query(sql);
    log(`applied ${file}`);
  }
}

module.exports = { FILES, SCHEMA_DIR, applySchema };

if (require.main === module) {
  const connectionString = process.argv[2] || process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('usage: node scripts/apply-schema.js <connection-string>   (or set DATABASE_URL)');
    process.exit(2);
  }
  const { Pool } = require('pg');
  const isLocal = /@(localhost|127\.0\.0\.1|postgres)[:/]/.test(connectionString);
  const pool = new Pool({ connectionString, ssl: isLocal ? false : { rejectUnauthorized: false } });
  applySchema(pool, (m) => console.log(m))
    .then(() => { console.log(`\nSchema applied (${FILES.length} files).`); return pool.end(); })
    .catch(async (err) => {
      console.error(`\nFailed: ${err.message}`);
      await pool.end().catch(() => {});
      process.exit(1);
    });
}
