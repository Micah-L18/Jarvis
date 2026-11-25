// The projection table. Everything Jarvis shows is thrown up into the room from an emitter disc
// beneath it: concentric rings, gauge ticks and a polar grid drawn in thin additive light, a cone
// of light rising from the lens, and a final screen pass that gives the picture its room
// (dark graphite, not black) and its scan lines. The whole stage is three draw calls.
import * as THREE from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// Emitter disc
// ---------------------------------------------------------------------------

const FLOOR_VERT = /* glsl */ `
  attribute float aSpin; attribute float aAlpha; attribute float aRise;
  uniform float uTime;
  varying float vA; varying float vR;
  void main(){
    vec3 q = position;
    float a = aAlpha;
    if (aRise > 0.0) {
      // a ring climbing the light cone, widening with it and thinning out as it goes
      float y = fract(position.y + uTime * aRise);
      float r = 0.2 + 0.58 * y;
      q = vec3(position.x * r, y, position.z * r);
      a *= sin(3.14159 * y) * (1.0 - y);
    }
    float ang = uTime * aSpin;
    float c = cos(ang), s = sin(ang);
    q = vec3(q.x * c - q.z * s, q.y, q.x * s + q.z * c);
    vA = a;
    vR = length(q.xz);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(q, 1.0);
  }`;
const FLOOR_FRAG = /* glsl */ `
  uniform vec3 uColor; uniform float uOpacity; uniform float uTime;
  varying float vA; varying float vR;
  void main(){
    // a slow ripple of light leaving the lens and crossing the disc
    float wave = fract(uTime * 0.07) * 1.5;
    float pulse = smoothstep(0.16, 0.0, abs(vR - wave)) * (1.0 - wave / 1.5);
    float a = vA * uOpacity * (1.0 + pulse * 1.1);
    vec3 col = mix(uColor, mix(uColor, vec3(1.0), 0.65), clamp(vA, 0.0, 1.0) * 0.55);
    gl_FragColor = vec4(col, a);
  }`;

/** Collects line segments or triangles on the unit disc, each vertex with a spin rate and brightness. */
class Sketch {
  constructor() {
    this.pos = [];
    this.spin = [];
    this.alpha = [];
    this.rise = [];
  }

  v(x, y, z, spin, alpha, rise = 0) {
    this.pos.push(x, y, z);
    this.spin.push(spin);
    this.alpha.push(alpha);
    this.rise.push(rise);
  }

  /** Arc of a circle as line segments. from/to are fractions of a turn. */
  arc(r, spin, alpha, from = 0, to = 1, { y = 0, rise = 0 } = {}) {
    const n = Math.max(2, Math.round((to - from) * 160));
    for (let i = 0; i < n; i++) {
      const a0 = (from + ((to - from) * i) / n) * TAU;
      const a1 = (from + ((to - from) * (i + 1)) / n) * TAU;
      this.v(Math.cos(a0) * r, y, Math.sin(a0) * r, spin, alpha, rise);
      this.v(Math.cos(a1) * r, y, Math.sin(a1) * r, spin, alpha, rise);
    }
  }

  /** Radial ticks; every `major`th is longer and brighter. */
  ticks(r, len, count, spin, alpha, major = 5, skip = () => false) {
    for (let i = 0; i < count; i++) {
      if (skip(i)) continue;
      const a = (i / count) * TAU;
      const big = i % major === 0;
      const l = big ? len * 2.2 : len;
      this.v(Math.cos(a) * r, 0, Math.sin(a) * r, spin, alpha * (big ? 1 : 0.6));
      this.v(Math.cos(a) * (r + l), 0, Math.sin(a) * (r + l), spin, alpha * (big ? 1 : 0.6));
    }
  }

  /** A spoke from r0 to r1, cut into pieces so the ripple can travel along it. */
  spoke(angle, r0, r1, spin, a0, a1) {
    const n = 6;
    for (let i = 0; i < n; i++) {
      const t0 = i / n, t1 = (i + 1) / n;
      const ra = r0 + (r1 - r0) * t0, rb = r0 + (r1 - r0) * t1;
      this.v(Math.cos(angle) * ra, 0, Math.sin(angle) * ra, spin, a0 + (a1 - a0) * t0);
      this.v(Math.cos(angle) * rb, 0, Math.sin(angle) * rb, spin, a0 + (a1 - a0) * t1);
    }
  }

  /** A filled band between two radii (triangles), brightness aIn at the inner edge and aOut at the outer. */
  band(r0, r1, spin, aIn, aOut, from = 0, to = 1) {
    const n = Math.max(2, Math.round((to - from) * 96));
    for (let i = 0; i < n; i++) {
      const a0 = (from + ((to - from) * i) / n) * TAU;
      const a1 = (from + ((to - from) * (i + 1)) / n) * TAU;
      const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
      this.v(c0 * r0, 0, s0 * r0, spin, aIn); this.v(c0 * r1, 0, s0 * r1, spin, aOut); this.v(c1 * r0, 0, s1 * r0, spin, aIn);
      this.v(c1 * r0, 0, s1 * r0, spin, aIn); this.v(c0 * r1, 0, s0 * r1, spin, aOut); this.v(c1 * r1, 0, s1 * r1, spin, aOut);
    }
  }

  geometry() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    geo.setAttribute('aSpin', new THREE.Float32BufferAttribute(this.spin, 1));
    geo.setAttribute('aAlpha', new THREE.Float32BufferAttribute(this.alpha, 1));
    geo.setAttribute('aRise', new THREE.Float32BufferAttribute(this.rise, 1));
    return geo;
  }
}

function emitterLines() {
  const s = new Sketch();
  // the lens
  s.arc(0.045, 0, 0.95);
  s.arc(0.085, 0.5, 0.7, 0.02, 0.3); s.arc(0.085, 0.5, 0.7, 0.36, 0.63); s.arc(0.085, 0.5, 0.7, 0.69, 0.97);
  s.arc(0.13, 0, 0.5);
  s.ticks(0.13, 0.012, 24, 0, 0.6, 3);

  // polar grid, fixed to the table and fading toward the rim
  for (const [r, a] of [[0.25, 0.3], [0.5, 0.24], [0.75, 0.17]]) s.arc(r, 0, a);
  for (let i = 0; i < 12; i++) s.spoke((i / 12) * TAU, 0.13, 1.0, 0, 0.3, 0.08);
  for (let i = 0; i < 36; i++) if (i % 3) s.spoke((i / 36) * TAU, 0.75, 1.0, 0, 0.13, 0.05);

  // inner instrument ring, turning one way
  s.arc(0.36, 0.11, 0.8, 0.0, 0.29); s.arc(0.36, 0.11, 0.8, 0.34, 0.6); s.arc(0.36, 0.11, 0.8, 0.67, 0.95);
  s.ticks(0.325, 0.014, 60, 0.11, 0.6, 5);

  // middle ring, turning the other way
  s.arc(0.62, -0.06, 0.62, 0.0, 0.2); s.arc(0.62, -0.06, 0.62, 0.25, 0.46); s.arc(0.62, -0.06, 0.62, 0.5, 0.7); s.arc(0.62, -0.06, 0.62, 0.76, 0.96);
  s.arc(0.635, -0.06, 0.3, 0.05, 0.16); s.arc(0.635, -0.06, 0.3, 0.55, 0.66);
  s.ticks(0.62, -0.016, 96, -0.06, 0.5, 4, (i) => i % 24 > 19);

  // rim: a full gauge circle with measurement ticks
  s.arc(1.0, 0.035, 0.6);
  s.ticks(1.0, 0.018, 180, 0.035, 0.6, 5);
  s.ticks(1.0, 0.07, 12, 0.035, 0.75, 1);

  // outer brackets, drifting back
  for (let i = 0; i < 6; i++) s.arc(1.1, -0.02, 0.36, i / 6 + 0.02, i / 6 + 0.11);
  for (let i = 0; i < 3; i++) s.arc(1.125, -0.02, 0.22, i / 3 + 0.19, i / 3 + 0.3);

  // slices of light climbing the cone
  for (let i = 0; i < 3; i++) s.arc(1.0, 0.1 * (i % 2 ? -1 : 1), 0.42, 0, 1, { y: i / 3, rise: 0.022 });
  return s.geometry();
}

function emitterFills() {
  const s = new Sketch();
  s.band(0.0, 0.045, 0, 0.9, 0.8); // lens
  s.band(0.045, 0.4, 0, 0.22, 0.0); // light pooled around it
  s.band(0.0, 1.0, 0, 0.05, 0.0); // the faintest wash, so the disc reads as a surface
  // translucent bands riding the rings
  for (const [from, to] of [[0.03, 0.2], [0.4, 0.52], [0.7, 0.9]]) s.band(0.385, 0.415, 0.11, 0.17, 0.17, from, to);
  for (const [from, to] of [[0.08, 0.18], [0.3, 0.43], [0.58, 0.64], [0.8, 0.93]]) s.band(0.655, 0.675, -0.06, 0.12, 0.12, from, to);
  for (let i = 0; i < 4; i++) s.band(1.045, 1.062, 0.035, 0.07, 0.07, i / 4 + 0.03, i / 4 + 0.17);
  return s.geometry();
}

// ---------------------------------------------------------------------------
// Cone of light
// ---------------------------------------------------------------------------

const CONE_VERT = /* glsl */ `
  varying vec3 vN; varying vec3 vV; varying float vH; varying float vAng;
  void main(){
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vN = normalMatrix * normal;
    vV = -mv.xyz;
    vH = uv.y;
    vAng = atan(position.z, position.x);
    gl_Position = projectionMatrix * mv;
  }`;
const CONE_FRAG = /* glsl */ `
  uniform vec3 uColor; uniform float uOpacity; uniform float uTime;
  varying vec3 vN; varying vec3 vV; varying float vH; varying float vAng;
  void main(){
    // thick through the middle, vanishing at the silhouette: reads as a volume of lit air
    float body = pow(abs(dot(normalize(vN), normalize(vV))), 1.4);
    float h = pow(1.0 - vH, 1.7);
    float rays = 0.72 + 0.28 * sin(vAng * 18.0 + uTime * 0.12) * sin(vAng * 7.0 - uTime * 0.07);
    gl_FragColor = vec4(uColor, body * h * rays * uOpacity);
  }`;

/**
 * An open, upward-widening cone of faint light. Unit height, base at y = 0.
 * Returns the mesh; drive `material.uniforms.uOpacity / uTime / uColor`.
 */
export function lightCone({ bottom = 0.2, top = 0.78, color = '#ff9a2e', opacity = 0.2 } = {}) {
  const geo = new THREE.CylinderGeometry(top, bottom, 1, 48, 1, true);
  geo.translate(0, 0.5, 0);
  const mat = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(color) }, uOpacity: { value: opacity }, uTime: { value: 0 } },
    vertexShader: CONE_VERT, fragmentShader: CONE_FRAG,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  return mesh;
}

// ---------------------------------------------------------------------------
// Stage
// ---------------------------------------------------------------------------

export class Stage {
  constructor() {
    this.group = new THREE.Group();
    this.time = 0;
    this.color = new THREE.Color('#ff9a2e');
    this.cur = null; // {y, radius, height, opacity}
    this.floorMat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: this.color }, uOpacity: { value: 0 }, uTime: { value: 0 } },
      vertexShader: FLOOR_VERT, fragmentShader: FLOOR_FRAG,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, side: THREE.DoubleSide,
    });
    this.lines = new THREE.LineSegments(emitterLines(), this.floorMat);
    this.fills = new THREE.Mesh(emitterFills(), this.floorMat);
    this.cone = lightCone();
    this.cone.material.uniforms.uColor.value = this.color;
    for (const o of [this.fills, this.cone, this.lines]) {
      o.frustumCulled = false;
      this.group.add(o);
    }
  }

  /**
   * @param target {y, radius, height, opacity, color: THREE.Color} — where the disc should sit (world y),
   *   how wide it is, how far up the light reaches, and what colour it throws.
   */
  update(dt, target) {
    this.time += dt;
    if (!this.cur) this.cur = { y: target.y, radius: target.radius, height: target.height, opacity: 0 };
    const k = 1 - Math.exp(-dt * 3.2);
    const c = this.cur;
    for (const key of ['y', 'radius', 'height', 'opacity']) c[key] += (target[key] - c[key]) * k;
    this.color.lerp(target.color, k);
    this.group.position.y = c.y;
    this.group.scale.set(c.radius, c.height, c.radius);
    this.group.visible = c.opacity > 0.01;
    this.floorMat.uniforms.uTime.value = this.time;
    this.floorMat.uniforms.uOpacity.value = c.opacity;
    this.cone.material.uniforms.uTime.value = this.time;
    this.cone.material.uniforms.uOpacity.value = c.opacity * 0.22;
  }
}

// ---------------------------------------------------------------------------
// Final screen pass: the room behind the hologram, scan lines over it, and sRGB output.
// It takes the place of the stock output pass, so it adds no pass of its own.
// ---------------------------------------------------------------------------

const SCREEN = {
  uniforms: {
    tDiffuse: { value: null },
    uRes: { value: new THREE.Vector2(1, 1) },
    uPixel: { value: 1 },
    uTime: { value: 0 },
    uTint: { value: new THREE.Color('#ff9a2e') },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform vec2 uRes; uniform float uPixel; uniform float uTime; uniform vec3 uTint;
    varying vec2 vUv;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    vec3 toSRGB(vec3 c){ c = max(c, 0.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
    void main(){
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      float aspect = uRes.x / uRes.y;

      // Hologram texture. Both are multiplied in, so they only show where light already is.
      float row = mod(floor(gl_FragCoord.y / uPixel), 3.0);
      c *= row < 1.0 ? 0.82 : 1.0;                                   // fine scan lines
      float sweep = fract(uTime / 11.0) * 1.3 - 0.15;                 // one slow pass up the picture
      c *= 1.0 + 0.2 * smoothstep(0.09, 0.0, abs(vUv.y - sweep));

      // The room: warm graphite, lit a little by the projector, falling off into the corners.
      vec2 p = (vUv - vec2(0.5, 0.46)) * vec2(aspect, 1.0);
      float fall = smoothstep(1.15, 0.05, length(p));
      vec3 room = vec3(0.0108, 0.0096, 0.0088) * (0.3 + 0.7 * fall);
      vec2 q = (vUv - vec2(0.5, 0.30)) * vec2(aspect * 0.8, 1.5);
      room += uTint * 0.0052 * smoothstep(0.75, 0.0, length(q));     // spill from the emitter
      // The hologram is held back a little behind the captions and the top bar, so the words always win.
      float strip = (1.0 - smoothstep(0.04, 0.2, vUv.y)) * smoothstep(0.42, 0.26, abs(vUv.x - 0.5));
      float bar = smoothstep(0.87, 0.96, vUv.y);
      c = c * (0.72 + 0.28 * fall) * (1.0 - 0.6 * strip) * (1.0 - 0.42 * bar) + room;

      c = toSRGB(c);
      c += (hash(gl_FragCoord.xy) - 0.5) / 255.0;                     // static dither: no banding in the dark
      gl_FragColor = vec4(c, 1.0);
    }`,
};

export function screenPass() {
  return new ShaderPass(SCREEN);
}
