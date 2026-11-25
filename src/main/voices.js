// The voices behind `synthesize`, each loaded only once it is chosen: tiny-voca (fast, the default)
// and Kokoro (neural, slower). If the fast voice cannot be fetched or loaded, Kokoro stands in for the
// rest of the session when it is already on disk, otherwise the system voice does; that is said once.
// No model or file access here: the loaders are handed in, so the routing can be tested on its own.

export const TINY_VOICE_IDS = ['M2', 'F2'];

/**
 * What a synthesize request asks for. A plain string is a Kokoro voice name (how the window asked
 * before there was a choice of engine); an object is {engine: 'tiny'|'kokoro', voice, speed, kokoro}.
 */
export function parseVoice(voice) {
  if (voice && typeof voice === 'object') {
    const speed = Number(voice.speed);
    return {
      engine: voice.engine === 'kokoro' ? 'kokoro' : 'tiny',
      voice: TINY_VOICE_IDS.includes(voice.voice) ? voice.voice : 'M2',
      speed: Number.isFinite(speed) ? Math.min(1.5, Math.max(0.7, speed)) : 1,
      kokoro: typeof voice.kokoro === 'string' && voice.kokoro ? voice.kokoro : 'bm_george',
    };
  }
  return { engine: 'kokoro', kokoro: typeof voice === 'string' && voice ? voice : 'bm_george' };
}

/** The engine the window's warm-up asks for: true meant Kokoro, false or 'system'/'off' nothing. */
export function warmEngine(voice) {
  if (voice === true) return 'kokoro';
  return voice === 'tiny' || voice === 'kokoro' ? voice : null;
}

export class Voices {
  /**
   * @param o.loadTiny () => Promise<{generate(text, {voice, speed})}> the fast voice, fetched on first use
   * @param o.loadKokoro (upgrade: boolean) => Promise<{generate(text, {voice})}> the neural voice;
   *   `upgrade` lets it go on to fetch its larger, faster copy — only when Kokoro is the chosen voice
   * @param o.kokoroCached () => boolean whether Kokoro can load without a download
   * @param o.post (msg) => void status messages for the window
   */
  constructor({ loadTiny, loadKokoro, kokoroCached, post }) {
    Object.assign(this, { loadTiny, loadKokoro, kokoroCached, post });
    this.tiny = null;
    this.fallback = null; // 'kokoro' | 'system' once the fast voice has failed this session
    this.ready = new Set(); // engines whose "ready" has been shown: it ends their download line
  }

  _ready(engine, model) {
    if (!this.ready.has(engine)) {
      this.ready.add(engine);
      this.post({ type: 'status', what: 'voice', done: true });
    }
    return { engine, model };
  }

  getTiny() {
    this.tiny ||= this.loadTiny().catch((err) => {
      this.fallback = this.kokoroCached() ? 'kokoro' : 'system';
      this.why = err?.message || String(err);
      return null;
    });
    return this.tiny;
  }

  /** Said once, when the stand-in is ready to speak (so its own loading lines do not hide it). */
  _tell(fallback) {
    this.fallback = fallback;
    if (this.told) return;
    this.told = true;
    this.post({ type: 'status', what: 'voice', fallback, error: this.why });
  }

  /** The model that will speak for `engine`, after any stand-in: {engine, model}, or null for the system voice. */
  async load(engine) {
    if (engine === 'kokoro') return this._ready(engine, await this.loadKokoro(true));
    if (engine !== 'tiny') return null;
    const model = await this.getTiny();
    if (model) return this._ready(engine, model);
    if (this.fallback === 'kokoro') {
      try {
        const kokoro = await this.loadKokoro(false);
        this._tell('kokoro');
        return { engine: 'kokoro', model: kokoro };
      } catch {
        this.fallback = 'system';
      }
    }
    this._tell('system');
    return null;
  }

  /** Load the chosen voice ahead of the first sentence. Resolves true if a model is ready, false if the system voice will speak. */
  async warm(voice) {
    const engine = warmEngine(voice);
    if (!engine) return false;
    return Boolean(await this.load(engine));
  }

  /** {audio, rate}, or null when the system voice has to speak this. An empty clip means there was nothing to say. */
  async synthesize({ text, voice }) {
    const want = parseVoice(voice);
    const got = await this.load(want.engine);
    if (!got) return null;
    const out = got.engine === 'tiny'
      ? await got.model.generate(text, { voice: want.voice, speed: want.speed })
      : await got.model.generate(text, { voice: want.kokoro });
    return { audio: out.audio, rate: out.sampling_rate };
  }
}
