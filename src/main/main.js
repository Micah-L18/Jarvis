import { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, session, systemPreferences, utilityProcess, globalShortcut } from 'electron';
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
import { CLOUD_MODELS } from './llm/anthropic.js';
import { listOllamaModels } from './llm/ollama.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const windowed = process.argv.includes('--windowed');
if (process.env.JARVIS_DATA_DIR) app.setPath('userData', path.resolve(process.env.JARVIS_DATA_DIR));
// Jarvis greets you and speaks without waiting for a click.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let win;
let settings;
let memory;
let skills;
let mcp;
let agent;

const send = (event, payload) => {
  if (win && !win.isDestroyed()) win.webContents.send(`jarvis:${event}`, payload);
};
const fsRoot = () => settings.get().fsRoot || os.homedir();

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

// ---- state for the renderer -------------------------------------------------

function publicState() {
  return {
    settings: settings.get(),
    hasApiKey: Boolean(getApiKey()),
    cloudModels: CLOUD_MODELS,
    memory: memory.snapshot(),
    skills: skills.list(),
    mcp: mcp.status(),
    fsRoot: fsRoot(),
    dataDir: app.getPath('userData'),
    platform: process.platform,
  };
}

function registerIpc() {
  const handle = (name, fn) => ipcMain.handle(`jarvis:${name}`, (_e, ...args) => fn(...args));

  handle('state', publicState);
  handle('settings:set', async (patch) => {
    const before = JSON.stringify(settings.get().mcpServers);
    settings.set(patch);
    if (JSON.stringify(settings.get().mcpServers) !== before) mcp.sync(settings.get().mcpServers);
    send('settings', publicState());
    return settings.get();
  });
  handle('secrets:set', ({ anthropicKey }) => {
    writeSecrets({ ...readSecrets(), anthropicKey: String(anthropicKey || '').trim() });
    send('settings', publicState());
    return Boolean(getApiKey());
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
    return skills.list();
  });
  handle('skills:remove', (id) => {
    skills.remove(id);
    return skills.list();
  });
  handle('skills:import', async () => {
    const res = await dialog.showOpenDialog(win, { title: 'Choose a skill folder (containing SKILL.md)', properties: ['openDirectory'] });
    if (!res.canceled && res.filePaths[0]) skills.importFolder(res.filePaths[0]);
    return skills.list();
  });

  handle('ollama:models', () => listOllamaModels(settings.get().ollamaUrl).catch(() => null));

  handle('fs:scan', () => scan(fsRoot(), { maxDepth: settings.get().fsDepth, maxNodes: 3500 }));
  handle('fs:expand', (dir, depth) => (isInside(fsRoot(), dir) ? expand(dir, depth) : []));
  handle('fs:open', (p) => (isInside(fsRoot(), p) ? shell.openPath(p) : 'outside root'));
  handle('fs:reveal', (p) => {
    if (isInside(fsRoot(), p)) shell.showItemInFolder(p);
  });
  handle('fs:pickRoot', async () => {
    const res = await dialog.showOpenDialog(win, { title: 'Choose the folder Jarvis can see', defaultPath: fsRoot(), properties: ['openDirectory'] });
    if (res.canceled || !res.filePaths[0]) return null;
    settings.set({ fsRoot: res.filePaths[0] });
    send('settings', publicState());
    return res.filePaths[0];
  });

  handle('speech:warm', (voice) => speechCall('warm', { voice }));
  handle('speech:transcribe', (audio) => speechCall('transcribe', { audio }));
  handle('speech:synthesize', (text, voice) => speechCall('synthesize', { text, voice }));
  handle('speech:cancel', () => (speech ? speechCall('cancel') : true));

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
  settings = new Settings(dataDir);
  memory = new Memory(dataDir);
  skills = new Skills(dataDir);
  mcp = new McpHub((status) => send('mcp', status));
  agent = new Agent({
    settings, memory, skills, mcp, getApiKey, fsRoot,
    emit: (event) => send('chat', event),
    ui: (event) => send('ui', event),
    openPath: (p) => shell.openPath(p),
  });
  memory.onChange((snapshot) => send('memory', snapshot));

  // The window only ever asks for the microphone; grant that and nothing else.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media'));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media');
  if (process.platform === 'darwin') systemPreferences.askForMediaAccess('microphone').catch(() => {});

  registerIpc();
  await createWindow();
  mcp.sync(settings.get().mcpServers);
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  globalShortcut.unregisterAll();
  speech?.kill();
  mcp?.closeAll();
});
