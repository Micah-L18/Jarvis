// Built-in tools. Each is {name, description, schema, run(input) -> string}; providers
// translate this neutral shape into their own tool format.
import fs from 'node:fs/promises';
import path from 'node:path';
import { scan, isInside } from './fsscan.js';
import { NODE_TYPES } from './memory.js';
import { kindOf } from './filekind.js';
import { extractText, canExtract, loadImage, imageSize, describeModel, stripHtml } from './extract.js';

const str = (description) => ({ type: 'string', description });
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

const TEXT_CAP = 40000;

/** A tool's result as text plus any images. run() returns a string, or {text, images:[{mediaType, data}]} to show the model a picture. */
export function toolResult(out) {
  if (out && typeof out === 'object' && !Array.isArray(out)) return { text: String(out.text ?? ''), images: Array.isArray(out.images) ? out.images : [] };
  return { text: String(out), images: [] };
}

export const bytes = (n) => (n < 1024 ? `${n} bytes` : n < 1024 ** 2 ? `${Math.round(n / 1024)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(1)} GB`);
export function duration(sec) {
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h) return `${h} hour${h > 1 ? 's' : ''}${m ? ` ${m} minute${m > 1 ? 's' : ''}` : ''}`;
  if (m) return `${m} minute${m > 1 ? 's' : ''}${s && m < 5 ? ` ${s} seconds` : ''}`;
  return `${s} seconds`;
}
const stamp = (sec) => {
  const t = Math.max(0, Math.floor(sec));
  const hh = Math.floor(t / 3600);
  const mm = String(Math.floor((t % 3600) / 60)).padStart(hh ? 2 : 1, '0');
  return `${hh ? `${hh}:` : ''}${mm}:${String(t % 60).padStart(2, '0')}`;
};

// Reading a long PDF a page at a time should not mean extracting it again for every page.
const extracted = new Map();
async function textOf(file, stat) {
  const key = `${file}|${stat.size}|${stat.mtimeMs}`;
  if (!extracted.has(key)) {
    extracted.set(key, extractText(file));
    while (extracted.size > 6) extracted.delete(extracted.keys().next().value);
  }
  try {
    return await extracted.get(key);
  } catch (err) {
    extracted.delete(key);
    throw err;
  }
}

/** A long transcript in paragraphs, each led by the time it starts. */
export function transcriptText(chunks, fallback = '') {
  if (!chunks?.length) return fallback.trim();
  const paras = [];
  let cur = null;
  for (const c of chunks) {
    const text = String(c.text || '').trim();
    if (!text) continue;
    const at = c.timestamp?.[0] ?? 0;
    if (!cur || at - cur.at >= 30) {
      cur = { at, parts: [] };
      paras.push(cur);
    }
    cur.parts.push(text);
  }
  return paras.map((p) => `[${stamp(p.at)}] ${p.parts.join(' ')}`).join('\n\n');
}

/** Minimal check of a tool input against its JSON schema: required keys and primitive types. */
export function validateInput(schema, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'input must be an object';
  for (const key of schema?.required || []) if (input[key] === undefined || input[key] === null) return `missing required field "${key}"`;
  for (const [key, value] of Object.entries(input)) {
    const spec = schema?.properties?.[key];
    if (!spec?.type) continue;
    const actual = Array.isArray(value) ? 'array' : typeof value;
    const ok = spec.type === actual || (spec.type === 'integer' && actual === 'number');
    if (!ok) return `field "${key}" should be ${spec.type}, got ${actual}`;
  }
  return null;
}

/**
 * @param ctx {memory, skills, settings, ui(event), fsRoot(), openPath(p),
 *   media?: {probe(path) -> {duration}, decode(path, {signal}) -> Float32Array (16 kHz mono)},
 *   transcribe?(audio, {signal}) -> {text, chunks}, transcribeSpeed?() -> seconds of audio per second, signal?() -> AbortSignal}
 * @param opts {localWeb: boolean} — add client-side web tools (used when the model has no hosted search)
 */
export function builtinTools(ctx, { localWeb = false } = {}) {
  const { memory, skills } = ctx;
  const inRoot = (p) => {
    const root = ctx.fsRoot();
    const full = path.resolve(root, p || '.');
    if (!isInside(root, full) && !(memory.projectsDir && isInside(memory.projectsDir, full))) throw new Error(`That is outside the folder I am allowed to see (${root}).`);
    return full;
  };
  // A file to read or show: inside the root or Jarvis's own documents, also once links are followed.
  const fileIn = async (p) => {
    const full = inRoot(p);
    let real;
    try {
      real = await fs.realpath(full);
    } catch {
      throw new Error(`There is no file at ${full}.`);
    }
    const roots = await Promise.all([ctx.fsRoot(), memory.projectsDir].filter(Boolean).map((r) => fs.realpath(r).catch(() => path.resolve(r))));
    if (!roots.some((r) => isInside(r, real))) throw new Error(`That is outside the folder I am allowed to see (${ctx.fsRoot()}).`);
    const stat = await fs.stat(real);
    return { file: full, stat, kind: stat.isDirectory() ? 'folder' : kindOf(full), name: path.basename(full) };
  };
  const notFolder = (f) => {
    if (f.kind === 'folder') throw new Error(`${f.file} is a folder; use list_folder, or show_view files with it as the focus.`);
  };
  const saveTranscript = (f, text, what) => {
    const title = `${f.name} — transcript`;
    const res = memory.saveDocument(null, title, `# ${title}\n\n${what} of ${f.file}\n\n${text}\n`);
    ctx.ui({ type: 'document', title, file: res.file, project: res.project.label });
    ctx.ui({ type: 'viewer_text', path: f.file, title, text });
    return res;
  };
  const words = (text) => (text.match(/\S+/g) || []).length;

  const tools = [
    {
      name: 'remember',
      description: 'Store something in long-term memory (the mind map). Conversation is already recorded automatically in the background; call this only when the user explicitly asks you to remember something or when a fact is important enough that it must not be missed.',
      schema: obj({
        label: str('Short name for the thing, 1-5 words'),
        type: { type: 'string', enum: NODE_TYPES.filter((t) => t !== 'project' && t !== 'document') },
        summary: str('One sentence capturing what to remember'),
        project: str('Project name it belongs to. Omit for the active project.'),
        related_to: { type: 'array', items: { type: 'string' }, description: 'Labels of existing memories this connects to' },
      }, ['label', 'summary']),
      run: async ({ label, type, summary, project, related_to }) => {
        const node = memory.upsert({ label, type, summary, project, relatedTo: related_to || [] });
        return `Remembered "${node.label}".`;
      },
    },
    {
      name: 'recall',
      description: 'Search long-term memory for anything related to a query. Use when the memory summary in your instructions is not enough.',
      schema: obj({ query: str('Words to look for') }, ['query']),
      run: async ({ query }) => {
        const hits = memory.search(query);
        if (!hits.length) return 'Nothing in memory matches.';
        return hits.map((n) => {
          const links = memory.neighbors(n.id).filter((x) => x.node.type !== 'core').map((x) => x.node.label).slice(0, 6);
          return `[${n.type}] ${n.label}: ${n.summary || '(no detail)'}${links.length ? ` (linked to: ${links.join(', ')})` : ''}`;
        }).join('\n');
      },
    },
    {
      name: 'forget',
      description: 'Delete something from long-term memory when the user asks you to forget it. Forgetting a project removes everything in it.',
      schema: obj({ label: str('Label of the memory or project to delete') }, ['label']),
      run: async ({ label }) => {
        const res = memory.forget(label);
        return res ? `Forgot "${res.node.label}"${res.removed > 1 ? ` and ${res.removed - 1} things inside it` : ''}.` : `Nothing called "${label}" in memory.`;
      },
    },
    {
      name: 'create_project',
      description: 'Create a project (or switch to it if it exists) and make it the active one. A project groups related memories and documents — e.g. a team being coached, a research question, a trip being planned.',
      schema: obj({ name: str('Project name'), description: str('One sentence on what it is for') }, ['name']),
      run: async ({ name, description }) => {
        const p = memory.createProject(name, description);
        return `Project "${p.label}" is active.`;
      },
    },
    {
      name: 'switch_project',
      description: 'Make an existing project the active one.',
      schema: obj({ name: str('Project name') }, ['name']),
      run: async ({ name }) => {
        const p = memory.setActiveProject(name);
        return p ? `Switched to "${p.label}".` : `No project called "${name}". Existing: ${memory.projects().map((x) => x.label).join(', ')}`;
      },
    },
    {
      name: 'save_document',
      description: 'Write a markdown document into a project folder. Use for anything too long to say aloud: plans, research notes, datasets, drafts, summaries and transcripts. Saving with an existing title replaces that document.',
      schema: obj({
        title: str('Document title'),
        content: str('Full markdown content'),
        project: str('Project name. Omit for the active project.'),
        for_file: str('Path of the file this document summarizes or transcribes, if any. It is then shown beside that file in the viewer\'s Text tab.'),
      }, ['title', 'content']),
      run: async ({ title, content, project, for_file: forFile }) => {
        const res = memory.saveDocument(project, title, content);
        ctx.ui({ type: 'document', title, file: res.file, project: res.project.label });
        let shown = '';
        if (forFile) {
          const f = await fileIn(forFile).catch(() => null);
          if (f) {
            ctx.ui({ type: 'viewer_text', path: f.file, title, text: content });
            shown = ' It is in the viewer\'s Text tab beside that file.';
          }
        }
        return `Saved "${title}" in project "${res.project.label}" at ${res.file}.${shown}${shown ? '' : ' You can offer to show it in the app (show_file).'}`;
      },
    },
    {
      name: 'read_document',
      description: 'Read back a document previously saved in a project.',
      schema: obj({ title: str('Document title'), project: str('Project name. Omit to look across all projects.') }, ['title']),
      run: async ({ title, project }) => {
        const res = memory.readDocument(project, title);
        return res ? res.content : `No document called "${title}".`;
      },
    },
    {
      name: 'open_document',
      description: 'Put a saved project document on screen in the app\'s viewer so the user can read it. Set outside to true only when they want it in another app.',
      schema: obj({ title: str('Document title'), project: str('Project name. Omit to look across all projects.'), outside: { type: 'boolean', description: 'Open in the default app instead of the viewer' } }, ['title']),
      run: async ({ title, project, outside }) => {
        const res = memory.readDocument(project, title);
        if (!res) return `No document called "${title}".`;
        if (outside) {
          await ctx.openPath(res.doc.file);
          return `Opened "${res.doc.label}" in its default app.`;
        }
        ctx.ui({ type: 'show_file', path: res.doc.file });
        return `"${res.doc.label}" is on screen in the viewer.`;
      },
    },
    {
      name: 'load_skill',
      description: 'Load the full instructions of one of your skills. Do this before starting work that a skill covers.',
      schema: obj({ name: str('Skill name as listed in your instructions') }, ['name']),
      run: async ({ name }) => {
        const skill = skills.get(name);
        if (!skill || ctx.settings.get().disabledSkills.includes(skill.id)) return `No enabled skill called "${name}".`;
        return skill.body;
      },
    },
    {
      name: 'show_view',
      description: 'Change what is on screen: "core" (just you), "mind" (the 3D map of what you know), or "files" (the 3D map of the user\'s folders). Optionally fly to one item by name.',
      schema: obj({ view: { type: 'string', enum: ['core', 'mind', 'files'] }, focus: str('Name of a memory, project, file or folder to fly to') }, ['view']),
      run: async ({ view, focus }) => {
        ctx.ui({ type: 'view', view, focus });
        return `Showing ${view}${focus ? `, focused on ${focus}` : ''}.`;
      },
    },
    {
      name: 'list_folder',
      description: 'List the files and folders inside a folder on the user\'s computer. Paths are relative to their root folder unless absolute.',
      schema: obj({ path: str('Folder path. Omit for the root folder.') }),
      run: async ({ path: p }) => {
        const dir = inRoot(p);
        const { nodes } = await scan(dir, { maxDepth: 1, maxNodes: 200, perDir: 200, includeRoot: false });
        if (!nodes.length) return `${dir} is empty or unreadable.`;
        return `${dir}\n${nodes.map((n) => `${n.dir ? '[folder]' : '        '} ${n.name}`).join('\n')}`;
      },
    },
    {
      name: 'find_files',
      description: 'Find files or folders on the user\'s computer whose name contains some text.',
      schema: obj({ name: str('Part of the file or folder name'), path: str('Folder to search under. Omit for the root folder.') }, ['name']),
      run: async ({ name, path: p }) => {
        const { nodes } = await scan(inRoot(p), { maxDepth: 7, maxNodes: 40000, perDir: 2000 });
        const want = name.toLowerCase();
        const hits = nodes.filter((n) => n.name.toLowerCase().includes(want)).slice(0, 40);
        return hits.length ? hits.map((n) => `${n.dir ? '[folder] ' : ''}${n.id}`).join('\n') : `Nothing matching "${name}".`;
      },
    },
    {
      name: 'show_file',
      description: 'Put a file on screen in the app\'s viewer: images, 3D models, PDFs, documents, text and code, spreadsheets, audio and video. Use this whenever the user asks to see, open, pull up or look at a file, or asks about a specific file. Returns what kind of file it is and, for text, how it begins.',
      schema: obj({ path: str('File path') }, ['path']),
      run: async ({ path: p }) => {
        const f = await fileIn(p);
        notFolder(f);
        ctx.ui({ type: 'show_file', path: f.file });
        const lines = [`On screen: ${f.name} (${f.kind}, ${bytes(f.stat.size)}) at ${f.file}.`];
        try {
          if (f.kind === 'image' || f.kind === 'svg') {
            const { width, height } = await imageSize(f.file);
            if (width) lines.push(`${width} by ${height} pixels.`);
            lines.push('To see what is in it, use read_file.');
          } else if (f.kind === 'model') {
            lines.push(`${await describeModel(f.file, f.stat.size)}. It is shown as a turntable they can spin.`);
          } else if ((f.kind === 'audio' || f.kind === 'video') && ctx.media) {
            const { duration: d } = await Promise.race([ctx.media.probe(f.file), new Promise((r) => setTimeout(() => r({}), 4000))]);
            if (d) lines.push(`${f.kind === 'video' ? 'Video' : 'Recording'}, ${duration(d)} long. transcribe_media gets the words.`);
          } else if (canExtract(f.file) && f.stat.size < 60e6) {
            const doc = await textOf(f.file, f.stat);
            if (doc.parts) lines.push(`${doc.parts.length} ${doc.partName}${doc.parts.length === 1 ? '' : 's'}.`);
            const text = (doc.parts ? doc.parts.join('\n\n') : doc.text).trim();
            lines.push(text ? `It begins:\n${text.slice(0, 2000)}${text.length > 2000 ? `\n… (${text.length.toLocaleString('en-GB')} characters in all; read_file for more)` : ''}` : 'There is no text in it that I can extract (a scanned document, perhaps).');
          }
        } catch {
          /* the description is a bonus; the file is on screen either way */
        }
        return lines.join('\n');
      },
    },
    {
      name: 'read_file',
      description: 'Read a file from the user\'s computer or a saved document: plain text and code, PDFs, Word (.docx), spreadsheets (.xlsx, .csv), slides (.pptx) and web pages come back as text, 40,000 characters at a time (use page or offset for the rest). Images come back as the picture itself, so you can see them.',
      schema: obj({
        path: str('File path'),
        page: { type: 'integer', description: 'For PDFs, slides and spreadsheets: read only this page, slide or sheet (from 1)' },
        offset: { type: 'integer', description: 'Character to start from, to continue a long text' },
      }, ['path']),
      run: async ({ path: p, page, offset = 0 }) => {
        const f = await fileIn(p);
        if (f.kind === 'folder') throw new Error('That is a folder; use list_folder.');
        if (f.kind === 'image' || f.kind === 'svg') {
          const img = await loadImage(f.file);
          const note = `${f.file}: ${f.kind === 'svg' ? 'SVG drawing' : 'image'}, ${img.width} by ${img.height} pixels, ${bytes(f.stat.size)}${img.scaled && img.sentWidth !== img.width ? ` (shown to you at ${img.sentWidth} by ${img.sentHeight})` : ''}.`;
          let source = '';
          if (f.kind === 'svg') {
            const svg = await fs.readFile(f.file, 'utf8');
            source = `\nSVG source${svg.length > 4000 ? ' (start)' : ''}:\n${svg.slice(0, 4000)}`;
          }
          return { text: note + source, images: [{ mediaType: img.mediaType, data: img.data }] };
        }
        if (f.kind === 'audio' || f.kind === 'video') return `${f.file} is a ${f.kind === 'video' ? 'video' : 'recording'} (${bytes(f.stat.size)}). Use transcribe_media to get the words.`;
        if (f.kind === 'model') return `${f.file}: ${await describeModel(f.file, f.stat.size)}, ${bytes(f.stat.size)}. Its geometry is not readable as text; show_file puts it on screen.`;
        const doc = await textOf(f.file, f.stat);
        if (doc.unreadable) return `${f.file}: ${doc.unreadable}`;
        let text = doc.text;
        let what = `${f.file} (${f.kind}${doc.parts ? `, ${doc.parts.length} ${doc.partName}${doc.parts.length === 1 ? '' : 's'}` : ''})`;
        if (page && doc.parts) {
          if (page < 1 || page > doc.parts.length) return `${what} has no ${doc.partName} ${page}.`;
          text = doc.parts[page - 1];
          what += `, ${doc.partName} ${page}`;
        }
        if (!text.trim()) return `${what}: no text in it that I can extract${f.kind === 'pdf' ? ' — it is probably scanned images of pages' : ''}.`;
        const from = Math.max(0, Math.min(offset, text.length));
        const slice = text.slice(from, from + TEXT_CAP);
        const to = from + slice.length;
        const more = to < text.length
          ? `\n… (characters ${from.toLocaleString('en-GB')} to ${to.toLocaleString('en-GB')} of ${text.length.toLocaleString('en-GB')}; read_file with offset ${to}${page ? ` and page ${page}` : ''} continues)`
          : from ? `\n(end; from character ${from.toLocaleString('en-GB')})` : '';
        return `${what}\n${slice}${more}`;
      },
    },
    {
      name: 'transcribe_document',
      description: 'Make a transcript of a text-bearing file (PDF, Word, slides, spreadsheet, web page, text or code): the full text is saved as a project document "<file> — transcript" and shown in the viewer\'s Text tab. Do not read it out. For images, look with read_file and save what you read with save_document (for_file set). For audio and video, use transcribe_media.',
      schema: obj({ path: str('File path') }, ['path']),
      run: async ({ path: p }) => {
        const f = await fileIn(p);
        notFolder(f);
        if (f.kind === 'audio' || f.kind === 'video') return 'That is a recording; use transcribe_media.';
        if (f.kind === 'image' || f.kind === 'svg') return 'That is an image: look at it with read_file, then save the text you read with save_document, title "<file name> — transcript" and for_file set to its path.';
        if (!canExtract(f.file)) return `I can't get text out of ${f.name}.`;
        const doc = await textOf(f.file, f.stat);
        if (doc.unreadable) return doc.unreadable;
        const text = (doc.parts ? doc.parts.map((t, i) => `## ${doc.partName[0].toUpperCase()}${doc.partName.slice(1)} ${i + 1}\n\n${t}`).join('\n\n') : doc.text).trim();
        if (!text) return `${f.name} has no text in it that I can extract${f.kind === 'pdf' ? ' — it is probably scanned' : ''}.`;
        const res = saveTranscript(f, text, 'Text');
        return `Saved "${f.name} — transcript" (${words(doc.text.replace(/^\[(page|sheet|slide) \d+\]$/gm, '')).toLocaleString('en-GB')} words) in project "${res.project.label}" and put it in the viewer's Text tab. Confirm that in one short line; do not read it out. It begins: ${text.slice(0, 500)}`;
      },
    },
    {
      name: 'transcribe_media',
      description: 'Transcribe the speech in an audio or video file with the local speech recognizer. The transcript is saved as a project document "<file> — transcript" and shown in the viewer\'s Text tab; do not read it out. Long recordings take a while: the first call says how long, then call again with confirm true.',
      schema: obj({ path: str('Audio or video file path'), confirm: { type: 'boolean', description: 'Go ahead with a long recording after telling the user how long it will take' } }, ['path']),
      run: async ({ path: p, confirm }) => {
        const f = await fileIn(p);
        notFolder(f);
        if (f.kind !== 'audio' && f.kind !== 'video') return f.kind === 'image' || f.kind === 'svg'
          ? 'That is an image: look at it with read_file, then save what you read with save_document (for_file set).'
          : 'That is not a recording; use transcribe_document for text-bearing files.';
        if (!ctx.media || !ctx.transcribe) return 'Transcribing recordings is not available right now.';
        const signal = ctx.signal?.();
        const { duration: d } = await Promise.race([ctx.media.probe(f.file).catch(() => ({})), new Promise((r) => setTimeout(() => r({}), 8000))]);
        if (d > 2 * 3600) return `${f.name} is ${duration(d)} long; I can transcribe up to two hours at a time.`;
        const speed = ctx.transcribeSpeed?.() || 6;
        const eta = d ? d / speed + 5 : 0;
        if (eta > 45 && !confirm) return `${f.name} is ${duration(d)} long; transcribing it here will take about ${duration(eta)}. Tell the user that in a sentence, then call transcribe_media again with confirm true.`;
        const audio = await ctx.media.decode(f.file, { signal });
        if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        if (!audio?.length) return `There is no sound in ${f.name} that I can decode.`;
        if (audio.length / 16000 > 2 * 3600) return `${f.name} is over two hours long; I can transcribe up to two hours at a time.`;
        const out = await ctx.transcribe(audio, { signal });
        const text = transcriptText(out.chunks, out.text);
        if (!text) return `I could not make out any speech in ${f.name}.`;
        const res = saveTranscript(f, text, 'Transcript');
        return `Saved "${f.name} — transcript" (${duration(audio.length / 16000)} of audio, ${words(out.text || text).toLocaleString('en-GB')} words) in project "${res.project.label}" and put it in the viewer's Text tab. Confirm that in one short line; do not read it out. It begins: ${text.slice(0, 500)}`;
      },
    },
    {
      name: 'open_path',
      description: 'Open a file or folder on the user\'s computer in its default app, outside Jarvis. Only when they ask for another app or the default app, or want a folder opened; otherwise use show_file.',
      schema: obj({ path: str('File or folder path') }, ['path']),
      run: async ({ path: p }) => {
        const full = inRoot(p);
        await ctx.openPath(full);
        return `Opened ${full}.`;
      },
    },
  ];

  if (localWeb) {
    tools.push(
      {
        name: 'web_search',
        description: 'Search the web. Returns titles, URLs and snippets; follow up with fetch_url to read a page.',
        schema: obj({ query: str('Search query') }, ['query']),
        run: async ({ query }) => {
          const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) });
          const html = await res.text();
          const out = [];
          const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g;
          let m;
          while ((m = re.exec(html)) && out.length < 8) {
            let url = m[1];
            const uddg = /[?&]uddg=([^&]+)/.exec(url);
            if (uddg) url = decodeURIComponent(uddg[1]);
            out.push(`${stripHtml(m[2])}\n${url}\n${stripHtml(m[3] || '')}`);
          }
          return out.length ? out.join('\n\n') : 'No results.';
        },
      },
      {
        name: 'fetch_url',
        description: 'Fetch a web page and return its readable text (first 12,000 characters).',
        schema: obj({ url: str('http(s) URL') }, ['url']),
        run: async ({ url }) => {
          if (!/^https?:\/\//i.test(url)) throw new Error('Only http and https URLs.');
          const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) });
          const body = await res.text();
          const text = /html/i.test(res.headers.get('content-type') || '') ? stripHtml(body) : body;
          return `${res.status} ${url}\n${text.slice(0, 12000)}`;
        },
      },
    );
  }
  return tools;
}
