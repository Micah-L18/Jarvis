import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Memory } from '../src/main/memory.js';
import { scan, expand } from '../src/main/fsscan.js';
import { builtinTools } from '../src/main/tools.js';
import { locate, chainTo, describeHit } from '../src/main/pointer.js';
import { InteractionGuard, pickMention, expandToPath } from '../src/renderer/focus.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-focus-'));
const put = (root, rel, text = 'x') => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};

/** A memory like the user's (three projects, people and a document), and a folder tree beside it. */
function world() {
  const data = tmp();
  const root = path.join(data, 'home');
  put(root, 'docs/notes.md', '# Notes');
  put(root, 'docs/roster.csv', 'name');
  put(root, 'media/fox.wav');
  put(root, 'work/clients/acme/2026/q3/invoice-417.pdf');
  put(root, 'Lisbon Trip/itinerary.txt');
  const memory = new Memory(data);
  memory.createProject('U14 Volleyball', 'The under-14 team.');
  memory.upsert({ label: 'Maya', type: 'person', summary: 'Keeps score.' });
  memory.upsert({ label: 'Serve Receive', type: 'topic', summary: 'Weakest skill.' });
  memory.upsert({ label: 'Roster', type: 'topic', summary: 'Who plays where.' });
  const doc = memory.saveDocument(null, 'Thursday Practice Plan', '# Plan\n\nWarm up.');
  memory.createProject('Lisbon Trip', 'June.');
  memory.upsert({ label: 'Sam', type: 'person', summary: 'Travel buddy.' });
  memory.createProject('Home Battery Research', '');
  // memory files one node per label, but two can share one after an edit: a second Maya, the installer
  memory.nodes.set('person:maya:2', { id: 'person:maya:2', label: 'Maya', type: 'person', summary: 'The installer.', project: 'project:home-battery-research', weight: 1 });
  memory.setActiveProject('U14 Volleyball');
  return { data, root, memory, doc };
}

test('point_to resolution: memories by id, exact label, any case, then loosely; documents are memories too', async () => {
  const { root, memory, doc } = world();
  const at = (target, map) => locate(target, { map, memory, root });
  const u14 = memory.findProject('U14 Volleyball');
  for (const t of [u14.id, 'U14 Volleyball', 'u14 volleyball', 'the U14 volleyball project', 'volleyball', 'U14 Voleyball']) {
    const hit = await at(t);
    assert.equal(hit.map, 'mind', t);
    assert.equal(hit.node.id, u14.id, t);
  }
  const plan = await at('thursday practice plan');
  assert.equal(plan.node.type, 'document');
  assert.equal((await at(doc.file)).node.id, plan.node.id, 'a saved document by its path is its node on the Mind map');
  assert.match(describeHit(plan, root), /document "Thursday Practice Plan" on the Mind map/);
});

test('point_to resolution: paths and file names go to the Files map, with the folders down to them', async () => {
  const { root, memory } = world();
  const at = (target, map) => locate(target, { map, memory, root });
  const notes = await at('notes.md');
  assert.equal(notes.map, 'files');
  assert.equal(notes.path, path.join(root, 'docs/notes.md'));
  assert.deepEqual(notes.chain.map((c) => [c.name, c.depth, c.dir, c.parent]), [['docs', 1, true, root], ['notes.md', 2, false, path.join(root, 'docs')]]);
  assert.equal((await at('the notes file')).path, notes.path, '"notes" is notes.md when no memory is called that');
  assert.equal((await at('docs/notes.md')).path, notes.path);
  assert.equal((await at(path.join(root, 'docs/notes.md'))).path, notes.path);
  const deep = await at('invoice-417.pdf');
  assert.equal(deep.chain.length, 6);
  assert.equal(deep.chain.at(-1).kind, 'pdf');
  const folder = await at('clients');
  assert.equal(folder.map, 'files');
  assert.equal(folder.dir, true);
  assert.match(describeHit(folder, root), /the folder clients on the Files map \(work\/clients/);
});

test('point_to resolution: close calls, ties, a forced map, misses and the outside of the root', async () => {
  const { root, memory } = world();
  const at = (target, map) => locate(target, { map, memory, root });
  // "Roster" is a memory and roster.csv a file: the bare name is the memory, the file name the file
  assert.equal((await at('roster')).map, 'mind');
  assert.equal((await at('roster.csv')).map, 'files');
  assert.equal((await at('roster', 'files')).path, path.join(root, 'docs/roster.csv'));
  // "Lisbon Trip" is a project and a folder: same name, the memory wins; asked for files, the folder
  assert.equal((await at('Lisbon Trip')).map, 'mind');
  assert.equal((await at('Lisbon Trip', 'files')).path, path.join(root, 'Lisbon Trip'));
  // called a file, it is the file, even with a memory of the same name (the background filer sometimes keeps one)
  memory.upsert({ label: 'Notes File', type: 'fact', summary: 'The notes are in docs.' });
  assert.equal((await at('the notes file')).map, 'files');
  assert.equal((await at('Notes File')).map, 'files');
  assert.equal((await at('notes', 'mind')).node.label, 'Notes File');
  memory.forget('Notes File');
  // two people called Maya: the one in the active project, and the other is named as also matching
  const maya = await at('Maya');
  assert.equal(maya.node.project, memory.findProject('U14 Volleyball').id);
  memory.setActiveProject('Home Battery Research');
  assert.equal((await at('Maya')).node.project, memory.findProject('Home Battery Research').id);
  // not on the map: a note and the nearest things
  const miss = await at('Serve practice drills');
  assert.equal(miss.map, null);
  assert.match(describeHit(miss, root), /not on either map\. Closest: .*Serve Receive \(topic, Mind map\)/);
  assert.equal((await at('Sam', 'files')).map, null);
  // outside the root, plainly or through a link
  const out = await at('/etc/passwd');
  assert.equal(out.outside, true);
  assert.match(describeHit(out, root), /outside the folder I am allowed to see/);
  assert.equal((await at('../elsewhere/notes.md')).outside, true);
  const away = tmp();
  put(away, 'secret.txt');
  fs.symlinkSync(away, path.join(root, 'linked'));
  assert.equal((await at('linked/secret.txt')).outside, true);
});

test('tools: point_to, show_view focus, show_file and memory tools send the window to the right place', async () => {
  const { data, root, memory } = world();
  const ui = [];
  const tools = Object.fromEntries(builtinTools({ memory, skills: null, settings: null, ui: (e) => ui.push(e), fsRoot: () => root, openPath() {} }).map((t) => [t.name, t]));
  assert.match(await tools.point_to.run({ target: 'u14 volleyball' }), /project "U14 Volleyball" on the Mind map/);
  assert.deepEqual(ui.pop(), { type: 'point', map: 'mind', id: 'project:u14-volleyball', label: 'U14 Volleyball' });
  assert.match(await tools.point_to.run({ target: 'invoice-417.pdf' }), /file invoice-417\.pdf on the Files map/);
  const e = ui.pop();
  assert.equal(e.map, 'files');
  assert.equal(e.chain.length, 6);
  assert.match(await tools.point_to.run({ target: '/etc/hosts' }), /outside/);
  assert.equal(ui.length, 0, 'nothing to show, nothing sent');
  // show_view with a focus resolves on that map only
  assert.match(await tools.show_view.run({ view: 'files', focus: 'roster' }), /roster\.csv/);
  assert.equal(ui.pop().id, path.join(root, 'docs/roster.csv'));
  assert.match(await tools.show_view.run({ view: 'mind', focus: 'nobody here' }), /Showing mind\. "nobody here" is not on the Mind map/);
  assert.deepEqual(ui.pop(), { type: 'view', view: 'mind' });
  // show_file: the viewer, and the Files map behind it, quietly
  await tools.show_file.run({ path: 'work/clients/acme/2026/q3/invoice-417.pdf' });
  const [shown, behind] = ui.splice(0);
  assert.equal(shown.type, 'show_file');
  assert.equal(behind.type, 'point');
  assert.equal(behind.quiet, true);
  assert.equal(behind.id, path.join(root, 'work/clients/acme/2026/q3/invoice-417.pdf'));
  // a saved document opens over the Mind map, at its node
  await tools.open_document.run({ title: 'Thursday Practice Plan' });
  assert.equal(ui.pop().map, 'mind');
  // memory bookkeeping only nudges a map already on screen
  await tools.switch_project.run({ name: 'Lisbon Trip' });
  assert.deepEqual(ui.pop(), { type: 'point', map: 'mind', id: 'project:lisbon-trip', label: 'Lisbon Trip', soft: true });
  await tools.remember.run({ label: 'Tram 28', type: 'fact', summary: 'Goes to Alfama.' });
  assert.equal(ui.pop().soft, true);
  assert.ok(data);
});

test('pickMention: one thing named outright, or nothing', () => {
  const c = [
    { key: 'p', label: 'U14 Volleyball' }, { key: 'v', label: 'Volleyball' }, { key: 'm', label: 'Maya' },
    { key: 'j', label: 'Jordan' }, { key: 'n', label: 'Notes' }, { key: 'b', label: 'Budget' }, { key: 'x', label: 'AI' },
    { key: 'f', label: 'roster.csv' }, { key: 's1', label: 'Sam' }, { key: 's2', label: 'Sam' },
  ];
  const pick = (text) => pickMention(text, c)?.key ?? null;
  assert.equal(pick("How's the U14 volleyball project going?"), 'p', 'a longer name swallows the one inside it');
  assert.equal(pick('what did maya say about thursday'), 'm');
  assert.equal(pick('open roster.csv please'), 'f');
  assert.equal(pick('Volleyball is fun'), 'v');
  assert.equal(pick('Maya and Jordan'), null, 'two things named: no focus');
  assert.equal(pick('ask Sam'), null, 'two things share the name: no focus');
  assert.equal(pick('read my notes'), null, 'common words are never focused');
  assert.equal(pick("what's the budget"), null);
  assert.equal(pick('tell me about AI'), null, 'labels shorter than three characters are never focused');
  assert.equal(pick('Mayan ruins'), null, 'whole words only');
  assert.equal(pick(''), null);
});

test('expandToPath: folders open level by level down to a path, the rest of the map left as it was', async () => {
  const root = tmp();
  put(root, 'a/one.txt');
  put(root, 'a/b/two.txt');
  put(root, 'a/b/c/d/deep.md');
  put(root, 'a/b/c/d/side.md');
  put(root, 'z.txt');
  const { nodes } = await scan(root, { maxDepth: 1 });
  const before = new Map(nodes.map((n) => [n.id, n]));
  nodes.find((n) => n.name === 'a').x = 12; // a laid-out node
  const target = path.join(root, 'a/b/c/d/deep.md');
  const chain = await chainTo(path.resolve(root), target);
  const calls = [];
  const added = await expandToPath(nodes, chain, (dir, depth) => { calls.push(path.relative(root, dir)); return expand(dir, depth); });
  assert.deepEqual(calls, ['', 'a', path.join('a', 'b'), path.join('a', 'b', 'c'), path.join('a', 'b', 'c', 'd')].slice(1), 'only folders not yet open are listed, top down');
  const byId = new Map(nodes.map((n) => [n.id, n]));
  assert.ok(byId.has(target));
  assert.ok(byId.has(path.join(root, 'a/b/c/d/side.md')), 'the path arrives among its neighbours');
  assert.ok(byId.has(path.join(root, 'a/one.txt')));
  assert.equal(byId.get(target).depth, 5);
  assert.equal(new Set(nodes.map((n) => n.id)).size, nodes.length, 'nothing twice');
  for (const [id, n] of before) assert.equal(byId.get(id), n, 'existing entries are the same objects');
  assert.equal(byId.get(path.join(root, 'a')).x, 12);
  assert.equal(byId.get(path.join(root, 'a')).more, 0);
  assert.equal(added, nodes.length - before.size);
  assert.equal(await expandToPath(nodes, chain, () => { throw new Error('nothing left to open'); }), 0);
  // a folder too big to list in full: the step is added on its own
  const few = [{ id: '/r', name: 'r', parent: null, dir: true, depth: 0 }];
  const n = await expandToPath(few, [{ id: '/r/big', name: 'big', parent: '/r', dir: true, kind: 'dir', depth: 1 }, { id: '/r/big/f9999', name: 'f9999', parent: '/r/big', dir: false, kind: 'other', depth: 2 }],
    async (dir) => (dir === '/r' ? [{ id: '/r/big', name: 'big', parent: '/r', dir: true, depth: 1 }] : [{ id: '/r/big/f0', name: 'f0', parent: '/r/big', dir: false, depth: 2 }]));
  assert.equal(n, 3);
  assert.deepEqual(few.map((x) => x.id), ['/r', '/r/big', '/r/big/f0', '/r/big/f9999']);
});

test('InteractionGuard: a camera move waits while the user has the view, and only the latest one', () => {
  let now = 0;
  const timers = [];
  const clock = { set: (fn, ms) => { const t = { fn, at: now + ms }; timers.push(t); return t; }, clear: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); } };
  const advance = (ms) => {
    const end = now + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const t = timers[0];
      if (!t || t.at > end) break;
      timers.shift();
      now = t.at;
      t.fn();
    }
    now = end;
  };
  let panelOpen = false;
  const g = new InteractionGuard({ now: () => now, timers: clock, blocked: () => (panelOpen ? 'controls open' : '') });
  const ran = [];
  assert.equal(g.busy(), '');
  assert.equal(g.run(() => ran.push('a')), 'now');
  g.down(); // dragging
  assert.equal(g.busy(), 'holding the view');
  assert.equal(g.run(() => ran.push('b')), 'deferred');
  assert.equal(g.run(() => ran.push('c')), 'deferred');
  advance(3000);
  assert.deepEqual(ran, ['a'], 'nothing moves while the button is held');
  g.up();
  advance(1500);
  assert.deepEqual(ran, ['a'], 'nor just after letting go');
  advance(1000);
  assert.deepEqual(ran, ['a', 'c'], 'then the latest request runs, once');
  advance(5000);
  assert.deepEqual(ran, ['a', 'c']);
  // the controls being open holds a move back; past the wait it is dropped
  panelOpen = true;
  assert.equal(g.busy(), 'controls open');
  g.run(() => ran.push('d'));
  advance(11000);
  panelOpen = false;
  advance(1000);
  assert.deepEqual(ran, ['a', 'c'], 'a move that waited too long is dropped');
  g.touch(); // a scroll of the wheel counts as having the view
  assert.equal(g.busy(), 'just moved the view');
});
