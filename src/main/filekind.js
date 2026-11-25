// What kind of file a path is, from its extension. Plain ESM with no Node
// imports so the renderer can bundle it too.

const KINDS = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'ico'],
  svg: ['svg'],
  model: ['glb', 'gltf', 'obj', 'stl', 'fbx', 'ply', '3mf', 'dae'],
  pdf: ['pdf'],
  markdown: ['md', 'markdown', 'mdx'],
  code: [
    'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift',
    'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'sh', 'bash', 'zsh', 'ps1', 'lua', 'sql',
    'css', 'scss', 'less', 'vue', 'svelte', 'yaml', 'yml', 'toml', 'ini', 'xml', 'glsl', 'r',
  ],
  text: ['txt', 'log', 'rtf', 'srt', 'vtt', 'conf', 'cfg', 'env', 'text'],
  csv: ['csv', 'tsv'],
  json: ['json', 'jsonl', 'geojson'],
  audio: ['mp3', 'wav', 'ogg', 'oga', 'flac', 'm4a', 'aac', 'opus', 'weba'],
  video: ['mp4', 'webm', 'mov', 'mkv', 'm4v', 'ogv', 'avi'],
  office: ['docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'odt', 'ods', 'odp'],
  html: ['html', 'htm', 'xhtml'],
};

const BY_EXT = new Map();
for (const [kind, exts] of Object.entries(KINDS)) for (const e of exts) BY_EXT.set(e, kind);

const BARE = new Set(['readme', 'license', 'licence', 'changelog', 'makefile', 'dockerfile', 'authors', 'notice']);

export function extOf(p) {
  const name = String(p || '').split(/[\\/]/).pop();
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export function kindOf(p) {
  const ext = extOf(p);
  if (ext) return BY_EXT.get(ext) || 'other';
  const name = String(p || '').split(/[\\/]/).pop().toLowerCase();
  return BARE.has(name) ? 'text' : 'other';
}

// Kinds whose bytes are readable as text.
export const TEXTUAL = new Set(['markdown', 'code', 'text', 'csv', 'json', 'html', 'svg']);

export const isTextual = (p) => TEXTUAL.has(kindOf(p));
export const isMedia = (p) => ['audio', 'video'].includes(kindOf(p));

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', avif: 'image/avif', ico: 'image/x-icon', svg: 'image/svg+xml',
  pdf: 'application/pdf', json: 'application/json', html: 'text/html', htm: 'text/html',
  css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', md: 'text/markdown',
  csv: 'text/csv', txt: 'text/plain', xml: 'application/xml',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', flac: 'audio/flac',
  m4a: 'audio/mp4', aac: 'audio/aac', opus: 'audio/ogg', weba: 'audio/webm',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska',
  m4v: 'video/mp4', ogv: 'video/ogg',
  glb: 'model/gltf-binary', gltf: 'model/gltf+json', obj: 'model/obj', stl: 'model/stl',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

export function mimeOf(p) {
  const ext = extOf(p);
  if (MIME[ext]) return MIME[ext];
  return TEXTUAL.has(kindOf(p)) ? 'text/plain' : 'application/octet-stream';
}
