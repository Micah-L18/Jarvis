// Skills are folders containing a SKILL.md: YAML-ish frontmatter (name, description) plus
// instructions. Only name + description go in the prompt; the body is loaded on demand.
import fs from 'node:fs';
import path from 'node:path';
import { slugify } from './store.js';

const BUILTIN = [
  {
    name: 'practice-planner',
    description: 'Build practice plans for a sports team the user coaches: timed blocks, drills, coaching points.',
    body: `# Practice planner

Use when asked for a practice plan, training session, or drill progression.

1. From memory and the conversation, work out the team (sport, age/level, roster size), the session length, the space and equipment available, and what the coach wants to improve. Ask only for what is missing and matters — one short spoken question at a time.
2. Write the plan as a document with save_document, in that team's project (create the project if it does not exist):
   - Header: date, duration, focus, equipment.
   - A table of timed blocks: time, activity, setup, coaching points. Warm-up first, a competitive game-like block near the end, cool-down/debrief last.
   - For each drill: how to run it, what to watch for, one way to make it easier and one to make it harder.
3. Out loud, give only the shape of the session in two or three sentences and say where the plan is saved. Offer one concrete adjustment if something looks off (e.g. too little serving for a serve-receive focus).
4. Remember what the team worked on so the next plan builds on it.`,
  },
  {
    name: 'research-collector',
    description: 'Run a research and data-collection project: gather sources, extract facts into a dataset, keep notes.',
    body: `# Research collector

Use for open-ended research, comparisons, or building a dataset by talking.

1. Pin down the question and what "done" looks like in a sentence. Create or switch to a project for it.
2. Search and read sources (only if internet access is on; otherwise say so and work from what the user tells you and local files).
3. Keep two documents in the project and update them with save_document as you go:
   - "Findings": dated notes, each claim with its source URL, and open questions.
   - "Dataset": a markdown table (or CSV in a code block) with one row per item collected and consistent columns.
4. Report progress conversationally: what you found, what surprised you, what you would look at next. Never read tables aloud.
5. Flag weak or conflicting sources rather than averaging them.`,
  },
  {
    name: 'daily-briefing',
    description: 'Give a short spoken briefing of open tasks and active projects from memory.',
    body: `# Daily briefing

Use when the user asks what's on, where things stand, or for a briefing.

Look at the active project and tasks in memory. In under five sentences: what is in flight, what is waiting on the user, and one suggestion for what to do next. No lists, no preamble.`,
  },
];

function parse(text, fallbackName) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  const meta = {};
  if (m) for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
  }
  return { name: meta.name || fallbackName, description: meta.description || '', body: (m ? m[2] : text).trim() };
}

export class Skills {
  constructor(dataDir) {
    this.dir = path.join(dataDir, 'skills');
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true });
      for (const s of BUILTIN) this.save(s);
    }
  }

  list() {
    const out = [];
    for (const entry of fs.readdirSync(this.dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(this.dir, entry.name, 'SKILL.md');
      if (!fs.existsSync(file)) continue;
      out.push({ id: entry.name, ...parse(fs.readFileSync(file, 'utf8'), entry.name) });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name) {
    const want = slugify(name);
    return this.list().find((s) => s.id === want || slugify(s.name) === want) || null;
  }

  save({ id, name, description, body }) {
    const folder = path.join(this.dir, id || slugify(name));
    fs.mkdirSync(folder, { recursive: true });
    const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    fs.writeFileSync(path.join(folder, 'SKILL.md'), `---\nname: ${oneLine(name)}\ndescription: ${oneLine(description)}\n---\n\n${String(body || '').trim()}\n`);
    return this.get(id || name);
  }

  /** Import an existing skill folder (anything with a SKILL.md in it). */
  importFolder(src) {
    if (!fs.existsSync(path.join(src, 'SKILL.md'))) throw new Error('That folder has no SKILL.md');
    const dest = path.join(this.dir, slugify(path.basename(src)));
    fs.cpSync(src, dest, { recursive: true });
    return this.get(path.basename(dest));
  }

  remove(id) {
    const folder = path.join(this.dir, slugify(id));
    if (folder.startsWith(this.dir + path.sep)) fs.rmSync(folder, { recursive: true, force: true });
  }
}
