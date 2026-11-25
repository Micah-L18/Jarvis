// Built-in tools. Each is {name, description, schema, run(input) -> string}; providers
// translate this neutral shape into their own tool format.
import fs from 'node:fs/promises';
import path from 'node:path';
import { scan, isInside } from './fsscan.js';
import { NODE_TYPES } from './memory.js';

const str = (description) => ({ type: 'string', description });
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

function stripHtml(html) {
  return html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
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
 * @param ctx {memory, skills, settings, ui(event), fsRoot(), openPath(p)}
 * @param opts {localWeb: boolean} — add client-side web tools (used when the model has no hosted search)
 */
export function builtinTools(ctx, { localWeb = false } = {}) {
  const { memory, skills } = ctx;
  const inRoot = (p) => {
    const root = ctx.fsRoot();
    const full = path.resolve(root, p || '.');
    if (!isInside(root, full)) throw new Error(`That is outside the folder I am allowed to see (${root}).`);
    return full;
  };

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
      description: 'Write a markdown document into a project folder. Use for anything too long to say aloud: plans, research notes, datasets, drafts. Saving with an existing title replaces that document.',
      schema: obj({ title: str('Document title'), content: str('Full markdown content'), project: str('Project name. Omit for the active project.') }, ['title', 'content']),
      run: async ({ title, content, project }) => {
        const res = memory.saveDocument(project, title, content);
        ctx.ui({ type: 'document', title, file: res.file, project: res.project.label });
        return `Saved "${title}" in project "${res.project.label}" at ${res.file}.`;
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
      description: 'Open a saved project document on screen in the default app so the user can read it.',
      schema: obj({ title: str('Document title'), project: str('Project name. Omit to look across all projects.') }, ['title']),
      run: async ({ title, project }) => {
        const res = memory.readDocument(project, title);
        if (!res) return `No document called "${title}".`;
        await ctx.openPath(res.doc.file);
        return `Opened "${res.doc.label}".`;
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
      name: 'read_file',
      description: 'Read a text file from the user\'s computer (first 40,000 characters).',
      schema: obj({ path: str('File path') }, ['path']),
      run: async ({ path: p }) => {
        const file = inRoot(p);
        const stat = await fs.stat(file);
        if (stat.isDirectory()) throw new Error('That is a folder; use list_folder.');
        const buf = await fs.readFile(file);
        if (buf.subarray(0, 4000).includes(0)) return `${file} is a binary file (${stat.size} bytes); I can't read it as text.`;
        const text = buf.toString('utf8');
        return text.length > 40000 ? `${text.slice(0, 40000)}\n… (truncated, ${text.length} characters total)` : text;
      },
    },
    {
      name: 'open_path',
      description: 'Open a file or folder on the user\'s computer in its default app.',
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
