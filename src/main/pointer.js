// Where something is: a memory on the Mind map, or a file or folder on the Files map. point_to,
// show_view's focus and show_file use this to send the window's camera to it.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scan, isInside } from './fsscan.js';
import { kindOf } from './filekind.js';
import { slugify } from './store.js';

const FOUND = 50; // the weakest score that still counts as the thing meant
const HINT = 15; // the weakest that is still worth offering as a near miss
// Words that dress a name up in speech ("the notes file", "my U14 project") without being part of it.
const DRESS = new Set(['the', 'a', 'an', 'my', 'our', 'your', 'his', 'her', 'their', 'that', 'this', 'file', 'folder', 'directory', 'project', 'document', 'doc', 'one']);
// What kind of file something is, said in speech ("the budget spreadsheet", "the cottage picture"):
// dressing as well, and a hint of the kinds meant.
const KIND_WORDS = {
  spreadsheet: ['csv', 'office'], spreadsheets: ['csv', 'office'], sheet: ['csv', 'office'], workbook: ['office'], table: ['csv'],
  picture: ['image', 'svg'], photo: ['image'], photograph: ['image'], image: ['image', 'svg'], pic: ['image'], drawing: ['svg', 'image'],
  video: ['video'], movie: ['video'], recording: ['audio', 'video'], audio: ['audio'], sound: ['audio'], song: ['audio'], podcast: ['audio'],
  model: ['model'], pdf: ['pdf'], slides: ['office', 'pdf'], deck: ['office', 'pdf'], presentation: ['office', 'pdf'],
};
// Kind words that also say "a file", so the Files map has the say (not "model" or "deck": a memory is often called that).
const FILE_KIND = new Set(Object.keys(KIND_WORDS).filter((w) => w !== 'model' && w !== 'deck' && w !== 'table'));

const wordsOf = (s) => String(s || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const undressed = (ws, kinds = false) => {
  const core = ws.filter((w) => !DRESS.has(w) && !(kinds && KIND_WORDS[w]));
  return core.length ? core : ws;
};
const kindsAsked = (t) => new Set(wordsOf(t).flatMap((w) => KIND_WORDS[w] || []));
const stemOf = (name) => name.replace(/\.[^.]+$/, '');
// A path, a file name, or a name called a file or folder ("the serve ladder file", "the budget spreadsheet"): the Files map has the say.
const looksLikePath = (t) => /[\\/]/.test(t) || t.startsWith('~') || /\.[a-z0-9]{1,6}$/i.test(t) || /\b(file|folder|directory)\b/i.test(t) || wordsOf(t).some((w) => FILE_KIND.has(w));

/** Edit distance, for a misheard or misspelt name; gives up early past `max`. */
export function editDistance(a, b, max = 3) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** How well a name (a memory's label, a file's name) fits what was asked for, 0-100. */
function nameScore(name, target) {
  const plain = wordScore(name, target, false);
  return wordsOf(target).some((w) => KIND_WORDS[w]) ? Math.max(plain, wordScore(name, target, true)) : plain;
}
function wordScore(name, target, kinds) {
  const lname = name.toLowerCase();
  const lt = target.toLowerCase();
  if (lname === lt) return 95;
  if (slugify(name) && slugify(name) === slugify(target)) return 90;
  const nw = wordsOf(name);
  const tw = undressed(wordsOf(target), kinds);
  if (!nw.length || !tw.length) return 0;
  if (nw.join(' ') === tw.join(' ')) return 88;
  if (nw.every((w) => tw.includes(w))) return 75 + Math.min(10, nw.length * 3); // "the U14 volleyball project" names "U14 Volleyball"
  if (tw.every((w) => nw.includes(w)) && tw.join('').length >= 3) return 60 + Math.round((10 * tw.length) / nw.length); // "volleyball" is part of "U14 Volleyball"
  const a = tw.join(' ');
  const b = nw.join(' ');
  if (a.length >= 5 && editDistance(a, b, 2) <= (a.length >= 9 ? 2 : 1)) return 58;
  const shared = tw.filter((w) => w.length > 2 && nw.includes(w)).length;
  return shared ? 20 + Math.round((25 * shared) / Math.max(tw.length, nw.length)) : 0;
}

/** Memories that could be meant, best first. A memory in the active project wins a tie. */
export function mindMatches(memory, target) {
  const t = String(target || '').trim();
  const active = memory.activeProject;
  const out = [];
  for (const node of memory.nodes.values()) {
    if (node.type === 'core') continue;
    let score = node.id === t ? 100 : nameScore(node.label, t);
    if (node.type === 'document' && node.file && path.resolve(node.file) === path.resolve(t)) score = 100;
    if (score < HINT) continue;
    const mine = node.id === active || node.project === active;
    out.push({ node, score: score + (mine && score < 100 ? 4 : 0) });
  }
  const rank = { project: 3, document: 2, person: 1 };
  return out.sort((x, y) => y.score - x.score || (rank[y.node.type] || 0) - (rank[x.node.type] || 0) || (y.node.weight || 1) - (x.node.weight || 1) || (y.node.updated || 0) - (x.node.updated || 0));
}

// Every file and folder under the root, from one bounded scan, kept for a little while: several
// lookups in one reply should not walk a home folder each time.
const listings = new Map();
async function listing(root) {
  const hit = listings.get(root);
  if (hit && Date.now() - hit.at < 20_000) return hit.nodes;
  const { nodes } = await scan(root, { maxDepth: 8, maxNodes: 40000, perDir: 2000, includeRoot: false });
  listings.set(root, { at: Date.now(), nodes });
  while (listings.size > 4) listings.delete(listings.keys().next().value);
  return nodes;
}

/** Files and folders under the root whose name fits, best first (nearer the top wins a tie). */
export async function fileMatches(root, target) {
  const t = String(target || '').trim().replace(/[\\/]+$/, '');
  if (!t) return [];
  const base = path.basename(t);
  const tail = t.includes('/') || t.includes('\\') ? path.normalize(t).replace(/^[\\/]+/, '') : '';
  const core = undressed(wordsOf(base), true).join(' '); // "the budget spreadsheet" is after budget.*
  const kinds = kindsAsked(base);
  const out = [];
  for (const n of await listing(root)) {
    let score = nameScore(n.name, base);
    if (!n.dir && score < 80 && (stemOf(n.name).toLowerCase() === stemOf(base).toLowerCase() || wordsOf(stemOf(n.name)).join(' ') === core)) score = /\.[^.]+$/.test(base) ? 55 : 80; // "notes" means notes.md
    if (!n.dir && score >= HINT && kinds.has(kindOf(n.name))) score = Math.min(95, score + 4); // the spreadsheet, not the notes of the same name
    if (tail && n.id.endsWith(path.sep + tail)) score = 96;
    if (score >= HINT) out.push({ path: n.id, name: n.name, dir: n.dir, depth: n.depth, score });
  }
  return out.sort((x, y) => y.score - x.score || x.depth - y.depth || x.path.localeCompare(y.path));
}

/** The folders from the root down to a path, and the path itself, as the Files map draws them. */
export async function chainTo(root, full) {
  const rel = path.relative(root, full);
  const parts = rel ? rel.split(path.sep) : [];
  const chain = [];
  let at = root;
  for (let i = 0; i < parts.length; i++) {
    const id = path.join(at, parts[i]);
    let dir = i < parts.length - 1;
    if (!dir) dir = await fs.stat(id).then((s) => s.isDirectory(), () => false);
    chain.push({ id, name: parts[i], parent: at, dir, kind: dir ? 'dir' : kindOf(parts[i]), depth: i + 1, more: 0 });
    at = id;
  }
  return chain;
}

const real = (p) => fs.realpath(p).catch(() => path.resolve(p));

/**
 * Find what `target` names and which map it is on.
 * @param target a memory's label or id, or a file or folder name or path (relative to the root, absolute, or ~/…)
 * @param map 'mind' | 'files' to look on one map only; omitted, the target decides (a path or a known
 *   file goes to Files, a memory to Mind; a close call goes to the better match, a tie to the memory)
 * @returns {map:'mind', node, also} | {map:'files', path, name, dir, chain, also} | {map:null, outside?, closest, note}
 *   `also`: other things that fit just as well, so the model can ask which was meant
 */
export async function locate(target, { map, memory, root }) {
  const t = String(target || '').trim();
  if (!t) return { map: null, closest: [], note: 'Point at what? No name was given.' };
  root = path.resolve(root);
  const wantMind = map !== 'files';
  const wantFiles = map !== 'mind';
  const minds = wantMind ? mindMatches(memory, t) : [];
  let filesHit = [];
  let outside = false;

  if (wantFiles) {
    const expanded = t.startsWith('~') ? path.join(os.homedir(), t.slice(1)) : t;
    const asPath = path.isAbsolute(expanded) || /[\\/]/.test(t) || t.startsWith('~');
    if (asPath) {
      const full = path.resolve(root, expanded);
      const inRoot = isInside(root, full) && isInside(await real(root), await real(full));
      if (!inRoot) {
        const doc = minds.find((m) => m.score === 100 && m.node.type === 'document');
        if (doc) return { map: 'mind', node: doc.node, also: [] };
        outside = true;
      } else if (await fs.stat(full).then(() => true, () => false)) { // never looked at outside the root: on Windows a UNC path connects to its host
        filesHit = [{ path: full, name: path.basename(full) || full, dir: false, score: 100 }];
      }
    }
    if (!filesHit.length && !outside) filesHit = await fileMatches(root, t);
  }

  const m = minds[0];
  const f = filesHit[0];
  const mOk = m && m.score >= FOUND;
  const fOk = f && f.score >= FOUND;
  let pick = null;
  if (mOk && fOk) pick = looksLikePath(t) ? (m.score >= 100 ? 'mind' : 'files') : m.score >= f.score ? 'mind' : 'files';
  else if (mOk) pick = 'mind';
  else if (fOk) pick = 'files';

  if (pick === 'mind') {
    return { map: 'mind', node: m.node, also: minds.slice(1).filter((x) => x.score === m.score).map((x) => x.node.label) };
  }
  if (pick === 'files') {
    const chain = await chainTo(root, f.path);
    const last = chain.at(-1);
    return { map: 'files', path: f.path, name: last?.name || path.basename(f.path), dir: Boolean(last?.dir), chain, also: filesHit.slice(1).filter((x) => x.score === f.score).map((x) => path.relative(root, x.path)) };
  }
  const closest = [
    ...minds.slice(0, 3).map((x) => ({ s: x.score, text: `${x.node.label} (${x.node.type}, Mind map)` })),
    ...filesHit.slice(0, 3).map((x) => ({ s: x.score, text: `${path.relative(root, x.path)} (Files map)` })),
  ].sort((a, b) => b.s - a.s).slice(0, 4).map((x) => x.text);
  if (outside) return { map: null, outside: true, closest, note: `That is outside the folder I am allowed to see (${root}), so it is not on the Files map.` };
  return { map: null, closest, note: `"${t}" is not on ${map ? `the ${map === 'mind' ? 'Mind' : 'Files'} map` : 'either map'}.` };
}

/** One line for the model about what was found. */
export function describeHit(hit, root) {
  if (hit.map === 'mind') {
    const n = hit.node;
    return `Pointing at ${n.type === 'core' ? '' : `the ${n.type} `}"${n.label}" on the Mind map.${hit.also?.length ? ` Also matching: ${hit.also.join(', ')}.` : ''}`;
  }
  if (hit.map === 'files') {
    const rel = path.relative(path.resolve(root), hit.path) || '.';
    return `Pointing at the ${hit.dir ? 'folder' : 'file'} ${hit.name} on the Files map (${rel}, in ${path.dirname(hit.path)}).${hit.also?.length ? ` Also matching: ${hit.also.join(', ')}.` : ''}`;
  }
  return `${hit.note}${hit.closest?.length ? ` Closest: ${hit.closest.join('; ')}.` : ' Nothing close.'}`;
}

/** The window event that flies the map's camera to a hit. */
export function pointEvent(hit, extra = {}) {
  if (hit.map === 'mind') return { type: 'point', map: 'mind', id: hit.node.id, label: hit.node.label, ...extra };
  if (hit.map === 'files') return { type: 'point', map: 'files', id: hit.path, label: hit.name, chain: hit.chain, ...extra };
  return null;
}
