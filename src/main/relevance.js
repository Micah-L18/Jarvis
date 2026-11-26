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
called calling calls told ask asked asking says saying sure kind sort stuff lately recently soon later ago
set start stop open close turn switch play pause minute minutes hour hours second seconds`.split(/\s+/));
// "may" is a month only next to a day number ("May 3", "3rd of May") or capitalised mid-sentence ("flying in May"); otherwise it is "may I ask".
const MAY = 'may';

// Letters NFD does not take apart, folded the way people type them without the key: Søren, Łukasz, Æsir, Straße.
const FOLD = { ø: 'o', ł: 'l', æ: 'ae', œ: 'oe', ß: 'ss', đ: 'd', ð: 'd', þ: 'th', ı: 'i', ŀ: 'l', ħ: 'h' };
// Ordinals as speech recognition writes them ("the 14th", "the third") meet the day numbers memories store.
const ORDINAL = Object.fromEntries(['second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth',
  'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth', 'eighteenth', 'nineteenth', 'twentieth'].map((w, i) => [w, String(i + 2)]).concat([['thirtieth', '30']]));
// Words that name a day or a part of the week: they place a question in time more than they say what it is about.
const WHEN = new Set(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'weekend', 'morning', 'afternoon', 'evening', 'night'].map((w) => stem(w)));

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
  return tokens(text).map((t) => t.w);
}

/** The content words with what kind each is: 'word', 'num' (a bare number) or 'ord' (an ordinal, "14th", "third": most likely a date). */
function tokens(text) {
  const out = [];
  const folded = String(text || '').normalize('NFD').replace(/\p{M}/gu, '').replace(/[øłæœßđðþıŀħØŁÆŒĐÐÞĦ]/g, (c) => {
    const f = FOLD[c.toLowerCase()];
    return c === c.toLowerCase() ? f : f[0].toUpperCase() + f.slice(1);
  });
  const words = folded.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const isNum = (w) => /^\d+(st|nd|rd|th)?$/i.test(w || '');
  words.forEach((orig, i) => {
    let raw = orig.toLowerCase();
    if (raw === MAY) {
      const midSentence = i > 0 && orig === 'May';
      if (!(isNum(words[i - 1]) || isNum(words[i + 1]) || (words[i - 1] || '').toLowerCase() === 'of' || midSentence)) return;
      out.push({ w: MAY, kind: 'word', raw });
      return;
    }
    const ord = /^(\d+)(st|nd|rd|th)$/.exec(raw)?.[1] || ORDINAL[raw];
    if (ord) return out.push({ w: ord, kind: 'ord' });
    if (/^\d+$/.test(raw)) return out.push({ w: raw, kind: 'num' }); // single digits too: "May 3" is a date
    if (raw.length < 2 || STOP.has(raw)) return;
    out.push({ w: stem(raw), kind: 'word', raw });
  });
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
    if (content) add(tf, terms(n.type), FIELD.neighbour); // recall("tasks"); not per turn, where "a task for you" would pull in every task
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

// How much a word of the query counts: a bare number is weak evidence (a single digit too weak to match on its own: "5 minutes"),
// an ordinal is probably a date, and a day of the week places a question in time more than it says what it is about.
const KIND_WEIGHT = { word: 1, ord: 0.8 };
function weigh(text, weight, into = new Map(), index = null) {
  const put = (w, v) => into.set(w, Math.max(into.get(w) || 0, v));
  const list = tokens(text);
  list.forEach(({ w, kind, raw }, i) => {
    put(w, weight * (KIND_WEIGHT[kind] ?? (w.length > 1 ? 0.35 : 0.2)) * (WHEN.has(w) ? 0.5 : 1));
    for (const k of KIN_OF.get(w) || []) put(k, weight * 0.7);
    // Two words that a memory spells as one, as speech recognition splits names ("sun peak" for SunPeak).
    const next = list[i + 1];
    if (index && kind === 'word' && next?.kind === 'word') {
      const joined = stem(raw + next.raw);
      if (index.df.has(joined)) put(joined, weight);
    }
  });
  return into;
}

const editDistance = (a, b, most) => {
  if (Math.abs(a.length - b.length) > most) return most + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
};

/**
 * For recall when nothing matches as said: the words in memory that a query word begins ("power" for Powerwall) or is a
 * slip away from ("Kenjy" for Kenji), as extra query terms. Not per turn: a loose match there is a leak.
 */
export function nearTerms(index, text, weight = 0.7) {
  const out = new Map();
  for (const { w, kind } of tokens(text)) {
    if (kind !== 'word' || w.length < 4 || index.df.has(w)) continue;
    const most = w.length >= 8 ? 2 : 1;
    let n = 0;
    for (const t of index.df.keys()) {
      if (t.length < 4 || /^\d/.test(t)) continue;
      if (t.startsWith(w) || (t[0] === w[0] && w.length >= 5 && editDistance(w, t, most) <= most)) { out.set(t, weight); if (++n >= 8) break; }
    }
  }
  return out;
}

/**
 * Memories that bear on this turn, best first: [{node, score}].
 * `text` is what the user just said; `context` the turns before it ([{role, text}], oldest first).
 * The context only sharpens what the message itself points at, or stands in for it when the message
 * refers back ("and the hotel?", "what's thirty percent of that?"); a change of subject drops it.
 * A memory is kept when it scores at least `min` (see below) and `ratio` of the best, and matches at least
 * `cover` of what the best-covered memory matched.
 */
export function rank(memory, { text = '', context = [], index = buildIndex(memory), min = 0.53, ratio = 0.4, cover = 0.4, limit = 8, exclude = () => false, extra = null } = {}) {
  const msg = weigh(text, 1, new Map(), index);
  for (const [w, v] of extra || []) if (!msg.has(w)) msg.set(w, v);
  const recent = context.slice(-4);
  const ctx = new Map();
  recent.forEach((t, i) => weigh(t.text, i >= recent.length - 2 ? 0.6 : 0.3, ctx));
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

// Preferences about how Jarvis should address or speak to the user, recognised in memories filed before the extractor marked
// them. Only that: what to call them, units, how long or formal answers should be — not tastes that happen to use the same
// words ("short layovers", "casual restaurants", "likes to talk about football", "call her mum").
const MANNER = new RegExp([
  "\\b(be|being) called\\b", '\\bcall (me|him|them) (by )?[A-Z]', "\\bgo(es)? by\\b", '\\baddress(ed)? (me|him|her|them|as)\\b', '\\bform of address\\b', '\\bnickname\\b',
  '\\b(metric|imperial|celsius|fahrenheit)\\b',
  '\\b(answers?|repl(y|ies)|responses?|explanations?)\\b[^.]*\\b(short|brief|concise|long|detailed|verbose|formal|casual|simple)\\b',
  '\\b(short|shorter|brief|concise|long|longer|detailed|verbose|formal|informal|casual|simple|plain)(er)? (answers?|repl(y|ies)|responses?|explanations?|tone|language)\\b',
  '\\b(spoken|talked|replied|answered) to in\\b', '\\b(no|without|skip) (small talk|filler|jokes|swearing)\\b', '\\bnever (mention|bring up)\\b',
].join('|'), 'i');

/** Is this a standing preference — something to honour in every reply, whatever the subject? */
export function isStanding(node) {
  if (!node || node.type === 'core' || node.type === 'project' || node.type === 'document') return false;
  if (typeof node.standing === 'boolean') return node.standing;
  if (node.type === 'preference') return MANNER.test(`${node.label} ${node.summary || ''}`);
  return node.type === 'fact' && /\b(preferred name|nickname|form of address|(user'?s|my) name)\b/i.test(node.label || '');
}
