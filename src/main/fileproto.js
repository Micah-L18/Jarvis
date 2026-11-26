// jarvis-file://local/<encodeURIComponent(absolute path)> — how the window loads the files it shows.
// Only files whose real location is inside one of the allowed folders are served; Range requests
// are honoured so audio and video can seek.
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { mimeOf, kindOf } from './filekind.js';

export const SCHEME = 'jarvis-file';
const PREFIX = `${SCHEME}://local/`;

// Whatever a file is, the window never runs it: navigated to or framed, it gets no scripts.
const LOCKDOWN = "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'";

export const fileUrl = (absPath) => PREFIX + encodeURIComponent(absPath);

/** The absolute path a jarvis-file URL names, or null. */
export function pathFromUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== `${SCHEME}:` || u.host !== 'local') return null;
  let p;
  try {
    p = decodeURIComponent(u.pathname.replace(/^\//, ''));
  } catch {
    return null;
  }
  if (!p || p.includes('\0') || !path.isAbsolute(p)) return null;
  return path.resolve(p);
}

const inside = (root, target) => {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/**
 * The real path of `target` if it (after following every symlink) lies inside one of `roots`
 * (also followed), else null. `realpath` is injectable for tests.
 * Nothing on disk is looked at for a path that is not inside a root as written: on Windows even
 * looking at a UNC path (\\host\share) connects to that host and offers it the user's credentials.
 */
export function allowedPath(target, roots, realpath = fs.realpathSync.native) {
  if (typeof target !== 'string' || !path.isAbsolute(target) || target.includes('\0')) return null;
  const asked = path.resolve(target);
  const realRoots = [];
  let near = false;
  for (const root of roots) {
    if (!root) continue;
    const given = path.resolve(root);
    let realRoot;
    try {
      realRoot = realpath(given); // a root comes from the settings, never from the window
    } catch {
      continue;
    }
    realRoots.push(realRoot);
    if (inside(given, asked) || inside(realRoot, asked)) near = true;
  }
  if (!near) return null;
  let real;
  try {
    real = realpath(asked);
  } catch {
    return null;
  }
  return realRoots.some((r) => inside(r, real)) ? real : null;
}

/** "bytes=a-b" against a file of `size` bytes → {start, end} (inclusive), 'bad' if unsatisfiable, null if absent. */
export function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m || (m[1] === '' && m[2] === '')) return 'bad';
  let start, end;
  if (m[1] === '') {
    const n = Number(m[2]);
    if (!n) return 'bad';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start > end || start >= size) return 'bad';
  return { start, end };
}

/** Call before the app is ready. */
export function registerScheme(protocol) {
  protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);
}

const BASE = { 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': LOCKDOWN };
const reply = (status, headers = {}, body = null) => new Response(body, { status, headers: { ...BASE, ...headers } });
// The window is a file:// page (origin "null"); nothing else may read these files.
const fromWindow = (req) => ['null', 'file://'].includes(req.headers.get('origin') ?? 'null');

/** @param roots () => string[] — the folders whose files may be served, asked on every request. */
export function serveFiles(protocol, roots) {
  protocol.handle(SCHEME, async (req) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return reply(405);
    if (!fromWindow(req)) return reply(403);
    const cors = { 'Access-Control-Allow-Origin': req.headers.get('origin') ?? 'null', 'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Last-Modified', Vary: 'Origin' };
    const asked = pathFromUrl(req.url);
    const real = asked && allowedPath(asked, roots());
    if (!real) {
      const missing = asked && roots().some((r) => r && inside(path.resolve(r), asked)) && !fs.existsSync(asked); // only ever looked for inside a root
      return reply(missing ? 404 : 403, { ...cors, 'Content-Type': 'text/plain' }, missing ? 'Not found' : 'Not allowed');
    }
    let stat;
    try {
      stat = await fs.promises.stat(real);
    } catch {
      return reply(404, cors);
    }
    if (!stat.isFile()) return reply(404, cors);
    // HTML is shown as its source and never rendered.
    const type = kindOf(real) === 'html' ? 'text/plain; charset=utf-8' : mimeOf(real);
    const head = { ...cors, 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Last-Modified': stat.mtime.toUTCString(), 'Cache-Control': 'no-cache' };
    const range = parseRange(req.headers.get('range'), stat.size);
    if (range === 'bad') return reply(416, { ...cors, 'Content-Range': `bytes */${stat.size}` });
    const { start, end } = range || { start: 0, end: stat.size - 1 };
    const length = stat.size ? end - start + 1 : 0;
    const headers = { ...head, 'Content-Length': String(length), ...(range ? { 'Content-Range': `bytes ${start}-${end}/${stat.size}` } : {}) };
    if (req.method === 'HEAD' || !length) return reply(range ? 206 : 200, headers);
    const stream = Readable.toWeb(fs.createReadStream(real, { start, end }));
    return reply(range ? 206 : 200, headers, stream);
  });
}
