// The small fast voice: tiny-voca (4.5 M parameters, Apache-2.0). The phonemizer runs in plain
// JavaScript; the model runs in ONNX Runtime, which makes a sentence in tens of milliseconds on a
// CPU where Kokoro takes around a second. Two American voices, M2 and F2.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import ort from 'onnxruntime-node';
import { readGGUF } from './vendor/tiny-voca/tiny-voca.js';
import { fromGGUF } from './vendor/tiny-voca/dizione/engine.js';
import { ValueError } from './vendor/tiny-voca/dizione/symbols.js';

const REPO = 'https://huggingface.co/n4ze3m/tiny-voca/resolve/5fe06641d0afecb3c04bc9faca2cf64d9b2b1600';
const FILES = [
  { name: 'onnx/model.onnx', size: 21386372, sha256: 'fe6d918791a15b82e37465981d7f27a070e46b46635e5a3482fc8dff87a1ae46' },
  { name: 'gguf/tiny-voca-js.gguf', size: 7988384, sha256: '8436ad1c9b57c3533c925588a1b3563f906079a89c081ac0bec9f31ad6e28653' }, // the phonemizer's dictionary and tables
];
const sha = (data) => crypto.createHash('sha256').update(data).digest('hex');
export const TINY_VOICES = { M2: 1, F2: 0 };
export const RATE = 24000;
const GAIN = 0.78;

/** Download one file into the cache unless it is already there; a part-file is never mistaken for a whole one. */
async function fetchOnce(dir, { name, sha256 }, onProgress) {
  const dest = path.join(dir, name);
  if (fs.existsSync(dest)) return dest;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const res = await fetch(`${REPO}/${name}`);
  if (!res.ok) throw new Error(`Could not download the fast voice (${res.status}).`);
  const total = Number(res.headers.get('content-length')) || 0;
  const chunks = [];
  let loaded = 0;
  for await (const chunk of res.body) {
    chunks.push(chunk);
    loaded += chunk.length;
    onProgress?.({ file: name, loaded, total });
  }
  const data = Buffer.concat(chunks);
  if (sha256 && sha(data) !== sha256) throw new Error('The fast voice download was damaged. I will try again next time.');
  fs.writeFileSync(`${dest}.part`, data);
  fs.renameSync(`${dest}.part`, dest);
  return dest;
}

/**
 * A tiny-voca speaker. `cacheDir` is the app's models folder. `onProgress({loaded, total})` follows
 * the first download across both files. A file on disk that is not what was downloaded is deleted,
 * so the next launch fetches it again.
 */
export async function loadTiny(cacheDir, onProgress) {
  const dir = path.join(cacheDir, 'n4ze3m', 'tiny-voca');
  const total = FILES.reduce((n, f) => n + f.size, 0);
  const paths = [];
  let before = 0;
  for (const f of FILES) {
    paths.push(await fetchOnce(dir, f, onProgress && (({ loaded }) => onProgress({ loaded: before + loaded, total }))));
    before += f.size;
  }
  const [model, bytes] = paths.map((p) => fs.readFileSync(p));
  const bad = FILES.filter((f, i) => sha([model, bytes][i]) !== f.sha256);
  if (bad.length) {
    for (const f of bad) fs.rmSync(path.join(dir, f.name), { force: true });
    throw new Error('The fast voice files were damaged. I will fetch them again next time.');
  }
  const phonemizer = await fromGGUF(readGGUF(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)));
  const session = await ort.InferenceSession.create(model, { intraOpNumThreads: Math.max(1, Math.min(4, os.cpus().length)) });
  const one = (v) => new ort.Tensor('float32', Float32Array.of(v), [1]);
  const ints = (a) => BigInt64Array.from(a, (v) => BigInt(v));
  return {
    async generate(text, { voice = 'M2', speed = 1 } = {}) {
      let line = text.trim();
      if (!/[.!?…]["')\]]*$/.test(line)) line += '.'; // without a closing mark the last word breaks off
      let ids;
      let stress;
      try {
        ({ ids, stress } = phonemizer.phonemize(line));
      } catch (err) {
        if (err instanceof ValueError) ids = []; // nothing to pronounce: "—", an emoji
        else throw err;
      }
      if (!ids.length) return { audio: new Float32Array(0), sampling_rate: RATE };
      const out = await session.run({
        tokens: new ort.Tensor('int64', ints(ids), [1, ids.length]),
        stress: new ort.Tensor('int64', ints(stress), [1, stress.length]),
        voice: new ort.Tensor('int64', BigInt64Array.of(BigInt(TINY_VOICES[voice] ?? 1)), [1]),
        speed: one(speed),
        pitch_shift: one(0),
        pitch_range: one(1),
      });
      const audio = Float32Array.from(out.audio.data);
      // Brought down to about Kokoro's loudness, so changing voice does not change the volume (or
      // how far the hologram swings), and kept below full scale: the model can peak above 1.
      let peak = 0;
      for (const v of audio) peak = Math.max(peak, Math.abs(v));
      const gain = Math.min(GAIN, 0.99 / (peak || 1));
      for (let i = 0; i < audio.length; i++) audio[i] *= gain;
      return { audio, sampling_rate: RATE };
    },
  };
}
