'use strict';

// A failed Supabase write must keep the modal open with the reason (ack with errors),
// never close it and look like a silent revert.
process.env.ADMIN_SLACK_USER_IDS = 'UADMIN';
const { registerJiraTriggerHandler, registerTriggerHandler } = require('../src/handlers/triggerHandler');

function fakeApp() {
  const handlers = {};
  return { app: { action: (id, fn) => { handlers[String(id)] = fn; }, view: (id, fn) => { handlers[String(id)] = fn; } }, handlers };
}
const opt = (value) => ({ selected_option: { value } });
const txt = (value) => ({ value });

describe('Jira trigger modal save', () => {
  const values = {
    jt_name: { value: txt('R&D risk review') },
    jt_jql: { value: txt('project = PR AND cf[15525] is not EMPTY') },
    jt_question: { value: txt('') },
    jt_notify: { value: opt('user_field') },
    jt_notify_field: { value: txt('customfield_11962') },
    jt_ask_type: { value: opt('risk_review') },
    jt_interval: { value: opt('60') },
    jt_action: { value: opt('transition') },
    jt_pilot_users: { value: { selected_users: ['UYEHUDA'] } },
    jt_scope: { value: opt('global') },
  };
  function setup(dbOverrides) {
    const { app, handlers } = fakeApp();
    const db = { getActiveJiraTriggers: jest.fn().mockResolvedValue([]), insertJiraTrigger: jest.fn().mockResolvedValue({ id: 't1' }), updateJiraTrigger: jest.fn().mockResolvedValue(undefined), ...dbOverrides };
    const ops = { channelId: 'COPS', post: jest.fn().mockResolvedValue(undefined) };
    const services = { db, jiraService: { searchIssues: jest.fn().mockResolvedValue([]) }, opsNotifier: ops, integrationCache: { getAll: jest.fn().mockResolvedValue([]) } };
    registerJiraTriggerHandler(app, services);
    const client = { views: { publish: jest.fn().mockResolvedValue({}), open: jest.fn() }, chat: { postMessage: jest.fn().mockResolvedValue({}) } };
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    return { handlers, db, ops, client, logger };
  }

  test('DB rejects (e.g. missing column) → modal stays open with the reason, ops informed, nothing else runs', async () => {
    const dbErr = Object.assign(new Error('Request failed with status code 400'), { response: { data: { message: 'column "pilot_slack_user_ids" does not exist' } } });
    const { handlers, ops, client, logger } = setup({ insertJiraTrigger: jest.fn().mockRejectedValue(dbErr) });
    const ack = jest.fn();
    await handlers.create_jira_trigger_modal({ ack, body: { user: { id: 'UADMIN' } }, view: { private_metadata: '{}', state: { values } }, client, logger });
    expect(ack).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenCalledWith({ response_action: 'errors', errors: { jt_name: expect.stringMatching(/Could not save: .*pilot_slack_user_ids.*does not exist/) } });
    expect(ops.post).toHaveBeenCalledWith(expect.stringMatching(/❌ Failed to save Jira trigger \*R&D risk review\*/));
    expect(client.views.publish).not.toHaveBeenCalled();
  });

  test('DB accepts → plain ack, Home refreshed, ops told, pilot list saved', async () => {
    const { handlers, db, ops, client, logger } = setup();
    const ack = jest.fn();
    await handlers.create_jira_trigger_modal({ ack, body: { user: { id: 'UADMIN' } }, view: { private_metadata: '{}', state: { values } }, client, logger });
    expect(ack).toHaveBeenCalledWith();
    expect(db.insertJiraTrigger).toHaveBeenCalledWith(expect.objectContaining({ ask_type: 'risk_review', pilot_slack_user_ids: ['UYEHUDA'], scope: 'global', notify_field_id: 'customfield_11962' }));
    expect(client.views.publish).toHaveBeenCalled();
    expect(ops.post).toHaveBeenCalledWith(expect.stringMatching(/✅ Jira trigger .*Pilot: only <@UYEHUDA>/));
  });

  test('a new trigger with no scope choice defaults to personal (safe first run)', async () => {
    const { handlers, db, client, logger } = setup();
    const { jt_scope, ...noScope } = values;
    await handlers.create_jira_trigger_modal({ ack: jest.fn(), body: { user: { id: 'UADMIN' } }, view: { private_metadata: '{}', state: { values: noScope } }, client, logger });
    expect(db.insertJiraTrigger).toHaveBeenCalledWith(expect.objectContaining({ scope: 'personal' }));
  });

  test('Jira identity checkbox: unchecked → allow_bot_fallback false (default); checked → true', async () => {
    const { handlers, db, client, logger } = setup();
    await handlers.create_jira_trigger_modal({ ack: jest.fn(), body: { user: { id: 'UADMIN' } }, view: { private_metadata: '{}', state: { values } }, client, logger });
    expect(db.insertJiraTrigger).toHaveBeenCalledWith(expect.objectContaining({ allow_bot_fallback: false }));
    await handlers.create_jira_trigger_modal({ ack: jest.fn(), body: { user: { id: 'UADMIN' } }, view: { private_metadata: '{}', state: { values: { ...values, jt_fallback: { value: { selected_options: [{ value: 'allow' }] } } } } }, client, logger });
    expect(db.insertJiraTrigger).toHaveBeenLastCalledWith(expect.objectContaining({ allow_bot_fallback: true }));
  });

  test('editing someone else\'s trigger → inline error, no write', async () => {
    const { handlers, db, client, logger } = setup({ getActiveJiraTriggers: jest.fn().mockResolvedValue([{ id: 't9', created_by: 'USOMEONE' }]) });
    const ack = jest.fn();
    await handlers.create_jira_trigger_modal({ ack, body: { user: { id: 'UREGULAR' } }, view: { private_metadata: JSON.stringify({ id: 't9' }), state: { values } }, client, logger });
    expect(ack).toHaveBeenCalledWith({ response_action: 'errors', errors: { jt_name: expect.stringMatching(/only edit/) } });
    expect(db.updateJiraTrigger).not.toHaveBeenCalled();
  });
});

describe('Jira trigger modal save — collect ask type', () => {
  const base = {
    jt_name: { value: txt('A1 — customer-friendly name & value') },
    jt_jql: { value: txt('project = PR AND issuetype = Initiative') },
    jt_question: { value: txt('') },
    jt_notify: { value: opt('user_field') },
    jt_notify_field: { value: txt('customfield_11909') },
    jt_ask_type: { value: opt('collect') },
    jt_interval: { value: opt('60') },
    jt_action: { value: opt('transition') },
    jt_scope: { value: opt('global') },
  };
  function setup() {
    const { app, handlers } = fakeApp();
    const db = { getActiveJiraTriggers: jest.fn().mockResolvedValue([]), insertJiraTrigger: jest.fn().mockResolvedValue({ id: 't1' }), updateJiraTrigger: jest.fn() };
    const ops = { channelId: 'COPS', post: jest.fn().mockResolvedValue(undefined) };
    registerJiraTriggerHandler(app, { db, jiraService: { searchIssues: jest.fn().mockResolvedValue([]) }, opsNotifier: ops, integrationCache: { getAll: jest.fn().mockResolvedValue([]) } });
    const client = { views: { publish: jest.fn().mockResolvedValue({}), open: jest.fn() }, chat: { postMessage: jest.fn().mockResolvedValue({}) } };
    return { handlers, db, ops, client, logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } };
  }
  test('bad field list → inline error on the fields input, no write', async () => {
    const { handlers, db, client, logger } = setup();
    const ack = jest.fn();
    await handlers.create_jira_trigger_modal({ ack, body: { user: { id: 'UADMIN' } }, view: { private_metadata: '{}', state: { values: { ...base, jt_collect_fields: { value: txt('Customer value | no id here') } } } }, client, logger });
    expect(ack).toHaveBeenCalledWith({ response_action: 'errors', errors: { jt_collect_fields: expect.stringMatching(/must start with a field id/) } });
    expect(db.insertJiraTrigger).not.toHaveBeenCalled();
  });
  test('after saving, the trigger is run once and the summary goes to ops (queued matches are called out)', async () => {
    const { app, handlers } = fakeApp();
    const db = { getActiveJiraTriggers: jest.fn().mockResolvedValue([]), insertJiraTrigger: jest.fn().mockResolvedValue({ id: 't1' }), updateJiraTrigger: jest.fn() };
    const ops = { channelId: 'COPS', post: jest.fn().mockResolvedValue(undefined) };
    const stats = { matched: 15, fresh: 14, sent: 0, queued: 1, fyi: 0, sentTo: [], queuedFor: ['PR-1436 → <@UADMIN> (hourly)'], skipped: ['PR-1429: personal trigger, Maya is not the creator'] };
    const jiraPoller = { runOnce: jest.fn().mockResolvedValue([stats]) };
    registerJiraTriggerHandler(app, { db, jiraService: { searchIssues: jest.fn().mockResolvedValue([]) }, opsNotifier: ops, jiraPoller, integrationCache: { getAll: jest.fn().mockResolvedValue([]) } });
    const client = { views: { publish: jest.fn().mockResolvedValue({}), open: jest.fn() }, chat: { postMessage: jest.fn().mockResolvedValue({}) } };
    const list = 'customfield_11822 | Customer-friendly name';
    await handlers.create_jira_trigger_modal({ ack: jest.fn(), body: { user: { id: 'UADMIN' } }, view: { private_metadata: '{}', state: { values: { ...base, jt_collect_fields: { value: txt(list) } } } }, client, logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } });
    expect(jiraPoller.runOnce).toHaveBeenCalledWith({ force: true, onlyId: 't1' });
    const summary = ops.post.mock.calls.map((c) => c[0]).find((m) => /First run of/.test(m));
    expect(summary).toMatch(/15 issue\(s\) match · 14 not yet asked · 1 already asked or waiting in a digest · 0 DM\(s\) sent · 1 queued for digests/);
    expect(summary).toMatch(/🔔 PR-1436 → <@UADMIN> \(hourly\) — held for their digest/);
  });

  test('valid field list → collect_fields saved as JSON, default question names the fields, ops told', async () => {
    const { handlers, db, ops, client, logger } = setup();
    const ack = jest.fn();
    const list = 'customfield_11822 | Customer-friendly name | External-facing name\ncustomfield_15249 | Customer value';
    await handlers.create_jira_trigger_modal({ ack, body: { user: { id: 'UADMIN' } }, view: { private_metadata: '{}', state: { values: { ...base, jt_collect_fields: { value: txt(list) } } } }, client, logger });
    expect(ack).toHaveBeenCalledWith();
    expect(db.insertJiraTrigger).toHaveBeenCalledWith(expect.objectContaining({
      ask_type: 'collect',
      collect_fields: [
        { id: 'customfield_11822', name: 'Customer-friendly name', hint: 'External-facing name', required: true },
        { id: 'customfield_15249', name: 'Customer value', hint: null, required: true },
      ],
      question: '{link} needs: Customer-friendly name, Customer value.',
      transition_to: null,
    }));
    expect(ops.post).toHaveBeenCalledWith(expect.stringMatching(/AI fills \*Customer-friendly name, Customer value\*/));
  });
});

describe('Channel trigger modal save', () => {
  const values = {
    name_block: { value: txt('Doc review') },
    channel_block: { value: { selected_conversation: 'C123ABCDEF' } },
    channel_id_block: { value: txt('') },
    triggers_block: { value: { selected_options: [{ value: 'reaction' }] } },
    field_id_block: { value: txt('customfield_1') },
    field_name_block: { value: txt('PM reviewed') },
    field_value_block: { value: txt('Yes') },
  };
  test('channel trigger: Jira identity checkbox persisted; default false', async () => {
    const { app, handlers } = fakeApp();
    const db = { upsertIntegration: jest.fn().mockResolvedValue({}) };
    const ops = { channelId: 'COPS', post: jest.fn().mockResolvedValue(undefined) };
    registerTriggerHandler(app, { db, opsNotifier: ops, integrationCache: { getAll: jest.fn().mockResolvedValue([]), invalidate: jest.fn() } });
    const client = { views: { publish: jest.fn().mockResolvedValue({}) }, conversations: { join: jest.fn().mockResolvedValue({}) }, chat: { postMessage: jest.fn().mockResolvedValue({}) } };
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    await handlers.create_trigger_modal({ ack: jest.fn(), body: { user: { id: 'UADMIN' } }, view: { private_metadata: '{}', state: { values } }, client, logger });
    expect(db.upsertIntegration).toHaveBeenCalledWith(expect.objectContaining({ allow_bot_fallback: false }));
    expect(ops.post).toHaveBeenCalledWith(expect.stringMatching(/OAuth required/));
    await handlers.create_trigger_modal({ ack: jest.fn(), body: { user: { id: 'UADMIN' } }, view: { private_metadata: '{}', state: { values: { ...values, fallback_block: { value: { selected_options: [{ value: 'allow' }] } } } } }, client, logger });
    expect(db.upsertIntegration).toHaveBeenLastCalledWith(expect.objectContaining({ allow_bot_fallback: true }));
    expect(ops.post).toHaveBeenLastCalledWith(expect.stringMatching(/bot account may act/));
  });

  test('DB rejects → modal stays open with the reason', async () => {
    const { app, handlers } = fakeApp();
    const db = { upsertIntegration: jest.fn().mockRejectedValue(new Error('boom')) };
    const ops = { channelId: 'COPS', post: jest.fn().mockResolvedValue(undefined) };
    registerTriggerHandler(app, { db, opsNotifier: ops, integrationCache: { getAll: jest.fn().mockResolvedValue([]), invalidate: jest.fn() } });
    const ack = jest.fn();
    const client = { views: { publish: jest.fn() }, conversations: { join: jest.fn() }, chat: { postMessage: jest.fn() } };
    await handlers.create_trigger_modal({ ack, body: { user: { id: 'UADMIN' } }, view: { private_metadata: '{}', state: { values } }, client, logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } });
    expect(ack).toHaveBeenCalledWith({ response_action: 'errors', errors: { name_block: 'Could not save: boom' } });
    expect(client.conversations.join).not.toHaveBeenCalled();
  });
});
