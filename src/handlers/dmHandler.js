'use strict';

const { issueLink } = require('../utils/jiraLink');
const { suggestFixVersion } = require('../services/fixVersionSuggester');
const riskReview = require('../utils/riskReviewMessage');
const collect = require('../utils/collectMessage');
const { logger: baseLogger } = require('../utils/logger');
const { withTimeout } = require('../utils/withTimeout');

// Each suggestion stage is capped at 5s inside the suggester; this is the
// belt-and-braces ceiling for the whole thing (4 sequential stage groups).
const SUGGESTION_STAGE_MS = 5_000;
const SUGGESTION_BUDGET_MS = SUGGESTION_STAGE_MS * 4 + 2_000;

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
    try {
      await client.chat.update({
        channel: channelId,
        ts: messageTs,
        text: newText,
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: originalText } },
          { type: 'section', text: { type: 'mrkdwn', text: newText } },
          ...extraBlocks,
        ],
      });
      return true;
    } catch (err) {
      // Don't swallow silently — a failed update leaves the user staring at a stale message.
      const detail = err.data?.error || err.message;
      const meta = err.data?.response_metadata?.messages?.join(' | ');
      baseLogger.error(`[dm] chat.update failed (${detail})${meta ? ` — ${meta}` : ''}`);
      return false;
    }
  }

  /** Per-user activity record (App Home "recent activity" + daily ops summary). Never throws. */
  async function record(client, entry) {
    try {
      const slackUserName = entry.slackUserId
        ? await services.userCache?.getName?.(client, entry.slackUserId).catch(() => null)
        : null;
      services.auditLog?.addEntry({ ts: Date.now(), integrationName: entry.integrationName || 'DM', success: true, slackUserName, ...entry });
    } catch { /* cosmetic */ }
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
    const intro = `ℹ️ One more thing before I can move *${issueLink(issueKey)}* to *${target}*: Jira needs a *Fix Version*.`;
    // Progress updates: the suggester calls this as each stage starts (≤5s apart)
    const onProgress = (label) => replaceButtons(client, channelId, messageTs, originalText, `${intro}\n_${label}_`);
    await onProgress('Looking for a suggestion…');

    const baseCtx = { ...context, dmChannelId: channelId, messageTs, originalText: (originalText || '').slice(0, 600) };
    const pickerButton = (suggestedId = null, label = '🏷 Choose a version') => ({
      type: 'button',
      text: { type: 'plain_text', text: label, emoji: true },
      action_id: 'jira_set_fixversion',
      value: JSON.stringify({ ...baseCtx, suggestedId }),
    });

    let suggestion = null;
    let suggestionNote = '';
    const started = Date.now();
    try {
      suggestion = await withTimeout(
        suggestFixVersion({
          jira: jiraService, llm: services.llmService, db: services.db, issueKey, logger,
          stageTimeoutMs: SUGGESTION_STAGE_MS, onProgress,
        }),
        SUGGESTION_BUDGET_MS,
        'Fix Version suggestion',
      );
      logger.info(`[dm] Fix Version suggestion for ${issueKey} took ${Date.now() - started}ms (pick: ${suggestion?.pick?.name || 'none'}, llm: ${suggestion?.usedLlm}, degraded: ${suggestion?.degraded?.length || 0})`);
    } catch (err) {
      logger.warn(`[dm] Fix Version suggestion failed for ${issueKey} after ${Date.now() - started}ms: ${err.message}`);
      suggestionNote = /timed out/.test(err.message)
        ? '\n_The suggestion took too long — pick a version manually._'
        : '\n_I couldn\'t compute a suggestion — pick a version manually._';
    }

    let rendered = false;
    try {
      rendered = await renderFixVersionOffer(client, channelId, messageTs, originalText, intro, suggestion, suggestionNote, baseCtx, pickerButton);
    } catch (err) {
      logger.error(`[dm] Rendering Fix Version offer failed for ${issueKey}: ${err.message}`);
    }
    if (!rendered) {
      // Never leave a progress message up: fall back to the bare picker.
      await replaceButtons(client, channelId, messageTs, originalText,
        `${intro}\n_Pick a version manually._`, [{ type: 'actions', elements: [pickerButton()] }]);
    }
  }

  async function renderFixVersionOffer(client, channelId, messageTs, originalText, intro, suggestion, suggestionNote, baseCtx, pickerButton) {
    const buttons = [];
    let text = intro + suggestionNote;

    if (suggestion?.pick) {
      const { pick, reason, alternative, children, usedLlm, acceptedAt, statusName } = suggestion;
      text += `\n💡 Suggested: *${pick.name}*${pick.released ? ' _(already released)_' : ''} — ${reason}.`;
      if (alternative) text += `\nAlternative: *${alternative.pick.name}* — ${alternative.reason}.`;
      const basis = [
        `${children.length} child issue(s)`,
        acceptedAt ? `entered ${statusName} ${new Date(acceptedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : null,
        usedLlm ? 'chosen by AI' : null,
      ].filter(Boolean).join(' · ');
      text += `\n_Based on ${basis}._`;
      buttons.push({
        type: 'button',
        style: 'primary',
        text: { type: 'plain_text', text: `✅ Use ${pick.name} & retry`.slice(0, 75), emoji: true },
        action_id: 'jira_fixversion_apply',
        value: JSON.stringify({ ...baseCtx, versionId: pick.id, versionName: pick.name }),
      });
      if (alternative) {
        buttons.push({
          type: 'button',
          text: { type: 'plain_text', text: `Use ${alternative.pick.name} instead`.slice(0, 75), emoji: true },
          // action_ids must be unique within an actions block — same handler via regex below
          action_id: 'jira_fixversion_apply_alt',
          value: JSON.stringify({ ...baseCtx, versionId: alternative.pick.id, versionName: alternative.pick.name }),
        });
      }
    } else if (suggestion && suggestion.children.length === 0 && !suggestion.acceptedAt) {
      text += '\n_I couldn\'t find child issues or a release calendar to base a suggestion on._';
    } else if (suggestion) {
      text += '\n_I couldn\'t narrow it down to one version._';
    }
    if (suggestion?.degraded?.length) {
      const what = suggestion.degraded.map((d) => d.split(':')[0]).join(', ');
      text += `\n_Some checks were skipped (${what}), so this may be partial._`;
    }

    buttons.push(pickerButton(suggestion?.pick?.id ?? null, suggestion?.pick ? '🏷 Choose another…' : '🏷 Choose a version'));

    return replaceButtons(client, channelId, messageTs, originalText, text, [{ type: 'actions', elements: buttons }]);
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
      await record(client, { slackUserId, issueKey, trigger: 'DM Yes', fieldName, fieldValue: `${fieldValue} (Fix Version ${versionName})` });
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

  // URL buttons still emit block_actions — ack them so Bolt doesn't log "no handler".
  app.action('dm_connect_jira', async ({ ack }) => { await ack(); });
  app.action('home_connect_jira', async ({ ack }) => { await ack(); });

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
      await record(client, { slackUserId, issueKey, trigger: 'DM Yes', fieldName, fieldValue });
    } catch (err) {
      logger.error(`[dm] Failed to update ${issueKey}: ${err.message}`);
      if (needsFixVersion(err) && channelId && messageTs) {
        // Jira wants a Fix Version before this transition — suggest one from the children and offer a retry.
        await offerFixVersion(client, context, channelId, messageTs, originalText, logger)
          .catch((e) => logger.error(`[dm] offerFixVersion failed for ${issueKey}: ${e.message}`));
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

  // ── Risk review (R&D Initiative Notifier → Dev owner) ─────────────────────
  //
  // Buttons: risk_set_status_* · risk_update_notes · risk_move_target · risk_handled
  // Modals:  risk_notes_modal · risk_target_modal
  // Every write goes through resolveJira (as the user via OAuth; bot fallback + nudge).

  function parseCtx(body, logger, what) {
    try { return JSON.parse(body.actions[0].value); } catch {
      logger.error(`[risk] Could not parse ${what} context`);
      return null;
    }
  }

  /** Echo a Dev owner's action to the FYI recipient (e.g. PM owner), if there is one. Never throws. */
  async function fyiFollowUp(client, ctx, text) {
    if (!ctx?.fyiSlackUserId) return;
    try {
      await client.chat.postMessage({ channel: ctx.fyiSlackUserId, text: `ℹ️ ${text}` });
    } catch (err) {
      baseLogger.warn(`[risk] FYI follow-up to ${ctx.fyiSlackUserId} failed: ${err.data?.error || err.message}`);
    }
  }

  async function riskFail(client, ctx, where, err, logger, action) {
    const { issueKey, slackUserId, dmChannelId, messageTs, originalText = '' } = ctx;
    logger.error(`[risk] ${action} failed for ${issueKey}: ${err.message}`);
    if (dmChannelId && messageTs) {
      await replaceButtons(client, dmChannelId, messageTs, originalText,
        `❌ ${where} on *${issueLink(issueKey)}*: ${err.message}\n_I'll ask again on the next check if it's still flagged._`);
    }
    await services.db?.deletePromptsForIssue(issueKey, slackUserId).catch(() => {});
    await services.opsNotifier?.riskReviewAction({ slackUserId, issueKey, action, error: err.message });
  }

  // Status buttons share one handler; the target status rides in the button value.
  app.action(/^risk_set_status_/, async ({ ack, body, client, logger }) => {
    await ack();
    const ctx = parseCtx(body, logger, 'risk status'); if (!ctx) return;
    const channelId = body.channel?.id; const messageTs = body.message?.ts; const originalText = body.message?.text || '';
    const { issueKey, slackUserId, status } = ctx;
    if (channelId && messageTs) await replaceButtons(client, channelId, messageTs, originalText, `_Moving to ${status}…_`);
    try {
      const usingOAuth = services.oauthService?.hasToken(slackUserId) ?? false;
      const jira = await resolveJira(slackUserId, client);
      await jira.transitionIssue(issueKey, status);
      logger.info(`[risk] ${issueKey} → ${status} by ${slackUserId} ✓`);
      const after = { ...ctx, risk: { ...ctx.risk, status } };
      if (channelId && messageTs) {
        await replaceButtons(client, channelId, messageTs, originalText,
          `✅ *${issueLink(issueKey)}* moved to *${status}*.\n_Want to add a line to Notes on what you're doing about it?_`,
          riskReview.afterStatusBlocks(after, slackUserId));
      }
      await services.db?.markPromptAnswered(issueKey, slackUserId).catch(() => {});
      await services.opsNotifier?.riskReviewAction({ slackUserId, issueKey, action: 'set status', detail: status, usingOAuth });
      await record(client, { slackUserId, issueKey, trigger: '🩺 risk review', fieldName: 'status', fieldValue: status });
      await fyiFollowUp(client, ctx, `<@${slackUserId}> set *${issueLink(issueKey)}* to *${status}*.`);
    } catch (err) {
      await riskFail(client, { ...ctx, dmChannelId: channelId, messageTs, originalText }, `Couldn't move to ${status}`, err, logger, 'set status');
    }
  });

  app.action('risk_update_notes', async ({ ack, body, client, logger }) => {
    await ack();
    const ctx = parseCtx(body, logger, 'notes'); if (!ctx) return;
    const metadata = JSON.stringify({ ...ctx, dmChannelId: body.channel?.id, messageTs: body.message?.ts, originalText: (body.message?.text || '').slice(0, 600) });
    // Show the current Notes so the author knows what they're adding to (quick read; skipped if slow)
    let currentNotes = '';
    try {
      const issue = await withTimeout(jiraService.getIssue(ctx.issueKey), 2_000, 'notes read');
      currentNotes = riskReview.notesPreview(issue?.fields?.[riskReview.FIELDS.NOTES]);
    } catch { /* cosmetic */ }
    try {
      await client.views.open({
        trigger_id: body.trigger_id,
        view: {
          type: 'modal', callback_id: 'risk_notes_modal', private_metadata: metadata,
          title: { type: 'plain_text', text: 'Update Notes' },
          submit: { type: 'plain_text', text: 'Save to Notes' },
          close: { type: 'plain_text', text: 'Cancel' },
          blocks: [
            { type: 'section', text: { type: 'mrkdwn', text: `*${issueLink(ctx.issueKey)}*${ctx.risk?.summary ? ` — ${ctx.risk.summary}` : ''}${ctx.risk?.notification ? `\n> ${ctx.risk.notification}` : ''}` } },
            riskReview.notesBlock(currentNotes),
            {
              type: 'input', block_id: 'note_block',
              label: { type: 'plain_text', text: 'What are you doing about it?' },
              element: { type: 'plain_text_input', action_id: 'note', multiline: true,
                placeholder: { type: 'plain_text', text: 'e.g. Waiting on the infra team for the new cluster; ETA next Tuesday, then two weeks of testing.' } },
              hint: { type: 'plain_text', text: 'Added as a dated line at the top of the Initiative\'s Notes. Existing notes are kept.' },
            },
          ],
        },
      });
    } catch (err) {
      logger.error(`[risk] Failed to open notes modal: ${err.message}`);
    }
  });

  app.view('risk_notes_modal', async ({ ack, body, view, client, logger }) => {
    await ack();
    let ctx; try { ctx = JSON.parse(view.private_metadata); } catch { logger.error('[risk] bad notes metadata'); return; }
    const { issueKey, slackUserId, dmChannelId, messageTs, originalText = '' } = ctx;
    const raw = view.state.values.note_block?.note?.value?.trim() || '';
    if (!raw) return;
    if (dmChannelId && messageTs) await replaceButtons(client, dmChannelId, messageTs, originalText, '_Saving to Notes…_');
    try {
      let note = raw;
      if (services.llmService) {
        try {
          const res = await services.llmService.tidyNote({ issueKey, summary: ctx.risk?.summary, notification: ctx.risk?.notification, userText: raw });
          if (res?.note && typeof res.note === 'string') note = res.note.trim();
        } catch (err) { logger.warn(`[risk] tidyNote failed, using raw text: ${err.message}`); }
      }
      const author = await services.userCache?.getName?.(client, slackUserId).catch(() => null);
      const usingOAuth = services.oauthService?.hasToken(slackUserId) ?? false;
      const jira = await resolveJira(slackUserId, client);
      const issue = await jira.getIssue(issueKey);
      const existing = issue?.fields?.[riskReview.FIELDS.NOTES] || '';
      const entry = riskReview.notesEntry(note, author);
      await jira.updateIssueField(issueKey, riskReview.FIELDS.NOTES, riskReview.prependNotes(existing, entry), 'text');
      logger.info(`[risk] Notes updated on ${issueKey} by ${slackUserId} ✓`);
      if (dmChannelId && messageTs) {
        await replaceButtons(client, dmChannelId, messageTs, originalText, `✅ Added to *${issueLink(issueKey)}* Notes:\n> ${entry}`);
      }
      await services.db?.markPromptAnswered(issueKey, slackUserId).catch(() => {});
      await services.opsNotifier?.riskReviewAction({ slackUserId, issueKey, action: 'updated Notes', detail: `"${note.slice(0, 140)}"`, usingOAuth });
      await record(client, { slackUserId, issueKey, trigger: '🩺 risk review', fieldName: 'Notes', fieldValue: note.slice(0, 80) });
      await fyiFollowUp(client, ctx, `<@${slackUserId}> updated Notes on *${issueLink(issueKey)}*:\n> ${entry}`);
    } catch (err) {
      await riskFail(client, ctx, "Couldn't update Notes", err, logger, 'update Notes');
    }
  });

  app.action('risk_move_target', async ({ ack, body, client, logger }) => {
    await ack();
    const ctx = parseCtx(body, logger, 'target'); if (!ctx) return;
    const metadata = JSON.stringify({ ...ctx, dmChannelId: body.channel?.id, messageTs: body.message?.ts, originalText: (body.message?.text || '').slice(0, 600) });
    const today = new Date().toISOString().slice(0, 10);
    try {
      await client.views.open({
        trigger_id: body.trigger_id,
        view: {
          type: 'modal', callback_id: 'risk_target_modal', private_metadata: metadata,
          title: { type: 'plain_text', text: 'Project target' },
          submit: { type: 'plain_text', text: 'Save' },
          close: { type: 'plain_text', text: 'Cancel' },
          blocks: [
            { type: 'section', text: { type: 'mrkdwn', text: `*${issueLink(ctx.issueKey)}* — current target: *${ctx.risk?.targetEnd || 'none'}*` } },
            {
              type: 'input', block_id: 'target_block', optional: true,
              label: { type: 'plain_text', text: 'New target date' },
              element: { type: 'datepicker', action_id: 'new_end', initial_date: ctx.risk?.targetEnd || today },
            },
            {
              type: 'input', block_id: 'clear_block', optional: true,
              label: { type: 'plain_text', text: 'Or' },
              element: { type: 'checkboxes', action_id: 'clear',
                options: [{ text: { type: 'plain_text', text: 'Clear the target (the work is not scheduled)' }, value: 'clear' }] },
            },
          ],
        },
      });
    } catch (err) {
      logger.error(`[risk] Failed to open target modal: ${err.message}`);
    }
  });

  app.view('risk_target_modal', async ({ ack, body, view, client, logger }) => {
    let ctx; try { ctx = JSON.parse(view.private_metadata); } catch { await ack(); logger.error('[risk] bad target metadata'); return; }
    const clear = (view.state.values.clear_block?.clear?.selected_options || []).some((o) => o.value === 'clear');
    const newEnd = view.state.values.target_block?.new_end?.selected_date || null;
    if (!clear && !newEnd) {
      await ack({ response_action: 'errors', errors: { target_block: 'Pick a new date or tick "Clear the target".' } });
      return;
    }
    await ack();
    const { issueKey, slackUserId, dmChannelId, messageTs, originalText = '' } = ctx;
    if (dmChannelId && messageTs) await replaceButtons(client, dmChannelId, messageTs, originalText, '_Updating the target…_');
    try {
      const usingOAuth = services.oauthService?.hasToken(slackUserId) ?? false;
      const jira = await resolveJira(slackUserId, client);
      let detail;
      if (clear) {
        await jira.updateIssueField(issueKey, riskReview.FIELDS.TARGET, null, 'raw');
        detail = 'target cleared';
      } else {
        const start = ctx.risk?.targetStart && ctx.risk.targetStart <= newEnd ? ctx.risk.targetStart : newEnd;
        await jira.updateIssueField(issueKey, riskReview.FIELDS.TARGET, JSON.stringify({ start, end: newEnd }), 'text');
        detail = `target → ${newEnd}`;
      }
      logger.info(`[risk] ${issueKey} ${detail} by ${slackUserId} ✓`);
      if (dmChannelId && messageTs) {
        await replaceButtons(client, dmChannelId, messageTs, originalText, `✅ *${issueLink(issueKey)}*: ${detail}.`);
      }
      await services.db?.markPromptAnswered(issueKey, slackUserId).catch(() => {});
      await services.opsNotifier?.riskReviewAction({ slackUserId, issueKey, action: 'target', detail, usingOAuth });
      await record(client, { slackUserId, issueKey, trigger: '🩺 risk review', fieldName: 'Project target', fieldValue: clear ? 'cleared' : newEnd });
      await fyiFollowUp(client, ctx, `<@${slackUserId}> changed the target of *${issueLink(issueKey)}*: ${detail}.`);
    } catch (err) {
      await riskFail(client, ctx, "Couldn't update the target", err, logger, 'move target');
    }
  });

  // "Skip" after a status change: finish without touching Notes.
  app.action('risk_skip_notes', async ({ ack, body, client, logger }) => {
    await ack();
    const ctx = parseCtx(body, logger, 'skip notes'); if (!ctx) return;
    const channelId = body.channel?.id; const messageTs = body.message?.ts; const originalText = body.message?.text || '';
    const { issueKey, slackUserId } = ctx;
    const status = ctx.risk?.status;
    if (channelId && messageTs) {
      await replaceButtons(client, channelId, messageTs, originalText,
        `✅ *${issueLink(issueKey)}*${status ? ` is *${status}*` : ''}. Notes left unchanged.`);
    }
    await services.opsNotifier?.riskReviewAction({ slackUserId, issueKey, action: 'skipped Notes update' });
    logger.info(`[risk] ${issueKey}: Notes update skipped by ${slackUserId}`);
  });

  app.action('risk_handled', async ({ ack, body, client, logger }) => {
    await ack();
    const ctx = parseCtx(body, logger, 'handled'); if (!ctx) return;
    const channelId = body.channel?.id; const messageTs = body.message?.ts; const originalText = body.message?.text || '';
    const { issueKey, slackUserId } = ctx;
    if (channelId && messageTs) {
      await replaceButtons(client, channelId, messageTs, originalText, `👍 Noted — no changes made to *${issueLink(issueKey)}*.`);
    }
    await services.db?.markPromptAnswered(issueKey, slackUserId).catch(() => {});
    await services.opsNotifier?.riskReviewAction({ slackUserId, issueKey, action: 'handled (no change)' });
    await record(client, { slackUserId, issueKey, trigger: '🩺 risk review', fieldName: 'acknowledged', fieldValue: 'no change' });
    await fyiFollowUp(client, ctx, `<@${slackUserId}> marked *${issueLink(issueKey)}* as handled — no change needed.`);
    logger.info(`[risk] ${issueKey} marked handled by ${slackUserId}`);
  });

  // ── Collect (free text → AI fills fields → preview → one save) ─────────────
  //
  // Buttons: collect_answer · collect_skip · collect_save · collect_edit · collect_cancel
  // Modal:   collect_modal
  // Every write goes through resolveJira (as the user via OAuth; bot fallback + nudge).

  const collectLoc = (body) => ({ dmChannelId: body.channel?.id, messageTs: body.message?.ts, originalText: (body.message?.text || '').slice(0, 600) });

  async function openCollectModal(client, body, ctx, values, freeText, logger) {
    try {
      await client.views.open({ trigger_id: body.trigger_id, view: collect.buildCollectModal(ctx, values, { freeText }) });
    } catch (err) {
      logger.error(`[collect] Failed to open modal for ${ctx.issueKey}: ${err.data?.error || err.message}`);
    }
  }

  async function collectFail(client, ctx, where, err, logger, action) {
    const { issueKey, slackUserId, dmChannelId, messageTs, originalText = '' } = ctx;
    logger.error(`[collect] ${action} failed for ${issueKey}: ${err.message}`);
    if (dmChannelId && messageTs) {
      await replaceButtons(client, dmChannelId, messageTs, originalText,
        `❌ ${where} on *${issueLink(issueKey)}*: ${err.message}\n_I'll ask again on the next check if it's still missing._`);
    }
    await services.db?.deletePromptsForIssue(issueKey, slackUserId).catch(() => {});
    await services.opsNotifier?.collectAction({ slackUserId, issueKey, action, error: err.message });
  }

  app.action('collect_answer', async ({ ack, body, client, logger }) => {
    await ack();
    const ctx = parseCtx(body, logger, 'collect answer'); if (!ctx) return;
    await openCollectModal(client, body, { ...ctx, ...collectLoc(body) }, {}, '', logger);
  });

  app.action('collect_edit', async ({ ack, body, client, logger }) => {
    await ack();
    const ctx = parseCtx(body, logger, 'collect edit'); if (!ctx) return;
    // Preview messages replaced the original; keep the location we already carry, else take this one
    const loc = ctx.dmChannelId && ctx.messageTs ? {} : collectLoc(body);
    await openCollectModal(client, body, { ...ctx, ...loc, values: undefined }, ctx.values || {}, ctx.freeText || '', logger);
  });

  app.view('collect_modal', async ({ ack, body, view, client, logger }) => {
    let ctx; try { ctx = JSON.parse(view.private_metadata); } catch { await ack(); logger.error('[collect] bad modal metadata'); return; }
    const fields = ctx.collect?.fields || [];
    const { freeText, explicit } = collect.readCollectModal(view, ctx);
    if (!freeText && !Object.keys(explicit).length) {
      await ack({ response_action: 'errors', errors: { free_text: 'Write something here, or fill in the fields below.' } });
      return;
    }
    await ack();
    const { issueKey, slackUserId, dmChannelId, messageTs, originalText = '' } = ctx;
    // Anything the free text needs to fill that wasn't typed explicitly?
    const needsLlm = freeText && fields.some((f) => !explicit[f.id]);
    if (needsLlm && dmChannelId && messageTs) await replaceButtons(client, dmChannelId, messageTs, originalText, '_Reading what you wrote…_');

    let extracted = {}; let note = null;
    if (needsLlm) {
      if (!services.llmService) {
        note = 'AI extraction is not configured — fill the fields directly.';
      } else {
        try {
          const res = await withTimeout(services.llmService.extractFields({ issueKey, summary: ctx.collect?.summary, fields, userText: freeText }), 15_000, 'field extraction');
          extracted = res?.values && typeof res.values === 'object' ? res.values : {};
          note = typeof res?.note === 'string' && res.note.trim() ? res.note.trim() : null;
          logger.info({ issueKey, extracted }, '[collect] LLM extraction');
        } catch (err) {
          logger.warn(`[collect] extractFields failed for ${issueKey}: ${err.message}`);
          note = "I couldn't read that automatically — fill the fields directly.";
        }
      }
    }
    const values = collect.mergeValues(fields, explicit, extracted);
    const previewCtx = { ...ctx, freeText: freeText.slice(0, 1000) };
    const { blocks, missing } = collect.previewBlocks(previewCtx, slackUserId, values, { note });
    if (dmChannelId && messageTs) {
      const ok = await replaceButtons(client, dmChannelId, messageTs, originalText,
        missing.length ? `ℹ️ Almost there — I still need *${missing.map((f) => f.name).join(', ')}*.` : '✅ Ready to save. Please check:', blocks);
      if (!ok) {
        // Never leave the progress line up
        await replaceButtons(client, dmChannelId, messageTs, originalText, `⚠️ I couldn't show the preview. Press *Answer* again to retry.`, [collect.buildCollectBlocks(ctx, slackUserId).pop()]);
      }
    }
  });

  app.action('collect_save', async ({ ack, body, client, logger }) => {
    await ack();
    const ctx = parseCtx(body, logger, 'collect save'); if (!ctx) return;
    const loc = ctx.dmChannelId && ctx.messageTs ? {} : collectLoc(body);
    const full = { ...ctx, ...loc };
    const { issueKey, slackUserId, dmChannelId, messageTs, originalText = '' } = full;
    const fields = ctx.collect?.fields || [];
    const values = ctx.values || {};
    const toWrite = Object.fromEntries(fields.filter((f) => values[f.id]).map((f) => [f.id, values[f.id]]));
    if (!Object.keys(toWrite).length) return;
    if (dmChannelId && messageTs) await replaceButtons(client, dmChannelId, messageTs, originalText, '_Saving to Jira…_');
    try {
      const usingOAuth = services.oauthService?.hasToken(slackUserId) ?? false;
      const jira = await resolveJira(slackUserId, client);
      await jira.updateIssueFields(issueKey, toWrite);
      logger.info(`[collect] ${issueKey} updated by ${slackUserId}: ${Object.keys(toWrite).join(', ')} ✓`);
      const lines = fields.filter((f) => toWrite[f.id]).map((f) => `• *${f.name}:* ${toWrite[f.id]}`).join('\n');
      if (dmChannelId && messageTs) {
        await replaceButtons(client, dmChannelId, messageTs, originalText, `✅ Saved to *${issueLink(issueKey)}*:\n${lines}`);
      }
      await services.db?.markPromptAnswered(issueKey, slackUserId).catch(() => {});
      const detail = fields.filter((f) => toWrite[f.id]).map((f) => `${f.name} = "${toWrite[f.id].slice(0, 80)}"`).join(' · ');
      await services.opsNotifier?.collectAction({ slackUserId, issueKey, action: 'saved', detail, usingOAuth });
      await record(client, { slackUserId, issueKey, trigger: '📝 collect', fieldName: fields.filter((f) => toWrite[f.id]).map((f) => f.name).join(', '), fieldValue: Object.values(toWrite).map((v) => v.slice(0, 40)).join(' / ') });
      await fyiFollowUp(client, ctx, `<@${slackUserId}> filled in *${issueLink(issueKey)}*:\n${lines}`);
    } catch (err) {
      await collectFail(client, full, "Couldn't save", err, logger, 'save');
    }
  });

  app.action('collect_cancel', async ({ ack, body, client, logger }) => {
    await ack();
    const ctx = parseCtx(body, logger, 'collect cancel'); if (!ctx) return;
    const loc = ctx.dmChannelId && ctx.messageTs ? { dmChannelId: ctx.dmChannelId, messageTs: ctx.messageTs } : collectLoc(body);
    const { issueKey, slackUserId } = ctx;
    // Nothing saved — put the original ask back so they can come back to it
    const fresh = { ...ctx, values: undefined, freeText: undefined, dmChannelId: undefined, messageTs: undefined, originalText: undefined };
    if (loc.dmChannelId && loc.messageTs) {
      try {
        await client.chat.update({ channel: loc.dmChannelId, ts: loc.messageTs, text: `📝 ${issueKey} needs: ${collect.describeCollectFields(ctx.collect?.fields)}`, blocks: collect.buildCollectBlocks(fresh, slackUserId) });
      } catch (err) { logger.warn(`[collect] cancel restore failed: ${err.data?.error || err.message}`); }
    }
    await services.opsNotifier?.collectAction({ slackUserId, issueKey, action: 'cancelled the preview (nothing saved)' });
  });

  app.action('collect_skip', async ({ ack, body, client, logger }) => {
    await ack();
    const ctx = parseCtx(body, logger, 'collect skip'); if (!ctx) return;
    const { dmChannelId, messageTs, originalText } = collectLoc(body);
    const { issueKey, slackUserId } = ctx;
    if (dmChannelId && messageTs) {
      await replaceButtons(client, dmChannelId, messageTs, originalText, `👍 Skipped — *${issueLink(issueKey)}* left as is. I won't ask about it again unless the trigger is re-run.`);
    }
    await services.db?.markPromptAnswered(issueKey, slackUserId).catch(() => {});
    await services.opsNotifier?.collectAction({ slackUserId, issueKey, action: 'skipped' });
    await record(client, { slackUserId, issueKey, trigger: '📝 collect', fieldName: 'skipped', fieldValue: 'no change' });
    logger.info(`[collect] ${issueKey} skipped by ${slackUserId}`);
  });

  // ── Fix Version: one-click apply of the suggestion ────────────────────────

  // Matches both the suggested ("jira_fixversion_apply") and alternative ("…_alt") buttons
  app.action(/^jira_fixversion_apply(_alt)?$/, async ({ ack, body, client, logger }) => {
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
            { type: 'section', text: { type: 'mrkdwn', text: `ℹ️ *${issueLink(issueKey)}* needs a Fix Version before moving to *${context.transitionTo || 'the next status'}*.` } },
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
      if (didSomething) {
        const what = decision.action === 'transition' ? `status = ${decision.transitionTo || transitionTo}`
          : decision.action === 'update_field' ? `${jiraFieldName || 'status'} = ${decision.fieldValue ?? jiraFieldValue ?? transitionTo}`
            : decision.comment ? 'comment added' : decision.assignee ? `assigned to ${decision.assignee}` : 'updated';
        const [fieldName, ...rest] = what.split(' = ');
        await record(client, { slackUserId, issueKey, trigger: 'DM reply', fieldName, fieldValue: rest.join(' = ') || '✓' });
      }
    } catch (err) {
      logger.error(`[dm] LLM-driven action failed for ${issueKey}: ${err.message}`);
      if (needsFixVersion(err) && dmChannelId && messageTs) {
        const target = decision.transitionTo || transitionTo;
        await offerFixVersion(client, { ...context, transitionTo: target }, dmChannelId, messageTs, originalText, logger)
          .catch((e) => logger.error(`[dm] offerFixVersion failed for ${issueKey}: ${e.message}`));
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
