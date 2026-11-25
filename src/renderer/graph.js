// A 3D force-directed constellation: glowing dots joined by faint lines, floating in the void.
// Used twice — once for what Jarvis knows, once for the file system.
import * as THREE from 'three';
import { forceSimulation, forceLink, forceManyBody, forceCenter } from 'd3-force-3d';

const VERT = /* glsl */ `
  attribute vec3 aColor; attribute float aSize; attribute float aAlpha;
  uniform float uScale; uniform float uTime;
  varying vec3 vColor; varying float vAlpha;
  void main(){
    vColor = aColor; vAlpha = aAlpha;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float twinkle = 0.92 + 0.08 * sin(uTime * 1.7 + position.x * 0.13 + position.y * 0.07);
    gl_PointSize = clamp(aSize * twinkle * uScale / -mv.z, 2.0, 110.0);
    gl_Position = projectionMatrix * mv;
  }`;
const FRAG = /* glsl */ `
  uniform float uOpacity;
  varying vec3 vColor; varying float vAlpha;
  void main(){
    float d = length(gl_PointCoord - 0.5);
    float core = smoothstep(0.2, 0.06, d);
    float halo = smoothstep(0.5, 0.0, d);
    float a = (core + halo * halo * 0.5) * vAlpha * uOpacity;
    if (a < 0.004) discard;
    gl_FragColor = vec4(mix(vColor, vec3(1.0), core * 0.55), a);
  }`;

const tmp = new THREE.Vector3();

export class Graph3D {
  /** @param opts {labelLayer: HTMLElement, linkOpacity, charge, linkDistance(link), maxLabels} */
  constructor(opts) {
    this.opts = { linkOpacity: 0.3, charge: -60, maxLabels: 60, ...opts };
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
    this.time = 0;

    this.pointsMat = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 600 }, uOpacity: { value: 0 }, uTime: { value: 0 } },
      vertexShader: VERT, fragmentShader: FRAG, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false,
    });
    this.points = new THREE.Points(new THREE.BufferGeometry(), this.pointsMat);
    this.points.frustumCulled = false;
    this.lineMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false });
    this.lines = new THREE.LineSegments(new THREE.BufferGeometry(), this.lineMat);
    this.lines.frustumCulled = false;
    this.group.add(this.lines, this.points);
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
   * @param nodes [{id, label, color:'#rrggbb', size, showLabel, pinned, near?:id, data}]
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
    this.points.geometry.dispose();
    this.points.geometry = geo;
    const lgeo = new THREE.BufferGeometry();
    lgeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.links.length * 6), 3));
    lgeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.links.length * 6), 3));
    this.lines.geometry.dispose();
    this.lines.geometry = lgeo;

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

    const lcol = this.lines.geometry.attributes.color.array;
    this.links.forEach((l, i) => {
      const a = typeof l.source === 'object' ? l.source : this.byId.get(l.source);
      const b = typeof l.target === 'object' ? l.target : this.byId.get(l.target);
      const hot = focus && (a.id === focus || b.id === focus);
      const k = focus ? (hot ? 1.6 : 0.12) : 1;
      lcol.set([a.color.r * k, a.color.g * k, a.color.b * k, b.color.r * k, b.color.g * k, b.color.b * k], i * 6);
    });
    this.lines.geometry.attributes.color.needsUpdate = true;
  }

  _writePositions() {
    const pos = this.points.geometry.attributes.position.array;
    let r2 = 0;
    this.nodes.forEach((n, i) => {
      pos[i * 3] = n.x; pos[i * 3 + 1] = n.y; pos[i * 3 + 2] = n.z;
      r2 = Math.max(r2, n.x * n.x + n.y * n.y + n.z * n.z);
    });
    this.radius = Math.max(60, Math.sqrt(r2));
    this.points.geometry.attributes.position.needsUpdate = true;
    const lp = this.lines.geometry.attributes.position.array;
    this.links.forEach((l, i) => {
      const a = l.source, b = l.target;
      lp[i * 6] = a.x; lp[i * 6 + 1] = a.y; lp[i * 6 + 2] = a.z;
      lp[i * 6 + 3] = b.x; lp[i * 6 + 4] = b.y; lp[i * 6 + 5] = b.z;
    });
    this.lines.geometry.attributes.position.needsUpdate = true;
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
      el.style.transform = `translate(${(tmp.x * 0.5 + 0.5) * width}px, ${(-tmp.y * 0.5 + 0.5) * height}px)`;
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
    this.time += dt;
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
    this.pointsMat.uniforms.uScale.value = height * 0.55;
    this.pointsMat.uniforms.uOpacity.value = this.opacity;
    this.pointsMat.uniforms.uTime.value = this.time;
    this.lineMat.opacity = this.opts.linkOpacity * this.opacity;
    this._placeLabels(camera, width, height);
  }
}
