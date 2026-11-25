import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { Orb } from './orb.js';
import { Stage, screenPass } from './stage.js';
import { Graph3D } from './graph.js';
import { Voice } from './voice.js';
import { Panel, h } from './panel.js';

const api = window.jarvis;
const $ = (id) => document.getElementById(id);
let state = await api.invoke('state');

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------

const canvas = $('space');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(0x000000, 1); // the room itself is painted by the screen pass
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 20000);
camera.position.set(0, 118, 404); // looking a little down, onto the projection table
scene.add(camera);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.rotateSpeed = 0.5;
controls.zoomSpeed = 0.8;
controls.autoRotate = true;
controls.autoRotateSpeed = 0.25;
controls.minDistance = 20;
controls.maxDistance = 6000;

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.5, 0.45, 0.1);
composer.addPass(bloom);
const screen = screenPass(); // room backdrop + scan lines + sRGB, in place of the stock output pass
composer.addPass(screen);

// The projection table everything stands on.
const stage = new Stage();
scene.add(stage.group);
const WARM = new THREE.Color('#ff9a2e');
const COOL = new THREE.Color('#35c8ff');

const orb = new Orb();
camera.add(orb.group); // the hologram lives in front of the camera, like a HUD element
const orbPose = { pos: new THREE.Vector3(0, 0.25, -10), scale: 1.2 };
orb.group.position.copy(orbPose.pos);

const mind = new Graph3D({ labelLayer: $('labels'), linkOpacity: 0.4, charge: -90, beamWidth: 2.4 });
const files = new Graph3D({ labelLayer: $('labels'), linkOpacity: 0.26, charge: -34, maxLabels: 70, beamWidth: 1.7 });
scene.add(mind.group, files.group);

function resize() {
  const w = window.innerWidth;
  const hgt = window.innerHeight;
  renderer.setSize(w, hgt, false);
  composer.setSize(w, hgt);
  const pr = renderer.getPixelRatio();
  screen.uniforms.uRes.value.set(w * pr, hgt * pr);
  screen.uniforms.uPixel.value = Math.max(1, Math.round(pr));
  camera.aspect = w / hgt;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------------------
// Mind map (what Jarvis knows)
// ---------------------------------------------------------------------------

const TYPE_COLOR = {
  core: '#fff2d0', project: '#ffc233', topic: '#ff8a1a', person: '#58d6ff', fact: '#ffae5c',
  preference: '#ff7eb6', task: '#ff5a3c', document: '#f2f2ff',
};

function buildMind() {
  const { nodes, edges, activeProject } = state.memory;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  mind.setData(
    nodes.map((n) => ({
      id: n.id,
      label: n.label,
      color: TYPE_COLOR[n.type] || TYPE_COLOR.topic,
      size: n.type === 'core' ? 13 : n.type === 'project' ? (n.id === activeProject ? 10 : 7.5) : n.type === 'document' ? 5 : 3.6 + Math.min(n.weight || 1, 6) * 0.45,
      showLabel: n.type === 'core' || n.type === 'project' || nodes.length < 40,
      pinned: n.type === 'core',
      stem: n.type === 'core' || n.type === 'project',
      near: n.type === 'project' ? 'core' : n.project,
      spread: 35,
      data: n,
    })),
    edges.map((e) => {
      const a = byId.get(e.source), b = byId.get(e.target);
      const hub = a?.type === 'core' || b?.type === 'core';
      const proj = a?.type === 'project' || b?.type === 'project';
      return { source: e.source, target: e.target, distance: hub ? 120 : proj ? 48 : 34, strength: hub ? 0.5 : proj ? 0.7 : 0.25, label: e.label };
    }),
  );
}

// ---------------------------------------------------------------------------
// File map
// ---------------------------------------------------------------------------

const KIND_COLOR = {
  dir: '#38b6ff', code: '#5dffb5', doc: '#ffc76b', data: '#b48cff', image: '#ff7eb6', media: '#ff6a4d',
  archive: '#8e9aa8', slides: '#ffa23a', other: '#6f8fb0',
};
let fileNodes = [];
let filesLoaded = false;
let filesLoading = null;

function buildFiles() {
  const kids = new Map();
  for (const n of fileNodes) if (n.parent) kids.set(n.parent, (kids.get(n.parent) || 0) + 1);
  files.setData(
    fileNodes.map((n) => {
      const c = kids.get(n.id) || 0;
      return {
        id: n.id,
        label: n.name,
        color: n.parent ? KIND_COLOR[n.kind] || KIND_COLOR.other : '#ffffff',
        size: !n.parent ? 12 : n.dir ? 3.2 + Math.min(6, Math.log2(1 + c + n.more) * 1.1) : 2.2,
        shape: n.dir ? 1 : 0, // folders are diamonds, files are dots
        showLabel: n.depth <= 1 && (n.dir || fileNodes.length < 200),
        pinned: !n.parent,
        stem: !n.parent || (n.dir && n.depth <= 1),
        near: n.parent,
        spread: [0, 90, 40, 22, 14, 10][Math.min(5, n.depth)],
        data: n,
      };
    }),
    fileNodes.filter((n) => n.parent).map((n) => ({ source: n.parent, target: n.id, distance: n.dir ? [0, 110, 55, 32, 22, 16][Math.min(5, n.depth)] : 12, strength: n.dir ? 0.7 : 0.9 })),
  );
}

async function loadFiles(force = false) {
  if (filesLoaded && !force) return;
  if (!filesLoading) {
    setStatus('Mapping your files…');
    filesLoading = api.invoke('fs:scan').then((res) => {
      fileNodes = res.nodes;
      files.byId = new Map(); // fresh layout for a fresh scan
      buildFiles();
      filesLoaded = true;
      filesLoading = null;
      setStatus(`${res.nodes.length.toLocaleString()} files and folders mapped${res.truncated ? ' — click a folder to open it further' : ''}`, 5000);
      if (view === 'files') fit(files);
    });
  }
  return filesLoading;
}

async function expandFolder(node) {
  const more = await api.invoke('fs:expand', node.id, node.depth);
  const have = new Set(fileNodes.map((n) => n.id));
  const fresh = more.filter((n) => !have.has(n.id));
  if (!fresh.length) return toast('Nothing more inside that folder.');
  fileNodes.push(...fresh);
  node.more = 0;
  buildFiles();
  files.setFocus(node.id);
}

// ---------------------------------------------------------------------------
// Views and camera
// ---------------------------------------------------------------------------

let view = 'core';
let flight = null;

function flyTo(target, distance, seconds = 1.4) {
  const dir = camera.position.clone().sub(controls.target);
  if (dir.lengthSq() < 1) dir.set(0, 0.2, 1);
  dir.normalize();
  flight = { t: 0, seconds, fromPos: camera.position.clone(), fromTarget: controls.target.clone(), toTarget: target.clone(), toPos: target.clone().add(dir.multiplyScalar(distance)) };
}

// Where the projection table sits. Under a map it is sized to the map; in Core it is sized to the
// orb, which lives in front of the camera, so it follows the camera's distance from the centre.
const FLOOR = { dropMin: 0.58, dropMax: 0.92, radius: 0.66, glow: 0.62, coreDrop: 0.25, coreRadius: 0.2 };

/** How far below a map's centre its table sits: just under the lowest node, within limits that keep it in the picture. */
function floorDrop(graph) {
  return THREE.MathUtils.clamp(-graph.bottom + graph.radius * 0.06, graph.radius * FLOOR.dropMin, graph.radius * FLOOR.dropMax);
}

function fit(graph) {
  // Aim a little below the middle of the map (more, the lower its table), so the table is in the picture too.
  const aim = (floorDrop(graph) - graph.radius * 0.5) * 0.4;
  flyTo(new THREE.Vector3(0, -aim, 0), Math.max(280, graph.radius * 2.65));
}

function stageTarget() {
  if (view === 'core') {
    const d = camera.position.distanceTo(controls.target);
    return { y: controls.target.y - d * FLOOR.coreDrop, radius: d * FLOOR.coreRadius, height: d * FLOOR.coreDrop, opacity: 1, color: WARM };
  }
  const g = view === 'files' ? files : mind;
  const drop = floorDrop(g);
  return { y: -drop, radius: g.radius * FLOOR.radius, height: drop * 1.2, opacity: FLOOR.glow, color: view === 'files' ? COOL : WARM };
}

function setView(next, focusText) {
  view = next;
  for (const b of $('views').children) b.classList.toggle('on', b.dataset.view === next);
  mind.show(next === 'mind' ? 1 : next === 'core' ? 0.3 : 0);
  files.show(next === 'files' ? 1 : 0);
  mind.labelsOn = next === 'mind';
  files.labelsOn = next === 'files';
  select(null);
  controls.autoRotateSpeed = next === 'core' ? 0.25 : 0.12;
  if (next === 'files') loadFiles().then(() => focusText && focusByName(files, focusText));
  const graph = next === 'files' ? files : mind;
  if (focusText && next !== 'files' && focusByName(mind, focusText)) return;
  if (next === 'core') flyTo(new THREE.Vector3(0, 0, 0), Math.max(420, mind.radius * 2.6));
  else fit(graph);
}

function focusByName(graph, text) {
  const node = graph.find(text);
  if (node) select(node, graph);
  return Boolean(node);
}

// Where the hologram sits: centre stage in Core, docked bottom-left while a map is up.
function orbTarget() {
  const d = 10;
  const halfH = d * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const halfW = halfH * camera.aspect;
  if (view === 'core') return { pos: new THREE.Vector3(0, halfH * 0.07, -d), scale: Math.min(1.55, halfW * 0.42) };
  return { pos: new THREE.Vector3(-halfW + 2.0, -halfH + 2.05, -d), scale: 0.52 };
}

// ---------------------------------------------------------------------------
// Selection card
// ---------------------------------------------------------------------------

let selected = null; // {node, graph}

function select(node, graph) {
  const card = $('card');
  mind.setFocus(null);
  files.setFocus(null);
  selected = node ? { node, graph } : null;
  if (!node) {
    card.hidden = true;
    return;
  }
  graph.setFocus(node.id);
  flyTo(new THREE.Vector3(node.x, node.y, node.z), graph === files ? 150 : 170, 1.1);
  const d = node.data;
  if (graph === mind) {
    const links = (graph.neighbors.get(node.id) ? [...graph.neighbors.get(node.id)] : []).map((id) => graph.byId.get(id)).filter((n) => n && n.data.type !== 'core');
    card.replaceChildren(...[
      h('div', { class: 'kind' }, d.type === 'core' ? 'core' : d.type),
      h('h2', {}, d.label),
      d.summary && h('p', {}, d.summary),
      d.type === 'core' && h('p', {}, 'Everything I know hangs off this point. Projects group what belongs together.'),
      links.length > 0 && h('div', { class: 'links' }, links.slice(0, 30).map((n) => h('div', {}, '— ', h('b', {}, n.label)))),
      h('div', { class: 'row' },
        d.type === 'document' && h('button', { class: 'btn', onclick: () => api.invoke('memory:openDocument', d.id) }, 'Open'),
        d.type === 'project' && h('button', { class: 'btn', onclick: () => api.invoke('memory:activate', d.id) }, d.id === state.memory.activeProject ? 'Active project' : 'Make active'),
        d.type === 'project' && h('button', { class: 'btn', onclick: () => api.invoke('memory:openProjectFolder', d.id) }, 'Folder'),
        d.type !== 'core' && d.id !== 'project:general' && h('button', { class: 'btn danger', onclick: async () => { await api.invoke('memory:forget', d.id); select(null); toast(`Forgotten: ${d.label}`); } }, d.type === 'project' ? 'Forget project' : 'Forget'),
        h('button', { class: 'btn', onclick: () => select(null) }, 'Close')),
    ].filter(Boolean));
  } else {
    card.replaceChildren(...[
      h('div', { class: 'kind' }, d.dir ? 'folder' : `${d.kind} file`),
      h('h2', {}, d.name),
      h('div', { class: 'path' }, d.id),
      d.dir && d.more > 0 && h('p', {}, `${d.more} more item${d.more === 1 ? '' : 's'} inside not shown yet.`),
      h('div', { class: 'row' },
        d.dir && d.more > 0 && h('button', { class: 'btn solid', onclick: () => expandFolder(d) }, 'Open further'),
        h('button', { class: 'btn', onclick: () => api.invoke('fs:open', d.id) }, d.dir ? 'Open folder' : 'Open file'),
        h('button', { class: 'btn', onclick: () => api.invoke('fs:reveal', d.id) }, 'Reveal'),
        h('button', { class: 'btn', onclick: () => select(null) }, 'Close')),
    ].filter(Boolean));
  }
  card.hidden = false;
}

const activeGraph = () => (view === 'files' ? files : view === 'mind' ? mind : null);
let downAt = null;
canvas.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; controls.autoRotate = false; });
canvas.addEventListener('pointermove', (e) => {
  const g = activeGraph();
  if (!g || e.buttons) return;
  const node = g.pick(camera, e.clientX, e.clientY, window.innerWidth, window.innerHeight);
  g.setHover(node?.id || null);
  canvas.style.cursor = node ? 'pointer' : 'default';
});
canvas.addEventListener('pointerup', (e) => {
  setTimeout(() => { controls.autoRotate = true; }, 4000);
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return;
  const g = activeGraph();
  if (!g) return;
  const node = g.pick(camera, e.clientX, e.clientY, window.innerWidth, window.innerHeight);
  select(node, g);
});

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------

function toast(text, error = false) {
  const el = h('div', { class: `toast ${error ? 'error' : ''}` }, text);
  $('toasts').append(el);
  setTimeout(() => { el.style.opacity = 0; setTimeout(() => el.remove(), 600); }, error ? 9000 : 4500);
}

let statusTimer;
function setStatus(text, ttl = 0) {
  $('status-line').textContent = text;
  clearTimeout(statusTimer);
  if (ttl) statusTimer = setTimeout(() => { $('status-line').textContent = ''; }, ttl);
}

let muted = false;
function renderChips() {
  const s = state.settings;
  const model = s.provider === 'cloud' ? (state.cloudModels.find((m) => m.id === s.cloudModel)?.label || s.cloudModel).replace(/^Claude /, '').replace(/ \(.*/, '') : s.localModel || 'no model';
  $('chip-brain').textContent = `${s.provider === 'cloud' ? 'Cloud' : 'Local'} · ${model}`;
  $('chip-brain').classList.toggle('cool', s.provider === 'local');
  $('chip-net').textContent = s.webSearch ? 'Internet on' : 'Internet off';
  $('chip-net').classList.toggle('off', !s.webSearch);
  $('chip-mic').textContent = muted ? 'Mic muted' : s.voice.handsFree ? 'Listening' : 'Push to talk';
  $('chip-mic').classList.toggle('off', muted);
}
$('chip-brain').onclick = () => api.invoke('settings:set', { provider: state.settings.provider === 'cloud' ? 'local' : 'cloud' });
$('chip-net').onclick = () => api.invoke('settings:set', { webSearch: !state.settings.webSearch });
const toggleMute = () => { muted = !muted; voice.setMuted(muted); renderChips(); };
$('chip-mic').onclick = toggleMute;
for (const b of $('views').children) b.onclick = () => setView(b.dataset.view);
$('btn-full').onclick = () => api.invoke('window:fullscreen');

const panel = new Panel($('panel'), {
  state: () => state,
  toast,
  refresh: async () => { state = await api.invoke('state'); panel.render(); },
  focusMind: (id) => { if (view !== 'mind') setView('mind'); const n = mind.byId.get(id); if (n) select(n, mind); },
  setView,
  rescanFiles: () => { filesLoaded = false; loadFiles(true); if (view !== 'files') setView('files'); },
});
$('btn-panel').onclick = () => panel.toggle();

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

let generating = false;
let turn = 0;
let replyText = '';
let replyLogged = true; // false while a reply is still being generated (so an interruption needs recording)
let voiceState = 'idle';
let fadeTimer;

function showUser(text, live = false) {
  $('said-user').textContent = text;
  $('said-user').classList.toggle('live', live);
  $('said-user').classList.remove('fade');
}
function showJarvis(text) {
  // Captions follow the voice: keep the most recent couple of lines.
  const tail = text.length > 260 ? `…${text.slice(text.indexOf(' ', text.length - 260))}` : text;
  $('said-jarvis').textContent = tail;
  $('said-jarvis').classList.remove('fade');
  clearTimeout(fadeTimer);
}
function restCaptions() {
  clearTimeout(fadeTimer);
  fadeTimer = setTimeout(() => { $('said-jarvis').classList.add('fade'); $('said-user').classList.add('fade'); }, 9000);
}

const voice = new Voice({
  settings: () => state.settings.voice,
  onState: (s) => {
    voiceState = s;
    if (s === 'hearing') showUser('…', true);
    if (s === 'idle' && !generating) { voice.settle(); restCaptions(); if ($('said-user').textContent === '…') showUser(''); }
  },
  onStatus: (text) => toast(text, true),
  onBargeIn: () => interrupt(),
  onUtterance: (text) => sendToJarvis(text),
});

/** Stop Jarvis mid-thought. Returns what it had said aloud, if the reply was still unfinished. */
function interrupt() {
  const heard = voice.hush();
  const unfinished = generating && !replyLogged;
  if (generating) api.invoke('chat:abort');
  generating = false;
  $('tool-line').textContent = '';
  return unfinished ? heard : '';
}

let pendingInterrupted = '';
function sendToJarvis(text) {
  text = text.trim();
  if (!text) return;
  pendingInterrupted = interrupt() || pendingInterrupted;
  showUser(text);
  showJarvis('');
  generating = true;
  replyLogged = false;
  replyText = '';
  const interrupted = pendingInterrupted;
  pendingInterrupted = '';
  turn = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  api.invoke('chat:send', text, { interrupted, id: turn }).catch((err) => toast(err.message, true));
}

api.on('chat', (e) => {
  if (e.turn !== turn || e.type === 'start') return;
  if (e.type === 'delta') {
    if (!generating) return; // interrupted; ignore stragglers
    replyText += e.text;
    showJarvis(replyText);
    voice.say(e.text);
    $('tool-line').textContent = '';
  } else if (e.type === 'tool') {
    $('tool-line').textContent = String(e.name || '').replace(/^mcp__/, '').replace(/_+/g, ' ');
  } else if (e.type === 'notice') {
    toast(e.text);
  } else if (e.type === 'error') {
    toast(e.text, true);
    showJarvis(e.text);
    voice.say(`${e.text} `);
  } else if (e.type === 'done') {
    replyLogged = true;
    if (!generating) return;
    generating = false;
    $('tool-line').textContent = '';
    voice.flush();
    if (!voice.speaking) restCaptions();
  }
});

api.on('ui', (e) => {
  if (e.type === 'view') setView(e.view, e.focus);
  else if (e.type === 'document') toast(`Saved to ${e.project}: ${e.title}`);
  else if (e.type === 'learned') toast(`Filed in memory: ${e.labels.join(', ')}`);
});
api.on('memory', (snapshot) => {
  state.memory = snapshot;
  const keep = selected?.graph === mind ? selected.node.id : null;
  buildMind();
  if (keep && !mind.byId.has(keep)) select(null);
  panel.render();
});
api.on('settings', (next) => { state = next; renderChips(); panel.render(); });
api.on('mcp', (status) => { state.mcp = status; panel.render(); });
api.on('speech', (msg) => {
  const what = msg.what === 'voice' ? 'voice' : 'speech recognition';
  if (msg.done) setStatus(`${what} ready`, 2500);
  else if (msg.total) setStatus(`Downloading ${what} model (one time) — ${Math.round((msg.loaded / msg.total) * 100)}%`);
});

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

const form = $('type-form');
const input = $('type-input');
const typing = () => /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '');
form.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value;
  input.value = '';
  sendToJarvis(text);
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (typing()) document.activeElement.blur();
    if (!form.hidden) form.hidden = true;
    else if (panel.open) panel.toggle(false);
    else if (selected) select(null);
    else if (generating || voice.speaking) interrupt();
    return;
  }
  if (e.key === 'Tab' && !typing()) { e.preventDefault(); panel.toggle(); return; }
  if (typing() || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === '/' || e.key === 'Enter') { e.preventDefault(); form.hidden = false; input.focus(); }
  else if (e.code === 'Space') { e.preventDefault(); if (!e.repeat) { interrupt(); voice.pushToTalk(true); } }
  else if (e.key === '1') setView('core');
  else if (e.key === '2') setView('mind');
  else if (e.key === '3') setView('files');
  else if (e.key.toLowerCase() === 'm') toggleMute();
  else if (e.key.toLowerCase() === 'f') api.invoke('window:fullscreen');
});
window.addEventListener('keyup', (e) => { if (e.code === 'Space') voice.pushToTalk(false); });

// ---------------------------------------------------------------------------
// Frame loop
// ---------------------------------------------------------------------------

let lastFrame = performance.now();
function frame(now = performance.now()) {
  const dt = Math.min((now - lastFrame) / 1000, 0.05);
  lastFrame = now;
  const w = window.innerWidth;
  const hgt = window.innerHeight;

  if (flight) {
    flight.t = Math.min(1, flight.t + dt / flight.seconds);
    const k = flight.t < 0.5 ? 4 * flight.t ** 3 : 1 - (-2 * flight.t + 2) ** 3 / 2;
    camera.position.lerpVectors(flight.fromPos, flight.toPos, k);
    controls.target.lerpVectors(flight.fromTarget, flight.toTarget, k);
    if (flight.t >= 1) flight = null;
  }
  controls.update();

  const hearing = voiceState === 'hearing';
  orb.setState(hearing ? 'listening' : voice.speaking ? 'speaking' : generating || voiceState === 'transcribing' ? 'thinking' : 'idle');
  orb.level = voice.level;
  orb.dock = view === 'core' ? 0 : 1;
  const target = orbTarget();
  const ease = 1 - Math.exp(-dt * 4);
  orb.group.position.lerp(target.pos, ease);
  orbPose.scale += (target.scale - orbPose.scale) * ease;
  orb.update(dt, (hgt / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)))) * orbPose.scale);
  orb.group.scale.setScalar(orbPose.scale * (orb.pulse || 1));

  stage.update(dt, stageTarget());
  mind.floorY = view === 'mind' ? stage.cur.y : null;
  files.floorY = view === 'files' ? stage.cur.y : null;
  screen.uniforms.uTime.value = stage.time;
  screen.uniforms.uTint.value.copy(stage.color);
  mind.update(dt, camera, w, hgt);
  files.update(dt, camera, w, hgt);
  composer.render();
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

buildMind();
renderChips();
setView('core');
requestAnimationFrame(frame);
window.__jarvis = { setView, mind, files, voice, orb, select, sendToJarvis, panel, loadFiles, state: () => state };

(async () => {
  const s = state.settings;
  if (s.provider === 'cloud' && !state.hasApiKey) toast('To wake the cloud brain, add an Anthropic API key under Brain in the panel (Tab) — or switch to Local.');
  const micOk = await voice.startMic();
  if (!micOk) { muted = true; renderChips(); }
  try {
    setStatus('Waking speech systems…');
    await api.invoke('speech:warm', s.voice.tts === 'kokoro');
    setStatus('');
    const hour = new Date().getHours();
    const greeting = `Good ${hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'}, ${s.address}. Systems are online.`;
    showJarvis(greeting);
    voice.say(greeting);
    voice.flush();
  } catch (err) {
    setStatus('');
    toast(`Speech systems could not start: ${err.message}. You can still type with /.`, true);
  }
})();
