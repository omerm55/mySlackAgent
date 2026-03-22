'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { loadIntegrations } = require('../src/loadIntegrations');

function writeTempConfig(data) {
  const file = path.join(os.tmpdir(), `integrations-test-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(data));
  return file;
}

// Capture process.exit calls without actually exiting
let exitSpy;
beforeEach(() => {
  exitSpy = jest.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Error(`process.exit(${code})`);
  });
});
afterEach(() => exitSpy.mockRestore());

describe('loadIntegrations', () => {
  test('loads a valid config successfully', () => {
    const file = writeTempConfig([
      {
        name: 'my-workflow',
        slackChannelId: 'C123',
        jiraFieldId: 'customfield_10000',
        jiraFieldValue: 'In Review',
        jiraFieldType: 'select',
        triggers: ['reply', 'reaction'],
      },
    ]);
    const result = loadIntegrations(file);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('my-workflow');
  });

  test('exits if file does not exist', () => {
    expect(() => loadIntegrations('/nonexistent/path.json')).toThrow('process.exit(1)');
  });

  test('exits if JSON is malformed', () => {
    const file = path.join(os.tmpdir(), `bad-${Date.now()}.json`);
    fs.writeFileSync(file, 'not json {{');
    expect(() => loadIntegrations(file)).toThrow('process.exit(1)');
  });

  test('exits if config is an empty array', () => {
    const file = writeTempConfig([]);
    expect(() => loadIntegrations(file)).toThrow('process.exit(1)');
  });

  test('exits if name is missing', () => {
    const file = writeTempConfig([{ slackChannelId: 'C123', jiraFieldId: 'f', jiraFieldValue: 'v', triggers: ['reply'] }]);
    expect(() => loadIntegrations(file)).toThrow('process.exit(1)');
  });

  test('exits if duplicate names are found', () => {
    const entry = { name: 'dupe', slackChannelId: 'C123', jiraFieldId: 'f', jiraFieldValue: 'v', triggers: ['reply'] };
    const file = writeTempConfig([entry, entry]);
    expect(() => loadIntegrations(file)).toThrow('process.exit(1)');
  });

  test('exits if triggers array is empty', () => {
    const file = writeTempConfig([{ name: 'w', slackChannelId: 'C123', jiraFieldId: 'f', jiraFieldValue: 'v', triggers: [] }]);
    expect(() => loadIntegrations(file)).toThrow('process.exit(1)');
  });

  test('exits if an unknown trigger is specified', () => {
    const file = writeTempConfig([{ name: 'w', slackChannelId: 'C123', jiraFieldId: 'f', jiraFieldValue: 'v', triggers: ['magic'] }]);
    expect(() => loadIntegrations(file)).toThrow('process.exit(1)');
  });
});
