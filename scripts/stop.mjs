// npm stop: asks a running Jarvis to quit, the same as closing it. With --force, or if it does not
// answer, the process recorded in its pid file is ended instead (only if it is still Jarvis).
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dataDirFor, pidFile, askToQuit } from '../src/main/control.js';

const force = process.argv.includes('--force');
const dir = dataDirFor();
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readPid = () => { try { return Number(fs.readFileSync(pidFile(dir), 'utf8').trim()) || 0; } catch { return 0; } };

/** The pid file can outlive the app, and pids get reused: only end a process that is Electron. */
function isJarvis(pid) {
  try {
    const cmd = process.platform === 'win32'
      ? execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' })
      : execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
    return /electron|jarvis/i.test(cmd);
  } catch { return false; }
}

async function gone(pid, ms) {
  for (let t = 0; t < ms; t += 200) {
    if (!pid || !alive(pid)) return true;
    await sleep(200);
  }
  return !alive(pid);
}

const pid = readPid();
if (!force && (await askToQuit(dir))) {
  if (await gone(pid, 10000)) { console.log('Jarvis stopped.'); process.exit(0); }
  console.log('Jarvis is taking a while to close; ending it.');
}
if (!pid || !alive(pid)) {
  fs.rmSync(pidFile(dir), { force: true });
  console.log('Jarvis is not running.');
  process.exit(0);
}
if (!isJarvis(pid)) {
  fs.rmSync(pidFile(dir), { force: true });
  console.log('Jarvis is not running (its old pid file pointed at another program, so I left that alone).');
  process.exit(0);
}
if (process.platform === 'win32') {
  try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* checked below */ }
} else {
  process.kill(pid, 'SIGTERM');
  if (!(await gone(pid, 5000))) process.kill(pid, 'SIGKILL');
}
if (await gone(pid, 3000)) { fs.rmSync(pidFile(dir), { force: true }); console.log('Jarvis stopped.'); }
else { console.log(`Could not stop Jarvis (pid ${pid}).`); process.exit(1); }
