'use strict';

const fs = require('fs');
const path = require('path');

const VALID_TRIGGERS = new Set(['reply', 'reaction']);
const VALID_FIELD_TYPES = new Set(['select', 'text', 'array', 'raw']);

/**
 * Load and validate the integrations config file.
 * Exits the process with a clear error message if the config is invalid.
 *
 * @param {string} [filePath]  Defaults to config/integrations.json in the project root
 * @returns {Array<object>}    Validated integration definitions
 */
function loadIntegrations(filePath) {
  const configPath = filePath || path.resolve(__dirname, '../config/integrations.json');

  if (!fs.existsSync(configPath)) {
    console.error(
      `Integrations config not found at: ${configPath}\n` +
      `Copy config/integrations.example.json to config/integrations.json and fill in your values.`
    );
    process.exit(1);
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    console.error(`Failed to parse integrations config: ${err.message}`);
    process.exit(1);
  }

  if (!Array.isArray(raw) || raw.length === 0) {
    console.error('integrations.json must be a non-empty array.');
    process.exit(1);
  }

  const names = new Set();
  for (const [i, entry] of raw.entries()) {
    const ctx = `integrations[${i}]`;

    if (!entry.name || typeof entry.name !== 'string') {
      console.error(`${ctx}: "name" is required and must be a string.`);
      process.exit(1);
    }
    if (names.has(entry.name)) {
      console.error(`${ctx}: duplicate integration name "${entry.name}".`);
      process.exit(1);
    }
    names.add(entry.name);

    if (!entry.slackChannelId || typeof entry.slackChannelId !== 'string') {
      console.error(`${ctx} ("${entry.name}"): "slackChannelId" is required.`);
      process.exit(1);
    }
    if (!entry.jiraFieldId || typeof entry.jiraFieldId !== 'string') {
      console.error(`${ctx} ("${entry.name}"): "jiraFieldId" is required.`);
      process.exit(1);
    }
    if (!entry.jiraFieldValue && entry.jiraFieldValue !== 0) {
      console.error(`${ctx} ("${entry.name}"): "jiraFieldValue" is required.`);
      process.exit(1);
    }
    if (entry.jiraFieldType && !VALID_FIELD_TYPES.has(entry.jiraFieldType)) {
      console.error(`${ctx} ("${entry.name}"): "jiraFieldType" must be one of: ${[...VALID_FIELD_TYPES].join(', ')}.`);
      process.exit(1);
    }
    if (!entry.owner || typeof entry.owner !== 'string') {
      console.error(`${ctx} ("${entry.name}"): "owner" is required (email or name of the person responsible).`);
      process.exit(1);
    }
    if (entry.allowedSlackUserIds !== undefined && !Array.isArray(entry.allowedSlackUserIds)) {
      console.error(`${ctx} ("${entry.name}"): "allowedSlackUserIds" must be an array.`);
      process.exit(1);
    }
    if (entry.rateLimitPerHour !== undefined && (typeof entry.rateLimitPerHour !== 'number' || entry.rateLimitPerHour < 1)) {
      console.error(`${ctx} ("${entry.name}"): "rateLimitPerHour" must be a positive number.`);
      process.exit(1);
    }
    if (!Array.isArray(entry.triggers) || entry.triggers.length === 0) {
      console.error(`${ctx} ("${entry.name}"): "triggers" must be a non-empty array.`);
      process.exit(1);
    }
    for (const t of entry.triggers) {
      if (!VALID_TRIGGERS.has(t)) {
        console.error(`${ctx} ("${entry.name}"): unknown trigger "${t}". Valid values: ${[...VALID_TRIGGERS].join(', ')}.`);
        process.exit(1);
      }
    }
  }

  return raw;
}

module.exports = { loadIntegrations };
