import { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, session, systemPreferences, utilityProcess, globalShortcut, protocol } from 'electron';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Settings } from './store.js';
import { Memory } from './memory.js';
import { Skills } from './skills.js';
import { McpHub } from './mcp.js';
import { Agent } from './agent.js';
import { scan, expand, isInside } from './fsscan.js';
import { DirSizer } from './dirsize.js';
import { CLOUD_MODELS } from './llm/anthropic.js';
import { listOllamaModels } from './llm/ollama.js';
import { ClaudeCli } from './llm/claudecli.js';
import { registerScheme, serveFiles, allowedPath } from './fileproto.js';
import { SelfChange, editInstructions } from './selfchange.js';
import { listen as listenForStop } from './control.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const windowed = process.argv.includes('--windowed');
if (process.env.JARVIS_DATA_DIR) app.setPath('userData', path.resolve(process.env.JARVIS_DATA_DIR));
// One Jarvis per data folder: starting it again brings the running one to the front.
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', () => {
  const w = BrowserWindow.getAllWindows()[0];
  if (w) { if (w.isMinimized()) w.restore(); w.show(); w.focus(); }
});
// `npm stop` and a plain `kill` close it the same way the window does.
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => app.quit());
let stopListener = () => {};
// Jarvis greets you and speaks without waiting for a click.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
registerScheme(protocol); // jarvis-file:// for the file viewer; must happen before ready

let win;
let settings;
let memory;
let skills;
let mcp;
let agent;
let claude;
let selfChange;
let startNotice = ''; // what Jarvis changed about itself before this start, said in the greeting
const sizer = new DirSizer();

const send = (event, payload) => {
  if (win && !win.isDestroyed()) win.webContents.send(`jarvis:${event}`, payload);
};
const fsRoot = () => settings.get().fsRoot || os.homedir();
// What the viewer may show and open: the chosen folder, and Jarvis's own project documents.
const viewRoots = () => [fsRoot(), memory.projectsDir];
const viewable = (p) => Boolean(allowedPath(p, viewRoots()));

// ---- secrets (API key) ------------------------------------------------------

const secretsFile = () => path.join(app.getPath('userData'), 'secrets.bin');
function readSecrets() {
  try {
    const raw = fs.readFileSync(secretsFile());
    const text = safeStorage.isEncryptionAvailable() && raw.subarray(0, 6).toString() !== 'plain:' ? safeStorage.decryptString(raw) : raw.toString().replace(/^plain:/, '');
    return JSON.parse(text);
  } catch {
    return {};
  }
}
function writeSecrets(value) {
  const text = JSON.stringify(value);
  // Encrypted with the OS keychain where available; otherwise a user-only file.
  const data = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(text) : Buffer.from(`plain:${text}`);
  fs.writeFileSync(secretsFile(), data, { mode: 0o600 });
}
const getApiKey = () => readSecrets().anthropicKey || process.env.ANTHROPIC_API_KEY || '';

// ---- speech (utility process) ----------------------------------------------

let speech;
let speechSeq = 0;
const speechPending = new Map();
function speechCall(op, args) {
  if (!speech) {
    speech = utilityProcess.fork(path.join(here, 'speech-process.js'), [path.join(app.getPath('userData'), 'models')], { serviceName: 'Jarvis speech' });
    speech.on('message', (msg) => {
      if (msg.type === 'status' && msg.what === 'transcript') {
        return send('ui', msg.stopped ? { type: 'status', text: 'Transcription stopped', ttl: 2500 } : { type: 'status', text: `Transcribing — ${Math.round((msg.at / msg.of) * 100)}%`, ttl: msg.at >= msg.of ? 2500 : 0 });
      }
      if (msg.type === 'status') return send('speech', msg);
      const pending = speechPending.get(msg.id);
      if (!pending) return;
      speechPending.delete(msg.id);
      if (msg.error) pending.reject(new Error(msg.error));
      else pending.resolve(msg.value);
    });
    speech.on('exit', () => {
      speech = null;
      for (const p of speechPending.values()) p.reject(new Error('The speech engine stopped unexpectedly.'));
      speechPending.clear();
    });
  }
  return new Promise((resolve, reject) => {
    const id = ++speechSeq;
    speechPending.set(id, { resolve, reject });
    speech.postMessage({ id, op, args });
  });
}

// ---- files on screen, and the sound inside recordings --------------------------

let onScreen = null; // what the viewer shows: {path, kind, name}
let transcribeSpeed = 0; // seconds of audio per second, measured on the last long transcription

// Recordings and pictures are decoded in the window (Chromium reads every format it plays or shows):
// sound comes back as 16 kHz mono, a picture sized for the model.
let mediaSeq = 0;
const mediaPending = new Map();
function mediaCall(type, file, { signal, timeout = 10 * 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const id = ++mediaSeq;
    const done = (fn, value) => {
      if (!mediaPending.delete(id)) return;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn(value);
    };
    const onAbort = () => done(reject, Object.assign(new Error('aborted'), { name: 'AbortError' }));
    const timer = setTimeout(() => done(reject, new Error('The window took too long to decode that file.')), timeout);
    signal?.addEventListener('abort', onAbort);
    mediaPending.set(id, (value) => (value?.error ? done(reject, new Error(value.error)) : done(resolve, value)));
    send('ui', type === 'picture' ? { type: 'decode_image', id, path: file } : { type: 'decode_audio', id, path: file, probe: type === 'probe' });
  });
}
const media = {
  probe: (file) => mediaCall('probe', file, { timeout: 15_000 }),
  decode: (file, { signal } = {}) => mediaCall('decode', file, { signal }),
  picture: (file) => mediaCall('picture', file, { timeout: 30_000 }),
};

/** A long recording through Whisper in slices; stops at the end of the current slice when `signal` fires, with what was done by then ({stopped: true, at, of}). */
async function transcribe(audio, { signal } = {}) {
  const started = Date.now();
  const job = speechCall('transcribe_long', { audio });
  const id = speechSeq; // the number speechCall just gave the job
  const onAbort = () => speech?.postMessage({ id: ++speechSeq, op: 'abort_long', args: { job: id } });
  signal?.addEventListener('abort', onAbort);
  try {
    const out = await job;
    if (audio.length >= 60 * 16000 && !out?.stopped) transcribeSpeed = audio.length / 16000 / Math.max(1, (Date.now() - started) / 1000);
    return out;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

// ---- state for the renderer -------------------------------------------------

function publicState() {
  return {
    settings: settings.get(),
    hasApiKey: Boolean(getApiKey()),
    claude: claude.status(),
    cloudModels: CLOUD_MODELS,
    memory: memory.snapshot(),
    skills: skills.list(),
    mcp: mcp.status(),
    fsRoot: fsRoot(),
    dataDir: app.getPath('userData'),
    platform: process.platform,
    selfChange: selfChange?.status(),
    selfChangeNotice: startNotice,
  };
}

/** Every settings change, from the controls or by voice, goes through here, so the window and the brain follow at once. */
async function applySettings(patch) {
  const before = JSON.stringify(settings.get().mcpServers);
  const claudePath = settings.get().claudePath;
  settings.set(patch);
  if (JSON.stringify(settings.get().mcpServers) !== before) mcp.sync(settings.get().mcpServers);
  send('settings', publicState());
  if (settings.get().claudePath !== claudePath) await claude.check({ again: true });
  agent.prewarm(); // model, effort, the Internet switch, the brain itself: whatever changed, the next turn starts ready
  return settings.get();
}

function registerIpc() {
  const handle = (name, fn) => ipcMain.handle(`jarvis:${name}`, (_e, ...args) => fn(...args));

  handle('state', publicState);
  handle('settings:set', (patch) => applySettings(patch));
  // Standing instructions from the controls: the same checks and caps as by voice.
  handle('instructions:edit', async (edit) => {
    const r = editInstructions(settings.get().instructions, edit || {});
    if (r.error) return { error: r.error };
    await applySettings({ instructions: r.list });
    return { list: r.list };
  });
  // Changes to Jarvis's own code (see selfchange.js): the controls' buttons and the change card.
  // A press of the button is the user's own yes; the model's apply_change and undo_last_change need theirs in what they said.
  handle('selfchange:apply', (opts) => selfChange.apply({ anyway: opts?.anyway === true, button: true }));
  handle('selfchange:discard', () => selfChange.discard());
  handle('selfchange:undo', () => selfChange.undo({ button: true }));
  handle('selfchange:show', () => {
    const file = selfChange.status().job?.diffFile;
    if (file) send('ui', { type: 'show_file', path: file });
    return Boolean(file);
  });
  handle('secrets:set', ({ anthropicKey }) => {
    writeSecrets({ ...readSecrets(), anthropicKey: String(anthropicKey || '').trim() });
    send('settings', publicState());
    return Boolean(getApiKey());
  });

  // The Claude Code login: 'claude:status' answers once it has been looked at; 'claude:check' looks again.
  handle('claude:status', () => (claude.status().state === 'checking' ? claude.check() : claude.status()));
  handle('claude:check', async () => {
    const status = await claude.check({ again: true });
    agent.prewarm();
    return status;
  });

  handle('chat:send', (text, opts) => agent.send(String(text || '').trim(), opts));
  handle('chat:abort', () => agent.abort());
  handle('chat:clear', () => memory.clearHistory());

  handle('memory:forget', (id) => Boolean(memory.forget(id)));
  handle('memory:activate', (id) => Boolean(memory.setActiveProject(id)));
  handle('memory:openDocument', (id) => {
    const node = memory.nodes.get(id);
    if (node?.file && isInside(memory.projectsDir, node.file)) return shell.openPath(node.file);
    return 'not found';
  });
  handle('memory:openProjectFolder', (id) => {
    const project = memory.nodes.get(id);
    if (!project) return 'not found';
    const dir = memory.projectDir(project);
    fs.mkdirSync(dir, { recursive: true });
    return shell.openPath(dir);
  });

  handle('skills:save', (skill) => {
    skills.save(skill);
    agent.prewarm();
    return skills.list();
  });
  handle('skills:remove', (id) => {
    skills.remove(id);
    agent.prewarm();
    return skills.list();
  });
  handle('skills:import', async () => {
    const res = await dialog.showOpenDialog(win, { title: 'Choose a skill folder (containing SKILL.md)', properties: ['openDirectory'] });
    if (!res.canceled && res.filePaths[0]) skills.importFolder(res.filePaths[0]);
    agent.prewarm();
    return skills.list();
  });

  handle('ollama:models', () => listOllamaModels(settings.get().ollamaUrl).catch(() => null));

  handle('fs:scan', () => {
    sizer.clear(); // a fresh map (first look, Rescan, a new folder): folder sizes are measured afresh too
    return scan(fsRoot(), { maxDepth: settings.get().fsDepth, maxNodes: 3500, bytes: true });
  });
  handle('fs:expand', (dir, depth) => (isInside(fsRoot(), dir) ? expand(dir, depth) : []));
  // Folder sizes for the Files map, measured in the background and sent back a batch at a time.
  handle('fs:sizes', (dirs) => {
    const root = fsRoot();
    const out = [];
    let timer = null;
    const flush = () => { timer = null; if (out.length) send('fsize', out.splice(0)); };
    sizer.measure((Array.isArray(dirs) ? dirs : []).filter((d) => typeof d === 'string' && isInside(root, d)), (id, r) => {
      out.push({ id, ...r });
      if (!timer) timer = setTimeout(flush, 120);
    }, { root: path.resolve(root) }).then(() => { clearTimeout(timer); flush(); });
    return true;
  });
  // Sizes of a few files Jarvis may show (its own documents on the Mind map).
  handle('fs:bytes', (paths) => Promise.all((Array.isArray(paths) ? paths : []).slice(0, 500).map((p) => (viewable(p) ? fs.promises.stat(p).then((st) => st.size, () => null) : null))));
  handle('fs:open', (p) => (viewable(p) ? shell.openPath(p) : 'outside root'));
  handle('fs:reveal', (p) => {
    if (viewable(p)) shell.showItemInFolder(p);
  });
  handle('fs:pickRoot', async () => {
    const res = await dialog.showOpenDialog(win, { title: 'Choose the folder Jarvis can see', defaultPath: fsRoot(), properties: ['openDirectory'] });
    if (res.canceled || !res.filePaths[0]) return null;
    sizer.clear();
    settings.set({ fsRoot: res.filePaths[0] });
    send('settings', publicState());
    return res.filePaths[0];
  });

  handle('speech:warm', (voice) => speechCall('warm', { voice }));
  handle('speech:transcribe', (audio, guess) => speechCall('transcribe', { audio, guess: Boolean(guess) }));
  handle('speech:stale', () => (speech ? speechCall('stale') : true));
  handle('speech:partial', (audio) => (speech ? speechCall('partial', { audio }) : null));
  handle('speech:synthesize', (text, voice) => speechCall('synthesize', { text, voice }));
  handle('speech:cancel', () => (speech ? speechCall('cancel') : true));

  handle('media:decoded', (id, value) => mediaPending.get(id)?.(value));
  handle('viewer:state', (shown) => {
    onScreen = shown?.path && viewable(shown.path) ? { path: shown.path, kind: String(shown.kind || ''), name: String(shown.name || '') } : null;
  });

  handle('window:fullscreen', () => {
    win.setFullScreen(!win.isFullScreen());
    return win.isFullScreen();
  });
  handle('window:quit', () => app.quit());
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    backgroundColor: '#000000',
    fullscreen: settings.get().startFullscreen && !windowed,
    autoHideMenuBar: true,
    title: 'J.A.R.V.I.S.',
    webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') {
      win.setFullScreen(!win.isFullScreen());
      event.preventDefault();
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  await win.loadFile(path.join(here, '../renderer/index.html'));
}

app.whenReady().then(async () => {
  const dataDir = app.getPath('userData');
  stopListener = listenForStop(dataDir, () => app.quit());
  settings = new Settings(dataDir);
  memory = new Memory(dataDir);
  skills = new Skills(dataDir);
  mcp = new McpHub((status) => {
    send('mcp', status);
    agent?.prewarm(); // a connection's tools are part of what the next turn starts with
  });
  claude = new ClaudeCli({
    workDir: path.join(dataDir, 'claude'), // an empty folder of its own, so the CLI has no project to look at
    configuredPath: () => settings.get().claudePath,
    onStatus: () => send('settings', publicState()),
    log: process.env.JARVIS_DEBUG ? (line) => console.error(`[claude] ${line}`) : undefined,
  });
  selfChange = new SelfChange({
    appPath: app.getAppPath(),
    settings, claude,
    workRoot: path.join(app.getPath('cache'), 'jarvis-self-change'), // per user, and outside the data folder: the coding agent never sees it
    diffDir: path.join(memory.projectsDir, 'jarvis-changes'), // inside what the viewer may show
    ui: (event) => send('ui', event),
    say: (text) => { memory.logTurn('assistant', text); send('ui', { type: 'say', text }); },
    restart: () => { app.relaunch(); app.quit(); },
    isBusy: () => Boolean(agent?.active),
    log: process.env.JARVIS_DEBUG ? (line) => console.error(`[self] ${line}`) : undefined,
  });
  startNotice = settings.get().selfChangeNotice || '';
  if (startNotice) {
    settings.set({ selfChangeNotice: '' });
    memory.logTurn('assistant', `(Restarted.) ${startNotice}`);
  }
  agent = new Agent({
    settings, memory, skills, mcp, claude, getApiKey, fsRoot,
    emit: (event) => send('chat', event),
    ui: (event) => send('ui', event),
    openPath: (p) => shell.openPath(p),
    onScreen: () => onScreen,
    media,
    transcribe,
    transcribeSpeed: () => transcribeSpeed,
    selfChange,
    setSettings: applySettings,
    selfEnv: () => ({ claudeReady: claude.status().state === 'ready', hasApiKey: Boolean(getApiKey()) }),
    rescanFiles: () => { sizer.stop(); send('ui', { type: 'rescan_files' }); },
  });
  memory.onChange((snapshot) => send('memory', snapshot));
  serveFiles(protocol, viewRoots);

  // The window only ever asks for the microphone; grant that and nothing else. Listing the speakers
  // to choose from is its own check, so that list still works if the microphone is refused.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media'));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media' || permission === 'speaker-selection');
  if (process.platform === 'darwin') systemPreferences.askForMediaAccess('microphone').catch(() => {});

  registerIpc();
  claude.sweep(); // what a crash or a kill left of Jarvis among Claude Code's running sessions
  if (agent.brain() === 'cli') claude.check(); // find Claude Code while the window loads
  await createWindow();
  mcp.sync(settings.get().mcpServers).finally(() => agent.prewarm());
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  stopListener();
  globalShortcut.unregisterAll();
  sizer.dispose();
  speech?.kill();
  claude?.dispose();
  mcp?.closeAll();
});
