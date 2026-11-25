import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { Orb } from './orb.js';
import { Stage, screenPass, steadyBloom, setCaptionBand, easeCaptionBand } from './stage.js';
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
const bloom = steadyBloom(new UnrealBloomPass(new THREE.Vector2(1, 1), 0.5, 0.45, 0.1));
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

// Labels keep out from under the top bar (px from the top); behind the caption they fade with their markers.
const HUD_CLEAR = { top: 88 };
const mind = new Graph3D({ labelLayer: $('labels'), hud: HUD_CLEAR, linkOpacity: 0.5, charge: -90, beamWidth: 1.2, flatten: 0.025 });
const files = new Graph3D({ labelLayer: $('labels'), hud: HUD_CLEAR, linkOpacity: 0.34, charge: -34, maxLabels: 70, beamWidth: 0.9, flatten: 0.02 });
scene.add(mind.group, files.group);

// The band the table's light fades out in is as tall as the caption: measured from the top of its
// first line of words (the user's line when there is one, else Jarvis's), whenever the caption
// block changes size or the user's line comes or goes — never per frame.
function fitCaptionBand() {
  const first = $('said-user').textContent ? $('said-user') : $('said-jarvis');
  setCaptionBand(window.innerWidth, window.innerHeight, renderer.getPixelRatio(), window.innerHeight - first.getBoundingClientRect().top);
}
new ResizeObserver(fitCaptionBand).observe($('talk'));

function resize() {
  const w = window.innerWidth;
  const hgt = window.innerHeight;
  // The drawing buffer always matches the display's pixels (also after the window moves to another
  // screen or the zoom changes), so the scan lines never beat against a rescaled canvas.
  const pr = Math.min(window.devicePixelRatio, 2);
  renderer.setPixelRatio(pr);
  composer.setPixelRatio(pr);
  renderer.setSize(w, hgt, false);
  composer.setSize(w, hgt);
  screen.uniforms.uRes.value.set(w * pr, hgt * pr);
  screen.uniforms.uPixel.value = Math.max(1, Math.round(pr));
  screen.uniforms.uDpr.value = pr;
  fitCaptionBand();
  camera.aspect = w / hgt;
  camera.updateProjectionMatrix();
  placeCallout();
}
window.addEventListener('resize', resize);
// A change of display scale does not always come with a resize event, so watch for it directly.
(function watchScale() {
  matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener('change', () => { resize(); watchScale(); }, { once: true });
})();

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
      hub: n.type === 'core' || n.type === 'project',
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
        hub: n.dir || !n.parent,
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
let follow = null; // the map being kept in frame while its layout settles (until the user takes the camera)

function flyTo(target, distance, seconds = 1.4) {
  const dir = camera.position.clone().sub(controls.target);
  if (dir.lengthSq() < 1) dir.set(0, 0.2, 1);
  dir.normalize();
  flight = { t: 0, seconds, dir, framing: false, fromPos: camera.position.clone(), fromTarget: controls.target.clone(), toTarget: target.clone(), toPos: target.clone().add(dir.clone().multiplyScalar(distance)) };
}

// The projection table. Under a map it sits clear below the map's keel and is sized to the map;
// in Core it is sized to the orb, which lives in front of the camera, so it follows the camera's
// distance from the centre.
const FLOOR = { gap: 0.32, radius: 0.42, glow: 0.5, cone: 0.12, coreDrop: 0.25, coreRadius: 0.17, coreCone: 0.22 };
const tableY = (graph) => graph.keel - Math.max(14, tableRadius(graph) * FLOOR.gap);
const tableRadius = (graph) => Math.max(50, graph.spread * FLOOR.radius);

// Framing a map: the band of the window it must sit in (clear of the top bar, the caption and the
// edges), with the table's near rim just above a one-line caption (behind a taller one the table
// fades out; the map is not re-framed every time a reply wraps). The HUD is sized in CSS pixels,
// so the band is worked out from the window's height: FRAME is px from the top for the highest
// node, px from the foot for the lowest node and for the table's rim.
const FRAME = { top: 117, bottom: 171, rim: 153 };
const framing = { sinE: 0.28, tanFov: 1, aspect: 1, top: 0.74, bottom: -0.62, side: 0.74, floorY: 0, floorR: 1, floorLimit: -0.66, minDist: 240 };
const framed = { y: 0, dist: 0 };

function solveFraming(graph, rounds) {
  const dy = camera.position.y - controls.target.y;
  framing.sinE = flight ? flight.dir.y : dy / (camera.position.distanceTo(controls.target) || 1);
  framing.tanFov = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  framing.aspect = camera.aspect;
  const hgt = window.innerHeight;
  framing.top = Math.max(0.25, 1 - (2 * FRAME.top) / hgt);
  framing.bottom = Math.min(-0.15, (2 * FRAME.bottom) / hgt - 1);
  framing.floorLimit = Math.min(framing.bottom - 0.02, (2 * FRAME.rim) / hgt - 1);
  framing.floorY = tableY(graph);
  framing.floorR = tableRadius(graph) * 1.08;
  return graph.frame(framing, framed, rounds);
}

function fit(graph) {
  flight = null;
  framed.y = (graph.top + tableY(graph)) / 2;
  framed.dist = graph.radius * 2.7;
  solveFraming(graph, 10);
  flyTo(new THREE.Vector3(0, framed.y, 0), framed.dist);
  flight.framing = true;
  follow = graph;
}

/** While a freshly shown map is still settling, keep it framed: retarget the flight, then ease after it. */
function keepFramed(dt) {
  const graph = follow;
  if (graph.settling) solveFraming(graph, 2);
  if (flight) {
    if (!flight.framing) return;
    flight.toTarget.set(0, framed.y, 0);
    flight.toPos.copy(flight.dir).multiplyScalar(framed.dist).add(flight.toTarget);
    return;
  }
  const k = 1 - Math.exp(-dt * 2.2);
  const dist = camera.position.distanceTo(controls.target);
  const off = framed.y - controls.target.y;
  const next = dist + (framed.dist - dist) * k;
  camera.position.sub(controls.target).multiplyScalar(next / (dist || 1));
  controls.target.y += off * k;
  controls.target.x -= controls.target.x * k;
  controls.target.z -= controls.target.z * k;
  camera.position.add(controls.target);
  if (!graph.settling && Math.abs(off) < 0.5 && Math.abs(framed.dist - dist) < 1) follow = null;
}

const stageAim = { y: 0, radius: 1, height: 1, opacity: 0, cone: 0, detail: 0, color: WARM };
function stageTarget() {
  const aim = stageAim;
  if (view === 'core') {
    const d = camera.position.distanceTo(controls.target);
    aim.y = controls.target.y - d * FLOOR.coreDrop;
    aim.radius = d * FLOOR.coreRadius;
    aim.height = d * FLOOR.coreDrop;
    aim.opacity = 1;
    aim.cone = FLOOR.coreCone;
    aim.detail = 1;
    aim.color = WARM;
    return aim;
  }
  const g = view === 'files' ? files : mind;
  aim.y = tableY(g);
  aim.radius = tableRadius(g);
  aim.height = (g.top - aim.y) * 0.9;
  aim.opacity = FLOOR.glow;
  aim.cone = FLOOR.cone;
  aim.detail = 0;
  aim.color = view === 'files' ? COOL : WARM;
  return aim;
}

function setView(next, focusText) {
  view = next;
  for (const b of $('views').children) b.classList.toggle('on', b.dataset.view === next);
  mind.show(next === 'mind' ? 1 : next === 'core' ? 0.3 : 0);
  files.show(next === 'files' ? 1 : 0);
  mind.labelsOn = next === 'mind';
  files.labelsOn = next === 'files';
  select(null);
  mind.setHover(null); // the map is about to move away from under the pointer
  files.setHover(null);
  follow = null;
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
const orbAim = { pos: new THREE.Vector3(), scale: 1 };
function orbTarget() {
  const d = 10;
  const halfH = d * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const halfW = halfH * camera.aspect;
  if (view === 'core') {
    orbAim.pos.set(0, halfH * 0.07, -d);
    orbAim.scale = Math.min(1.55, halfW * 0.42);
  } else {
    orbAim.pos.set(-halfW + 2.0, -halfH + 2.05, -d);
    orbAim.scale = 0.52;
  }
  return orbAim;
}

// ---------------------------------------------------------------------------
// Selection card
// ---------------------------------------------------------------------------

let selected = null; // {node, graph}

function select(node, graph) {
  const card = $('card');
  mind.setFocus(null);
  files.setFocus(null);
  mind.keepClear();
  files.keepClear();
  selected = node ? { node, graph } : null;
  if (!node) {
    card.hidden = true;
    aim.classList.remove('on');
    return;
  }
  follow = null;
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
  placeCallout();
}

// The targeting brackets around the selected node and the thin callout line tying it to its card:
// one small SVG overlay, moved each frame while something is selected.
const aim = $('aim');
const aimMark = $('aim-mark');
const aimLine = $('aim-line');
const aimAt = { x: 0, y: 0, r: 0, visible: false };
const callout = { x: 0, y: 0, half: -1, ax: NaN, ay: NaN }; // where the line leaves the card; the brackets as last drawn

/** Measured when the card or the window changes, not per frame. */
function placeCallout() {
  if (!selected) return;
  const box = $('card').getBoundingClientRect();
  callout.x = box.right + 5;
  callout.y = box.top - 5;
  callout.ax = NaN; // redraw the line
  selected.graph.keepClear(box.left - 4, box.top - 8, box.right + 10, box.bottom + 4); // no label prints under the card
}

function trackSelection(w, hgt) {
  if (!selected) return;
  const { node, graph } = selected;
  if (graph.byId.get(node.id) !== node) { // the data was rebuilt: follow the node's new record
    const now = graph.byId.get(node.id);
    if (!now) return aim.classList.remove('on');
    selected.node = now;
  }
  const at = graph.screenOf(selected.node, camera, w, hgt, aimAt);
  aim.classList.toggle('on', at.visible);
  if (!at.visible) return;
  const half = Math.round(at.r + 7);
  if (half !== callout.half) { // four corners, redrawn only when the marker changes size
    callout.half = half;
    callout.ax = NaN;
    const leg = Math.max(5, Math.round(half * 0.36));
    aimMark.setAttribute('d', `M${-half},${leg - half}V${-half}H${leg - half}M${half - leg},${-half}H${half}V${leg - half}M${half},${half - leg}V${half}H${half - leg}M${leg - half},${half}H${-half}V${half - leg}`);
  }
  const ax = Math.round(at.x * 4) / 4, ay = Math.round(at.y * 4) / 4;
  if (ax === callout.ax && ay === callout.ay) return; // nothing moved
  callout.ax = ax; callout.ay = ay;
  aimMark.setAttribute('transform', `translate(${ax},${ay})`);
  // from the card's corner bracket, a short level run, then straight to the nearest corner of the brackets
  const elbow = callout.x + 16;
  const ex = ax - half, ey = ay + (callout.y < ay ? -half : half);
  if (ex < elbow + 12) aimLine.setAttribute('points', '');
  else aimLine.setAttribute('points', `${callout.x},${callout.y} ${elbow},${callout.y} ${ex},${ey}`);
}

const activeGraph = () => (view === 'files' ? files : view === 'mind' ? mind : null);
let downAt = null;
const inHand = (on) => { mind.inHand = files.inHand = on; }; // labels hold their places while the view is turned by hand
canvas.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; controls.autoRotate = false; follow = null; inHand(true); });
canvas.addEventListener('pointercancel', () => inHand(false));
canvas.addEventListener('wheel', () => { follow = null; }, { passive: true });
canvas.addEventListener('pointermove', (e) => {
  const g = activeGraph();
  if (!g || e.buttons) return;
  const node = g.pick(camera, e.clientX, e.clientY, window.innerWidth, window.innerHeight);
  g.setHover(node?.id || null);
  canvas.style.cursor = node ? 'pointer' : 'default';
});
canvas.addEventListener('pointerleave', () => { mind.setHover(null); files.setHover(null); canvas.style.cursor = 'default'; });
canvas.addEventListener('pointerup', (e) => {
  inHand(false);
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
  fitCaptionBand(); // the user's line coming or going does not change the caption block's size
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
  if (follow) keepFramed(dt);
  controls.update();
  // controls.update() turns the camera but leaves its world matrices a frame behind; bring them up
  // to date so labels, picking and the selection brackets are placed with this frame's view
  camera.updateMatrixWorld();

  const hearing = voiceState === 'hearing';
  orb.setState(hearing ? 'listening' : voice.speaking ? 'speaking' : generating || voiceState === 'transcribing' ? 'thinking' : 'idle');
  orb.level = voice.level;
  orb.dock = view === 'core' ? 0 : 1;
  const target = orbTarget();
  const ease = 1 - Math.exp(-dt * 4);
  orb.group.position.lerp(target.pos, ease);
  orbPose.scale += (target.scale - orbPose.scale) * ease;
  const pr = renderer.getPixelRatio();
  orb.update(dt, (hgt / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)))) * orbPose.scale * pr); // in drawing-buffer pixels
  orb.group.scale.setScalar(orbPose.scale * (orb.pulse || 1));

  easeCaptionBand(dt);
  stage.update(dt, stageTarget(), camera.position);
  mind.floorY = view === 'mind' ? stage.cur.y : null;
  files.floorY = view === 'files' ? stage.cur.y : null;
  screen.uniforms.uTime.value = stage.time;
  screen.uniforms.uTint.value.copy(stage.color);
  mind.update(dt, camera, w, hgt, pr);
  files.update(dt, camera, w, hgt, pr);
  trackSelection(w, hgt);
  composer.render();
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

resize();
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
