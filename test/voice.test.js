import test from 'node:test';
import assert from 'node:assert/strict';
import { Voice, speechStatus } from '../src/renderer/voice.js';
import { captionParts } from '../src/renderer/captions.js';

// The listening rules, fed 20 ms frames by hand, with the recognizer stood in for.
function fakeVoice(transcripts = []) {
  const calls = [];
  const heard = [];
  globalThis.window = {
    jarvis: {
      invoke: async (channel, audio, guess) => {
        calls.push(channel === 'speech:transcribe' ? `transcribe${guess ? ' (hunch)' : ''} ${Math.round(audio.length / 320)}` : channel);
        return channel === 'speech:transcribe' ? transcripts.shift() : true;
      },
    },
  };
  const voice = new Voice({ onUtterance: (t) => heard.push(t), onState: () => {}, onStatus: () => {}, onBargeIn: () => {}, settings: () => ({ handsFree: true, bargeIn: true, tts: 'off' }) });
  voice.ctx = { sampleRate: 16000 };
  const feed = (level, frames) => { for (let i = 0; i < frames; i++) voice._onFrame(new Float32Array(320).fill(level)); };
  return { voice, calls, heard, talk: (n) => feed(0.1, n), quiet: (n) => feed(0, n) };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

test('voice: transcription starts during the pause and its result is used when the pause is long enough', async () => {
  const v = fakeVoice(['what is the weather']);
  v.talk(25);
  v.quiet(11);
  assert.deepEqual(v.calls, [], 'not yet: a breath is not the end of a remark');
  v.quiet(1);
  assert.deepEqual(v.calls, ['transcribe (hunch) 37']);
  v.quiet(20);
  await settle();
  assert.deepEqual(v.heard, ['what is the weather']);
  assert.equal(v.calls.length, 1, 'the remark is not transcribed a second time');
});

test('voice: a hunch is thrown away when the user carries on, and the whole remark is transcribed', async () => {
  const v = fakeVoice(['half a', 'half a thought and the rest']);
  v.talk(25);
  v.quiet(12);
  v.talk(10);
  assert.deepEqual(v.calls, ['transcribe (hunch) 37', 'speech:stale']);
  v.quiet(32);
  await settle();
  assert.equal(v.calls[2], 'transcribe (hunch) 59');
  assert.deepEqual(v.heard, ['half a thought and the rest']);
});

test('voice: a failed hunch falls back to transcribing the finished remark', async () => {
  const v = fakeVoice([null, 'second try']);
  v.talk(25);
  v.quiet(32);
  await settle();
  assert.deepEqual(v.calls, ['transcribe (hunch) 37', 'transcribe 57']);
  assert.deepEqual(v.heard, ['second try']);
});

test('voice: the opening of a reply is released at its first comma, later text sentence by sentence', () => {
  const v = fakeVoice();
  const out = [];
  v.voice._enqueue = (t) => { out.push(t.trim()); v.voice.firstChunk = false; };
  for (const piece of ['It is fourteen degrees', ' and overcast, sir, with rain', ' expected by four. Take a coat, I would say.']) v.voice.say(piece);
  v.voice.flush();
  assert.deepEqual(out, ['It is fourteen degrees and overcast,', 'sir, with rain expected by four.', 'Take a coat, I would say.']);
});

test('voice: a list without full stops is spoken line by line, and no piece runs on past the cap', () => {
  const v = fakeVoice();
  const out = [];
  v.voice._enqueue = (t) => { out.push(t.trim()); v.voice.firstChunk = false; };
  const lines = Array.from({ length: 40 }, (_, i) => `- Survey photo ${i + 1} from the harbour slipway, west side`);
  const reply = `Here are the files in that folder, sir:\n${lines.join('\n')}\n`;
  for (const w of reply.split(/(?<= )/)) v.voice.say(w);
  v.voice.flush();
  assert.ok(out.length >= 40, `one piece a line (${out.length})`);
  assert.ok(out.every((p) => p.length <= 240));
  out.length = 0;
  for (const w of `${'and then the next thing '.repeat(40)}`.split(/(?<= )/)) v.voice.say(w);
  v.voice.flush();
  assert.ok(out.length > 3 && out.every((p) => p.length <= 240), 'a run with no stops at all');
  assert.equal(out.join(' '), 'and then the next thing '.repeat(40).trim());
});

test('voice: the status line follows a model download to its end, including one that breaks off', () => {
  assert.deepEqual(speechStatus({ what: 'faster voice', file: 'onnx/model.onnx', loaded: 125763584, total: 325532232 }), { text: 'Downloading faster voice model (one time) — 39%', ttl: 0 });
  assert.deepEqual(speechStatus({ what: 'faster voice', done: true }), { text: 'faster voice ready', ttl: 2500 });
  const failed = speechStatus({ what: 'faster voice', failed: true });
  assert.match(failed.text, /faster voice could not be downloaded/);
  assert.equal(failed.ttl > 0, true, 'the progress line is replaced by one that goes away');
  assert.deepEqual(speechStatus({ what: 'listening', done: true }), { text: 'speech recognition ready', ttl: 2500 });
  assert.equal(speechStatus({ what: 'voice', done: false }), null);
  assert.deepEqual(speechStatus({ what: 'captions', loaded: 31, total: 124 }), { text: 'Downloading live captions model (one time) — 25%', ttl: 0 });
});

// ---- live captions ------------------------------------------------------------

// Partials are answered by hand, so the test decides when each one comes back.
function liveVoice({ ptt = false } = {}) {
  const partials = [];
  const shown = [];
  globalThis.window = {
    jarvis: {
      invoke: (channel, audio) => {
        if (channel !== 'speech:partial') return Promise.resolve(channel === 'speech:transcribe' ? 'final words' : true);
        let answer;
        const p = new Promise((r) => { answer = r; });
        partials.push({ frames: Math.round(audio.length / 320), answer });
        return p;
      },
    },
  };
  const voice = new Voice({ onUtterance: () => {}, onPartial: (t) => shown.push(t), onState: () => {}, onStatus: () => {}, onBargeIn: () => {}, settings: () => ({ handsFree: !ptt, bargeIn: true, tts: 'off' }) });
  voice.ctx = { sampleRate: 16000 };
  const feed = (level, frames) => { for (let i = 0; i < frames; i++) voice._onFrame(new Float32Array(320).fill(level)); };
  return { voice, partials, shown, talk: (n) => feed(0.1, n), quiet: (n) => feed(0, n) };
}

test('captions: the first partial waits for 0.8 s of voice, then one at a time, each after 0.5 s more', async () => {
  const v = liveVoice();
  v.talk(5); // the onset: hearing starts here
  v.talk(39);
  assert.equal(v.partials.length, 0, 'not before 0.8 s of voice');
  v.talk(1);
  assert.equal(v.partials.length, 1);
  v.talk(60);
  assert.equal(v.partials.length, 1, 'never two in flight');
  v.partials[0].answer('what is the');
  await settle();
  assert.deepEqual(v.shown, ['what is the']);
  v.talk(1);
  assert.equal(v.partials.length, 2, 'more than 0.5 s arrived while the first was out: the next goes at once');
  v.partials[1].answer('what is the weather');
  await settle();
  v.talk(24);
  assert.equal(v.partials.length, 2, 'under 0.5 s of new audio');
  v.talk(1);
  assert.equal(v.partials.length, 3);
  assert.deepEqual(v.shown, ['what is the', 'what is the weather']);
});

test('captions: none is started while the user pauses, and one that returns after the remark is ignored', async () => {
  const v = liveVoice();
  v.talk(50);
  assert.equal(v.partials.length, 1);
  v.partials[0].answer('');
  await settle();
  v.quiet(30);
  assert.equal(v.partials.length, 1, 'a pause is not the time to ask: the hunch may be about to go');
  v.talk(1);
  assert.equal(v.partials.length, 2, 'talking again picks it back up');
  v.quiet(40); // the remark ends while the caption is still out
  assert.equal(v.voice.capture, null);
  v.partials[1].answer('too late');
  await settle();
  assert.deepEqual(v.shown, [], 'an empty partial and a late one are both left unshown');
});

test('captions: a partial from a dropped remark is not shown on the next one', async () => {
  const v = liveVoice();
  v.talk(50);
  v.voice.setMuted(true); // dropped
  v.voice.setMuted(false);
  v.talk(50);
  assert.equal(v.partials.length, 2, 'the new remark asks for its own');
  v.partials[0].answer('old remark');
  v.partials[1].answer('new remark');
  await settle();
  assert.deepEqual(v.shown, ['new remark']);
});

test('captions: only the last 20 seconds are sent', () => {
  const v = liveVoice();
  v.talk(1200);
  assert.equal(v.partials[0].frames, 45);
  v.partials[0].answer('x');
  return settle().then(() => {
    v.talk(1);
    assert.equal(v.partials[1].frames, 1000);
  });
});

test('captions: push-to-talk shows nothing until there is real voice in it', () => {
  const v = liveVoice({ ptt: true });
  v.voice.pushToTalk(true);
  v.quiet(100);
  assert.equal(v.partials.length, 0, 'held silence would only make Whisper invent words');
  v.talk(40);
  assert.equal(v.partials.length, 1);
});

// ---- Jarvis's line following its voice --------------------------------------

test('captions: each spoken piece reports how far into the reply the voice has got', async () => {
  const spoken = [];
  globalThis.window = { jarvis: { invoke: async () => null } }; // no clip: the system voice, absent here, stands in
  const voice = new Voice({ onState: () => {}, onSpoken: (n) => spoken.push(n), settings: () => ({ tts: 'kokoro' }) });
  const reply = 'It is fourteen degrees and overcast, sir. Rain is expected by four. Take a good coat. ```js\ncode\n```';
  for (const piece of reply.match(/.{1,7}/gs)) voice.say(piece);
  voice.flush();
  await voice.queue;
  // the code block at the end is not read out, but the caption still reaches the end of the reply
  assert.deepEqual(spoken, [reply.indexOf('Rain'), reply.indexOf('Take'), reply.indexOf('```'), reply.length]);
  assert.equal(voice.fed, reply.length);
  voice.hush();
  assert.equal(voice.fed, 0, 'the next reply counts from its own start');
});

test('captions: spoken text is lit, the rest dim, and the window stays with the voice', () => {
  assert.deepEqual(captionParts('Good evening, sir. Systems are online.', 19), { lead: '', lit: 'Good evening, sir. ', dim: 'Systems are online.', trail: '' });
  assert.deepEqual(captionParts('Good evening, sir.', null), { lead: '', lit: 'Good evening, sir.', dim: '', trail: '' }, 'no voice to follow: all lit');
  const words = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ');
  const tail = captionParts(words, null);
  assert.equal(tail.lead, '…');
  assert.ok((tail.lit).length <= 260 && words.endsWith(tail.lit), 'the most recent 260 characters, as before');
  const behind = captionParts(words, 60, 30);
  assert.equal(behind.lit, words.slice(30, 60), 'the piece being spoken is kept on screen');
  assert.ok(behind.lead && behind.trail === '…' && behind.lit.length + behind.dim.length <= 260);
  const ahead = captionParts(words, words.length - 20, words.length - 40);
  assert.equal(ahead.lit + ahead.dim, tail.lit, 'near the end it is the usual tail');
});
