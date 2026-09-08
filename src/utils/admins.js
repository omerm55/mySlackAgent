'use strict';

const ADMIN_USER_IDS = new Set(
  (process.env.ADMIN_SLACK_USER_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
);

/** @param {string} slackUserId */
function isAdmin(slackUserId) {
  return ADMIN_USER_IDS.has(slackUserId);
}

/**
 * Whether a user may edit/delete a trigger-like row.
 * Creator or admin. `createdBy` may be null for static (env-configured) rows → never manageable.
 */
function canManage(createdBy, slackUserId) {
  return Boolean(createdBy) && (createdBy === slackUserId || isAdmin(slackUserId));
}

module.exports = { isAdmin, canManage };
