import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileUrl, dirOf, formatBytes, middle, looksBinary, parseCsv, resolveLocal } from '../src/renderer/viewkit.js';
import { pathFromUrl } from '../src/main/fileproto.js';
import { Voice } from '../src/renderer/voice.js';

test('viewer: fileUrl is what the protocol reads back', () => {
  for (const p of ['/a/b c.png', '/x/%20#?.md', '/ü/日本/model.glb']) assert.equal(pathFromUrl(fileUrl(p)), p);
});

test('viewer: dirOf, formatBytes, middle', () => {
  assert.equal(dirOf('/a/b/c.gltf'), '/a/b/');
  assert.equal(dirOf('C:\\m\\x.obj'), 'C:\\m\\');
  assert.equal(dirOf('x.obj'), '');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(160 * 1024 * 1024), '160 MB');
  assert.equal(formatBytes(NaN), '');
  const long = `/very/${'deep/'.repeat(40)}file.txt`;
  assert.equal(middle(long).length, 96);
  assert.ok(middle(long).endsWith('file.txt'));
  assert.equal(middle('/short'), '/short');
});

test('viewer: binary sniffing', () => {
  assert.equal(looksBinary(new TextEncoder().encode('plain text\n\twith tabs\r\n')), false);
  assert.equal(looksBinary(new TextEncoder().encode('ümlauts and emoji 🚀')), false);
  assert.equal(looksBinary(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1])), true);
  assert.equal(looksBinary(new Uint8Array(100).fill(3)), true);
  assert.equal(looksBinary(new Uint8Array(0)), false);
});

test('viewer: csv reading', () => {
  assert.deepEqual(parseCsv('a,b\n1,2\n', ','), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseCsv('a,"b, c","say ""hi"""\r\nx,"multi\nline",z', ','), [['a', 'b, c', 'say "hi"'], ['x', 'multi\nline', 'z']]);
  assert.deepEqual(parseCsv('a\tb\n1\t2', '\t'), [['a', 'b'], ['1', '2']]);
  assert.equal(parseCsv('h\n1\n2\n3\n4\n', ',', 3).length, 3);
  assert.deepEqual(parseCsv('a,,c', ','), [['a', '', 'c']]);
});

test('viewer: markdown links and images resolve next to the file, never above the root', () => {
  assert.equal(resolveLocal('/home/me/notes/', 'pic.png'), '/home/me/notes/pic.png');
  assert.equal(resolveLocal('/home/me/notes/', './img/a%20b.png?x#y'), '/home/me/notes/img/a b.png');
  assert.equal(resolveLocal('/home/me/notes/', '../other/plan.md'), '/home/me/other/plan.md');
  assert.equal(resolveLocal('/home/me/notes/', '/etc/passwd'), '/etc/passwd'); // absolute: the protocol decides
  assert.equal(resolveLocal('/a/', '../../../x'), null);
  assert.equal(resolveLocal('C:\\docs\\', 'img\\a.png'), 'C:\\docs\\img\\a.png');
  assert.equal(resolveLocal('/a/', '%E0%A4%A'), null);
});

test('voice: hands-free listening is held while something else plays, push-to-talk still works', () => {
  const states = [];
  const heard = [];
  globalThis.window = { jarvis: { invoke: async () => 'text' } };
  const voice = new Voice({ onUtterance: (t) => heard.push(t), onState: (s) => states.push(s), onStatus: () => {}, onBargeIn: () => {}, settings: () => ({ handsFree: true, bargeIn: true, tts: 'off' }) });
  voice.ctx = { sampleRate: 16000 };
  const feed = (level, n) => { for (let i = 0; i < n; i++) voice._onFrame(new Float32Array(320).fill(level)); };
  feed(0.1, 10);
  assert.ok(voice.capture, 'listening normally');
  voice.hold('viewer', true);
  assert.equal(voice.capture, null, 'a remark in progress is dropped when the video starts');
  assert.equal(states.at(-1), 'idle');
  feed(0.2, 60);
  assert.equal(voice.capture, null, 'the soundtrack is not the user');
  voice.pushToTalk(true);
  feed(0.1, 5);
  assert.ok(voice.capture, 'push-to-talk still records');
  voice.pushToTalk(false);
  voice.hold('viewer', false);
  feed(0.1, 10);
  assert.ok(voice.capture, 'listening again once the video stops');
});
