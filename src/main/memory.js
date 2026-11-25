// The mind map: a small knowledge graph of what Jarvis knows, grouped into projects.
// It is the single source of truth for long-term memory — what's in the graph is what
// gets put in front of the model, so deleting a node really does make Jarvis forget it.
import path from 'node:path';
import fs from 'node:fs';
import { readJson, writeJson, slugify } from './store.js';

export const NODE_TYPES = ['project', 'topic', 'person', 'fact', 'preference', 'task', 'document'];
const CORE = 'core';
const GENERAL = 'project:general';

export class Memory {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'memory.json');
    this.historyFile = path.join(dataDir, 'history.json');
    this.projectsDir = path.join(dataDir, 'projects');
    const saved = readJson(this.file, null);
    this.nodes = new Map((saved?.nodes || []).map((n) => [n.id, n]));
    this.edges = saved?.edges || [];
    this.activeProject = saved?.activeProject || GENERAL;
    this.history = readJson(this.historyFile, []);
    this.listeners = new Set();
    if (!this.nodes.has(CORE)) this.nodes.set(CORE, { id: CORE, label: 'JARVIS', type: 'core', summary: '', created: Date.now() });
    if (!this.nodes.has(GENERAL)) this._addProject('General', 'Everything that does not belong to a specific project.', GENERAL);
    if (!this.nodes.has(this.activeProject)) this.activeProject = GENERAL;
  }

  onChange(fn) {
    this.listeners.add(fn);
  }

  _save() {
    writeJson(this.file, { nodes: [...this.nodes.values()], edges: this.edges, activeProject: this.activeProject });
    for (const fn of this.listeners) fn(this.snapshot());
  }

  snapshot() {
    return { nodes: [...this.nodes.values()], edges: this.edges, activeProject: this.activeProject };
  }

  // ---- lookup -------------------------------------------------------------

  find(labelOrId) {
    if (!labelOrId) return null;
    if (this.nodes.has(labelOrId)) return this.nodes.get(labelOrId);
    const want = slugify(labelOrId);
    for (const n of this.nodes.values()) if (slugify(n.label) === want) return n;
    for (const n of this.nodes.values()) if (slugify(n.label).includes(want) && want.length > 3) return n;
    return null;
  }

  projects() {
    return [...this.nodes.values()].filter((n) => n.type === 'project');
  }

  findProject(name) {
    if (!name) return null;
    const want = slugify(name);
    return this.projects().find((p) => p.id === name || slugify(p.label) === want) || null;
  }

  search(query, limit = 12) {
    const terms = String(query || '').toLowerCase().split(/\s+/).filter((t) => t.length > 1);
    const scored = [];
    for (const n of this.nodes.values()) {
      if (n.type === 'core') continue;
      const hay = `${n.label} ${n.summary || ''}`.toLowerCase();
      let score = 0;
      for (const t of terms) if (hay.includes(t)) score += n.label.toLowerCase().includes(t) ? 3 : 1;
      if (score) scored.push([score, n]);
    }
    return scored.sort((a, b) => b[0] - a[0]).slice(0, limit).map(([, n]) => n);
  }

  neighbors(id) {
    const out = [];
    for (const e of this.edges) {
      if (e.source === id && this.nodes.has(e.target)) out.push({ node: this.nodes.get(e.target), relation: e.label, dir: 'out' });
      else if (e.target === id && this.nodes.has(e.source)) out.push({ node: this.nodes.get(e.source), relation: e.label, dir: 'in' });
    }
    return out;
  }

  // ---- mutation -----------------------------------------------------------

  _addProject(name, description, id) {
    const node = { id: id || `project:${slugify(name)}`, label: name, type: 'project', summary: description || '', created: Date.now(), updated: Date.now() };
    this.nodes.set(node.id, node);
    this._link(CORE, node.id, 'project');
    return node;
  }

  _link(source, target, label = 'related to') {
    if (source === target || !this.nodes.has(source) || !this.nodes.has(target)) return;
    const exists = this.edges.some((e) => (e.source === source && e.target === target) || (e.source === target && e.target === source));
    if (!exists) this.edges.push({ source, target, label });
  }

  createProject(name, description = '') {
    let project = this.findProject(name);
    if (project) {
      if (description && !project.summary) project.summary = description;
    } else {
      project = this._addProject(name, description);
    }
    this.activeProject = project.id;
    this._save();
    return project;
  }

  setActiveProject(name) {
    const project = this.findProject(name);
    if (!project) return null;
    this.activeProject = project.id;
    this._save();
    return project;
  }

  /** Add or update a node. `project` is a project name/id; defaults to the active project. */
  upsert({ label, type = 'topic', summary = '', project, relatedTo = [] }, { save = true } = {}) {
    label = String(label || '').trim();
    if (!label) return null;
    if (type === 'project') return this.createProject(label, summary);
    if (!NODE_TYPES.includes(type)) type = 'topic';
    const proj = this.findProject(project) || this.nodes.get(this.activeProject) || this.nodes.get(GENERAL);
    let node = this.find(label);
    if (node && (node.type === 'core' || node.type === 'project')) node = null;
    if (node) {
      if (summary && summary !== node.summary) node.summary = summary;
      node.updated = Date.now();
      node.weight = (node.weight || 1) + 1;
    } else {
      node = { id: `${type}:${slugify(label)}:${Date.now().toString(36)}`, label, type, summary, project: proj.id, created: Date.now(), updated: Date.now(), weight: 1 };
      this.nodes.set(node.id, node);
      this._link(proj.id, node.id, 'contains');
    }
    for (const other of relatedTo) {
      const target = typeof other === 'string' ? this.find(other) : this.find(other.label);
      if (target && target.type !== 'core') this._link(node.id, target.id, other.relation || 'related to');
    }
    if (save) this._save();
    return node;
  }

  /** Merge a batch produced by the background extractor. */
  merge({ project, nodes = [], links = [] }) {
    let proj = null;
    if (project) proj = this.findProject(project) || this._addProject(project, '');
    if (proj && proj.id !== GENERAL) this.activeProject = proj.id;
    const added = [];
    for (const n of nodes) {
      const node = this.upsert({ ...n, project: proj?.id }, { save: false });
      if (node) added.push(node);
    }
    for (const l of links) {
      const a = this.find(l.from);
      const b = this.find(l.to);
      if (a && b && a.type !== 'core' && b.type !== 'core') this._link(a.id, b.id, l.relation || 'related to');
    }
    if (added.length || proj) this._save();
    return added;
  }

  /** Remove a node (and for a project, everything inside it). Also scrubs it from the saved conversation. */
  forget(labelOrId) {
    const node = this.find(labelOrId);
    if (!node || node.type === 'core' || node.id === GENERAL) return null;
    const doomed = new Set([node.id]);
    if (node.type === 'project') {
      for (const n of this.nodes.values()) if (n.project === node.id) doomed.add(n.id);
      if (this.activeProject === node.id) this.activeProject = GENERAL;
    }
    const labels = [...doomed].map((id) => this.nodes.get(id).label.toLowerCase()).filter((l) => l.length > 2);
    for (const id of doomed) this.nodes.delete(id);
    this.edges = this.edges.filter((e) => !doomed.has(e.source) && !doomed.has(e.target));
    const before = this.history.length;
    this.history = this.history.filter((h) => !labels.some((l) => h.text.toLowerCase().includes(l)));
    if (this.history.length !== before) writeJson(this.historyFile, this.history);
    this._save();
    return { node, removed: doomed.size };
  }

  // ---- conversation log ---------------------------------------------------

  logTurn(role, text) {
    if (!text) return;
    this.history.push({ role, text, ts: Date.now(), project: this.activeProject });
    if (this.history.length > 200) this.history = this.history.slice(-200);
    writeJson(this.historyFile, this.history);
  }

  recentTurns(count = 16) {
    return this.history.slice(-count).map(({ role, text }) => ({ role, text }));
  }

  clearHistory() {
    this.history = [];
    writeJson(this.historyFile, this.history);
  }

  // ---- documents ----------------------------------------------------------

  projectDir(project) {
    return path.join(this.projectsDir, slugify(project.label));
  }

  saveDocument(projectName, title, content) {
    const project = this.findProject(projectName) || this.nodes.get(this.activeProject);
    const dir = this.projectDir(project);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${slugify(title)}.md`);
    fs.writeFileSync(file, content);
    const first = content.replace(/^#.*$/m, '').trim().split('\n').find((l) => l.trim()) || '';
    const node = this.upsert({ label: title, type: 'document', summary: first.slice(0, 160), project: project.id }, { save: false });
    node.file = file;
    this._save();
    return { file, project, node };
  }

  listDocuments(projectName) {
    const project = this.findProject(projectName) || this.nodes.get(this.activeProject);
    return [...this.nodes.values()].filter((n) => n.type === 'document' && n.project === project.id && n.file && fs.existsSync(n.file));
  }

  readDocument(projectName, title) {
    const docs = projectName ? this.listDocuments(projectName) : [...this.nodes.values()].filter((n) => n.type === 'document' && n.file);
    const want = slugify(title);
    const doc = docs.find((d) => slugify(d.label) === want) || docs.find((d) => slugify(d.label).includes(want));
    if (!doc || !fs.existsSync(doc.file)) return null;
    return { doc, content: fs.readFileSync(doc.file, 'utf8') };
  }

  // ---- prompt digest ------------------------------------------------------

  /** A compact text rendering of the graph for the system prompt, active project first. */
  digest(maxChars = 6000) {
    const projects = this.projects().sort((a, b) => (a.id === this.activeProject ? -1 : b.id === this.activeProject ? 1 : (b.updated || 0) - (a.updated || 0)));
    const lines = [];
    for (const p of projects) {
      const items = [...this.nodes.values()].filter((n) => n.project === p.id).sort((a, b) => (b.updated || 0) - (a.updated || 0));
      if (!items.length && p.id === GENERAL) continue;
      lines.push(`Project "${p.label}"${p.id === this.activeProject ? ' (active)' : ''}${p.summary ? ` — ${p.summary}` : ''}`);
      for (const n of items) lines.push(`  - [${n.type}] ${n.label}${n.summary ? `: ${n.summary}` : ''}`);
    }
    let text = lines.join('\n');
    if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n  … (more in memory; use the recall tool)`;
    return text || '(nothing remembered yet)';
  }
}
