import test from 'node:test';
import assert from 'node:assert/strict';
import { Voice } from '../src/renderer/voice.js';

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
