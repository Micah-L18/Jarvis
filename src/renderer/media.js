// The sound inside recordings, for transcription, and pictures for the model to look at. The main
// process asks; the window decodes, because Chromium reads every format it can show or play, and
// hands back 16 kHz mono samples or a picture sized for the model.
import { kindOf, extOf } from '../main/filekind.js';

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

// Chromium decodes a whole file at the file's own sample rate before resampling it, and gives up past
// about 2^28 frames: 93 minutes at 48 kHz, 101 at 44.1. Longer MP3 and WAV recordings (podcasts,
// meetings, voice recorders) are decoded in pieces below that and joined up.
const FRAME_LIMIT = 2 ** 28;
const PIECE_FRAMES = 2 ** 27; // about 47 minutes at 48 kHz

/** The whole recording as 16 kHz mono. */
export async function decode(path) {
  const res = await fetch(url(path));
  if (!res.ok) throw new Error(res.status === 403 ? 'That file is outside the folders I may read.' : `Could not load that file (${res.status}).`);
  if (Number(res.headers.get('content-length')) > MAX_BYTES) throw new Error('That file is too big for me to decode here.');
  const ext = extOf(path);
  const duration = ext === 'mp3' ? (await probe(path)).duration || 0 : 0;
  return decodeBytes(await res.arrayBuffer(), ext, duration);
}

/** Decoded audio as 16 kHz mono. An offline context at 16 kHz resamples as it decodes. */
async function decodeOne(buf) {
  const audio = await new OfflineAudioContext(1, 1, RATE).decodeAudioData(buf);
  const channels = Array.from({ length: audio.numberOfChannels }, (_, c) => audio.getChannelData(c));
  return downmix(channels, audio.length);
}

/** A file's bytes as 16 kHz mono; `duration` (seconds, 0 if unknown) says whether an MP3 needs decoding in pieces. */
export async function decodeBytes(buf, ext, duration = 0) {
  const pieces = ext === 'wav' ? wavPieces(buf) : ext === 'mp3' && duration * 48000 > FRAME_LIMIT * 0.9 ? mp3Pieces(buf, Math.ceil((duration * 48000) / PIECE_FRAMES)) : null;
  if (pieces) {
    const parts = [];
    for (const piece of pieces) { // each made only when its turn comes, so the copies are not all in memory at once
      parts.push(await decodeOne(piece()).catch(() => {
        throw new Error('There is no sound in that file that I can decode.');
      }));
    }
    const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }
  return decodeOne(buf).catch(() => {
    throw new Error(duration * 44100 > FRAME_LIMIT
      ? 'That recording is too long for me to decode here in one go; an MP3 or WAV copy of it, or a shorter piece, would work.'
      : 'There is no sound in that file that I can decode.');
  });
}

/** A long WAV as several shorter WAVs (each with the original header, made when called), or null if it is short enough as it is, or not a WAV I can cut. */
export function wavPieces(buf, { pieceFrames = PIECE_FRAMES, limit = FRAME_LIMIT * 0.9 } = {}) {
  const v = new DataView(buf);
  const tag = (at) => String.fromCharCode(v.getUint8(at), v.getUint8(at + 1), v.getUint8(at + 2), v.getUint8(at + 3));
  if (buf.byteLength < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  let blockAlign = 0;
  for (let at = 12; at + 8 <= buf.byteLength;) {
    const id = tag(at);
    const size = v.getUint32(at + 4, true);
    if (id === 'fmt ') blockAlign = v.getUint16(at + 20, true);
    if (id === 'data') {
      const start = at + 8;
      const bytes = Math.min(size, buf.byteLength - start);
      if (!blockAlign || bytes / blockAlign <= limit) return null;
      const step = pieceFrames * blockAlign;
      const head = new Uint8Array(buf, 0, start);
      const pieces = [];
      for (let from = 0; from < bytes; from += step) {
        const len = Math.min(step, bytes - from);
        pieces.push(() => {
          const out = new Uint8Array(start + len);
          out.set(head);
          out.set(new Uint8Array(buf, start + from, len), start);
          const ov = new DataView(out.buffer);
          ov.setUint32(4, out.length - 8, true);
          ov.setUint32(start - 4, len, true);
          return out.buffer;
        });
      }
      return pieces;
    }
    at += 8 + size + (size % 2);
  }
  return null;
}

/** An MP3 cut into `n` pieces (made when called), each starting on a frame header: an MP3 decodes from any frame. */
export function mp3Pieces(buf, n) {
  const b = new Uint8Array(buf);
  const isFrame = (i) => b[i] === 0xff && (b[i + 1] & 0xe0) === 0xe0 && ((b[i + 1] >> 3) & 3) !== 1 && ((b[i + 1] >> 1) & 3) !== 0 && (b[i + 2] >> 4) !== 0xf && (b[i + 2] >> 4) !== 0 && ((b[i + 2] >> 2) & 3) !== 3;
  const cuts = [0];
  for (let k = 1; k < n; k++) {
    let i = Math.floor((b.length * k) / n);
    while (i + 3 < b.length && !isFrame(i)) i++;
    if (i + 3 < b.length && i > cuts.at(-1)) cuts.push(i);
  }
  cuts.push(b.length);
  return cuts.slice(0, -1).map((from, k) => () => buf.slice(from, cuts[k + 1]));
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
