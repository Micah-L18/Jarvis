// How much is inside a folder, measured in the background for the Files map: a walk of the whole
// tree (dot files and the folders the map leaves out included), a few entries at a time so the main
// process is never held up, and bounded in time and entries so a huge tree cannot keep the disk
// busy. A walk that runs out of budget reports what it counted as a lower bound. Each folder the walk
// finishes is remembered by path and modification time, so going over the same ground again (a
// parent after its subfolders, a folder opened further, a second look) costs one stat per folder.
import fs from 'node:fs/promises';
import path from 'node:path';

const BATCH = 32; // stats in flight at once
const KEEP = 10 * 60 * 1000; // a remembered size is trusted this long even if the folder's mtime is unchanged (contents of subfolders can change without it)
const SYSTEM = new Set(['/proc', '/sys', '/dev', '/run']); // not real files, when the root is /

export class DirSizer {
  constructor() {
    this.cache = new Map(); // path -> {mtimeMs, bytes, files, at}
    this.gen = 0;
    this.running = null;
  }

  /** A remembered, finished size for this folder, if it is still current. */
  async cached(dir) {
    const c = this.cache.get(dir);
    if (!c || Date.now() - c.at > KEEP) return null;
    try {
      const st = await fs.stat(dir);
      return st.mtimeMs === c.mtimeMs ? c : null;
    } catch {
      return null;
    }
  }

  /**
   * Size of everything inside `dir`.
   * @param budget {until: ms timestamp, entries: how many more entries may be looked at} — shared, so
   *   a walk and everything it walks into stop together. Out of entries, no further folder is opened
   *   (the one being counted is finished); out of time, it stops where it is.
   * @param onDone (dir, {bytes, files}) for each folder inside that the walk measured completely
   * @returns {bytes, files, complete}
   */
  async walk(dir, budget, onDone = () => {}, gen = this.gen) {
    const hit = await this.cached(dir);
    if (hit) return { bytes: hit.bytes, files: hit.files, complete: true };
    let st, entries;
    try {
      st = await fs.stat(dir);
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return { bytes: 0, files: 0, complete: true }; // unreadable: nothing we can count
    }
    let bytes = 0, files = 0, complete = true;
    const subdirs = [];
    const plain = [];
    for (const e of entries) {
      if (e.isDirectory()) { const p = path.join(dir, e.name); if (!SYSTEM.has(p)) subdirs.push(p); }
      else if (e.isFile()) plain.push(path.join(dir, e.name));
    }
    budget.entries -= entries.length;
    for (let i = 0; i < plain.length; i += BATCH) {
      if (gen !== this.gen || Date.now() > budget.until) { complete = false; break; }
      const sizes = await Promise.all(plain.slice(i, i + BATCH).map((f) => fs.lstat(f).then((s) => s.size, () => 0)));
      for (const s of sizes) { bytes += s; files++; }
    }
    for (const sub of subdirs) {
      if (gen !== this.gen || Date.now() > budget.until || budget.entries <= 0) { complete = false; break; }
      const r = await this.walk(sub, budget, onDone, gen);
      bytes += r.bytes; files += r.files;
      if (!r.complete) complete = false;
    }
    if (complete) {
      this.cache.set(dir, { mtimeMs: st.mtimeMs, bytes, files, at: Date.now() });
      onDone(dir, { bytes, files });
    }
    return { bytes, files, complete };
  }

  /**
   * Measure these folders one after another, reporting each through `report(dir, {bytes, files,
   * complete})` as soon as it is known — and any other wanted folder a walk happens to finish on the
   * way. A folder whose walk ran out of budget is tried once more at the end, deepest first: by then
   * its subfolders are mostly remembered, so the second walk usually finishes. A new call replaces the
   * old one (only the latest map is measured).
   * @param opts {each: ms per walk, entries: entries per walk, total: ms for the whole run}
   */
  measure(dirs, report, { each = 1500, entries = 60000, total = 30000 } = {}) {
    const gen = ++this.gen;
    const wanted = new Set(dirs);
    const known = new Set();
    const tell = (dir, r) => {
      if (gen !== this.gen || !wanted.has(dir) || known.has(dir)) return; // each finished size is told once
      if (r.complete) known.add(dir);
      report(dir, r);
    };
    const end = Date.now() + total;
    const run = async () => {
      const retry = [];
      for (const pass of [dirs, null]) {
        const list = pass || retry.sort((a, b) => b.split(path.sep).length - a.split(path.sep).length);
        for (const dir of list) {
          if (gen !== this.gen || Date.now() > end) return;
          if (known.has(dir)) continue;
          const r = await this.walk(dir, { until: Math.min(end, Date.now() + each), entries }, (d, s) => tell(d, { ...s, complete: true }), gen);
          tell(dir, r);
          if (!r.complete && pass) retry.push(dir);
        }
      }
    };
    this.running = run().catch(() => {});
    return this.running;
  }

  /** Stop measuring (a new root, the window closing). */
  stop() {
    this.gen++;
  }
}
