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

const FIX_VERSION_PROMPT = `You are a Jira release-planning assistant.
An epic must be given a Fix Version before it can be closed. You are given:
- the epic, the status it is in, and the date it entered that status (its work was complete by then)
- its child issues with their statuses and fix versions, plus a tally of those versions
- "timelineFit": the release whose branch-out window contains the date the epic entered its status
  (releases are worked on during their branch-out window, so work finished then ships in that release)
- "current": the release whose branch-out window contains today
- the list of candidate versions that exist in the project

Choose the single most appropriate Fix Version for the epic, weighing evidence in this order:
1. The children's actual fix versions are the strongest evidence of where the code landed. If they
   span several versions, the epic ships with the LAST of them.
2. Otherwise the timelineFit release: work finished on date D ships in the release being worked on at D.
3. Otherwise the current release.
Only pick from the candidates list and answer with the candidate's "id".

Respond ONLY with valid JSON (no markdown fences):
{ "versionId": "<candidate id>", "reason": "<one short sentence a PM would find useful, mention the evidence used>" }`;

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

    return this._callJson(SYSTEM_PROMPT, userMessage);
  }

  /**
   * Pick a Fix Version for an epic from its children.
   * @returns {Promise<{ versionId: string, reason: string }>}
   */
  async suggestFixVersion({ epicKey, epicSummary, statusName, acceptedAt, today, timelineFit, current, children, tally, candidates }) {
    const userMessage =
      `Epic: ${epicKey} — ${epicSummary}\n` +
      `Status: ${statusName || 'unknown'}${acceptedAt ? ` (entered on ${acceptedAt})` : ''}\n` +
      `Today: ${today}\n` +
      `timelineFit: ${timelineFit ? `id=${timelineFit.id} name="${timelineFit.name}" (branch-out window ${timelineFit.branchOut})` : 'unknown'}\n` +
      `current: ${current ? `id=${current.id} name="${current.name}"` : 'unknown'}\n\n` +
      `Children (${children.length}):\n` +
      children.map((c) => `- ${c.key} [${c.status}] fixVersions=${c.fixVersions.length ? c.fixVersions.join(', ') : 'none'} — ${c.summary}`).join('\n') +
      `\n\nTally of children's versions: ${tally.length ? tally.map((t) => `${t.name}×${t.count}`).join(', ') : 'none'}\n\n` +
      `Candidate versions:\n` +
      candidates.map((v) => `- id=${v.id} name="${v.name}" ${v.released ? 'released' : 'unreleased'}${v.releaseDate ? ` (${v.releaseDate})` : ''}`).join('\n') +
      `\n\nWhich candidate should be the epic's Fix Version?`;
    return this._callJson(FIX_VERSION_PROMPT, userMessage);
  }

  async _callJson(systemPrompt, userMessage) {
    const raw = this.provider === 'openai'
      ? await this._callOpenAI(systemPrompt, userMessage)
      : this.provider === 'gemini'
        ? await this._callGemini(systemPrompt, userMessage)
        : await this._callAnthropic(systemPrompt, userMessage);

    const cleaned = raw.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    return JSON.parse(cleaned);
  }

  async _callOpenAI(systemPrompt, userMessage) {
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
            { role: 'system', content: systemPrompt },
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

  async _callGemini(systemPrompt, userMessage) {
    try {
      const resp = await axios.post(
        `https://generativelanguage.googleapis.com/v1/models/gemini-3.5-flash-lite:generateContent?key=${this.apiKey}`,
        {
          system_instruction: { parts: [{ text: systemPrompt }] },
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

  async _callAnthropic(systemPrompt, userMessage) {
    const resp = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 512,
        system: systemPrompt,
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
