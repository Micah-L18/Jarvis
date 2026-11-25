// Tiny JSON-file persistence. Everything Jarvis keeps lives under one data directory.
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_SETTINGS = {
  provider: 'cloud', // 'cloud' (Anthropic) | 'local' (Ollama)
  cloudAuth: 'cli', // how the cloud brain signs in: 'cli' (the Claude Code login on this computer) | 'key' (an Anthropic API key)
  claudePath: '', // where the claude program is, if it is not found by itself
  cloudModel: 'claude-opus-5-5',
  effort: 'low', // low | medium | high — how hard the cloud model thinks before answering
  localModel: '',
  ollamaUrl: 'http://localhost:11434',
  webSearch: true,
  userName: '',
  address: 'sir',
  voice: {
    tts: 'kokoro', // 'kokoro' (local neural voice) | 'system' (OS voices) | 'off'
    kokoroVoice: 'bm_george',
    systemVoice: '',
    inputDevice: '', // microphone and speaker device ids; '' follows the system default
    outputDevice: '',
    handsFree: true,
    bargeIn: true,
  },
  fsRoot: '',
  fsDepth: 3,
  startFullscreen: true,
  mcpServers: [], // {id, name, type:'stdio'|'http', command, args, env, url, headers, enabled}
  disabledSkills: [],
};

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function merge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])
      ? merge(base[k], v)
      : v;
  }
  return out;
}

export class Settings {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'settings.json');
    this.value = merge(DEFAULT_SETTINGS, readJson(this.file, {}));
  }
  get() {
    return this.value;
  }
  set(patch) {
    this.value = merge(this.value, patch);
    writeJson(this.file, this.value);
    return this.value;
  }
}

export function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60) || 'untitled';
}
