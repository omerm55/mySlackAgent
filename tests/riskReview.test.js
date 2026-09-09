'use strict';

const rr = require('../src/utils/riskReviewMessage');
const { registerDmHandler } = require('../src/handlers/dmHandler');

const NOTIF = 'Sep 8 — Overdue 5d; Progress red 12%/exp 50%. Action: flag at risk; update progress';

function ctxFor(status, extra = {}) {
  return {
    askType: 'risk_review', issueKey: 'PR-1234', question: '',
    risk: { notification: NOTIF, status, summary: 'Smart Alerts', targetStart: '2026-06-01', targetEnd: '2026-08-31' },
    ...extra,
  };
}
const actionIds = (blocks) => blocks.filter((b) => b.type === 'actions').flatMap((b) => b.elements.map((e) => e.action_id));

describe('riskReviewMessage helpers', () => {
  test('parseInterval handles JSON strings, objects and junk', () => {
    expect(rr.parseInterval('{"start":"2026-06-01","end":"2026-08-31"}')).toEqual({ start: '2026-06-01', end: '2026-08-31' });
    expect(rr.parseInterval({ start: '2026-06-01', end: null })).toEqual({ start: '2026-06-01', end: null });
    expect(rr.parseInterval('not json')).toBeNull();
    expect(rr.parseInterval(null)).toBeNull();
  });

  test('riskContextFor reads notification, status, summary and target from a searched issue', () => {
    const issue = { key: 'PR-1', fields: { summary: 'S', status: { name: 'On Track' }, [rr.FIELDS.NOTIFICATION]: ` ${NOTIF} `, [rr.FIELDS.TARGET]: '{"start":"2026-06-01","end":"2026-08-31"}' } };
    expect(rr.riskContextFor(issue)).toEqual({ notification: NOTIF, status: 'On Track', summary: 'S', targetStart: '2026-06-01', targetEnd: '2026-08-31', notes: '' });
  });

  test.each([
    ['On Track', ['Low Risk', 'High Risk', 'Off Track']],
    ['In discovery', ['Low Risk', 'High Risk', 'Off Track']],
    ['High Risk', ['On Track']],
    ['Off Track', ['On Track']],
    ['On hold', []],
  ])('statusChoices(%s) follows the notifier\'s already-at-risk / on-hold rules', (status, expected) => {
    expect(rr.statusChoices(status)).toEqual(expected);
  });

  test('blocks: On Track → three risk buttons + Notes/target/handled, all unique action_ids', () => {
    const blocks = rr.buildRiskReviewBlocks(ctxFor('On Track'), 'U1');
    const ids = actionIds(blocks);
    expect(ids).toEqual(['risk_set_status_low', 'risk_set_status_high', 'risk_set_status_off', 'risk_update_notes', 'risk_move_target', 'risk_handled']);
    expect(new Set(ids).size).toBe(ids.length);
    expect(JSON.stringify(blocks)).toContain(NOTIF);
    expect(JSON.stringify(blocks)).toContain('Target: *2026-08-31*');
    const val = JSON.parse(blocks.find((b) => b.type === 'actions').elements[1].value);
    expect(val).toMatchObject({ askType: 'risk_review', issueKey: 'PR-1234', slackUserId: 'U1', status: 'High Risk' });
    expect(val.risk.notification).toBe(NOTIF);
  });

  test('blocks: already High Risk → only "Back On Track"; On hold → no status buttons', () => {
    expect(actionIds(rr.buildRiskReviewBlocks(ctxFor('High Risk'), 'U1'))).toEqual(['risk_set_status_ontrack', 'risk_update_notes', 'risk_move_target', 'risk_handled']);
    expect(actionIds(rr.buildRiskReviewBlocks(ctxFor('On hold'), 'U1'))).toEqual(['risk_update_notes', 'risk_move_target', 'risk_handled']);
  });

  test('notesEntry / prependNotes keep history', () => {
    const entry = rr.notesEntry('Waiting on infra; ETA Tuesday.', 'Omer', new Date('2026-09-09T10:00:00Z'));
    expect(entry).toBe('2026-09-09 (Omer): Waiting on infra; ETA Tuesday.');
    expect(rr.prependNotes('old note', entry)).toBe(`${entry}\n\nold note`);
    expect(rr.prependNotes('', entry)).toBe(entry);
  });
});

describe('risk review handlers', () => {
  function setup({ llm = null, existingNotes = 'older note' } = {}) {
    const handlers = {};
    const app = {
      action: (id, fn) => { handlers[String(id)] = fn; },
      view: (id, fn) => { handlers[String(id)] = fn; },
    };
    const updates = [];
    const client = {
      chat: { update: jest.fn(async (p) => { updates.push(p); return {}; }), postMessage: jest.fn().mockResolvedValue({}) },
      views: { open: jest.fn().mockResolvedValue({}) },
      conversations: { open: jest.fn().mockResolvedValue({ channel: { id: 'D1' } }) },
    };
    const jira = {
      transitionIssue: jest.fn().mockResolvedValue(undefined),
      updateIssueField: jest.fn().mockResolvedValue(undefined),
      getIssue: jest.fn().mockResolvedValue({ fields: { [rr.FIELDS.NOTES]: existingNotes } }),
    };
    const db = { markPromptAnswered: jest.fn().mockResolvedValue(undefined), deletePromptsForIssue: jest.fn().mockResolvedValue(undefined) };
    const ops = { riskReviewAction: jest.fn().mockResolvedValue(undefined) };
    const userCache = { getName: jest.fn().mockResolvedValue('Omer') };
    registerDmHandler(app, jira, { db, llmService: llm, oauthService: null, opsNotifier: ops, userCache });
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const value = (extra) => JSON.stringify({ askType: 'risk_review', issueKey: 'PR-1234', slackUserId: 'U1', risk: ctxFor('On Track').risk, ...extra });
    const body = (extra) => ({ actions: [{ value: value(extra) }], channel: { id: 'D1' }, message: { ts: '1', text: 'orig' }, user: { id: 'U1' }, trigger_id: 'T' });
    return { handlers, client, jira, db, ops, updates, logger, value, body };
  }
  const statusHandler = (handlers) => handlers[Object.keys(handlers).find((k) => k.startsWith('/^risk_set_status_'))];

  test('status button → transitionIssue as the user, message shows ✅ and keeps only Update Notes', async () => {
    const { handlers, client, jira, db, ops, updates, logger, body } = setup();
    await statusHandler(handlers)({ ack: jest.fn(), body: body({ status: 'High Risk' }), client, logger });
    expect(jira.transitionIssue).toHaveBeenCalledWith('PR-1234', 'High Risk');
    const last = updates[updates.length - 1];
    expect(last.text).toMatch(/moved to \*High Risk\*/);
    expect(actionIds(last.blocks)).toEqual(['risk_update_notes', 'risk_skip_notes']);
    expect(db.markPromptAnswered).toHaveBeenCalledWith('PR-1234', 'U1');
    expect(ops.riskReviewAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'set status', detail: 'High Risk' }));
  });

  test('status failure → ❌ with Jira error and the prompt is cleared for re-ask', async () => {
    const { handlers, client, jira, db, updates, logger, body } = setup();
    jira.transitionIssue.mockRejectedValueOnce(new Error('HTTP 400: nope'));
    await statusHandler(handlers)({ ack: jest.fn(), body: body({ status: 'Off Track' }), client, logger });
    expect(updates[updates.length - 1].text).toMatch(/❌ Couldn't move to Off Track.*HTTP 400: nope/);
    expect(db.deletePromptsForIssue).toHaveBeenCalledWith('PR-1234', 'U1');
  });

  test('notes modal → tidied (LLM) dated line prepended to existing Notes, written as text', async () => {
    const llm = { tidyNote: jest.fn().mockResolvedValue({ note: 'Waiting on infra; ETA Tuesday.' }) };
    const { handlers, client, jira, updates, logger, value } = setup({ llm });
    await handlers.risk_notes_modal({
      ack: jest.fn(), body: { user: { id: 'U1' } }, client, logger,
      view: { private_metadata: value({ dmChannelId: 'D1', messageTs: '1', originalText: 'orig' }), state: { values: { note_block: { note: { value: 'waitng on infra, eta tuesday' } } } } },
    });
    expect(llm.tidyNote).toHaveBeenCalledWith(expect.objectContaining({ issueKey: 'PR-1234', userText: 'waitng on infra, eta tuesday' }));
    const [key, field, val, type] = jira.updateIssueField.mock.calls[0];
    expect([key, field, type]).toEqual(['PR-1234', rr.FIELDS.NOTES, 'text']);
    expect(val).toMatch(/^\d{4}-\d{2}-\d{2} \(Omer\): Waiting on infra; ETA Tuesday\.\n\nolder note$/);
    expect(updates[updates.length - 1].text).toMatch(/✅ Added to .*Notes/);
  });

  test('notes modal → LLM failure falls back to the raw text', async () => {
    const llm = { tidyNote: jest.fn().mockRejectedValue(new Error('llm down')) };
    const { handlers, client, jira, logger, value } = setup({ llm, existingNotes: '' });
    await handlers.risk_notes_modal({
      ack: jest.fn(), body: { user: { id: 'U1' } }, client, logger,
      view: { private_metadata: value({}), state: { values: { note_block: { note: { value: 'raw text' } } } } },
    });
    expect(jira.updateIssueField.mock.calls[0][2]).toMatch(/\(Omer\): raw text$/);
  });

  test('target modal → new end keeps the existing start; clear → raw null; neither → inline error', async () => {
    const { handlers, client, jira, logger, value } = setup();
    const submit = (values) => handlers.risk_target_modal({
      ack: jest.fn(), body: { user: { id: 'U1' } }, client, logger,
      view: { private_metadata: value({}), state: { values } },
    });
    await submit({ target_block: { new_end: { selected_date: '2026-10-15' } } });
    expect(jira.updateIssueField).toHaveBeenLastCalledWith('PR-1234', rr.FIELDS.TARGET, JSON.stringify({ start: '2026-06-01', end: '2026-10-15' }), 'text');

    await submit({ clear_block: { clear: { selected_options: [{ value: 'clear' }] } } });
    expect(jira.updateIssueField).toHaveBeenLastCalledWith('PR-1234', rr.FIELDS.TARGET, null, 'raw');

    const ack = jest.fn();
    await handlers.risk_target_modal({ ack, body: { user: { id: 'U1' } }, client, logger, view: { private_metadata: value({}), state: { values: {} } } });
    expect(ack).toHaveBeenCalledWith({ response_action: 'errors', errors: expect.objectContaining({ target_block: expect.any(String) }) });
  });

  test('handled → no Jira write, prompt marked answered, message rewritten', async () => {
    const { handlers, client, jira, db, updates, logger, body } = setup();
    await handlers.risk_handled({ ack: jest.fn(), body: body({}), client, logger });
    expect(jira.transitionIssue).not.toHaveBeenCalled();
    expect(jira.updateIssueField).not.toHaveBeenCalled();
    expect(db.markPromptAnswered).toHaveBeenCalledWith('PR-1234', 'U1');
    expect(updates[updates.length - 1].text).toMatch(/Noted — no changes/);
  });
});

describe('risk review FYI follow-ups', () => {
  test('status change is echoed to the FYI recipient; nothing sent without one', async () => {
    const handlers = {};
    const app = { action: (id, fn) => { handlers[String(id)] = fn; }, view: (id, fn) => { handlers[String(id)] = fn; } };
    const client = {
      chat: { update: jest.fn().mockResolvedValue({}), postMessage: jest.fn().mockResolvedValue({}) },
      views: { open: jest.fn() }, conversations: { open: jest.fn() },
    };
    const jira = { transitionIssue: jest.fn().mockResolvedValue(undefined) };
    registerDmHandler(app, jira, { db: { markPromptAnswered: jest.fn().mockResolvedValue(undefined) }, oauthService: null });
    const statusHandler = handlers[Object.keys(handlers).find((k) => k.startsWith('/^risk_set_status_'))];
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const mk = (fyi) => ({ actions: [{ value: JSON.stringify({ askType: 'risk_review', issueKey: 'PR-9', slackUserId: 'UDEV', status: 'High Risk', fyiSlackUserId: fyi, risk: {} }) }], channel: { id: 'D1' }, message: { ts: '1', text: 'o' }, user: { id: 'UDEV' } });

    await statusHandler({ ack: jest.fn(), body: mk('UPM'), client, logger });
    expect(client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: 'UPM', text: expect.stringMatching(/<@UDEV> set .*PR-9.* to \*High Risk\*/) }));

    client.chat.postMessage.mockClear();
    await statusHandler({ ack: jest.fn(), body: mk(null), client, logger });
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });
});

describe('Notes in the risk review', () => {
  test('plainText handles strings and ADF documents', () => {
    expect(rr.plainText('  hello  ')).toBe('hello');
    expect(rr.plainText({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'c' }] }] })).toBe('a\nb\nc'.replace('a\nb', 'ab'));
    expect(rr.plainText(null)).toBe('');
  });

  test('riskContextFor carries a truncated Notes preview', () => {
    const long = 'x'.repeat(500);
    const issue = { key: 'PR-1', fields: { summary: 'S', status: { name: 'On Track' }, [rr.FIELDS.NOTES]: long } };
    expect(rr.riskContextFor(issue).notes).toHaveLength(401);
    expect(rr.riskContextFor(issue).notes.endsWith('…')).toBe(true);
  });

  test('DM and FYI show Notes, or say they are empty', async () => {
    const withNotes = rr.buildRiskReviewBlocks({ ...ctxFor('On Track'), risk: { ...ctxFor('On Track').risk, notes: 'Waiting on infra.\nETA Tuesday.' } }, 'U1');
    expect(JSON.stringify(withNotes)).toContain('*Notes:*\\n> Waiting on infra.\\n> ETA Tuesday.');
    const empty = rr.buildRiskReviewBlocks(ctxFor('On Track'), 'U1');
    expect(JSON.stringify(empty)).toContain('*Notes:* _empty_');

    const client = { conversations: { open: jest.fn().mockResolvedValue({ channel: { id: 'D' } }) }, chat: { postMessage: jest.fn().mockResolvedValue({ ts: '1' }) } };
    await rr.sendFyi(client, 'UPM', ctxFor('On Track'), 'UDEV', null);
    expect(JSON.stringify(client.chat.postMessage.mock.calls[0][0].blocks)).toContain('*Notes:* _empty_');
  });
});

describe('Skip after a status change', () => {
  test('finalises the message without touching Jira', async () => {
    const handlers = {};
    const app = { action: (id, fn) => { handlers[String(id)] = fn; }, view: (id, fn) => { handlers[String(id)] = fn; } };
    const client = { chat: { update: jest.fn().mockResolvedValue({}), postMessage: jest.fn().mockResolvedValue({}) }, views: { open: jest.fn() }, conversations: { open: jest.fn() } };
    const jira = { transitionIssue: jest.fn(), updateIssueField: jest.fn(), getIssue: jest.fn() };
    const ops = { riskReviewAction: jest.fn().mockResolvedValue(undefined) };
    registerDmHandler(app, jira, { db: {}, oauthService: null, opsNotifier: ops });
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const body = { actions: [{ value: JSON.stringify({ askType: 'risk_review', issueKey: 'PR-9', slackUserId: 'UDEV', risk: { status: 'High Risk' } }) }], channel: { id: 'D1' }, message: { ts: '1', text: 'o' }, user: { id: 'UDEV' } };
    await handlers.risk_skip_notes({ ack: jest.fn(), body, client, logger });
    expect(jira.updateIssueField).not.toHaveBeenCalled();
    expect(client.chat.update).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringMatching(/PR-9.* is \*High Risk\*\. Notes left unchanged\./) }));
    expect(ops.riskReviewAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'skipped Notes update' }));
  });
});

describe('notification age', () => {
  const NOW = new Date('2026-09-09T12:00:00Z');
  test('parses the notifier\'s "Mmm DD — …" stamp, assuming the current year', () => {
    expect(rr.parseNotificationDate('Sep 7 — Progress orange 64%/exp 80%. Action: update progress', NOW).toISOString()).toBe('2026-09-07T00:00:00.000Z');
    expect(rr.parseNotificationDate('Jul 06 — Status mismatch. Action: update Status', NOW).toISOString()).toBe('2026-07-06T00:00:00.000Z');
    expect(rr.parseNotificationDate('[Dev Domain] Sep 7 — x', NOW)).toBeNull(); // prefix breaks the stamp → unknown, treated as fresh
    expect(rr.parseNotificationDate('', NOW)).toBeNull();
  });
  test('a stamp in the future rolls back a year (December run read in January)', () => {
    expect(rr.parseNotificationDate('Dec 29 — Overdue 3d', new Date('2027-01-03T00:00:00Z')).toISOString()).toBe('2026-12-29T00:00:00.000Z');
  });
  test('notificationAge: fresh within 8 days, stale beyond, unparseable = fresh', () => {
    expect(rr.notificationAge('Sep 7 — x', NOW)).toEqual({ stale: false, ageDays: 2 });
    expect(rr.notificationAge('Aug 31 — x', NOW)).toEqual({ stale: true, ageDays: 9 });
    expect(rr.notificationAge('Jun 8 — x', NOW).stale).toBe(true);
    expect(rr.notificationAge('garbage', NOW)).toEqual({ stale: false, ageDays: null });
    expect(rr.notificationAge('Aug 31 — x', NOW, 14).stale).toBe(false);
  });
});
