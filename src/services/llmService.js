'use strict';

const axios = require('axios');

const SYSTEM_PROMPT = `You are a Jira automation assistant embedded in a Slack bot.
A Slack user has responded in free text to a yes/no question about updating a Jira issue.
Interpret their intent and return a JSON action.

Available actions:
- "update_field": Update the proposed Jira field. You may adjust the value if the user specifies something different from what was proposed.
- "add_comment": Add a comment to the Jira issue (use when the user provides context or explanation without wanting a field change).
- "no_action": The user doesn't want any change right now.

You may combine update_field + add_comment by setting action to "update_field" and also including a "comment" key.

Respond ONLY with valid JSON in this exact format (no markdown fences):
{
  "action": "update_field" | "add_comment" | "no_action",
  "fieldValue": "<value to set>",
  "comment": "<comment text to add to the Jira issue>",
  "confirmationMessage": "<one short sentence to show the Slack user, e.g. Done — updated X to Y>"
}

Omit keys that don't apply. Always include confirmationMessage.`;

class LlmService {
  constructor(apiKey) {
    this.apiKey = apiKey;
  }

  /**
   * Given the bot's question and the user's free-text response, return a
   * structured action to execute on the Jira issue.
   */
  async interpretJiraResponse({ issueKey, question, jiraFieldId, jiraFieldName, jiraFieldValue, jiraFieldType, userText }) {
    const userMessage =
      `Issue: ${issueKey}\n` +
      `Bot's question: "${question}"\n` +
      `Bot's proposed change: Set field "${jiraFieldName}" (id: ${jiraFieldId}) to "${jiraFieldValue}" [type: ${jiraFieldType}]\n` +
      `User's response: "${userText}"\n\n` +
      `What action should be taken?`;

    const resp = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 512,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }],
      },
      {
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        timeout: 15_000,
      }
    );

    const raw = resp.data.content[0].text.trim()
      .replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    return JSON.parse(raw);
  }
}

module.exports = LlmService;
