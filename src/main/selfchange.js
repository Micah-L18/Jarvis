// Jarvis changing itself when asked, from safe to powerful:
//   1. settings by voice (change_setting): an explicit list of what may be changed by talking, checked like the controls would;
//   2. standing instructions (update_instructions): a short list the user owns, put at the top of the system prompt;
//   3. its own code (change_myself): a Claude Code agent on the user's Claude login edits a separate git worktree on a branch of
//      its own; the result is built and tested, shown as a diff, and merged into the running checkout only on an explicit yes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { CLOUD_MODELS } from './llm/anthropic.js';
import { claudeEnv, CliError, describeCliError } from './llm/claudecli.js';

const str = (description) => ({ type: 'string', description });
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

// ---- 1. settings by voice ----------------------------------------------------------

const KOKORO_VOICES = {
  bm_george: 'George', bm_lewis: 'Lewis', bm_daniel: 'Daniel', bm_fable: 'Fable', bf_emma: 'Emma', bf_isabella: 'Isabella',
  am_michael: 'Michael', am_fenrir: 'Fenrir', af_heart: 'Heart', af_bella: 'Bella',
};
const ENGINES = { tiny: 'the fast voice', kokoro: 'the neural voice', system: 'the system voice', off: 'silent, captions only' };
const ENGINE_WORDS = { fast: 'tiny', 'tiny-voca': 'tiny', neural: 'kokoro', natural: 'kokoro', british: 'kokoro', silent: 'off', captions: 'off', none: 'off', mute: 'off' };
const EFFORTS = { low: 'quick', medium: 'balanced', high: 'deep' };
const EFFORT_WORDS = { quick: 'low', fast: 'low', balanced: 'medium', normal: 'medium', deep: 'high', careful: 'high', hard: 'high' };
const SPEED_WORDS = { slow: 0.9, slower: 0.9, unhurried: 0.9, normal: 1, default: 1, fast: 1.15, faster: 1.15, brisk: 1.15, quick: 1.15 };

function parseBool(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (['true', 'on', 'yes', '1', 'enable', 'enabled', 'start'].includes(v)) return true;
  if (['false', 'off', 'no', '0', 'disable', 'disabled', 'stop'].includes(v)) return false;
  return null;
}
const plainText = (value, max) => {
  const v = String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  return v.length <= max ? v : null;
};
const onOff = (v) => (v ? 'on' : 'off');

/**
 * What may be changed by talking. Each entry turns a spoken value into a settings patch (or says why not),
 * given the current settings and what the computer has (env: {claudeReady, hasApiKey, isDir(p), home}).
 */
export const VOICE_SETTINGS = {
  voice_engine: {
    help: 'tiny (fast voice), kokoro (neural voice), system, or off (captions only)',
    set(value) {
      const v = String(value).trim().toLowerCase();
      const tts = ENGINES[v] ? v : ENGINE_WORDS[v];
      if (!tts) return { error: `voice_engine must be one of: ${this.help}.` };
      return { patch: { voice: { tts, ttsChosen: true } }, said: `voice set to ${ENGINES[tts]}` };
    },
  },
  voice: {
    help: 'for the fast voice: male (M2) or female (F2); for the neural voice a name: George, Lewis, Daniel, Fable, Emma, Isabella, Michael, Fenrir, Heart, Bella; for the system voice, the voice\'s name',
    set(value, s) {
      const v = String(value).trim();
      const low = v.toLowerCase();
      if (s.voice.tts === 'tiny') {
        const id = ['m2', 'male', 'man'].includes(low) ? 'M2' : ['f2', 'female', 'woman'].includes(low) ? 'F2' : '';
        if (!id) return { error: 'The fast voice comes as male (M2) or female (F2). For a named voice, switch voice_engine to kokoro first.' };
        return { patch: { voice: { tinyVoice: id } }, said: `the fast voice is now ${id === 'M2' ? 'male' : 'female'}` };
      }
      if (s.voice.tts === 'kokoro') {
        const id = Object.keys(KOKORO_VOICES).find((k) => k === low || KOKORO_VOICES[k].toLowerCase() === low);
        if (!id) return { error: `The neural voice has: ${Object.values(KOKORO_VOICES).join(', ')}.` };
        return { patch: { voice: { kokoroVoice: id } }, said: `the neural voice is now ${KOKORO_VOICES[id]}` };
      }
      if (s.voice.tts === 'system') {
        const name = plainText(v, 80);
        if (name === null) return { error: 'That voice name is too long.' };
        return { patch: { voice: { systemVoice: name } }, said: name ? `system voice set to ${name}` : 'system voice set to the best British voice available' };
      }
      return { error: 'Speech is off; set voice_engine first.' };
    },
  },
  voice_speed: {
    help: 'a number from 0.8 to 1.3 (1 is normal), or slow, normal, fast',
    set(value, s) {
      const low = String(value).trim().toLowerCase();
      const n = SPEED_WORDS[low] ?? Number(low);
      if (!Number.isFinite(n) || n < 0.8 || n > 1.3) return { error: `voice_speed must be ${this.help}.` };
      const note = s?.voice?.tts && s.voice.tts !== 'tiny' ? ' (it applies to the fast voice; the current voice keeps its own pace)' : '';
      return { patch: { voice: { tinySpeed: Math.round(n * 100) / 100 } }, said: `speaking speed set to ${n}${note}` };
    },
  },
  hands_free: {
    help: 'on (always listening) or off (push to talk)',
    set(value) {
      const b = parseBool(value);
      if (b === null) return { error: 'hands_free must be on or off.' };
      return { patch: { voice: { handsFree: b } }, said: b ? 'hands-free listening on' : 'hands-free off; hold Space to talk' };
    },
  },
  interruptions: {
    help: 'on (the user can talk over Jarvis to interrupt) or off',
    set(value) {
      const b = parseBool(value);
      if (b === null) return { error: 'interruptions must be on or off.' };
      return { patch: { voice: { bargeIn: b } }, said: `interrupting while I talk ${onOff(b)}` };
    },
  },
  address: {
    help: 'how Jarvis addresses the user, e.g. sir, ma\'am, boss, or their first name',
    set(value) {
      const v = plainText(value, 30);
      if (!v) return { error: 'address must be a short form of address, up to 30 characters.' };
      return { patch: { address: v }, said: `I'll address you as ${v}` };
    },
  },
  user_name: {
    help: 'the user\'s name (empty to clear)',
    set(value) {
      const v = plainText(value, 40);
      if (v === null) return { error: 'user_name must be up to 40 characters.' };
      return { patch: { userName: v }, said: v ? `your name is set to ${v}` : 'your name is cleared' };
    },
  },
  cloud_model: {
    help: `one of ${CLOUD_MODELS.map((m) => m.label.replace(/^Claude /, '').replace(/ \(.*\)$/, '')).join(', ')}`,
    set(value) {
      const low = String(value).trim().toLowerCase();
      const m = CLOUD_MODELS.find((x) => x.id === low) || CLOUD_MODELS.find((x) => low && x.label.toLowerCase().includes(low.replace(/^claude\s+/, '')));
      if (!m) return { error: `cloud_model must be ${this.help}.` };
      return { patch: { cloudModel: m.id }, said: `cloud model set to ${m.label.replace(/ \(.*\)$/, '')}` };
    },
  },
  thinking: {
    help: 'low (quick), medium (balanced) or high (deep)',
    set(value) {
      const low = String(value).trim().toLowerCase();
      const effort = EFFORTS[low] ? low : EFFORT_WORDS[low];
      if (!effort) return { error: `thinking must be ${this.help}.` };
      return { patch: { effort }, said: `thinking set to ${EFFORTS[effort]}` };
    },
  },
  internet: {
    help: 'on or off (web search and reading pages)',
    set(value) {
      const b = parseBool(value);
      if (b === null) return { error: 'internet must be on or off.' };
      return { patch: { webSearch: b }, said: `internet access ${onOff(b)}` };
    },
  },
  brain: {
    help: 'cloud (Claude) or local (Ollama)',
    set(value, s, env) {
      const low = String(value).trim().toLowerCase();
      const provider = ['cloud', 'claude', 'online'].includes(low) ? 'cloud' : ['local', 'ollama', 'offline'].includes(low) ? 'local' : '';
      if (!provider) return { error: 'brain must be cloud or local.' };
      if (provider === 'local' && !s.localModel) return { error: 'No local model is chosen yet. That needs Ollama and a model picked under Brain in the controls.' };
      if (provider === 'cloud' && (s.cloudAuth === 'key' ? !env.hasApiKey : !env.claudeReady)) {
        return { error: s.cloudAuth === 'key' ? 'The cloud brain has no API key yet; it can be added under Brain in the controls.' : 'The Claude login is not ready (Claude Code missing or signed out); see Brain in the controls.' };
      }
      return { patch: { provider }, said: provider === 'local' ? `switched to the local model, ${s.localModel}` : 'switched to the cloud model' };
    },
  },
  files_folder: {
    help: 'an existing folder inside the home folder (or inside the current files folder), as a full path or starting with ~; anywhere else is chosen with Change folder in the controls',
    set(value, s, env) {
      let p = String(value ?? '').trim();
      if (!p) return { error: 'files_folder needs a folder path.' };
      const home = env.home || os.homedir();
      if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = path.join(home, p.slice(1));
      if (!path.isAbsolute(p)) return { error: 'files_folder needs a full path (or one starting with ~).' };
      if (!env.isDir(p)) return { error: `There is no folder at ${path.resolve(p)}.` };
      // Where it really is, links followed (/proc/self/root, a link to /, a volume alias): that is what file access would reach.
      const real = (x) => { try { return (env.realpath || fs.realpathSync.native)(x); } catch { return null; } };
      const at = real(p);
      if (!at || path.parse(at).root === at) return { error: 'I won\'t take the whole disk as the files folder; name a folder.' };
      // By voice it only moves within the home folder or within the folder it already has: wider is a choice made in the controls.
      const within = [home, s?.fsRoot].filter(Boolean).map(real).filter((r) => r && path.parse(r).root !== r);
      if (!within.some((r) => inside(r, at))) return { error: `By voice I can only move the files folder within your home folder; for ${at}, use Change folder under Files in the controls.` };
      return { patch: { fsRoot: at }, said: `files folder set to ${at}`, rescan: true };
    },
  },
  files_depth: {
    help: 'how many folder levels the Files map shows at first, 2 to 5',
    set(value) {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 2 || n > 5) return { error: 'files_depth must be a whole number from 2 to 5.' };
      return { patch: { fsDepth: n }, said: `files map shows ${n} levels`, rescan: true };
    },
  },
  start_fullscreen: {
    help: 'on or off',
    set(value) {
      const b = parseBool(value);
      if (b === null) return { error: 'start_fullscreen must be on or off.' };
      return { patch: { startFullscreen: b }, said: `starting full screen ${onOff(b)}` };
    },
  },
};

/** Check one spoken setting change. Returns {patch, said, rescan?} or {error}. Never touches anything outside VOICE_SETTINGS. */
export function changeSetting(name, value, settings, env = {}) {
  const key = String(name || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!Object.hasOwn(VOICE_SETTINGS, key)) return { error: `"${name}" is not something I can change by voice. I can change: ${Object.keys(VOICE_SETTINGS).join(', ')}. Anything else is in the controls (Tab).` };
  if (value === undefined || value === null) return { error: `Give a value: ${VOICE_SETTINGS[key].help}.` };
  return VOICE_SETTINGS[key].set(value, settings, { isDir: () => false, ...env });
}

// ---- 2. standing instructions -------------------------------------------------------

export const INSTRUCTIONS_MAX = 12;
export const INSTRUCTION_CHARS = 200;
export const INSTRUCTIONS_TOTAL = 1500;

const words = (t) => String(t).toLowerCase().match(/[a-z0-9']+/g) || [];

/** Which instruction `which` means: its number (from 1), or the one sharing the most words with it. -1 if none. */
export function findInstruction(list, which) {
  const w = String(which ?? '').trim();
  if (!w) return -1;
  if (/^\d+$/.test(w)) {
    const i = Number(w) - 1;
    return i >= 0 && i < list.length ? i : -1;
  }
  const low = w.toLowerCase();
  const exact = list.findIndex((t) => t.toLowerCase().includes(low) || low.includes(t.toLowerCase()));
  if (exact >= 0) return exact;
  const want = new Set(words(w).filter((x) => x.length > 2));
  let best = -1;
  let score = 0;
  list.forEach((t, i) => {
    const n = words(t).filter((x) => want.has(x)).length;
    if (n > score) { score = n; best = i; }
  });
  return best;
}

/** Add, remove, replace or list. Returns {list, said} or {error}. The list is the user's; nothing else is touched. */
export function editInstructions(current, { action, text, which } = {}) {
  const list = Array.isArray(current) ? current.filter((t) => typeof t === 'string' && t.trim()) : [];
  const clean = plainText(text, INSTRUCTION_CHARS);
  const numbered = () => (list.length ? list.map((t, i) => `${i + 1}. ${t}`).join('\n') : '(none)');
  const fits = (next) => next.length <= INSTRUCTIONS_MAX && next.join('\n').length <= INSTRUCTIONS_TOTAL;
  switch (action) {
    case 'list':
      return { list, said: list.length ? `Standing instructions:\n${numbered()}` : 'There are no standing instructions.' };
    case 'add': {
      if (!clean) return { error: String(text ?? '').trim() ? `That is too long for a standing instruction; keep it under ${INSTRUCTION_CHARS} characters.` : 'add needs the instruction text.' };
      if (list.some((t) => t.toLowerCase() === clean.toLowerCase())) return { list, said: `Already there: "${clean}".` };
      const next = [...list, clean];
      if (!fits(next)) return { error: `The list is full (at most ${INSTRUCTIONS_MAX} instructions, ${INSTRUCTIONS_TOTAL} characters in all). Remove or merge one first. Current:\n${numbered()}` };
      return { list: next, said: `Saved: "${clean}".` };
    }
    case 'remove': {
      const i = findInstruction(list, which ?? text);
      if (i < 0) return { error: `No standing instruction matches that. Current:\n${numbered()}` };
      return { list: list.filter((_, j) => j !== i), said: `Removed: "${list[i]}".` };
    }
    case 'replace': {
      if (!clean) return { error: String(text ?? '').trim() ? `That is too long; keep it under ${INSTRUCTION_CHARS} characters.` : 'replace needs the new text.' };
      const i = findInstruction(list, which);
      if (i < 0) return { error: `No standing instruction matches "${which ?? ''}". Current:\n${numbered()}` };
      const next = list.map((t, j) => (j === i ? clean : t));
      if (!fits(next)) return { error: `That would make the list too long (${INSTRUCTIONS_TOTAL} characters in all).` };
      return { list: next, said: `Replaced "${list[i]}" with "${clean}".` };
    }
    default:
      return { error: 'action must be add, remove, replace or list.' };
  }
}

/** The top of the stable system prompt: the user's own instructions, which win over the defaults that follow. */
export function instructionsSection(list, who = 'the user') {
  const items = (Array.isArray(list) ? list : []).filter((t) => typeof t === 'string' && t.trim()).slice(0, INSTRUCTIONS_MAX);
  if (!items.length) return '';
  return `Standing instructions from ${who}
${who[0].toUpperCase()}${who.slice(1)} set these themselves. They take precedence over everything that follows — your default manner, length, form of address and what you bring up — wherever the two conflict. Follow them in every reply until ${who} changes them.
${items.map((t) => `- ${t}`).join('\n')}`;
}

/** How Jarvis decides between the three levels. A persona section of its own, after the defaults. */
export function selfPersona({ code = false } = {}) {
  return `Changing yourself
- When they ask you to behave or look differently, use the lightest thing that does it. A setting first (change_setting: voice, speed, hands-free, interruptions, how you address them, their name, model, thinking, internet, brain, files folder): confirm in one short sentence what you changed. Then a standing instruction (update_instructions) for how you should talk or behave from now on ("shorter answers", "don't bring up volleyball", "use metric"): say back the instruction you saved, in a few words.
- ${code
    ? 'Only for what neither can do — how you look, a new feature, a change to how you work ("make the orb blue", "add a timer") — change your own code with change_myself. Before calling it, say in one sentence what you will change and ask if they want you to go ahead; call it on a yes, with their request in their words. It works in the background in a separate copy; tell them in a few words and carry on talking. When it reports back, the diff is on screen: apply_change only after an explicit yes, discard_change on a no or "stop". undo_last_change reverts the last applied change.'
    : 'Changes to your own code are not possible in this build (it is not running from its source); say you can change settings and standing instructions, and what you can do with those.'}
- Never say a change is made, saved or applied before the tool says so. If a tool refuses, say why in a few words.`;
}

// ---- 3. changes to its own code -------------------------------------------------------

const SKIP = new Set(['please', 'can', 'could', 'you', 'jarvis', 'i', 'want', 'would', 'like', 'to', 'the', 'a', 'an', 'my', 'your', 'me', 'for']);
/** jarvis/self-<date>-<slug>: a branch name git accepts, from what was asked. */
export function branchName(request, date = new Date()) {
  const d = date.toISOString().slice(0, 10);
  let slug = '';
  for (const w of words(request).map((x) => x.replace(/'/g, '')).filter((x) => x && !SKIP.has(x))) {
    if (slug && slug.length + w.length + 1 > 40) break;
    slug = slug ? `${slug}-${w}` : w.slice(0, 40);
  }
  slug = slug || 'change';
  return `jarvis/self-${d}-${slug}`;
}

/** Is Jarvis running from a git checkout of its own source? */
export function sourceCheckout(appPath) {
  try {
    if (!appPath || !fs.existsSync(path.join(appPath, '.git'))) return { ok: false, reason: 'not running from a git checkout of its source' };
    const pkg = JSON.parse(fs.readFileSync(path.join(appPath, 'package.json'), 'utf8'));
    if (pkg.name !== 'jarvis') return { ok: false, reason: 'the folder it runs from is not Jarvis\'s source' };
    return { ok: true, dir: appPath };
  } catch {
    return { ok: false, reason: 'not running from a git checkout of its source' };
  }
}

/** A path made absolute and with the links of its existing part followed, so it can be compared with a root. */
export function realish(p) {
  let cur = path.resolve(p);
  const rest = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...rest);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      rest.unshift(path.basename(cur));
      cur = parent;
    }
  }
}
const inside = (root, p) => {
  const rel = path.relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

const FILE_TOOLS = { Read: 'read', Glob: 'read', Grep: 'read', Edit: 'write', Write: 'write', MultiEdit: 'write', NotebookEdit: 'write' };
const hasDotDot = (p) => String(p).split(/[\\/]+/).includes('..');

/**
 * The whole policy for the self-change agent's tools: reading, searching and editing files inside its worktree, nothing else.
 * It runs no commands at all (no Bash): anything it could run, it could also have written, so nothing it writes runs before
 * the user has said yes. Paths with ".." are refused rather than resolved, since a ".." after a link (node_modules) leads
 * somewhere else on disk than it does on paper.
 */
export function toolAllowed(name, input = {}, opts = {}) {
  const deny = (reason) => ({ ok: false, reason });
  if (name === 'Bash') return deny('This job runs no commands. Read, Glob and Grep to look, Edit and Write to change files; Jarvis builds, tests and commits it once the user agrees.');
  if (name === 'TodoWrite') return { ok: true };
  const mode = FILE_TOOLS[name];
  if (!mode) return deny(`${name} is not available for this job.`);
  const root = realish(opts.worktree);
  if (name === 'Glob' && typeof input.pattern === 'string' && (path.isAbsolute(input.pattern) || hasDotDot(input.pattern) || /^~/.test(input.pattern))) {
    const fixed = input.pattern.split(/[*?[{]/)[0];
    if (/^~/.test(input.pattern) || hasDotDot(input.pattern) || !inside(root, realish(fixed || '/'))) return deny('Only files inside this worktree.');
  }
  const p = input.file_path ?? input.notebook_path ?? input.path;
  if (p === undefined || p === '') return mode === 'read' && name !== 'Read' ? { ok: true } : deny('A file path is needed.');
  if (hasDotDot(p) || /^~/.test(String(p))) return deny('No ".." or ~ in paths: name the file by its path inside this worktree.');
  const full = realish(path.resolve(root, String(p)));
  const roots = mode === 'read' ? [root, ...(opts.readRoots || []).map(realish)] : [root];
  if (!roots.some((r) => inside(r, full))) return deny(`Only files inside this worktree (${root}).`);
  if (mode === 'write' && (inside(path.join(root, '.git'), full) || /(^|[\\/])node_modules([\\/]|$)/.test(path.relative(root, full)))) return deny('Not inside .git or node_modules.');
  return { ok: true };
}

// ---- consent ---------------------------------------------------------------------------
// What changes Jarvis's code or its standing instructions is decided by what the user said, never by the model alone:
// text it reads (a web page, a file, a tool result, the coding agent's own summary) cannot stand in for a yes.

const NEGATION = /\b(no|nope|nah|not|don'?t|do not|never|stop|wait|hold|cancel|discard|later|isn'?t|won'?t|shouldn'?t|wouldn'?t)\b/i;
const YES = /\b(yes|yeah|yep|yup|yea|sure|ok|okay|alright|all right|go ahead|go for it|do it|please do|proceed|absolutely|definitely|certainly|of course|sounds good|affirmative|ship it|make it so|apply it|let'?s do it)\b/i;
const plainWords = (t) => String(t || '').toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, ' ').trim().split(/\s+/).filter(Boolean);

/** A short yes from the user ("yes", "go ahead", "sure, do it"), and no "no" or "wait" in it. `verb` also counts as a yes ("apply the change"). */
export function isYes(text, verb = null, maxWords = 8) {
  const w = plainWords(text);
  const t = w.join(' ');
  if (!w.length || w.length > (verb ? Math.max(maxWords, 14) : maxWords) || NEGATION.test(t) || /^(how|what|why|when|where|who|which)\b/.test(t)) return false;
  return (w.length <= maxWords && YES.test(t)) || Boolean(verb && verb.test(t));
}

const FILLER = new Set(['the', 'and', 'you', 'your', 'yours', 'user', 'users', 'them', 'their', 'they', 'from', 'now', 'with', 'for', 'that', 'this',
  'always', 'please', 'jarvis', 'should', 'would', 'could', 'will', 'want', 'like', 'dont', 'any', 'all', 'are', 'about', 'when', 'what', 'into', 'its']);
const content = (t) => plainWords(t).map((x) => x.replace(/'/g, '')).filter((x) => x.length > 2 && !FILLER.has(x)).map((x) => x.slice(0, 5));

/** Is `candidate` (an instruction, a change request) in the user's own words — at least half its words are in what they said? */
export function inTheirWords(candidate, said) {
  const want = [...new Set(content(candidate))];
  if (!want.length) return false;
  const have = new Set(content(said));
  return want.filter((x) => have.has(x)).length * 2 >= want.length;
}

/** What the agent is doing, in a few words for the status line. */
export function progressLine(name, input = {}) {
  const file = path.basename(String(input.file_path || input.path || ''));
  if (name === 'Read') return file ? `reading ${file}` : 'reading the code';
  if (name === 'Glob' || name === 'Grep') return 'looking through the code';
  if (name === 'Edit' || name === 'MultiEdit' || name === 'Write') return file ? `editing ${file}` : 'editing';
  return 'working';
}

const CODER_SYSTEM = `You are changing Jarvis, a voice-first Electron desktop assistant, because its user asked for it out loud. You work in a git worktree of Jarvis's own source, on a branch made for this change. The copy of Jarvis that is running lives elsewhere and stays untouched until the user has seen your diff and said yes.

The codebase
- package.json, build.mjs: "node build.mjs" bundles the renderer into dist/. "npm test" runs node --test test/*.test.js.
- src/main/ is the Electron main process (ESM): main.js window and IPC, agent.js prompt and turns, tools.js Jarvis's tools, memory.js the mind map, store.js settings and their defaults, llm/ the brains, speech-process.js speech.
- src/renderer/ is the window: index.html and styles.css the HUD, app.js the wiring, orb.js the hologram (three.js), graph.js the 3D maps, panel.js the controls, viewer.js the file viewer, voice.js the voice loop.
- README.md describes the features from the user's side; keep it true if you change one.

Rules
- Do what was asked with the smallest change that does it well. Match the code style around it, and the short, plain wording of user-facing text. No unrelated refactors or clean-ups.
- Your tools are Read, Glob and Grep to find your way and Edit and Write to change files, all inside this folder (node_modules can be read, not changed; never .git). There is no shell: you cannot run the build, the tests, git or anything else. Nothing you write runs until the user agrees; then Jarvis builds it, runs the tests and commits it. So read the code you touch and its callers carefully, and get it right on paper.
- No new dependencies: you cannot install packages. If the request cannot be done without one, change nothing and say which package and why in your SUMMARY line.
- Update or add tests in test/ when you change behaviour they cover.
- End your final message with one line starting "SUMMARY:" — one or two plain spoken sentences for the user on what you changed (no file paths, no code, nothing about builds or tests; Jarvis reports those itself). If you could not do it, say why on that line.`;

const NEVER_TOOLS = ['Bash', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'TaskStop', 'ListAgents', 'SendMessage', 'Workflow', 'Skill', 'SlashCommand', 'ToolSearch', 'NotebookEdit',
  'CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup', 'RemoteTrigger', 'PushNotification', 'EnterWorktree', 'ExitWorktree', 'BashOutput', 'KillShell', 'Monitor', 'LS'];
const CODER_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'TodoWrite'];
export const TIME_CAP = 15 * 60_000;
export const MAX_TURNS = 80;

/** The SDK options for the coding agent. Pure, so the lists can be tested. */
export function coderOptions({ bin, model, worktree, env, policy, abortController }) {
  const check = (name, input) => policy(name, input || {});
  return {
    model,
    effort: 'medium',
    systemPrompt: CODER_SYSTEM,
    tools: CODER_TOOLS,
    allowedTools: [], // every call goes through canUseTool (and the hook below, which sees even the ones Claude Code would allow by itself)
    disallowedTools: NEVER_TOOLS,
    canUseTool: async (name, input) => {
      const r = check(name, input);
      return r.ok ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: r.reason };
    },
    hooks: {
      PreToolUse: [{
        hooks: [async (hook) => {
          const r = check(hook.tool_name, hook.tool_input);
          return r.ok ? {} : { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: r.reason } };
        }],
      }],
    },
    permissionMode: 'default',
    mcpServers: {},
    strictMcpConfig: true, // none of the user's MCP servers
    settingSources: [], // no user or project settings: no CLAUDE.md, hooks, permissions or plugins of theirs
    settings: { crossSessionInbound: 'refuse' },
    skills: [],
    plugins: [],
    persistSession: false,
    title: 'Jarvis self-change',
    maxTurns: MAX_TURNS,
    cwd: worktree,
    env,
    abortController,
    ...(bin ? { pathToClaudeCodeExecutable: bin } : {}),
  };
}

/** The coding agent's environment: Claude Code's stripped one, git kept to this worktree and never prompting. */
export function coderEnv(base = process.env) {
  const env = claudeEnv(base);
  for (const k of Object.keys(env)) if (/^(GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|CONFIG.*|SSH.*|ASKPASS)|SSH_ASKPASS|JARVIS_.*|ELECTRON_.*)$/i.test(k) || /(TOKEN|SECRET|PASSWORD|API_KEY)/i.test(k)) delete env[k];
  return { ...env, GIT_TERMINAL_PROMPT: '0', CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: '1' };
}

/** The environment for node running code from a change: no keys or tokens, nothing pointing at Jarvis's data. */
export function nodeEnv(base = process.env) {
  const env = { ...base };
  for (const k of Object.keys(env)) if (/^(JARVIS_.*|ELECTRON_RUN_AS_NODE|NODE_TEST_CONTEXT|NODE_OPTIONS)$/i.test(k) || /(TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL)/i.test(k)) delete env[k];
  return env;
}

const gitEnv = () => {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  for (const k of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE)$/.test(k)) delete env[k];
  return env;
};
function exec(file, args, { cwd, env, timeout = 120_000 } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { cwd, env, timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(stdout || ''), err: String(stderr || ''), missing: err?.code === 'ENOENT' });
    });
  });
}
export const defaultGit = (args, cwd) => exec('git', args, { cwd, env: gitEnv() });
/** node on the PATH, or Electron's own Node when the app was started without one on the PATH. */
export async function defaultNode(args, cwd) {
  const env = nodeEnv(); // NODE_TEST_CONTEXT goes too: started from a test run, a nested node --test would report to it instead of failing
  const r = await exec('node', args, { cwd, env, timeout: 10 * 60_000 });
  if (!r.missing || !process.versions.electron) return r;
  return exec(process.execPath, args, { cwd, env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 10 * 60_000 });
}

const tail = (text, n = 1200) => (text.length > n ? `…${text.slice(-n)}` : text).trim();
const firstLine = (t) => String(t || '').split('\n').find((l) => l.trim()) || '';

/** The SUMMARY: line of the agent's last message, or its last sentences. */
export function summaryOf(text) {
  const t = String(text || '');
  const m = /SUMMARY:\s*([\s\S]+?)\s*$/i.exec(t);
  const s = (m ? m[1] : t.split(/\n\s*\n/).filter((p) => p.trim()).pop() || '').replace(/\s+/g, ' ').trim();
  return s.length > 320 ? `${s.slice(0, 317).replace(/\s+\S*$/, '')}…` : s;
}

export class SelfChange {
  /**
   * @param o {appPath, settings, claude (ClaudeCli), workRoot, diffDir, ui(event), say(text), restart(), log(line),
   *   git(args, cwd), node(args, cwd), sdk ({query}), isBusy() -> bool (a conversation turn in progress), now()}
   * git, node and sdk can be replaced in tests.
   */
  constructor(o) {
    const given = Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
    this.o = { git: defaultGit, node: defaultNode, ui: () => {}, say: () => {}, restart: () => {}, log: () => {}, isBusy: () => false, now: () => new Date(), ...given };
    this.repo = sourceCheckout(o.appPath);
    this.job = null;
  }

  get available() {
    return this.repo.ok;
  }

  // ---- what is going on ----------------------------------------------------------

  status() {
    const j = this.job;
    return {
      available: this.repo.ok,
      reason: this.repo.ok ? '' : this.repo.reason,
      job: j && { state: j.state, request: j.request, step: j.step, summary: j.summary, checked: Boolean(j.checked), testsOk: j.testsOk, buildOk: j.buildOk, diffFile: j.diffFile, branch: j.branch, error: j.error, files: j.files || [] },
      history: (this.o.settings.get().selfChanges || []).slice(-8),
    };
  }

  /**
   * One line for the per-turn prompt, so the conversation knows about a change in flight. Only Jarvis's own words and the
   * user's request: never the coding agent's summary, which is its text, not the user's or Jarvis's.
   */
  note() {
    const j = this.job;
    if (!j) return '';
    if (j.state === 'checking') return `Change to your own code ("${j.request}"): the coding is done; you are writing up the diff — ${j.step}.`;
    if (j.state === 'working') return `Change to your own code in progress (in the background): "${j.request}" — ${j.step}.`;
    if (j.state === 'ready') {
      const files = j.files || [];
      const checked = j.checked ? (j.testsOk ? 'It builds and the tests pass.' : `It was built and tested after their yes and ${j.buildOk ? 'the tests FAIL' : 'the build FAILS'}, so it was not applied.`) : 'It has not been built or tested yet: that runs its code, so it happens after their yes, before anything is applied.';
      return `Change to your own code ("${j.request}") waiting for their yes or no: ${files.length} file${files.length === 1 ? '' : 's'} changed (${files.slice(0, 4).join(', ')}${files.length > 4 ? '…' : ''}), the diff on screen. ${checked} apply_change only once they say yes (it will refuse otherwise); discard_change on a no.`;
    }
    if (j.state === 'applying') return `Applying the change to your own code now (${j.step || 'applying'}); you will restart in a moment if it goes through.`;
    return '';
  }

  /**
   * Something the user said (typed or spoken), at the start of each turn. A yes to the waiting change, or to an undo Jarvis
   * asked about, is only ever taken from here or from the window's buttons; tool calls check it (see apply, undo).
   */
  heard(text) {
    this.turn = (this.turn || 0) + 1;
    const said = String(text || '');
    const j = this.job;
    this.consent = null;
    if (j?.state === 'ready' && (j.readyTurn ?? Infinity) < this.turn && isYes(said, /\bapply\b/)) this.consent = 'apply';
    else if (this.undoAsked === this.turn - 1 && isYes(said, /\b(undo|revert)\b/)) this.consent = 'undo';
    else if (/\b(undo|revert|roll back)\b/i.test(said) && isYes(said, /\b(undo|revert|roll back)\b/)) this.consent = 'undo'; // "undo that last change"
  }

  update(patch) {
    if (this.job) Object.assign(this.job, patch);
    this.o.ui({ type: 'self_change', status: this.status() });
    if (patch.step && ['working', 'checking'].includes(this.job?.state)) this.o.ui({ type: 'status', text: `Changing myself — ${patch.step}`, ttl: 0 });
  }

  async git(args, cwd = this.repo.dir) {
    const r = await this.o.git(args, cwd);
    this.o.log(`git ${args.join(' ')} -> ${r.code}${r.ok ? '' : ` ${firstLine(r.err)}`}`);
    return r;
  }

  /** Tracked files with changes in the running checkout ([] when clean). */
  async localEdits() {
    const r = await this.git(['status', '--porcelain', '--untracked-files=no']);
    if (!r.ok) return ['(git status failed)'];
    return r.out.split('\n').filter((l) => l.trim()).map((l) => l.slice(3));
  }

  /** Whether the Claude login can run the coding agent; '' when it can, otherwise what to tell the user. */
  async loginProblem() {
    const claude = this.o.claude;
    if (!claude) return 'Claude Code is not available here, so I can\'t change my own code.';
    const s = await claude.check();
    if (s.state === 'ready') return '';
    const kind = { missing: 'not_installed', old: 'old', signed_out: 'not_logged_in', provider: 'provider', managed: 'managed' }[s.state] || 'error';
    return `I change my own code through Claude Code on your Claude login, and it isn't ready: ${describeCliError(new CliError(kind, s.state === 'old' ? s.version : s.provider || ''))}`;
  }

  // ---- making a change ---------------------------------------------------------------

  /** Start a change in the background. Resolves at once with what to tell the user. */
  async start(request) {
    request = String(request || '').trim();
    if (!request) return 'change_myself needs the request, in the user\'s words.';
    if (!this.repo.ok) return `I can only change my settings and standing instructions in this build: I'm ${this.repo.reason}, so there is no code of mine to edit.`;
    if (this.job?.state === 'working') return `Already working on "${this.job.request}" (${this.job.step}). Wait for it, or discard_change to stop it.`;
    if (this.job?.state === 'ready') return `A change is still waiting for a yes or no: ${this.job.summary} Apply or discard it first.`;
    if (this.job?.state === 'applying') return 'A change is being applied right now.';
    const problem = await this.loginProblem();
    if (problem) return problem;
    let sdk;
    try {
      sdk = this.o.sdk || (await this.o.claude.load());
    } catch (err) {
      return describeCliError(err);
    }

    const head = await this.git(['rev-parse', 'HEAD']);
    if (!head.ok) return 'I could not read my own git history, so I won\'t start.';
    const base = head.out.trim();
    let branch = branchName(request, this.o.now());
    for (let n = 2; (await this.git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).ok; n++) branch = `${branchName(request, this.o.now())}-${n}`;
    const worktree = path.join(this.o.workRoot, branch.replace(/^jarvis\//, '').replace(/[^\w.-]+/g, '-'));
    fs.mkdirSync(path.dirname(worktree), { recursive: true });
    const add = await this.git(['worktree', 'add', '-b', branch, worktree, base]);
    if (!add.ok) return `I could not make a separate copy to work in: ${firstLine(add.err)}`;
    // The packages, shared with the running copy: read, never written (the policy keeps writes out of node_modules).
    const modules = path.join(this.repo.dir, 'node_modules');
    if (fs.existsSync(modules)) {
      try { fs.symlinkSync(modules, path.join(worktree, 'node_modules'), 'junction'); } catch (err) { this.o.log(`node_modules link failed: ${err.message}`); }
    }
    const ac = new AbortController();
    this.job = { request, branch, worktree, base, state: 'working', step: 'reading the code', started: Date.now(), ac };
    this.update({ step: 'reading the code' });
    this.running = this.run(this.job, sdk).catch((err) => this.o.log(`self-change failed: ${err?.stack || err}`));
    return `Started on a separate copy of my code (branch ${branch}). It runs in the background, usually a few minutes; I'll say when it is ready and show the diff. Tell the user that in a few words and carry on with the conversation.`;
  }

  async run(job, sdk) {
    const s = this.o.settings.get();
    const model = /^claude-/.test(s.cloudModel) ? s.cloudModel : 'claude-opus-5-5';
    const readRoots = [path.join(this.repo.dir, 'node_modules')];
    const policy = (name, input) => {
      const r = toolAllowed(name, input, { worktree: job.worktree, readRoots });
      if (!r.ok) this.o.log(`denied ${name} ${JSON.stringify(input).slice(0, 200)}: ${r.reason}`);
      return r;
    };
    const timer = setTimeout(() => { job.timedOut = true; job.ac.abort(); }, TIME_CAP);
    let bin = '';
    try { bin = await this.o.claude?.binary?.(); } catch { /* the SDK's own copy */ }
    let result = null;
    let lastText = '';
    try {
      const q = sdk.query({
        prompt: `The user asked for this change, in their own words (spoken, so it went through speech recognition):\n\n"${job.request}"`,
        options: coderOptions({ bin, model, worktree: job.worktree, env: coderEnv(), policy, abortController: job.ac }),
      });
      for await (const m of q) {
        if (m.type === 'system' && m.subtype === 'init') {
          const extra = (m.tools || []).filter((t) => !CODER_TOOLS.includes(t));
          const servers = (m.mcp_servers || []).map((x) => x.name);
          this.o.log(`coder init ${JSON.stringify({ model: m.model, tools: m.tools, servers, cwd: m.cwd })}`);
          if (servers.length) { job.ac.abort(); throw new Error(`Claude Code loaded MCP servers I did not ask for (${servers.join(', ')}), so I stopped.`); }
          if (extra.length) this.o.log(`coder has extra tools (refused by the policy): ${extra.join(', ')}`);
        } else if (m.type === 'assistant' && !m.parent_tool_use_id) {
          for (const b of m.message?.content || []) {
            if (b.type === 'tool_use') this.update({ step: progressLine(b.name, b.input) });
            else if (b.type === 'text' && b.text.trim()) lastText = b.text;
          }
          if (m.error) job.error = firstLine((m.message?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(' ')) || m.error;
        } else if (m.type === 'result') {
          result = m;
        }
      }
    } catch (err) {
      if (!job.ac.signal.aborted) job.error = job.error || err?.message || String(err);
    } finally {
      clearTimeout(timer);
    }
    if (this.job !== job) return; // discarded meanwhile
    if (job.ac.signal.aborted && !job.timedOut) return; // stopped by the user; discard() tidies up
    this.update({ state: 'checking', step: 'checking the result' });
    await this.finish(job, result, lastText);
  }

  /**
   * The agent is done: commit what it left, write the diff, and report. Nothing it wrote is run here — not the build, not
   * the tests, not a git hook: that waits for the user's yes (see apply).
   */
  async finish(job, result, lastText) {
    const wt = job.worktree;
    job.summary = summaryOf(result?.result || lastText);
    const left = await this.git(['status', '--porcelain'], wt);
    if (left.ok && left.out.split('\n').some((l) => l.trim() && !/node_modules$/.test(l.trim()))) {
      await this.git(['add', '-A', '--', '.', ':(exclude)node_modules', ':(exclude)dist'], wt);
      await this.git(['-c', `core.hooksPath=${os.devNull}`, 'commit', '--no-verify', '-q', '-m', `Jarvis: ${job.request.slice(0, 60)}`], wt); // hooks could be files the agent wrote
    }
    const names = await this.git(['diff', '--name-only', job.base, job.branch]);
    job.files = names.ok ? names.out.split('\n').filter(Boolean) : [];
    if (!job.files.length) {
      const why = job.timedOut ? 'It ran out of time before changing anything.' : job.error ? `It stopped: ${job.error}` : job.summary || 'No change came of it.';
      this.update({ state: 'failed', step: '' });
      await this.cleanup(job, { keepBranch: false });
      this.job = null;
      this.update({});
      this.o.ui({ type: 'status', text: '', ttl: 1 });
      return this.o.say(`I couldn't make that change to my code. ${why}`);
    }
    if (this.job !== job) return;
    job.checked = false;
    job.buildOk = null;
    job.testsOk = null;
    const diffFile = await this.writeDiff(job);
    job.readyTurn = this.turn || 0; // a yes counts only from the next thing the user says
    this.update({ state: 'ready', step: '', diffFile });
    this.o.ui({ type: 'status', text: '', ttl: 1 });
    this.o.ui({ type: 'show_file', path: diffFile });
    const what = job.summary || `I changed ${job.files.length} file${job.files.length === 1 ? '' : 's'}.`;
    this.o.say(`The change is ready. ${what} The diff is on screen. I haven't run it yet: if you say yes, I build it and run the tests first, and apply it only if they pass. Shall I?`);
  }

  /** The diff file the viewer shows, with what is known about the build and the tests at its top. */
  async writeDiff(job, { build, test } = {}) {
    const diff = await this.git(['diff', job.base, job.branch]);
    const stat = await this.git(['diff', '--stat', job.base, job.branch]);
    fs.mkdirSync(this.o.diffDir, { recursive: true });
    const diffFile = path.join(this.o.diffDir, `${job.branch.replace(/^jarvis\//, '').replace(/[^\w.-]+/g, '-')}.diff`);
    const checks = !build
      ? '# not built or tested yet: that runs the new code, so it happens only after you say yes\n'
      : `# build: ${build.ok ? 'ok' : 'FAILED'} · tests: ${test.ok ? 'pass' : 'FAIL'}\n${build.ok ? '' : `# ${tail(build.err || build.out, 600).replace(/\n/g, '\n# ')}\n`}${test.ok ? '' : `# ${tail(test.out + test.err, 900).replace(/\n/g, '\n# ')}\n`}`;
    const header = `# ${job.request}\n# branch ${job.branch}\n# ${job.summary}\n${checks}#\n${stat.out.replace(/^/gm, '# ')}\n`;
    fs.writeFileSync(diffFile, `${header}\n${diff.out}`);
    return diffFile;
  }

  /** Build the change and run its tests, in its worktree, without keys or tokens in the environment. Only after the user's yes. */
  async check(job) {
    const wt = job.worktree;
    const build = await this.o.node(['build.mjs'], wt);
    const testDir = path.join(wt, 'test');
    const tests = fs.existsSync(testDir) ? fs.readdirSync(testDir).filter((f) => f.endsWith('.test.js')).map((f) => path.join('test', f)) : [];
    const test = build.ok && tests.length ? await this.o.node(['--test', ...tests], wt) : { ok: build.ok, out: '', err: '' };
    return { build, test };
  }

  async cleanup(job, { keepBranch = true } = {}) {
    try { fs.rmSync(path.join(job.worktree, 'node_modules'), { force: true }); } catch { /* not there */ }
    await this.git(['worktree', 'remove', '--force', job.worktree]); // only this worktree: never a prune, which could drop the user's own
    if (fs.existsSync(job.worktree)) fs.rmSync(job.worktree, { recursive: true, force: true });
    if (!keepBranch) await this.git(['branch', '-d', job.branch]); // -d: only one that holds nothing
  }

  /** Stop a change in progress, or throw away one that is waiting. The branch is kept unless it is empty. */
  async discard() {
    const job = this.job;
    if (!job) return 'There is no change in progress or waiting.';
    if (job.state === 'applying') return 'It is being applied already.';
    const wasWorking = job.state === 'working' || job.state === 'checking';
    job.ac.abort();
    this.job = null;
    await this.running?.catch(() => {});
    const ahead = await this.git(['rev-list', '--count', `${job.base}..${job.branch}`]);
    await this.cleanup(job, { keepBranch: ahead.ok && Number(ahead.out.trim()) > 0 });
    this.update({});
    this.o.ui({ type: 'status', text: wasWorking ? 'Change stopped' : 'Change discarded', ttl: 2500 });
    return wasWorking ? 'Stopped, and nothing was changed.' : 'Discarded; nothing was changed.';
  }

  /**
   * Build and test the waiting change, then merge it into the running checkout, rebuild, and restart. Only on the user's
   * yes: `button` when it comes from the window's Apply button, otherwise (a tool call) the yes must be in what the user said
   * this turn (see heard).
   */
  async apply({ anyway = false, button = false } = {}) {
    const job = this.job;
    if (!job) return 'There is no change waiting to be applied.';
    if (job.state === 'working' || job.state === 'checking') return `It is still working on it (${job.step}).`;
    if (job.state !== 'ready') return 'There is no change waiting to be applied.';
    if (!button && this.consent !== 'apply') return 'Not applied: I apply a change to my own code only right after the user says yes to it, or presses Apply on its card. Ask them in a few words whether to apply it, and call apply_change again once they say yes.';
    const sawFailure = job.checked && !job.testsOk; // "anyway" only means something once they have heard it fails
    if (sawFailure && !anyway) return `The ${job.buildOk ? 'tests fail' : 'build fails'} on that change, so I have not applied it. Only if the user insists, call apply_change again with anyway true.`;
    const edits = await this.localEdits();
    if (edits.length) return `There are edits in my code that are not committed (${edits.slice(0, 4).join(', ')}${edits.length > 4 ? '…' : ''}), so I left everything as it is. Commit or put those away first, then ask again.`;
    if (!job.checked) {
      this.update({ state: 'applying', step: 'building and testing it first' });
      this.o.ui({ type: 'status', text: 'Changing myself — building and testing it first', ttl: 0 });
      const { build, test } = await this.check(job);
      if (this.job !== job) return 'It was put aside meanwhile.';
      job.checked = true;
      job.buildOk = build.ok;
      job.testsOk = build.ok && test.ok;
      try { await this.writeDiff(job, { build, test }); } catch (err) { this.o.log(`diff rewrite failed: ${err.message}`); }
      this.o.ui({ type: 'status', text: '', ttl: 1 });
      if (!job.testsOk) {
        job.readyTurn = this.turn || 0; // applying it anyway takes a fresh yes
        this.consent = null;
        this.update({ state: 'ready', step: '' });
        return `I built and tested it first, and ${build.ok ? 'the tests fail' : 'it does not build'} (${firstLine(build.ok ? tail(test.out + test.err, 300) : build.err || build.out) || 'see the diff'}), so I have not applied it; the output is at the top of the diff. Only if the user then insists, call apply_change again with anyway true.`;
      }
    }
    this.update({ state: 'applying', step: 'applying' });
    const before = (await this.git(['rev-parse', 'HEAD'])).out.trim();
    let mode = 'ff';
    let merged = await this.git(['merge', '--ff-only', '-q', job.branch]);
    if (!merged.ok) {
      mode = 'merge';
      merged = await this.git(['merge', '--no-ff', '--no-edit', '-q', '-m', `Jarvis: apply ${job.branch}`, job.branch]);
      if (!merged.ok) {
        await this.git(['merge', '--abort']);
        this.update({ state: 'ready', step: '' });
        return `It no longer fits my current code (${firstLine(merged.err || merged.out) || 'a merge conflict'}), so I left everything as it was. Discard it and ask again.`;
      }
    }
    const after = (await this.git(['rev-parse', 'HEAD'])).out.trim();
    if (after === before) { // already in my history (applied before, or reverted since): nothing was applied
      await this.putAside(job);
      return 'That change is already part of my code\'s history, so there was nothing to apply and nothing changed. I put it aside.';
    }
    const build = await this.o.node(['build.mjs'], this.repo.dir);
    if (!build.ok) {
      await this.revert({ before, after, mode }, `Jarvis: undo ${job.branch} (build failed)`);
      await this.o.node(['build.mjs'], this.repo.dir);
      await this.putAside(job); // not offered again: a second merge of the same branch would change nothing
      return `It merged, but my build failed (${firstLine(build.err || build.out)}), so I reverted it and put the change aside (its branch is kept). Nothing changed.`;
    }
    const entry = { branch: job.branch, request: job.request, summary: job.summary, date: this.o.now().toISOString(), before, after, mode, testsOk: job.testsOk };
    const history = [...(this.o.settings.get().selfChanges || []), entry].slice(-20);
    this.o.settings.set({ selfChanges: history, selfChangeNotice: `I've applied the change: ${job.summary || job.request}` });
    await this.cleanup(job);
    this.job = null;
    this.update({});
    this.restartSoon();
    return 'Applied. I restart in a few seconds to load it; say so in a few words.';
  }

  /** Drop the waiting job without applying it, keeping its branch. */
  async putAside(job) {
    await this.cleanup(job);
    if (this.job === job) this.job = null;
    this.update({});
  }

  /** Revert `before..after` with new commits; never a reset. */
  async revert({ before, after, mode }, message) {
    const r = mode === 'merge'
      ? await this.git(['revert', '--no-edit', '-m', '1', after])
      : await this.git(['revert', '--no-commit', `${before}..${after}`]);
    if (!r.ok) {
      await this.git(['revert', '--abort']);
      return r;
    }
    if (mode !== 'merge') return this.git(['commit', '-q', '-m', message]);
    return r;
  }

  /** Revert the last applied change with a revert commit, rebuild and restart. Only on the user's say (see apply). */
  async undo({ button = false } = {}) {
    if (!this.repo.ok) return 'There is no code change of mine to undo in this build.';
    if (this.job && this.job.state !== 'ready') return 'A change is in progress; stop it first.';
    const history = this.o.settings.get().selfChanges || [];
    const i = history.findLastIndex((e) => !e.undone && e.before !== e.after); // an entry that changed nothing has nothing to revert
    if (i < 0) return 'There is no applied change to undo.';
    const entry = history[i];
    if (!button && this.consent !== 'undo') {
      this.undoAsked = this.turn || 0;
      return `Not undone yet: I undo a change to my own code only when the user asks for it or says yes to it. Ask them whether to undo "${entry.request}", and call undo_last_change again once they say yes.`;
    }
    this.consent = null;
    const edits = await this.localEdits();
    if (edits.length) return `There are uncommitted edits in my code (${edits.slice(0, 4).join(', ')}), so I left everything as it is.`;
    const r = await this.revert(entry, `Jarvis: undo ${entry.branch}`);
    if (!r.ok) return `I could not undo it cleanly (${firstLine(r.err || r.out)}), so I left everything as it was.`;
    const build = await this.o.node(['build.mjs'], this.repo.dir);
    const next = history.map((e, j) => (j === i ? { ...e, undone: this.o.now().toISOString() } : e));
    this.o.settings.set({ selfChanges: next, selfChangeNotice: `I've undone the change: ${entry.summary || entry.request}` });
    this.update({});
    if (!build.ok) return `Reverted, but the build failed afterwards (${firstLine(build.err || build.out)}). I have not restarted.`;
    this.restartSoon();
    return `Undone: ${(entry.summary || entry.request).replace(/[.!?]+$/, '')}. I restart in a few seconds; say so in a few words.`;
  }

  /** Restart once the current turn has been answered (or at most twenty seconds from now). */
  restartSoon() {
    const until = Date.now() + 20_000;
    let quiet = 0;
    const tick = () => {
      quiet = this.o.isBusy() ? 0 : quiet + 1;
      if (quiet >= (this.o.quietTicks ?? 10) || Date.now() > until) return this.o.restart(); // 2.5 s with no turn running: the confirmation has been said
      setTimeout(tick, 250);
    };
    setTimeout(tick, 250);
  }
}

// ---- the tools ---------------------------------------------------------------------------

/**
 * @param ctx {settings, setSettings(patch) -> Promise, env() -> {claudeReady, hasApiKey}, selfChange (SelfChange), rescanFiles?(),
 *   heard() -> what the user said this turn (consent for instructions and code changes is checked against it)}
 */
export function selfTools(ctx) {
  const who = () => ctx.settings.get().userName || 'the user';
  return [
    {
      name: 'change_setting',
      description: `Change one of your own settings when the user asks, the same as the controls panel would. Settings: ${Object.entries(VOICE_SETTINGS).map(([k, v]) => `${k} (${v.help})`).join('; ')}. Not the API key, connections or anything else. Confirm in one short sentence what changed.`,
      schema: obj({ setting: { type: 'string', enum: Object.keys(VOICE_SETTINGS) }, value: str('The new value, e.g. "on", "off", "female", "1.15", "Micah", "~/Documents"') }, ['setting', 'value']),
      run: async ({ setting, value }) => {
        const s = ctx.settings.get();
        const r = changeSetting(setting, value, s, {
          ...(ctx.env?.() || {}),
          home: os.homedir(),
          isDir: (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } },
        });
        if (r.error) return `Not changed: ${r.error}`;
        await ctx.setSettings(r.patch);
        if (r.rescan) ctx.rescanFiles?.();
        return `Done: ${r.said}. Confirm in one short sentence.`;
      },
    },
    {
      name: 'update_instructions',
      description: `The user's standing instructions to you: how to talk and behave in every conversation from now on ("keep answers under two sentences", "call me Micah", "don't bring up volleyball unless I ask", "use metric units"). They sit at the top of your instructions and override your defaults. add saves one (rephrase it as a short instruction in the second person if need be, keeping their meaning); remove deletes one (which: its number or words from it); replace swaps one (which) for new text; list reads them. At most ${INSTRUCTIONS_MAX}, ${INSTRUCTION_CHARS} characters each. Repeat back what you saved in a few words.`,
      schema: obj({
        action: { type: 'string', enum: ['add', 'remove', 'replace', 'list'] },
        text: str('The instruction to add, or the new text for replace'),
        which: str('For remove and replace: the number of the instruction, or words from it'),
      }, ['action']),
      run: async ({ action, text, which }) => {
        // Saved for good and put above the defaults: only what the user said themselves, not what a page or a file says.
        if ((action === 'add' || action === 'replace') && !inTheirWords(text, ctx.heard?.() || '')) return 'Not saved: a standing instruction has to come from what the user just said to you, in their words. Use their own words (lightly tidied), or ask them what exactly to save.';
        const before = ctx.settings.get().instructions || [];
        const r = editInstructions(before, { action, text, which });
        if (r.error) return `Not changed: ${r.error}`;
        if (JSON.stringify(r.list) !== JSON.stringify(before)) await ctx.setSettings({ instructions: r.list });
        return action === 'list' ? r.said : `${r.said} It applies from your next reply on${who() !== 'the user' ? `, ${who()}` : ''}.`;
      },
    },
    {
      name: 'change_myself',
      description: 'Change your own code, for what a setting or a standing instruction cannot do: how you look, a new feature, how something works ("make the orb blue", "add a timer", "make the captions bigger"). Ask first and call this only after they said yes. A coding agent on their Claude login edits a separate copy of your source on a new branch, in the background, and cannot run anything; you are told when the diff is ready. Nothing is built, run or changed until they approve it with apply_change.',
      schema: obj({ request: str('What they asked for, in their own words') }, ['request']),
      run: async ({ request }) => {
        const said = ctx.heard?.() || '';
        if (!isYes(said) && !inTheirWords(request, said)) return 'Not started: I change my own code only when the user asks for it themselves. Ask them whether they want this change, and call change_myself on their yes, with their request in their words.';
        return ctx.selfChange.start(request);
      },
    },
    {
      name: 'apply_change',
      description: 'Apply the change to your own code that is waiting — only right after the user said yes to it (it refuses otherwise). Builds and tests it first if that has not been done, then merges it, rebuilds and restarts you.',
      schema: obj({ anyway: { type: 'boolean', description: 'True only if the tests failed and the user insists on applying it regardless' } }),
      run: async ({ anyway }) => ctx.selfChange.apply({ anyway: anyway === true }),
    },
    {
      name: 'discard_change',
      description: 'Stop a change to your own code that is in progress, or throw away one that is waiting (when they say no, or stop).',
      schema: obj({}),
      run: async () => ctx.selfChange.discard(),
    },
    {
      name: 'undo_last_change',
      description: 'Undo the last change to your own code that was applied, with a revert commit; rebuilds and restarts you. Only when the user asks for it or says yes to it (it refuses otherwise).',
      schema: obj({}),
      run: async () => ctx.selfChange.undo(),
    },
  ];
}

/** Stands in for SelfChange where there is none (tests, or a build without its source). */
export const noSelfChange = {
  available: false,
  note: () => '',
  heard: () => {},
  start: async () => 'I can only change my settings and standing instructions in this build; there is no code of mine to edit.',
  apply: async () => 'There is no change waiting to be applied.',
  discard: async () => 'There is no change in progress or waiting.',
  undo: async () => 'There is no code change of mine to undo in this build.',
};
