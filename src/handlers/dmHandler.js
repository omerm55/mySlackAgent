'use strict';

/**
 * Handles interactive button responses to bot-initiated DM questions.
 *
 * Three actions:
 *  - jira_confirm_yes   → update Jira immediately (Quick Yes)
 *  - jira_confirm_no    → no action (Quick No)
 *  - jira_reply         → open a modal for free-text reply; LLM interprets it
 *
 * @param {import('@slack/bolt').App} app
 * @param {import('../services/jiraService')} jiraService
 * @param {object} services
 * @param {import('../services/oauthService')} [services.oauthService]
 * @param {import('../services/llmService')} [services.llmService]
 */
function registerDmHandler(app, jiraService, services) {

  // ── helpers ──────────────────────────────────────────────────────────────

  async function resolveJira(slackUserId) {
    const { oauthService } = services;
    if (oauthService && slackUserId && oauthService.hasToken(slackUserId)) {
      try { return await oauthService.getJiraService(slackUserId); } catch { /* fall through */ }
    }
    return jiraService;
  }

  async function replaceButtons(client, channelId, messageTs, originalText, newText) {
    await client.chat.update({
      channel: channelId,
      ts: messageTs,
      text: newText,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: originalText } },
        { type: 'section', text: { type: 'mrkdwn', text: newText } },
      ],
    }).catch(() => {});
  }

  // ── Quick Yes ─────────────────────────────────────────────────────────────

  app.action('jira_confirm_yes', async ({ ack, body, client, logger }) => {
    await ack();
    let context;
    try { context = JSON.parse(body.actions[0].value); } catch {
      logger.error('[dm] Could not parse button context');
      return;
    }

    const { issueKey, jiraFieldId, jiraFieldName, jiraFieldValue, jiraFieldType, slackUserId } = context;
    const channelId = body.channel?.id;
    const messageTs = body.message?.ts;
    const originalText = body.message?.text || '';

    if (channelId && messageTs) {
      await replaceButtons(client, channelId, messageTs, originalText, '_Processing…_');
    }

    try {
      const effectiveJira = await resolveJira(slackUserId);
      await effectiveJira.updateIssueField(issueKey, jiraFieldId, jiraFieldValue, jiraFieldType || 'select');
      logger.info(`[dm] Updated ${issueKey} ${jiraFieldId}=${jiraFieldValue} ✓`);
      if (channelId && messageTs) {
        await replaceButtons(client, channelId, messageTs, originalText,
          `✅ Done — *${issueKey}* updated: *${jiraFieldName}* = *${jiraFieldValue}*`);
      }
    } catch (err) {
      logger.error(`[dm] Failed to update ${issueKey}: ${err.message}`);
      if (channelId && messageTs) {
        await replaceButtons(client, channelId, messageTs, originalText,
          `❌ Failed to update *${issueKey}*: ${err.message}`);
      }
    }
  });

  // ── Quick No ─────────────────────────────────────────────────────────────

  app.action('jira_confirm_no', async ({ ack, body, client, logger }) => {
    await ack();
    let context;
    try { context = JSON.parse(body.actions[0].value); } catch {
      logger.error('[dm] Could not parse button context');
      return;
    }

    const { issueKey } = context;
    const channelId = body.channel?.id;
    const messageTs = body.message?.ts;
    const originalText = body.message?.text || '';

    logger.info(`[dm] User declined update for ${issueKey}`);
    if (channelId && messageTs) {
      await replaceButtons(client, channelId, messageTs, originalText,
        `OK, no changes made to *${issueKey}*.`);
    }
  });

  // ── Reply → open modal ────────────────────────────────────────────────────

  app.action('jira_reply', async ({ ack, body, client, logger }) => {
    await ack();
    let context;
    try { context = JSON.parse(body.actions[0].value); } catch {
      logger.error('[dm] Could not parse button context for Reply');
      return;
    }

    // Embed channel + message ts so the view handler can update the original msg
    const metadata = JSON.stringify({
      ...context,
      dmChannelId: body.channel?.id,
      messageTs: body.message?.ts,
      originalText: body.message?.text || '',
    });

    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'jira_response_modal',
        private_metadata: metadata,
        title: { type: 'plain_text', text: 'Reply to Jira Bot' },
        submit: { type: 'plain_text', text: 'Send' },
        close: { type: 'plain_text', text: 'Cancel' },
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*${context.issueKey}*: ${context.question || `Set *${context.jiraFieldName}* to *${context.jiraFieldValue}*?`}`,
            },
          },
          {
            type: 'input',
            block_id: 'response_block',
            label: { type: 'plain_text', text: 'Your response' },
            element: {
              type: 'plain_text_input',
              action_id: 'response_input',
              multiline: true,
              placeholder: { type: 'plain_text', text: 'Type your answer — e.g. "Yes", "Not yet, waiting on QA", "Yes but set it to Needs Review instead"…' },
            },
          },
        ],
      },
    });
  });

  // ── Modal submitted → LLM interprets → execute ────────────────────────────

  app.view('jira_response_modal', async ({ ack, body, view, client, logger }) => {
    await ack(); // closes the modal immediately

    let context;
    try { context = JSON.parse(view.private_metadata); } catch {
      logger.error('[dm] Could not parse modal metadata');
      return;
    }

    const userText = view.state.values.response_block?.response_input?.value?.trim() || '';
    const { issueKey, jiraFieldId, jiraFieldName, jiraFieldValue, jiraFieldType,
            slackUserId, dmChannelId, messageTs, originalText = '' } = context;

    const { llmService } = services;
    if (!llmService) {
      if (dmChannelId && messageTs) {
        await replaceButtons(client, dmChannelId, messageTs, originalText,
          '⚠️ AI interpretation is not configured (ANTHROPIC_API_KEY missing). Please use the Yes/No buttons.');
      }
      return;
    }

    // Show "thinking" state while the LLM runs
    if (dmChannelId && messageTs) {
      await replaceButtons(client, dmChannelId, messageTs, originalText, '_Thinking…_');
    }

    let decision;
    try {
      decision = await llmService.interpretJiraResponse({
        issueKey, question: context.question, jiraFieldId, jiraFieldName, jiraFieldValue, jiraFieldType, userText,
      });
      logger.info({ issueKey, action: decision.action, userText }, '[dm] LLM decision');
    } catch (err) {
      logger.error(`[dm] LLM error: ${err.message}`);
      if (dmChannelId && messageTs) {
        await replaceButtons(client, dmChannelId, messageTs, originalText,
          `❌ AI failed to interpret your response: ${err.message}`);
      }
      return;
    }

    const effectiveJira = await resolveJira(slackUserId);

    try {
      if (decision.action === 'update_field') {
        const finalValue = decision.fieldValue ?? jiraFieldValue;
        await effectiveJira.updateIssueField(issueKey, jiraFieldId, finalValue, jiraFieldType || 'select');
        logger.info(`[dm] LLM-driven update ${issueKey} ${jiraFieldId}=${finalValue} ✓`);
      }

      if (decision.comment) {
        await effectiveJira.addComment(issueKey, decision.comment);
        logger.info(`[dm] LLM-driven comment added to ${issueKey}`);
      }

      if (decision.assignee) {
        const accountId = await effectiveJira.findUser(decision.assignee);
        if (accountId) {
          await effectiveJira.assignIssue(issueKey, accountId);
          logger.info(`[dm] Assigned ${issueKey} to "${decision.assignee}" (${accountId}) ✓`);
        } else {
          logger.warn(`[dm] Could not find Jira user matching "${decision.assignee}"`);
        }
      }

      const didSomething = decision.action !== 'no_action' || decision.comment || decision.assignee;
      const confirmation = decision.confirmationMessage || (didSomething ? `✅ Done — *${issueKey}* updated.` : 'OK, no changes made.');
      if (dmChannelId && messageTs) {
        await replaceButtons(client, dmChannelId, messageTs, originalText,
          didSomething ? `✅ ${confirmation}` : confirmation);
      }
    } catch (err) {
      logger.error(`[dm] LLM-driven action failed for ${issueKey}: ${err.message}`);
      if (dmChannelId && messageTs) {
        await replaceButtons(client, dmChannelId, messageTs, originalText,
          `❌ Failed: ${err.message}`);
      }
    }
  });
}

module.exports = { registerDmHandler };
