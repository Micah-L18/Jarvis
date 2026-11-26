import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Voices, parseVoice, warmEngine } from '../src/main/voices.js';
import { Settings, migrateSettings, DEFAULT_SETTINGS } from '../src/main/store.js';
import { Voice, synthVoice, speechStatus } from '../src/renderer/voice.js';

// The voice engines, stood in for: each records what it was asked to say.
function engines({ tinyFails = false, kokoroCached = true } = {}) {
  const log = [];
  const posted = [];
  const model = (name) => ({ generate: async (text, opts) => { log.push(`${name} ${text} ${JSON.stringify(opts)}`); return { audio: new Float32Array(3), sampling_rate: 24000 }; } });
  const voices = new Voices({
    loadTiny: async () => { log.push('load tiny'); if (tinyFails) throw new Error('offline'); return model('tiny'); },
    loadKokoro: async (upgrade) => { log.push(`load kokoro${upgrade ? ' (and fetch the larger copy)' : ''}`); return model('kokoro'); },
    kokoroCached: () => kokoroCached,
    post: (m) => posted.push(m),
  });
  return { voices, log, posted };
}

test('tts: the fast voice speaks when chosen, and Kokoro is never loaded for it', async () => {
  const e = engines();
  assert.equal(await e.voices.warm('tiny'), true);
  const out = await e.voices.synthesize({ text: 'Hello.', voice: { engine: 'tiny', voice: 'F2', speed: 1.15, kokoro: 'bm_george' } });
  await e.voices.synthesize({ text: 'Again.', voice: { engine: 'tiny', voice: 'M2' } });
  assert.deepEqual(e.log, ['load tiny', 'tiny Hello. {"voice":"F2","speed":1.15}', 'tiny Again. {"voice":"M2","speed":1}']);
  assert.equal(out.rate, 24000);
  assert.equal(out.audio.length, 3);
  assert.deepEqual(e.posted, [{ type: 'status', what: 'voice', done: true }], '"ready" once, which ends the download line');
});

test('tts: Kokoro speaks when chosen (also when asked the old way, by voice name) and may fetch its larger copy', async () => {
  const e = engines();
  await e.voices.synthesize({ text: 'Hi.', voice: 'bf_emma' });
  await e.voices.synthesize({ text: 'Yes.', voice: { engine: 'kokoro', kokoro: 'bm_lewis' } });
  assert.deepEqual(e.log, ['load kokoro (and fetch the larger copy)', 'kokoro Hi. {"voice":"bf_emma"}', 'load kokoro (and fetch the larger copy)', 'kokoro Yes. {"voice":"bm_lewis"}']);
  assert.equal(e.log.includes('load tiny'), false);
});

test('tts: warming up loads only the chosen voice; the system voice and silence load nothing', async () => {
  for (const [voice, loads] of [['tiny', ['load tiny']], ['kokoro', ['load kokoro (and fetch the larger copy)']], [true, ['load kokoro (and fetch the larger copy)']], ['system', []], ['off', []], [false, []]]) {
    const e = engines();
    await e.voices.warm(voice);
    assert.deepEqual(e.log, loads, String(voice));
  }
  assert.equal(warmEngine('system'), null);
});

test('tts: if the fast voice fails, Kokoro stands in when it is on disk, without fetching its larger copy, and that is said once', async () => {
  const e = engines({ tinyFails: true, kokoroCached: true });
  assert.equal(await e.voices.warm('tiny'), true);
  await e.voices.synthesize({ text: 'One.', voice: { engine: 'tiny', voice: 'M2', kokoro: 'bm_daniel' } });
  await e.voices.synthesize({ text: 'Two.', voice: { engine: 'tiny', voice: 'M2', kokoro: 'bm_daniel' } });
  assert.equal(e.log.filter((l) => l === 'load tiny').length, 1, 'not retried this session');
  assert.equal(e.log.filter((l) => l.includes('larger copy')).length, 0);
  assert.ok(e.log.includes('kokoro One. {"voice":"bm_daniel"}'));
  assert.equal(e.posted.length, 1, 'said once, in place of "voice ready"');
  assert.equal(e.posted[0].fallback, 'kokoro');
  assert.match(speechStatus(e.posted[0]).text, /using the neural voice/);
  assert.equal(speechStatus(e.posted[0]).notice, true, 'a notice of its own, not a status line that the next download line hides');
});

test('tts: if the fast voice fails and Kokoro is not on disk, the system voice speaks (synthesize gives nothing)', async () => {
  const e = engines({ tinyFails: true, kokoroCached: false });
  assert.equal(await e.voices.warm('tiny'), false);
  assert.equal(await e.voices.synthesize({ text: 'One.', voice: { engine: 'tiny' } }), null);
  assert.equal(e.log.some((l) => l.startsWith('load kokoro')), false, 'no 92 MB download as a stand-in');
  assert.equal(e.posted.length, 1, 'said once, and no "voice ready"');
  assert.match(speechStatus(e.posted[0]).text, /system voice/);
});

test('tts: if Kokoro cannot stand in either, the system voice speaks and only that is said', async () => {
  const e = engines({ tinyFails: true, kokoroCached: true });
  e.voices.loadKokoro = async () => { throw new Error('broken'); };
  assert.equal(await e.voices.synthesize({ text: 'One.', voice: { engine: 'tiny' } }), null);
  assert.equal(await e.voices.synthesize({ text: 'Two.', voice: { engine: 'tiny' } }), null);
  assert.deepEqual(e.posted.map((m) => m.fallback), ['system']);
});

test('tts: requests are cleaned up before they reach an engine', () => {
  assert.deepEqual(parseVoice({ engine: 'tiny', voice: 'X9', speed: 9 }), { engine: 'tiny', voice: 'M2', speed: 1.5, kokoro: 'bm_george' });
  assert.deepEqual(parseVoice({ engine: 'tiny', speed: 'fast' }), { engine: 'tiny', voice: 'M2', speed: 1, kokoro: 'bm_george' });
  assert.deepEqual(parseVoice(undefined), { engine: 'kokoro', kokoro: 'bm_george' });
});

test('settings: new installs get the fast voice', () => {
  assert.equal(DEFAULT_SETTINGS.voice.tts, 'tiny');
  assert.equal(DEFAULT_SETTINGS.voice.tinyVoice, 'M2');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-tts-'));
  assert.equal(new Settings(dir).get().voice.tts, 'tiny');
});

test('settings: an old saved Kokoro that was only ever the default becomes the fast voice; a real choice is kept', () => {
  const old = (voice) => ({ provider: 'local', voice: { tts: 'kokoro', kokoroVoice: 'bm_george', systemVoice: '', handsFree: true, bargeIn: true, ...voice } });
  assert.equal(migrateSettings(old()).voice.tts, 'tiny', 'every save wrote the default out: not a choice');
  assert.equal(migrateSettings(old()).provider, 'local', 'the rest is left alone');
  assert.equal(migrateSettings(old({ kokoroVoice: 'bf_emma' })).voice.tts, 'kokoro', 'picked a Kokoro voice: that is using Kokoro on purpose');
  assert.equal(migrateSettings(old({ kokoroVoice: 'bf_emma' })).voice.ttsChosen, true);
  assert.equal(migrateSettings(old({ ttsChosen: true })).voice.tts, 'kokoro', 'chosen in the controls');
  assert.equal(migrateSettings(old({ tts: 'system' })).voice.tts, 'system');
  assert.equal(migrateSettings(old({ tts: 'off' })).voice.tts, 'off');
  assert.deepEqual(migrateSettings({}), {});
  assert.equal(migrateSettings(null), null);
});

test('settings: choosing Kokoro in the controls survives the next launch', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-tts-'));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ voice: { tts: 'kokoro', kokoroVoice: 'bm_george', handsFree: false } }));
  const first = new Settings(dir);
  assert.equal(first.get().voice.tts, 'tiny');
  assert.equal(first.get().voice.handsFree, false);
  first.set({ voice: { tts: 'kokoro', ttsChosen: true } }); // what the controls send
  assert.equal(new Settings(dir).get().voice.tts, 'kokoro');
  first.set({ voice: { tts: 'tiny', ttsChosen: true } });
  assert.equal(new Settings(dir).get().voice.tts, 'tiny');
});

test('voice: each engine is asked for in its own form', () => {
  assert.deepEqual(synthVoice({ tts: 'tiny', tinyVoice: 'F2', tinySpeed: 1.15, kokoroVoice: 'bm_lewis' }), { engine: 'tiny', voice: 'F2', speed: 1.15, kokoro: 'bm_lewis' });
  assert.deepEqual(synthVoice({ tts: 'tiny' }), { engine: 'tiny', voice: 'M2', speed: 1, kokoro: undefined });
  assert.equal(synthVoice({ tts: 'kokoro', kokoroVoice: 'bf_emma' }), 'bf_emma');
  assert.equal(synthVoice({ tts: 'system' }), null);
  assert.equal(synthVoice({ tts: 'off' }), null);
});

test('voice: a sentence with nothing to pronounce is skipped, not handed to the system voice, and speech carries on', async () => {
  const asked = [];
  const spoken = [];
  globalThis.window = {
    jarvis: { invoke: async (channel, text, how) => { asked.push([channel, text, how]); return channel === 'speech:synthesize' ? { audio: new Float32Array(0), rate: 24000 } : true; } },
    speechSynthesis: { speak: (u) => { spoken.push(u.text); u.onend(); }, cancel() {}, getVoices: () => [] },
  };
  globalThis.speechSynthesis = window.speechSynthesis;
  globalThis.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
  globalThis.requestAnimationFrame = () => {};
  const states = [];
  const voice = new Voice({ onState: (s) => states.push(s), onStatus() {}, onSpoken() {}, settings: () => ({ tts: 'tiny', tinyVoice: 'F2' }) });
  voice.say('— — — ');
  voice.flush();
  await voice.queue;
  assert.deepEqual(asked, [['speech:synthesize', '— — —', { engine: 'tiny', voice: 'F2', speed: 1, kokoro: undefined }]]);
  assert.deepEqual(spoken, []);
  assert.equal(voice.speaking, false);
  assert.equal(states.at(-1), 'idle');
  delete globalThis.speechSynthesis;
  delete globalThis.SpeechSynthesisUtterance;
});

test('tiny voice: a long text goes to the model in pieces of bounded length, cut at stops, commas or spaces', async () => {
  const { speechPieces } = await import('../src/main/tts-tiny.js');
  assert.deepEqual(speechPieces('Short and sweet.'), ['Short and sweet.']);
  assert.deepEqual(speechPieces(''), []);
  const list = Array.from({ length: 40 }, (_, i) => `Survey photo ${i + 1} from the harbour slipway`).join(', ');
  const pieces = speechPieces(list);
  assert.ok(pieces.length > 5);
  assert.ok(pieces.every((p) => p.length <= 240), 'none longer than the cap');
  assert.ok(pieces.slice(0, -1).every((p) => p.endsWith(',')), 'cut at the commas');
  assert.equal(pieces.join(' '), list, 'nothing lost');
  const words = 'word '.repeat(200).trim();
  assert.ok(speechPieces(words).every((p) => p.length <= 240 && !p.includes('wor d')));
  assert.ok(speechPieces('x'.repeat(1000)).every((p) => p.length <= 240), 'even with nowhere to cut');
});
