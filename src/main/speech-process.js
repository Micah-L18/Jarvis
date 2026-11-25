// Runs in an Electron utility process so model inference never stalls the window.
// Speech-to-text: Whisper. Text-to-speech: Kokoro. Both run fully on this machine;
// the model files are downloaded once on first use and cached.
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
let tts;
const getAsr = () => (asr ||= pipeline('automatic-speech-recognition', 'onnx-community/whisper-base.en', { dtype: 'q8', device: 'cpu', progress_callback: progress('listening') }));
const getTts = () => (tts ||= KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'q8', device: 'cpu', progress_callback: progress('voice') }));

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
let chain = Promise.resolve();
let epoch = 0;
port.on('message', ({ data }) => {
  const { id, op, args } = data;
  if (op === 'cancel') {
    epoch++;
    post({ type: 'result', id, value: true });
    return;
  }
  const mine = epoch;
  chain = chain.then(async () => {
    if (op === 'synthesize' && mine !== epoch) {
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
