// Cloud brain: Claude via the Anthropic SDK, streaming, with a manual tool loop.
// The loop is hand-rolled because tools run on this machine (files, MCP servers, the UI)
// and speech needs every text delta the moment it arrives, plus instant cancellation.
import Anthropic from '@anthropic-ai/sdk';
import { validateInput } from '../tools.js';

export const CLOUD_MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (fastest)' },
  { id: 'claude-fable-5-2', label: 'Claude Fable 5.2 (most capable)' },
];
const EXTRACT_MODEL = 'claude-haiku-5-5';
// Models whose safety classifiers can decline a request; let the API re-run those on a fallback model.
const SERVER_FALLBACK = new Set(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-2']);
const MAX_STEPS = 24;

function client(apiKey) {
  return new Anthropic({ apiKey, maxRetries: 2 });
}

function webTools(model) {
  const v = /haiku/.test(model) ? ['web_search_20250305', 'web_fetch_20250910'] : ['web_search_20260209', 'web_fetch_20260209'];
  return [
    { type: v[0], name: 'web_search', max_uses: 6 },
    { type: v[1], name: 'web_fetch', max_uses: 6 },
  ];
}

export function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError) return 'The Anthropic API key was rejected. Check it in the Brain settings.';
  if (err instanceof Anthropic.PermissionDeniedError) return 'That API key is not allowed to use this model.';
  if (err instanceof Anthropic.NotFoundError) return 'That model was not found for this API key.';
  if (err instanceof Anthropic.RateLimitError) return 'The cloud model is rate limited right now. Give it a moment.';
  if (err instanceof Anthropic.APIConnectionError) return 'I could not reach the cloud model. Check the internet connection, or switch me to the local model.';
  if (err instanceof Anthropic.APIError) return `The cloud model returned an error: ${err.message}`;
  return err?.message || String(err);
}

export function isAbort(err) {
  return err instanceof Anthropic.APIUserAbortError || err?.name === 'AbortError';
}

/**
 * Run one user turn to completion.
 * @param o {apiKey, model, effort, system:{stable,volatile}, history:[{role,text}], userText, tools, webSearch, emit, signal}
 * @returns {Promise<string>} everything Jarvis said this turn
 */
export async function runAnthropicTurn({ apiKey, model, effort, system, history, userText, tools, webSearch, emit, signal }) {
  const anthropic = client(apiKey);
  const byName = new Map(tools.map((t) => [t.name, t]));
  const apiTools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema, eager_input_streaming: true }));
  if (webSearch) apiTools.push(...webTools(model));

  const messages = [...history.map((h) => ({ role: h.role, content: h.text })), { role: 'user', content: userText }];
  let spoken = '';
  let jsonRetries = 0;

  for (let step = 0; step < MAX_STEPS; step++) {
    const params = {
      model,
      max_tokens: 16000,
      system: [
        { type: 'text', text: system.stable, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: system.volatile },
      ],
      messages,
      tools: apiTools,
      output_config: { effort },
    };
    if (SERVER_FALLBACK.has(model)) {
      params.betas = ['server-side-fallback-2026-07-01'];
      params.fallbacks = 'default';
    }

    let turnText = '';
    let message;
    try {
      const stream = anthropic.beta.messages.stream(params, { signal });
      stream.on('text', (delta) => {
        turnText += delta;
        emit({ type: 'delta', text: delta });
      });
      stream.on('streamEvent', (event) => {
        if (event.type === 'content_block_start' && (event.content_block.type === 'tool_use' || event.content_block.type === 'server_tool_use')) {
          emit({ type: 'tool', name: event.content_block.name });
        }
      });
      message = await stream.finalMessage();
    } catch (err) {
      // With eager input streaming a malformed tool input surfaces as a plain (non-API) error. Re-issue the turn.
      if (err instanceof Anthropic.APIError || isAbort(err) || jsonRetries >= 2) throw err;
      jsonRetries++;
      if (turnText) emit({ type: 'retract', text: turnText });
      continue;
    }
    spoken += turnText;

    if (message.stop_reason === 'refusal') {
      const line = spoken ? '' : "I'm afraid that's not something I can help with.";
      if (line) emit({ type: 'delta', text: line });
      return spoken + line;
    }
    if (message.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: message.content });
      continue;
    }

    const calls = message.content.filter((b) => b.type === 'tool_use');
    if (!calls.length) return spoken;
    if (message.stop_reason === 'max_tokens') throw new Error('The reply was cut off while preparing a tool call.');

    // Pass the assistant turn back exactly as received (thinking blocks included), then all results in one user message.
    messages.push({ role: 'assistant', content: message.content });
    const results = await Promise.all(calls.map(async (call) => {
      const tool = byName.get(call.name);
      const problem = tool ? validateInput(tool.schema, call.input) : `unknown tool ${call.name}`;
      if (problem) return { type: 'tool_result', tool_use_id: call.id, is_error: true, content: `Invalid tool input: ${problem}` };
      try {
        const out = await tool.run(call.input);
        return { type: 'tool_result', tool_use_id: call.id, content: String(out).slice(0, 60000) };
      } catch (err) {
        return { type: 'tool_result', tool_use_id: call.id, is_error: true, content: err?.message || String(err) };
      }
    }));
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    messages.push({ role: 'user', content: results });
    if (spoken && !/\s$/.test(spoken)) {
      spoken += ' ';
      emit({ type: 'delta', text: ' ' });
    }
  }
  return spoken;
}

/** One-shot structured extraction (used by the background memory builder). */
export async function extractJsonAnthropic({ apiKey, system, user, schema }) {
  const res = await client(apiKey).messages.create({
    model: EXTRACT_MODEL,
    max_tokens: 4000,
    system,
    messages: [{ role: 'user', content: user }],
    output_config: { effort: 'low', format: { type: 'json_schema', schema } },
  });
  if (res.stop_reason !== 'end_turn') return null;
  const text = res.content.find((b) => b.type === 'text')?.text;
  return text ? JSON.parse(text) : null;
}
