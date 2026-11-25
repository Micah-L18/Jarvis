// The hologram: a sketchy orange sphere of rings, arcs, ticks and particles around an inner
// lattice, all additive light. It breathes when idle, focuses when listening, spins up when
// thinking, and its surface and core are driven by the voice signal when speaking.
import * as THREE from 'three';

const ORANGE = new THREE.Color('#ff8a1a');
const AMBER = new THREE.Color('#ffb648');
const HOT = new THREE.Color('#ffe2a8');
const EMBER = new THREE.Color('#ff4d00');

const rand = (a, b) => a + Math.random() * (b - a);

function lineMat(color, opacity) {
  return new THREE.LineBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false });
}

/** A circle drawn as broken arcs with a slightly unsteady hand. */
function sketchRing(radius, { gaps = 3, wobble = 0.006, segments = 220 } = {}) {
  const pts = [];
  const cuts = Array.from({ length: gaps }, () => ({ at: Math.random(), len: rand(0.03, 0.16) }));
  const phase = rand(0, 10);
  for (let i = 0; i < segments; i++) {
    const t0 = i / segments;
    const t1 = (i + 1) / segments;
    if (cuts.some((c) => ((t0 - c.at + 1) % 1) < c.len)) continue;
    for (const t of [t0, t1]) {
      const a = t * Math.PI * 2;
      const r = radius * (1 + wobble * Math.sin(a * 7 + phase) + wobble * 0.6 * Math.sin(a * 17 + phase * 2));
      pts.push(Math.cos(a) * r, Math.sin(a) * r, 0);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return geo;
}

/** Gauge ticks around a circle. */
function tickRing(radius, count, length, everyNth = 5) {
  const pts = [];
  for (let i = 0; i < count; i++) {
    if (Math.random() < 0.12) continue;
    const a = (i / count) * Math.PI * 2;
    const l = i % everyNth === 0 ? length * 2.2 : length;
    pts.push(Math.cos(a) * radius, Math.sin(a) * radius, 0, Math.cos(a) * (radius + l), Math.sin(a) * (radius + l), 0);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return geo;
}

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,240,210,1)');
  grad.addColorStop(0.18, 'rgba(255,170,60,0.85)');
  grad.addColorStop(0.5, 'rgba(255,110,10,0.22)');
  grad.addColorStop(1, 'rgba(255,90,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

const SHELL_VERT = /* glsl */ `
  uniform float uTime; uniform float uLevel; uniform float uScale; uniform float uAgitation;
  attribute float aSeed;
  varying float vGlow;
  // cheap value noise on the sphere
  float hash(vec3 p){ return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
  float noise(vec3 p){
    vec3 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
    return mix(mix(mix(hash(i), hash(i+vec3(1,0,0)), f.x), mix(hash(i+vec3(0,1,0)), hash(i+vec3(1,1,0)), f.x), f.y),
               mix(mix(hash(i+vec3(0,0,1)), hash(i+vec3(1,0,1)), f.x), mix(hash(i+vec3(0,1,1)), hash(i+vec3(1,1,1)), f.x), f.y), f.z);
  }
  void main(){
    float n = noise(position * 2.6 + vec3(0.0, uTime * (0.35 + uAgitation), uTime * 0.2));
    float n2 = noise(position * 6.0 - vec3(uTime * 0.6));
    float disp = (n - 0.5) * (0.06 + uLevel * 0.55) + (n2 - 0.5) * 0.03;
    vec3 p = position * (1.0 + disp);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vGlow = 0.35 + n * 0.65 + uLevel * 0.6;
    gl_PointSize = max(1.0, (0.012 + aSeed * 0.02 + uLevel * 0.02) * uScale / -mv.z);
    gl_Position = projectionMatrix * mv;
  }`;
const SHELL_FRAG = /* glsl */ `
  uniform vec3 uColor; uniform float uOpacity;
  varying float vGlow;
  void main(){
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.05, d) * vGlow * uOpacity;
    gl_FragColor = vec4(uColor * (0.7 + vGlow * 0.6), a);
  }`;

export class Orb {
  constructor() {
    this.group = new THREE.Group();
    this.spinners = []; // {obj, axis, speed}
    this.mats = []; // {mat, base}
    this.state = 'idle';
    this.level = 0; // 0..1 audio level, set from outside
    this.smooth = { level: 0, spin: 0.3, bright: 0.7, focus: 0, agitation: 0 };
    this.time = 0;
    this._build();
  }

  _track(mat, base = mat.opacity) {
    this.mats.push({ mat, base });
    return mat;
  }

  _spin(obj, speed, axis = new THREE.Vector3(0, 0, 1)) {
    this.spinners.push({ obj, axis, speed });
    return obj;
  }

  _build() {
    const g = this.group;

    // Core glow
    this.core = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, transparent: true }));
    this.core.scale.setScalar(0.9);
    g.add(this.core);

    // Inner lattice: nested wire boxes and an icosahedron, like scaffolding inside the sphere
    this.lattice = new THREE.Group();
    for (const [w, h, d, o] of [[0.62, 0.62, 0.62, 0.55], [0.9, 0.36, 0.7, 0.3], [0.36, 0.95, 0.5, 0.25]]) {
      const box = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, d)), this._track(lineMat(AMBER, o)));
      this.lattice.add(box);
    }
    const ico = new THREE.LineSegments(new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(0.5, 1)), this._track(lineMat(ORANGE, 0.22)));
    this.lattice.add(this._spin(ico, -0.5, new THREE.Vector3(0.3, 1, 0.2).normalize()));
    g.add(this._spin(this.lattice, 0.25, new THREE.Vector3(0.2, 1, 0.1).normalize()));

    // Particle shell
    const N = 3200;
    const pos = new Float32Array(N * 3);
    const seed = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const y = 1 - (i / (N - 1)) * 2;
      const r = Math.sqrt(1 - y * y);
      const a = i * Math.PI * (3 - Math.sqrt(5));
      const rad = 1.02 + (Math.random() < 0.15 ? rand(-0.25, 0.3) : rand(-0.02, 0.02));
      pos.set([Math.cos(a) * r * rad, y * rad, Math.sin(a) * r * rad], i * 3);
      seed[i] = Math.random();
    }
    const shellGeo = new THREE.BufferGeometry();
    shellGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    shellGeo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    this.shellMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uLevel: { value: 0 }, uScale: { value: 600 }, uAgitation: { value: 0 }, uColor: { value: AMBER.clone() }, uOpacity: { value: 0.8 } },
      vertexShader: SHELL_VERT, fragmentShader: SHELL_FRAG, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false,
    });
    this.shell = new THREE.Points(shellGeo, this.shellMat);
    g.add(this._spin(this.shell, 0.12, new THREE.Vector3(0, 1, 0)));

    // Scribbled great circles — the hand-drawn tangle that gives the sphere its volume
    this.scribble = new THREE.Group();
    for (let i = 0; i < 46; i++) {
      const ring = new THREE.LineSegments(sketchRing(rand(0.93, 1.1), { gaps: 2 + (i % 3), wobble: 0.012 }), this._track(lineMat(i % 5 === 0 ? HOT : ORANGE, rand(0.1, 0.34))));
      ring.rotation.set(rand(0, Math.PI), rand(0, Math.PI), rand(0, Math.PI));
      this.scribble.add(this._spin(ring, rand(-0.25, 0.25)));
    }
    g.add(this._spin(this.scribble, 0.08, new THREE.Vector3(0.1, 1, 0).normalize()));

    // Instrument rings — tilted, broken, some with gauge ticks or translucent bands
    this.rings = [];
    const ringSpecs = [
      { r: 1.22, tilt: [1.25, 0.1, 0], speed: 0.5, o: 0.9, ticks: 72 },
      { r: 1.34, tilt: [1.32, -0.25, 0.2], speed: -0.32, o: 0.55, band: [0.035, 1.9] },
      { r: 1.47, tilt: [1.1, 0.5, -0.1], speed: 0.22, o: 0.75 },
      { r: 1.6, tilt: [1.4, 0.05, 0.4], speed: -0.16, o: 0.4, ticks: 120 },
      { r: 1.12, tilt: [0.2, 0.9, 0], speed: 0.7, o: 0.6 },
      { r: 1.28, tilt: [0.6, -0.7, 0.9], speed: -0.45, o: 0.45, band: [0.02, 1.1] },
      { r: 1.72, tilt: [1.52, 0, 0], speed: 0.1, o: 0.3 },
      { r: 0.8, tilt: [0.9, 0.3, 1.2], speed: -0.9, o: 0.5 },
    ];
    for (const spec of ringSpecs) {
      const holder = new THREE.Group();
      holder.rotation.set(...spec.tilt);
      holder.userData.tilt = new THREE.Euler(...spec.tilt);
      const spin = new THREE.Group();
      spin.add(new THREE.LineSegments(sketchRing(spec.r, { gaps: 3 }), this._track(lineMat(AMBER, spec.o))));
      spin.add(new THREE.LineSegments(sketchRing(spec.r * 1.012, { gaps: 5, wobble: 0.01 }), this._track(lineMat(ORANGE, spec.o * 0.5))));
      if (spec.ticks) spin.add(new THREE.LineSegments(tickRing(spec.r * 1.03, spec.ticks, 0.03), this._track(lineMat(HOT, spec.o * 0.7))));
      if (spec.band) {
        const mat = this._track(new THREE.MeshBasicMaterial({ color: EMBER, transparent: true, opacity: 0.32, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false }));
        for (let k = 0; k < 2; k++) spin.add(new THREE.Mesh(new THREE.RingGeometry(spec.r - spec.band[0] * 2, spec.r - spec.band[0], 96, 1, rand(0, 6.28), spec.band[1] * rand(0.4, 1)), mat));
      }
      holder.add(this._spin(spin, spec.speed));
      this.rings.push(holder);
      g.add(holder);
    }

    // Two fine axes through the sphere
    const axes = new Float32Array([-2.3, -0.5, 0, 2.3, 0.5, 0, -0.3, -1.9, 0.4, 0.3, 1.9, -0.4]);
    const axGeo = new THREE.BufferGeometry();
    axGeo.setAttribute('position', new THREE.BufferAttribute(axes, 3));
    g.add(new THREE.LineSegments(axGeo, this._track(lineMat(AMBER, 0.28))));

    // Orbiting motes
    const M = 180;
    const mp = new Float32Array(M * 3);
    for (let i = 0; i < M; i++) {
      const v = new THREE.Vector3().randomDirection().multiplyScalar(rand(1.3, 2.2));
      mp.set([v.x, v.y * 0.5, v.z], i * 3);
    }
    const moteGeo = new THREE.BufferGeometry();
    moteGeo.setAttribute('position', new THREE.BufferAttribute(mp, 3));
    this.motes = new THREE.Points(moteGeo, this._track(new THREE.PointsMaterial({ color: HOT, size: 0.02, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false })));
    g.add(this._spin(this.motes, 0.18, new THREE.Vector3(0, 1, 0)));
  }

  setState(state) {
    this.state = state;
  }

  /** @param dt seconds  @param pxPerUnit how many pixels one world unit covers at distance 1 (for point sizing) */
  update(dt, pxPerUnit) {
    this.time += dt;
    const target = {
      idle: { spin: 0.3, bright: 0.72, focus: 0, agitation: 0 },
      listening: { spin: 0.55, bright: 1.0, focus: 1, agitation: 0.15 },
      thinking: { spin: 2.4, bright: 0.88, focus: 0.35, agitation: 0.9 },
      speaking: { spin: 0.8, bright: 1.05, focus: 0, agitation: 0.3 },
    }[this.state] || {};
    const s = this.smooth;
    const k = 1 - Math.exp(-dt * 4);
    for (const key of ['spin', 'bright', 'focus', 'agitation']) s[key] += ((target[key] ?? 0) - s[key]) * k;
    const lk = 1 - Math.exp(-dt * (this.level > s.level ? 28 : 9)); // fast attack, slower release
    s.level += (this.level - s.level) * lk;

    for (const { obj, axis, speed } of this.spinners) obj.rotateOnAxis(axis, speed * s.spin * dt);

    // Listening pulls the instrument rings toward a common plane, like an iris focusing.
    for (const holder of this.rings) {
      const t = holder.userData.tilt;
      holder.rotation.x = THREE.MathUtils.lerp(t.x, 1.35, s.focus * 0.8);
      holder.rotation.y = THREE.MathUtils.lerp(t.y, 0, s.focus * 0.8);
      holder.rotation.z = THREE.MathUtils.lerp(t.z, 0, s.focus * 0.8);
    }

    const thinkPulse = this.state === 'thinking' ? 0.12 * Math.sin(this.time * 9) : 0;
    const breath = 0.018 * Math.sin(this.time * 1.3);
    const bright = s.bright + thinkPulse + s.level * 0.5;
    for (const { mat, base } of this.mats) mat.opacity = Math.min(1, base * bright);

    this.shellMat.uniforms.uTime.value = this.time;
    this.shellMat.uniforms.uLevel.value = s.level;
    this.shellMat.uniforms.uAgitation.value = s.agitation;
    this.shellMat.uniforms.uScale.value = pxPerUnit;
    this.shellMat.uniforms.uOpacity.value = 0.38 + bright * 0.3;

    this.core.scale.setScalar(0.85 + s.level * 1.3 + breath * 3 + thinkPulse);
    this.core.material.opacity = Math.min(1, 0.45 + s.level * 0.55 + thinkPulse);
    this.lattice.scale.setScalar(1 + s.level * 0.25);
    this.pulse = 1 + breath + s.level * 0.07;
  }
}
