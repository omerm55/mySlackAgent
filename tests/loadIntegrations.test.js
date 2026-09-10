'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { loadIntegrations } = require('../src/loadIntegrations');

// Minimal valid entry — used as the base for all tests
const VALID_ENTRY = {
  name: 'my-workflow',
  owner: 'owner@company.com',
  slackChannelId: 'C123',
  jiraFieldId: 'customfield_10000',
  jiraFieldValue: 'In Review',
  jiraFieldType: 'select',
  triggers: ['reply', 'reaction'],
};

function writeTempConfig(data) {
  const file = path.join(os.tmpdir(), `integrations-test-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(data));
  return file;
}

let exitSpy;
beforeEach(() => {
  exitSpy = jest.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Error(`process.exit(${code})`);
  });
});
afterEach(() => exitSpy.mockRestore());

describe('loadIntegrations', () => {
  test('loads a valid config successfully', () => {
    const file = writeTempConfig([VALID_ENTRY]);
    const result = loadIntegrations(file);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('my-workflow');
  });

  test('returns an empty list if file does not exist (integrations live in Supabase)', () => {
    const saved = process.env.INTEGRATIONS_JSON;
    delete process.env.INTEGRATIONS_JSON;
    try {
      expect(loadIntegrations('/nonexistent/path.json')).toEqual([]);
    } finally {
      if (saved !== undefined) process.env.INTEGRATIONS_JSON = saved;
    }
  });

  test('exits if JSON is malformed', () => {
    const file = path.join(os.tmpdir(), `bad-${Date.now()}.json`);
    fs.writeFileSync(file, 'not json {{');
    expect(() => loadIntegrations(file)).toThrow('process.exit(1)');
  });

  test('accepts an empty array', () => {
    expect(loadIntegrations(writeTempConfig([]))).toEqual([]);
  });

  test('exits if name is missing', () => {
    const { name, ...rest } = VALID_ENTRY;
    expect(() => loadIntegrations(writeTempConfig([rest]))).toThrow('process.exit(1)');
  });

  test('exits if owner is missing', () => {
    const { owner, ...rest } = VALID_ENTRY;
    expect(() => loadIntegrations(writeTempConfig([rest]))).toThrow('process.exit(1)');
  });

  test('exits if duplicate names are found', () => {
    expect(() => loadIntegrations(writeTempConfig([VALID_ENTRY, VALID_ENTRY]))).toThrow('process.exit(1)');
  });

  test('exits if allowedSlackUserIds is not an array', () => {
    const file = writeTempConfig([{ ...VALID_ENTRY, allowedSlackUserIds: 'U123' }]);
    expect(() => loadIntegrations(file)).toThrow('process.exit(1)');
  });

  test('exits if rateLimitPerHour is not a positive number', () => {
    const file = writeTempConfig([{ ...VALID_ENTRY, rateLimitPerHour: 0 }]);
    expect(() => loadIntegrations(file)).toThrow('process.exit(1)');
  });

  test('exits if triggers array is empty', () => {
    expect(() => loadIntegrations(writeTempConfig([{ ...VALID_ENTRY, triggers: [] }]))).toThrow('process.exit(1)');
  });

  test('exits if an unknown trigger is specified', () => {
    expect(() => loadIntegrations(writeTempConfig([{ ...VALID_ENTRY, triggers: ['magic'] }]))).toThrow('process.exit(1)');
  });
});
