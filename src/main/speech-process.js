// Runs in an Electron utility process so model inference never stalls the window.
// Speech-to-text: Whisper. Text-to-speech: Kokoro. Both run fully on this machine;
// the model files are downloaded once on first use and cached.
import fs from 'node:fs';
import path from 'node:path';
import { pipeline, env } from '@huggingface/transformers';
import { KokoroTTS } from 'kokoro-js';

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

// The voice comes in two sizes. The full-precision one speaks about 2.5 times faster on a CPU
// (the small one is built from integer operations that run slowly), but it is a 325 MB download
// against 92 MB. So: start on whichever is already here, fetch the fast one in the background
// the first time, and switch to it the moment it is ready.
const KOKORO = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const FAST = path.join(cacheDir || '', KOKORO, 'onnx', 'model.onnx');
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
    .catch(() => {}); // the small voice carries on
}
function getTts() {
  if (tts) return tts;
  if (cacheDir && fs.existsSync(FAST)) {
    tts = loadTts('fp32', 'voice').catch(() => {
      fs.rmSync(FAST, { force: true }); // a download that was cut short: fetch it again later
      const small = loadTts('q8', 'voice');
      small.then(fetchFast, () => {});
      return small;
    });
  } else {
    tts = loadTts('q8', 'voice');
    tts.then(fetchFast, () => {});
  }
  return tts;
}

const JUNK = /^[\s.\-–—!?,]*$|^\s*[[(].*[\])]\s*$/; // "[BLANK_AUDIO]", "(silence)", bare punctuation

const handlers = {
  async warm({ voice }) {
    await getAsr();
    post({ type: 'status', what: 'listening', done: true });
    if (voice) {
      await getTts();
      post({ type: 'status', what: 'voice', done: true });
    }
    return true;
  },
  async transcribe({ audio }) {
    const model = await getAsr();
    const out = await model(audio instanceof Float32Array ? audio : new Float32Array(audio));
    const text = (out.text || '').trim();
    return JUNK.test(text) ? '' : text;
  },
  async synthesize({ text, voice }) {
    const model = await getTts();
    const out = await model.generate(text, { voice: voice || 'bm_george' });
    return { audio: out.audio, rate: out.sampling_rate };
  },
};

// One job at a time: inference is CPU-bound, and ordering keeps spoken sentences in sequence.
// `cancel` jumps the queue and voids any speech still waiting to be synthesized (the user interrupted).
// `stale` does the same for a transcription started on a hunch that the user had finished, when they had not.
let chain = Promise.resolve();
let epoch = 0;
let hunch = 0;
port.on('message', ({ data }) => {
  const { id, op, args } = data;
  if (op === 'cancel' || op === 'stale') {
    if (op === 'cancel') epoch++;
    else hunch++;
    post({ type: 'result', id, value: true });
    return;
  }
  const mine = epoch;
  const myHunch = hunch;
  chain = chain.then(async () => {
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
