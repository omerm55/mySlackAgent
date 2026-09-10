'use strict';

/**
 * End-to-end-ish test of the Fix Version offer in dmHandler:
 * Yes → transition fails "Fix Version is required" → suggestion → offer rendered.
 * Guards the two failure modes that once left the DM stuck on a progress line.
 */
const { registerDmHandler } = require('../src/handlers/dmHandler');

function setup({ updateImpl } = {}) {
  const handlers = {};
  const app = {
    action: (id, fn) => { handlers[String(id)] = fn; },
    view: (id, fn) => { handlers[String(id)] = fn; },
  };
  const updates = [];
  const client = {
    chat: {
      update: jest.fn(async (p) => { updates.push(p); if (updateImpl) return updateImpl(p); return {}; }),
      postMessage: jest.fn().mockResolvedValue({}),
    },
    conversations: { open: jest.fn().mockResolvedValue({ channel: { id: 'D1' } }) },
  };
  const jira = {
    transitionIssue: jest.fn().mockRejectedValue(new Error('HTTP 400: A Fix Version is required')),
    getIssue: jest.fn().mockResolvedValue({ fields: { summary: 'E', status: { name: 'Acceptance' } } }),
    searchIssues: jest.fn().mockResolvedValue([]),
    getProjectVersions: jest.fn().mockResolvedValue([{ id: '40', name: '2026.4.0' }, { id: '32', name: '2026.3.2' }]),
    getStatusEnteredAt: jest.fn().mockResolvedValue(new Date('2026-08-12')),
  };
  const db = {
    getReleaseCalendar: jest.fn().mockResolvedValue([
      { version_name: '2026.3.2', branch_out: '2026-08-01', branch_out_end: '2026-08-31' },
      { version_name: '2026.4.0', branch_out: '2026-09-01', branch_out_end: '2026-09-30' },
    ]),
    deletePromptsForIssue: jest.fn().mockResolvedValue(undefined),
  };
  registerDmHandler(app, jira, { db, llmService: null, oauthService: null });
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const clickYes = () => handlers.jira_confirm_yes({
    ack: jest.fn(),
    body: {
      actions: [{ value: JSON.stringify({ issueKey: 'SNS-1', transitionTo: 'Done', slackUserId: 'U1', question: 'q' }) }],
      channel: { id: 'D1' }, message: { ts: '1', text: 'orig' },
    },
    client, logger,
  });
  const actionIds = (p) => (p.blocks || []).filter((b) => b.type === 'actions').flatMap((b) => b.elements.map((e) => e.action_id));
  return { handlers, client, updates, clickYes, actionIds, db };
}

describe('Fix Version offer', () => {
  test('renders suggested + alternative + picker with unique action_ids', async () => {
    const { updates, clickYes, actionIds } = setup();
    await clickYes();
    const last = updates[updates.length - 1];
    const ids = actionIds(last);
    expect(ids).toEqual(['jira_fixversion_apply', 'jira_fixversion_apply_alt', 'jira_set_fixversion']);
    expect(new Set(ids).size).toBe(ids.length);
    expect(last.text).toMatch(/Suggested: \*2026\.3\.2\*/);
    expect(last.text).toMatch(/Alternative: \*2026\.4\.0\*/);
    expect(last.text).toMatch(/^ℹ️ One more thing/);
  });

  test('progress lines are posted while the suggestion runs (never a silent wait)', async () => {
    const { updates, clickYes } = setup();
    await clickYes();
    const texts = updates.map((u) => u.text);
    expect(texts.some((t) => /Looking for a suggestion/.test(t))).toBe(true);
    expect(texts.some((t) => /Checking child issues and project versions/.test(t))).toBe(true);
    expect(texts.some((t) => /Reading when the epic entered Acceptance/.test(t))).toBe(true);
  });

  test('if Slack rejects the offer, the DM falls back to the bare picker instead of staying stuck', async () => {
    const slackErr = Object.assign(new Error('An API error occurred: invalid_blocks'), {
      data: { error: 'invalid_blocks', response_metadata: { messages: ['[ERROR] duplicate action_id'] } },
    });
    // Reject the first multi-button update (the offer), accept everything else
    const { updates, clickYes, actionIds } = setup({
      updateImpl: (p) => { if (actionIds(p).length > 1) throw slackErr; return {}; },
    });
    await clickYes();
    const last = updates[updates.length - 1];
    expect(actionIds(last)).toEqual(['jira_set_fixversion']);
    expect(last.text).toMatch(/Pick a version manually/);
  });

  test('the alternative button is handled by the same apply handler', () => {
    const { handlers } = setup();
    const key = Object.keys(handlers).find((k) => k.startsWith('/^jira_fixversion_apply'));
    expect(key).toBeDefined();
    const re = new RegExp(key.slice(1, key.lastIndexOf('/')));
    expect(re.test('jira_fixversion_apply')).toBe(true);
    expect(re.test('jira_fixversion_apply_alt')).toBe(true);
    expect(re.test('jira_fixversion_apply_other')).toBe(false);
  });
});
