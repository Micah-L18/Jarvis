// A 3D force-directed graph drawn as a hologram: marker dots joined by beams of light, hanging in
// the air above the projection table. Used twice — once for what Jarvis knows, once for the file system.
import * as THREE from 'three';
import { forceSimulation, forceLink, forceManyBody, forceCenter } from 'd3-force-3d';

const MARK_SCALE = 0.72; // marker size on screen = node size * viewport height * this / distance
const MARK_MIN = 2.6;
const MARK_MAX = 96;

// Nodes are markers, not stars: a crisp bright centre inside a thin ring (a diamond for aShape = 1),
// with reticle ticks once they are large enough on screen to carry them. They do not twinkle.
const VERT = /* glsl */ `
  attribute vec3 aColor; attribute float aSize; attribute float aAlpha; attribute float aShape;
  uniform float uScale;
  const float MARK_MIN = ${MARK_MIN.toFixed(1)}; const float MARK_MAX = ${MARK_MAX.toFixed(1)};
  varying vec3 vColor; varying float vAlpha; varying float vPx; varying float vShape;
  void main(){
    vColor = aColor; vAlpha = aAlpha; vShape = aShape;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vPx = clamp(aSize * uScale / -mv.z, MARK_MIN, MARK_MAX);
    gl_PointSize = vPx;
    gl_Position = projectionMatrix * mv;
  }`;
const FRAG = /* glsl */ `
  uniform float uOpacity;
  varying vec3 vColor; varying float vAlpha; varying float vPx; varying float vShape;
  void main(){
    vec2 p = (gl_PointCoord - 0.5) * 2.0;
    float d = mix(length(p), (abs(p.x) + abs(p.y)) * 0.8, vShape);
    float px = 2.0 / vPx;                                  // one screen pixel, in marker units
    float big = smoothstep(7.0, 15.0, vPx);                // enough pixels to draw a ring?
    float rc = mix(0.7, 0.27, big);
    float core = 1.0 - smoothstep(rc - px, rc + px, d);
    float ring = (1.0 - smoothstep(px * 0.6, px * 1.6, abs(d - 0.7))) * big;
    float reticle = smoothstep(24.0, 40.0, vPx) * step(min(abs(p.x), abs(p.y)), px * 0.8) * step(0.8, d) * step(d, 0.98);
    float halo = 1.0 - smoothstep(0.0, 1.0, d);
    float a = (core * mix(0.8, 1.0, big) + ring * 0.85 + reticle * 0.6 + halo * halo * 0.14) * vAlpha * uOpacity;
    if (a < 0.004) discard;
    gl_FragColor = vec4(mix(vColor, vec3(1.0), core * mix(0.12, 0.6, big)), a);
  }`;

// Links are beams: camera-facing ribbons a few pixels wide with a hot core and a soft edge,
// one instanced quad per link (a single draw call however many there are).
const BEAM_VERT = /* glsl */ `
  attribute vec3 aStart; attribute vec3 aEnd; attribute vec3 aColStart; attribute vec3 aColEnd;
  uniform vec2 uRes; uniform float uWidth;
  varying vec3 vColor; varying float vSide;
  void main(){
    vColor = mix(aColStart, aColEnd, position.y);
    vSide = position.x;
    vec4 s = modelViewMatrix * vec4(aStart, 1.0);
    vec4 e = modelViewMatrix * vec4(aEnd, 1.0);
    float near = -1.0;                                      // trim whatever passes behind the camera
    if (s.z > near && e.z > near) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
    if (s.z > near) s = mix(e, s, (near - e.z) / (s.z - e.z));
    else if (e.z > near) e = mix(s, e, (near - s.z) / (e.z - s.z));
    vec4 cs = projectionMatrix * s;
    vec4 ce = projectionMatrix * e;
    vec2 dir = (ce.xy / ce.w - cs.xy / cs.w) * uRes;
    float len = length(dir);
    dir = len > 1e-4 ? dir / len : vec2(1.0, 0.0);
    vec4 c = mix(cs, ce, position.y);
    c.xy += vec2(-dir.y, dir.x) * position.x * uWidth * 2.0 / uRes * c.w;
    gl_Position = c;
  }`;
const BEAM_FRAG = /* glsl */ `
  uniform float uOpacity;
  varying vec3 vColor; varying float vSide;
  void main(){
    float x = abs(vSide);
    float core = 1.0 - smoothstep(0.18, 0.5, x);
    float glow = (1.0 - x) * (1.0 - x);
    gl_FragColor = vec4(vColor, (core + glow * 0.4) * uOpacity);
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

const STEMS = 48; // how many major nodes get a plumb line down to the table
const FOOT = 10; // segments in the little ring where a plumb line lands
const STEM_FLOATS = (1 + FOOT) * 6;

const tmp = new THREE.Vector3();

export class Graph3D {
  /** @param opts {labelLayer: HTMLElement, linkOpacity, charge, maxLabels, beamWidth} */
  constructor(opts) {
    this.opts = { linkOpacity: 0.3, charge: -60, maxLabels: 60, beamWidth: 2.2, ...opts };
    this.group = new THREE.Group();
    this.nodes = [];
    this.links = [];
    this.byId = new Map();
    this.opacity = 0;
    this.targetOpacity = 0;
    this.focusId = null;
    this.hoverId = null;
    this.labelsOn = true;
    this.radius = 100;
    this.bottom = -100; // lowest node's y, so the table can sit under it

    const light = { transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false };
    this.pointsMat = new THREE.ShaderMaterial({ uniforms: { uScale: { value: 600 }, uOpacity: { value: 0 } }, vertexShader: VERT, fragmentShader: FRAG, ...light });
    this.points = new THREE.Points(new THREE.BufferGeometry(), this.pointsMat);
    this.points.frustumCulled = false;
    this.lineMat = new THREE.ShaderMaterial({
      uniforms: { uRes: { value: new THREE.Vector2(1, 1) }, uWidth: { value: this.opts.beamWidth }, uOpacity: { value: 0 } },
      vertexShader: BEAM_VERT, fragmentShader: BEAM_FRAG, side: THREE.DoubleSide, ...light,
    });
    this.lines = new THREE.Mesh(beamGeometry(0), this.lineMat);
    this.lines.frustumCulled = false;
    this.lines.visible = false;
    // Plumb lines from the major nodes down to the projection table, so the map reads as a
    // measured volume standing on the emitter rather than as points adrift.
    this.floorY = null; // world y of the table, set from outside; null hides the plumb lines
    this.stemNodes = [];
    this.stemMat = new THREE.LineBasicMaterial({ vertexColors: true, opacity: 0, ...light });
    this.stems = new THREE.LineSegments(new THREE.BufferGeometry(), this.stemMat);
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
    this.labelEls = new Map();
  }

  /**
   * @param nodes [{id, label, color:'#rrggbb', size, showLabel, pinned, near?:id, shape?: 0 round | 1 diamond,
   *   stem?: drop a plumb line to the table, data}]
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
      if (node.x !== undefined) continue;
      const anchor = this.byId.get(node.near);
      if (node.pinned) Object.assign(node, { x: 0, y: 0, z: 0, fx: 0, fy: 0, fz: 0 });
      else if (anchor && anchor.x !== undefined) {
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
    geo.setAttribute('aShape', new THREE.BufferAttribute(Float32Array.from(this.nodes, (node) => node.shape || 0), 1));
    this.points.geometry.dispose();
    this.points.geometry = geo;
    this.lines.geometry.dispose();
    this.lines.geometry = beamGeometry(this.links.length);
    this.lines.visible = this.links.length > 0;

    this.stemNodes = this.nodes.filter((node) => node.stem).sort((a, b) => b.size - a.size).slice(0, STEMS);
    const sgeo = new THREE.BufferGeometry();
    sgeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.stemNodes.length * STEM_FLOATS), 3));
    sgeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.stemNodes.length * STEM_FLOATS), 3));
    this.stems.geometry.dispose();
    this.stems.geometry = sgeo;

    if (this.focusId && !this.byId.has(this.focusId)) this.focusId = null;
    this._paint();
    this._syncLabels();
    // Lay out most of the way before showing a brand-new map, so it doesn't explode on screen.
    if (!old.size) for (let i = 0; i < (n > 1500 ? 30 : 90); i++) this.sim.tick();
    this._writePositions();
  }

  /** Colours, sizes and dimming — recomputed when data, focus or hover changes. */
  _paint() {
    const geo = this.points.geometry;
    if (!geo.attributes.aColor) return; // nothing loaded yet
    const col = geo.attributes.aColor.array;
    const size = geo.attributes.aSize.array;
    const alpha = geo.attributes.aAlpha.array;
    const focus = this.focusId;
    const near = focus ? this.neighbors.get(focus) || new Set() : null;
    this.nodes.forEach((node, i) => {
      const lit = !focus || node.id === focus || near.has(node.id);
      node.lit = lit;
      col.set([node.color.r, node.color.g, node.color.b], i * 3);
      size[i] = node.size * (node.id === focus ? 1.7 : node.id === this.hoverId ? 1.4 : 1);
      alpha[i] = lit ? 1 : 0.16;
      node.index = i;
    });
    geo.attributes.aColor.needsUpdate = geo.attributes.aSize.needsUpdate = geo.attributes.aAlpha.needsUpdate = true;

    const cols = this.lines.geometry.userData.cols;
    const lcol = cols.array;
    this.links.forEach((l, i) => {
      const a = typeof l.source === 'object' ? l.source : this.byId.get(l.source);
      const b = typeof l.target === 'object' ? l.target : this.byId.get(l.target);
      const hot = focus && (a.id === focus || b.id === focus);
      const k = focus ? (hot ? 1.6 : 0.12) : 1;
      lcol.set([a.color.r * k, a.color.g * k, a.color.b * k, b.color.r * k, b.color.g * k, b.color.b * k], i * 6);
    });
    cols.needsUpdate = true;

    // Plumb lines: brightest where they leave the table, fading on the way up to the node.
    const scol = this.stems.geometry.attributes.color.array;
    this.stemNodes.forEach((node, i) => {
      const k = node.lit ? 1 : 0.15;
      const r = node.color.r * k, g = node.color.g * k, b = node.color.b * k;
      const o = i * STEM_FLOATS;
      scol.set([r * 0.08, g * 0.08, b * 0.08, r * 0.42, g * 0.42, b * 0.42], o);
      for (let j = 0; j < FOOT * 2; j++) scol.set([r * 0.8, g * 0.8, b * 0.8], o + 6 + j * 3);
    });
    this.stems.geometry.attributes.color.needsUpdate = true;
  }

  _writePositions() {
    const pos = this.points.geometry.attributes.position.array;
    let r2 = 0;
    let low = 0;
    this.nodes.forEach((n, i) => {
      pos[i * 3] = n.x; pos[i * 3 + 1] = n.y; pos[i * 3 + 2] = n.z;
      r2 = Math.max(r2, n.x * n.x + n.y * n.y + n.z * n.z);
      low = Math.min(low, n.y);
    });
    this.radius = Math.max(60, Math.sqrt(r2));
    this.bottom = low;
    this.points.geometry.attributes.position.needsUpdate = true;
    const ends = this.lines.geometry.userData.ends;
    const lp = ends.array;
    this.links.forEach((l, i) => {
      const a = l.source, b = l.target;
      lp[i * 6] = a.x; lp[i * 6 + 1] = a.y; lp[i * 6 + 2] = a.z;
      lp[i * 6 + 3] = b.x; lp[i * 6 + 4] = b.y; lp[i * 6 + 5] = b.z;
    });
    ends.needsUpdate = true;
  }

  /** Plumb lines and the small rings where they land. Cheap (at most STEMS nodes), so done every frame. */
  _writeStems() {
    const pos = this.stems.geometry.attributes.position.array;
    const y = this.floorY;
    const foot = this.radius * 0.014;
    this.stemNodes.forEach((node, i) => {
      const o = i * STEM_FLOATS;
      if (node.y - y < foot * 2) { // at or under the table: nothing to draw
        pos.fill(0, o, o + STEM_FLOATS);
        return;
      }
      pos.set([node.x, node.y, node.z, node.x, y, node.z], o);
      for (let j = 0; j < FOOT; j++) {
        const a0 = (j / FOOT) * Math.PI * 2, a1 = ((j + 1) / FOOT) * Math.PI * 2;
        pos.set([node.x + Math.cos(a0) * foot, y, node.z + Math.sin(a0) * foot, node.x + Math.cos(a1) * foot, y, node.z + Math.sin(a1) * foot], o + 6 + j * 6);
      }
    });
    this.stems.geometry.attributes.position.needsUpdate = true;
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
    for (const [id, el] of this.labelEls) {
      if (!wanted.has(id)) {
        el.remove();
        this.labelEls.delete(id);
      }
    }
    for (const id of wanted) {
      const node = this.byId.get(id);
      if (!node) continue;
      let el = this.labelEls.get(id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'node-label';
        this.opts.labelLayer.appendChild(el);
        this.labelEls.set(id, el);
      }
      el.textContent = node.label;
      el.classList.toggle('major', Boolean(node.showLabel));
      el.classList.toggle('focus', id === this.focusId || id === this.hoverId);
      el.style.color = `#${node.color.clone().lerp(new THREE.Color('#ffffff'), 0.45).getHexString()}`;
    }
  }

  _placeLabels(camera, width, height) {
    const visible = this.labelsOn && this.opacity > 0.5;
    for (const [id, el] of this.labelEls) {
      const node = this.byId.get(id);
      tmp.set(node.x, node.y, node.z).project(camera);
      const dim = this.focusId && !node.lit;
      if (!visible || tmp.z > 1 || dim) {
        el.style.opacity = 0;
        continue;
      }
      const dist = camera.position.distanceTo(tmp.set(node.x, node.y, node.z));
      tmp.project(camera);
      const fade = id === this.focusId || id === this.hoverId ? 1 : THREE.MathUtils.clamp(1.5 - dist / (this.radius * 2.4), 0.15, 0.95);
      el.style.opacity = fade * this.opacity;
      // keep the text clear of the marker's ring, however large the marker is drawn
      const size = node.size * (id === this.focusId ? 1.7 : id === this.hoverId ? 1.4 : 1);
      const ring = THREE.MathUtils.clamp((size * height * MARK_SCALE) / dist, MARK_MIN, MARK_MAX) * 0.35;
      el.style.transform = `translate(${(tmp.x * 0.5 + 0.5) * width + Math.max(0, ring - 6)}px, ${(-tmp.y * 0.5 + 0.5) * height}px)`;
    }
  }

  /** Nearest node to a screen point, or null. */
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
      if (d < reach * reach && d < bestD) {
        bestD = d;
        best = node;
      }
    }
    return best;
  }

  update(dt, camera, width, height) {
    this.opacity += (this.targetOpacity - this.opacity) * (1 - Math.exp(-dt * 5));
    if (Math.abs(this.targetOpacity - this.opacity) < 0.003) this.opacity = this.targetOpacity;
    this.group.visible = this.opacity > 0.01;
    if (this.sim.alpha() > 0.012 && this.nodes.length) {
      this.sim.tick();
      this._writePositions();
    }
    if (!this.group.visible) {
      for (const el of this.labelEls.values()) el.style.opacity = 0;
      return;
    }
    this.pointsMat.uniforms.uScale.value = height * MARK_SCALE;
    this.pointsMat.uniforms.uOpacity.value = this.opacity;
    this.lineMat.uniforms.uRes.value.set(width, height);
    this.lineMat.uniforms.uOpacity.value = this.opts.linkOpacity * this.opacity;
    this.stems.visible = this.floorY !== null && this.stemNodes.length > 0;
    if (this.stems.visible) {
      this._writeStems();
      this.stemMat.opacity = 0.5 * this.opacity;
    }
    this._placeLabels(camera, width, height);
  }
}
