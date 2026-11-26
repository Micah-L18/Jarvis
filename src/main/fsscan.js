// Breadth-first scan of a folder tree for the 3D file map. Bounded by depth and node count
// so pointing it at a home directory stays fast; folders can be expanded on demand.
import fs from 'node:fs/promises';
import path from 'node:path';
import { kindOf } from './filekind.js';

const SKIP = new Set([
  'node_modules', 'Library', 'AppData', 'Application Data', '$RECYCLE.BIN', 'System Volume Information',
  '__pycache__', 'venv', '.venv', 'proc', 'sys', 'dev', 'snap', 'Applications', 'target', 'dist', 'build',
]);

export { kindOf };

// Children shown on the map, folders first, and how many files and folders were left out (dot files,
// SKIP): a folder with any left out is not wholly listed, so its size has to be measured. One that
// cannot be read at all (no permission) is marked so: nothing listed is not the same as nothing there.
async function readChildren(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    return { list: [], hidden: 0, unreadable: err.code !== 'ENOENT' };
  }
  let hidden = 0;
  const list = entries.filter((e) => {
    if (!e.isDirectory() && !e.isFile()) return false;
    if (e.name.startsWith('.') || SKIP.has(e.name)) { hidden++; return false; }
    return true;
  }).sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  return { list, hidden };
}

/** Sizes in bytes of the listed files, a few at a time (the stats run off the main thread). */
async function addBytes(files) {
  for (let i = 0; i < files.length; i += 48) {
    await Promise.all(files.slice(i, i + 48).map(async (node) => {
      try { node.bytes = (await fs.lstat(node.id)).size; } catch { node.bytes = 0; }
    }));
  }
}

/**
 * @returns {{root:string, nodes:Array<{id,name,parent,dir,kind,depth,more,hidden?,unreadable?,bytes?}>, truncated:boolean}}
 * `more` on a folder = number of children that were not included (depth or count limit); `hidden` =
 * files and folders inside it that the map never shows (dot files, SKIP); `unreadable`: it could not be listed. With `bytes`, files carry their size
 * (a stat each: the Files map wants it, a search through thousands of files does not).
 */
export async function scan(root, { maxDepth = 3, maxNodes = 3500, perDir = 60, baseDepth = 0, includeRoot = true, bytes = false } = {}) {
  root = path.resolve(root);
  const nodes = [];
  if (includeRoot) nodes.push({ id: root, name: path.basename(root) || root, parent: null, dir: true, kind: 'dir', depth: baseDepth, more: 0 });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  let queue = [{ dir: root, depth: baseDepth }];
  let truncated = false;
  const files = [];
  while (queue.length) {
    const next = [];
    for (const { dir, depth } of queue) {
      const { list: children, hidden, unreadable } = await readChildren(dir);
      const parent = byId.get(dir);
      if (parent && hidden) parent.hidden = hidden;
      if (parent && unreadable) parent.unreadable = true;
      if (depth - baseDepth >= maxDepth) {
        if (parent) parent.more = children.length;
        continue;
      }
      let taken = 0;
      for (const entry of children) {
        if (taken >= perDir || nodes.length >= maxNodes) break;
        const id = path.join(dir, entry.name);
        const isDir = entry.isDirectory();
        const node = { id, name: entry.name, parent: dir, dir: isDir, kind: isDir ? 'dir' : kindOf(entry.name), depth: depth + 1, more: 0 };
        nodes.push(node);
        byId.set(id, node);
        taken++;
        if (isDir) next.push({ dir: id, depth: depth + 1 });
        else files.push(node);
      }
      if (taken < children.length) {
        truncated = true;
        if (parent) parent.more = children.length - taken;
      }
    }
    queue = next;
  }
  if (bytes) await addBytes(files);
  return { root, nodes, truncated };
}

/** Children of one folder (used when the user clicks a folder to open it further). */
export async function expand(dir, depth, { maxNodes = 400 } = {}) {
  const result = await scan(dir, { maxDepth: 1, maxNodes, perDir: maxNodes, baseDepth: depth, includeRoot: false, bytes: true });
  return result.nodes;
}

export function isInside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
