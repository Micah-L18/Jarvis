import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ClaudeCli, CliError, describeCliError, claudeEnv, candidatePaths, composePrompt, exposeTools, sessionOptions, MIN_VERSION } from '../src/main/llm/claudecli.js';
import { Memory, tellingWords, mentions } from '../src/main/memory.js';
import { Settings } from '../src/main/store.js';
import { Skills } from '../src/main/skills.js';
import { Agent } from '../src/main/agent.js';
import { claudeLogin, brainChip } from '../src/renderer/brain.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-cli-test-'));
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const never = new Promise(() => {});

// ---- the CLI's messages, as the Agent SDK hands them over -------------------------------------

const ev = (event, parent = null) => ({ type: 'stream_event', event, parent_tool_use_id: parent });
const say = (text) => ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
const calls = (name) => ev({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', name, input: {} } });
const stop = ev({ type: 'message_stop' });
const toolResult = { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'ok' }] }] } };
const done = (extra = {}) => ({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', result: '', ...extra });
const init = (o) => ({
  type: 'system', subtype: 'init', model: o.model, permissionMode: o.permissionMode, apiKeySource: 'none', claude_code_version: '2.1.332',
  tools: [...o.tools, ...(o.outputFormat ? ['StructuredOutput'] : [])],
  mcp_servers: Object.keys(o.mcpServers).map((name) => ({ name, status: 'connected', source: 'sdk' })),
});
const cliSays = (error, text) => ({ type: 'assistant', error, message: { role: 'assistant', content: [{ type: 'text', text }] } });

/** A client on the in-process tool server, as the CLI would have. */
async function toolClient(options) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await options.mcpServers.jarvis.instance.connect(a);
  const client = new Client({ name: 'fake-cli', version: '1' });
  await client.connect(b);
  return client;
}

/** Stands in for the Agent SDK. `script(run)` is an async generator of the messages one process emits. */
function fakeSdk(script) {
  const runs = [];
  const start = (how, options, prompt) => {
    const run = { how, options, prompt, closed: false };
    runs.push(run);
    return Object.assign(script(run), { close() { run.closed = true; } });
  };
  const spares = [];
  return {
    runs, spares,
    query: ({ prompt, options }) => start('query', options, prompt),
    startup: async ({ options }) => {
      const spare = { options, closed: false, used: false };
      spares.push(spare);
      return { query: (prompt) => { spare.used = true; return start('spare', options, prompt); }, close() { spare.closed = true; } };
    },
  };
}

const found = { path: '/usr/local/bin/claude', source: 'installed', version: '2.1.332' };
function makeCli(script, { locate = async () => found, auth = { ok: true, stdout: '{"loggedIn":true,"authMethod":"claude.ai"}' } } = {}) {
  const sdk = fakeSdk(script);
  const statuses = [];
  const cli = new ClaudeCli({
    workDir: path.join(tmp(), 'claude'), sdk, locate, onStatus: (s) => statuses.push(s.state),
    env: claudeEnv({ PATH: '/bin', ANTHROPIC_API_KEY: 'sk-test', ANTHROPIC_AUTH_TOKEN: 't', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli' }),
    exec: async (_file, args) => (args[0] === 'auth' ? auth : { ok: true, stdout: `${found.version} (Claude Code)` }),
  });
  return { cli, sdk, statuses };
}

const remembered = [];
const tools = [
  { name: 'remember', description: 'Store something.', schema: { type: 'object', properties: { label: { type: 'string' }, summary: { type: 'string' } }, required: ['label', 'summary'], additionalProperties: false }, run: async (i) => { remembered.push(i); return `Remembered "${i.label}".`; } },
  { name: 'read_file', description: 'Read a file.', schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }, run: async () => { throw new Error('That is outside the folder I am allowed to see.'); } },
  { name: 'mcp__calendar__list_events', description: '[calendar] List events', schema: { type: 'object', properties: {} }, run: async () => 'x'.repeat(70000) },
];
const turn = (extra = {}) => ({
  model: 'claude-opus-5-5', effort: 'low', system: { stable: 'You are JARVIS.', volatile: 'What you know\n  - [person] Maya: Setter.' },
  history: [{ role: 'user', text: 'hello' }, { role: 'assistant', text: 'Good evening, sir.' }], userText: 'remember the budget', tools, webSearch: false, ...extra,
});

// ---- tests ------------------------------------------------------------------------------------

test('claude cli: a turn maps the CLI stream to the same events as the API path and runs Jarvis tools in-process', async () => {
  const toolAnswers = {};
  const { cli, sdk } = makeCli(async function* (run) {
    yield init(run.options);
    yield ev({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } });
    yield say('Right ');
    yield say('away.');
    yield calls('mcp__jarvis__remember');
    yield calls('mcp__jarvis__calendar__list_events');
    yield ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'a nested call talking' } }, 'toolu_nested');
    const client = await toolClient(run.options);
    toolAnswers.list = (await client.listTools()).tools;
    toolAnswers.good = await client.callTool({ name: 'remember', arguments: { label: 'Budget', summary: 'Twelve thousand.' } });
    toolAnswers.bad = await client.callTool({ name: 'remember', arguments: { label: 'Budget' } });
    toolAnswers.threw = await client.callTool({ name: 'read_file', arguments: { path: '/etc/passwd' } });
    toolAnswers.unknown = await client.callTool({ name: 'Bash', arguments: { command: 'ls' } });
    toolAnswers.long = await client.callTool({ name: 'calendar__list_events', arguments: {} });
    yield stop;
    yield toolResult;
    yield say('Noted, sir.');
    yield stop;
    yield done();
    yield say('never read: the turn ended at the result');
  });
  const events = [];
  const text = await cli.runTurn(turn({ emit: (e) => events.push(e) }));
  assert.equal(text, 'Right away. Noted, sir.');
  assert.deepEqual(events, [
    { type: 'delta', text: 'Right ' }, { type: 'delta', text: 'away.' },
    { type: 'tool', name: 'remember' }, { type: 'tool', name: 'mcp__calendar__list_events' },
    { type: 'delta', text: ' ' }, { type: 'delta', text: 'Noted, sir.' },
  ]);

  // tools: Jarvis's own, by JSON schema, validated and answered the way the API path does it
  assert.deepEqual(toolAnswers.list.map((t) => t.name), ['remember', 'read_file', 'calendar__list_events']);
  assert.deepEqual(toolAnswers.list[0].inputSchema.required, ['label', 'summary']);
  assert.equal(toolAnswers.good.content[0].text, 'Remembered "Budget".');
  assert.deepEqual(remembered, [{ label: 'Budget', summary: 'Twelve thousand.' }]);
  assert.equal(toolAnswers.bad.isError, true);
  assert.equal(toolAnswers.bad.content[0].text, 'Invalid tool input: missing required field "summary"');
  assert.equal(toolAnswers.threw.isError, true);
  assert.match(toolAnswers.threw.content[0].text, /outside the folder/);
  assert.match(toolAnswers.unknown.content[0].text, /Invalid tool input: unknown tool Bash/);
  assert.equal(toolAnswers.long.content[0].text.length, 60000);

  // the process is told everything in the prompt, and nothing is left running
  const run = sdk.runs[0];
  assert.equal(run.prompt, '[Context for this turn — supplied by the app]\nWhat you know\n  - [person] Maya: Setter.\n\n[Conversation so far]\nUser: hello\nJarvis: Good evening, sir.\n\n[Just said]\nremember the budget');
  assert.match(run.options.systemPrompt, /^You are JARVIS\.\n\nHow messages reach you/);
  assert.equal(run.closed, true);
  assert.equal(composePrompt({ volatile: 'v', history: [], userText: '/clear' }), '[Context for this turn — supplied by the app]\nv\n\n[Just said]\n/clear');
});

test('claude cli: only Jarvis tools reach the model; web tools only with the Internet switch; nothing of Claude Code', async () => {
  const { cli, sdk } = makeCli(async function* (run) {
    yield init(run.options);
    if (run.options.tools.includes('WebSearch')) {
      yield say('Let me look. ');
      yield ev({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', name: 'WebSearch', input: {} } });
      yield stop;
      yield toolResult;
      for (const t of ['Node 26', ' is current.', '\n\nSo', 'me say 24.', '\n', '\nSour', 'ces:\n- [Node](https://nodejs.org)', '\n- more']) yield say(t);
      yield stop;
    } else yield say('Offline.');
    yield done();
  });
  const off = [];
  assert.equal(await cli.runTurn(turn({ emit: (e) => off.push(e) })), 'Offline.');
  const o = sdk.runs[0].options;
  assert.deepEqual(o.tools, [], 'none of Claude Code\'s own tools');
  assert.deepEqual(o.allowedTools, ['mcp__jarvis']);
  for (const name of ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Task', 'Agent', 'Skill', 'NotebookEdit', 'WebSearch', 'WebFetch']) assert.equal(o.disallowedTools.includes(name), true, `${name} is refused by name`);
  assert.deepEqual(Object.keys(o.mcpServers), ['jarvis']);
  assert.equal(o.mcpServers.jarvis.type, 'sdk');
  assert.deepEqual([o.settingSources, o.skills, o.plugins], [[], [], []]);
  assert.deepEqual([o.strictMcpConfig, o.verbatimPrompts, o.persistSession, o.permissionMode, o.title], [true, true, false, 'dontAsk', 'Jarvis']);
  assert.deepEqual([o.model, o.effort, o.maxTurns, o.includePartialMessages], ['claude-opus-5-5', 'low', 24, true]);
  assert.equal(o.pathToClaudeCodeExecutable, '/usr/local/bin/claude');
  assert.equal(o.cwd, cli.workDir);
  assert.equal(fs.readdirSync(o.cwd).length, 0, 'an empty folder of its own');
  assert.equal(o.env.PATH, '/bin');
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT']) assert.equal(key in o.env, false, `${key} is not passed on`);
  assert.deepEqual([o.env.ENABLE_CLAUDEAI_MCP_SERVERS, o.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS, o.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY], ['false', '1', '1']);
  assert.doesNotMatch(o.systemPrompt, /Sources/);
  for (const key of ['hooks', 'agents', 'resume', 'continue', 'canUseTool', 'additionalDirectories', 'settings']) assert.equal(key in o, false);

  const on = [];
  const text = await cli.runTurn(turn({ webSearch: true, emit: (e) => on.push(e) }));
  const w = sdk.runs[1].options;
  assert.deepEqual(w.tools, ['WebSearch', 'WebFetch']);
  assert.deepEqual(w.allowedTools, ['WebSearch', 'WebFetch', 'mcp__jarvis']);
  assert.equal(w.disallowedTools.includes('WebSearch') || w.disallowedTools.includes('WebFetch'), false);
  assert.equal(w.disallowedTools.includes('Bash'), true);
  assert.match(w.systemPrompt, /Never finish with a list of sources or links/);
  assert.equal(on.find((e) => e.type === 'tool').name, 'web_search', 'reported under the API path\'s name');
  assert.equal(text, 'Let me look. Node 26 is current.\n\nSome say 24.', 'the list of links the search tool asks for is not spoken');
  assert.equal(on.filter((e) => e.type === 'delta').map((e) => e.text).join(''), text);

  // no tools at all: no server either
  assert.deepEqual(sessionOptions({ model: 'm', system: 's', defs: [], webSearch: false }).mcpServers, {});
  assert.deepEqual(sessionOptions({ model: 'm', system: 's', defs: [], webSearch: false }).allowedTools, []);
  // a connection's tool keeps a name the API accepts under the mcp__jarvis__ prefix
  const long = exposeTools([{ name: `mcp__srv__${'x'.repeat(70)}` }, { name: `mcp__srv__${'x'.repeat(71)}` }]);
  assert.equal(long.every((d) => `mcp__jarvis__${d.name}`.length <= 64), true);
  assert.notEqual(long[0].name, long[1].name);
});

test('claude cli: a CLI that offers anything else is stopped before the model can use it', async () => {
  let controller;
  const { cli } = makeCli(async function* (run) {
    controller = run.options.abortController;
    yield { ...init(run.options), tools: ['mcp__jarvis__remember', 'Bash'] };
    yield say('rm -rf');
    yield done();
  });
  const events = [];
  const err = await cli.runTurn(turn({ emit: (e) => events.push(e) })).catch((e) => e);
  assert.equal(err.kind, 'unsafe');
  assert.match(err.message, /Bash/);
  assert.equal(controller.signal.aborted, true);
  assert.deepEqual(events, []);
  assert.match(describeCliError(err), /tools I did not ask for/);

  const other = makeCli(async function* (run) {
    yield { ...init(run.options), mcp_servers: [{ name: 'jarvis' }, { name: 'github' }] };
    yield done();
  });
  assert.equal((await other.cli.runTurn(turn()).catch((e) => e)).kind, 'unsafe');
});

test('claude cli: the spare serves one turn, the next is started at once, and it is dropped when what it was started for changes', async () => {
  const { cli, sdk } = makeCli(async function* (run) {
    yield init(run.options);
    yield say(`from ${run.how}`);
    yield done();
  });
  await cli.prewarm(turn());
  await cli.prewarm(turn()); // nothing changed: the same spare
  assert.equal(sdk.spares.length, 1);
  assert.equal(await cli.runTurn(turn()), 'from spare');
  await tick();
  assert.equal(sdk.spares.length, 2, 'the one for the next turn');
  assert.equal(sdk.spares[0].used, true);

  // memory, history and what was said are not part of a spare: it still fits
  assert.equal(await cli.runTurn(turn({ system: { stable: 'You are JARVIS.', volatile: 'What you know\n(nothing remembered yet)' }, history: [], userText: 'who is Maya?' })), 'from spare');
  assert.equal(sdk.runs.at(-1).prompt.includes('Maya: Setter'), false);
  await tick();

  // model, effort, the Internet switch, the persona or the tool list: any change and the spare is closed, not used
  for (const change of [{ model: 'claude-haiku-5-5' }, { effort: 'high' }, { webSearch: true }, { system: { stable: 'You are JARVIS, and call them ma\'am.', volatile: '' } }, { tools: tools.slice(0, 1) }]) {
    const before = sdk.spares.at(-1);
    assert.equal(await cli.runTurn(turn(change)), 'from query');
    assert.equal(before.closed, true);
    assert.equal(before.used, false);
    const o = sdk.runs.at(-1).options;
    if (change.model) assert.equal(o.model, 'claude-haiku-5-5');
    if (change.effort) assert.equal(o.effort, 'high');
    if (change.webSearch) assert.deepEqual(o.tools, ['WebSearch', 'WebFetch']);
    await tick();
    await cli.prewarm(turn()); // back to the usual
    await tick();
  }

  const last = sdk.spares.at(-1);
  cli.dispose();
  await tick();
  assert.equal(last.closed, true, 'closed on quit');
  assert.equal(cli.spare, null);
});

test('claude cli: a spare that died is replaced without the user hearing about it', async () => {
  let n = 0;
  const { cli, sdk } = makeCli(async function* (run) {
    n++;
    if (run.how === 'spare') throw new Error('Claude Code process exited with code 1');
    yield init(run.options);
    yield say('Still here, sir.');
    yield done();
  });
  await cli.prewarm(turn());
  const events = [];
  assert.equal(await cli.runTurn(turn({ emit: (e) => events.push(e) })), 'Still here, sir.');
  assert.deepEqual(sdk.runs.map((r) => r.how), ['spare', 'query']);
  assert.deepEqual(events, [{ type: 'delta', text: 'Still here, sir.' }]);
  assert.equal(n, 2);
});

test('claude cli: interrupting stops at once, and the next turn works', async () => {
  let controller;
  const { cli, sdk } = makeCli(async function* (run) {
    controller = run.options.abortController;
    yield init(run.options);
    yield say('One. Two. ');
    if (run.prompt.includes('count')) await never;
    yield say('Certainly.');
    yield done();
  });
  const ac = new AbortController();
  const events = [];
  const started = Date.now();
  const slow = cli.runTurn(turn({ userText: 'count to a thousand', emit: (e) => events.push(e), signal: ac.signal }));
  await tick();
  ac.abort();
  const err = await slow.catch((e) => e);
  assert.equal(err.name, 'AbortError');
  assert.equal(Date.now() - started < 500, true);
  assert.equal(controller.signal.aborted, true, 'the child is told to stop');
  assert.deepEqual(events, [{ type: 'delta', text: 'One. Two. ' }]);
  assert.equal(cli.running.size, 0);
  assert.equal(await cli.runTurn(turn({ userText: 'never mind' })), 'One. Two. Certainly.');

  const before = sdk.runs.length;
  const gone = new AbortController();
  gone.abort();
  assert.equal((await cli.runTurn(turn({ signal: gone.signal })).catch((e) => e)).name, 'AbortError');
  assert.equal(sdk.runs.length, before, 'nothing is started for a turn that was already abandoned');
});

test('claude cli: failures are told apart, never spoken as if they were the reply', async () => {
  const cases = {
    signedOut: [cliSays('authentication_failed', 'Not logged in · Please run /login'), done({ is_error: true })],
    limit: [{ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: Date.UTC(2026, 0, 1, 15, 0) / 1000 } }, cliSays('rate_limit', "You've hit your session limit"), done({ is_error: true })],
    model: [cliSays('model_not_found', 'There is an issue with the selected model'), done({ is_error: true })],
    busy: [cliSays('overloaded', 'Overloaded'), done({ is_error: true })],
    billing: [cliSays('billing_error', 'Credit balance is too low'), done({ is_error: true })],
    offline: [cliSays('unknown', 'API Error: Connection error.'), done({ is_error: true })],
    crashed: [{ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom'] }],
    refused: [done({ stop_reason: 'refusal' })],
    longWinded: [say('Step one.'), { type: 'result', subtype: 'error_max_turns', is_error: true }],
  };
  const { cli, sdk, statuses } = makeCli(async function* (run) {
    yield init(run.options);
    yield* cases[run.prompt.split('\n').at(-1)];
    throw new Error('Claude Code returned an error result'); // what the SDK does after an error result
  });
  const attempt = async (which) => {
    const events = [];
    const out = await cli.runTurn(turn({ userText: which, history: [], emit: (e) => events.push(e) })).catch((e) => e);
    return { out, events };
  };
  await cli.check();

  const signedOut = await attempt('signedOut');
  assert.equal(signedOut.out instanceof CliError && signedOut.out.kind, 'not_logged_in');
  assert.deepEqual(signedOut.events, [], '"Not logged in · Please run /login" is not Jarvis talking');
  assert.match(describeCliError(signedOut.out), /signed out\. Run claude in a terminal and sign in/);

  const limit = await attempt('limit');
  assert.equal(limit.out.kind, 'rate_limit');
  assert.match(describeCliError(limit.out), /reached its usage limit for now; it resets around \d\d:\d\d\./);
  assert.equal((await attempt('model')).out.kind, 'model');
  assert.equal((await attempt('busy')).out.kind, 'busy');
  assert.match(describeCliError((await attempt('billing')).out), /account can't be used right now: Credit balance is too low/);
  assert.match(describeCliError((await attempt('offline')).out), /could not reach the cloud model/);
  assert.match(describeCliError((await attempt('crashed')).out), /returned an error: boom/);
  const refused = await attempt('refused');
  assert.equal(refused.out, "I'm afraid that's not something I can help with.");
  assert.equal(refused.events.length, 1);
  assert.equal((await attempt('longWinded')).out, 'Step one.');
  assert.equal(sdk.runs.every((r) => r.closed || r.options.abortController.signal.aborted), true);

  // not there at all: nothing is started, and the answer says what to do
  const missing = makeCli(async function* () { yield done(); }, { locate: async () => null });
  const err = await missing.cli.runTurn(turn()).catch((e) => e);
  assert.equal(err.kind, 'not_installed');
  assert.equal(missing.sdk.runs.length, 0);
  assert.match(describeCliError(err), /can't find the Claude Code command line tool/);
  // found, but it will not start
  const broken = makeCli(async function* () { yield done(); });
  broken.sdk.query = () => { throw Object.assign(new ReferenceError('Claude Code native binary not found at /usr/local/bin/claude'), { code: 'ENOENT', errorClass: 'executable_not_found' }); };
  assert.equal((await broken.cli.runTurn(turn()).catch((e) => e)).kind, 'not_installed');
  assert.equal(statuses.includes('ready'), true);
});

test('claude cli: finding Claude Code and reading its sign-in', async () => {
  const ready = makeCli(async function* () { yield done(); });
  assert.deepEqual(await ready.cli.check(), { state: 'ready', path: '/usr/local/bin/claude', source: 'installed', version: '2.1.332', loggedIn: true });
  assert.deepEqual(ready.statuses, ['ready']);
  await ready.cli.check();
  assert.deepEqual(ready.statuses, ['ready'], 'told once, not on every look');

  const out = makeCli(async function* () { yield done(); }, { auth: { ok: false, stdout: '{"loggedIn":false,"authMethod":"none"}' } });
  assert.equal((await out.cli.check()).state, 'signed_out');
  await out.cli.prewarm(turn());
  assert.equal(out.sdk.spares.length, 0, 'no process is parked while signed out');

  const old = makeCli(async function* () { yield done(); }, { locate: async () => ({ ...found, version: '2.1.100' }) });
  assert.equal((await old.cli.check()).state, 'old');
  assert.equal((await old.cli.runTurn(turn()).catch((e) => e)).kind, 'old');
  assert.match(describeCliError(new CliError('old', '2.1.100')), /too old for me \(2\.1\.100\)\. Update it by running claude update/);
  assert.equal(MIN_VERSION, '2.1.248');

  // installed later: the next turn finds it without anyone pressing Re-check
  let installed = false;
  const later = makeCli(async function* (run) { yield init(run.options); yield say('Here.'); yield done(); }, { locate: async () => (installed ? found : null) });
  assert.equal((await later.cli.check()).state, 'missing');
  installed = true;
  assert.equal(await later.cli.runTurn(turn()), 'Here.');
  assert.deepEqual(later.statuses, ['missing', 'ready']);

  // a path typed into the controls that does not work is reported as that
  const typed = makeCli(async function* () { yield done(); }, { locate: async () => ({ path: '/nope/claude', source: 'setting', version: '' }) });
  assert.deepEqual(await typed.cli.check(), { state: 'missing', path: '/nope/claude', source: 'setting', version: '', loggedIn: false });

  // where to look when the app was not started from a shell
  const mac = candidatePaths({ env: { PATH: '/usr/bin:/bin' }, platform: 'darwin', home: '/Users/ana' });
  assert.deepEqual(mac.slice(0, 3), ['/usr/bin/claude', '/bin/claude', '/Users/ana/.local/bin/claude']);
  for (const p of ['/opt/homebrew/bin/claude', '/usr/local/bin/claude', '/Users/ana/.claude/local/claude', '/Users/ana/.npm-global/bin/claude', '/Users/ana/.bun/bin/claude']) assert.equal(mac.includes(p), true, p);
  const win = candidatePaths({ env: { Path: 'C:\\Windows', APPDATA: 'C:\\Users\\ana\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\ana\\AppData\\Local' }, platform: 'win32', home: 'C:\\Users\\ana' });
  for (const p of ['C:\\Users\\ana\\.local\\bin\\claude.exe', 'C:\\Users\\ana\\AppData\\Roaming\\npm\\claude.cmd']) assert.equal(win.includes(p), true, p);
});

test('claude cli: background filing asks for JSON on the quickest model the login has', async () => {
  const schema = { type: 'object', properties: { nodes: { type: 'array' } }, required: ['nodes'] };
  const { cli, sdk } = makeCli(async function* (run) {
    yield init(run.options);
    if (run.options.model === 'claude-sonnet-5-5') { yield cliSays('model_not_found', 'not on this plan'); yield done({ is_error: true }); return; }
    if (run.prompt === 'nothing') { yield done({ structured_output: undefined }); return; }
    yield done({ structured_output: { nodes: [{ label: 'Budget' }] } });
  });
  assert.deepEqual(await cli.extractJson({ system: 'Extract.', user: 'the exchange', schema, fallbackModel: 'claude-opus-5-5' }), { nodes: [{ label: 'Budget' }] });
  assert.deepEqual(sdk.runs.map((r) => r.options.model), ['claude-sonnet-5-5', 'claude-haiku-5-5']);
  const o = sdk.runs[1].options;
  assert.deepEqual([o.effort, o.systemPrompt, o.outputFormat, o.thinking], ['low', 'Extract.', { type: 'json_schema', schema }, { type: 'disabled' }]);
  assert.deepEqual([o.tools, o.allowedTools, o.mcpServers, o.settingSources, o.persistSession, o.includePartialMessages], [[], [], {}, [], false, false]);
  assert.equal(o.disallowedTools.includes('Bash'), true);
  assert.equal(sdk.runs[1].prompt, 'the exchange');

  assert.equal(await cli.extractJson({ system: 'Extract.', user: 'nothing', schema }), null);
  assert.equal(sdk.runs.at(-1).options.model, 'claude-haiku-5-5', 'the model that was missing is not tried again');
});

// ---- through the Agent --------------------------------------------------------------------------

function makeAgent(script, settingsPatch = {}) {
  const dir = tmp();
  const settings = new Settings(dir);
  settings.set(settingsPatch);
  const memory = new Memory(dir);
  const { cli, sdk } = makeCli(script);
  const events = [];
  const keyTurns = [];
  const agent = new Agent({
    settings, memory, skills: new Skills(dir), mcp: { status: () => [], tools: () => [] }, claude: cli, getApiKey: () => 'sk-test',
    emit: (e) => events.push(e), ui: () => {}, fsRoot: () => dir, openPath: async () => '',
  }, {
    runAnthropicTurn: async (o) => { keyTurns.push(o); o.emit({ type: 'delta', text: 'From the key.' }); },
    extractJsonAnthropic: async () => null,
  });
  return { agent, settings, memory, cli, sdk, events, keyTurns };
}

test('agent on the Claude login: the default brain; memory and the settings of the moment are what every turn sees', async () => {
  const extraction = { project: '', nodes: [{ label: 'Ana', type: 'person', summary: "The user's sister is named Ana." }], links: [] };
  const { agent, settings, memory, cli, sdk, events, keyTurns } = makeAgent(async function* (run) {
    yield init(run.options);
    if (run.options.outputFormat) { yield done({ structured_output: run.prompt.includes('sister') && !run.prompt.includes('Forget') ? extraction : { project: '', nodes: [], links: [] } }); return; }
    const said = run.prompt.split('[Just said]\n')[1];
    if (/^Forget/.test(said)) {
      const client = await toolClient(run.options);
      yield calls('mcp__jarvis__forget');
      await client.callTool({ name: 'forget', arguments: { label: 'Ana' } });
      yield toolResult;
      yield say("I've deleted Ana from memory, sir.");
    } else if (/count/.test(said)) {
      yield say('One. Two. Three. ');
      await never;
    } else yield say(/sister's name is/.test(said) ? 'Noted, sir.' : 'Very good, sir.');
    yield done();
  });
  assert.equal(settings.get().cloudAuth, 'cli');
  assert.equal(agent.brain(), 'cli');
  const turns = () => sdk.runs.filter((r) => !r.options.outputFormat);

  const first = await agent.send("My sister's name is Ana.");
  assert.deepEqual([first.text, first.error], ['Noted, sir.', '']);
  assert.deepEqual(events.map((e) => e.type), ['start', 'delta', 'done']);
  assert.equal(keyTurns.length, 0, 'no API key involved');
  await tick(50); // background filing, through the CLI as well
  assert.equal(memory.find('Ana').type, 'person');
  assert.deepEqual(sdk.runs.find((r) => r.options.outputFormat).options.outputFormat.schema.required, ['project', 'nodes', 'links']);

  await agent.send('Good.');
  assert.match(turns()[1].prompt, /\[person\] Ana: The user's sister is named Ana\./, 'the memory digest of the moment');
  assert.match(turns()[1].prompt, /\[Conversation so far\]\nUser: My sister's name is Ana\.\nJarvis: Noted, sir\.\n\n\[Just said\]\nGood\./);
  assert.match(turns()[1].options.systemPrompt, /^You are JARVIS, the user's personal AI/);
  assert.equal(turns()[1].how, 'spare');

  // forgetting: gone from the map, from the record, and from the reply that confirmed it — and nowhere else for it to be
  const forget = await agent.send('Forget about Ana.');
  assert.equal(forget.text, "I've deleted Ana from memory, sir.");
  await tick(50);
  assert.equal(memory.find('Ana'), null);
  assert.equal(memory.history.some((h) => /ana\b/i.test(h.text)), false);
  await agent.send('What do you know about my family?');
  assert.doesNotMatch(turns().at(-1).prompt, /\bAna\b/);
  assert.equal(turns().at(-1).how, 'spare', 'a parked process holds nothing that could need forgetting');
  assert.doesNotMatch(JSON.stringify(turns().at(-1).options.systemPrompt), /\bAna\b/);

  // clearing the conversation, switching project
  memory.clearHistory();
  memory.createProject('Lisbon Trip', 'April');
  await agent.send('And now?');
  assert.doesNotMatch(turns().at(-1).prompt, /Conversation so far/);
  assert.match(turns().at(-1).prompt, /Project "Lisbon Trip" \(active\)/);

  // model, effort and the Internet switch take effect on the very next turn
  settings.set({ cloudModel: 'claude-haiku-5-5', effort: 'medium', webSearch: false });
  await agent.send('Quicker.');
  const o = turns().at(-1).options;
  assert.deepEqual([o.model, o.effort, o.tools], ['claude-haiku-5-5', 'medium', []]);
  assert.match(o.systemPrompt, /Internet access is switched off/);
  assert.equal(o.mcpServers.jarvis.type, 'sdk');

  // an interrupted reply is recorded as cut off on the next turn, exactly as with the other brains
  memory.clearHistory();
  const slow = agent.send('count to a hundred');
  await tick();
  const next = agent.send('never mind', { interrupted: 'One. Two.' });
  assert.equal((await slow).aborted, true);
  assert.equal((await next).text, 'Very good, sir.');
  assert.deepEqual(memory.recentTurns().map((t) => t.text), ['count to a hundred', 'One. Two. — (cut off by the user)', 'never mind', 'Very good, sir.']);
  assert.match(turns().at(-1).prompt, /Jarvis: One\. Two\. — \(cut off by the user\)\n\n\[Just said\]\nnever mind/);

  // switching to an API key (or to the local model) lets the parked process go and uses the other path at once
  await agent.prewarm();
  const parked = sdk.spares.at(-1);
  settings.set({ cloudAuth: 'key' });
  agent.prewarm();
  await tick();
  assert.equal(parked.closed, true);
  const before = sdk.runs.length;
  assert.equal((await agent.send('hello')).text, 'From the key.');
  assert.equal(keyTurns.length, 1);
  assert.equal(keyTurns[0].apiKey, 'sk-test');
  assert.equal(sdk.runs.length, before);
  assert.equal(cli.spare, null);
});

test('agent on the Claude login: a missing or signed-out CLI is reported in plain words', async () => {
  const { agent, events } = makeAgent(async function* (run) {
    yield init(run.options);
    yield cliSays('authentication_failed', 'Not logged in · Please run /login');
    yield done({ is_error: true });
  });
  const res = await agent.send('hello');
  assert.equal(res.text, '');
  assert.equal(res.error, 'Claude Code is signed out. Run claude in a terminal and sign in, then ask me again.');
  assert.deepEqual(events.map((e) => e.type), ['start', 'error', 'done']);
});

// ---- small pure pieces ------------------------------------------------------------------------

test('memory: forgetting scrubs every line that names the thing, however it was worded', () => {
  assert.deepEqual(tellingWords({ label: 'Sister Ana', summary: "Ana is the user's sister." }), ['sister ana', 'sister', 'ana']);
  assert.deepEqual(tellingWords({ label: 'Sister', summary: "The user's sister is named Ana. She lives in Porto." }), ['sister', 'ana', 'porto']);
  assert.deepEqual([mentions('a banana', ['ana']), mentions("Ana's car", ['ana']), mentions('Call ANA.', ['ana'])], [false, true, true]);
  const m = new Memory(tmp());
  m.upsert({ label: 'Sister Ana', type: 'person', summary: "The user's sister is named Ana." });
  m.logTurn('user', "Remember that my sister's name is Ana.");
  m.logTurn('assistant', 'Noted, sir.');
  m.logTurn('user', 'I had a banana.');
  m.forget('Sister Ana');
  assert.deepEqual(m.history.map((h) => h.text), ['Noted, sir.', 'I had a banana.']);
  assert.deepEqual(m.forgotten, ['sister ana', 'sister', 'ana']);
});

test('controls: what the brain chip and the sign-in line say', () => {
  const state = (settings, extra = {}) => ({ settings: { provider: 'cloud', cloudAuth: 'cli', cloudModel: 'claude-opus-5-5', localModel: '', ...settings }, cloudModels: [{ id: 'claude-opus-5-5', label: 'Claude Opus 5.5' }], hasApiKey: false, claude: { state: 'ready', version: '2.1.332' }, ...extra });
  assert.deepEqual(brainChip(state({})), { text: 'Cloud · Opus 5.5', off: false });
  assert.deepEqual(brainChip(state({}, { claude: { state: 'signed_out', version: '2.1.332' } })), { text: 'Cloud · signed out', off: true });
  assert.deepEqual(brainChip(state({}, { claude: { state: 'missing' } })), { text: 'Cloud · no Claude Code', off: true });
  assert.deepEqual(brainChip(state({}, { claude: { state: 'checking' } })), { text: 'Cloud · Opus 5.5', off: false });
  assert.deepEqual(brainChip(state({ cloudAuth: 'key' })), { text: 'Cloud · no API key', off: true });
  assert.deepEqual(brainChip(state({ cloudAuth: 'key' }, { hasApiKey: true, claude: { state: 'missing' } })), { text: 'Cloud · Opus 5.5', off: false });
  assert.deepEqual(brainChip(state({ provider: 'local', localModel: 'qwen3' })), { text: 'Local · qwen3', off: false });

  assert.equal(claudeLogin({ state: 'ready', version: '2.1.332', source: 'installed' }).line, 'Claude Code 2.1.332 found · signed in');
  assert.equal(claudeLogin({ state: 'ready', version: '2.1.332', source: 'bundled' }).line, 'Claude Code 2.1.332 (built in) found · signed in');
  assert.equal(claudeLogin({ state: 'ready' }).toast, '');
  assert.match(claudeLogin({ state: 'signed_out', version: '2.1.332' }).line, /signed out\. Run claude in a terminal, sign in, then Re-check/);
  assert.match(claudeLogin({ state: 'missing' }).line, /not found\. Install it/);
  assert.match(claudeLogin({ state: 'missing' }).toast, /can't find the Claude Code CLI/);
  assert.match(claudeLogin({ state: 'missing', path: '/nope/claude' }).line, /Nothing I can run at that path/);
  assert.match(claudeLogin({ state: 'old', version: '2.1.100' }).line, /too old\. Run claude update/);
  assert.equal(claudeLogin({ state: 'checking' }).line, 'Looking for Claude Code…');
  assert.doesNotMatch(Object.values(claudeLogin({ state: 'missing' })).join(' '), /API key before|add an Anthropic API key/i);
});
