import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Memory } from '../src/main/memory.js';
import { Settings } from '../src/main/store.js';
import { Skills } from '../src/main/skills.js';
import { scan, expand, isInside } from '../src/main/fsscan.js';
import { builtinTools, validateInput } from '../src/main/tools.js';
import { Agent, normalizeHistory } from '../src/main/agent.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-test-'));
const listen = (handler) => new Promise((resolve) => {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
});
const readBody = async (req) => { let b = ''; for await (const c of req) b += c; return JSON.parse(b); };

function makeAgent(dir, settingsPatch = {}) {
  const settings = new Settings(dir);
  settings.set(settingsPatch);
  const memory = new Memory(dir);
  const skills = new Skills(dir);
  const events = [];
  const ui = [];
  const agent = new Agent({
    settings, memory, skills,
    mcp: { status: () => [], tools: () => [] },
    getApiKey: () => 'test-key',
    emit: (e) => events.push(e),
    ui: (e) => ui.push(e),
    fsRoot: () => dir,
    openPath: async () => '',
  });
  return { agent, settings, memory, skills, events, ui };
}

test('memory: projects group nodes, digest lists them, forget removes them and scrubs history', () => {
  const dir = tmp();
  const m = new Memory(dir);
  m.createProject('Volleyball', 'the team');
  m.merge({ nodes: [{ label: 'Maya', type: 'person', summary: 'Setter.' }, { label: 'Serve Receive', type: 'topic', summary: 'Weak spot.' }], links: [{ from: 'Maya', to: 'Serve Receive', relation: 'works on' }] });
  m.logTurn('user', 'Maya is our setter');
  m.logTurn('assistant', 'Noted.');
  assert.match(m.digest(), /Project "Volleyball" \(active\)/);
  assert.match(m.digest(), /\[person\] Maya: Setter\./);
  assert.equal(m.find('maya').project, 'project:volleyball');
  assert.equal(m.neighbors(m.find('Maya').id).some((n) => n.node.label === 'Serve Receive'), true);

  // updating an existing label does not duplicate it
  m.merge({ nodes: [{ label: 'maya', type: 'person', summary: 'Setter, co-captain.' }] });
  assert.equal([...m.nodes.values()].filter((n) => n.label.toLowerCase() === 'maya').length, 1);
  assert.equal(m.find('Maya').summary, 'Setter, co-captain.');

  m.forget('Maya');
  assert.equal(m.find('Maya'), null);
  assert.doesNotMatch(m.digest(), /Maya/);
  assert.equal(m.history.some((h) => /maya/i.test(h.text)), false);

  // persisted
  const again = new Memory(dir);
  assert.equal(again.find('Serve Receive').type, 'topic');
  again.forget('Volleyball');
  assert.equal(again.find('Serve Receive'), null);
  assert.equal(again.activeProject, 'project:general');
  assert.equal(again.forget('General'), null, 'the General project cannot be removed');
});

test('memory: documents are written into the project folder', () => {
  const m = new Memory(tmp());
  m.createProject('Camp');
  const { file } = m.saveDocument('Camp', 'Day One', '# Day One\n\nWarm-up.');
  assert.equal(fs.readFileSync(file, 'utf8').includes('Warm-up'), true);
  assert.equal(m.readDocument(null, 'day one').content.startsWith('# Day One'), true);
  assert.equal(m.listDocuments('Camp').length, 1);
});

test('fsscan: bounded breadth-first scan, expansion, and root confinement', async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'a/b/c'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'node_modules/x'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'a/notes.md'), 'hi');
  fs.writeFileSync(path.join(dir, 'a/b/c/deep.py'), 'x');
  fs.writeFileSync(path.join(dir, '.hidden'), 'x');
  const res = await scan(dir, { maxDepth: 2 });
  const names = res.nodes.map((n) => n.name);
  assert.deepEqual(names.includes('notes.md') && names.includes('b'), true);
  assert.equal(names.includes('node_modules') || names.includes('.hidden') || names.includes('c'), false);
  const b = res.nodes.find((n) => n.name === 'b');
  assert.equal(b.more, 1, 'folder at the depth limit reports unseen children');
  assert.equal(res.nodes.find((n) => n.name === 'notes.md').kind, 'doc');
  const more = await expand(b.id, b.depth);
  assert.deepEqual(more.map((n) => [n.name, n.depth]), [['c', 3]]);
  assert.equal(isInside(dir, path.join(dir, 'a')), true);
  assert.equal(isInside(dir, path.join(dir, '..', 'elsewhere')), false);
});

test('tools: file tools refuse paths outside the root; input validation', async () => {
  const { agent, memory } = makeAgent(tmp());
  const tools = Object.fromEntries(agent.tools().map((t) => [t.name, t]));
  await assert.rejects(tools.read_file.run({ path: '/etc/passwd' }), /outside the folder/);
  await assert.rejects(tools.list_folder.run({ path: '../..' }), /outside the folder/);
  assert.match(await tools.remember.run({ label: 'Coffee', summary: 'Flat white.' , type: 'preference' }), /Remembered/);
  assert.match(await tools.recall.run({ query: 'coffee' }), /Flat white/);
  assert.match(await tools.forget.run({ label: 'coffee' }), /Forgot "Coffee"/);
  assert.equal(memory.find('Coffee'), null);
  assert.match(await tools.load_skill.run({ name: 'practice-planner' }), /Practice planner/);
  assert.equal(validateInput(tools.remember.schema, { label: 'x' }), 'missing required field "summary"');
  assert.match(validateInput(tools.remember.schema, { label: 3, summary: 's' }), /should be string/);
  assert.equal(validateInput(tools.remember.schema, { label: 'x', summary: 's' }), null);
  assert.equal(builtinTools({ memory, skills: null, settings: null, ui() {}, fsRoot: () => '/', openPath() {} }, { localWeb: true }).some((t) => t.name === 'web_search'), true);
});

test('normalizeHistory: merges same-role neighbours and starts with the user', () => {
  assert.deepEqual(normalizeHistory([{ role: 'assistant', text: 'a' }, { role: 'user', text: 'b' }, { role: 'user', text: 'c' }, { role: 'assistant', text: 'd' }]),
    [{ role: 'user', text: 'b\nc' }, { role: 'assistant', text: 'd' }]);
});

test('local brain (Ollama protocol): streams, runs tools, respects the internet switch, files memory', async () => {
  const bodies = [];
  const { server, url } = await listen(async (req, res) => {
    const b = await readBody(req);
    bodies.push(b);
    if (b.format) return res.end(JSON.stringify({ message: { content: JSON.stringify({ project: 'Spring Camp', nodes: [{ label: 'Day One', type: 'task', summary: 'First day of camp.' }], links: [] }) } }));
    if (b.messages.at(-1).role === 'tool') {
      res.write(`${JSON.stringify({ message: { content: '<think>secret</think>Saved' } })}\n${JSON.stringify({ message: { content: ', sir.' } })}\n`);
    } else {
      res.write(`${JSON.stringify({ message: { content: 'One moment. ' } })}\n`);
      res.write(`${JSON.stringify({ message: { content: '', tool_calls: [{ function: { name: 'save_document', arguments: { title: 'Plan', content: '# Plan' } } }] } })}\n`);
    }
    res.end(`${JSON.stringify({ done: true })}\n`);
  });
  const { agent, memory, events, ui, settings } = makeAgent(tmp(), { provider: 'local', ollamaUrl: url, localModel: 'fake', webSearch: false });
  const result = await agent.send('make a plan');
  assert.equal(result.text, 'One moment. Saved, sir.');
  assert.equal(events.filter((e) => e.type === 'tool')[0].name, 'save_document');
  assert.equal(ui.some((e) => e.type === 'document'), true);
  assert.equal(memory.readDocument(null, 'Plan').content, '# Plan');
  assert.deepEqual(memory.recentTurns().map((t) => t.role), ['user', 'assistant']);
  const toolNames = bodies[0].tools.map((t) => t.function.name);
  assert.equal(toolNames.includes('web_search'), false, 'no web tools when internet is off');
  assert.match(bodies[0].messages[0].content, /Internet access is switched off/);
  assert.equal(bodies[1].messages.at(-1).role, 'tool');

  await new Promise((r) => setTimeout(r, 200)); // background memory filing
  assert.equal(memory.find('Day One').project, 'project:spring-camp');

  settings.set({ webSearch: true });
  await agent.send('again');
  assert.equal(bodies.filter((b) => b.tools).at(-1).tools.some((t) => t.function.name === 'web_search'), true);
  server.close();
});

test('local brain: an interrupted reply is recorded as cut off on the next turn', async () => {
  const { server, url } = await listen(async (req, res) => {
    const b = await readBody(req);
    if (b.format) return res.end(JSON.stringify({ message: { content: '{"project":"","nodes":[],"links":[]}' } }));
    res.write(`${JSON.stringify({ message: { content: 'First sentence. ' } })}\n`);
    if (b.messages.at(-1).content.includes('slow')) await new Promise((r) => setTimeout(r, 2000));
    res.end(`${JSON.stringify({ message: { content: 'Second.' } })}\n`);
  });
  const { agent, memory } = makeAgent(tmp(), { provider: 'local', ollamaUrl: url, localModel: 'fake' });
  const slow = agent.send('slow one');
  await new Promise((r) => setTimeout(r, 300));
  const next = agent.send('never mind', { interrupted: 'First sentence.' });
  assert.equal((await slow).aborted, true);
  assert.equal((await next).text, 'First sentence. Second.');
  assert.deepEqual(memory.recentTurns().map((t) => t.text), ['slow one', 'First sentence. — (cut off by the user)', 'never mind', 'First sentence. Second.']);
  server.close();
});

test('cloud brain with an API key (Anthropic SDK against a stub): request shape and tool loop', async () => {
  const bodies = [];
  const headers = [];
  const sse = (res, events) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    res.end();
  };
  const start = { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } };
  const text = (index, t) => [
    { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index, delta: { type: 'text_delta', text: t } },
    { type: 'content_block_stop', index },
  ];
  const end = (stop_reason) => [{ type: 'message_delta', delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: 5 } }, { type: 'message_stop' }];
  const { server, url } = await listen(async (req, res) => {
    const b = await readBody(req);
    bodies.push(b);
    headers.push(req.headers);
    if (!b.stream) { // background extraction
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ id: 'msg_x', type: 'message', role: 'assistant', model: b.model, stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: '{"project":"","nodes":[{"label":"Budget","type":"fact","summary":"Twelve thousand."}],"links":[]}' }] }));
    }
    if (b.messages.at(-1).role === 'user' && Array.isArray(b.messages.at(-1).content)) return sse(res, [start, ...text(0, 'Noted, sir.'), ...end('end_turn')]);
    return sse(res, [start, ...text(0, 'Right away.'),
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'remember', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"label":"Budget","summary":"Twelve ' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'thousand."}' } },
      { type: 'content_block_stop', index: 1 }, ...end('tool_use')]);
  });
  const saved = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_BASE_URL = url;
  try {
    const { agent, memory, events } = makeAgent(tmp(), { provider: 'cloud', cloudAuth: 'key', webSearch: true });
    const result = await agent.send('remember the budget is twelve thousand');
    assert.equal(result.error, '');
    assert.equal(result.text, 'Right away. Noted, sir.');
    assert.equal(memory.find('Budget').summary, 'Twelve thousand.');
    assert.equal(events.some((e) => e.type === 'tool' && e.name === 'remember'), true);

    const first = bodies[0];
    assert.equal(first.model, 'claude-opus-5-5');
    assert.deepEqual(first.output_config, { effort: 'low' });
    assert.equal(first.fallbacks, 'default');
    assert.match(headers[0]['anthropic-beta'], /server-side-fallback-2026-07-01/);
    assert.equal(first.thinking, undefined);
    assert.equal(first.system[0].cache_control.type, 'ephemeral');
    assert.equal(first.tools.some((t) => t.type === 'web_search_20260209'), true);
    assert.equal(first.tools.find((t) => t.name === 'remember').eager_input_streaming, true);
    const second = bodies[1];
    assert.equal(second.messages.at(-2).content.some((c) => c.type === 'tool_use'), true, 'assistant turn passed back intact');
    assert.equal(second.messages.at(-1).content[0].type, 'tool_result');
    assert.match(second.messages.at(-1).content[0].content, /Remembered/);

    await new Promise((r) => setTimeout(r, 300));
    const extract = bodies.find((b) => !b.stream);
    assert.equal(extract.model, 'claude-haiku-5-5');
    assert.equal(extract.output_config.format.type, 'json_schema');
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = saved;
    server.close();
  }
});
