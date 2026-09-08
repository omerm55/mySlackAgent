'use strict';

const axios = require('axios');

const SYSTEM_PROMPT = `You are a Jira automation assistant embedded in a Slack bot.
A Slack user has responded in free text to a yes/no question about updating a Jira issue.
Interpret their intent and return a JSON action.

The bot's proposed change is either (a) setting a field to a value, or (b) transitioning the issue to a status.

Primary action (choose one):
- "update_field": Apply the proposed field change. You may change the value if the user specifies something different.
- "transition": Move the issue to a status. Use when the proposed change is a transition and the user approves, or when the user asks to move it somewhere else (set "transitionTo" to that status name).
- "add_comment": Only add a comment, no field update or transition.
- "no_action": The user doesn't want the proposed change right now.

Optional extras (include alongside any primary action):
- "comment": a string — add this as a Jira comment (use when the user provides explanation, context, or asks to add a note)
- "assignee": a name or email string — assign the issue to this person (e.g. "Gaby", "gaby@company.com")

Respond ONLY with valid JSON (no markdown fences):
{
  "action": "update_field" | "transition" | "add_comment" | "no_action",
  "fieldValue": "<value to set, for update_field>",
  "transitionTo": "<target status name, for transition>",
  "comment": "<comment text>",
  "assignee": "<name or email of person to assign>",
  "confirmationMessage": "<one short sentence summarising what was done>"
}

Omit keys that don't apply. Always include confirmationMessage.`;

class LlmService {
  /**
   * @param {'anthropic'|'gemini'} provider
   * @param {string} apiKey
   */
  constructor(provider, apiKey) {
    this.provider = provider;
    this.apiKey = apiKey;
  }

  /**
   * Factory: pick provider from env vars. Returns null if no key is set.
   * Priority: OPENAI_API_KEY > GEMINI_API_KEY > ANTHROPIC_API_KEY
   */
  static fromEnv() {
    if (process.env.OPENAI_API_KEY) return new LlmService('openai', process.env.OPENAI_API_KEY);
    if (process.env.GEMINI_API_KEY) return new LlmService('gemini', process.env.GEMINI_API_KEY);
    if (process.env.ANTHROPIC_API_KEY) return new LlmService('anthropic', process.env.ANTHROPIC_API_KEY);
    return null;
  }

  async interpretJiraResponse({ issueKey, question, jiraFieldId, jiraFieldName, jiraFieldValue, jiraFieldType, transitionTo, userText }) {
    const proposed = transitionTo
      ? `Transition the issue to status "${transitionTo}"`
      : `Set field "${jiraFieldName}" (id: ${jiraFieldId}) to "${jiraFieldValue}" [type: ${jiraFieldType}]`;
    const userMessage =
      `Issue: ${issueKey}\n` +
      `Bot's question: "${question}"\n` +
      `Bot's proposed change: ${proposed}\n` +
      `User's response: "${userText}"\n\n` +
      `What action should be taken?`;

    const raw = this.provider === 'openai'
      ? await this._callOpenAI(userMessage)
      : this.provider === 'gemini'
        ? await this._callGemini(userMessage)
        : await this._callAnthropic(userMessage);

    const cleaned = raw.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    return JSON.parse(cleaned);
  }

  async _callOpenAI(userMessage) {
    const baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
    const model = process.env.OPENAI_DEPLOYMENT || process.env.OPENAI_MODEL || 'gpt-4o';
    const isAzure = Boolean(process.env.OPENAI_BASE_URL);
    console.log(`[llm] calling OpenAI provider — model: ${model}, endpoint: ${baseUrl}/chat/completions, azure: ${isAzure}`);
    const headers = {
      'content-type': 'application/json',
      ...(isAzure
        ? { 'api-key': this.apiKey }
        : { Authorization: `Bearer ${this.apiKey}` }),
    };
    try {
      const resp = await axios.post(
        `${baseUrl}/chat/completions`,
        {
          model,
          max_completion_tokens: 512,
          temperature: 0.1,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userMessage },
          ],
        },
        { headers, timeout: 15_000 }
      );
      return resp.data.choices[0].message.content;
    } catch (err) {
      if (err.response) {
        throw new Error(`OpenAI ${err.response.status}: ${JSON.stringify(err.response.data)}`);
      }
      throw err;
    }
  }

  async _callGemini(userMessage) {
    try {
      const resp = await axios.post(
        `https://generativelanguage.googleapis.com/v1/models/gemini-3.5-flash-lite:generateContent?key=${this.apiKey}`,
        {
          system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ role: 'user', parts: [{ text: userMessage }] }],
          generationConfig: { maxOutputTokens: 512, temperature: 0.1 },
        },
        { headers: { 'content-type': 'application/json' }, timeout: 15_000 }
      );
      return resp.data.candidates[0].content.parts[0].text;
    } catch (err) {
      if (err.response) {
        throw new Error(`Gemini ${err.response.status}: ${JSON.stringify(err.response.data)}`);
      }
      throw err;
    }
  }

  async _callAnthropic(userMessage) {
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
    return resp.data.content[0].text;
  }
}

module.exports = LlmService;
