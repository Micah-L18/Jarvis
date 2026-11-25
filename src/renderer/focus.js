// Pointing at things on the maps without getting in the user's way: a guard that holds a camera
// move back while the user has hold of the view, the rule that picks the one thing a remark names
// (for when the model forgets to point), and opening the Files map down to a path.

/**
 * Says whether the view is the user's right now (a button held on the map, or touched within the
 * last `quietMs`, or something else that blocks, like the controls being open), and runs a camera
 * move once it is free. Only the latest move waits; one that cannot run within `maxWait` is dropped.
 */
export class InteractionGuard {
  constructor({ now = () => performance.now(), quietMs = 2000, maxWait = 10000, poll = 250, blocked = () => '', timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (t) => clearTimeout(t) } } = {}) {
    Object.assign(this, { now, quietMs, maxWait, poll, blocked, timers });
    this.pressed = false;
    this.last = -Infinity;
    this.waiting = null; // {fn, since}
    this.timer = null;
  }

  down() { this.pressed = true; this.last = this.now(); }
  up() { this.pressed = false; this.last = this.now(); }
  touch() { this.last = this.now(); }

  /** Why the view cannot be moved now, or '' if it can. */
  busy() {
    if (this.pressed) return 'holding the view';
    if (this.now() - this.last < this.quietMs) return 'just moved the view';
    return this.blocked() || '';
  }

  /** Run `fn` now if the view is free ('now'), or as soon as it is ('deferred'). */
  run(fn) {
    if (!this.busy()) {
      this.cancel();
      fn();
      return 'now';
    }
    this.waiting = { fn, since: this.now() };
    if (!this.timer) this._tick();
    return 'deferred';
  }

  cancel() {
    this.waiting = null;
    if (this.timer) this.timers.clear(this.timer);
    this.timer = null;
  }

  _tick() {
    this.timer = this.timers.set(() => {
      this.timer = null;
      const w = this.waiting;
      if (!w) return;
      if (!this.busy()) {
        this.waiting = null;
        w.fn();
      } else if (this.now() - w.since >= this.maxWait) {
        this.waiting = null; // the moment has passed
      } else {
        this._tick();
      }
    }, this.poll);
  }
}

// Words that are names of things too often to be taken as pointing at one: a memory or a folder
// labelled like this is never focused just because the word came up.
export const COMMON = new Set(`
a an and are as at be but by can could did do does for from get got had has have he her here him his how i if in into is it its
just like me more my no not now of on one or our out over she so some than that the their them then there these they this those
to too two up us was we were what when where which who why will with would yes you your all any about after again also back
been being both each few going good great into last long made make many most much must new next off old only other own right
said same say see should show since still such take tell than thing things think three time today tomorrow very want way week
well went year yesterday look looking open pull find where's what's how's it's that's let's okay ok please thanks thank jarvis
sir hello hi hey morning evening afternoon night home work general notes note docs documents document files file folder folders
project projects media music pictures photos images videos downloads desktop data test tests misc stuff todo plan plans list
budget coffee team people person topic topics fact facts task tasks summary report draft drafts idea ideas meeting meetings
src lib bin build dist assets public private shared temp tmp backup backups archive old new final copy untitled
`.trim().split(/\s+/));

const WORDISH = /[\p{L}\p{N}]/u;

function occurrences(hay, needle) {
  const spans = [];
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + 1)) {
    const before = hay[at - 1] || ' ';
    const after = hay[at + needle.length] || ' ';
    if (!WORDISH.test(before) && !WORDISH.test(after)) spans.push([at, at + needle.length]);
  }
  return spans;
}

/**
 * The one thing on the maps that a remark names outright, or null. Conservative on purpose: a
 * label counts only if it appears whole (any case), is at least `min` characters, and is not a
 * common word; a mention inside a longer one ("Volleyball" in "U14 Volleyball") does not count
 * separately; and if more than one thing is named, or two things share the name, nothing is picked.
 * @param candidates [{key, label, ...}] — key tells things apart (a node id or a path)
 */
export function pickMention(text, candidates, { common = COMMON, min = 3 } = {}) {
  const hay = String(text || '').toLowerCase().replace(/[’‘]/g, "'");
  if (!hay.trim()) return null;
  const hits = [];
  for (const c of candidates) {
    const label = String(c.label || '').trim().toLowerCase();
    if (label.length < min || common.has(label)) continue;
    if (!WORDISH.test(label)) continue;
    for (const span of occurrences(hay, label)) hits.push({ c, label, span });
  }
  // a mention inside a longer mention is part of it
  const kept = hits.filter((x) => !hits.some((y) => y !== x && y.label.length > x.label.length && y.span[0] <= x.span[0] && y.span[1] >= x.span[1]));
  const keys = new Set(kept.map((x) => x.c.key));
  if (keys.size !== 1) return null;
  return kept[0].c;
}

/**
 * Make sure every step from the root down to a path is on the Files map: each folder on the way
 * that has not been opened yet is expanded (its whole listing, so the path arrives among its
 * neighbours), and anything still missing (a folder too big to list in full) is added on its own.
 * New entries are appended to `nodes` in place; what is already there is left alone.
 * @param chain [{id, name, parent, dir, kind, depth, more}] from just under the root down to the path
 * @param expand (dirId, depth) -> Promise<nodes> — one folder's children, as fsscan.expand gives them
 * @returns how many entries were added
 */
export async function expandToPath(nodes, chain, expand) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  let added = 0;
  for (const step of chain) {
    if (byId.has(step.id)) continue;
    const parent = byId.get(step.parent);
    if (parent) {
      const kids = await expand(parent.id, parent.depth);
      for (const kid of kids || []) {
        if (byId.has(kid.id)) continue;
        nodes.push(kid);
        byId.set(kid.id, kid);
        added++;
      }
      parent.more = 0;
    }
    if (!byId.has(step.id)) {
      const node = { ...step, depth: parent ? parent.depth + 1 : step.depth };
      nodes.push(node);
      byId.set(node.id, node);
      added++;
    }
  }
  return added;
}
