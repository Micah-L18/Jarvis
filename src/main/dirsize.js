// How much is inside a folder, measured in the background for the Files map: a walk of the whole
// tree (dot files and the folders the map leaves out included), bounded in time and entries so a huge
// tree cannot keep the disk busy. A walk that runs out of budget reports what it counted as a lower
// bound, and keeps its place: the next walk of that folder carries on from there instead of starting
// over. Each folder the walk finishes is remembered by path and modification time, so going over the
// same ground again (a parent after its subfolders, a folder opened further) costs one stat per folder.
//
// The walk runs in a child process (DirSizer), never in Electron's main process: reading a folder of
// a hundred thousand files takes a while, and a stat on a dead network mount never returns at all and
// holds a thread of the pool every fs call in the process shares. A child that hangs is killed, and
// the folder it hung in is left out from then on. It does not go into other file systems mounted
// inside the root (a NAS, a USB disk), nor into cloud-drive folders, which a walk would download.
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BATCH = 32; // stats in flight at once
const KEEP = 10 * 60 * 1000; // a remembered size is trusted this long even if the folder's mtime is unchanged (contents of subfolders can change without it)
const SYSTEM = new Set(['/proc', '/sys', '/dev', '/run']); // not real files, when the root is /
const CLOUD = /[\\/]Library[\\/](CloudStorage|Mobile Documents)$/; // macOS file-provider folders: walking them wakes the provider and downloads
const OP_TIMEOUT = 4000; // one stat or read that takes longer than this is hung (a dead network mount), not slow

/** A file system call that did not come back in time. */
class Stuck extends Error {
  constructor(where) {
    super(`no answer from the disk at ${where}`);
    this.path = where;
  }
}

/** Mount points (Linux): other file systems inside the root are not walked into, nor even looked at. */
function linuxMounts() {
  try {
    const unescape = (p) => p.replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
    return new Set(fsSync.readFileSync('/proc/self/mounts', 'utf8').split('\n').map((l) => l.split(' ')[1]).filter(Boolean).map(unescape));
  } catch {
    return new Set();
  }
}

/** The walk itself, in whatever process runs it (the child, or a test). */
export class DirWalker {
  /** @param o {opTimeout, mounts() -> Set of mount points, skip: paths never to walk into} */
  constructor({ opTimeout = OP_TIMEOUT, mounts = () => (process.platform === 'linux' ? linuxMounts() : new Set()), skip = [] } = {}) {
    this.cache = new Map(); // path -> {mtimeMs, bytes, files, exact, at}
    this.partial = new Map(); // path -> where an unfinished walk of this folder stopped: {mtimeMs, names, done, bytes, files, exact, subdirs}
    this.stuck = new Set(skip); // folders where the disk did not answer: left out
    this.gen = 0;
    this.opTimeout = opTimeout;
    this.listMounts = mounts;
    this.mounts = new Set();
    this.dev = null; // the device of the root: a folder on another one is not walked into
    this.onStuck = () => {};
  }

  /** Forget every remembered size (a rescan, a new root). */
  clear() {
    this.cache.clear();
    this.partial.clear();
  }

  stop() {
    this.gen++;
  }

  /** `promise`, or Stuck if it has not settled within opTimeout. */
  timed(promise, where) {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Stuck(where)), this.opTimeout); })]).finally(() => clearTimeout(timer));
  }

  /** A remembered, finished size for this folder, if it is still current. */
  async cached(dir) {
    const c = this.cache.get(dir);
    if (!c || Date.now() - c.at > KEEP) return null;
    try {
      const st = await this.timed(fs.stat(dir), dir);
      return st.mtimeMs === c.mtimeMs ? c : null;
    } catch (err) {
      if (err instanceof Stuck) throw err;
      return null;
    }
  }

  /**
   * Size of everything inside `dir`.
   * @param budget {until: ms timestamp, entries: how many more entries may be looked at} — shared, so
   *   a walk and everything it walks into stop together. Out of entries, no further folder is opened
   *   (the one being counted is finished); out of time, it stops where it is, and remembers where.
   * @param onDone (dir, {bytes, files, exact}) for each folder inside that the walk measured completely
   * @returns {bytes, files, complete, exact}: complete when the walk got through it all; exact when, besides, nothing in it was
   *   left out (unreadable, another disk, a cloud folder, a hung mount) — otherwise the figures are a lower bound
   * @throws Stuck when the disk stops answering
   */
  async walk(dir, budget, onDone = () => {}, gen = this.gen) {
    const skipped = { bytes: 0, files: 0, complete: true, exact: false };
    if (this.stuck.has(dir)) return skipped;
    const hit = await this.cached(dir);
    if (hit) return { bytes: hit.bytes, files: hit.files, complete: true, exact: hit.exact };
    let st;
    try {
      st = await this.timed(fs.stat(dir), dir);
    } catch (err) {
      if (err instanceof Stuck) throw err;
      return { ...skipped, exact: err.code === 'ENOENT' }; // gone is nothing; unreadable is something we could not count
    }
    if (this.dev != null && st.dev !== this.dev) return skipped;
    let p = this.partial.get(dir);
    if (!p || p.mtimeMs !== st.mtimeMs) {
      let entries;
      try {
        entries = await this.timed(fs.readdir(dir, { withFileTypes: true }), dir);
      } catch (err) {
        if (err instanceof Stuck) throw err;
        return { ...skipped, exact: err.code === 'ENOENT' };
      }
      p = { mtimeMs: st.mtimeMs, names: [], done: 0, bytes: 0, files: 0, exact: true, subdirs: [] };
      for (const e of entries) { // names only: a path is made for each file as it is counted, not all at once
        if (e.isDirectory()) p.subdirs.push(e.name);
        else if (e.isFile()) p.names.push(e.name);
      }
      budget.entries -= entries.length;
    }
    let complete = true;
    while (p.done < p.names.length) {
      if (gen !== this.gen || Date.now() > budget.until) { complete = false; break; }
      const batch = p.names.slice(p.done, p.done + BATCH);
      const sizes = await this.timed(Promise.all(batch.map((n) => fs.lstat(path.join(dir, n)).then((s) => s.size, (e) => (e.code === 'ENOENT' ? 0 : -1)))), dir);
      for (const s of sizes) {
        if (s < 0) p.exact = false;
        else { p.bytes += s; p.files++; }
      }
      p.done += batch.length;
    }
    let { bytes, files, exact } = p;
    if (complete) {
      for (const name of p.subdirs) {
        const sub = path.join(dir, name);
        if (SYSTEM.has(sub)) continue;
        if (this.mounts.has(sub) || CLOUD.test(sub) || this.stuck.has(sub)) { exact = false; continue; }
        if (gen !== this.gen || Date.now() > budget.until || budget.entries <= 0) { complete = false; break; }
        const r = await this.walk(sub, budget, onDone, gen);
        bytes += r.bytes; files += r.files;
        if (!r.complete) complete = false;
        if (r.exact === false) exact = false;
      }
    }
    if (!complete) {
      this.partial.set(dir, p); // the next walk carries on with the files from here; finished subfolders are in the cache
      return { bytes, files, complete: false, exact: false };
    }
    this.partial.delete(dir);
    this.cache.set(dir, { mtimeMs: st.mtimeMs, bytes, files, exact, at: Date.now() });
    onDone(dir, { bytes, files, exact });
    return { bytes, files, complete: true, exact };
  }

  /**
   * Measure these folders one after another, reporting each through `report(dir, {bytes, files,
   * complete, exact})` as soon as it is known — and any other wanted folder a walk happens to finish on the
   * way. A folder whose walk ran out of budget is tried once more at the end, deepest first: by then
   * its subfolders are mostly remembered, and the second walk carries on where the first stopped. A new
   * call replaces the old one (only the latest map is measured).
   * @param opts {each: ms per walk, entries: entries per walk, total: ms for the whole run, root: the files folder}
   */
  async measure(dirs, report, { each = 1500, entries = 60000, total = 30000, root = null } = {}) {
    const gen = ++this.gen;
    const wanted = new Set(dirs);
    const known = new Set();
    const tell = (dir, r) => {
      if (gen !== this.gen || !wanted.has(dir) || known.has(dir)) return; // each finished size is told once
      if (r.complete) known.add(dir);
      report(dir, r);
    };
    const end = Date.now() + total;
    try {
      const under = root && (root.endsWith(path.sep) ? root : root + path.sep);
      this.mounts = new Set([...this.listMounts()].filter((m) => !root || (m !== root && m.startsWith(under))));
      this.dev = root ? (await this.timed(fs.stat(root), root)).dev : null;
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
    } catch (err) {
      if (!(err instanceof Stuck)) throw err;
      this.stuck.add(err.path);
      this.onStuck(err.path);
    }
  }
}

const CHILD = fileURLToPath(new URL('./dirsize-child.js', import.meta.url));

/**
 * Folder sizes for main.js: a DirWalker in a child process. measure(dirs, report, opts) resolves when the run is over —
 * finished, replaced by a newer one, stopped, or given up on because the disk stopped answering (then the child is killed
 * and the folder it hung in is left out of every later walk).
 */
export class DirSizer {
  /** @param o {grace: ms past `total` before a run is given up on, execArgv: for the child (tests), opTimeout} */
  constructor({ grace = 3000, execArgv = [], opTimeout } = {}) {
    this.grace = grace;
    this.execArgv = execArgv;
    this.opTimeout = opTimeout;
    this.proc = null;
    this.run = null;
    this.gen = 0;
    this.stuck = new Set();
  }

  spawn() {
    const proc = fork(CHILD, [], {
      execPath: process.execPath, // Electron's own binary, run as Node
      execArgv: this.execArgv,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      serialization: 'advanced',
    });
    proc.on('message', (m) => this.message(proc, m));
    proc.on('exit', () => { if (this.proc === proc) { this.proc = null; this.settle(); } });
    proc.on('error', () => { if (this.proc === proc) this.kill(); });
    proc.send({ type: 'init', skip: [...this.stuck], opTimeout: this.opTimeout });
    proc.unref(); // an idle child does not keep Jarvis (or a test) running; a run in flight holds its own timer
    proc.channel?.unref();
    this.proc = proc;
    return proc;
  }

  message(proc, m) {
    if (proc !== this.proc || !m) return;
    const run = this.run;
    if (m.type === 'size' && run && m.gen === run.gen) run.report(m.dir, m.r);
    else if (m.type === 'done' && run && m.gen === run.gen) this.settle();
    else if (m.type === 'stuck') { // its thread pool is tied up for good: start afresh without that folder
      this.stuck.add(m.path);
      this.kill();
    }
  }

  measure(dirs, report, opts = {}) {
    this.settle();
    const gen = ++this.gen;
    const proc = this.proc || this.spawn();
    const total = opts.total ?? 30000;
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.kill(), total + this.grace); // overran its own budget: hung somewhere
      this.run = { gen, report, resolve, timer };
      proc.send({ type: 'measure', gen, dirs, opts });
    });
  }

  settle() {
    const run = this.run;
    this.run = null;
    if (run) { clearTimeout(run.timer); run.resolve(); }
  }

  kill() {
    const proc = this.proc;
    this.proc = null;
    this.settle();
    try { proc?.kill('SIGKILL'); } catch { /* gone */ }
  }

  /** Stop measuring (a new root, the window closing). */
  stop() {
    this.gen++;
    this.proc?.send({ type: 'stop' });
    this.settle();
  }

  /** Stop, and forget every remembered size (a rescan, a new root): what is on disk now is measured afresh. */
  clear() {
    this.stop();
    this.proc?.send({ type: 'clear' });
  }

  dispose() {
    this.kill();
  }
}
