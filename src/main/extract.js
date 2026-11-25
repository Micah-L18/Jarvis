// Text out of the files people keep: PDFs, Word documents, spreadsheets, slides, web pages
// and plain text. Long documents come back in parts (pages, sheets, slides) so they can be
// read a piece at a time.
import fs from 'node:fs/promises';
import { kindOf, extOf, TEXTUAL } from './filekind.js';

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

async function zip(buf) {
  const { default: JSZip } = await import('jszip');
  return JSZip.loadAsync(buf);
}

const byNumber = (re) => (a, b) => Number(re.exec(a)?.[1] || 0) - Number(re.exec(b)?.[1] || 0);

async function xlsxParts(buf) {
  const z = await zip(buf);
  const shared = [];
  const sst = await z.file('xl/sharedStrings.xml')?.async('string');
  if (sst) {
    for (const si of sst.match(/<si>[\s\S]*?<\/si>/g) || []) {
      shared.push(decodeXml((si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || []).map((t) => t.replace(/<[^>]+>/g, '')).join('')));
    }
  }
  const book = (await z.file('xl/workbook.xml')?.async('string')) || '';
  const names = [...book.matchAll(/<sheet\b[^>]*name="([^"]*)"/g)].map((m) => decodeXml(m[1]));
  const files = Object.keys(z.files).filter((f) => /^xl\/worksheets\/sheet\d+\.xml$/.test(f)).sort(byNumber(/sheet(\d+)\.xml/));
  const parts = [];
  for (const [i, f] of files.entries()) {
    const xml = await z.file(f).async('string');
    const rows = [];
    for (const row of xml.match(/<row\b[\s\S]*?<\/row>/g) || []) {
      const cells = [];
      for (const c of row.match(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) || []) {
        const ref = /\br="([A-Z]+)\d+"/.exec(c)?.[1];
        const col = ref ? [...ref].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1 : cells.length;
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
      rows.push(cells.join(','));
    }
    parts.push(`Sheet "${names[i] || `Sheet ${i + 1}`}"\n${rows.join('\n')}`);
  }
  return parts;
}

async function pptxParts(buf) {
  const z = await zip(buf);
  const files = Object.keys(z.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f)).sort(byNumber(/slide(\d+)\.xml/));
  const parts = [];
  for (const f of files) {
    const xml = await z.file(f).async('string');
    const paras = (xml.match(/<a:p>[\s\S]*?<\/a:p>/g) || [])
      .map((p) => decodeXml((p.match(/<a:t>([\s\S]*?)<\/a:t>/g) || []).map((t) => t.replace(/<[^>]+>/g, '')).join('')))
      .filter(Boolean);
    parts.push(paras.join('\n'));
  }
  return parts;
}

async function docxText(buf) {
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
  else if (kind === 'html') return { text: stripHtml(buf.toString('utf8')) };
  else if (TEXTUAL.has(kind) || (kind === 'other' && !buf.subarray(0, 4000).includes(0))) return { text: buf.toString('utf8') };
  else return { unreadable: `That is ${kind === 'other' ? 'a binary file' : `a${/^[aeiou]/.test(kind) ? 'n' : ''} ${kind} file`}, not text.` };
  const partName = PART_NAME[ext] || PART_NAME[kind];
  const text = parts.map((p, i) => `[${partName} ${i + 1}]\n${p}`).join('\n\n');
  return { text, parts, partName };
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

/** Dimensions without decoding the whole image. */
export async function imageSize(file) {
  const { default: sharp } = await import('sharp');
  const meta = await sharp(file).metadata();
  return { width: meta.width || 0, height: meta.height || 0, format: meta.format };
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
