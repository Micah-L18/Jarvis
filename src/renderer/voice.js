// Ears and mouth. Listens continuously, decides when the user has started and finished a
// thought, hands the audio to local Whisper, and speaks replies sentence by sentence as they
// stream in — stopping instantly if the user talks over it.

const WORKLET = `
class Tap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('tap', Tap);`;

const FRAME_MS = 20;

function resample(input, fromRate, toRate) {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    out[i] = sum / Math.max(1, end - start);
  }
  return out;
}

/** Make streamed model text safe to read aloud. */
export function speakable(text) {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/[*_#`>|~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export class Voice {
  /**
   * @param cb {onUtterance(text), onBargeIn(), onState(state), onStatus(text), settings() -> voice settings}
   * state: 'idle' | 'hearing' | 'transcribing' | 'speaking'
   */
  constructor(cb) {
    this.cb = cb;
    this.level = 0; // mic or speech level 0..1, read by the orb
    this.micOn = false;
    this.muted = false;
    this.ptt = false;
    // capture
    this.frame = [];
    this.frameLen = 0;
    this.preroll = [];
    this.capture = null; // {frames:[], voiced, silence}
    this.noise = 0.004;
    this.onset = 0;
    this.holdUntil = 0;
    // speech out
    this.epoch = 0;
    this.textBuf = '';
    this.queue = Promise.resolve();
    this.pendingSpeech = 0;
    this.source = null;
    this.heard = '';
    this.firstChunk = true;
  }

  get speaking() {
    return this.pendingSpeech > 0;
  }

  _ctx() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 512;
      this.analyser.connect(this.ctx.destination);
      this.scope = new Float32Array(this.analyser.fftSize);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  // ---- listening --------------------------------------------------------------

  async startMic() {
    if (this.micOn) return true;
    try {
      const ctx = this._ctx();
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
      await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' })));
      const tap = new AudioWorkletNode(ctx, 'tap');
      tap.port.onmessage = (e) => this._onAudio(e.data);
      ctx.createMediaStreamSource(this.stream).connect(tap);
      this.frameSize = Math.round((ctx.sampleRate * FRAME_MS) / 1000);
      this.micOn = true;
      return true;
    } catch (err) {
      this.cb.onStatus(`Microphone unavailable (${err.message}). You can still type.`);
      return false;
    }
  }

  setMuted(muted) {
    this.muted = muted;
    if (muted) this._drop();
  }

  /** Push-to-talk: hold to record regardless of the hands-free setting. */
  pushToTalk(down) {
    if (down && !this.ptt) {
      this.ptt = true;
      if (!this.capture) this._begin();
    } else if (!down && this.ptt) {
      this.ptt = false;
      this._finish();
    }
  }

  _onAudio(chunk) {
    this.frame.push(chunk);
    this.frameLen += chunk.length;
    if (this.frameLen < this.frameSize) return;
    const frame = new Float32Array(this.frameLen);
    let o = 0;
    for (const c of this.frame) { frame.set(c, o); o += c.length; }
    this.frame = [];
    this.frameLen = 0;
    this._onFrame(frame);
  }

  _onFrame(frame) {
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    const rms = Math.sqrt(sum / frame.length);
    if (!this.speaking) this.level = Math.min(1, rms * 9);

    const s = this.cb.settings();
    const speaking = this.speaking || performance.now() < this.holdUntil;
    if (this.muted && !this.ptt) return;
    if (this.ptt) {
      this.capture?.frames.push(frame);
      if (this.capture) this.capture.voiced++;
      return;
    }
    if (!s.handsFree) return;
    // While Jarvis is talking, either ignore the mic or demand a clear, sustained voice before interrupting.
    if (speaking && !s.bargeIn) { this._drop(); return; }

    const threshold = speaking ? Math.max(0.055, this.noise * 6) : Math.max(0.014, this.noise * 3.2);
    const loud = rms > threshold;
    if (!this.capture) {
      if (!loud) this.noise += (Math.min(rms, 0.05) - this.noise) * 0.04;
      this.preroll.push(frame);
      if (this.preroll.length > 30) this.preroll.shift();
      this.onset = loud ? this.onset + 1 : Math.max(0, this.onset - 1);
      if (this.onset >= (speaking ? 16 : 5)) {
        if (speaking) this.cb.onBargeIn();
        this._begin(this.preroll);
      }
      return;
    }
    const cap = this.capture;
    cap.frames.push(frame);
    if (rms > threshold * 0.6) { cap.voiced++; cap.silence = 0; } else cap.silence++;
    // A shorter pause ends a short remark; give longer thoughts a little more room.
    const patience = cap.voiced > 150 ? 55 : 40;
    if (cap.silence >= patience || cap.frames.length > 1500) this._finish();
  }

  _begin(pre = []) {
    this.capture = { frames: [...pre], voiced: 0, silence: 0 };
    this.preroll = [];
    this.onset = 0;
    this.cb.onState('hearing');
  }

  _drop() {
    this.capture = null;
    this.onset = 0;
  }

  async _finish() {
    const cap = this.capture;
    this.capture = null;
    if (!cap) return;
    if (cap.voiced < 12) { // under ~a quarter second of actual voice: a cough, a click
      this.cb.onState('idle');
      return;
    }
    const total = cap.frames.reduce((n, f) => n + f.length, 0);
    const pcm = new Float32Array(total);
    let o = 0;
    for (const f of cap.frames) { pcm.set(f, o); o += f.length; }
    this.cb.onState('transcribing');
    try {
      const text = await window.jarvis.invoke('speech:transcribe', resample(pcm, this.ctx.sampleRate, 16000));
      if (text) this.cb.onUtterance(text);
      else this.cb.onState('idle');
    } catch (err) {
      this.cb.onStatus(`Speech recognition failed: ${err.message}`);
      this.cb.onState('idle');
    }
  }

  // ---- speaking ---------------------------------------------------------------

  /** Feed streamed reply text; complete sentences are spoken as soon as they exist. */
  say(delta) {
    this.textBuf += delta;
    for (;;) {
      // A sentence ends at punctuation followed by a space; very short fragments ("Mr.", "3.") stay attached.
      let cut = -1;
      const re = /[.!?…]+["')\]]*\s+/g;
      for (let m; (m = re.exec(this.textBuf)); ) {
        if (m.index + m[0].length >= 14) { cut = m.index + m[0].length; break; }
      }
      // Get the first words out fast: break the opening at a comma if the sentence is running long.
      if (cut < 0 && this.firstChunk && this.textBuf.length > 60) {
        const m = /^[\s\S]{25,}?[,;:—]\s+/.exec(this.textBuf);
        if (m) cut = m[0].length;
      }
      if (cut < 0) break;
      this._enqueue(this.textBuf.slice(0, cut));
      this.textBuf = this.textBuf.slice(cut);
    }
  }

  /** The reply is complete: speak whatever is left in the buffer. */
  flush() {
    if (this.textBuf.trim()) this._enqueue(this.textBuf);
    this.textBuf = '';
    this.firstChunk = true;
  }

  _enqueue(raw) {
    const text = speakable(raw);
    if (!text) return;
    this.firstChunk = false;
    const s = this.cb.settings();
    const epoch = this.epoch;
    this.pendingSpeech++;
    this.cb.onState('speaking');
    // Start synthesis now so audio is ready by the time the previous sentence ends.
    const audio = s.tts === 'kokoro' ? window.jarvis.invoke('speech:synthesize', text, s.kokoroVoice).catch(() => null) : null;
    this.queue = this.queue.then(async () => {
      try {
        if (epoch !== this.epoch) return;
        if (s.tts === 'off') {
          await new Promise((r) => setTimeout(r, Math.min(4000, text.length * 45)));
        } else {
          const clip = audio && (await audio);
          if (epoch !== this.epoch) return;
          this.heard += (this.heard ? ' ' : '') + text;
          if (clip?.audio) await this._play(clip, epoch);
          else await this._systemSpeak(text, s, epoch);
        }
      } finally {
        if (epoch !== this.epoch) return; // hushed: the counter was already reset
        this.pendingSpeech--;
        if (this.pendingSpeech === 0) {
          this.level = 0;
          this.holdUntil = performance.now() + 350; // let the room echo die before trusting the mic
          this.cb.onState('idle');
        }
      }
    });
  }

  _play({ audio, rate }, epoch) {
    return new Promise((resolve) => {
      const ctx = this._ctx();
      const buffer = ctx.createBuffer(1, audio.length, rate);
      buffer.copyToChannel(audio instanceof Float32Array ? audio : new Float32Array(audio), 0);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(this.analyser);
      this.source = src;
      const meter = () => {
        if (this.source !== src) return;
        this.analyser.getFloatTimeDomainData(this.scope);
        let sum = 0;
        for (let i = 0; i < this.scope.length; i++) sum += this.scope[i] * this.scope[i];
        this.level = Math.min(1, Math.sqrt(sum / this.scope.length) * 5.5);
        requestAnimationFrame(meter);
      };
      src.onended = () => {
        if (this.source === src) this.source = null;
        resolve();
      };
      if (epoch !== this.epoch) return resolve();
      src.start();
      meter();
    });
  }

  _systemSpeak(text, s, epoch) {
    return new Promise((resolve) => {
      if (!('speechSynthesis' in window)) return resolve();
      const u = new SpeechSynthesisUtterance(text);
      const voices = speechSynthesis.getVoices();
      u.voice = voices.find((v) => v.name === s.systemVoice) || voices.find((v) => /en-GB/i.test(v.lang) && /male|daniel|george|ryan|arthur/i.test(v.name)) || voices.find((v) => /en-GB/i.test(v.lang)) || null;
      u.rate = 1.04;
      // No real signal from the OS voice, so fake a plausible envelope for the hologram.
      let alive = true;
      const start = performance.now();
      const wobble = () => {
        if (!alive || epoch !== this.epoch) return;
        const t = (performance.now() - start) / 1000;
        this.level = 0.25 + 0.3 * Math.abs(Math.sin(t * 9.1) * Math.sin(t * 3.7 + 1)) + Math.random() * 0.1;
        requestAnimationFrame(wobble);
      };
      const done = () => { alive = false; resolve(); };
      u.onend = done;
      u.onerror = done;
      speechSynthesis.speak(u);
      wobble();
      setTimeout(done, 400 + text.length * 120); // some OS voices never fire onend
    });
  }

  /** Stop talking immediately. Returns what had actually been said aloud so far. */
  hush() {
    this.epoch++;
    this.pendingSpeech = 0;
    this.textBuf = '';
    this.firstChunk = true;
    const src = this.source;
    this.source = null;
    try { src?.stop(); } catch { /* not started */ }
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    window.jarvis.invoke('speech:cancel').catch(() => {});
    const heard = this.heard;
    this.heard = '';
    this.level = 0;
    return heard;
  }

  /** Call when a reply finished normally. */
  settle() {
    this.heard = '';
  }
}
