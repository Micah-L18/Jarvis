// Text out of the files people keep: PDFs, Word documents, spreadsheets, slides, web pages
// and plain text. Long documents come back in parts (pages, sheets, slides) so they can be
// read a piece at a time.
import fs from 'node:fs/promises';
import { kindOf, extOf, TEXTUAL, textEncoding, decodeText } from './filekind.js';

export function stripHtml(html) {
  return html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'")
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n[\s]*/g, '\n')
    .trim();
}

const decodeXml = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&amp;/g, '&');

async function pdfParts(buf) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: new Uint8Array(buf), isEvalSupported: false, useSystemFonts: false, verbosity: 0 });
  const doc = await task.promise;
  try {
    const parts = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const { items } = await page.getTextContent();
      parts.push(items.map((it) => (it.str || '') + (it.hasEOL ? '\n' : '')).join('').replace(/[ \t]+\n/g, '\n').trim());
      page.cleanup();
    }
    return parts;
  } finally {
    await task.destroy();
  }
}

// A document is a zip, and a zip can unpack to far more than it weighs: past these it is not read.
const ZIP_TOTAL = 512 * 1024 ** 2;
const ZIP_ENTRY = 128 * 1024 ** 2;
// What one workbook may come to as text, and the most columns a sheet can have (XFD).
const SHEET_TEXT = 4_000_000;
const MAX_COLUMNS = 16384;

async function zip(buf) {
  const { default: JSZip } = await import('jszip');
  const z = await JSZip.loadAsync(buf);
  let total = 0;
  for (const f of Object.values(z.files)) total += f._data?.uncompressedSize || 0;
  if (total > ZIP_TOTAL) throw new Error('That file unpacks to far more than its size; I will not read it.');
  return z;
}
/** One part of an unpacked document as text, or undefined if it is not there; refused if it unpacks too large. */
async function partText(z, name) {
  const f = z.file(name);
  if (!f) return undefined;
  if ((f._data?.uncompressedSize || 0) > ZIP_ENTRY) throw new Error('A part of that file is too large to read.');
  return f.async('string');
}

const byNumber = (re) => (a, b) => Number(re.exec(a)?.[1] || 0) - Number(re.exec(b)?.[1] || 0);

async function xlsxParts(buf) {
  const z = await zip(buf);
  const shared = [];
  const sst = await partText(z, 'xl/sharedStrings.xml');
  if (sst) {
    for (const si of sst.match(/<si>[\s\S]*?<\/si>/g) || []) {
      shared.push(decodeXml((si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || []).map((t) => t.replace(/<[^>]+>/g, '')).join('')));
    }
  }
  const book = (await partText(z, 'xl/workbook.xml')) || '';
  const names = [...book.matchAll(/<sheet\b[^>]*name="([^"]*)"/g)].map((m) => decodeXml(m[1]));
  const files = Object.keys(z.files).filter((f) => /^xl\/worksheets\/sheet\d+\.xml$/.test(f)).sort(byNumber(/sheet(\d+)\.xml/));
  const parts = [];
  let budget = SHEET_TEXT; // characters left for the whole workbook
  for (const [i, f] of files.entries()) {
    const title = `Sheet "${names[i] || `Sheet ${i + 1}`}"`;
    if (budget <= 0) {
      parts.push(`${title}\n(left out: the workbook is too large to read whole)`);
      continue;
    }
    const xml = await partText(z, f);
    const rows = [];
    for (const row of xml.match(/<row\b[\s\S]*?<\/row>/g) || []) {
      const cells = [];
      for (const c of row.match(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) || []) {
        const ref = /\br="([A-Z]{1,3})\d+"/.exec(c)?.[1];
        const col = ref ? [...ref].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1 : cells.length;
        if (col >= MAX_COLUMNS) continue; // no real sheet has a cell out there
        const type = /\bt="(\w+)"/.exec(c)?.[1];
        const v = /<v>([\s\S]*?)<\/v>/.exec(c)?.[1];
        const inline = /<is>([\s\S]*?)<\/is>/.exec(c)?.[1];
        let value = '';
        if (type === 's' && v !== undefined) value = shared[Number(v)] ?? '';
        else if (inline) value = decodeXml(inline.replace(/<[^>]+>/g, ''));
        else if (v !== undefined) value = decodeXml(v);
        while (cells.length < col) cells.push('');
        cells[col] = /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
      }
      const line = cells.join(',');
      budget -= line.length + 1;
      if (budget < 0) {
        rows.push('… (the rest is left out: the workbook is too large to read whole)');
        break;
      }
      rows.push(line);
    }
    parts.push(`${title}\n${rows.join('\n')}`);
  }
  return parts;
}

async function pptxParts(buf) {
  const z = await zip(buf);
  const files = Object.keys(z.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f)).sort(byNumber(/slide(\d+)\.xml/));
  const parts = [];
  for (const f of files) {
    const xml = await partText(z, f);
    const paras = (xml.match(/<a:p>[\s\S]*?<\/a:p>/g) || [])
      .map((p) => decodeXml((p.match(/<a:t>([\s\S]*?)<\/a:t>/g) || []).map((t) => t.replace(/<[^>]+>/g, '')).join('')))
      .filter(Boolean);
    parts.push(paras.join('\n'));
  }
  return parts;
}

async function docxText(buf) {
  // mammoth unpacks the whole file itself, so the size checks run first.
  const z = await zip(buf);
  for (const f of Object.values(z.files)) {
    if ((f._data?.uncompressedSize || 0) > ZIP_ENTRY) throw new Error('A part of that file is too large to read.');
  }
  const { default: mammoth } = await import('mammoth');
  const { value } = await mammoth.extractRawText({ buffer: buf });
  return value.replace(/\n{3,}/g, '\n\n').trim();
}

/** What a part of a document is called, for "page 3 of 12". */
export const PART_NAME = { pdf: 'page', xlsx: 'sheet', pptx: 'slide' };

/**
 * @returns {Promise<{text:string, parts?:string[], partName?:string} | {unreadable:string}>}
 * `parts` is set for paged formats; `text` is always the whole text.
 */
export async function extractText(file) {
  const kind = kindOf(file);
  const ext = extOf(file);
  const buf = await fs.readFile(file);
  let parts;
  if (kind === 'pdf') parts = await pdfParts(buf);
  else if (ext === 'xlsx') parts = await xlsxParts(buf);
  else if (ext === 'pptx') parts = await pptxParts(buf);
  else if (ext === 'docx') return { text: await docxText(buf) };
  else if (kind === 'office') return { unreadable: `I can read .docx, .xlsx and .pptx, but not the older .${ext} format. Save it in the newer format and I can.` };
  else if (kind === 'html') return { text: stripHtml(decodeText(buf) ?? buf.toString('utf8')) };
  else if (TEXTUAL.has(kind)) return { text: decodeText(buf) ?? buf.toString('utf8') }; // UTF-8, or UTF-16 by its mark or its NULs
  else if (kind === 'other' && decodeText(buf.subarray(0, 4000), { sniff: false }) != null) return { text: decodeText(buf, { sniff: false }) ?? buf.toString('utf8') };
  else return { unreadable: `That is ${kind === 'other' ? 'a binary file' : `a${/^[aeiou]/.test(kind) ? 'n' : ''} ${kind} file`}, not text.` };
  const partName = PART_NAME[ext] || PART_NAME[kind];
  const text = parts.map((p, i) => `[${partName} ${i + 1}]\n${p}`).join('\n\n');
  return { text, parts, partName };
}

/** Plain text bigger than this is read a window at a time (readTextWindow), never whole. */
export const BIG_TEXT = 8 * 1024 ** 2;
/** Files whose bytes are their text (no markup to strip, no format to unpack), so a window of them can be read. */
export const isPlainText = (file) => {
  const kind = kindOf(file);
  return kind === 'other' || (TEXTUAL.has(kind) && kind !== 'html');
};

/**
 * Up to `maxChars` characters of a plain-text file from byte `from` on, reading only those bytes.
 * @returns {Promise<{text, start, end, size, encoding} | {binary: true, size}>} — `start` and `end` are
 *   byte offsets (end is where the next window starts), so a long log can be read page by page.
 */
export async function readTextWindow(file, from, maxChars) {
  const fh = await fs.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const head = Buffer.alloc(Math.min(size, 8192));
    await fh.read(head, 0, head.length, 0);
    const mayBeBinary = kindOf(file) === 'other';
    const encoding = textEncoding(head, { sniff: !mayBeBinary });
    if (mayBeBinary && encoding === 'utf-8' && head.subarray(0, 4000).includes(0)) return { binary: true, size };
    const unit = encoding === 'utf-8' ? 1 : 2;
    const bom = encoding === 'utf-8' ? (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf ? 3 : 0) : (head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff) ? 2 : 0;
    let start = Math.max(bom, Math.min(Math.floor(Number(from) || 0), size));
    if (unit === 2) start -= (start - bom) % 2;
    const want = Math.min(size - start, maxChars * (unit === 1 ? 4 : 2));
    const buf = Buffer.alloc(Math.max(0, want));
    const { bytesRead } = await fh.read(buf, 0, buf.length, start);
    let b = buf.subarray(0, bytesRead);
    if (unit === 1) { // landed inside a character: start at the next one
      let skip = 0;
      while (skip < 3 && skip < b.length && (b[skip] & 0xc0) === 0x80) skip++;
      b = b.subarray(skip);
      start += skip;
    }
    let text = new TextDecoder(encoding, { ignoreBOM: true }).decode(b, { stream: true }); // an unfinished last character is left for the next window
    if (text.length > maxChars) text = text.slice(0, /[\uD800-\uDBFF]/.test(text[maxChars - 1]) ? maxChars - 1 : maxChars);
    const used = Math.min(b.length, unit === 1 ? Buffer.byteLength(text, 'utf8') : text.length * 2);
    return { text, start, end: start + used, size, encoding };
  } finally {
    await fh.close();
  }
}

/** Kinds extractText can get words out of. */
export const canExtract = (file) => {
  const kind = kindOf(file);
  return TEXTUAL.has(kind) || kind === 'pdf' || ['docx', 'xlsx', 'pptx'].includes(extOf(file));
};

const MAX_SIDE = 1568; // the long side the vision models work at; bigger only costs time
const PASS_AS_IS = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

/**
 * An image ready to hand to a model: {mediaType, data (base64), width, height, scaled}.
 * Small PNG/JPEG/GIF/WebP files go as they are; anything larger or in another format
 * (SVG, BMP, AVIF…) is redrawn as a JPEG no bigger than MAX_SIDE on its long side.
 */
export async function loadImage(file, { maxSide = MAX_SIDE, maxBytes = 1_000_000 } = {}) {
  const buf = await fs.readFile(file);
  const { default: sharp } = await import('sharp');
  const meta = await sharp(buf, { animated: false }).metadata();
  const width = meta.width || 0;
  const height = meta.height || 0;
  const asIs = PASS_AS_IS[extOf(file)];
  if (asIs && Math.max(width, height) <= maxSide && buf.length <= maxBytes) {
    return { mediaType: asIs, data: buf.toString('base64'), width, height, scaled: false };
  }
  const out = await sharp(buf, { animated: false, density: meta.format === 'svg' ? 144 : undefined })
    .rotate()
    .resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: meta.format !== 'svg' })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 85 })
    .toBuffer({ resolveWithObject: true });
  return { mediaType: 'image/jpeg', data: out.data.toString('base64'), width, height, scaled: true, sentWidth: out.info.width, sentHeight: out.info.height };
}

/** Dimensions from the file's header alone ({width: 0, height: 0} when it cannot tell). */
export async function imageSize(file) {
  const fh = await fs.open(file, 'r');
  try {
    const buf = Buffer.alloc(256 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return sizeFromHeader(buf.subarray(0, bytesRead));
  } finally {
    await fh.close();
  }
}

export function sizeFromHeader(b) {
  const none = { width: 0, height: 0 };
  const ascii = (at, n) => b.toString('latin1', at, at + n);
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), format: 'png' };
  if (b.length >= 10 && ascii(0, 3) === 'GIF') return { width: b.readUInt16LE(6), height: b.readUInt16LE(8), format: 'gif' };
  if (b.length >= 26 && ascii(0, 2) === 'BM') return { width: b.readInt32LE(18), height: Math.abs(b.readInt32LE(22)), format: 'bmp' };
  if (b.length >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    const chunk = ascii(12, 4);
    if (chunk === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff, format: 'webp' };
    if (chunk === 'VP8L') { const v = b.readUInt32LE(21); return { width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1, format: 'webp' }; }
    if (chunk === 'VP8X') return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1, format: 'webp' };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xff) return none;
      const marker = b[i + 1];
      if (marker === 0xff) { i++; continue; }
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5), format: 'jpeg' };
      i += 2 + b.readUInt16BE(i + 2);
    }
    return none;
  }
  const text = ascii(0, Math.min(b.length, 4096));
  const svg = /<svg\b[^>]*>/i.exec(text)?.[0];
  if (svg) {
    const attr = (name) => Number.parseFloat((new RegExp(`\\s${name}\\s*=\\s*["']([\\d.]+)(px)?["']`, 'i').exec(svg) || [])[1]);
    const box = /viewBox\s*=\s*["'][\d.\s,-]*?([\d.]+)[\s,]+([\d.]+)\s*["']/i.exec(svg);
    const width = attr('width') || Number(box?.[1]) || 0;
    const height = attr('height') || Number(box?.[2]) || 0;
    return { width: Math.round(width), height: Math.round(height), format: 'svg' };
  }
  return none;
}

/** A line about a 3D model file: its format and, where cheap, what is in it. */
export async function describeModel(file, size) {
  const ext = extOf(file);
  const fmt = { glb: 'binary glTF', gltf: 'glTF', obj: 'Wavefront OBJ', stl: 'STL', fbx: 'FBX', ply: 'PLY', '3mf': '3MF', dae: 'COLLADA' }[ext] || ext;
  try {
    let json;
    if (ext === 'gltf' && size < 20e6) json = JSON.parse(await fs.readFile(file, 'utf8'));
    if (ext === 'glb') {
      const fh = await fs.open(file);
      try {
        const head = Buffer.alloc(20);
        await fh.read(head, 0, 20, 0);
        const len = head.readUInt32LE(12);
        if (head.toString('ascii', 0, 4) === 'glTF' && head.readUInt32LE(16) === 0x4e4f534a && len < 20e6) {
          const chunk = Buffer.alloc(len);
          await fh.read(chunk, 0, len, 20);
          json = JSON.parse(chunk.toString('utf8'));
        }
      } finally {
        await fh.close();
      }
    }
    if (json) {
      const n = (k) => (json[k] || []).length;
      return `${fmt} model: ${n('meshes')} meshes, ${n('materials')} materials, ${n('animations')} animations${json.asset?.generator ? `, made with ${json.asset.generator}` : ''}`;
    }
    if (ext === 'stl' && size > 84) {
      const fh = await fs.open(file);
      try {
        const head = Buffer.alloc(84);
        await fh.read(head, 0, 84, 0);
        const tris = head.readUInt32LE(80);
        if (84 + tris * 50 === size) return `${fmt} model (binary): ${tris.toLocaleString('en-GB')} triangles`;
      } finally {
        await fh.close();
      }
    }
    if (ext === 'obj' && size < 50e6) {
      const text = await fs.readFile(file, 'utf8');
      const count = (re) => (text.match(re) || []).length;
      return `${fmt} model: ${count(/^v\s/gm).toLocaleString('en-GB')} vertices, ${count(/^f\s/gm).toLocaleString('en-GB')} faces`;
    }
  } catch {
    /* only a description; the format alone will do */
  }
  return `${fmt} model`;
}
