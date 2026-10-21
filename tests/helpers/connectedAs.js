'use strict';

// Writes are made only with the person's own token (SNS-133715, condition 3), so a test that expects a
// write needs a connected user. This oauthService says everyone is connected and hands back `jira` as
// their client, so assertions on `jira` keep meaning "the write happened — as the person".
function connectedAs(jira) {
  return {
    hasToken: jest.fn(() => true),
    getJiraService: jest.fn().mockResolvedValue(jira),
    generateAuthUrl: jest.fn().mockResolvedValue('https://auth?state=t'),
  };
}

module.exports = { connectedAs };
