'use strict';

const { logger } = require('../utils/logger');

/**
 * Resolves who triggered an action and posts an attribution comment on the
 * Jira issue.
 *
 * Jira Cloud does not support impersonation via basic auth — the API always
 * acts as the automation account. This service compensates by:
 *   1. Looking up the triggering Slack user's email
 *   2. Finding their Jira account by that email (if it exists)
 *   3. Adding a comment that @-mentions them so the change is traceable
 */
class AttributionService {
  /**
   * @param {import('./jiraService')} jiraService
   */
  constructor(jiraService) {
    this.jiraService = jiraService;
  }

  /**
   * Look up the Slack user's display name and email.
   * @param {object} client  Bolt's Slack WebClient
   * @param {string} slackUserId
   * @returns {Promise<{ name: string, email: string|null }>}
   */
  async _resolveSlackUser(client, slackUserId) {
    try {
      const result = await client.users.info({ user: slackUserId });
      const profile = result.user && result.user.profile;
      return {
        name: (profile && (profile.real_name || profile.display_name)) || slackUserId,
        email: (profile && profile.email) || null,
      };
    } catch {
      return { name: slackUserId, email: null };
    }
  }

  /**
   * Post an attribution comment on a Jira issue after an automated update.
   * Non-fatal: errors are swallowed — the caller should log them if needed.
   *
   * @param {object} client         Bolt's Slack WebClient
   * @param {string} slackUserId    Slack user who triggered the action
   * @param {string} issueKey       Jira issue key
   * @param {string} fieldId        Field that was updated
   * @param {string} fieldValue     Value it was set to
   * @param {string} trigger        Human-readable trigger ('👍 reaction' | 'thread reply')
   * @param {string} integrationName
   */
  async postAttributionComment(client, slackUserId, issueKey, fieldId, fieldValue, trigger, integrationName) {
    const { name, email } = await this._resolveSlackUser(client, slackUserId);

    // Try to find their Jira account by email for a proper @-mention
    let actorDisplay = name;
    if (email) {
      const accountId = await this.jiraService.findUserByEmail(email);
      if (accountId) {
        actorDisplay = `[~accountId:${accountId}]`;
      } else {
        actorDisplay = `${name} (${email})`;
      }
    }

    const text =
      `Automated update via Slack integration "${integrationName}"\n` +
      `Triggered by: ${actorDisplay} via ${trigger}\n` +
      `Field "${fieldId}" set to "${fieldValue}"`;

    try {
      await this.jiraService.addComment(issueKey, text);
    } catch (err) {
      const detail = err.response ? `HTTP ${err.response.status}` : err.message;
      // Log but don't rethrow — the field update already succeeded
      logger.error(`[attribution] Failed to post comment on ${issueKey}: ${detail}`);
    }
  }
}

module.exports = AttributionService;
