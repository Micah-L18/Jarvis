// The control panel: brain, voice, skills, connections, projects, memory, files, system.
import { deviceOptions } from './devices.js';
import { claudeLogin } from './brain.js';

const api = window.jarvis;

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}

const TTS_ENGINES = [['tiny', 'Fast voice (tiny-voca)'], ['kokoro', 'Neural voice (Kokoro)'], ['system', 'System voice'], ['off', 'Silent — captions only']];
const TINY_VOICES = [['M2', 'Male (M2)'], ['F2', 'Female (F2)']];
const TINY_SPEEDS = [['0.9', 'Unhurried'], ['1', 'Normal speed'], ['1.15', 'Brisk']];
const KOKORO_VOICES = [
  ['bm_george', 'George — British, male'], ['bm_lewis', 'Lewis — British, male'], ['bm_daniel', 'Daniel — British, male'], ['bm_fable', 'Fable — British, male'],
  ['bf_emma', 'Emma — British, female'], ['bf_isabella', 'Isabella — British, female'],
  ['am_michael', 'Michael — American, male'], ['am_fenrir', 'Fenrir — American, male'], ['af_heart', 'Heart — American, female'], ['af_bella', 'Bella — American, female'],
];

export class Panel {
  /** @param app {state(), toast(text, error?), focusMind(id), setView(view), rescanFiles(), voice() -> Voice} */
  constructor(root, app) {
    this.root = root;
    this.app = app;
    this.memoryFilter = '';
    this.skillDraft = null;
    this.mcpDraft = null;
    this.localModels = undefined;
  }

  get open() {
    return !this.root.hidden;
  }

  toggle(open = this.root.hidden) {
    this.root.hidden = !open;
    if (open) {
      this.render();
      this.refreshLocalModels();
      this.app.voice().syncDevices(); // look again at what is plugged in; the lists follow in refreshDevices()
      this.runMeter();
    }
  }

  deviceSelect(kind, saved, onchange) {
    const el = this.select(saved, deviceOptions(this.app.voice().devices, kind, saved), onchange);
    el.dataset.devices = kind;
    el.style.cssText = 'flex:1;min-width:0';
    return el;
  }

  /** Something was plugged in or pulled out: redo the two device lists where they stand, leaving the rest of the panel (and whatever is being typed) alone. */
  refreshDevices() {
    if (!this.open) return;
    const v = this.app.state().settings.voice;
    for (const el of this.root.querySelectorAll('select[data-devices]')) {
      const saved = (el.dataset.devices === 'audioinput' ? v.inputDevice : v.outputDevice) || '';
      const options = deviceOptions(this.app.voice().devices, el.dataset.devices, saved);
      if (options.length === el.options.length && options.every(([id, label], i) => el.options[i].value === id && el.options[i].text === label)) continue;
      el.replaceChildren(...options.map(([id, label]) => h('option', { value: id }, label)));
      el.value = saved;
    }
  }

  /** The microphone level: one transform a frame while the panel is open, nothing once it is closed. */
  runMeter() {
    if (this.metering) return;
    this.metering = true;
    let bar = null;
    let shown = 0;
    const tick = () => {
      if (!this.open) { this.metering = false; return; }
      if (bar !== this.meterBar) { bar = this.meterBar; shown = 0; } // the panel was redrawn
      const level = Math.max(this.app.voice().micLevel, shown * 0.88); // quick up, easy down
      if (bar && Math.abs(level - shown) > 0.004) bar.style.transform = `scaleX(${(shown = level).toFixed(3)})`;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  async refreshLocalModels() {
    this.localModels = await api.invoke('ollama:models');
    if (this.open) this.render();
  }

  set(patch) {
    return api.invoke('settings:set', patch);
  }

  toggleRow(label, on, onchange) {
    return h('div', { class: `toggle ${on ? 'on' : ''}`, onclick: () => onchange(!on) }, label, h('i'));
  }

  select(value, options, onchange) {
    const el = h('select', { onchange: (e) => onchange(e.target.value) }, options.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
    return el;
  }

  text(value, onchange, props = {}) {
    return h('input', { type: 'text', value: value || '', onchange: (e) => onchange(e.target.value.trim()), ...props });
  }

  render() {
    if (!this.open) return;
    const keep = this.root.scrollTop;
    const active = document.activeElement;
    if (active && this.root.contains(active) && /INPUT|TEXTAREA/.test(active.tagName) && active.dataset.live) return; // don't clobber typing
    this.root.replaceChildren(this.brain(), this.voice(), this.skills(), this.connections(), this.projects(), this.memory(), this.files(), this.system());
    this.root.scrollTop = keep;
  }

  // ---- sections -------------------------------------------------------------

  brain() {
    const st = this.app.state();
    const s = st.settings;
    const cloud = s.provider === 'cloud';
    let keyInput;
    const login = claudeLogin(st.claude);
    const signIn = s.cloudAuth === 'key'
      ? [
          h('label', {}, `Anthropic API key ${st.hasApiKey ? '· saved' : '· needed'}`),
          h('div', { class: 'row' },
            (keyInput = h('input', { type: 'password', placeholder: st.hasApiKey ? '••••••••••••' : 'sk-ant-…', style: 'flex:1', 'data-live': '1' })),
            h('button', { class: 'btn', onclick: async () => {
              if (!keyInput.value.trim()) return;
              await api.invoke('secrets:set', { anthropicKey: keyInput.value });
              keyInput.blur();
              this.app.toast('API key saved on this computer.');
            } }, 'Save')),
          h('p', { class: 'note' }, 'What you say and the tools\' results are sent to Anthropic. The key is stored encrypted with your OS keychain.'),
        ]
      : [
          h('div', { class: 'row', style: 'margin-top:8px;flex-wrap:nowrap' },
            h('span', { class: `dot ${login.dot}` }),
            h('div', { style: 'flex:1;min-width:0;font:10px/1.6 var(--mono);color:var(--hot)', title: st.claude?.path || '' }, login.line),
            h('button', { class: 'btn', title: 'Look for Claude Code and its sign-in again', onclick: async () => {
              st.claude = await api.invoke('claude:check');
              this.render();
              const now = claudeLogin(st.claude);
              this.app.toast(now.line, !now.ok);
            } }, 'Re-check')),
          h('label', {}, 'Path to claude (optional)'),
          this.text(s.claudePath, (v) => this.set({ claudePath: v }), { placeholder: st.claude?.path || 'found automatically', 'data-live': '1' }),
          h('p', { class: 'note' }, 'Uses the sign-in of the Claude Code CLI on this computer — no API key. What you say and the tools\' results are sent to Anthropic and count against your Claude plan. Nothing else from your Claude Code setup is used.'),
        ];
    const body = cloud
      ? [
          h('label', {}, 'Model'),
          this.select(s.cloudModel, st.cloudModels.map((m) => [m.id, m.label]), (v) => this.set({ cloudModel: v })),
          h('label', {}, 'Thinking'),
          this.select(s.effort, [['low', 'Quick — best for conversation'], ['medium', 'Balanced'], ['high', 'Deep — slower, more careful']], (v) => this.set({ effort: v })),
          h('label', {}, 'Sign in with'),
          this.select(s.cloudAuth, [['cli', 'Claude login (Claude Code CLI)'], ['key', 'API key']], (v) => this.set({ cloudAuth: v })),
          ...signIn,
        ]
      : [
          h('label', {}, 'Ollama address'),
          this.text(s.ollamaUrl, async (v) => { await this.set({ ollamaUrl: v }); this.refreshLocalModels(); }),
          h('label', {}, 'Model'),
          this.localModels?.length
            ? this.select(s.localModel, [['', '— choose —'], ...this.localModels.map((m) => [m, m])], (v) => this.set({ localModel: v }))
            : h('p', { class: 'note' }, this.localModels === undefined ? 'Looking for Ollama…' : 'Ollama is not answering. Install it from ollama.com, run it, and pull a tool-capable model (for example: ollama pull qwen3).'),
          h('div', { class: 'row', style: 'margin-top:8px' }, h('button', { class: 'btn', onclick: () => this.refreshLocalModels() }, 'Refresh')),
          h('p', { class: 'note' }, 'Everything stays on this machine. Speech recognition and the voice are always local.'),
        ];
    return h('section', {},
      h('h3', {}, 'Brain'),
      h('div', { class: 'seg' },
        h('button', { class: cloud ? 'on' : '', onclick: () => this.set({ provider: 'cloud' }) }, 'Cloud'),
        h('button', { class: cloud ? '' : 'on', onclick: () => this.set({ provider: 'local' }) }, 'Local')),
      body,
      h('div', { style: 'margin-top:10px' }, this.toggleRow('Internet access (search and read the web)', s.webSearch, (v) => this.set({ webSearch: v }))),
    );
  }

  voice() {
    const s = this.app.state().settings;
    const v = s.voice;
    const setV = (patch) => this.set({ voice: patch });
    const sysVoices = 'speechSynthesis' in window ? speechSynthesis.getVoices().filter((x) => /^en/i.test(x.lang)) : [];
    return h('section', {},
      h('h3', {}, 'Voice'),
      h('label', {}, 'Speaking voice'),
      this.select(v.tts, TTS_ENGINES, (x) => { setV({ tts: x, ttsChosen: true }); if (x === 'tiny' || x === 'kokoro') api.invoke('speech:warm', x).catch(() => {}); }),
      v.tts === 'tiny' && h('div', { class: 'row' },
        Object.assign(this.select(v.tinyVoice, TINY_VOICES, (x) => setV({ tinyVoice: x })), { style: 'flex:1;min-width:0' }),
        Object.assign(this.select(String(v.tinySpeed || 1), TINY_SPEEDS, (x) => setV({ tinySpeed: Number(x) })), { style: 'flex:1;min-width:0' })),
      v.tts === 'tiny' && h('p', { class: 'note' }, 'American English. Much faster; Kokoro sounds more natural.'),
      v.tts === 'kokoro' && this.select(v.kokoroVoice, KOKORO_VOICES, (x) => setV({ kokoroVoice: x })),
      v.tts === 'system' && this.select(v.systemVoice, [['', 'Best British voice available'], ...sysVoices.map((x) => [x.name, x.name])], (x) => setV({ systemVoice: x })),
      h('label', {}, 'Microphone'),
      h('div', { class: 'row' },
        this.deviceSelect('audioinput', v.inputDevice, (x) => setV({ inputDevice: x })),
        h('div', { class: 'meter', title: 'What the microphone hears' }, (this.meterBar = h('i')))),
      h('label', {}, 'Speaker'),
      h('div', { class: 'row' },
        this.deviceSelect('audiooutput', v.outputDevice, (x) => setV({ outputDevice: x })),
        h('button', { class: 'btn', title: 'Play a short tone through this speaker', onclick: () => this.app.voice().testTone() }, 'Test')),
      v.tts === 'system' && h('p', { class: 'note' }, 'The system voice always plays through the system default speaker. The fast and neural voices follow this choice.'),
      h('div', { style: 'margin-top:8px' },
        this.toggleRow('Hands-free: always listening', v.handsFree, (x) => setV({ handsFree: x })),
        this.toggleRow('Let me interrupt while it is talking', v.bargeIn, (x) => setV({ bargeIn: x }))),
      h('p', { class: 'note' }, 'On open speakers the microphone can hear Jarvis and cut it off. If that happens, turn interruptions off or use headphones. Space is always push-to-talk.'),
      h('label', {}, 'Your name'),
      this.text(s.userName, (x) => this.set({ userName: x }), { placeholder: 'optional' }),
      h('label', {}, 'How it addresses you'),
      this.text(s.address, (x) => this.set({ address: x || 'sir' })),
    );
  }

  skills() {
    const st = this.app.state();
    const disabled = new Set(st.settings.disabledSkills);
    const save = async (skill) => {
      if (!skill.name?.trim()) return this.app.toast('A skill needs a name.', true);
      await api.invoke('skills:save', skill);
      this.skillDraft = null;
      await this.app.refresh();
    };
    const d = this.skillDraft;
    let name, desc, body;
    return h('section', {},
      h('h3', {}, 'Skills', h('small', {}, `${st.skills.length - disabled.size} active`)),
      h('div', { class: 'list' }, st.skills.map((k) => h('div', { class: 'item' },
        h('div', { class: 'grow item clicky', style: 'border:0;padding:0', onclick: () => { this.skillDraft = { ...k }; this.render(); } },
          h('div', { class: 'grow' }, h('div', { class: 'name' }, k.name), h('div', { class: 'sub' }, k.description))),
        this.toggleRow('', !disabled.has(k.id), (on) => this.set({ disabledSkills: on ? [...disabled].filter((x) => x !== k.id) : [...disabled, k.id] })),
        h('button', { class: 'x', title: 'Delete skill', onclick: async () => { await api.invoke('skills:remove', k.id); this.app.refresh(); } }, '✕')))),
      d
        ? h('div', { class: 'editor' },
            h('label', {}, 'Name'), (name = h('input', { type: 'text', value: d.name || '', 'data-live': '1' })),
            h('label', {}, 'When to use it (one line)'), (desc = h('input', { type: 'text', value: d.description || '', 'data-live': '1' })),
            h('label', {}, 'Instructions'), (body = h('textarea', { 'data-live': '1' }, d.body || '')),
            h('div', { class: 'row', style: 'margin-top:10px' },
              h('button', { class: 'btn solid', onclick: () => save({ id: d.id, name: name.value, description: desc.value, body: body.value }) }, 'Save skill'),
              h('button', { class: 'btn', onclick: () => { this.skillDraft = null; document.activeElement?.blur(); this.render(); } }, 'Cancel')))
        : h('div', { class: 'row', style: 'margin-top:10px' },
            h('button', { class: 'btn', onclick: () => { this.skillDraft = {}; this.render(); } }, 'New skill'),
            h('button', { class: 'btn', onclick: async () => { try { await api.invoke('skills:import'); this.app.refresh(); } catch (e) { this.app.toast(e.message, true); } } }, 'Import folder')),
      h('p', { class: 'note' }, 'A skill is a set of instructions Jarvis reads when a task calls for it — written in plain language.'),
    );
  }

  connections() {
    const st = this.app.state();
    const servers = st.settings.mcpServers;
    const status = new Map(st.mcp.map((c) => [c.id, c]));
    const saveServers = (next) => this.set({ mcpServers: next });
    const d = this.mcpDraft;
    let name, command, url, extra;
    const addForm = d && h('div', { class: 'editor' },
      h('div', { class: 'seg' },
        h('button', { class: d.type === 'stdio' ? 'on' : '', onclick: () => { d.type = 'stdio'; this.render(); } }, 'Command'),
        h('button', { class: d.type === 'http' ? 'on' : '', onclick: () => { d.type = 'http'; this.render(); } }, 'URL')),
      h('label', {}, 'Name'), (name = h('input', { type: 'text', placeholder: 'e.g. calendar', 'data-live': '1' })),
      d.type === 'stdio'
        ? [h('label', {}, 'Command and arguments'), (command = h('input', { type: 'text', placeholder: 'npx -y @modelcontextprotocol/server-filesystem ~/Documents', 'data-live': '1' })),
           h('label', {}, 'Environment (KEY=value per line, optional)'), (extra = h('textarea', { style: 'min-height:54px', 'data-live': '1' }))]
        : [h('label', {}, 'Server URL'), (url = h('input', { type: 'text', placeholder: 'https://example.com/mcp', 'data-live': '1' })),
           h('label', {}, 'Headers (Name: value per line, optional)'), (extra = h('textarea', { style: 'min-height:54px', 'data-live': '1' }))],
      h('div', { class: 'row', style: 'margin-top:10px' },
        h('button', { class: 'btn solid', onclick: () => {
          const pairs = Object.fromEntries(extra.value.split('\n').map((l) => l.split(d.type === 'stdio' ? '=' : ':')).filter((p) => p.length > 1 && p[0].trim()).map(([k, ...rest]) => [k.trim(), rest.join(d.type === 'stdio' ? '=' : ':').trim()]));
          const server = { id: `${Date.now().toString(36)}`, name: name.value.trim(), type: d.type, enabled: true };
          if (!server.name) return this.app.toast('Give the connection a name.', true);
          if (d.type === 'stdio') {
            const [cmd, ...args] = command.value.trim().split(/\s+/);
            if (!cmd) return this.app.toast('Enter the command that starts the server.', true);
            Object.assign(server, { command: cmd, args: args.join(' '), env: pairs });
          } else {
            if (!/^https?:\/\//.test(url.value.trim())) return this.app.toast('Enter the server URL.', true);
            Object.assign(server, { url: url.value.trim(), headers: pairs });
          }
          this.mcpDraft = null;
          document.activeElement?.blur();
          saveServers([...servers, server]);
        } }, 'Connect'),
        h('button', { class: 'btn', onclick: () => { this.mcpDraft = null; document.activeElement?.blur(); this.render(); } }, 'Cancel')));
    return h('section', {},
      h('h3', {}, 'Connections', h('small', {}, 'MCP servers')),
      h('div', { class: 'list' }, servers.map((srv) => {
        const live = status.get(srv.id);
        const sub = srv.enabled === false ? 'off' : live?.status === 'connected' ? `${live.tools.length} tools · ${live.tools.slice(0, 4).map((t) => t.name).join(', ')}` : live?.error || live?.status || 'starting…';
        return h('div', { class: 'item' },
          h('span', { class: `dot ${srv.enabled === false ? '' : live?.status || 'connecting'}` }),
          h('div', { class: 'grow' }, h('div', { class: 'name' }, srv.name), h('div', { class: 'sub', title: sub }, sub)),
          this.toggleRow('', srv.enabled !== false, (on) => saveServers(servers.map((x) => (x.id === srv.id ? { ...x, enabled: on } : x)))),
          h('button', { class: 'x', title: 'Remove', onclick: () => saveServers(servers.filter((x) => x.id !== srv.id)) }, '✕'));
      })),
      addForm || h('div', { class: 'row', style: 'margin-top:10px' }, h('button', { class: 'btn', onclick: () => { this.mcpDraft = { type: 'stdio' }; this.render(); } }, 'Add connection')),
      h('p', { class: 'note' }, 'Each connection gives Jarvis new tools — calendars, email, databases, home automation, anything with an MCP server. A command-type server runs as a program on this computer with your permissions.'),
    );
  }

  projects() {
    const st = this.app.state();
    const projects = st.memory.nodes.filter((n) => n.type === 'project');
    const count = (id) => st.memory.nodes.filter((n) => n.project === id).length;
    return h('section', {},
      h('h3', {}, 'Projects', h('small', {}, 'say "start a project for…"')),
      h('div', { class: 'list' }, projects.map((p) => h('div', { class: 'item' },
        h('div', { class: 'grow item clicky', style: 'border:0;padding:0', onclick: () => { api.invoke('memory:activate', p.id); this.app.focusMind(p.id); } },
          h('div', { class: 'grow' }, h('div', { class: 'name' }, p.label), h('div', { class: 'sub' }, `${count(p.id)} items${p.summary ? ` · ${p.summary}` : ''}`))),
        p.id === st.memory.activeProject && h('span', { class: 'tag', style: 'color:var(--amber);border-color:var(--amber)' }, 'active'),
        h('button', { class: 'x', title: 'Open project folder', onclick: () => api.invoke('memory:openProjectFolder', p.id) }, '▤'),
        p.id !== 'project:general' && h('button', { class: 'x', title: 'Forget this project and everything in it', onclick: () => api.invoke('memory:forget', p.id) }, '✕')))),
    );
  }

  memory() {
    const st = this.app.state();
    const q = this.memoryFilter.toLowerCase();
    const items = st.memory.nodes
      .filter((n) => n.type !== 'core' && n.type !== 'project')
      .filter((n) => !q || `${n.label} ${n.summary || ''}`.toLowerCase().includes(q))
      .sort((a, b) => (b.updated || 0) - (a.updated || 0));
    const list = h('div', { class: 'list' });
    const fill = () => list.replaceChildren(...items.slice(0, 200).map((n) => h('div', { class: 'item' },
      h('span', { class: 'tag' }, n.type),
      h('div', { class: 'grow item clicky', style: 'border:0;padding:0', onclick: () => this.app.focusMind(n.id) },
        h('div', { class: 'grow' }, h('div', { class: 'name' }, n.label), h('div', { class: 'sub', title: n.summary || '' }, n.summary || ''))),
      h('button', { class: 'x', title: 'Forget this', onclick: () => api.invoke('memory:forget', n.id) }, '✕'))));
    fill();
    return h('section', {},
      h('h3', {}, 'Memory', h('small', {}, `${items.length} things known`)),
      h('input', { type: 'text', placeholder: 'Filter…', value: this.memoryFilter, 'data-live': '1', oninput: (e) => {
        this.memoryFilter = e.target.value;
        const qq = this.memoryFilter.toLowerCase();
        for (const row of list.children) row.hidden = Boolean(qq) && !row.textContent.toLowerCase().includes(qq);
      } }),
      list,
      !items.length && h('p', { class: 'note' }, 'Nothing yet. As you talk, people, plans and facts are filed here on their own.'),
      h('div', { class: 'row', style: 'margin-top:10px' },
        h('button', { class: 'btn', onclick: async () => { await api.invoke('chat:clear'); this.app.toast('Recent conversation cleared. The mind map is untouched.'); } }, 'Clear recent conversation')),
      h('p', { class: 'note' }, 'Removing something here (or clicking a dot in the Mind view and choosing Forget) deletes it from what Jarvis knows, including mentions in the saved conversation.'),
    );
  }

  files() {
    const st = this.app.state();
    return h('section', {},
      h('h3', {}, 'Files'),
      h('label', {}, 'Folder Jarvis can see'),
      h('div', { class: 'path', style: 'font:11px var(--mono);color:var(--hot);word-break:break-all;margin-bottom:8px' }, st.fsRoot),
      h('label', {}, 'Depth shown at first'),
      this.select(String(st.settings.fsDepth), [['2', '2 levels'], ['3', '3 levels'], ['4', '4 levels'], ['5', '5 levels']], async (v) => { await this.set({ fsDepth: Number(v) }); this.app.rescanFiles(); }),
      h('div', { class: 'row', style: 'margin-top:10px' },
        h('button', { class: 'btn', onclick: async () => { if (await api.invoke('fs:pickRoot')) this.app.rescanFiles(); } }, 'Change folder'),
        h('button', { class: 'btn', onclick: () => this.app.rescanFiles() }, 'Rescan')),
      h('p', { class: 'note' }, 'Jarvis can list, search, read and open files inside this folder, never outside it. Click a folder dot to open it further.'),
    );
  }

  system() {
    const st = this.app.state();
    return h('section', {},
      h('h3', {}, 'System'),
      this.toggleRow('Start in full screen', st.settings.startFullscreen, (v) => this.set({ startFullscreen: v })),
      h('p', { class: 'note' }, `Data: ${st.dataDir}`),
      h('div', { class: 'row', style: 'margin-top:10px' },
        h('button', { class: 'btn', onclick: () => api.invoke('window:fullscreen') }, 'Toggle full screen'),
        h('button', { class: 'btn danger', onclick: () => api.invoke('window:quit') }, 'Quit')),
    );
  }
}
