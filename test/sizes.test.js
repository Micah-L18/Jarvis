import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sizeScale, formatBytes, folderTotals, sizeText } from '../src/renderer/sizes.js';
import { scan, expand } from '../src/main/fsscan.js';
import { DirSizer } from '../src/main/dirsize.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-sizes-'));
const put = (root, rel, bytes) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), Buffer.alloc(bytes, 97));
};
const KB = 1024, MB = KB * KB, GB = MB * KB;

test('sizes: marker scale grows on a log scale, clamped at both ends', () => {
  assert.equal(sizeScale(0), 1, 'zero bytes gets the smallest marker');
  assert.equal(sizeScale(undefined), 1);
  assert.equal(sizeScale(-5), 1);
  assert.equal(sizeScale(500), 1);
  assert.equal(sizeScale(KB), 1);
  const gb = sizeScale(GB);
  assert.ok(gb >= 3 && gb <= 4, `1 GB is 3-4x the smallest (${gb})`);
  assert.ok(Math.abs(sizeScale(MB) - (1 + gb) / 2) < 1e-9, '1 MB sits halfway between 1 KB and 1 GB');
  let last = 1;
  for (let b = 2 * KB; b <= 64 * GB; b *= 2) {
    const s = sizeScale(b);
    assert.ok(s >= last, 'never shrinks as bytes grow');
    last = s;
  }
  assert.ok(sizeScale(1024 * GB) <= 4.2, 'a huge file cannot swamp the view');
  assert.equal(sizeScale(1024 * GB), sizeScale(64 * GB), 'clamped past about 16 GB');
});

test('sizes: bytes read the way people say them', () => {
  assert.equal(formatBytes(0), '0 bytes');
  assert.equal(formatBytes(1), '1 byte');
  assert.equal(formatBytes(820), '820 bytes');
  assert.equal(formatBytes(14 * KB), '14 KB');
  assert.equal(formatBytes(2.4 * MB), '2.4 MB');
  assert.equal(formatBytes(1.25 * GB), '1.3 GB');
  assert.equal(formatBytes(1500 * GB), '1.5 TB');
  assert.equal(formatBytes(512 * MB), '512 MB');
});

test('sizes: folder totals add up what is listed, and say "at least" until measured', () => {
  const nodes = [
    { id: '/r', parent: null, dir: true },
    { id: '/r/a', parent: '/r', dir: true },
    { id: '/r/a/x.bin', parent: '/r/a', dir: false, bytes: 3 * MB },
    { id: '/r/a/y.txt', parent: '/r/a', dir: false, bytes: 1000 },
    { id: '/r/b', parent: '/r', dir: true, more: 4 }, // has children not listed
    { id: '/r/b/z', parent: '/r/b', dir: false, bytes: 10 },
    { id: '/r/c', parent: '/r', dir: true, hidden: 1 }, // a dot file inside
    { id: '/r/top.md', parent: '/r', dir: false, bytes: 5 },
  ];
  let t = folderTotals(nodes);
  assert.deepEqual(t.get('/r/a'), { bytes: 3 * MB + 1000, files: 2, exact: true });
  assert.deepEqual(t.get('/r/b'), { bytes: 10, files: 1, exact: false });
  assert.deepEqual(t.get('/r/c'), { bytes: 0, files: 0, exact: false });
  assert.deepEqual(t.get('/r'), { bytes: 3 * MB + 1000 + 10 + 5, files: 4, exact: false }, 'a parent is only exact when all of it is');
  assert.equal(sizeText(nodes[0], t.get('/r')), 'at least 3 MB · 4 files');
  assert.equal(sizeText(nodes[1], t.get('/r/a')), '3 MB · 2 files');
  assert.equal(sizeText(nodes[2]), '3 MB');
  assert.equal(sizeText({ dir: false }), '', 'no size known, no line');

  // measured in the background: a finished walk replaces the sum, an unfinished one raises the floor
  const walked = new Map([
    ['/r/b', { bytes: 2 * GB, files: 3410, complete: true }],
    ['/r/c', { bytes: 40, files: 1, complete: true }],
    ['/r', { bytes: 100, files: 2, complete: false }],
  ]);
  t = folderTotals(nodes, walked);
  assert.deepEqual(t.get('/r/b'), { bytes: 2 * GB, files: 3410, exact: true });
  assert.equal(sizeText(nodes[4], t.get('/r/b')), '2 GB · 3,410 files');
  assert.deepEqual(t.get('/r'), { bytes: 2 * GB + 3 * MB + 1000 + 40 + 5, files: 3414, exact: true }, 'every part known: the sum is exact');
  walked.set('/r/b', { bytes: 5 * GB, files: 9000, complete: false });
  t = folderTotals(nodes, walked);
  assert.equal(t.get('/r/b').exact, false);
  assert.equal(t.get('/r/b').bytes, 5 * GB, 'a cut-short walk still beats the listed sum');
  assert.match(sizeText(nodes[0], t.get('/r')), /^at least 5 GB · 9,00\d files$/);
});

test('sizes: the scan gives file sizes and notes what it hides', async () => {
  const root = tmp();
  put(root, 'a/big.bin', 50000);
  put(root, 'a/.secret', 7);
  put(root, 'a/node_modules/dep/index.js', 9);
  put(root, 'empty.txt', 0);
  const { nodes } = await scan(root, { maxDepth: 3, bytes: true });
  const by = Object.fromEntries(nodes.map((n) => [path.relative(root, n.id) || '.', n]));
  assert.equal(by['a/big.bin'].bytes, 50000);
  assert.equal(by['empty.txt'].bytes, 0);
  assert.equal(by.a.hidden, 2, 'the dot file and node_modules');
  const t = folderTotals(nodes);
  assert.equal(t.get(by.a.id).exact, false, 'hidden things inside: needs measuring');
  assert.equal(t.get(by.a.id).bytes, 50000);
  const kids = await expand(by.a.id, by.a.depth);
  assert.equal(kids.find((n) => n.name === 'big.bin').bytes, 50000);
});

test('sizes: background walk measures everything, remembers it, and stops at its budget', async () => {
  const root = tmp();
  put(root, 'a/one.bin', 1000);
  put(root, 'a/deep/two.bin', 2000);
  put(root, 'a/.hidden', 30);
  put(root, 'b/three.bin', 4000);
  for (let i = 0; i < 40; i++) put(root, `wide/f${i}.txt`, 10);
  const sizer = new DirSizer();
  const done = [];
  const r = await sizer.walk(root, { until: Date.now() + 5000, entries: 1e6 }, (d) => done.push(path.relative(root, d)));
  assert.deepEqual(r, { bytes: 1000 + 2000 + 30 + 4000 + 400, files: 44, complete: true });
  assert.ok(done.includes('a/deep') && done.includes('a') && done.includes(''), 'every folder it finished is reported');
  assert.ok(sizer.cache.has(path.join(root, 'a')));

  // a second look costs a stat per folder: the cache answers, even if the files were gone
  const real = fs.promises.readdir;
  let reads = 0;
  fs.promises.readdir = (...a) => { reads++; return real(...a); };
  try {
    const again = await sizer.walk(path.join(root, 'a'), { until: Date.now() + 5000, entries: 1e6 });
    assert.equal(again.bytes, 3030);
    assert.equal(reads, 0);
  } finally {
    fs.promises.readdir = real;
  }
  // a folder that changed (its mtime moved) is walked again
  put(root, 'a/new.bin', 500);
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(root, 'a'), later, later);
  assert.equal((await sizer.walk(path.join(root, 'a'), { until: Date.now() + 5000, entries: 1e6 })).bytes, 3530);

  // out of budget: a lower bound, marked unfinished, and nothing half-counted is remembered
  const fresh = new DirSizer();
  const cut = await fresh.walk(root, { until: Date.now() + 5000, entries: 3 });
  assert.equal(cut.complete, false);
  assert.ok(cut.bytes < 7930);
  assert.equal(fresh.cache.has(root), false);
});

test('sizes: measure reports each folder, retries the unfinished, and a new request replaces the old', async () => {
  const root = tmp();
  for (const q of ['q1', 'q2', 'q3']) for (let i = 0; i < 15; i++) put(root, `p/${q}/f${i}.bin`, 100);
  put(root, 'p/top.bin', 7);
  put(root, 'r/s.bin', 9);
  const sizer = new DirSizer();
  const got = new Map();
  const seen = [];
  // 25 entries a walk: p's first walk opens q1 and q2, not q3, so p is unfinished until it is tried again
  await sizer.measure([path.join(root, 'p'), path.join(root, 'r')], (d, res) => { seen.push([path.relative(root, d), res.complete]); got.set(path.relative(root, d), res); }, { entries: 25 });
  assert.deepEqual(seen, [['p', false], ['r', true], ['p', true]]);
  assert.deepEqual(got.get('p'), { bytes: 4507, files: 46, complete: true }, 'the second try reuses the remembered subfolders');
  assert.deepEqual(got.get('r'), { bytes: 9, files: 1, complete: true });

  const late = [];
  const first = sizer.measure([path.join(root, 'r')], (d) => late.push(d));
  sizer.stop();
  await first;
  assert.ok(late.length <= 1);
});
