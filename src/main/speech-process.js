// Runs in an Electron utility process so model inference never stalls the window.
// Speech-to-text: Whisper. Text-to-speech: tiny-voca (fast, the default) or Kokoro (neural).
// All run fully on this machine; the model files are downloaded once on first use and cached.
import fs from 'node:fs';
import path from 'node:path';
import { pipeline, env } from '@huggingface/transformers';
import { KokoroTTS } from 'kokoro-js';
import { loadTiny } from './tts-tiny.js';
import { Voices } from './voices.js';

const port = process.parentPort;
const cacheDir = process.argv[2];
if (cacheDir) env.cacheDir = cacheDir;

const post = (msg) => port.postMessage(msg);
const progress = (what) => (p) => {
  if (p.status === 'progress' && p.total) post({ type: 'status', what, file: p.file, loaded: p.loaded, total: p.total });
  if (p.status === 'ready' || p.status === 'done') post({ type: 'status', what, done: p.status === 'ready' });
};

let asr;
const getAsr = () => (asr ||= pipeline('automatic-speech-recognition', 'onnx-community/whisper-base.en', { dtype: 'q8', device: 'cpu', progress_callback: progress('listening') }));

// Live captions use the tiny Whisper, fetched the first time they are wanted (124 MB, once).
// Integer encoder, full-precision decoder: on a CPU that mix was the quickest of the four.
// Until it is ready, captions are simply not shown — nothing waits for it.
let tiny = null;
let tinyLoading = null;
let tinyFailedAt = -Infinity;
function getTiny() {
  if (tiny || tinyLoading || Date.now() - tinyFailedAt < 10 * 60e3) return tiny;
  tinyLoading = pipeline('automatic-speech-recognition', 'onnx-community/whisper-tiny.en', {
    dtype: { encoder_model: 'q8', decoder_model_merged: 'fp32' }, device: 'cpu', progress_callback: progress('captions'),
  }).then((model) => { tiny = model; }, () => {
    tinyFailedAt = Date.now();
    post({ type: 'status', what: 'captions', failed: true });
  }).finally(() => { tinyLoading = null; });
  return null;
}

// Kokoro comes in two sizes. The full-precision one speaks about 2.5 times faster on a CPU
// (the small one is built from integer operations that run slowly), but it is a 325 MB download
// against 92 MB. So: start on whichever is already here, fetch the fast one in the background
// the first time (only when Kokoro is the chosen voice), and switch to it the moment it is ready.
const KOKORO = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const FAST = path.join(cacheDir || '', KOKORO, 'onnx', 'model.onnx');
const SMALL = path.join(cacheDir || '', KOKORO, 'onnx', 'model_quantized.onnx');
const loadTts = (dtype, what) => KokoroTTS.from_pretrained(KOKORO, { dtype, device: 'cpu', progress_callback: progress(what) });
let tts;
let fetching = false;
function fetchFast() {
  if (fetching) return;
  fetching = true;
  loadTts('fp32', 'faster voice')
    .then((model) => {
      tts = Promise.resolve(model);
      post({ type: 'status', what: 'faster voice', done: true });
    })
    .catch(() => post({ type: 'status', what: 'faster voice', failed: true })); // the small voice carries on; the window stops showing a download
}
function getTts(upgrade = true) {
  if (tts) {
    if (upgrade) tts.then((model) => { if (model.dtype !== 'fp32') fetchFast(); }, () => {});
    return tts;
  }
  const small = () => {
    const model = loadTts('q8', 'voice').then((m) => Object.assign(m, { dtype: 'q8' }));
    if (upgrade) model.then(fetchFast, () => {});
    return model;
  };
  if (cacheDir && fs.existsSync(FAST)) {
    tts = loadTts('fp32', 'voice').then((m) => Object.assign(m, { dtype: 'fp32' }), () => {
      fs.rmSync(FAST, { force: true }); // a download that was cut short: fetch it again later
      return small();
    });
  } else tts = small();
  return tts;
}

// The fast voice is fetched as one 29 MB download, reported like the other models.
const voices = new Voices({
  loadTiny: () => loadTiny(cacheDir, ({ loaded, total }) => post({ type: 'status', what: 'voice', loaded, total })),
  loadKokoro: getTts,
  kokoroCached: () => Boolean(cacheDir) && (fs.existsSync(FAST) || fs.existsSync(SMALL)),
  post,
});

const JUNK = /^[\s.\-–—!?,]*$|^\s*[[(].*[\])]\s*$/; // "[BLANK_AUDIO]", "(silence)", bare punctuation

// Warming up loads models without queueing behind work (loading is not inference): the recognizer
// and the chosen voice side by side. `voice` is the engine ('tiny' | 'kokoro'; true meant Kokoro).
async function warm(id, { voice }) {
  try {
    await Promise.all([
      getAsr().then(() => post({ type: 'status', what: 'listening', done: true })),
      voices.warm(voice), // says "voice ready" itself, as it does when a voice is first chosen later
    ]);
    post({ type: 'result', id, value: true });
  } catch (err) {
    post({ type: 'result', id, error: err?.message || String(err) });
  }
}

const handlers = {
  async transcribe({ audio }) {
    const model = await getAsr();
    const out = await model(audio instanceof Float32Array ? audio : new Float32Array(audio));
    const text = (out.text || '').trim();
    return JUNK.test(text) ? '' : text;
  },
  synthesize: (args) => voices.synthesize(args),
};

// Long recordings go through in slices of up to 28 seconds — one Whisper window each — and each
// slice is its own job on the chain, so what the user says meanwhile is heard between slices.
// Slices end at the quietest moment of their last five seconds so a word is not cut in two.
// (Whisper's own chunking, and timestamps, both dropped whole sentences in testing.)
// `abort_long` stops a job before its next slice.
const RATE = 16000;
const SLICE = 28 * RATE;
const abortedLong = new Set();
function quietest(audio, from, to) {
  const win = RATE / 10;
  let best = to;
  let bestEnergy = Infinity;
  for (let i = from; i + win <= to; i += win / 2) {
    let e = 0;
    for (let j = i; j < i + win; j++) e += audio[j] * audio[j];
    if (e < bestEnergy) {
      bestEnergy = e;
      best = i + win / 2;
    }
  }
  return Math.round(best);
}
async function transcribeLong(id, { audio }) {
  audio = audio instanceof Float32Array ? audio : new Float32Array(audio);
  const chunks = [];
  try {
    for (let start = 0; start < audio.length;) {
      if (abortedLong.has(id)) throw new Error('Transcription stopped.');
      let end = Math.min(audio.length, start + SLICE);
      if (end < audio.length) end = quietest(audio, end - 5 * RATE, end);
      const piece = audio.slice(start, end);
      const out = await enqueue(async () => (abortedLong.has(id) ? null : (await getAsr())(piece)));
      if (!out) throw new Error('Transcription stopped.');
      const text = (out.text || '').trim();
      if (text && !JUNK.test(text)) chunks.push({ text, timestamp: [start / RATE, end / RATE] });
      start = end;
      post({ type: 'status', what: 'transcript', job: id, at: start / RATE, of: audio.length / RATE });
    }
    post({ type: 'result', id, value: { text: chunks.map((c) => c.text).join(' '), chunks } });
  } catch (err) {
    post({ type: 'status', what: 'transcript', job: id, stopped: true });
    post({ type: 'result', id, error: err?.message || String(err) });
  } finally {
    abortedLong.delete(id);
  }
}
function enqueue(fn) {
  waiting++;
  const job = chain.then(() => { waiting--; return fn(); });
  chain = job.catch(() => {});
  return job;
}

// A live caption of what the user has said so far. It must never hold up real work: it is skipped
// when anything else is waiting or a newer one has come in, and stops mid-sentence if a job arrives
// while it runs (only the encoder pass, a few hundred ms, cannot be cut short).
const STOP = new Error('caption overtaken');
let partials = 0;
function partial(id, { audio }) {
  const mine = ++partials;
  const model = getTiny();
  const skip = () => mine !== partials || waiting > 0 || talking > 0;
  if (!model || skip()) return void post({ type: 'result', id, value: null });
  chain = chain.then(async () => {
    let value = null;
    try {
      if (!skip()) {
        const out = await model(audio instanceof Float32Array ? audio : new Float32Array(audio), {
          max_new_tokens: 120,
          streamer: { put() { if (skip()) throw STOP; }, end() {} },
        });
        const text = (out.text || '').trim();
        value = JUNK.test(text) ? '' : text;
      }
    } catch { /* overtaken, or the model failed: no caption this time */ }
    post({ type: 'result', id, value });
  });
}

// One job at a time: inference is CPU-bound, and ordering keeps spoken sentences in sequence.
// `cancel` jumps the queue and voids any speech still waiting to be synthesized (the user interrupted).
// `stale` does the same for a transcription started on a hunch that the user had finished, when they had not.
let chain = Promise.resolve();
let epoch = 0;
let hunch = 0;
let waiting = 0; // jobs queued behind the one running, live captions aside

// The fast voice has a line of its own: a sentence takes it tens of milliseconds, so it would only
// lose by waiting behind a transcription slice (seconds) — and a live caption stands aside for it.
// Sentences still go one at a time and in order, and `cancel` voids those not yet started. Kokoro,
// whose sentences take seconds of CPU, keeps to the shared line so it does not slow the recognizer
// (unless it is standing in for a fast voice that failed to start: then it speaks from this line).
let mouth = Promise.resolve();
let talking = 0; // fast-voice sentences queued or being made
function speak(id, args, mine) {
  talking++;
  mouth = mouth.then(async () => {
    try {
      if (mine !== epoch) return void post({ type: 'result', id, value: null });
      post({ type: 'result', id, value: await handlers.synthesize(args) });
    } catch (err) {
      post({ type: 'result', id, error: err?.message || String(err) });
    } finally {
      talking--;
    }
  });
}
const fastVoice = (args) => args?.voice && typeof args.voice === 'object' && args.voice.engine !== 'kokoro';

port.on('message', ({ data }) => {
  const { id, op, args } = data;
  if (op === 'warm') return void warm(id, args || {});
  if (op === 'synthesize' && fastVoice(args)) return void speak(id, args, epoch);
  if (op === 'partial') return void partial(id, args || {});
  if (op === 'transcribe_long') return void transcribeLong(id, args || {});
  if (op === 'abort_long') {
    abortedLong.add(args?.job);
    post({ type: 'result', id, value: true });
    return;
  }
  if (op === 'cancel' || op === 'stale') {
    if (op === 'cancel') epoch++;
    else hunch++;
    post({ type: 'result', id, value: true });
    return;
  }
  const mine = epoch;
  const myHunch = hunch;
  waiting++;
  chain = chain.then(async () => {
    waiting--;
    if ((op === 'synthesize' && mine !== epoch) || (op === 'transcribe' && args?.guess && myHunch !== hunch)) {
      post({ type: 'result', id, value: null });
      return;
    }
    try {
      post({ type: 'result', id, value: await handlers[op](args || {}) });
    } catch (err) {
      post({ type: 'result', id, error: err?.message || String(err) });
    }
  });
});
