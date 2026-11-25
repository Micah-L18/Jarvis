// Breadth-first scan of a folder tree for the 3D file map. Bounded by depth and node count
// so pointing it at a home directory stays fast; folders can be expanded on demand.
import fs from 'node:fs/promises';
import path from 'node:path';

const SKIP = new Set([
  'node_modules', 'Library', 'AppData', 'Application Data', '$RECYCLE.BIN', 'System Volume Information',
  '__pycache__', 'venv', '.venv', 'proc', 'sys', 'dev', 'snap', 'Applications', 'target', 'dist', 'build',
]);

const KINDS = {
  code: ['js', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'cs', 'php', 'swift', 'kt', 'sh', 'html', 'css', 'json', 'yaml', 'yml', 'toml', 'sql'],
  doc: ['md', 'txt', 'pdf', 'doc', 'docx', 'rtf', 'pages', 'odt', 'tex'],
  data: ['csv', 'xls', 'xlsx', 'numbers', 'db', 'sqlite', 'parquet', 'xml'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'heic', 'bmp', 'psd', 'ai'],
  media: ['mp3', 'wav', 'flac', 'm4a', 'mp4', 'mov', 'mkv', 'avi', 'webm'],
  archive: ['zip', 'tar', 'gz', 'rar', '7z', 'dmg', 'iso'],
  slides: ['ppt', 'pptx', 'key'],
};
const KIND_OF = new Map(Object.entries(KINDS).flatMap(([kind, exts]) => exts.map((e) => [e, kind])));

export function kindOf(name) {
  const ext = path.extname(name).slice(1).toLowerCase();
  return KIND_OF.get(ext) || 'other';
}

async function readChildren(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => !e.name.startsWith('.') && !SKIP.has(e.name) && (e.isDirectory() || e.isFile()))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
}

/**
 * @returns {{root:string, nodes:Array<{id,name,parent,dir,kind,depth,more}>, truncated:boolean}}
 * `more` on a folder = number of children that were not included (depth or count limit).
 */
export async function scan(root, { maxDepth = 3, maxNodes = 3500, perDir = 60, baseDepth = 0, includeRoot = true } = {}) {
  root = path.resolve(root);
  const nodes = [];
  if (includeRoot) nodes.push({ id: root, name: path.basename(root) || root, parent: null, dir: true, kind: 'dir', depth: baseDepth, more: 0 });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  let queue = [{ dir: root, depth: baseDepth }];
  let truncated = false;
  while (queue.length) {
    const next = [];
    for (const { dir, depth } of queue) {
      const children = await readChildren(dir);
      const parent = byId.get(dir);
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
      }
      if (taken < children.length) {
        truncated = true;
        if (parent) parent.more = children.length - taken;
      }
    }
    queue = next;
  }
  return { root, nodes, truncated };
}

/** Children of one folder (used when the user clicks a folder to open it further). */
export async function expand(dir, depth, { maxNodes = 400 } = {}) {
  const result = await scan(dir, { maxDepth: 1, maxNodes, perDir: maxNodes, baseDepth: depth, includeRoot: false });
  return result.nodes;
}

export function isInside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
