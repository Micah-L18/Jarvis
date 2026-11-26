// How `npm stop` reaches a running Jarvis: a local socket (a named pipe on Windows) next to its
// data, plus a pid file as a last resort. Plain Node, so the stop script can use it without Electron.
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

/** Where Electron keeps Jarvis's data by default (app name "jarvis"), unless JARVIS_DATA_DIR says otherwise. */
export function dataDirFor(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.JARVIS_DATA_DIR) return path.resolve(env.JARVIS_DATA_DIR);
  const appData = platform === 'win32' ? env.APPDATA || path.join(home, 'AppData', 'Roaming')
    : platform === 'darwin' ? path.join(home, 'Library', 'Application Support')
    : env.XDG_CONFIG_HOME || path.join(home, '.config');
  return path.join(appData, 'jarvis');
}

export function controlAddress(dataDir, platform = process.platform) {
  const tag = crypto.createHash('sha1').update(path.resolve(dataDir)).digest('hex').slice(0, 12);
  if (platform === 'win32') return `\\\\.\\pipe\\jarvis-${tag}`;
  const sock = path.join(dataDir, 'jarvis.sock');
  return sock.length < 100 ? sock : path.join(os.tmpdir(), `jarvis-${tag}.sock`); // socket paths are short on macOS
}

export const pidFile = (dataDir) => path.join(dataDir, 'jarvis.pid');

/** In the app: answer "quit" on the control socket. Returns a function that closes it. */
export function listen(dataDir, onQuit) {
  const address = controlAddress(dataDir);
  const server = net.createServer((sock) => {
    sock.setEncoding('utf8');
    sock.on('data', (line) => {
      if (line.trim() !== 'quit') return sock.end('?\n');
      sock.end('bye\n');
      onQuit();
    });
    sock.on('error', () => {});
  });
  server.on('error', () => {}); // stopping by pid still works
  if (process.platform !== 'win32') fs.rmSync(address, { force: true }); // left by a crash; the single-instance lock says no one else owns it
  server.listen(address);
  fs.writeFileSync(pidFile(dataDir), String(process.pid));
  return () => {
    server.close();
    if (process.platform !== 'win32') fs.rmSync(address, { force: true });
    try { if (fs.readFileSync(pidFile(dataDir), 'utf8').trim() === String(process.pid)) fs.rmSync(pidFile(dataDir)); } catch { /* gone */ }
  };
}

/** From the stop script: ask politely. Resolves true if Jarvis said it is quitting. */
export function askToQuit(dataDir, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const sock = net.connect(controlAddress(dataDir));
    const done = (ok) => { clearTimeout(timer); sock.destroy(); resolve(ok); };
    const timer = setTimeout(() => done(false), timeoutMs);
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write('quit\n'));
    sock.on('data', (d) => done(d.startsWith('bye')));
    sock.on('error', () => done(false));
  });
}
