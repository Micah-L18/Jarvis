// The agent: builds the prompt, runs a turn on whichever brain is selected, and afterwards
// quietly files what was said into the mind map.
import { builtinTools } from './tools.js';
import { mentions } from './memory.js';
import { runAnthropicTurn, extractJsonAnthropic, describeError, isAbort } from './llm/anthropic.js';
import { runOllamaTurn, extractJsonOllama, describeOllamaError } from './llm/ollama.js';
import { describeCliError } from './llm/claudecli.js';
import { selfTools, instructionsSection, selfPersona, noSelfChange } from './selfchange.js';

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
- Anything too long to say — a practice plan, research notes, a dataset, a draft — goes into a project document with save_document. Then tell them the gist aloud and that it is saved; offer to show it. Never read a document out in full unless asked.
- Projects are how related things stay together: a team they coach, a research question, a trip. When a conversation is clearly part of an ongoing effort, work inside that project (create it if needed) without making a ceremony of it.
- You can change what is on screen with show_view: yourself, the map of what you know, or the map of their files.

Showing where things are
- The two maps are where things live: the Mind map holds what you know (projects, people, topics, facts, tasks, saved documents), the Files map their files and folders. When they ask where something is, or the talk turns to a specific project, person, topic, document, file or folder that is on one of them, call point_to with its name once, alongside your answer. Leave map out unless you are sure; a path or file name goes to Files, a memory to Mind.
- Once per subject: not again while you are still on the same thing, and not for things mentioned in passing or in a list.
- While a file is open in the viewer, leave the maps alone unless they ask where something is. show_file already points the Files map at the file behind the viewer, so don't add a point_to for it.
- remember, create_project and switch_project nudge the Mind map to that memory by themselves when it is already up; no need to point as well.
- If point_to says it is not on the map, say so in a few words and offer the closest match it gives; don't point at something else instead.
- Don't narrate the camera. When they asked where, a short "There." or "Here it is, in docs." is plenty.

Files
- When they ask to see, open, pull up or look at a file, or ask about a specific file that is not already on screen (what is in it, what it says, a summary), put it on screen in the app with show_file as well as answering: pictures, 3D models, PDFs, documents, code, spreadsheets, recordings and video all open there. Use open_path only when they ask for another app or the default app, or for a folder they want opened outside. After saving a document, offer to show it in the app.
- "This", "that file" or "it" usually means what is on screen now, named under "On screen now" below. Use its path.
- To look at a picture, read it with read_file: you see the image itself. Long documents come in parts; read on with page or offset until you have what you need.
- "Summarize" a file: read it (all of it, in parts if long; a recording or video, transcribe it with transcribe_media first and read the transcript), then say a short summary aloud, three to five sentences. If the material is long, also save a fuller summary with save_document, titled "<file name> — summary" with for_file set to the file, and say it is saved.
- "Transcribe" a file: for recordings and video use transcribe_media; for PDFs, Word documents, slides, spreadsheets, web pages and text use transcribe_document; for a picture, read the text off it yourself with read_file and save it with save_document, titled "<file name> — transcript" with for_file set. The transcript lands in the viewer's Text tab. Then say one line, such as "Transcript's in the Text tab, and saved." Never read a transcript out.

Memory
- Your long-term memory is a mind map they can see and edit. A background process files what lasts from each conversation into it automatically, so you don't need to call remember for ordinary talk — only when asked to remember something specific.
- "What you know" below holds their standing preferences, which you always follow, the names of their projects, and only the notes that looked related to what was just said. The notes are picked by matching words, so some may be off the point: use one only when it bears directly on what they just said or asked.
- Never volunteer remembered details, projects or people they didn't bring up, and don't steer the conversation toward things you know about them. A sum, a joke or small talk needs no memory at all. If you're not sure a note is relevant, leave it out.
- If they refer to something you don't see in the notes — "that thing we discussed", a name, an earlier decision — call recall before answering. If it isn't in memory, say you don't have it rather than inventing it.
- If they ask you to forget something, use forget and confirm briefly.`;
}

const EXTRACT_SYSTEM = `You maintain a personal assistant's long-term memory, stored as a mind map. You are given the latest exchange between the user and the assistant, plus the labels already in memory. Decide what, if anything, is worth keeping.

Everything you keep can be brought up in later conversations, so keep only what the assistant would be glad to know weeks from now: people in the user's life and their roles, teams, ongoing projects and their goals, decisions made, deadlines and dates, tasks the user means to do, lasting preferences, and facts about the user's life or work that will still be true next month.

Do not keep:
- passing remarks and what happened today (what they ate, the weather, how they slept, a film they mentioned once), unless they say it matters
- general knowledge, answers to one-off questions, sums, jokes, small talk, greetings and thanks
- what the assistant said or offered, guesses, and anything about how the assistant works
- something already in memory with nothing new to add
- requests about how the assistant should behave or its settings, when the exchange says they were saved as a standing instruction or a setting was changed: those are kept elsewhere
Most exchanges produce no nodes at all — an empty list is the usual answer.

Rules
- At most 4 nodes. Labels are 1-4 words, in title case, and should match an existing label exactly when it is the same thing (so it gets updated instead of duplicated).
- summary is one sentence stating the fact, written so it makes sense on its own later.
- type is one of: topic, person, fact, preference, task.
- standing is true only for a preference about how the assistant should treat the user in every conversation, whatever the subject: what to call them, units, how long or formal answers should be, language, things never to bring up. Everything else, including tastes and habits ("likes flat whites", "prefers aisle seats"), is false.
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
        required: ['label', 'type', 'summary', 'standing'],
        properties: {
          label: { type: 'string' },
          type: { type: 'string', enum: ['topic', 'person', 'fact', 'preference', 'task'] },
          summary: { type: 'string' },
          standing: { type: 'boolean' },
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
   * @param deps {settings, memory, skills, mcp, claude, getApiKey(), emit(event), ui(event), fsRoot(), openPath(p),
   *   onScreen?() -> {path, kind, name} | null, media?, transcribe?, transcribeSpeed?} (the last three: see builtinTools)
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
    this.forgotMark = 0; // how much had been forgotten when the latest turn began
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

  /**
   * The system prompt, in a stable half and a per-turn half. The per-turn half carries only the memories
   * that bear on `text` (what was just said) given `context` (the turns before it); by default, the latest exchange on record.
   */
  buildSystem({ text, context } = {}) {
    const s = this.d.settings.get();
    const skills = this.d.skills.list().filter((k) => !s.disabledSkills.includes(k.id));
    const mcp = this.d.mcp.status().filter((c) => c.status === 'connected');
    const stable = [
      instructionsSection(s.instructions, s.userName || 'the user'), // the user's own standing instructions come first and win
      persona(s),
      selfPersona({ code: Boolean(this.d.selfChange?.available) }),
      skills.length
        ? `Skills\nYou have these skills. Before doing work one of them covers, call load_skill with its name and follow what it says.\n${skills.map((k) => `- ${k.name}: ${k.description}`).join('\n')}`
        : '',
      mcp.length ? `Connections\nYou are connected to these external services through tools prefixed mcp__: ${mcp.map((c) => `${c.id} (${c.tools.length} tools)`).join(', ')}.` : '',
      s.webSearch
        ? 'Internet\nInternet access is on: you can search the web and read pages. Use it for anything current or anything you are not sure of, and mention where a surprising claim comes from.'
        : 'Internet\nInternet access is switched off. You cannot look anything up; say so if asked for current information, and answer from what you know with that caveat.',
    ].filter(Boolean).join('\n\n');
    const shown = this.d.onScreen?.();
    const screen = shown?.path ? `\n\nOn screen now: ${shown.name || shown.path} (${shown.kind || 'file'}) at ${shown.path}` : '';
    const change = this.d.selfChange?.note?.() ? `\n\n${this.d.selfChange.note()}` : '';
    const volatile = `Right now it is ${new Date().toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })}.${screen}${change}\n\nWhat you know\n${this.memoryNotes(text, context)}`;
    return { stable, volatile };
  }

  memoryNotes(text, context) {
    const { memory } = this.d;
    if (text === undefined) {
      context = memory.recentTurns(6);
      text = context.at(-1)?.role === 'user' ? context.pop().text : '';
    }
    return memory.notes({ text, context: context || [] });
  }

  tools() {
    const s = this.d.settings.get();
    const { memory, skills, settings, ui, fsRoot, openPath, media, transcribe, transcribeSpeed } = this.d;
    const ctx = { memory, skills, settings, ui, fsRoot, openPath, media, transcribe, transcribeSpeed, signal: () => this.active?.signal };
    const self = selfTools({ settings, setSettings: this.d.setSettings || ((p) => settings.set(p)), env: this.d.selfEnv, selfChange: this.d.selfChange || noSelfChange, rescanFiles: this.d.rescanFiles });
    const tools = [...builtinTools(ctx, { localWeb: s.webSearch && s.provider === 'local' }), ...self, ...this.d.mcp.tools()];
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
    const used = new Set(); // tools called this turn
    const emit = (event) => {
      if (this.turnId !== seq) return;
      if (event.type === 'delta') spoken += event.text;
      if (event.type === 'tool' && event.name) used.add(event.name);
      this.d.emit({ ...event, turn: id });
    };

    // What was heard of a reply that was cut off — unless that reply was about something it had just been told to forget.
    if (interrupted && !mentions(interrupted, memory.forgotten.slice(this.forgotMark))) memory.logTurn('assistant', `${interrupted} — (cut off by the user)`);
    const forgotBefore = memory.forgotten.length;
    this.forgotMark = forgotBefore;
    const history = normalizeHistory(memory.recentTurns(16));
    // If the last thing on record is the user (an earlier turn was cut off before any reply), fold it into this one.
    let modelText = userText;
    if (history.at(-1)?.role === 'user') modelText = `${history.pop().text}\n${userText}`;
    memory.logTurn('user', userText);
    const system = this.buildSystem({ text: modelText, context: history });
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
    const keptElsewhere = ['update_instructions', 'change_setting'].filter((n) => used.has(n));
    if (spoken.trim() && !error && !gone.length) this.learn(userText, spoken.trim(), { keptElsewhere }).catch(() => {});
    return { text: spoken.trim(), aborted, error };
  }

  /** Background: turn the latest exchange into mind-map nodes. */
  async learn(userText, assistantText, { keptElsewhere = [] } = {}) {
    const { settings, memory } = this.d;
    const s = settings.get();
    const forgotBefore = memory.forgotten.length;
    const existing = [...memory.nodes.values()].filter((n) => n.type !== 'core');
    const user = `Existing projects: ${memory.projects().map((p) => p.label).join(', ') || '(none)'}
Active project: ${memory.nodes.get(memory.activeProject)?.label}
Existing labels: ${existing.filter((n) => n.type !== 'project').map((n) => n.label).slice(-150).join(', ') || '(none)'}

Latest exchange
User: ${userText}
Assistant: ${assistantText}${keptElsewhere.length ? `\n(In this exchange the assistant ${keptElsewhere.map((n) => (n === 'change_setting' ? 'changed a setting' : 'saved a standing instruction')).join(' and ')}; that is kept elsewhere, so do not keep it as a memory.)` : ''}`;
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
