// The sound inside recordings, for transcription. The main process asks; the window decodes,
// because Web Audio reads every format Chromium can play, and hands back 16 kHz mono samples.
import { kindOf } from '../main/filekind.js';

const RATE = 16000;
const MAX_BYTES = 1.5e9; // decoding needs the whole file in memory
const url = (p) => `jarvis-file://local/${encodeURIComponent(p)}`;

/** How long a recording is, from its metadata alone. */
export function probe(path, { timeout = 12000 } = {}) {
  return new Promise((resolve) => {
    const el = document.createElement(kindOf(path) === 'video' ? 'video' : 'audio');
    const finish = (value) => {
      clearTimeout(timer);
      el.removeAttribute('src');
      el.load();
      resolve(value);
    };
    const timer = setTimeout(() => finish({ error: 'Timed out reading that file.' }), timeout);
    el.preload = 'metadata';
    el.muted = true;
    el.onloadedmetadata = () => finish({ duration: Number.isFinite(el.duration) ? el.duration : 0 });
    el.onerror = () => finish({ error: 'That file will not play here.' });
    el.src = url(path);
  });
}

/** Every channel averaged into one. */
export function downmix(channels, length) {
  const out = new Float32Array(length);
  for (const data of channels) for (let i = 0; i < length; i++) out[i] += data[i] / channels.length;
  return out;
}

/** The whole recording as 16 kHz mono. */
export async function decode(path) {
  const res = await fetch(url(path));
  if (!res.ok) throw new Error(res.status === 403 ? 'That file is outside the folders I may read.' : `Could not load that file (${res.status}).`);
  if (Number(res.headers.get('content-length')) > MAX_BYTES) throw new Error('That file is too big for me to decode here.');
  const buf = await res.arrayBuffer();
  // An offline context at 16 kHz resamples as it decodes.
  const audio = await new OfflineAudioContext(1, 1, RATE).decodeAudioData(buf).catch(() => {
    throw new Error('There is no sound in that file that I can decode.');
  });
  const channels = Array.from({ length: audio.numberOfChannels }, (_, c) => audio.getChannelData(c));
  return downmix(channels, audio.length);
}

/** Answer the main process's decode requests, and show transcription progress in the status line. */
export function wireMedia(api, { setStatus }) {
  api.on('ui', async (e) => {
    if (e.type === 'status') return setStatus(e.text, e.ttl || 0);
    if (e.type !== 'decode_audio') return;
    let value;
    try {
      value = e.probe ? await probe(e.path) : await decode(e.path);
    } catch (err) {
      value = { error: err?.message || String(err) };
    }
    api.invoke('media:decoded', e.id, value);
  });
}
