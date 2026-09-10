'use strict';

const { logger } = require('../utils/logger');

function normalizeRow(row) {
  return {
    id: row.id,
    name: row.name,
    slackChannelId: row.channel_id,
    triggers: Array.isArray(row.triggers) ? row.triggers : JSON.parse(row.triggers || '[]'),
    jiraFieldId: row.jira_field_id,
    jiraFieldName: row.jira_field_name || row.jira_field_id,
    jiraFieldValue: row.jira_field_value,
    jiraFieldType: row.jira_field_type || 'select',
    allowedSlackUserIds: Array.isArray(row.allowed_slack_user_ids)
      ? row.allowed_slack_user_ids
      : [],
    rateLimitPerHour: row.rate_limit_per_hour || 20,
    scope: row.scope || 'global',
    createdBy: row.created_by,
    allowBotFallback: row.allow_bot_fallback === true,
  };
}

/**
 * Merges static integrations (from INTEGRATIONS_JSON) with database rows.
 * Refreshes from DB at most every `ttlMs` milliseconds.
 */
class IntegrationCache {
  constructor(db, staticIntegrations = [], ttlMs = 60_000) {
    this.db = db;
    this.static = staticIntegrations;
    this.ttlMs = ttlMs;
    this._cache = null;
    this._loadedAt = 0;
  }

  async getAll() {
    if (!this._cache || Date.now() - this._loadedAt > this.ttlMs) {
      await this._refresh();
    }
    return this._cache;
  }

  invalidate() {
    this._cache = null;
    this._loadedAt = 0;
  }

  async _refresh() {
    let dbRows = [];
    if (this.db) {
      try {
        dbRows = await this.db.getActiveIntegrations();
      } catch (err) {
        logger.warn(`[integrationCache] Failed to load from the database: ${err.message}`);
      }
    }
    const dbIntegrations = dbRows.map(normalizeRow);
    this._cache = [...this.static, ...dbIntegrations];
    this._loadedAt = Date.now();
    logger.info(`[integrationCache] Loaded ${this._cache.length} integration(s) (${this.static.length} static, ${dbIntegrations.length} from DB)`);
  }
}

module.exports = IntegrationCache;
