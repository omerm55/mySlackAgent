'use strict';

// Admin gating and persistent activity on the App Home.
process.env.ADMIN_SLACK_USER_IDS = 'UADMIN';
const { buildHomeBlocks } = require('../src/handlers/homeHandler');
const AuditLog = require('../src/utils/auditLog');

const text = (blocks) => JSON.stringify(blocks);

function services({ db = null, auditLog = new AuditLog() } = {}) {
  return {
    oauthService: { hasToken: () => true, generateAuthUrl: () => 'https://auth' },
    integrationCache: { getAll: jest.fn().mockResolvedValue([{ id: 'i1', name: 'Doc review', slackChannelId: 'C1', triggers: ['reaction'], jiraFieldName: 'PM reviewed', jiraFieldValue: 'Yes', scope: 'global', createdBy: 'UADMIN' }]) },
    db,
    auditLog,
  };
}

describe('App Home visibility', () => {
  test('admins see channel + Jira trigger sections and the create buttons', async () => {
    const db = { getActiveJiraTriggers: jest.fn().mockResolvedValue([]), getUserPreference: jest.fn().mockResolvedValue(null), getPendingPrompts: jest.fn().mockResolvedValue([]) };
    const blocks = await buildHomeBlocks('UADMIN', services({ db }));
    const t = text(blocks);
    expect(t).toContain('*Channel triggers*');
    expect(t).toContain('*Jira triggers*');
    expect(t).toContain('home_create_trigger');
    expect(t).toContain('home_create_jira_trigger');
    expect(t).toContain('Doc review');
  });

  test('regular users see connection, notifications, how it works and activity — no triggers', async () => {
    const db = { getActiveJiraTriggers: jest.fn(), getUserPreference: jest.fn().mockResolvedValue(null), getPendingPrompts: jest.fn().mockResolvedValue([]) };
    const svc = services({ db });
    const blocks = await buildHomeBlocks('UREGULAR', svc);
    const t = text(blocks);
    expect(t).not.toContain('Channel triggers');
    expect(t).not.toContain('Jira triggers');
    expect(t).not.toContain('home_create_trigger');
    expect(t).not.toContain('home_create_jira_trigger');
    expect(t).toContain('Jira account connected');
    expect(t).toContain('home_set_digest');
    expect(t).toContain('*How it works*');
    expect(t).toContain('*Your recent activity*');
    // No wasted DB calls for sections the user cannot see
    expect(svc.integrationCache.getAll).not.toHaveBeenCalled();
    expect(db.getActiveJiraTriggers).not.toHaveBeenCalled();
  });
});

describe('recent activity', () => {
  test('comes from Supabase when configured (survives restarts), newest first', async () => {
    const db = {
      getActiveJiraTriggers: jest.fn().mockResolvedValue([]), getUserPreference: jest.fn().mockResolvedValue(null), getPendingPrompts: jest.fn().mockResolvedValue([]),
      getRecentActivity: jest.fn().mockResolvedValue([
        { ts: Date.UTC(2026, 8, 9, 10), slackUserId: 'U1', trigger: '🩺 risk review', issueKey: 'PR-1290', fieldName: 'status', fieldValue: 'High Risk', success: true },
        { ts: Date.UTC(2026, 8, 8, 9), slackUserId: 'U1', trigger: 'DM Yes', issueKey: 'SNS-1', fieldName: 'status', fieldValue: 'Done', success: false, error: 'HTTP 400' },
      ]),
    };
    const auditLog = new AuditLog({ db });
    const blocks = await buildHomeBlocks('U1', services({ db, auditLog }));
    const t = text(blocks);
    expect(db.getRecentActivity).toHaveBeenCalledWith('U1', 5);
    expect(t).toContain('*PR-1290*');
    expect(t).toContain('status = High Risk');
    expect(t).toContain('❌  *SNS-1*');
    expect(t).not.toContain('No activity yet');
  });

  test('falls back to memory without Supabase; addEntry persists when a db is attached', async () => {
    const auditLog = new AuditLog();
    auditLog.addEntry({ ts: Date.now(), slackUserId: 'U1', trigger: 'DM Yes', issueKey: 'SNS-2', fieldName: 'status', fieldValue: 'Done', success: true });
    const blocks = await buildHomeBlocks('U1', services({ auditLog }));
    expect(text(blocks)).toContain('*SNS-2*');

    const db = { insertActivity: jest.fn().mockResolvedValue(undefined) };
    auditLog.setDb(db);
    auditLog.addEntry({ ts: 1, slackUserId: 'U1', trigger: 'DM Yes', issueKey: 'SNS-3', success: true });
    expect(db.insertActivity).toHaveBeenCalledWith(expect.objectContaining({ issueKey: 'SNS-3' }));
    // entries without a user/issue are not persisted (nothing to show anyone)
    auditLog.addEntry({ ts: 1, trigger: 'x', success: true });
    expect(db.insertActivity).toHaveBeenCalledTimes(1);
  });
});
