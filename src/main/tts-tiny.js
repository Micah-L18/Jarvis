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

const REPO = 'https://huggingface.co/n4ze3m/tiny-voca/resolve/5fe06641d0afecb3c04bc9faca2cf64d9b2b1600';
const FILES = [
  { name: 'onnx/model.onnx', sha256: 'fe6d918791a15b82e37465981d7f27a070e46b46635e5a3482fc8dff87a1ae46' },
  { name: 'gguf/tiny-voca-js.gguf', sha256: '8436ad1c9b57c3533c925588a1b3563f906079a89c081ac0bec9f31ad6e28653' }, // the phonemizer's dictionary and tables
];
export const TINY_VOICES = { M2: 1, F2: 0 };
export const RATE = 24000;

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
  if (sha256 && crypto.createHash('sha256').update(data).digest('hex') !== sha256) throw new Error('The fast voice download was damaged. I will try again next time.');
  fs.writeFileSync(`${dest}.part`, data);
  fs.renameSync(`${dest}.part`, dest);
  return dest;
}

/** A tiny-voca speaker. `cacheDir` is the app's models folder. */
export async function loadTiny(cacheDir, onProgress) {
  const dir = path.join(cacheDir, 'n4ze3m', 'tiny-voca');
  const paths = [];
  for (const f of FILES) paths.push(await fetchOnce(dir, f, onProgress));
  const bytes = fs.readFileSync(paths[1]);
  const phonemizer = await fromGGUF(readGGUF(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)));
  const session = await ort.InferenceSession.create(paths[0], { intraOpNumThreads: Math.max(1, Math.min(4, os.cpus().length)) });
  const one = (v) => new ort.Tensor('float32', Float32Array.of(v), [1]);
  const ints = (a) => BigInt64Array.from(a, (v) => BigInt(v));
  return {
    async generate(text, { voice = 'M2', speed = 1 } = {}) {
      let line = text.trim();
      if (!/[.!?…]["')\]]*$/.test(line)) line += '.'; // without a closing mark the last word breaks off
      const { ids, stress } = phonemizer.phonemize(line);
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
      let peak = 0;
      for (const v of audio) peak = Math.max(peak, Math.abs(v));
      if (peak > 0.99) for (let i = 0; i < audio.length; i++) audio[i] *= 0.99 / peak; // the model can peak above 1
      return { audio, sampling_rate: RATE };
    },
  };
}
