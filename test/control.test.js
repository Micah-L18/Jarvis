import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { dataDirFor, controlAddress, listen, askToQuit, pidFile } from '../src/main/control.js';

test('control: the data folder matches where Electron keeps it on each platform', () => {
  assert.equal(dataDirFor({}, 'linux', '/home/a'), '/home/a/.config/jarvis');
  assert.equal(dataDirFor({ XDG_CONFIG_HOME: '/x' }, 'linux', '/home/a'), '/x/jarvis');
  assert.equal(dataDirFor({}, 'darwin', '/Users/a'), '/Users/a/Library/Application Support/jarvis');
  assert.equal(dataDirFor({ APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, 'win32', 'C:\\Users\\a'), path.join('C:\\Users\\a\\AppData\\Roaming', 'jarvis'));
  assert.equal(dataDirFor({ JARVIS_DATA_DIR: '/data/j' }, 'linux', '/home/a'), '/data/j');
});

test('control: a named pipe on Windows, a short socket path elsewhere', () => {
  assert.match(controlAddress('C:\\x', 'win32'), /^\\\\\.\\pipe\\jarvis-[0-9a-f]{12}$/);
  assert.equal(controlAddress('/home/a/.config/jarvis', 'linux'), '/home/a/.config/jarvis/jarvis.sock');
  assert.match(controlAddress(`/${'d'.repeat(120)}`, 'darwin'), /jarvis-[0-9a-f]{12}\.sock$/);
});

test('control: "quit" on the socket reaches the app, and closing cleans up', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-'));
  let quits = 0;
  const close = listen(dir, () => quits++);
  assert.equal(fs.readFileSync(pidFile(dir), 'utf8'), String(process.pid));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(await askToQuit(dir), true);
  assert.equal(quits, 1);
  close();
  assert.equal(fs.existsSync(pidFile(dir)), false);
  assert.equal(await askToQuit(dir, 500), false, 'nothing answers once closed');
});
