// Cloud brain without a key: Claude through the Claude Code CLI, on the login the user already has
// there. The Agent SDK runs `claude` as a child process; this module turns that process into a
// plain model endpoint — Jarvis's persona, Jarvis's tools served in-process, nothing of Claude
// Code's own (no shell, no file tools, no settings, hooks, skills, plugins or MCP servers).
//
// Each turn gets a process of its own and is told everything in the prompt (memory digest, recent
// conversation), so nothing outlives a turn: forgetting, clearing the conversation or switching
// project cannot be contradicted by a session that remembers otherwise. So that this does not cost
// half a second of start-up before every reply, the process for the next turn is started ahead of
// time and parked (the "spare"). A spare knows only the binary, model, effort, the stable half of
// the system prompt and the tool list; it is thrown away when any of those change, when the brain
// is switched away from the CLI and on quit, and it serves exactly one turn.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { validateInput } from '../tools.js';

const SERVER = 'jarvis';
const PREFIX = `mcp__${SERVER}__`;
const WEB = { WebSearch: 'web_search', WebFetch: 'web_fetch' }; // CLI tool -> the name the API path reports
// `tools` below already limits Claude Code's built-ins to the web pair or to nothing. These are refused by name as well.
const NEVER = [
  'Bash', 'BashOutput', 'KillShell', 'Monitor', 'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep', 'LS',
  'Task', 'Agent', 'TaskStop', 'ListAgents', 'SendMessage', 'Workflow', 'Skill', 'SlashCommand', 'ToolSearch', 'TodoWrite',
  'CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup', 'RemoteTrigger', 'PushNotification', 'EnterWorktree', 'ExitWorktree',
];
const MAX_STEPS = 24;
// verbatimPrompts (speech is never read as a /command or an @file) needs at least this.
export const MIN_VERSION = '2.1.248';
// Background filing, quickest first; the next one only if the login does not offer it. Through the
// CLI a structured answer takes Sonnet about 3.4 s and Haiku about 4.5 s (Haiku is lighter on the plan).
const EXTRACT_MODELS = ['claude-sonnet-5-5', 'claude-haiku-5-5'];

// How a turn is laid out for a process that keeps no conversation of its own.
const LAYOUT = `How messages reach you
Each message is put together by the app in up to three parts: a context block (the time and what you know), the conversation so far, and what was just said. Only the last part is the person speaking to you now; the rest is your own record. Answer what was just said, in your own voice, without repeating these headings or putting a speaker name in front of your words.`;

// Claude Code's search tool tells the model to finish with a list of links. Read aloud, that is noise.
const SPOKEN_SOURCES = `Sources
When you have looked something up, say where it comes from in passing ("according to the Node site"). Never finish with a list of sources or links, whatever a tool's own instructions say: every word you write is spoken aloud.`;

/** Backstop for the above: once a web tool has been used, a line starting "Sources:" and everything after it is not passed on. */
function withoutSources(out) {
  let armed = false;
  let cut = false;
  let held = '';
  return {
    arm() { armed = true; },
    push(text) {
      if (cut) return;
      if (!armed) return out(text);
      held += text;
      const heading = /\n[ \t*_#]*sources:/i.exec(held);
      const at = heading ? heading.index : held.lastIndexOf('\n') + 1;
      const line = held.slice(at).replace(/^[\s*_#]+/, '').toLowerCase();
      if (!heading && !'sources:'.startsWith(line)) { out(held); held = ''; return; }
      const keep = held.slice(0, at).replace(/\n+$/, ''); // a line that may yet turn out to be the heading is held, with the gap before it
      if (keep) out(keep);
      held = held.slice(keep.length);
      cut = Boolean(heading);
    },
    flush() {
      if (!cut && held) out(held);
      held = '';
    },
  };
}

export class CliError extends Error {
  constructor(kind, detail = '') {
    super(detail || kind);
    this.name = 'CliError';
    this.kind = kind;
  }
}
const ABORTED = Symbol('aborted');
const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
const isAbort = (err) => err?.name === 'AbortError';

/** Spoken aloud, so no punctuation that only reads well on a screen. */
export function describeCliError(err) {
  const detail = err instanceof CliError && err.message !== err.kind ? err.message : '';
  switch (err?.kind) {
    case 'not_installed': return 'I can\'t find the Claude Code command line tool on this computer. Install it and sign in, or point me to it under Brain in the controls.';
    case 'not_logged_in': return 'Claude Code is signed out. Run claude in a terminal and sign in, then ask me again.';
    case 'old': return `This Claude Code is too old for me${detail ? ` (${detail})` : ''}. Update it by running claude update in a terminal.`;
    case 'rate_limit': return `Your Claude plan has reached its usage limit for now${detail ? `; it resets ${detail}` : ''}. Give it a while, or switch me to the local model.`;
    case 'account': return `Your Claude account can't be used right now${detail ? `: ${detail}` : '.'}`;
    case 'model': return 'That model is not available on your Claude login. Pick another under Brain.';
    case 'busy': return 'The cloud model is having trouble right now. Give it a moment.';
    case 'offline': return 'I could not reach the cloud model. Check the internet connection, or switch me to the local model.';
    case 'unsafe': return 'Claude Code offered tools I did not ask for, so I stopped. Update Claude Code, or switch me to an API key.';
    default: return `The cloud model returned an error: ${detail || err?.message || String(err)}`;
  }
}

/**
 * The child's environment. The login must win, so no inherited key; and when Jarvis is started
 * from a Claude Code terminal, that session's markers must not make the child think it is nested.
 * The switches turn off the parts of Claude Code that reach beyond a single answer.
 */
export function claudeEnv(base = process.env) {
  const env = { ...base };
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID']) delete env[k];
  return {
    ...env,
    CLAUDE_AGENT_SDK_CLIENT_APP: 'jarvis',
    ENABLE_CLAUDEAI_MCP_SERVERS: 'false', // the connectors of the user's claude.ai account
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    DISABLE_AUTOUPDATER: '1', // updating the user's CLI is not Jarvis's business
  };
}

const newer = (a, b) => {
  const x = String(a).split('.').map(Number);
  const y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return true;
};

function run(file, args, { env, timeout = 15000 } = {}) {
  return new Promise((resolve) => {
    // npm's Windows shims are batch files, which only a shell can start.
    const shim = /\.(cmd|bat)$/i.test(file);
    execFile(shim ? `"${file}"` : file, args, { env, timeout, windowsHide: true, shell: shim }, (err, stdout) => {
      resolve({ ok: !err, stdout: String(stdout || '') });
    });
  });
}

/** Where `claude` usually lives. A GUI app does not get the shell's PATH (Finder, the Windows Start menu), so look in the known places too. */
export function candidatePaths({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  const win = platform === 'win32';
  const p = win ? path.win32 : path.posix;
  const names = win ? ['claude.exe', 'claude.cmd'] : ['claude'];
  const dirs = (env.PATH || env.Path || '').split(win ? ';' : ':').filter(Boolean);
  dirs.push(p.join(home, '.local', 'bin'), p.join(home, '.claude', 'local'), p.join(home, '.claude', 'bin'));
  if (win) {
    if (env.APPDATA) dirs.push(p.join(env.APPDATA, 'npm'));
    if (env.LOCALAPPDATA) dirs.push(p.join(env.LOCALAPPDATA, 'Programs', 'claude'), p.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links'));
  } else {
    dirs.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/home/linuxbrew/.linuxbrew/bin', '/snap/bin',
      p.join(home, '.npm-global', 'bin'), p.join(home, '.npm', 'bin'), p.join(home, '.bun', 'bin'), p.join(home, '.volta', 'bin'),
      p.join(home, '.yarn', 'bin'), p.join(home, '.local', 'share', 'pnpm'), p.join(home, 'Library', 'pnpm'), p.join(home, '.nix-profile', 'bin'));
  }
  if (env.npm_config_prefix) dirs.push(win ? env.npm_config_prefix : p.join(env.npm_config_prefix, 'bin'));
  const out = [];
  for (const dir of dirs) for (const name of names) if (!out.includes(p.join(dir, name))) out.push(p.join(dir, name));
  return out;
}

function executable(file) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (process.platform !== 'win32') fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Last resorts for an install in an unusual place: ask the login shell (which reads the user's profile), then npm. */
async function askShell({ env = process.env, platform = process.platform } = {}) {
  if (platform !== 'win32') {
    const shell = env.SHELL || '/bin/sh';
    const flags = /(bash|zsh|fish)$/.test(shell) ? '-ilc' : '-lc';
    const mark = '__jarvis__';
    const res = await run(shell, [flags, `echo ${mark}$(command -v claude)${mark}`], { env, timeout: 5000 });
    const found = new RegExp(`${mark}(.*?)${mark}`).exec(res.stdout)?.[1]?.trim();
    if (found && path.isAbsolute(found)) return found;
  }
  const npm = await run(platform === 'win32' ? 'npm.cmd' : 'npm', ['prefix', '-g'], { env, timeout: 5000 });
  const prefix = npm.ok && npm.stdout.trim().split('\n').pop();
  return prefix ? (platform === 'win32' ? path.join(prefix, 'claude.cmd') : path.join(prefix, 'bin', 'claude')) : '';
}

/** The copy of Claude Code that ships inside the Agent SDK package. It reads the same login. */
function bundledBinary() {
  const require = createRequire(import.meta.url);
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  for (const libc of ['', '-musl']) {
    try {
      return require.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}${libc}/${exe}`);
    } catch {
      /* not installed for this platform */
    }
  }
  return '';
}

/** JSON-schema tools in Jarvis's shape, served to the child over the SDK's in-process MCP transport. */
function toolServer(defs, live) {
  const server = new Server({ name: SERVER, version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: defs.map((d) => ({ name: d.name, description: d.description, inputSchema: d.schema })) }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const fail = (text) => ({ isError: true, content: [{ type: 'text', text }] });
    const tool = live.tools.get(req.params.name);
    const input = req.params.arguments ?? {};
    const problem = tool ? validateInput(tool.schema, input) : `unknown tool ${req.params.name}`;
    if (problem) return fail(`Invalid tool input: ${problem}`);
    try {
      return { content: [{ type: 'text', text: String(await tool.run(input)).slice(0, 60000) }] };
    } catch (err) {
      return fail(err?.message || String(err));
    }
  });
  return server;
}

/**
 * Names as the child sees them. Its own prefix (mcp__jarvis__) is added to each, so a connection's
 * tool drops its leading mcp__ and long names are cut to stay inside the 64 characters a tool name may have.
 */
export function exposeTools(tools) {
  const used = new Set();
  return tools.map((tool) => {
    const room = 64 - PREFIX.length;
    let name = tool.name.replace(/^mcp__/, '').slice(0, room);
    for (let n = 2; used.has(name); n++) name = `${name.slice(0, room - String(n).length - 1)}_${n}`;
    used.add(name);
    return { name, description: tool.description, schema: tool.schema, tool };
  });
}

export function composePrompt({ volatile, history = [], userText }) {
  const parts = [];
  if (volatile) parts.push(`[Context for this turn — supplied by the app]\n${volatile}`);
  if (history.length) parts.push(`[Conversation so far]\n${history.map((h) => `${h.role === 'assistant' ? 'Jarvis' : 'User'}: ${h.text}`).join('\n')}`);
  parts.push(`[Just said]\n${userText}`);
  return parts.join('\n\n');
}

/** Everything that decides what the child may see and do. Pure, so the lists can be tested. */
export function sessionOptions({ bin, model, effort, system, defs = [], webSearch = false, cwd, env, server }) {
  const web = webSearch ? Object.keys(WEB) : [];
  return {
    model,
    ...(effort ? { effort } : {}),
    systemPrompt: system,
    tools: web, // Claude Code's own tools: the web pair, or none at all
    allowedTools: [...web, ...(defs.length ? [`mcp__${SERVER}`] : [])],
    disallowedTools: [...NEVER, ...(webSearch ? [] : Object.keys(WEB))],
    mcpServers: defs.length ? { [SERVER]: { type: 'sdk', name: SERVER, instance: server } } : {},
    strictMcpConfig: true, // none of the user's own MCP servers
    settingSources: [], // no user, project or local settings: no CLAUDE.md, hooks, permissions, plugins
    skills: [],
    plugins: [],
    permissionMode: 'dontAsk', // never asks; what is not allowed above is refused
    verbatimPrompts: true, // what was said is text: "/clear" is not a command, "@notes" is not a file to read
    persistSession: false, // no transcript among the user's Claude Code sessions
    title: 'Jarvis', // or the CLI spends a model call naming the session
    includePartialMessages: true,
    maxTurns: MAX_STEPS,
    cwd,
    env,
    ...(bin ? { pathToClaudeCodeExecutable: bin } : {}),
  };
}

function apiFailure(code, text, limit) {
  switch (code) {
    case 'authentication_failed': return new CliError('not_logged_in');
    case 'rate_limit': {
      const at = limit?.resetsAt ? new Date(limit.resetsAt * 1000) : null;
      return new CliError('rate_limit', at ? `around ${at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : '');
    }
    case 'oauth_org_not_allowed': case 'account_on_hold': case 'verification_required': case 'billing_error': return new CliError('account', text);
    case 'model_not_found': return new CliError('model');
    case 'overloaded': case 'server_error': return new CliError('busy');
    default: return /connection|network|fetch failed|ENOTFOUND|ECONN|timed? ?out/i.test(text) ? new CliError('offline') : new CliError('error', text);
  }
}

function spawnFailure(err) {
  if (err instanceof CliError) return err;
  if (err?.errorClass === 'executable_not_found' || err?.errorClass === 'executable_launch_failed' || err?.code === 'ENOENT' || err?.code === 'EACCES') return new CliError('not_installed');
  if (/not logged in|\/login/i.test(err?.message || '')) return new CliError('not_logged_in');
  return new CliError('error', String(err?.message || err).slice(0, 300));
}

export class ClaudeCli {
  /**
   * @param o {workDir, configuredPath(), onStatus(status), sdk, log(line), env, locate(), exec(file, args)}
   * `sdk` ({query, startup}), `locate` and `exec` can be replaced in tests.
   */
  constructor({ workDir, configuredPath = () => '', onStatus = () => {}, sdk = null, log = () => {}, env = null, locate = null, exec = null } = {}) {
    this.workDir = workDir || path.join(os.tmpdir(), 'jarvis-claude');
    this.configuredPath = configuredPath;
    this.onStatus = onStatus;
    this.sdk = sdk;
    this.log = log;
    this.env = env || claudeEnv();
    this.locate = locate || (() => this.find());
    this.exec = exec || ((file, args) => run(file, args, { env: this.env }));
    this.state = { state: 'checking', path: '', source: '', version: '', loggedIn: false };
    this.checking = null;
    this.spare = null;
    this.running = new Set();
    this.extractModel = 0;
  }

  status() {
    return this.state;
  }

  async load() {
    if (!this.sdk) this.sdk = await import('@anthropic-ai/claude-agent-sdk');
    return this.sdk;
  }

  // ---- finding it and checking the login ------------------------------------

  async probe(file) {
    const v = await this.exec(file, ['--version']);
    const version = /(\d+\.\d+\.\d+)/.exec(v.stdout)?.[1] || '';
    return v.ok && version ? version : '';
  }

  /** The user's own install if there is one that is new enough; otherwise the copy inside the SDK. */
  async find() {
    const set = this.configuredPath();
    if (set) return { path: set, source: 'setting', version: await this.probe(set) };
    let old = null;
    const tryOne = async (file, source) => {
      if (!file || !executable(file)) return null;
      const version = await this.probe(file);
      if (version && newer(version, MIN_VERSION)) return { path: file, source, version };
      if (version) old = old || { path: file, source, version };
      return null;
    };
    const own = bundledBinary();
    // npm's Windows shim is a batch file, which the SDK cannot start; the copy inside the SDK reads the same login.
    const usable = (file) => !(own && /\.(cmd|bat)$/i.test(file));
    for (const file of candidatePaths().filter(usable)) {
      const hit = await tryOne(file, 'installed');
      if (hit) return hit;
    }
    const asked = await askShell().catch(() => '');
    const hit = usable(asked) && await tryOne(asked, 'installed');
    if (hit) return hit;
    if (own) return { path: own, source: 'bundled', version: await this.probe(own) };
    return old;
  }

  /** Is Claude Code there, new enough and signed in? About a third of a second; no model call. */
  check({ again = false } = {}) {
    if (again && this.checking) return this.checking.then(() => this.check()); // what was being looked at may have changed
    if (!this.checking) {
      this.checking = (async () => {
        const next = { state: 'missing', path: '', source: '', version: '', loggedIn: false };
        try {
          const found = await this.locate();
          if (found) Object.assign(next, found);
          if (found?.version) {
            if (!newer(found.version, MIN_VERSION)) next.state = 'old';
            else {
              const auth = await this.exec(found.path, ['auth', 'status']);
              let info = null;
              try { info = JSON.parse(auth.stdout); } catch { /* an unexpected answer counts as signed out */ }
              next.loggedIn = Boolean(info?.loggedIn);
              next.state = next.loggedIn ? 'ready' : 'signed_out';
            }
          }
        } catch (err) {
          this.log(`check failed: ${err?.message || err}`);
        }
        const changed = JSON.stringify(next) !== JSON.stringify(this.state);
        if (next.path !== this.state.path) this.dropSpare();
        this.state = next;
        this.checking = null;
        this.log(`status ${JSON.stringify(next)}`);
        if (changed) this.onStatus(next);
        return next;
      })();
    }
    return this.checking;
  }

  async binary() {
    let s = this.state;
    if (s.state === 'checking' || s.state === 'missing' || s.state === 'old') s = await this.check(); // it may have been installed since
    if (s.state === 'missing') throw new CliError('not_installed');
    if (s.state === 'old') throw new CliError('old', s.version);
    return s.path;
  }

  // ---- the spare --------------------------------------------------------------

  plan(bin, { model, effort, system, tools = [], webSearch = false }) {
    const defs = exposeTools(tools);
    const stable = [system.stable, LAYOUT, webSearch ? SPOKEN_SOURCES : ''].filter(Boolean).join('\n\n');
    const key = createHash('sha1').update(JSON.stringify([bin, model, effort || '', stable, Boolean(webSearch), defs.map((d) => [d.name, d.description, d.schema])])).digest('hex');
    return { key, bin, model, effort, stable, defs, webSearch };
  }

  options(plan, live, ac) {
    fs.mkdirSync(this.workDir, { recursive: true });
    return {
      ...sessionOptions({ bin: plan.bin, model: plan.model, effort: plan.effort, system: plan.stable, defs: plan.defs, webSearch: plan.webSearch, cwd: this.workDir, env: this.env, server: plan.defs.length ? toolServer(plan.defs, live) : null }),
      abortController: ac,
      stderr: (text) => { live.stderr = (live.stderr + text).slice(-600); },
    };
  }

  dropSpare() {
    const s = this.spare;
    this.spare = null;
    s?.ready.then((warm) => { try { warm?.close(); } catch { /* already gone */ } });
  }

  /**
   * Start the process for the next turn now. Safe to call as often as anything changes: a spare that
   * still fits is kept, one that no longer does is closed.
   * @param turn {model, effort, system:{stable}, tools, webSearch}
   */
  async prewarm(turn) {
    try {
      if (this.state.state === 'checking') await this.check();
      if (this.state.state !== 'ready') return this.dropSpare();
      const plan = this.plan(this.state.path, turn);
      if (this.spare?.key === plan.key) return;
      this.dropSpare();
      const { startup } = await this.load();
      if (this.spare) return; // a later call got here first
      const live = { tools: new Map(), stderr: '' };
      const ac = new AbortController();
      const spare = { key: plan.key, live, ac, ready: null };
      spare.ready = startup({ options: this.options(plan, live, ac) }).catch((err) => {
        this.log(`spare failed to start: ${err?.message || err}`);
        if (this.spare === spare) this.spare = null;
        return null;
      });
      this.spare = spare;
    } catch (err) {
      this.log(`prewarm failed: ${err?.message || err}`);
    }
  }

  /** Stop everything: on quit, and when the brain is switched away from the CLI. */
  dispose() {
    this.dropSpare();
    for (const ac of this.running) ac.abort();
    this.running.clear();
  }

  // ---- a turn -----------------------------------------------------------------

  /**
   * Run one user turn to completion. Same contract and events as runAnthropicTurn, minus the key.
   * @param o {model, effort, system:{stable,volatile}, history:[{role,text}], userText, tools, webSearch, emit, signal}
   * @returns {Promise<string>} everything Jarvis said this turn
   */
  async runTurn(o) {
    if (o.signal?.aborted) throw abortError();
    const since = Date.now();
    const bin = await this.binary();
    const { query } = await this.load();
    const plan = this.plan(bin, o);
    const prompt = composePrompt({ volatile: o.system.volatile, history: o.history, userText: o.userText });
    const tools = new Map(plan.defs.map((d) => [d.name, d.tool]));
    const aborted = new Promise((resolve) => o.signal?.addEventListener('abort', () => resolve(ABORTED), { once: true }));

    for (let attempt = 0; ; attempt++) {
      let q = null;
      let ac;
      let live;
      if (this.spare?.key === plan.key && attempt === 0) {
        const spare = this.spare;
        this.spare = null;
        const warm = await Promise.race([spare.ready, aborted]);
        if (warm === ABORTED) {
          if (!this.spare) this.spare = spare; // never used: it will do for the next turn
          throw abortError();
        }
        if (warm) {
          ({ ac, live } = spare);
          live.tools = tools;
          try { q = warm.query(prompt); } catch (err) { this.log(`spare unusable: ${err?.message || err}`); }
        }
      }
      const warmed = Boolean(q);
      if (!q) {
        ac = new AbortController();
        live = { tools, stderr: '' };
        try {
          q = query({ prompt, options: this.options(plan, live, ac) });
        } catch (err) {
          throw this.failed(spawnFailure(err));
        }
      }
      this.prewarm(o); // the one for the next turn starts while this one is thinking
      const seen = { emitted: false, since, warmed };
      try {
        const spoken = await this.pump(q, ac, aborted, plan, o.emit || (() => {}), seen);
        if (this.state.state !== 'ready') this.check(); // it worked, so whatever the status said is out of date
        return spoken;
      } catch (err) {
        if (isAbort(err)) throw err;
        const failure = spawnFailure(err);
        this.log(`turn failed (${failure.kind}${warmed ? ', spare' : ''}): ${failure.message} ${live.stderr.trim().slice(-200)}`);
        // A parked process can die or go stale. If it had said nothing yet, the user only notices a pause.
        if (warmed && !seen.emitted && !['rate_limit', 'account', 'model', 'unsafe'].includes(failure.kind)) continue;
        throw this.failed(failure);
      }
    }
  }

  failed(failure) {
    if (failure.kind === 'not_installed' || failure.kind === 'not_logged_in') this.check(); // let the controls show it
    return failure;
  }

  async pump(q, ac, aborted, plan, emit, seen) {
    const allowed = new Set([...plan.defs.map((d) => PREFIX + d.name), ...(plan.webSearch ? Object.keys(WEB) : [])]);
    const names = new Map(plan.defs.map((d) => [PREFIX + d.name, d.tool.name]));
    const it = q[Symbol.asyncIterator]();
    let spoken = '';
    let result = null;
    let failure = null;
    let limit = null;
    const say = withoutSources((text) => {
      spoken += text;
      emit({ type: 'delta', text });
    });
    this.running.add(ac);
    try {
      for (;;) {
        const next = it.next();
        const r = await Promise.race([next, aborted]);
        if (r === ABORTED) {
          next.catch(() => {}); // it rejects a couple of seconds later, once the child is gone; nobody is waiting
          throw abortError();
        }
        if (r.done) break;
        const m = r.value;
        if (m.type === 'system' && m.subtype === 'init') {
          this.log(`init ${JSON.stringify({ model: m.model, tools: m.tools, mcp: m.mcp_servers, permissionMode: m.permissionMode, apiKeySource: m.apiKeySource, version: m.claude_code_version, spare: seen.warmed, ms: Date.now() - seen.since })}`);
          const extra = [...(m.tools || []).filter((t) => !allowed.has(t)), ...(m.mcp_servers || []).filter((s) => s.name !== SERVER).map((s) => `mcp server ${s.name}`)];
          if (extra.length) throw new CliError('unsafe', extra.join(', '));
        } else if (m.type === 'stream_event') {
          if (m.parent_tool_use_id) continue;
          const e = m.event;
          if (e.type === 'content_block_start' && (e.content_block.type === 'tool_use' || e.content_block.type === 'server_tool_use')) {
            seen.emitted = true;
            if (WEB[e.content_block.name]) say.arm();
            emit({ type: 'tool', name: names.get(e.content_block.name) || WEB[e.content_block.name] || e.content_block.name });
          } else if (e.type === 'content_block_delta' && e.delta.type === 'text_delta' && e.delta.text) {
            if (!seen.spoke) this.log(`first words ${Date.now() - seen.since} ms`);
            seen.spoke = seen.emitted = true;
            say.push(e.delta.text);
          } else if (e.type === 'message_stop') {
            say.flush();
          }
        } else if (m.type === 'assistant' && m.error) {
          // The CLI words its own failures ("Not logged in · Please run /login") as an assistant message. Never speak those.
          failure = { code: m.error, text: (m.message?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(' ') };
        } else if (m.type === 'user' && !m.parent_tool_use_id) {
          const content = m.message?.content;
          if (Array.isArray(content) && content.some((b) => b.type === 'tool_result') && spoken && !/\s$/.test(spoken)) {
            spoken += ' ';
            emit({ type: 'delta', text: ' ' });
          }
        } else if (m.type === 'rate_limit_event') {
          limit = m.rate_limit_info;
        } else if (m.type === 'result') {
          result = m;
          break; // the child exits by itself a moment later
        }
      }
    } catch (err) {
      if (isAbort(err) || err instanceof CliError || !failure) throw err;
    } finally {
      this.running.delete(ac);
      if (!result) ac.abort(); // interrupted or failed: stop the child now
      else try { q.close?.(); } catch { /* already gone */ }
    }
    if (failure) throw apiFailure(failure.code, failure.text, limit);
    if (!result) throw new CliError('error', 'Claude Code stopped without answering.');
    if (result.is_error && result.subtype !== 'error_max_turns') throw new CliError('error', (result.errors || []).join('; ') || String(result.result || result.subtype));
    if (result.stop_reason === 'refusal' && !spoken) {
      spoken = "I'm afraid that's not something I can help with.";
      emit({ type: 'delta', text: spoken });
    }
    return spoken;
  }

  // ---- background extraction ------------------------------------------------

  /** One-shot structured extraction (used by the background memory builder). Resolves with the object or null. */
  async extractJson({ system, user, schema, fallbackModel }) {
    const bin = await this.binary();
    const { query } = await this.load();
    const models = [...EXTRACT_MODELS, ...(fallbackModel ? [fallbackModel] : [])];
    for (; this.extractModel < models.length; this.extractModel++) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 90000);
      this.running.add(ac);
      let result = null;
      let failure = null;
      try {
        const q = query({
          prompt: user,
          options: {
            ...sessionOptions({ bin, model: models[this.extractModel], effort: 'low', system, cwd: this.workDir, env: this.env }),
            includePartialMessages: false, thinking: { type: 'disabled' }, maxTurns: 4,
            outputFormat: { type: 'json_schema', schema }, abortController: ac,
          },
        });
        for await (const m of q) {
          if (m.type === 'system' && m.subtype === 'init' && (m.tools || []).some((t) => t !== 'StructuredOutput')) throw new CliError('unsafe', m.tools.join(', '));
          if (m.type === 'assistant' && m.error) failure = m.error;
          if (m.type === 'result') result = m;
        }
      } catch (err) {
        if (!failure && !result) throw spawnFailure(err);
      } finally {
        clearTimeout(timer);
        this.running.delete(ac);
        if (!result) ac.abort();
      }
      if (failure === 'model_not_found') continue; // this login does not have that model; try the next
      if (failure || !result || result.is_error || result.subtype !== 'success') return null;
      return result.structured_output ?? null;
    }
    return null;
  }
}
