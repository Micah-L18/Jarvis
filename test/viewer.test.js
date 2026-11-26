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
  const u16 = new Uint8Array([0xff, 0xfe, ...new Uint8Array(Buffer.from('name,age\r\nAna,30', 'utf16le'))]);
  assert.equal(looksBinary(u16), false, 'UTF-16 (Excel "Unicode Text", PowerShell 5) is text');
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

test('media: a recording too long for Chromium to decode whole is cut into pieces that each decode alone', async () => {
  const { wavPieces, mp3Pieces } = await import('../src/renderer/media.js');
  // a 16-bit stereo WAV of 1000 frames with an extra chunk before the data
  const frames = 1000;
  const wav = new ArrayBuffer(12 + 24 + 12 + 8 + frames * 4);
  const v = new DataView(wav);
  const put = (at, s) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  put(0, 'RIFF'); v.setUint32(4, wav.byteLength - 8, true); put(8, 'WAVE');
  put(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true); v.setUint32(24, 44100, true); v.setUint32(28, 176400, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true);
  put(36, 'LIST'); v.setUint32(40, 4, true); put(44, 'INFO');
  put(48, 'data'); v.setUint32(52, frames * 4, true);
  for (let i = 0; i < frames * 2; i++) v.setInt16(56 + i * 2, i, true);
  assert.equal(wavPieces(wav), null, 'short enough: decoded whole');
  const pieces = wavPieces(wav, { pieceFrames: 300, limit: 500 }).map((make) => new DataView(make()));
  assert.equal(pieces.length, 4);
  assert.deepEqual(pieces.map((p) => p.getUint32(52, true)), [1200, 1200, 1200, 400], 'data sizes');
  assert.ok(pieces.every((p) => p.getUint32(4, true) === p.byteLength - 8), 'RIFF sizes');
  assert.equal(pieces[1].getInt16(56, true), 600, 'the second piece carries on where the first stopped');
  assert.equal(pieces[3].getInt16(56 + 199 * 2, true), 1999);
  assert.equal(wavPieces(new ArrayBuffer(100)), null, 'not a WAV');
  // an MP3: pieces start on frame headers, and nothing is lost
  const frame = [0xff, 0xfb, 0x90, 0x64, ...new Array(413).fill(0x11)];
  const mp3 = new Uint8Array([...'ID3'].map((c) => c.charCodeAt(0)).concat(new Array(20).fill(0), ...Array.from({ length: 50 }, () => frame))).buffer;
  const parts = mp3Pieces(mp3, 3).map((make) => new Uint8Array(make()));
  assert.equal(parts.length, 3);
  assert.ok(parts.slice(1).every((p) => p[0] === 0xff && p[1] === 0xfb));
  assert.equal(parts.reduce((n, p) => n + p.length, 0), mp3.byteLength);
});
