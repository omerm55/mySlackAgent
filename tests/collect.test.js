'use strict';

const cm = require('../src/utils/collectMessage');
const { registerDmHandler } = require('../src/handlers/dmHandler');
const { sendDmQuestion } = require('../src/utils/dmQuestion');

const NAME = 'customfield_11822';
const VALUE = 'customfield_15249';
const FIELDS = [
  { id: NAME, name: 'Customer-friendly name', hint: 'External-facing name', required: true },
  { id: VALUE, name: 'Customer value', hint: 'One line on what the customer gets', required: true },
];
const actionIds = (blocks) => blocks.filter((b) => b.type === 'actions').flatMap((b) => b.elements.map((e) => e.action_id));
const ctxFor = (extra = {}) => ({ askType: 'collect', issueKey: 'PR-1234', question: '', collect: { summary: 'Smart Alerts', fields: FIELDS.map((f) => ({ ...f, current: '' })) }, ...extra });

describe('collect: trigger field list', () => {
  test('parses "id | label | hint | optional" lines', () => {
    const { fields, error } = cm.parseCollectFields(`${NAME} | Customer-friendly name | External-facing name\n${VALUE} | Customer value | | optional\n`);
    expect(error).toBeNull();
    expect(fields).toEqual([
      { id: NAME, name: 'Customer-friendly name', hint: 'External-facing name', required: true },
      { id: VALUE, name: 'Customer value', hint: null, required: false },
    ]);
    expect(cm.parseCollectFields(cm.formatCollectFields(fields)).fields).toEqual(fields);
  });
  test('rejects empty, bad ids and duplicates', () => {
    expect(cm.parseCollectFields('').error).toMatch(/at least one field/);
    expect(cm.parseCollectFields('Customer value | x').error).toMatch(/must start with a field id/);
    expect(cm.parseCollectFields(`${NAME} | a\n${NAME} | b`).error).toMatch(/listed twice/);
  });
  test('collectContextFor carries current values (capped) from the searched issue', () => {
    const issue = { key: 'PR-1', fields: { summary: 'S', [NAME]: '  Smart Alerts ', [VALUE]: null } };
    const c = cm.collectContextFor(issue, { collect_fields: FIELDS });
    expect(c.summary).toBe('S');
    expect(c.fields.map((f) => f.current)).toEqual(['Smart Alerts', '']);
  });
});

describe('collect: DM, preview and modal', () => {
  test('ask blocks: Answer + Skip, current values or "empty", compact ctx', () => {
    const ctx = ctxFor(); ctx.collect.fields[0].current = 'Smart Alerts';
    const blocks = cm.buildCollectBlocks(ctx, 'U1');
    expect(actionIds(blocks)).toEqual(['collect_answer', 'collect_skip']);
    const text = JSON.stringify(blocks);
    expect(text).toContain('Customer-friendly name:* Smart Alerts');
    expect(text).toContain('Customer value:* _empty_');
    const val = JSON.parse(blocks.find((b) => b.type === 'actions').elements[0].value);
    expect(val).toMatchObject({ askType: 'collect', issueKey: 'PR-1234', slackUserId: 'U1' });
    expect(val.collect.fields).toHaveLength(2);
    expect(blocks.find((b) => b.type === 'actions').elements[0].value.length).toBeLessThan(2000);
  });
  test('preview: all values → Save/Edit/Cancel; missing required → no Save, "Add the missing part"', () => {
    const full = cm.previewBlocks(ctxFor({ freeText: 'my words' }), 'U1', { [NAME]: 'Smart Alerts', [VALUE]: 'Know when a KPI drifts.' });
    expect(full.missing).toEqual([]);
    expect(actionIds(full.blocks)).toEqual(['collect_save', 'collect_edit', 'collect_cancel']);
    const edit = full.blocks.find((b) => b.type === 'actions').elements[1];
    expect(JSON.parse(edit.value)).toMatchObject({ values: { [NAME]: 'Smart Alerts' }, freeText: 'my words' });
    const partial = cm.previewBlocks(ctxFor(), 'U1', { [NAME]: 'Smart Alerts', [VALUE]: null });
    expect(partial.missing.map((f) => f.id)).toEqual([VALUE]);
    expect(actionIds(partial.blocks)).toEqual(['collect_edit', 'collect_cancel']);
    expect(JSON.stringify(partial.blocks)).toContain('not found in what you wrote');
  });
  test('mergeValues: explicit wins over extracted, caps at 255, null when neither', () => {
    const merged = cm.mergeValues(FIELDS, { [NAME]: 'Typed' }, { [NAME]: 'Extracted', [VALUE]: ' ' + 'x'.repeat(300) });
    expect(merged[NAME]).toBe('Typed');
    expect(merged[VALUE]).toHaveLength(255);
    expect(cm.mergeValues(FIELDS, {}, {})).toEqual({ [NAME]: null, [VALUE]: null });
  });
  test('modal: free text + one input per field, prefilled; metadata drops values/freeText', () => {
    const ctx = ctxFor({ values: { [NAME]: 'x' }, freeText: 'y', dmChannelId: 'D1', messageTs: '1' });
    const view = cm.buildCollectModal(ctx, { [NAME]: 'Smart Alerts' }, { freeText: 'call it Smart Alerts' });
    expect(view.callback_id).toBe('collect_modal');
    expect(view.blocks.map((b) => b.block_id).filter(Boolean)).toEqual(['free_text', `cf_${NAME}`, `cf_${VALUE}`]);
    expect(view.blocks[1].element.initial_value).toBe('call it Smart Alerts');
    expect(view.blocks[2].element.initial_value).toBe('Smart Alerts');
    expect(view.blocks[3].element.initial_value).toBeUndefined();
    const meta = JSON.parse(view.private_metadata);
    expect(meta.values).toBeUndefined(); expect(meta.freeText).toBeUndefined(); expect(meta.dmChannelId).toBe('D1');
  });
  test('readCollectModal: explicit only where typed and different from current', () => {
    const ctx = ctxFor(); ctx.collect.fields[0].current = 'Smart Alerts';
    const view = { state: { values: { free_text: { value: { value: ' words ' } }, [`cf_${NAME}`]: { value: { value: 'Smart Alerts' } }, [`cf_${VALUE}`]: { value: { value: 'Typed value' } } } } };
    expect(cm.readCollectModal(view, ctx)).toEqual({ freeText: 'words', explicit: { [VALUE]: 'Typed value' } });
  });
  test('sendDmQuestion delegates collect asks to sendCollect', async () => {
    const client = { conversations: { open: jest.fn().mockResolvedValue({ channel: { id: 'D1' } }) }, chat: { postMessage: jest.fn().mockResolvedValue({ ts: '9' }) } };
    const ops = { dmQuestionSent: jest.fn() };
    const res = await sendDmQuestion(client, 'U1', ctxFor({ authUrl: 'https://auth' }), null, ops);
    expect(res).toEqual({ channelId: 'D1', messageTs: '9' });
    const ids = actionIds(client.chat.postMessage.mock.calls[0][0].blocks);
    expect(ids).toEqual(['collect_answer', 'collect_skip', 'dm_connect_jira']);
    expect(ops.dmQuestionSent).toHaveBeenCalledWith(expect.objectContaining({ issueKey: 'PR-1234', fieldValue: 'collect' }));
  });
});

describe('collect handlers', () => {
  function setup({ llm = undefined } = {}) {
    const handlers = {};
    const app = { action: (id, fn) => { handlers[String(id)] = fn; }, view: (id, fn) => { handlers[String(id)] = fn; } };
    const updates = [];
    const client = {
      chat: { update: jest.fn(async (p) => { updates.push(p); return {}; }), postMessage: jest.fn().mockResolvedValue({}) },
      views: { open: jest.fn().mockResolvedValue({}) },
      conversations: { open: jest.fn().mockResolvedValue({ channel: { id: 'D1' } }) },
    };
    const jira = { updateIssueFields: jest.fn().mockResolvedValue(undefined), updateIssueField: jest.fn(), transitionIssue: jest.fn() };
    const db = { markPromptAnswered: jest.fn().mockResolvedValue(undefined), deletePromptsForIssue: jest.fn().mockResolvedValue(undefined) };
    const ops = { collectAction: jest.fn().mockResolvedValue(undefined) };
    const llmService = llm === undefined ? { extractFields: jest.fn().mockResolvedValue({ values: { [NAME]: 'Smart Alerts', [VALUE]: 'Customers know the moment a KPI drifts.' }, note: null }) } : llm;
    registerDmHandler(app, jira, { db, llmService, oauthService: null, opsNotifier: ops, userCache: { getName: jest.fn().mockResolvedValue('Omer') } });
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const value = (extra) => JSON.stringify({ ...ctxFor(), slackUserId: 'U1', ...extra });
    const body = (extra) => ({ actions: [{ value: value(extra) }], channel: { id: 'D1' }, message: { ts: '1', text: 'orig' }, user: { id: 'U1' }, trigger_id: 'T' });
    const meta = (extra) => JSON.stringify({ ...ctxFor(), slackUserId: 'U1', dmChannelId: 'D1', messageTs: '1', originalText: 'orig', ...extra });
    const view = (values, extra) => ({ private_metadata: meta(extra), state: { values } });
    return { handlers, client, jira, db, ops, updates, logger, body, view, llmService };
  }
  const typed = (v) => ({ value: { value: v } });

  test('Answer → opens the modal carrying the DM location', async () => {
    const { handlers, client, logger, body } = setup();
    await handlers.collect_answer({ ack: jest.fn(), body: body(), client, logger });
    const v = client.views.open.mock.calls[0][0].view;
    expect(v.callback_id).toBe('collect_modal');
    expect(JSON.parse(v.private_metadata)).toMatchObject({ issueKey: 'PR-1234', dmChannelId: 'D1', messageTs: '1' });
  });

  test('modal: nothing entered → inline error, no LLM', async () => {
    const { handlers, client, logger, view, llmService } = setup();
    const ack = jest.fn();
    await handlers.collect_modal({ ack, body: {}, view: view({ free_text: typed('') }), client, logger });
    expect(ack).toHaveBeenCalledWith({ response_action: 'errors', errors: { free_text: expect.any(String) } });
    expect(llmService.extractFields).not.toHaveBeenCalled();
  });

  test('modal: explicit values only → preview with Save, LLM not called', async () => {
    const { handlers, client, logger, view, updates, llmService } = setup();
    await handlers.collect_modal({ ack: jest.fn(), body: {}, view: view({ [`cf_${NAME}`]: typed('Smart Alerts'), [`cf_${VALUE}`]: typed('Know when a KPI drifts.') }), client, logger });
    expect(llmService.extractFields).not.toHaveBeenCalled();
    const last = updates[updates.length - 1];
    expect(last.text).toMatch(/Ready to save/);
    expect(actionIds(last.blocks)).toEqual(['collect_save', 'collect_edit', 'collect_cancel']);
    expect(JSON.parse(last.blocks.find((b) => b.type === 'actions').elements[0].value).values).toEqual({ [NAME]: 'Smart Alerts', [VALUE]: 'Know when a KPI drifts.' });
  });

  test('modal: free text → LLM extracts; a typed field wins over the extraction', async () => {
    const { handlers, client, logger, view, updates, llmService } = setup();
    await handlers.collect_modal({ ack: jest.fn(), body: {}, view: view({ free_text: typed('Call it Smart Alerts; customers know the moment a KPI drifts'), [`cf_${VALUE}`]: typed('Typed value') }), client, logger });
    expect(llmService.extractFields).toHaveBeenCalledWith(expect.objectContaining({ issueKey: 'PR-1234', userText: expect.stringContaining('Smart Alerts') }));
    expect(updates[0].text).toMatch(/Reading what you wrote/);
    const last = updates[updates.length - 1];
    expect(JSON.parse(last.blocks.find((b) => b.type === 'actions').elements[0].value).values).toEqual({ [NAME]: 'Smart Alerts', [VALUE]: 'Typed value' });
  });

  test('modal: LLM finds only one field → no Save, "Almost there" with the missing name', async () => {
    const { handlers, client, logger, view, updates } = setup({ llm: { extractFields: jest.fn().mockResolvedValue({ values: { [NAME]: 'Smart Alerts', [VALUE]: null } }) } });
    await handlers.collect_modal({ ack: jest.fn(), body: {}, view: view({ free_text: typed('Call it Smart Alerts') }), client, logger });
    const last = updates[updates.length - 1];
    expect(last.text).toMatch(/Almost there.*Customer value/);
    expect(actionIds(last.blocks)).toEqual(['collect_edit', 'collect_cancel']);
  });

  test('modal: LLM failure → preview still shown with a note, no Save (nothing extracted)', async () => {
    const { handlers, client, logger, view, updates } = setup({ llm: { extractFields: jest.fn().mockRejectedValue(new Error('boom')) } });
    await handlers.collect_modal({ ack: jest.fn(), body: {}, view: view({ free_text: typed('words') }), client, logger });
    const last = updates[updates.length - 1];
    expect(JSON.stringify(last.blocks)).toMatch(/couldn't read that automatically/);
    expect(actionIds(last.blocks)).toEqual(['collect_edit', 'collect_cancel']);
  });

  test('Save → ONE PUT with both fields, ✅, answered, ops, FYI follow-up', async () => {
    const { handlers, client, jira, db, ops, logger, body, updates } = setup();
    const values = { [NAME]: 'Smart Alerts', [VALUE]: 'Know when a KPI drifts.' };
    await handlers.collect_save({ ack: jest.fn(), body: body({ values, fyiSlackUserId: 'UPM' }), client, logger });
    expect(jira.updateIssueFields).toHaveBeenCalledTimes(1);
    expect(jira.updateIssueFields).toHaveBeenCalledWith('PR-1234', values);
    expect(updates[updates.length - 1].text).toMatch(/✅ Saved to .*PR-1234.*Customer-friendly name:\* Smart Alerts/s);
    expect(db.markPromptAnswered).toHaveBeenCalledWith('PR-1234', 'U1');
    expect(ops.collectAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'saved', detail: expect.stringContaining('Smart Alerts') }));
    expect(client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: 'UPM', text: expect.stringMatching(/filled in/) }));
  });

  test('Save failure → ❌ with Jira error, prompt cleared for re-ask', async () => {
    const { handlers, client, jira, db, logger, body, updates } = setup();
    jira.updateIssueFields.mockRejectedValueOnce(new Error('HTTP 400: Field cannot be set'));
    await handlers.collect_save({ ack: jest.fn(), body: body({ values: { [NAME]: 'x', [VALUE]: 'y' } }), client, logger });
    expect(updates[updates.length - 1].text).toMatch(/❌ Couldn't save.*HTTP 400/);
    expect(db.deletePromptsForIssue).toHaveBeenCalledWith('PR-1234', 'U1');
  });

  test('Edit → reopens the modal prefilled with the extracted values and text', async () => {
    const { handlers, client, logger, body } = setup();
    await handlers.collect_edit({ ack: jest.fn(), body: body({ values: { [NAME]: 'Smart Alerts', [VALUE]: null }, freeText: 'my words' }), client, logger });
    const v = client.views.open.mock.calls[0][0].view;
    expect(v.blocks[1].element.initial_value).toBe('my words');
    expect(v.blocks[2].element.initial_value).toBe('Smart Alerts');
    expect(JSON.parse(v.private_metadata)).toMatchObject({ dmChannelId: 'D1', messageTs: '1' });
  });

  test('Cancel → original Answer/Skip ask restored, nothing written; Skip → answered, no Jira', async () => {
    const { handlers, client, jira, db, ops, logger, body, updates } = setup();
    await handlers.collect_cancel({ ack: jest.fn(), body: body({ values: { [NAME]: 'x' } }), client, logger });
    expect(actionIds(updates[updates.length - 1].blocks)).toEqual(['collect_answer', 'collect_skip']);
    await handlers.collect_skip({ ack: jest.fn(), body: body(), client, logger });
    expect(updates[updates.length - 1].text).toMatch(/Skipped/);
    expect(db.markPromptAnswered).toHaveBeenCalledWith('PR-1234', 'U1');
    expect(jira.updateIssueFields).not.toHaveBeenCalled();
    expect(ops.collectAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'skipped' }));
  });
});
