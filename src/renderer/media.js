// The sound inside recordings, for transcription, and pictures for the model to look at. The main
// process asks; the window decodes, because Chromium reads every format it can show or play, and
// hands back 16 kHz mono samples or a picture sized for the model.
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

const MAX_SIDE = 1568; // the long side the vision models work at; bigger only costs time
const AS_IS = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const base64 = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).slice(String(r.result).indexOf(',') + 1));
  r.onerror = () => reject(new Error('Could not read that picture.'));
  r.readAsDataURL(blob);
});

/**
 * A picture ready for a model: {mediaType, data (base64), width, height, scaled, sentWidth?, sentHeight?}.
 * Small PNG/JPEG/GIF/WebP files go as they are; anything bigger or in another format (SVG, BMP,
 * AVIF…) is redrawn as a JPEG no bigger than MAX_SIDE on its long side. Chromium does the decoding,
 * which keeps image libraries out of the main process.
 */
export async function picture(path, { maxSide = MAX_SIDE, maxBytes = 1_000_000 } = {}) {
  const res = await fetch(url(path));
  if (!res.ok) throw new Error(res.status === 403 ? 'That file is outside the folders I may read.' : `Could not load that file (${res.status}).`);
  const blob = await res.blob();
  const src = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = src;
    await img.decode().catch(() => { throw new Error('I could not read that picture.'); });
    const width = img.naturalWidth;
    const height = img.naturalHeight;
    if (AS_IS.has(blob.type) && Math.max(width, height) <= maxSide && blob.size <= maxBytes) {
      return { mediaType: blob.type, data: await base64(blob), width, height, scaled: false };
    }
    const svg = blob.type === 'image/svg+xml';
    const scale = Math.min(svg ? 2 : 1, maxSide / Math.max(width || 1, height || 1));
    const canvas = new OffscreenCanvas(Math.max(1, Math.round((width || 300) * scale)), Math.max(1, Math.round((height || 150) * scale)));
    const g = canvas.getContext('2d');
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.drawImage(img, 0, 0, canvas.width, canvas.height);
    const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
    return { mediaType: 'image/jpeg', data: await base64(out), width, height, scaled: true, sentWidth: canvas.width, sentHeight: canvas.height };
  } finally {
    URL.revokeObjectURL(src);
  }
}

/** Answer the main process's decode requests, and show transcription progress in the status line. */
export function wireMedia(api, { setStatus }) {
  api.on('ui', async (e) => {
    if (e.type === 'status') return setStatus(e.text, e.ttl || 0);
    if (e.type !== 'decode_audio' && e.type !== 'decode_image') return;
    let value;
    try {
      value = e.type === 'decode_image' ? await picture(e.path) : e.probe ? await probe(e.path) : await decode(e.path);
    } catch (err) {
      value = { error: err?.message || String(err) };
    }
    api.invoke('media:decoded', e.id, value);
  });
}
