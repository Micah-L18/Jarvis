// Local brain: any tool-capable model served by Ollama on this machine. Nothing leaves the computer.

const MAX_STEPS = 16;

async function* ndjson(body) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) yield JSON.parse(line);
    }
  }
  if (buf.trim()) yield JSON.parse(buf);
}

/** Drops <think>…</think> spans from a token stream (some local models reason inline). */
function thinkFilter(emitText) {
  let buf = '';
  let thinking = false;
  return (delta, flush = false) => {
    buf += delta;
    let out = '';
    for (;;) {
      const tag = thinking ? '</think>' : '<think>';
      const at = buf.indexOf(tag);
      if (at >= 0) {
        if (!thinking) out += buf.slice(0, at);
        buf = buf.slice(at + tag.length);
        thinking = !thinking;
        continue;
      }
      // keep back anything that could be the start of a tag
      let keep = 0;
      for (let k = Math.min(tag.length - 1, buf.length); k > 0; k--) if (tag.startsWith(buf.slice(-k))) { keep = k; break; }
      if (flush) keep = 0;
      if (!thinking) out += buf.slice(0, buf.length - keep);
      buf = buf.slice(buf.length - keep);
      break;
    }
    if (out) emitText(out);
  };
}

export async function listOllamaModels(baseUrl) {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/tags`, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`Ollama answered ${res.status}`);
  return ((await res.json()).models || []).map((m) => m.name);
}

export function describeOllamaError(err, baseUrl) {
  if (err?.cause?.code === 'ECONNREFUSED' || /fetch failed/i.test(err?.message || '')) {
    return `I can't reach the local model. Is Ollama running at ${baseUrl}?`;
  }
  return err?.message || String(err);
}

async function chat(baseUrl, body, signal) {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const err = new Error(`Ollama error ${res.status}: ${detail.slice(0, 300)}`);
    err.noTools = /does not support tools/i.test(detail);
    throw err;
  }
  return res;
}

/**
 * Run one user turn to completion against Ollama.
 * @param o {baseUrl, model, system (string), history, userText, tools, emit, signal}
 */
export async function runOllamaTurn({ baseUrl, model, system, history, userText, tools, emit, signal }) {
  if (!model) throw new Error('No local model selected. Pick one in the Brain settings (for example: ollama pull qwen3).');
  const byName = new Map(tools.map((t) => [t.name, t]));
  let apiTools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } }));
  const messages = [
    { role: 'system', content: system },
    ...history.map((h) => ({ role: h.role, content: h.text })),
    { role: 'user', content: userText },
  ];
  let spoken = '';

  for (let step = 0; step < MAX_STEPS; step++) {
    let res;
    try {
      res = await chat(baseUrl, { model, messages, stream: true, ...(apiTools.length ? { tools: apiTools } : {}) }, signal);
    } catch (err) {
      if (err.noTools && apiTools.length) {
        apiTools = []; // this model can only talk; carry on without tools
        emit({ type: 'notice', text: `${model} does not support tools, so skills, memory tools and connections are unavailable with it.` });
        step--;
        continue;
      }
      throw err;
    }

    let content = '';
    const calls = [];
    const push = thinkFilter((text) => {
      content += text;
      emit({ type: 'delta', text });
    });
    for await (const part of ndjson(res.body)) {
      if (part.error) throw new Error(part.error);
      if (part.message?.content) push(part.message.content);
      for (const call of part.message?.tool_calls || []) {
        calls.push(call);
        emit({ type: 'tool', name: call.function?.name });
      }
    }
    push('', true);
    spoken += content;
    if (!calls.length) return spoken;

    messages.push({ role: 'assistant', content, tool_calls: calls });
    for (const call of calls) {
      const name = call.function?.name;
      let args = call.function?.arguments ?? {};
      if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch { args = {}; }
      }
      const tool = byName.get(name);
      let out;
      try {
        out = tool ? await tool.run(args) : `Unknown tool ${name}`;
      } catch (err) {
        out = `Error: ${err?.message || err}`;
      }
      messages.push({ role: 'tool', tool_name: name, content: String(out).slice(0, 24000) });
    }
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    if (spoken && !/\s$/.test(spoken)) {
      spoken += ' ';
      emit({ type: 'delta', text: ' ' });
    }
  }
  return spoken;
}

export async function extractJsonOllama({ baseUrl, model, system, user, schema }) {
  const res = await chat(baseUrl, {
    model,
    stream: false,
    format: schema,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  }, AbortSignal.timeout(120000));
  const text = (await res.json()).message?.content || '';
  return JSON.parse(text.replace(/<think>[\s\S]*?<\/think>/g, '').trim());
}
