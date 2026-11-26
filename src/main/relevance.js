// Which memories bear on what is being said right now. Each turn the model gets only these, not the
// whole mind map: a memory it is shown is a memory it will use, so an unrelated one is a leak waiting
// to happen. Scoring is BM25 over a memory's label, summary, its neighbours' labels and its project.
import fs from 'node:fs';

const STOP = new Set(`a about above after again against all also am an and any anything are as at be because been before being
below between both but by can cannot could did do does doing done down during each else even ever every few for from further
get gets getting got had has have having he her here hers herself him himself his how i if in into is it its itself just know
let lets like ll me might more most much must my myself need no nor not now of off on once only or other ought our ours
ourselves out over own please really right same say said see she should so some something such tell than thank thanks that
the their theirs them themselves then there these they thing things think this those through to too under until up us very
want was way we well were what when where which while who whom why will with would yeah yes yet you your yours yourself ok okay
sir madam jarvis hey hi hello oh um uh actually maybe probably still lately today tonight tomorrow yesterday going go gonna
make made user users week weeks day days time times last next first new old good great bit lot one two back look looking
again remind remember recall find show give put take keep wonder wondering doesn don didn isn wasn won aren couldn wouldn
shouldn hasn haven hadn mr mrs ms dr liked likes love loved loves wanted wants thinking thought thinks feel feeling felt left
called calling calls told ask asked asking says saying sure kind sort stuff lately recently soon later ago`.split(/\s+/));

// Kinship words people use in place of a name ("my boy", "the wife"): each also looks for the others.
const KIN = [['son', 'boy', 'lad'], ['daughter', 'girl'], ['kid', 'kids', 'child', 'children', 'son', 'daughter'],
  ['wife', 'husband', 'partner', 'spouse'], ['mum', 'mom', 'mother', 'mam'], ['dad', 'father'], ['brother', 'sibling'], ['sister', 'sibling'],
  ['grandma', 'grandmother', 'nan', 'granny'], ['grandpa', 'grandfather', 'granddad']];
const KIN_OF = new Map();
for (const group of KIN) for (const w of group.map(stem)) KIN_OF.set(w, [...new Set([...(KIN_OF.get(w) || []), ...group.map(stem).filter((x) => x !== w)])]);

/** Fold a word to a rough stem so "drills", "drilling" and "drill" meet, and "decided" meets "decide". */
export function stem(w) {
  if (/^\d/.test(w)) return w;
  if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (w.endsWith('sses')) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !/(ss|us|is)$/.test(w)) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  if (w.length > 3 && /([^aeiouls])\1$/.test(w)) w = w.slice(0, -1); // runn → run, but not "ball"/"pass"
  if (w.length > 4 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

/** The content words of a text, stemmed. */
export function terms(text) {
  const out = [];
  const plain = String(text || '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
  for (const raw of plain.split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 2 || STOP.has(raw)) continue;
    out.push(stem(raw));
  }
  return out;
}

// Words that point back at what was just being talked about ("what about that?", "and the hotel?").
const REFERRING = /\b(it|its|that|this|those|these|they|them|there|he|she|him|her|his|hers|one|ones|same|else|again|also|too|instead)\b|^\s*(and|so|but|what about|how about|ok so|okay so)\b/i;

const FIELD = { label: 3, summary: 1, neighbour: 0.5, project: 0.5, content: 0.3 };
const K1 = 1.2;
const B = 0.75;

function add(tf, words, weight) {
  for (const w of words) tf.set(w, (tf.get(w) || 0) + weight);
}

/**
 * Index the graph. With `content`, the text of saved documents is indexed too (for recall, which
 * can afford to read files; the per-turn path does not).
 */
export function buildIndex(memory, { content = false } = {}) {
  const docs = new Map();
  const df = new Map();
  let total = 0;
  const neighbourLabels = new Map();
  for (const e of memory.edges) {
    const a = memory.nodes.get(e.source);
    const b = memory.nodes.get(e.target);
    if (!a || !b || a.type === 'core' || b.type === 'core' || a.type === 'project' || b.type === 'project') continue;
    if (!neighbourLabels.has(a.id)) neighbourLabels.set(a.id, []);
    if (!neighbourLabels.has(b.id)) neighbourLabels.set(b.id, []);
    neighbourLabels.get(a.id).push(b.label);
    neighbourLabels.get(b.id).push(a.label);
  }
  for (const n of memory.nodes.values()) {
    if (n.type === 'core') continue;
    const tf = new Map();
    add(tf, terms(n.label), FIELD.label);
    add(tf, terms(n.summary), FIELD.summary);
    add(tf, terms((neighbourLabels.get(n.id) || []).join(' ')), FIELD.neighbour);
    if (n.type !== 'project') add(tf, terms(memory.nodes.get(n.project)?.label), FIELD.project);
    if (content && n.type === 'document' && n.file) add(tf, terms(docText(n.file)), FIELD.content);
    let len = 0;
    for (const [w, v] of tf) { len += v; df.set(w, (df.get(w) || 0) + 1); }
    total += len;
    docs.set(n.id, { tf, len });
  }
  // what one rare word is worth (the idf of a word only one memory has): the yardstick for thresholds
  const unit = Math.log(1 + (docs.size - 0.5) / 1.5);
  return { docs, df, n: docs.size, unit, avg: total / Math.max(1, docs.size) };
}

const docCache = new Map();
function docText(file) {
  try {
    const { mtimeMs } = fs.statSync(file);
    const hit = docCache.get(file);
    if (hit && hit.mtimeMs === mtimeMs) return hit.text;
    const text = fs.readFileSync(file, 'utf8').slice(0, 20000);
    docCache.set(file, { mtimeMs, text });
    return text;
  } catch {
    return '';
  }
}

/** BM25 of every memory against weighted query terms: id → {score, cover}, cover being the weighted idf of the terms it matched. */
export function score(index, query) {
  const out = new Map();
  if (!query.size) return out;
  for (const [id, { tf, len }] of index.docs) {
    let s = 0;
    let cover = 0;
    for (const [w, qw] of query) {
      const f = tf.get(w);
      if (!f) continue;
      const df = index.df.get(w) || 0;
      // Floored, so that a word most memories share still counts for something: a mind map that is mostly one team should still answer to its name.
      const idf = Math.max(Math.log(1 + (index.n - df + 0.5) / (df + 0.5)), 0.3 * index.unit);
      s += qw * idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * len) / index.avg)));
      cover += qw * idf;
    }
    if (s > 0) out.set(id, { score: s, cover });
  }
  return out;
}

function weigh(words, weight, into = new Map()) {
  const put = (w, v) => into.set(w, Math.max(into.get(w) || 0, v));
  for (const w of words) {
    put(w, /^\d/.test(w) ? weight * 0.35 : weight); // a bare number is weak evidence
    for (const k of KIN_OF.get(w) || []) put(k, weight * 0.7);
  }
  return into;
}

/**
 * Memories that bear on this turn, best first: [{node, score}].
 * `text` is what the user just said; `context` the turns before it ([{role, text}], oldest first).
 * The context only sharpens what the message itself points at, or stands in for it when the message
 * refers back ("and the hotel?", "what's thirty percent of that?"); a change of subject drops it.
 * A memory is kept when it scores at least `min` (see below) and `ratio` of the best, and matches at least
 * `cover` of what the best-covered memory matched.
 */
export function rank(memory, { text = '', context = [], index = buildIndex(memory), min = 0.53, ratio = 0.4, cover = 0.4, limit = 8, exclude = () => false } = {}) {
  const msg = weigh(terms(text), 1);
  const recent = context.slice(-4);
  const ctx = new Map();
  recent.forEach((t, i) => weigh(terms(t.text), i >= recent.length - 2 ? 0.6 : 0.3, ctx));
  for (const w of msg.keys()) ctx.delete(w);
  const sMsg = score(index, msg);
  const sCtx = score(index, ctx);
  const followUp = REFERRING.test(text) || msg.size === 0;
  // A memory that matches only the vaguest word of the message ("plan" in "the plan for the cutover") is not what was meant.
  let best = 0;
  for (const { cover } of sMsg.values()) best = Math.max(best, cover);
  const scored = [];
  for (const [id] of index.docs) {
    const node = memory.nodes.get(id);
    if (!node || node.id === 'project:general' || exclude(node)) continue;
    const hit = sMsg.get(id);
    const m = hit && hit.cover >= cover * best ? hit.score : 0;
    const c = sCtx.get(id)?.score || 0;
    let s = m ? m + 0.3 * c : followUp ? 0.6 * c : 0;
    if (!s) continue;
    if (node.id === memory.activeProject || node.project === memory.activeProject) s *= 1.2;
    scored.push({ node, score: s });
  }
  scored.sort((a, b) => b.score - a.score || (b.node.weight || 1) - (a.node.weight || 1) || (b.node.updated || 0) - (a.node.updated || 0));
  // `min` is in units of what one rare word matched once in a label is worth, so it means the same in a small memory as in a big one.
  const top = scored[0]?.score || 0;
  return scored.filter((h) => h.score >= Math.max(min * index.unit, ratio * top)).slice(0, limit);
}

// Preferences that change how Jarvis should talk, recognised in memories filed before the extractor marked them.
const MANNER = /\b(call(s|ed)? (him|her|them|me)|be called|address(ed)?|nickname|go(es)? by|units?|metric|imperial|celsius|fahrenheit|brief|short|concise|verbose|wordy|detail(ed)?|filler|language|speak|spoken|talk(s|ing)?|tone|formal|casual|swear(ing)?|jokes?|humou?r|small talk|sir|ma'?am)\b/i;

/** Is this a standing preference — something to honour in every reply, whatever the subject? */
export function isStanding(node) {
  if (!node || node.type === 'core' || node.type === 'project' || node.type === 'document') return false;
  if (typeof node.standing === 'boolean') return node.standing;
  if (node.type === 'preference') return MANNER.test(`${node.label} ${node.summary || ''}`);
  return node.type === 'fact' && /\b(preferred name|nickname|form of address|(user'?s|my) name)\b/i.test(node.label || '');
}
