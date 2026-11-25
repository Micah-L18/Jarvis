// Pure helpers for the file viewer (no DOM), so they can be tested on their own.

export const fileUrl = (absPath) => `jarvis-file://local/${encodeURIComponent(absPath)}`;

export const nameOf = (p) => String(p).split(/[\\/]/).pop();
export const dirOf = (p) => p.slice(0, Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1);

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

export const middle = (text, max = 96) => (text.length <= max ? text : `${text.slice(0, 32)}…${text.slice(text.length - (max - 33))}`);

/** Bytes that are not text: NULs, or many control characters, in the first few KB. */
export function looksBinary(bytes) {
  const n = Math.min(bytes.length, 8192);
  let odd = 0;
  for (let i = 0; i < n; i++) {
    const b = bytes[i];
    if (b === 0) return true;
    if (b < 32 && b !== 9 && b !== 10 && b !== 13 && b !== 12 && b !== 27) odd++;
  }
  return n > 0 && odd / n > 0.1;
}

/** A small CSV/TSV reader (quotes, doubled quotes, newlines inside quotes). Stops after `maxRows`. */
export function parseCsv(text, delimiter, maxRows = Infinity) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === delimiter) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      if (rows.length >= maxRows) return rows;
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/** A path relative to `dir` (with ./ and ../), as an absolute path; null if it climbs above the root. */
export function resolveLocal(dir, ref) {
  let rel;
  try { rel = decodeURIComponent(ref.split(/[?#]/)[0]); } catch { return null; }
  if (!rel) return null;
  const win = /^[a-z]:[\\/]/i.test(dir);
  const sep = win ? '\\' : '/';
  const absolute = rel.startsWith('/') || /^[a-z]:[\\/]/i.test(rel);
  const parts = (absolute ? rel : dir + rel).split(/[\\/]+/);
  const out = [];
  for (const p of parts) {
    if (p === '.' || (p === '' && out.length)) continue;
    if (p === '..') { if (out.length <= 1) return null; out.pop(); } else out.push(p);
  }
  return out.join(sep) || null;
}
