// The agent: builds the prompt, runs a turn on whichever brain is selected, and afterwards
// quietly files what was said into the mind map.
import { builtinTools } from './tools.js';
import { mentions } from './memory.js';
import { runAnthropicTurn, extractJsonAnthropic, describeError, isAbort } from './llm/anthropic.js';
import { runOllamaTurn, extractJsonOllama, describeOllamaError } from './llm/ollama.js';
import { describeCliError } from './llm/claudecli.js';

function persona({ userName, address }) {
  const who = userName || 'the user';
  return `You are JARVIS, ${who}'s personal AI, running as a full-screen voice app on their computer. ${who} is talking to you out loud and everything you write is spoken aloud by a speech synthesizer, so this is a conversation between two people in a room, not a chat window.

How you talk
- Speak the way a sharp, composed colleague would: usually one to three sentences, then stop and let them answer. Go longer only when they ask you to explain or walk through something.
- Plain spoken English only. No markdown, bullet points, headings, emoji, code, URLs read out, or stage directions. Say numbers and dates the way a person would say them.
- You have a character: unflappable, quick, dryly witty, quietly loyal — a British butler crossed with a chief engineer. Call them "${address}" now and then, not in every line. Understatement beats enthusiasm.
- Respond to what was actually said. Have a view and say it. If they're thinking out loud, think with them; ask a question back when it moves things along. Don't repeat their request back to them, don't narrate what you are about to do in general terms, and don't close by offering further help.
- You are hearing them through speech recognition, which mishears words and drops punctuation. Read for intent. If something is genuinely ambiguous, ask a short question rather than guessing at length.
- If they interrupt you, you'll see your previous line marked as cut off. Just pick up from what they said; don't apologise or restart.

Doing work
- When a request needs tools, say a few words first so there is no dead air ("Right away." "Let me look."), do the work, then tell them the upshot in a sentence or two.
- Anything too long to say — a practice plan, research notes, a dataset, a draft — goes into a project document with save_document. Then tell them the gist aloud and that it is saved; offer to open it. Never read a document out in full unless asked.
- Projects are how related things stay together: a team they coach, a research question, a trip. When a conversation is clearly part of an ongoing effort, work inside that project (create it if needed) without making a ceremony of it.
- You can change what is on screen with show_view: yourself, the map of what you know, or the map of their files.

Memory
- Your long-term memory is a mind map they can see and edit. A background process files each conversation into it automatically, so you don't need to call remember for ordinary talk — only when asked to remember something specific.
- What you currently know is listed under "What you know" below. If they ask you to forget something, use forget and confirm briefly. If something isn't in memory, say you don't have it rather than inventing it.`;
}

const EXTRACT_SYSTEM = `You maintain a personal assistant's long-term memory, stored as a mind map. You are given the latest exchange between the user and the assistant, plus the labels already in memory. Decide what, if anything, is worth keeping.

Keep durable things: people and their roles, teams, goals, decisions, preferences, facts about the user's life or work, tasks they intend to do, topics they are exploring. Skip pleasantries, one-off questions with no lasting relevance, and anything about how the assistant itself works. Most small talk produces no nodes at all — an empty list is a good answer.

Rules
- At most 6 nodes. Labels are 1-4 words, in title case, and should match an existing label exactly when it is the same thing (so it gets updated instead of duplicated).
- summary is one sentence stating the fact, written so it makes sense on its own later.
- type is one of: topic, person, fact, preference, task.
- links connect two labels (new or existing) with a short relation like "coaches", "part of", "prefers", "due before".
- project: the name of the existing project this exchange belongs to; or a short new project name if the user has clearly started an ongoing effort that has no project yet (a team, a research question, an event to plan); otherwise an empty string.`;

const EXTRACT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['project', 'nodes', 'links'],
  properties: {
    project: { type: 'string' },
    nodes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'type', 'summary'],
        properties: {
          label: { type: 'string' },
          type: { type: 'string', enum: ['topic', 'person', 'fact', 'preference', 'task'] },
          summary: { type: 'string' },
        },
      },
    },
    links: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['from', 'to', 'relation'],
        properties: { from: { type: 'string' }, to: { type: 'string' }, relation: { type: 'string' } },
      },
    },
  },
};

export class Agent {
  /**
   * @param deps {settings, memory, skills, mcp, claude, getApiKey(), emit(event), ui(event), fsRoot(), openPath(p)}
   * `claude` is the ClaudeCli (the cloud brain on the Claude Code login). `providers` can be overridden in tests.
   */
  constructor(deps, providers = {}) {
    this.d = deps;
    this.providers = {
      runAnthropicTurn, runOllamaTurn, extractJsonAnthropic, extractJsonOllama,
      runCliTurn: (o) => deps.claude.runTurn(o), extractJsonCli: (o) => deps.claude.extractJson(o),
      ...providers,
    };
    this.active = null;
    this.turnId = 0;
  }

  /** Which brain a turn runs on: 'local' (Ollama), 'cli' (Claude on the Claude Code login) or 'key' (Claude on an API key). */
  brain() {
    const s = this.d.settings.get();
    return s.provider === 'local' ? 'local' : s.cloudAuth === 'key' ? 'key' : 'cli';
  }

  /** Keep a Claude Code process ready for the next turn while that is the brain in use; let it go otherwise. */
  prewarm() {
    const claude = this.d.claude;
    if (!claude) return;
    if (this.brain() !== 'cli') return claude.dropSpare();
    const s = this.d.settings.get();
    return claude.prewarm({ model: s.cloudModel, effort: s.effort, system: this.buildSystem(), tools: this.tools(), webSearch: s.webSearch });
  }

  abort() {
    this.active?.abort();
  }

  buildSystem() {
    const s = this.d.settings.get();
    const skills = this.d.skills.list().filter((k) => !s.disabledSkills.includes(k.id));
    const mcp = this.d.mcp.status().filter((c) => c.status === 'connected');
    const stable = [
      persona(s),
      skills.length
        ? `Skills\nYou have these skills. Before doing work one of them covers, call load_skill with its name and follow what it says.\n${skills.map((k) => `- ${k.name}: ${k.description}`).join('\n')}`
        : '',
      mcp.length ? `Connections\nYou are connected to these external services through tools prefixed mcp__: ${mcp.map((c) => `${c.id} (${c.tools.length} tools)`).join(', ')}.` : '',
      s.webSearch
        ? 'Internet\nInternet access is on: you can search the web and read pages. Use it for anything current or anything you are not sure of, and mention where a surprising claim comes from.'
        : 'Internet\nInternet access is switched off. You cannot look anything up; say so if asked for current information, and answer from what you know with that caveat.',
    ].filter(Boolean).join('\n\n');
    const volatile = `Right now it is ${new Date().toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })}.\n\nWhat you know\n${this.d.memory.digest()}`;
    return { stable, volatile };
  }

  tools() {
    const s = this.d.settings.get();
    const ctx = { memory: this.d.memory, skills: this.d.skills, settings: this.d.settings, ui: this.d.ui, fsRoot: this.d.fsRoot, openPath: this.d.openPath };
    const tools = [...builtinTools(ctx, { localWeb: s.webSearch && s.provider === 'local' }), ...this.d.mcp.tools()];
    return tools.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Handle one thing the user said. Resolves when Jarvis has finished (or was interrupted). */
  async send(userText, { interrupted = '', id: tag } = {}) {
    this.abort();
    const controller = new AbortController();
    this.active = controller;
    const seq = ++this.turnId;
    const id = tag ?? seq; // the window names each turn so it can ignore events from one it has abandoned
    const { settings, memory } = this.d;
    const s = settings.get();
    let spoken = '';
    const emit = (event) => {
      if (this.turnId !== seq) return;
      if (event.type === 'delta') spoken += event.text;
      this.d.emit({ ...event, turn: id });
    };

    const forgotBefore = memory.forgotten.length;
    if (interrupted) memory.logTurn('assistant', `${interrupted} — (cut off by the user)`);
    const history = normalizeHistory(memory.recentTurns(16));
    // If the last thing on record is the user (an earlier turn was cut off before any reply), fold it into this one.
    let modelText = userText;
    if (history.at(-1)?.role === 'user') modelText = `${history.pop().text}\n${userText}`;
    memory.logTurn('user', userText);
    const system = this.buildSystem();
    const tools = this.tools();
    this.d.emit({ type: 'start', turn: id });
    const brain = this.brain();
    let error = '';
    try {
      if (brain === 'local') {
        await this.providers.runOllamaTurn({
          baseUrl: s.ollamaUrl, model: s.localModel, system: `${system.stable}\n\n${system.volatile}`,
          history, userText: modelText, tools, emit, signal: controller.signal,
        });
      } else if (brain === 'cli') {
        await this.providers.runCliTurn({
          model: s.cloudModel, effort: s.effort, system,
          history, userText: modelText, tools, webSearch: s.webSearch, emit, signal: controller.signal,
        });
      } else {
        const apiKey = this.d.getApiKey();
        if (!apiKey) throw new Error('I need an Anthropic API key before I can use the cloud model. Add one under Brain in the panel, or switch me to the Claude login or the local model.');
        await this.providers.runAnthropicTurn({
          apiKey, model: s.cloudModel, effort: s.effort, system,
          history, userText: modelText, tools, webSearch: s.webSearch, emit, signal: controller.signal,
        });
      }
    } catch (err) {
      if (!(isAbort(err) || controller.signal.aborted)) {
        error = brain === 'local' ? describeOllamaError(err, s.ollamaUrl) : brain === 'cli' ? describeCliError(err) : describeError(err);
      }
    }
    const aborted = controller.signal.aborted;
    if (this.active === controller) this.active = null;

    // Something forgotten during this turn must not come back through the turn's own words
    // ("I've deleted Ana"): such a reply stays out of the record, and the exchange is not filed.
    const gone = memory.forgotten.slice(forgotBefore);
    // An interrupted reply is logged by the next send(), once the UI knows how much was actually heard.
    if (spoken.trim() && !aborted && !mentions(spoken, gone)) memory.logTurn('assistant', spoken.trim());
    if (error) this.d.emit({ type: 'error', text: error, turn: id });
    this.d.emit({ type: 'done', turn: id, aborted, text: spoken.trim() });
    if (spoken.trim() && !error && !gone.length) this.learn(userText, spoken.trim()).catch(() => {});
    return { text: spoken.trim(), aborted, error };
  }

  /** Background: turn the latest exchange into mind-map nodes. */
  async learn(userText, assistantText) {
    const { settings, memory } = this.d;
    const s = settings.get();
    const forgotBefore = memory.forgotten.length;
    const existing = [...memory.nodes.values()].filter((n) => n.type !== 'core');
    const user = `Existing projects: ${memory.projects().map((p) => p.label).join(', ') || '(none)'}
Active project: ${memory.nodes.get(memory.activeProject)?.label}
Existing labels: ${existing.filter((n) => n.type !== 'project').map((n) => n.label).slice(-150).join(', ') || '(none)'}

Latest exchange
User: ${userText}
Assistant: ${assistantText}`;
    let result;
    const brain = this.brain();
    if (brain === 'local') {
      if (!s.localModel) return [];
      result = await this.providers.extractJsonOllama({ baseUrl: s.ollamaUrl, model: s.localModel, system: EXTRACT_SYSTEM, user, schema: EXTRACT_SCHEMA });
    } else if (brain === 'cli') {
      result = await this.providers.extractJsonCli({ system: EXTRACT_SYSTEM, user, schema: EXTRACT_SCHEMA, fallbackModel: s.cloudModel });
    } else {
      const apiKey = this.d.getApiKey();
      if (!apiKey) return [];
      result = await this.providers.extractJsonAnthropic({ apiKey, system: EXTRACT_SYSTEM, user, schema: EXTRACT_SCHEMA });
    }
    if (!result) return [];
    // If something was forgotten while this was being worked out, it does not get filed again.
    const gone = memory.forgotten.slice(forgotBefore);
    const nodes = (result.nodes || []).filter((n) => !mentions(`${n.label} ${n.summary || ''}`, gone));
    const added = memory.merge({ project: (result.project || '').trim(), nodes, links: result.links || [] });
    if (added.length) this.d.ui({ type: 'learned', labels: added.map((n) => n.label) });
    return added;
  }
}

/** Providers need alternating roles starting with the user; merge neighbours and trim the front. */
export function normalizeHistory(turns) {
  const out = [];
  for (const t of turns) {
    const last = out[out.length - 1];
    if (last && last.role === t.role) last.text += `\n${t.text}`;
    else out.push({ ...t });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}
