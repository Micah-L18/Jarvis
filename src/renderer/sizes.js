// How big things are on the Files map: a marker grows with the bytes it stands for (a folder with
// everything inside it), on a log scale so a 1 GB file is a few times a 1 KB one, not a million.
// Pure functions, shared by the window and the tests.

const KB = 1024;
const LOG_FROM = Math.log2(KB); // at or under 1 KB a marker is its smallest
const LOG_SPAN = Math.log2(KB ** 3) - LOG_FROM; // 1 KB .. 1 GB
const GROW = 2.6; // 1 GB is 1 + GROW times the smallest
const BEYOND = 0.2; // past 1 GB it keeps growing, slowly, up to this much further along the scale (about 16 GB)

/** Marker scale for a size in bytes: 1 for 1 KB and under (zero-byte files too), 3.6 at 1 GB, at most about 4.1. */
export function sizeScale(bytes) {
  const b = Number(bytes) > 0 ? Number(bytes) : 0;
  if (b <= KB) return 1;
  const t = Math.min(1 + BEYOND, (Math.log2(b) - LOG_FROM) / LOG_SPAN);
  return 1 + GROW * t;
}

/** "0 bytes", "820 bytes", "14 KB", "2.4 MB", "1.2 GB". */
export function formatBytes(bytes) {
  const b = Math.max(0, Math.round(Number(bytes) || 0));
  if (b < KB) return `${b} byte${b === 1 ? '' : 's'}`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let v = b / KB, u = 0;
  while (v >= KB && u < units.length - 1) { v /= KB; u++; }
  return `${v < 10 ? (Math.round(v * 10) / 10).toString() : Math.round(v).toLocaleString('en-US')} ${units[u]}`;
}

/**
 * Totals for every folder on the map. Files carry `bytes` from the scan; a folder's total is what
 * the scan listed under it, unless a background walk has measured the whole folder (`walked`:
 * Map id -> {bytes, files, complete, exact}). A folder is exact when the walk finished with nothing
 * left out, or when the scan listed all of it (nothing more inside, nothing hidden, nothing unreadable,
 * every subfolder exact too); otherwise its total is a lower bound ("at least"). A finished walk that
 * counted less than the scan just listed is out of date, so the larger figure wins, as a lower bound.
 * @param nodes [{id, parent, dir, bytes?, more?, hidden?, unreadable?}]
 * @returns Map id -> {bytes, files, exact} for folders
 */
export function folderTotals(nodes, walked = new Map()) {
  const out = new Map();
  const kids = new Map();
  for (const n of nodes) {
    if (n.dir) out.set(n.id, { bytes: 0, files: 0, exact: !(n.more > 0) && !(n.hidden > 0) && !n.unreadable });
  }
  for (const n of nodes) {
    if (n.parent == null || !out.has(n.parent)) continue;
    if (!kids.has(n.parent)) kids.set(n.parent, []);
    kids.get(n.parent).push(n);
  }
  // deepest first, so each folder sums subfolders that are already done
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const depthOf = new Map();
  const depth = (n) => {
    if (depthOf.has(n.id)) return depthOf.get(n.id);
    let d = 0;
    for (let p = n.parent, guard = 0; p != null && out.has(p) && guard < 256; guard++) {
      d++;
      p = byId.get(p)?.parent;
    }
    depthOf.set(n.id, d);
    return d;
  };
  const dirs = nodes.filter((n) => n.dir).sort((a, b) => depth(b) - depth(a));
  for (const d of dirs) {
    const t = out.get(d.id);
    for (const k of kids.get(d.id) || []) {
      if (k.dir) {
        const s = out.get(k.id);
        t.bytes += s.bytes; t.files += s.files;
        if (!s.exact) t.exact = false;
      } else {
        t.bytes += Number(k.bytes) || 0; t.files += 1;
        if (k.bytes == null) t.exact = false;
      }
    }
    const w = walked.get(d.id);
    if (w?.complete) {
      const stale = w.bytes < t.bytes || w.files < t.files;
      Object.assign(t, { bytes: Math.max(t.bytes, w.bytes), files: Math.max(t.files, w.files), exact: w.exact !== false && !stale });
    } else if (w && !t.exact) { t.bytes = Math.max(t.bytes, w.bytes); t.files = Math.max(t.files, w.files); }
  }
  return out;
}

/** The size line for a card or a hover label: "2.4 MB", "1.2 GB · 3,410 files", "at least 1.2 GB · 3,410 files". */
export function sizeText(node, total) {
  if (!node.dir) return node.bytes == null ? '' : formatBytes(node.bytes);
  if (!total) return '';
  const files = `${total.files.toLocaleString('en-US')} file${total.files === 1 ? '' : 's'}`;
  return `${total.exact ? '' : 'at least '}${formatBytes(total.bytes)} · ${files}`;
}
