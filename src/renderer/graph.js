// A 3D force-directed graph drawn as a hologram: ringed markers joined by thin beams of light,
// hanging in the air above the projection table. Used twice — once for what Jarvis knows, once for
// the file system.
import * as THREE from 'three';
import { forceSimulation, forceLink, forceManyBody, forceCenter, forceY } from 'd3-force-3d';
import { CAPTION, CAPTION_MASK, captionFade } from './stage.js';

// Marker size on screen, in CSS pixels = node size * viewport height * MARK_SCALE / distance. Past the
// knee a marker grows more slowly and it never exceeds MARK_MAX, so a close-up hub cannot take over.
const MARK_SCALE = 1.45;
const MARK_MIN = 2.6;
const MARK_KNEE = 30;
const MARK_MAX = 48;
const MARK_DETAIL = 12; // from about this size a marker has room for its rings
const FOCUS_GROW = 1.5;
const HOVER_GROW = 1.25;
const DIAMOND = 0.72; // a diamond's flats sit this much closer in than a circle of the same marker
const KEEL = 0.4; // slope of the upturned cone the map is taken to sit in (see Graph3D.keel)

function markPx(size, height, dist) {
  let px = (size * height * MARK_SCALE) / dist;
  if (px > MARK_KNEE) px = MARK_KNEE + (px - MARK_KNEE) * 0.35;
  return Math.min(MARK_MAX, Math.max(MARK_MIN, px));
}

// Nodes are markers, not stars: a bright core inside a thin halo ring; hubs carry a second, outer
// ring; the selected node's outer ring is broken and turns slowly. aShape 1 draws the same thing as
// a diamond (folders). aRing: -1 a bare dot (dimmed while something else is selected), 0 plain,
// 1 hub or hovered, 2 selected. All sizes are CSS pixels (uPr is the renderer's pixel ratio), so
// strokes stay thin and identical on any display. Like everything else the table projects, markers
// and beams fade out where they would run behind the caption.
const VERT = /* glsl */ `
  attribute vec3 aColor; attribute float aSize; attribute float aAlpha; attribute float aShape; attribute float aRing;
  uniform float uScale; uniform float uPr;
  varying vec3 vColor; varying float vAlpha; varying float vPx; varying float vShape; varying float vRing;
  void main(){
    vColor = aColor; vAlpha = aAlpha; vShape = aShape; vRing = aRing;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float px = aSize * uScale / max(-mv.z, 0.001);
    px = min(px, ${MARK_KNEE.toFixed(1)} + (px - ${MARK_KNEE.toFixed(1)}) * 0.35);
    vPx = clamp(px, ${MARK_MIN.toFixed(1)}, ${MARK_MAX.toFixed(1)});
    gl_PointSize = vPx * uPr;
    gl_Position = projectionMatrix * mv;
  }`;
const FRAG = /* glsl */ `
  uniform float uOpacity; uniform float uSpin;
  varying vec3 vColor; varying float vAlpha; varying float vPx; varying float vShape; varying float vRing;
  ${CAPTION_MASK}
  void main(){
    vec2 p = gl_PointCoord - 0.5;
    float R = 0.5 * vPx;                                   // everything below is in CSS pixels
    float k = mix(1.0, ${DIAMOND.toFixed(2)}, vShape);
    float d = mix(length(p), (abs(p.x) + abs(p.y)) * 0.7071, vShape) * vPx; // distance from the centre / from a diamond's edge
    // rings need room, a node that is not dimmed, and a map that is up (behind the orb in Core it is only dots)
    float detail = smoothstep(${(MARK_DETAIL - 3).toFixed(1)}, ${(MARK_DETAIL + 3).toFixed(1)}, vPx) * step(-0.5, vRing) * smoothstep(0.35, 0.8, uOpacity);
    float coreR = max(min(R * mix(0.5, 0.2, detail), 1.9 + R * 0.06), 1.0) * k; // the core stays a point, however close
    float core = 1.0 - smoothstep(coreR - 0.7, coreR + 0.7, d);
    float w = 0.3 + vPx * 0.007;                            // half a stroke
    float r1 = R * 0.56 * k;
    float ring1 = (1.0 - smoothstep(w, w + 0.9, abs(d - r1))) * detail;
    float hub = step(0.5, vRing), sel = step(1.5, vRing);
    float r2 = (R * 0.92 - 0.8) * k;
    float ring2 = (1.0 - smoothstep(w, w + 0.9, abs(d - r2))) * detail * hub;
    ring2 *= mix(1.0, smoothstep(0.2, 0.36, abs(sin((atan(p.y, p.x) + uSpin) * 1.5))), sel);
    float fill = (1.0 - smoothstep(r1 - 1.0, r1, d)) * detail;
    float glow = 1.0 - smoothstep(0.0, mix(R * k, r1, detail), d);
    float a = (core + ring1 * 0.8 + ring2 * mix(0.55, 1.0, sel) + fill * 0.05 + glow * glow * mix(0.3, 0.14, detail)) * vAlpha * uOpacity * captionMask();
    if (a < 0.004) discard;
    gl_FragColor = vec4(mix(vColor, vec3(1.0), core * mix(0.3, 0.6, detail)), a); // small markers keep their type colour
  }`;

// Links are beams: thin camera-facing ribbons, one instanced quad per link (a single draw call
// however many there are). The quad is a little wider than the beam and the fragment shader draws
// the line inside it from the distance to its centre, so even a hairline stays smooth.
const BEAM_PAD = 1.5;
const BEAM_VERT = /* glsl */ `
  attribute vec3 aStart; attribute vec3 aEnd; attribute vec3 aColStart; attribute vec3 aColEnd;
  uniform vec2 uView; uniform float uWidth;                 // uView: the viewport in CSS pixels
  varying vec3 vColor; varying float vD;
  void main(){
    vColor = mix(aColStart, aColEnd, position.y);
    float halfW = uWidth * 0.5 + ${BEAM_PAD.toFixed(1)};
    vD = position.x * halfW;
    vec4 s = modelViewMatrix * vec4(aStart, 1.0);
    vec4 e = modelViewMatrix * vec4(aEnd, 1.0);
    float near = -1.0;                                      // trim whatever passes behind the camera
    if (s.z > near && e.z > near) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
    if (s.z > near) s = mix(e, s, (near - e.z) / (s.z - e.z));
    else if (e.z > near) e = mix(s, e, (near - s.z) / (e.z - s.z));
    vec4 cs = projectionMatrix * s;
    vec4 ce = projectionMatrix * e;
    vec2 dir = (ce.xy / ce.w - cs.xy / cs.w) * uView;
    float len = length(dir);
    dir = len > 1e-4 ? dir / len : vec2(1.0, 0.0);
    vec4 c = mix(cs, ce, position.y);
    c.xy += vec2(-dir.y, dir.x) * position.x * halfW * 2.0 / uView * c.w;
    gl_Position = c;
  }`;
const BEAM_FRAG = /* glsl */ `
  uniform float uOpacity; uniform float uWidth;
  varying vec3 vColor; varying float vD;
  ${CAPTION_MASK}
  void main(){
    float x = abs(vD);                                      // CSS pixels from the centre of the beam
    float core = 1.0 - smoothstep(uWidth * 0.5 - 0.5, uWidth * 0.5 + 0.5, x);
    float glow = max(0.0, 1.0 - x / (uWidth * 0.5 + ${BEAM_PAD.toFixed(1)}));
    gl_FragColor = vec4(vColor, (core + glow * glow * 0.22) * uOpacity * captionMask());
  }`;

function beamGeometry(count) {
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, 0, 0, 1, 0, 0, -1, 1, 0, 1, 1, 0], 3));
  geo.setIndex([0, 1, 2, 2, 1, 3]);
  const ends = new THREE.InstancedInterleavedBuffer(new Float32Array(Math.max(1, count) * 6), 6);
  const cols = new THREE.InstancedInterleavedBuffer(new Float32Array(Math.max(1, count) * 6), 6);
  geo.setAttribute('aStart', new THREE.InterleavedBufferAttribute(ends, 3, 0));
  geo.setAttribute('aEnd', new THREE.InterleavedBufferAttribute(ends, 3, 3));
  geo.setAttribute('aColStart', new THREE.InterleavedBufferAttribute(cols, 3, 0));
  geo.setAttribute('aColEnd', new THREE.InterleavedBufferAttribute(cols, 3, 3));
  geo.instanceCount = count;
  geo.userData = { ends, cols };
  return geo;
}

// Plumb lines: the hovered and the selected node each drop a line to the projection table, ending
// in a small landing ring. A few slots are enough (two in use, the rest fading out).
const STEM_SLOTS = 4;
const FOOT = 20; // segments in a landing ring
const STEM_VERTS = (1 + FOOT) * 2;
const CIRCLE = new Float32Array((FOOT + 1) * 2); // the unit circle, worked out once
for (let j = 0; j <= FOOT; j++) {
  CIRCLE[j * 2] = Math.cos((j / FOOT) * Math.PI * 2);
  CIRCLE[j * 2 + 1] = Math.sin((j / FOOT) * Math.PI * 2);
}

// Labels that would print over one another (or over the selected marker) step aside: each tries
// its own line to the right of its marker, then one line below, one above, then the left of its
// marker; if all are taken by more important labels it fades out until there is room again.
const LABEL_LINE = 12;
const LABEL_DY = [0, LABEL_LINE, -LABEL_LINE, 0];
const LABEL_LEFT = 3; // the slot that puts the text to the left of its marker
const LABEL_STICK = 4; // a label only moves when the other place is clear by this much (no dithering)

// A plumb line fades behind the caption too.
const STEM_VERT = /* glsl */ `
  attribute vec3 aColor;
  varying vec3 vColor;
  void main(){ vColor = aColor; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const STEM_FRAG = /* glsl */ `
  uniform float uOpacity;
  varying vec3 vColor;
  ${CAPTION_MASK}
  void main(){ gl_FragColor = vec4(vColor, uOpacity * captionMask()); }`;

// How wide a label will be drawn, in CSS pixels, at the sizes and letter spacings styles.css gives
// .node-label: measured on a canvas that is never shown, so wide glyphs (CJK, emoji) count in full.
let ruler = null, rulerFace = 'monospace';
function textWidth(text, px, spacingEm) {
  if (!ruler) {
    ruler = document.createElement('canvas').getContext('2d');
    rulerFace = getComputedStyle(document.documentElement).getPropertyValue('--mono').trim() || rulerFace;
  }
  ruler.font = `${px}px ${rulerFace}`;
  let glyphs = 0;
  for (const _ of text) glyphs++; // letter spacing is added once per character, not per UTF-16 unit
  return ruler.measureText(text).width + glyphs * px * spacingEm;
}

const tmp = new THREE.Vector3();
const WHITE = new THREE.Color('#ffffff');

export class Graph3D {
  /**
   * @param opts {labelLayer: HTMLElement, linkOpacity, charge, maxLabels, beamWidth (CSS px), flatten,
   *   hud: {top} — labels fade out within `top` px of the window's top, where the HUD's own words are}
   */
  constructor(opts) {
    this.opts = { linkOpacity: 0.3, charge: -60, maxLabels: 60, beamWidth: 1.1, flatten: 0, hud: null, ...opts };
    this.group = new THREE.Group();
    this.nodes = [];
    this.links = [];
    this.byId = new Map();
    this.neighbors = new Map();
    this.opacity = 0;
    this.targetOpacity = 0;
    this.focusId = null;
    this.hoverId = null;
    this.labelsOn = true;
    this.labelsShown = false;
    this.time = 0;
    // Extent of the layout, refreshed whenever it moves: furthest node from the centre, furthest
    // from the vertical axis, the lowest and highest node, and the keel — the tip of the upturned
    // cone that just holds every node. Seen from a little above, a node far out from the axis reads
    // as lower than it is, so a table set below the keel (not merely below the lowest node) is one
    // that no node appears to sink into, whichever way the map is turned.
    this.radius = 100;
    this.spread = 100;
    this.bottom = -60;
    this.top = 60;
    this.keel = -60;

    const light = { transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false };
    this.pointsMat = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 600 }, uPr: { value: 1 }, uOpacity: { value: 0 }, uSpin: { value: 0 }, uRes: CAPTION.uRes, uCaption: CAPTION.uCaption },
      vertexShader: VERT, fragmentShader: FRAG, ...light,
    });
    this.points = new THREE.Points(new THREE.BufferGeometry(), this.pointsMat);
    this.points.frustumCulled = false;
    this.lineMat = new THREE.ShaderMaterial({
      uniforms: { uView: { value: new THREE.Vector2(1, 1) }, uWidth: { value: this.opts.beamWidth }, uOpacity: { value: 0 }, uRes: CAPTION.uRes, uCaption: CAPTION.uCaption },
      vertexShader: BEAM_VERT, fragmentShader: BEAM_FRAG, side: THREE.DoubleSide, ...light,
    });
    this.lines = new THREE.Mesh(beamGeometry(0), this.lineMat);
    this.lines.frustumCulled = false;
    this.lines.visible = false;

    this.floorY = null; // world y of the table, set from outside; null means no plumb lines
    this.stemSlots = Array.from({ length: STEM_SLOTS }, () => ({ id: null, a: 0, paintedA: -1, x: NaN, y: NaN, z: NaN, floor: 0, pf: NaN, foot: 0, r: 1, g: 1, b: 1 }));
    const sgeo = new THREE.BufferGeometry();
    sgeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(STEM_SLOTS * STEM_VERTS * 3), 3));
    sgeo.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(STEM_SLOTS * STEM_VERTS * 3), 3));
    this.stemMat = new THREE.ShaderMaterial({
      uniforms: { uOpacity: { value: 0 }, uRes: CAPTION.uRes, uCaption: CAPTION.uCaption },
      vertexShader: STEM_VERT, fragmentShader: STEM_FRAG, ...light,
    });
    this.stems = new THREE.LineSegments(sgeo, this.stemMat);
    this.stems.frustumCulled = false;
    this.stems.visible = false;
    this.group.add(this.stems, this.lines, this.points);
    this.group.visible = false;

    this.sim = forceSimulation([], 3)
      .force('link', forceLink([]).id((d) => d.id))
      .force('charge', forceManyBody().strength(this.opts.charge).theta(1.1).distanceMax(900))
      .force('center', forceCenter(0, 0, 0).strength(0.03))
      .velocityDecay(0.32)
      .stop();
    // A gentle pull toward the horizontal plane: the map settles wider than tall, like an object
    // hovering over the table, while staying a volume.
    if (this.opts.flatten) this.sim.force('flatten', forceY(0).strength(this.opts.flatten));
    this.labels = new Map(); // id -> {id, el, w, rank, slot, dx, dy, fade, fresh, x0, x1, y, h, op, tx, ty}
    this.labelOrder = []; // the same records, most important first
    this.labelKept = []; // scratch: what has been placed so far this frame
    this.labelBlock = { x0: 0, x1: 0, y: 0, h: 0 }; // the selected marker and its brackets: nothing prints over them
  }

  /** True while the layout is still moving. */
  get settling() {
    return this.nodes.length > 0 && this.sim.alpha() > 0.012;
  }

  /**
   * @param nodes [{id, label, color:'#rrggbb', size, showLabel, pinned, near?:id, shape?: 0 round | 1 diamond,
   *   hub?: draw the second, outer ring, data}]
   * @param links [{source:id, target:id, distance?, strength?}]
   * Positions of nodes that already exist are kept, so the map evolves instead of reshuffling.
   */
  setData(nodes, links) {
    const old = this.byId;
    this.byId = new Map();
    this.nodes = nodes.map((n) => {
      const prev = old.get(n.id);
      const node = { ...n, color: new THREE.Color(n.color) };
      if (prev) Object.assign(node, { x: prev.x, y: prev.y, z: prev.z, vx: 0, vy: 0, vz: 0 });
      this.byId.set(node.id, node);
      return node;
    });
    // New nodes appear next to whatever they hang off, then drift into place.
    for (const node of this.nodes) {
      // the pinned node (the core, the root folder) stands on the map's axis, over the lens — after every rebuild
      if (node.pinned) { Object.assign(node, { x: 0, y: 0, z: 0, fx: 0, fy: 0, fz: 0 }); continue; }
      if (node.x !== undefined) continue;
      const anchor = this.byId.get(node.near);
      if (anchor && anchor.x !== undefined) {
        const r = node.spread || 30;
        tmp.randomDirection().multiplyScalar(r);
        Object.assign(node, { x: anchor.x + tmp.x, y: anchor.y + tmp.y, z: anchor.z + tmp.z });
      } else {
        tmp.randomDirection().multiplyScalar(40 + Math.random() * 60);
        Object.assign(node, { x: tmp.x, y: tmp.y, z: tmp.z });
      }
    }
    this.links = links.filter((l) => this.byId.has(l.source) && this.byId.has(l.target)).map((l) => ({ ...l }));
    this.neighbors = new Map();
    for (const l of this.links) {
      if (!this.neighbors.has(l.source)) this.neighbors.set(l.source, new Set());
      if (!this.neighbors.has(l.target)) this.neighbors.set(l.target, new Set());
      this.neighbors.get(l.source).add(l.target);
      this.neighbors.get(l.target).add(l.source);
    }

    this.sim.nodes(this.nodes);
    this.sim.force('link').links(this.links).distance((l) => l.distance ?? 30).strength((l) => l.strength ?? 0.6);
    this.sim.alpha(old.size ? 0.45 : 1).alphaDecay(this.nodes.length > 1500 ? 0.03 : 0.018);

    const n = this.nodes.length;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(n), 1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(new Float32Array(n), 1));
    geo.setAttribute('aRing', new THREE.BufferAttribute(new Float32Array(n), 1));
    geo.setAttribute('aShape', new THREE.BufferAttribute(Float32Array.from(this.nodes, (node) => node.shape || 0), 1));
    this.points.geometry.dispose();
    this.points.geometry = geo;
    this.lines.geometry.dispose();
    this.lines.geometry = beamGeometry(this.links.length);
    this.lines.visible = this.links.length > 0;

    // A node that has gone can be neither selected nor hovered.
    if (this.focusId && !this.byId.has(this.focusId)) this.focusId = null;
    if (this.hoverId && !this.byId.has(this.hoverId)) this.hoverId = null;
    this._paint();
    this._syncLabels();
    // Lay out most of the way before showing a brand-new map, so it doesn't explode on screen.
    if (!old.size) for (let i = 0; i < (n > 1500 ? 30 : 90); i++) this.sim.tick();
    this._writePositions();
  }

  /** Colours, sizes, rings and dimming — recomputed when data, focus or hover changes. */
  _paint() {
    const geo = this.points.geometry;
    if (!geo.attributes.aColor) return; // nothing loaded yet
    const col = geo.attributes.aColor.array;
    const size = geo.attributes.aSize.array;
    const alpha = geo.attributes.aAlpha.array;
    const ring = geo.attributes.aRing.array;
    const focus = this.focusId;
    const hover = this.hoverId;
    const near = focus ? this.neighbors.get(focus) : null;
    for (let i = 0; i < this.nodes.length; i++) {
      const node = this.nodes[i];
      const lit = !focus || node.id === focus || Boolean(near && near.has(node.id));
      node.lit = lit;
      node.index = i;
      col[i * 3] = node.color.r; col[i * 3 + 1] = node.color.g; col[i * 3 + 2] = node.color.b;
      size[i] = node.size * (node.id === focus ? FOCUS_GROW : node.id === hover ? HOVER_GROW : 1);
      ring[i] = !lit ? -1 : node.id === focus ? 2 : node.id === hover || node.hub ? 1 : 0;
      alpha[i] = lit ? 1 : 0.16;
    }
    geo.attributes.aColor.needsUpdate = geo.attributes.aSize.needsUpdate = geo.attributes.aAlpha.needsUpdate = geo.attributes.aRing.needsUpdate = true;

    const cols = this.lines.geometry.userData.cols;
    const lcol = cols.array;
    for (let i = 0; i < this.links.length; i++) {
      const l = this.links[i];
      const a = typeof l.source === 'object' ? l.source : this.byId.get(l.source);
      const b = typeof l.target === 'object' ? l.target : this.byId.get(l.target);
      const hot = focus && (a.id === focus || b.id === focus);
      const k = focus ? (hot ? 1.4 : 0.12) : 1;
      const o = i * 6;
      lcol[o] = a.color.r * k; lcol[o + 1] = a.color.g * k; lcol[o + 2] = a.color.b * k;
      lcol[o + 3] = b.color.r * k; lcol[o + 4] = b.color.g * k; lcol[o + 5] = b.color.b * k;
    }
    cols.needsUpdate = true;
  }

  _writePositions() {
    const pos = this.points.geometry.attributes.position.array;
    let r2 = 0, s2 = 0, low = 0, high = 0, keel = 0;
    for (let i = 0; i < this.nodes.length; i++) {
      const n = this.nodes[i];
      pos[i * 3] = n.x; pos[i * 3 + 1] = n.y; pos[i * 3 + 2] = n.z;
      const h2 = n.x * n.x + n.z * n.z;
      if (h2 > s2) s2 = h2;
      if (h2 + n.y * n.y > r2) r2 = h2 + n.y * n.y;
      if (n.y < low) low = n.y;
      if (n.y > high) high = n.y;
      const k = n.y - Math.sqrt(h2) * KEEL;
      if (k < keel) keel = k;
    }
    this.radius = Math.max(60, Math.sqrt(r2));
    this.spread = Math.max(40, Math.sqrt(s2));
    this.bottom = low;
    this.top = high;
    this.keel = keel;
    this.points.geometry.attributes.position.needsUpdate = true;
    const ends = this.lines.geometry.userData.ends;
    const lp = ends.array;
    for (let i = 0; i < this.links.length; i++) {
      const a = this.links[i].source, b = this.links[i].target;
      const o = i * 6;
      lp[o] = a.x; lp[o + 1] = a.y; lp[o + 2] = a.z;
      lp[o + 3] = b.x; lp[o + 4] = b.y; lp[o + 5] = b.z;
    }
    ends.needsUpdate = true;
  }

  /**
   * Plumb lines for the hovered and the selected node. Each fades in and out (so nothing pops, on a
   * view switch included), and the buffers are only rewritten for a slot whose node, table or
   * brightness actually changed.
   */
  _updateStems(dt) {
    const slots = this.stemSlots;
    const on = this.floorY !== null && this.opacity > 0.01;
    const want0 = on ? this.focusId : null;
    const want1 = on && this.hoverId !== this.focusId ? this.hoverId : null;
    // give each wanted node a slot: a free one, else the faintest one that is on its way out
    for (let w = 0; w < 2; w++) {
      const id = w ? want1 : want0;
      if (id === null) continue;
      let have = false, pick = -1;
      for (let i = 0; i < STEM_SLOTS; i++) {
        const s = slots[i];
        if (s.id === id) { have = true; break; }
        if (s.id !== null && (s.id === want0 || s.id === want1)) continue;
        if (pick < 0 || (slots[pick].id !== null && (s.id === null || s.a < slots[pick].a))) pick = i;
      }
      if (!have && pick >= 0) {
        const s = slots[pick];
        s.id = id; s.a = 0; s.paintedA = -1; s.x = NaN;
      }
    }

    const pos = this.stems.geometry.attributes.position;
    const col = this.stems.geometry.attributes.aColor;
    const P = pos.array, C = col.array;
    const k = 1 - Math.exp(-dt * 9);
    let any = false, moved = false, painted = false;
    for (let i = 0; i < STEM_SLOTS; i++) {
      const s = slots[i];
      if (s.id === null) continue;
      const o = i * STEM_VERTS * 3;
      const node = this.byId.get(s.id);
      const foot = this.radius * 0.016;
      const wanted = Boolean(node) && (s.id === want0 || s.id === want1) && node.y - this.floorY > foot * 2;
      s.a += ((wanted ? 1 : 0) - s.a) * k;
      if (!wanted && s.a < 0.01) { // faded out: free the slot
        P.fill(0, o, o + STEM_VERTS * 3);
        s.id = null; s.a = 0;
        moved = true;
        continue;
      }
      any = true;
      if (wanted) s.floor = this.floorY; // while fading out it stays where it stood
      if (node && (node.x !== s.x || node.y !== s.y || node.z !== s.z || s.floor !== s.pf || foot !== s.foot)) {
        s.x = node.x; s.y = node.y; s.z = node.z; s.pf = s.floor; s.foot = foot;
        s.r = node.color.r; s.g = node.color.g; s.b = node.color.b;
        P[o] = s.x; P[o + 1] = s.y; P[o + 2] = s.z;
        P[o + 3] = s.x; P[o + 4] = s.floor; P[o + 5] = s.z;
        for (let j = 0; j < FOOT; j++) {
          const q = o + 6 + j * 6;
          P[q] = s.x + CIRCLE[j * 2] * foot; P[q + 1] = s.floor; P[q + 2] = s.z + CIRCLE[j * 2 + 1] * foot;
          P[q + 3] = s.x + CIRCLE[j * 2 + 2] * foot; P[q + 4] = s.floor; P[q + 5] = s.z + CIRCLE[j * 2 + 3] * foot;
        }
        moved = true;
        s.paintedA = -1;
      }
      if (Math.abs(s.a - s.paintedA) > 0.004) { // brightest where it lands, fading on the way up to the node
        s.paintedA = s.a;
        const r = s.r * s.a, g = s.g * s.a, b = s.b * s.a;
        C[o] = r * 0.06; C[o + 1] = g * 0.06; C[o + 2] = b * 0.06;
        C[o + 3] = r * 0.5; C[o + 4] = g * 0.5; C[o + 5] = b * 0.5;
        for (let q = o + 6; q < o + STEM_VERTS * 3; q += 3) { C[q] = r * 0.85; C[q + 1] = g * 0.85; C[q + 2] = b * 0.85; }
        painted = true;
      }
    }
    if (moved) pos.needsUpdate = true;
    if (painted) col.needsUpdate = true;
    this.stems.visible = any;
    this.stemMat.uniforms.uOpacity.value = 0.7 * this.opacity;
  }

  show(opacity = 1) {
    this.targetOpacity = opacity;
  }

  setFocus(id) {
    this.focusId = id && this.byId.has(id) ? id : null;
    this._paint();
    this._syncLabels();
  }

  setHover(id) {
    if (id === this.hoverId) return;
    this.hoverId = id;
    this._paint();
    this._syncLabels();
  }

  find(text) {
    const want = String(text || '').toLowerCase().trim();
    if (!want) return null;
    return this.nodes.find((n) => n.label.toLowerCase() === want) || this.nodes.find((n) => n.label.toLowerCase().includes(want)) || null;
  }

  // ---- framing ----------------------------------------------------------------

  /**
   * Where the camera should aim and how far back it should stand so that the map and its table sit
   * inside a band of the screen, whichever way the map is turned (every node is treated as the ring
   * it sweeps around the vertical axis).
   * @param view {sinE: sine of the camera's elevation, tanFov: tan(fov / 2), aspect,
   *   top / bottom / side: limits in NDC for the nodes, floorY / floorR: the table, floorLimit: lowest its near rim may sit}
   * @param out {y, dist} — the previous answer on the way in (the solve is iterative), the new one on the way out
   * @param rounds how many refinement passes to run
   */
  frame(view, out, rounds = 8) {
    const sinE = THREE.MathUtils.clamp(view.sinE, 0.1, 0.8);
    const cosE = Math.sqrt(1 - sinE * sinE);
    const t = view.tanFov;
    const span = view.top - view.bottom;
    const floorShift = view.bottom - view.floorLimit; // lets the table's own limit be compared on the nodes' scale
    let ty = Number.isFinite(out.y) ? out.y : 0;
    let dist = out.dist > 0 ? out.dist : this.radius * 2.7;
    const nodes = this.nodes;
    for (let round = 0; round < rounds; round++) {
      let hi = -Infinity, lo = Infinity, wide = 0;
      for (let i = -1; i < nodes.length; i++) {
        // i = -1 is the table's rim
        const y = i < 0 ? view.floorY : nodes[i].y;
        const rho = i < 0 ? view.floorR : Math.sqrt(nodes[i].x * nodes[i].x + nodes[i].z * nodes[i].z);
        const dy = y - ty;
        const base = dist - dy * sinE;
        const dn = Math.max(base - rho * cosE, dist * 0.05); // depth when the ring is nearest the camera
        const df = Math.max(base + rho * cosE, dist * 0.05); // … and furthest
        const yn = (dy * cosE - rho * sinE) / (dn * t);
        const yf = (dy * cosE + rho * sinE) / (df * t);
        if (i < 0) {
          lo = Math.min(lo, yn + floorShift);
          continue;
        }
        if (yn > hi) hi = yn;
        if (yf > hi) hi = yf;
        if (yn < lo) lo = yn;
        if (yf < lo) lo = yf;
        const x = rho / (Math.sqrt(Math.max(base * base - rho * rho * cosE * cosE, 1e-6)) * t * view.aspect);
        if (x > wide) wide = x;
      }
      if (hi === -Infinity) { hi = 0; lo = Math.min(lo, 0); }
      // centre the content in the band, then stand back (or step in) until it just fills it
      const up = ((view.top - hi) - (lo - view.bottom)) / 2;
      ty -= (up * t * dist) / cosE;
      dist = Math.max(view.minDist, dist * Math.max((hi - lo) / span, wide / view.side));
    }
    out.y = ty;
    out.dist = dist;
    return out;
  }

  /** How big a node's marker is drawn, as the radius of its outermost ring in CSS pixels. */
  _markRadius(node, dist, height) {
    const focus = node.id === this.focusId, hover = node.id === this.hoverId;
    const px = markPx(node.size * (focus ? FOCUS_GROW : hover ? HOVER_GROW : 1), height, dist);
    if (px < MARK_DETAIL || (this.focusId && !node.lit)) return px * 0.3;
    const corner = node.shape ? DIAMOND * 1.4142 : 1; // a diamond reaches furthest at its points
    return px * 0.5 * (focus || hover || node.hub ? 0.92 : 0.56) * corner;
  }

  /** Where a node is on screen (CSS pixels), how large its marker is drawn, and whether it can be seen (not faded out behind the caption). Writes into out {x, y, r, visible}. */
  screenOf(node, camera, width, height, out) {
    const dist = camera.position.distanceTo(tmp.set(node.x, node.y, node.z));
    tmp.project(camera);
    out.x = (tmp.x * 0.5 + 0.5) * width;
    out.y = (-tmp.y * 0.5 + 0.5) * height;
    out.visible = this.opacity > 0.5 && tmp.z > -1 && tmp.z < 1 && captionFade(out.x, out.x, out.y) > 0.3;
    out.r = this._markRadius(node, dist, height);
    return out;
  }

  // ---- labels ---------------------------------------------------------------

  _syncLabels() {
    const wanted = new Set();
    const always = this.nodes.filter((n) => n.showLabel).sort((a, b) => b.size - a.size).slice(0, this.opts.maxLabels);
    for (const n of always) wanted.add(n.id);
    if (this.hoverId) wanted.add(this.hoverId);
    if (this.focusId) {
      wanted.add(this.focusId);
      let extra = 0;
      for (const id of this.neighbors.get(this.focusId) || []) {
        if (extra++ > 40) break;
        wanted.add(id);
      }
    }
    for (const [id, rec] of this.labels) {
      if (!wanted.has(id)) {
        rec.el.remove();
        this.labels.delete(id);
      }
    }
    const order = this.labelOrder;
    order.length = 0;
    for (const id of wanted) {
      const node = this.byId.get(id);
      if (!node) continue;
      let rec = this.labels.get(id);
      if (!rec) {
        const el = document.createElement('div');
        el.className = 'node-label';
        this.opts.labelLayer.appendChild(el);
        rec = { id, el, text: null, mode: -1, w: 0, rank: 0, slot: 0, dx: 0, dy: 0, fade: 1, fresh: true, x0: 0, x1: 0, y: 0, h: LABEL_LINE / 2, op: 0, tx: NaN, ty: NaN };
        this.labels.set(id, rec);
      }
      const major = Boolean(node.showLabel);
      const marked = id === this.focusId || id === this.hoverId;
      rec.el.classList.toggle('major', major);
      rec.el.classList.toggle('focus', marked);
      rec.el.style.color = `#${node.color.clone().lerp(WHITE, 0.45).getHexString()}`;
      // the width is measured off screen (no layout read), and only when the text or its type size changes
      const mode = (marked ? 2 : 0) + (major ? 1 : 0);
      if (rec.text !== node.label || rec.mode !== mode) {
        if (rec.text !== node.label) rec.el.textContent = node.label;
        rec.text = node.label; rec.mode = mode;
        rec.w = textWidth(major ? node.label.toUpperCase() : node.label, marked ? 13 : major ? 11 : 10, major ? 0.14 : 0.06);
      }
      rec.rank = (id === this.focusId ? 3e6 : id === this.hoverId ? 2e6 : major ? 1e3 : 0) + node.size;
      order.push(rec);
    }
    order.sort((a, b) => b.rank - a.rank);
  }

  _placeLabels(camera, width, height, dt) {
    const visible = this.labelsOn && this.opacity > 0.5;
    const order = this.labelOrder;
    const kept = this.labelKept;
    kept.length = 0;
    const ease = 1 - Math.exp(-dt * 10);
    const hud = this.opts.hud;
    // labels dim with depth: full strength at the near side of the map, well legible still at the far side
    const nearest = Math.max(0, camera.position.length() - this.radius);
    for (let i = 0; i < order.length; i++) {
      const rec = order[i];
      const el = rec.el;
      const node = this.byId.get(rec.id);
      if (!node) { // gone from the data; its label goes at the next sync
        if (rec.op !== 0) el.style.opacity = rec.op = 0;
        continue;
      }
      const dim = this.focusId && !node.lit;
      const dist = camera.position.distanceTo(tmp.set(node.x, node.y, node.z));
      tmp.project(camera);
      if (!visible || tmp.z > 1 || dim) {
        if (rec.op !== 0) el.style.opacity = rec.op = 0;
        continue;
      }
      const focus = rec.id === this.focusId;
      const marked = focus || rec.id === this.hoverId;
      const sx = (tmp.x * 0.5 + 0.5) * width;
      const sy = (-tmp.y * 0.5 + 0.5) * height;
      // the text starts just outside the marker's outermost ring (and outside the selection's
      // brackets), however large the marker is drawn
      const ring = this._markRadius(node, dist, height);
      const clear = ring + (focus ? 14 : 5);
      let slot = -1, x = 0;
      for (let t = 0; t < LABEL_DY.length && slot < 0; t++) {
        const pad = t === rec.slot ? 0 : LABEL_STICK;
        const xx = t === LABEL_LEFT ? sx - clear - rec.w : sx + clear;
        const yy = sy + LABEL_DY[t];
        let free = true;
        for (let j = 0; j < kept.length; j++) {
          const o = kept[j];
          if (xx - pad < o.x1 && xx + rec.w + pad > o.x0 && Math.abs(yy - o.y) < o.h + LABEL_LINE / 2 - 1 + pad * 0.5) { free = false; break; }
        }
        if (free) { slot = t; x = xx; }
      }
      if (slot >= 0) {
        rec.slot = slot;
        rec.x0 = x; rec.x1 = x + rec.w; rec.y = sy + LABEL_DY[slot];
        kept.push(rec);
        const dx = slot === LABEL_LEFT ? -(clear * 2 + rec.w) : 0;
        rec.dx = rec.fresh ? dx : rec.dx + (dx - rec.dx) * ease;
        rec.dy = rec.fresh ? LABEL_DY[slot] : rec.dy + (LABEL_DY[slot] - rec.dy) * ease;
      }
      rec.fade = rec.fresh ? (slot >= 0 ? 1 : 0) : rec.fade + ((slot >= 0 ? 1 : 0) - rec.fade) * ease;
      rec.fresh = false;
      if (focus) {
        const block = this.labelBlock;
        block.x0 = sx - ring - 9; block.x1 = sx + ring + 9; block.y = sy; block.h = ring + 9;
        kept.push(block);
      }
      let fade = marked ? 1 : 0.95 - 0.55 * THREE.MathUtils.clamp((dist - nearest) / (this.radius * 2), 0, 1);
      // the HUD's words always win: under the top bar a label fades out; behind the caption it
      // fades exactly as its marker does (and wherever its own text would reach the caption)
      if (hud && !marked) fade *= THREE.MathUtils.clamp((sy - hud.top + 30) / 30, 0, 1);
      fade *= slot >= 0 ? captionFade(Math.min(sx, rec.x0), Math.max(sx, rec.x1), sy) : captionFade(sx, sx, sy);
      // the DOM is only touched for a label that actually moved or changed strength
      const op = Math.round(fade * rec.fade * this.opacity * 100) / 100;
      if (op !== rec.op) el.style.opacity = rec.op = op;
      const tx = Math.round((sx + clear + rec.dx) * 10) / 10, ty = Math.round((sy + rec.dy) * 10) / 10;
      if (tx !== rec.tx || ty !== rec.ty) {
        rec.tx = tx; rec.ty = ty;
        el.style.transform = `translate(${tx}px, ${ty}px)`;
      }
    }
  }

  /** Nearest node to a screen point, or null. A node that has faded out behind the caption cannot be picked. */
  pick(camera, x, y, width, height) {
    if (this.opacity < 0.5) return null;
    let best = null;
    let bestD = Infinity;
    for (const node of this.nodes) {
      if (this.focusId && !node.lit) continue;
      tmp.set(node.x, node.y, node.z).project(camera);
      if (tmp.z > 1 || tmp.z < -1) continue;
      const dx = (tmp.x * 0.5 + 0.5) * width - x;
      const dy = (-tmp.y * 0.5 + 0.5) * height - y;
      const d = dx * dx + dy * dy;
      const reach = 10 + node.size * 1.5;
      if (d < reach * reach && d < bestD && captionFade(x + dx, x + dx, y + dy) > 0.5) {
        bestD = d;
        best = node;
      }
    }
    return best;
  }

  /** @param width, height the viewport in CSS pixels  @param pixelRatio the renderer's pixel ratio */
  update(dt, camera, width, height, pixelRatio = 1) {
    this.time += dt;
    this.opacity += (this.targetOpacity - this.opacity) * (1 - Math.exp(-dt * 5));
    if (Math.abs(this.targetOpacity - this.opacity) < 0.003) this.opacity = this.targetOpacity;
    this.group.visible = this.opacity > 0.01;
    if (this.sim.alpha() > 0.012 && this.nodes.length) {
      this.sim.tick();
      this._writePositions();
    }
    this._updateStems(dt);
    if (!this.group.visible) {
      if (this.labelsShown) for (let i = 0; i < this.labelOrder.length; i++) this.labelOrder[i].el.style.opacity = this.labelOrder[i].op = 0;
      this.labelsShown = false;
      return;
    }
    this.labelsShown = true;
    this.pointsMat.uniforms.uScale.value = height * MARK_SCALE;
    this.pointsMat.uniforms.uPr.value = pixelRatio;
    this.pointsMat.uniforms.uOpacity.value = this.opacity;
    this.pointsMat.uniforms.uSpin.value = (this.time * 0.4) % (Math.PI * 4); // the selected marker's ring turns slowly
    this.lineMat.uniforms.uView.value.set(width, height);
    this.lineMat.uniforms.uOpacity.value = this.opts.linkOpacity * this.opacity;
    this._placeLabels(camera, width, height, dt);
  }
}
