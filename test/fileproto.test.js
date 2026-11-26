import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { allowedPath, pathFromUrl, fileUrl, parseRange } from '../src/main/fileproto.js';

test('fileUrl and pathFromUrl round-trip, including odd names', () => {
  for (const p of ['/home/me/a b/c#d?.png', '/tmp/ümlaut/%41.txt', '/x/y.glb']) assert.equal(pathFromUrl(fileUrl(p)), p);
  assert.equal(pathFromUrl('jarvis-file://other/%2Fetc%2Fpasswd'), null);
  assert.equal(pathFromUrl('file:///etc/passwd'), null);
  assert.equal(pathFromUrl('jarvis-file://local/relative.txt'), null);
  assert.equal(pathFromUrl('jarvis-file://local/%2Fa%00b'), null);
  assert.equal(pathFromUrl('jarvis-file://local/%E0%A4%A'), null);
  assert.equal(pathFromUrl(fileUrl('/root/../etc/passwd')), '/etc/passwd'); // normalised, then judged by allowedPath
});

test('allowedPath keeps to the roots, follows symlinks, refuses ../ and escapes', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-proto-'));
  const root = path.join(base, 'root');
  const docs = path.join(base, 'docs');
  const outside = path.join(base, 'outside');
  for (const d of [root, docs, outside, path.join(root, 'sub')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(root, 'sub', 'a.txt'), 'a');
  fs.writeFileSync(path.join(docs, 'plan.md'), 'b');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'c');
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
  fs.symlinkSync(outside, path.join(root, 'linkdir'));
  fs.symlinkSync(path.join(root, 'sub', 'a.txt'), path.join(root, 'inner.txt'));
  fs.symlinkSync(root, path.join(base, 'rootlink'));
  const roots = [root, docs];
  try {
    assert.equal(allowedPath(path.join(root, 'sub', 'a.txt'), roots), fs.realpathSync(path.join(root, 'sub', 'a.txt')));
    assert.ok(allowedPath(path.join(docs, 'plan.md'), roots));
    assert.ok(allowedPath(path.join(root, 'inner.txt'), roots), 'a link that stays inside is fine');
    assert.ok(allowedPath(root, roots), 'the root itself');
    assert.equal(allowedPath(path.join(root, 'link.txt'), roots), null, 'symlinked file escaping the root');
    assert.equal(allowedPath(path.join(root, 'linkdir', 'secret.txt'), roots), null, 'symlinked folder escaping the root');
    assert.equal(allowedPath(path.join(root, '..', 'outside', 'secret.txt'), roots), null, '../');
    assert.equal(allowedPath(`${root}-evil/x`, roots), null, 'a sibling sharing the prefix');
    assert.equal(allowedPath(path.join(root, 'missing.txt'), roots), null, 'missing files');
    assert.equal(allowedPath('relative/a.txt', roots), null);
    assert.equal(allowedPath(null, roots), null);
    assert.ok(allowedPath(path.join(root, 'sub', 'a.txt'), [path.join(base, 'rootlink')]), 'a root given through a symlink');
    assert.equal(allowedPath(path.join(root, 'sub', 'a.txt'), ['', null, path.join(base, 'nope')]), null);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('allowedPath with an injected realpath (pure)', () => {
  const real = (p) => ({ '/r': '/r', '/r/x': '/r/x', '/r/esc': '/etc/passwd' })[p] ?? (() => { throw new Error('ENOENT'); })();
  assert.equal(allowedPath('/r/x', ['/r'], real), '/r/x');
  assert.equal(allowedPath('/r/esc', ['/r'], real), null);
  assert.equal(allowedPath('/r/none', ['/r'], real), null);
});

test('allowedPath never touches the disk for a path outside every root (a UNC path would connect on Windows)', () => {
  const seen = [];
  const real = (p) => { seen.push(p); return p; };
  assert.equal(allowedPath('/far/away/secret', ['/home/root'], real), null);
  assert.equal(allowedPath('/home/root-evil/x', ['/home/root'], real), null);
  assert.equal(allowedPath('/home/root/../elsewhere/x', ['/home/root'], real), null);
  assert.deepEqual(seen.filter((p) => !p.startsWith('/home/root') || p.includes('evil') || p.includes('elsewhere')), [], 'only the roots were looked at');
  assert.equal(allowedPath('/home/root/a.txt', ['/home/root'], real), '/home/root/a.txt');
  assert.ok(seen.includes('/home/root/a.txt'));
  // A root reached through a link: a path under the link's target is inside, as written.
  const linked = (p) => (p === '/link' ? '/data' : p);
  assert.equal(allowedPath('/data/x', ['/link'], linked), '/data/x');
});

test('parseRange', () => {
  assert.equal(parseRange(null, 100), null);
  assert.deepEqual(parseRange('bytes=0-9', 100), { start: 0, end: 9 });
  assert.deepEqual(parseRange('bytes=90-', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=0-1000', 100), { start: 0, end: 99 });
  assert.equal(parseRange('bytes=100-', 100), 'bad');
  assert.equal(parseRange('bytes=5-2', 100), 'bad');
  assert.equal(parseRange('bytes=-', 100), 'bad');
  assert.equal(parseRange('items=0-1', 100), 'bad');
  assert.equal(parseRange('bytes=0-1,4-5', 100), 'bad');
});
