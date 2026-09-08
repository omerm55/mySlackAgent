'use strict';

const { issueLink } = require('../utils/jiraLink');
const { suggestFixVersion } = require('../services/fixVersionSuggester');

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

  async function resolveJira(slackUserId, client) {
    const { oauthService } = services;
    if (!oauthService || !slackUserId) return jiraService;
    if (oauthService.hasToken(slackUserId)) {
      try { return await oauthService.getJiraService(slackUserId); } catch { /* fall through */ }
    } else if (client) {
      // First time — DM the user an auth link (fire and forget)
      const authUrl = oauthService.generateAuthUrl(slackUserId);
      client.chat.postMessage({
        channel: slackUserId,
        text: `👋 To make your Jira changes appear as *you* (not the bot), <${authUrl}|connect your Jira account>. This change was made by the bot account.`,
      }).catch(() => {});
    }
    return jiraService;
  }

  async function replaceButtons(client, channelId, messageTs, originalText, newText, extraBlocks = []) {
    await client.chat.update({
      channel: channelId,
      ts: messageTs,
      text: newText,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: originalText } },
        { type: 'section', text: { type: 'mrkdwn', text: newText } },
        ...extraBlocks,
      ],
    }).catch(() => {});
  }

  const needsFixVersion = (err) => /fix\s*version/i.test(err?.message || '');

  /**
   * Jira refused a transition for lack of a Fix Version. Look at the epic's
   * children, suggest one (LLM-assisted), and rewrite the DM with:
   *   [✅ Use <version> & retry]  [🏷 Choose another…]
   * Falls back to just the picker when nothing can be suggested.
   */
  async function offerFixVersion(client, context, channelId, messageTs, originalText, logger) {
    const { issueKey, transitionTo } = context;
    const target = transitionTo || 'the next status';
    await replaceButtons(client, channelId, messageTs, originalText,
      `⚠️ Jira needs a *Fix Version* on *${issueLink(issueKey)}* before it can move to *${target}*.\n_Looking at its child issues for a suggestion…_`);

    let suggestion = null;
    try {
      suggestion = await suggestFixVersion({ jira: jiraService, llm: services.llmService, issueKey, logger });
    } catch (err) {
      logger.warn(`[dm] Fix Version suggestion failed for ${issueKey}: ${err.message}`);
    }

    const baseCtx = { ...context, dmChannelId: channelId, messageTs, originalText: (originalText || '').slice(0, 600) };
    const buttons = [];
    let text = `⚠️ Jira needs a *Fix Version* on *${issueLink(issueKey)}* before it can move to *${target}*.`;

    if (suggestion?.pick) {
      const { pick, reason, children, usedLlm } = suggestion;
      text += `\n💡 Suggested: *${pick.name}*${pick.released ? ' _(already released)_' : ''} — ${reason}.`;
      text += `\n_Based on ${children.length} child issue(s)${usedLlm ? ', chosen by AI' : ''}._`;
      buttons.push({
        type: 'button',
        style: 'primary',
        text: { type: 'plain_text', text: `✅ Use ${pick.name} & retry`.slice(0, 75), emoji: true },
        action_id: 'jira_fixversion_apply',
        value: JSON.stringify({ ...baseCtx, versionId: pick.id, versionName: pick.name }),
      });
    } else if (suggestion && suggestion.children.length === 0) {
      text += '\n_No child issues found to base a suggestion on._';
    } else {
      text += '\n_The child issues don\'t point to a single version._';
    }

    buttons.push({
      type: 'button',
      text: { type: 'plain_text', text: suggestion?.pick ? '🏷 Choose another…' : '🏷 Choose a version', emoji: true },
      action_id: 'jira_set_fixversion',
      value: JSON.stringify({ ...baseCtx, suggestedId: suggestion?.pick?.id ?? null }),
    });

    await replaceButtons(client, channelId, messageTs, originalText, text, [{ type: 'actions', elements: buttons }]);
  }

  /** Set fixVersions on the issue, then apply the originally proposed action. Updates the DM. */
  async function applyFixVersionAndRetry(client, context, versionId, versionName, logger) {
    const { issueKey, transitionTo, jiraFieldId, jiraFieldValue, jiraFieldType, jiraFieldName,
            slackUserId, dmChannelId, messageTs, originalText = '' } = context;

    if (dmChannelId && messageTs) {
      await replaceButtons(client, dmChannelId, messageTs, originalText, `_Setting Fix Version to *${versionName}* and retrying…_`);
    }

    const fieldName = transitionTo ? 'status' : jiraFieldName;
    const fieldValue = transitionTo || jiraFieldValue;
    try {
      const { oauthService } = services;
      const usingOAuth = oauthService?.hasToken(slackUserId) ?? false;
      const jira = await resolveJira(slackUserId, client);
      await jira.updateIssueField(issueKey, 'fixVersions', [{ id: versionId }], 'raw');
      if (transitionTo) {
        await jira.transitionIssue(issueKey, transitionTo);
      } else {
        await jira.updateIssueField(issueKey, jiraFieldId, jiraFieldValue, jiraFieldType || 'select');
      }
      logger.info(`[dm] Set Fix Version "${versionName}" and applied ${fieldName}=${fieldValue} on ${issueKey} ✓`);
      if (dmChannelId && messageTs) {
        await replaceButtons(client, dmChannelId, messageTs, originalText,
          transitionTo
            ? `✅ Done — Fix Version set to *${versionName}*, *${issueLink(issueKey)}* moved to *${transitionTo}*`
            : `✅ Done — Fix Version set to *${versionName}*, *${issueLink(issueKey)}* updated: *${jiraFieldName}* = *${jiraFieldValue}*`);
      }
      await services.opsNotifier?.dmButtonClicked({ action: 'yes', slackUserId, issueKey, fieldName, fieldValue: `${fieldValue} (fixVersion: ${versionName})`, usingOAuth });
    } catch (err) {
      logger.error(`[dm] Fix Version retry failed for ${issueKey}: ${err.message}`);
      if (dmChannelId && messageTs) {
        await replaceButtons(client, dmChannelId, messageTs, originalText,
          `❌ Still failed on *${issueLink(issueKey)}*: ${err.message}\n_I'll ask again on the next check if it still applies._`);
      }
      await services.db?.deletePromptsForIssue(issueKey, slackUserId).catch(() => {});
      await services.opsNotifier?.dmButtonClicked({ action: 'yes', slackUserId, issueKey, fieldName, fieldValue, error: err.message });
    }
  }

  // ── Quick Yes ─────────────────────────────────────────────────────────────

  app.action('jira_confirm_yes', async ({ ack, body, client, logger }) => {
    await ack();
    let context;
    try { context = JSON.parse(body.actions[0].value); } catch {
      logger.error('[dm] Could not parse button context');
      return;
    }

    const { issueKey, jiraFieldId, jiraFieldName, jiraFieldValue, jiraFieldType, transitionTo, slackUserId } = context;
    const channelId = body.channel?.id;
    const messageTs = body.message?.ts;
    const originalText = body.message?.text || '';

    // For ops/audit reporting, a transition is reported as status=<target>
    const fieldName = transitionTo ? 'status' : jiraFieldName;
    const fieldValue = transitionTo || jiraFieldValue;

    if (channelId && messageTs) {
      await replaceButtons(client, channelId, messageTs, originalText, '_Processing…_');
    }

    try {
      const { oauthService } = services;
      const usingOAuth = oauthService?.hasToken(slackUserId) ?? false;
      const effectiveJira = await resolveJira(slackUserId, client);
      if (transitionTo) {
        await effectiveJira.transitionIssue(issueKey, transitionTo);
        logger.info(`[dm] Transitioned ${issueKey} → ${transitionTo} ✓`);
      } else {
        await effectiveJira.updateIssueField(issueKey, jiraFieldId, jiraFieldValue, jiraFieldType || 'select');
        logger.info(`[dm] Updated ${issueKey} ${jiraFieldId}=${jiraFieldValue} ✓`);
      }
      if (channelId && messageTs) {
        await replaceButtons(client, channelId, messageTs, originalText,
          transitionTo
            ? `✅ Done — *${issueLink(issueKey)}* moved to *${transitionTo}*`
            : `✅ Done — *${issueLink(issueKey)}* updated: *${jiraFieldName}* = *${jiraFieldValue}*`);
      }
      await services.opsNotifier?.dmButtonClicked({ action: 'yes', slackUserId, issueKey, fieldName, fieldValue, usingOAuth });
    } catch (err) {
      logger.error(`[dm] Failed to update ${issueKey}: ${err.message}`);
      if (needsFixVersion(err) && channelId && messageTs) {
        // Jira wants a Fix Version before this transition — suggest one from the children and offer a retry.
        await offerFixVersion(client, context, channelId, messageTs, originalText, logger);
      } else {
        if (channelId && messageTs) {
          await replaceButtons(client, channelId, messageTs, originalText,
            `❌ Failed to update *${issueLink(issueKey)}*: ${err.message}\n_I'll ask again on the next check if it still applies._`);
        }
        // Let the Jira poller re-ask about this issue instead of treating it as handled
        await services.db?.deletePromptsForIssue(issueKey, slackUserId).catch(() => {});
      }
      await services.opsNotifier?.dmButtonClicked({ action: 'yes', slackUserId, issueKey, fieldName, fieldValue, error: err.message });
    }
  });

  // ── Fix Version: one-click apply of the suggestion ────────────────────────

  app.action('jira_fixversion_apply', async ({ ack, body, client, logger }) => {
    await ack();
    let context;
    try { context = JSON.parse(body.actions[0].value); } catch {
      logger.error('[dm] Could not parse Fix Version apply context');
      return;
    }
    const { versionId, versionName, ...rest } = context;
    await applyFixVersionAndRetry(client, rest, versionId, versionName, logger);
  });

  // ── Fix Version: manual picker (preselects the suggestion when there is one) ──

  app.action('jira_set_fixversion', async ({ ack, body, client, logger }) => {
    await ack();
    let context;
    try { context = JSON.parse(body.actions[0].value); } catch {
      logger.error('[dm] Could not parse Fix Version button context');
      return;
    }
    const { issueKey, slackUserId, suggestedId } = context;
    const projectKey = issueKey.split('-')[0];

    try {
      const jira = await resolveJira(slackUserId, client);
      const versions = (await jira.getProjectVersions(projectKey))
        .filter((v) => !v.archived)
        .sort((a, b) => {
          if (a.released !== b.released) return a.released ? 1 : -1;
          return (b.releaseDate || '').localeCompare(a.releaseDate || '') || b.name.localeCompare(a.name);
        })
        .slice(0, 100);

      if (versions.length === 0) {
        await client.chat.postMessage({ channel: slackUserId, text: `😕 No versions found in project *${projectKey}*. Please set the Fix Version in Jira: ${issueLink(issueKey)}` });
        return;
      }

      const options = versions.map((v) => ({
        text: { type: 'plain_text', text: `${v.name}${v.releaseDate ? `  (${v.releaseDate})` : ''}${v.released ? '  ✓ released' : ''}`.slice(0, 75) },
        value: v.id,
      }));
      const initial = suggestedId ? options.find((o) => o.value === String(suggestedId)) : null;

      await client.views.open({
        trigger_id: body.trigger_id,
        view: {
          type: 'modal',
          callback_id: 'jira_fixversion_modal',
          private_metadata: JSON.stringify(context),
          title: { type: 'plain_text', text: 'Set Fix Version' },
          submit: { type: 'plain_text', text: 'Set & retry' },
          close: { type: 'plain_text', text: 'Cancel' },
          blocks: [
            { type: 'section', text: { type: 'mrkdwn', text: `*${issueLink(issueKey)}* needs a Fix Version before moving to *${context.transitionTo || 'the next status'}*.` } },
            {
              type: 'input',
              block_id: 'fv_block',
              label: { type: 'plain_text', text: 'Fix Version' },
              element: {
                type: 'static_select',
                action_id: 'fv',
                placeholder: { type: 'plain_text', text: 'Choose a version' },
                options,
                ...(initial ? { initial_option: initial } : {}),
              },
              ...(initial ? { hint: { type: 'plain_text', text: 'Preselected: the version suggested from the epic\'s child issues.' } } : {}),
            },
          ],
        },
      });
    } catch (err) {
      logger.error(`[dm] Fix Version picker failed for ${issueKey}: ${err.message}`);
      await client.chat.postMessage({ channel: slackUserId, text: `❌ Couldn't load versions for *${projectKey}*: ${err.message}` }).catch(() => {});
    }
  });

  app.view('jira_fixversion_modal', async ({ ack, view, client, logger }) => {
    await ack();
    let context;
    try { context = JSON.parse(view.private_metadata); } catch {
      logger.error('[dm] Could not parse Fix Version modal metadata');
      return;
    }
    const selected = view.state.values.fv_block?.fv?.selected_option;
    if (!selected) return;
    const versionName = selected.text.text.split('  (')[0].replace(/\s+✓ released$/, '');
    await applyFixVersionAndRetry(client, context, selected.value, versionName, logger);
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
        `OK, no changes made to *${issueLink(issueKey)}*.`);
    }
    await services.opsNotifier?.dmButtonClicked({ action: 'no', slackUserId: context.slackUserId, issueKey });
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
              text: `*${context.issueKey}*: ${context.question || (context.transitionTo
                ? `Move to *${context.transitionTo}*?`
                : `Set *${context.jiraFieldName}* to *${context.jiraFieldValue}*?`)}`,
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
    const { issueKey, jiraFieldId, jiraFieldName, jiraFieldValue, jiraFieldType, transitionTo,
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
        issueKey, question: context.question, jiraFieldId, jiraFieldName, jiraFieldValue, jiraFieldType, transitionTo, userText,
      });
      logger.info({ issueKey, action: decision.action, userText }, '[dm] LLM decision');
    } catch (err) {
      logger.error(`[dm] LLM error: ${err.message}`);
      if (dmChannelId && messageTs) {
        await replaceButtons(client, dmChannelId, messageTs, originalText,
          `❌ AI failed to interpret your response: ${err.message}`);
      }
      await services.opsNotifier?.dmLlmDecision({ slackUserId, issueKey, userText, decision: {}, error: err.message });
      return;
    }

    const effectiveJira = await resolveJira(slackUserId, client);

    try {
      if (decision.action === 'transition') {
        const target = decision.transitionTo || transitionTo;
        await effectiveJira.transitionIssue(issueKey, target);
        logger.info(`[dm] LLM-driven transition ${issueKey} → ${target} ✓`);
      } else if (decision.action === 'update_field') {
        if (transitionTo && !jiraFieldId) {
          // Proposed action was a transition but LLM chose update_field — treat as approval
          await effectiveJira.transitionIssue(issueKey, transitionTo);
          logger.info(`[dm] LLM approved transition ${issueKey} → ${transitionTo} ✓`);
        } else {
          const finalValue = decision.fieldValue ?? jiraFieldValue;
          await effectiveJira.updateIssueField(issueKey, jiraFieldId, finalValue, jiraFieldType || 'select');
          logger.info(`[dm] LLM-driven update ${issueKey} ${jiraFieldId}=${finalValue} ✓`);
        }
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
      const confirmation = decision.confirmationMessage || (didSomething ? `Done — *${issueLink(issueKey)}* updated.` : 'OK, no changes made.');
      if (dmChannelId && messageTs) {
        await replaceButtons(client, dmChannelId, messageTs, originalText,
          didSomething ? `✅ ${confirmation} (${issueLink(issueKey)})` : confirmation);
      }
      await services.opsNotifier?.dmLlmDecision({ slackUserId, issueKey, userText, decision });
    } catch (err) {
      logger.error(`[dm] LLM-driven action failed for ${issueKey}: ${err.message}`);
      if (needsFixVersion(err) && dmChannelId && messageTs) {
        const target = decision.transitionTo || transitionTo;
        await offerFixVersion(client, { ...context, transitionTo: target }, dmChannelId, messageTs, originalText, logger);
      } else {
        if (dmChannelId && messageTs) {
          await replaceButtons(client, dmChannelId, messageTs, originalText,
            `❌ Failed on *${issueLink(issueKey)}*: ${err.message}\n_I'll ask again on the next check if it still applies._`);
        }
        await services.db?.deletePromptsForIssue(issueKey, slackUserId).catch(() => {});
      }
    }
  });
}

module.exports = { registerDmHandler };
