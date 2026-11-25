// Ears and mouth. Listens continuously, decides when the user has started and finished a
// thought, hands the audio to local Whisper, and speaks replies sentence by sentence as they
// stream in — stopping instantly if the user talks over it.
import { resolveDevice } from './devices.js';

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
// How long a silence ends a remark, in frames: a short remark, and a longer thought that earns more room.
const PAUSE = 32;
const PAUSE_LONG = 45;
// Transcription starts this far into the silence, on the hunch that the user has finished, so the
// words are usually ready by the time the pause is long enough to be sure.
const GUESS_AFTER = 12;
// Live captions while the user talks: the first once there is this much voice (frames), then again
// each time one comes back and at least this much more has been heard; only the latest stretch is sent.
const LIVE_FIRST = 40;
const LIVE_EVERY = 25;
const LIVE_SPAN = 1000;
const MIC = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 };

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

/**
 * The status line for a message from the speech process: {text, ttl}, ttl 0 meaning "until the
 * next one" — or null when there is nothing to show. A download that broke off must end the
 * progress line, or it stays on screen for a download that is no longer happening.
 */
export function speechStatus(msg) {
  // Said once, as a notice of its own: the status line is busy with other models loading at that moment.
  if (msg.fallback) return { text: `The fast voice could not start — using the ${msg.fallback === 'kokoro' ? 'neural' : 'system'} voice for now.`, ttl: 6000, notice: true };
  const what = msg.what === 'voice' ? 'voice' : msg.what === 'faster voice' ? 'faster voice' : msg.what === 'captions' ? 'live captions' : 'speech recognition';
  if (msg.failed) return { text: `The ${what} could not be downloaded — I will try again next time`, ttl: 6000 };
  if (msg.done) return { text: `${what} ready`, ttl: 2500 };
  if (msg.total) return { text: `Downloading ${what} model (one time) — ${Math.round((msg.loaded / msg.total) * 100)}%`, ttl: 0 };
  return null;
}

/**
 * What to ask the speech process to say a sentence with, for these voice settings: the fast voice's
 * options, a Kokoro voice name, or null when the system voice (or silence) is chosen.
 */
export function synthVoice(s) {
  if (s.tts === 'tiny') return { engine: 'tiny', voice: s.tinyVoice || 'M2', speed: s.tinySpeed || 1, kokoro: s.kokoroVoice };
  if (s.tts === 'kokoro') return s.kokoroVoice || 'bm_george';
  return null;
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
   * @param cb {onUtterance(text), onPartial(text), onSpoken(upTo), onBargeIn(), onState(state), onStatus(text), onNotice(text), onDevices(), settings() -> voice settings}
   * state: 'idle' | 'hearing' | 'transcribing' | 'speaking'
   * onPartial: the words heard so far, while the user is still talking.
   * onSpoken: the reply is being spoken up to this many characters of the text given to say().
   */
  constructor(cb) {
    this.cb = cb;
    this.level = 0; // mic or speech level 0..1, read by the orb
    this.micLevel = 0; // the microphone alone, for the meter in the controls
    this.micOn = false;
    // devices: what is plugged in, what is open ('' = system default), and which saved choice is being stood in for
    this.devices = [];
    this.micId = '';
    this.sinkId = '';
    this.missing = { microphone: '', speaker: '' };
    this.micDown = false; // true once "microphone unavailable" has been said
    globalThis.navigator?.mediaDevices?.addEventListener('devicechange', () => this.syncDevices());
    this.muted = false;
    this.ptt = false;
    // capture
    this.frame = [];
    this.frameLen = 0;
    this.preroll = [];
    this.capture = null; // {frames:[], voiced, silence, speech, liveAt, live}
    this.liveCaptions = true;
    this.noise = 0.004;
    this.onset = 0;
    this.holdUntil = 0;
    this.holds = new Set(); // things playing sound of their own (a video in the viewer): not the user talking
    // speech out
    this.epoch = 0;
    this.textBuf = '';
    this.fed = 0; // characters given to say() since the last hush
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
    if (!this.micOn) await this.syncDevices();
    return this.micOn;
  }

  /**
   * Bring the open microphone and the speaker in line with the saved choices and with what is
   * plugged in right now. Call it whenever either may have changed; calls run one after another.
   */
  syncDevices() {
    this.syncing = (this.syncing || Promise.resolve()).then(() => this._sync()).catch(() => {});
    return this.syncing;
  }

  async _sync() {
    const s = this.cb.settings();
    const list = () => navigator.mediaDevices.enumerateDevices().catch(() => []);
    this.devices = await list();
    await this._useSpeaker(s.outputDevice || '');
    // Device names can be withheld until a microphone has been opened: look again after opening one.
    if (await this._useMic(s.inputDevice || '')) this.devices = await list();
    this.cb.onDevices?.();
  }

  /** All of Jarvis's sound leaves through the one context, so moving its sink moves everything. */
  async _useSpeaker(wanted) {
    const ctx = this._ctx();
    if (!ctx.setSinkId) return;
    let id = resolveDevice(this.devices, 'audiooutput', wanted);
    if (id !== this.sinkId) {
      try {
        await ctx.setSinkId(id);
      } catch {
        id = '';
        await ctx.setSinkId('').catch(() => {});
      }
      this.sinkId = id;
    }
    if (ctx.state === 'suspended') ctx.resume(); // the microphone is read through this context too
    this._standIn('speaker', wanted, id);
  }

  /** Returns true if a microphone was (re)opened. */
  async _useMic(wanted) {
    const id = resolveDevice(this.devices, 'audioinput', wanted);
    if (this.micOn && id === this.micId) {
      this._standIn('microphone', wanted, id);
      return false;
    }
    let error;
    let opened = false;
    // If the chosen microphone will not open, the system default is better than going deaf.
    for (const attempt of id ? [id, ''] : ['']) {
      error = null;
      if (this.micOn && attempt === this.micId) break; // already standing in
      try {
        await this._openMic(attempt);
        opened = true;
        break;
      } catch (err) {
        error = err;
      }
    }
    if (error && !this.micOn) {
      if (!this.micDown) this.cb.onStatus(`Microphone unavailable (${error.message}). You can still type.`);
      this.micDown = true;
      if (this.capture && !this.ptt) this._finish(); // nothing more is coming
      return false;
    }
    this.micDown = false;
    this._standIn('microphone', wanted, this.micId);
    return opened;
  }

  /** Say once when a saved device is missing and the system default is standing in, and when it returns. */
  _standIn(what, wanted, used) {
    if (wanted && used !== wanted) {
      if (this.missing[what] !== wanted) this.cb.onNotice?.(`The saved ${what} is not available. Using the system default.`);
      this.missing[what] = wanted;
    } else {
      if (wanted && this.missing[what] === wanted) this.cb.onNotice?.(`The saved ${what} is back. Using it again.`);
      this.missing[what] = '';
    }
  }

  /** Open a microphone ('' = system default) and swap it in for the one in use, which stays open until then. */
  async _openMic(id) {
    const ctx = this._ctx();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: id ? { ...MIC, deviceId: { exact: id } } : MIC });
    try {
      if (!this.tap) { // registered once; every microphone after the first plugs into the same tap
        const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
        this.worklet ||= ctx.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
        await this.worklet.catch((err) => { this.worklet = null; throw err; });
        this.tap = new AudioWorkletNode(ctx, 'tap');
        this.tap.port.onmessage = (e) => this._onAudio(e.data);
      }
    } catch (err) {
      for (const t of stream.getTracks()) t.stop();
      throw err;
    }
    this._closeMic();
    this.stream = stream;
    this.micNode = ctx.createMediaStreamSource(stream);
    this.micNode.connect(this.tap);
    this.frameSize = Math.round((ctx.sampleRate * FRAME_MS) / 1000);
    this.micId = id;
    this.micOn = true;
    // A different microphone has a different floor: learn it afresh. An utterance in progress carries on.
    this.noise = 0.004;
    this.onset = 0;
    this.preroll = [];
    stream.getAudioTracks()[0].onended = () => { // unplugged
      if (this.stream !== stream) return;
      this._closeMic();
      this.syncDevices();
    };
  }

  _closeMic() {
    this.micNode?.disconnect();
    this.micNode = null;
    for (const t of this.stream?.getTracks() || []) { t.onended = null; t.stop(); }
    this.stream = null;
    this.micOn = false;
    this.micLevel = 0;
  }

  /** Hands-free listening pauses while `key` is held (push-to-talk still works). */
  hold(key, on) {
    if (!on) return void this.holds.delete(key);
    this.holds.add(key);
    if (this.capture && !this.ptt) { this._drop(); this.cb.onState('idle'); }
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
    this.micLevel = Math.min(1, rms * 9);
    if (!this.speaking) this.level = Math.min(1, rms * 9);

    const s = this.cb.settings();
    const speaking = this.speaking || performance.now() < this.holdUntil;
    if (this.muted && !this.ptt) return;
    if (this.ptt) {
      const cap = this.capture;
      if (!cap) return;
      cap.frames.push(frame);
      cap.voiced++;
      if (rms > Math.max(0.014, this.noise * 3.2) * 0.6) cap.speech++;
      this._unguess(cap);
      this._live(cap);
      return;
    }
    if (!s.handsFree) return;
    if (this.holds.size) { this.onset = 0; return; }
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
    if (rms > threshold * 0.6) { cap.voiced++; cap.speech++; cap.silence = 0; this._unguess(cap); } else cap.silence++;
    this._live(cap);
    if (cap.silence === GUESS_AFTER && cap.voiced >= 12 && !cap.guess) {
      cap.guess = window.jarvis.invoke('speech:transcribe', this._pcm(cap.frames), true).catch(() => null);
    }
    // A shorter pause ends a short remark; give longer thoughts a little more room.
    const patience = cap.voiced > 150 ? PAUSE_LONG : PAUSE;
    if (cap.silence >= patience || cap.frames.length > 1500) this._finish();
  }

  /**
   * Ask for a caption of what has been said so far, while the user is audibly talking. One at a time,
   * never alongside a hunch, and one that comes back after the remark ended (or was dropped) is ignored.
   */
  _live(cap) {
    if (!this.liveCaptions || cap.live || cap.guess || cap.silence || cap.speech < LIVE_FIRST) return;
    if (cap.liveAt && cap.frames.length - cap.liveAt < LIVE_EVERY) return;
    cap.live = true;
    cap.liveAt = cap.frames.length;
    window.jarvis.invoke('speech:partial', this._pcm(cap.frames.slice(-LIVE_SPAN)))
      .catch(() => null)
      .then((text) => {
        cap.live = false;
        if (text && this.capture === cap) this.cb.onPartial?.(text);
      });
  }

  /** The user went on talking: the transcription started on a hunch is of half a remark. */
  _unguess(cap) {
    if (!cap.guess) return;
    cap.guess = null;
    window.jarvis.invoke('speech:stale').catch(() => {});
  }

  /** The captured frames as one 16 kHz clip, which is what the recognizer takes. */
  _pcm(frames) {
    const pcm = new Float32Array(frames.reduce((n, f) => n + f.length, 0));
    let o = 0;
    for (const f of frames) { pcm.set(f, o); o += f.length; }
    return resample(pcm, this.ctx.sampleRate, 16000);
  }

  _begin(pre = []) {
    this.capture = { frames: [...pre], voiced: 0, silence: 0, speech: 0, liveAt: 0, live: false };
    this.preroll = [];
    this.onset = 0;
    this.cb.onState('hearing');
  }

  _drop() {
    if (this.capture) this._unguess(this.capture);
    this.capture = null;
    this.onset = 0;
  }

  async _finish() {
    const cap = this.capture;
    this.capture = null;
    if (!cap) return;
    if (cap.voiced < 12) { // under ~a quarter second of actual voice: a cough, a click
      this._unguess(cap);
      this.cb.onState('idle');
      return;
    }
    this.cb.onState('transcribing');
    try {
      // Nothing but silence has arrived since the hunch, so its transcript is the whole remark.
      let text = cap.guess ? await cap.guess : null;
      if (text == null) text = await window.jarvis.invoke('speech:transcribe', this._pcm(cap.frames));
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
    this.fed += delta.length;
    for (;;) {
      // A sentence ends at punctuation followed by a space; very short fragments ("Mr.", "3.") stay attached.
      let cut = -1;
      const re = /[.!?…]+["')\]]*\s+/g;
      for (let m; (m = re.exec(this.textBuf)); ) {
        if (m.index + m[0].length >= 14) { cut = m.index + m[0].length; break; }
      }
      // Get the first words out fast: the opening is spoken as soon as it reaches a comma.
      if (cut < 0 && this.firstChunk) {
        const m = /^[\s\S]{18,}?[,;:—]\s+/.exec(this.textBuf);
        if (m) cut = m[0].length;
      }
      if (cut < 0) break;
      this._enqueue(this.textBuf.slice(0, cut), this.fed - this.textBuf.length + cut);
      this.textBuf = this.textBuf.slice(cut);
    }
  }

  /** The reply is complete: speak whatever is left in the buffer. */
  flush() {
    if (this.textBuf.trim()) this._enqueue(this.textBuf, this.fed);
    this.textBuf = '';
    this.firstChunk = true;
  }

  /** `upTo`: where this piece ends in the text given to say(), for the caption that follows the voice. */
  _enqueue(raw, upTo = this.fed) {
    const text = speakable(raw);
    if (!text) { // nothing to read aloud (a code block), but the caption still moves past it in turn
      const epoch = this.epoch;
      this.queue = this.queue.then(() => { if (epoch === this.epoch) this.cb.onSpoken?.(upTo); });
      return;
    }
    this.firstChunk = false;
    const s = this.cb.settings();
    const epoch = this.epoch;
    this.pendingSpeech++;
    this.cb.onState('speaking');
    // Start synthesis now so audio is ready by the time the previous sentence ends.
    const how = synthVoice(s);
    const audio = how ? window.jarvis.invoke('speech:synthesize', text, how).catch(() => null) : null;
    this.queue = this.queue.then(async () => {
      try {
        if (epoch !== this.epoch) return;
        if (s.tts === 'off') {
          this.cb.onSpoken?.(upTo);
          await new Promise((r) => setTimeout(r, Math.min(4000, text.length * 45)));
        } else {
          const clip = audio && (await audio);
          if (epoch !== this.epoch) return;
          this.heard += (this.heard ? ' ' : '') + text;
          this.cb.onSpoken?.(upTo);
          if (clip?.audio?.length) await this._play(clip, epoch);
          else if (!clip?.audio) await this._systemSpeak(text, s, epoch); // an empty clip: nothing to pronounce
        }
      } finally {
        if (epoch !== this.epoch) return; // hushed: the counter was already reset
        this.pendingSpeech--;
        if (this.pendingSpeech === 0) {
          this.level = 0;
          this.holdUntil = performance.now() + 350 + this._lag(); // let the room echo die before trusting the mic
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

  /** How far behind the speaker runs (ms): a wireless or HDMI output is still sounding after the last sample is sent. */
  _lag() {
    return Math.min(1000, (this.ctx?.outputLatency || 0) * 1000);
  }

  /** A short two-note chime through the chosen speaker, to confirm where Jarvis will be heard. */
  testTone() {
    const ctx = this._ctx();
    const t0 = ctx.currentTime + 0.03;
    let last;
    for (const [freq, at] of [[587.33, 0], [880, 0.15]]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0 + at);
      gain.gain.exponentialRampToValueAtTime(0.2, t0 + at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.5);
      osc.connect(gain).connect(this.analyser);
      osc.start(t0 + at);
      osc.stop(t0 + at + 0.52);
      osc.onended = () => gain.disconnect();
      last = osc;
    }
    // The microphone will hear the chime; it is not the user starting to speak.
    if (!this.capture) this.holdUntil = Math.max(this.holdUntil, performance.now() + 1000 + this._lag());
    return new Promise((resolve) => last.addEventListener('ended', resolve));
  }

  /** Stop talking immediately. Returns what had actually been said aloud so far. */
  hush() {
    this.epoch++;
    this.pendingSpeech = 0;
    this.textBuf = '';
    this.fed = 0;
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
    this.fed = 0;
  }
}
