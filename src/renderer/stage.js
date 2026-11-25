// The projection table. Everything Jarvis shows is thrown up into the room from an emitter disc
// beneath it, drawn in thin additive light, with a cone of light rising from the lens. Under the
// orb (Core) the disc is a full instrument: rings, gauge ticks, a polar grid. Under a map it is
// pared back to a ticked rim, one inner ring and the glow of the lens, so it never competes with
// the data. A final screen pass gives the picture its room (dark, warm at the centre) and its scan
// lines. The whole stage is three draw calls.
import * as THREE from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// Emitter disc
// ---------------------------------------------------------------------------

// Where the caption and the hint sit (bottom centre of the window): the table's light is faded out
// behind them, so the words stand on clean dark background. The band is sized in CSS pixels, like
// the caption itself, and is as tall as the caption: it grows when a reply runs to several lines
// or the type box opens. Every material that fades behind it shares these two uniforms.
// uCaption: half-width where the fade is complete / where it ends, then the height above the
// window's foot where it is complete / where it ends — all in drawing-buffer pixels.
export const CAPTION = { uRes: { value: new THREE.Vector2(1, 1) }, uCaption: { value: new THREE.Vector4(-2, -1, -2, -1) } };
export const CAPTION_MASK = /* glsl */ `
  uniform vec2 uRes; uniform vec4 uCaption;
  float captionMask(){
    return 1.0 - 0.96 * (1.0 - smoothstep(uCaption.z, uCaption.w, gl_FragCoord.y)) * (1.0 - smoothstep(uCaption.x, uCaption.y, abs(gl_FragCoord.x - 0.5 * uRes.x)));
  }`;

// CSS pixels: the fade's width at each side; the least height above the foot at which it is
// complete (a one-line caption); how far it clears the top of the words; how much higher it ends.
const BAND = { ramp: 144, full: 122, clear: 14, rise: 49 };
const band = { mid: 0, height: 1e9, half: 0, pr: 1, full: BAND.full, aim: BAND.full }; // the band as it stands, in CSS pixels

function writeBand() {
  CAPTION.uCaption.value.set(band.half, band.half + BAND.ramp, band.full, band.full + BAND.rise).multiplyScalar(band.pr);
}

/**
 * Call when the window, its pixel ratio or the caption changes. width and height are CSS pixels;
 * captionTop is how far above the window's foot the caption's words begin. The band's height then
 * eases to its new size (see easeCaptionBand).
 */
export function setCaptionBand(width, height, pixelRatio, captionTop = 0) {
  band.mid = width / 2; band.height = height; band.half = Math.min(432, width * 0.36); band.pr = pixelRatio;
  band.aim = Math.max(BAND.full, Math.min(captionTop + BAND.clear, height * 0.5)); // never more than the lower half of the window
  CAPTION.uRes.value.set(width * pixelRatio, height * pixelRatio);
  writeBand();
}

/** Each frame: the band follows the caption as it grows or shrinks, without a step. */
export function easeCaptionBand(dt) {
  if (band.full === band.aim) return;
  band.full += (band.aim - band.full) * (1 - Math.exp(-dt * 9));
  if (Math.abs(band.aim - band.full) < 0.5) band.full = band.aim;
  writeBand();
}

/**
 * The same fade, for things placed from JavaScript (labels, picking): how much of something that
 * spans x0..x1 at height y (CSS pixels from the window's top left) is left behind the caption.
 */
export function captionFade(x0, x1, y) {
  const dx = Math.max(0, x0 - band.mid, band.mid - x1);
  const low = 1 - THREE.MathUtils.smoothstep(band.height - y, band.full, band.full + BAND.rise);
  return 1 - 0.96 * low * (1 - THREE.MathUtils.smoothstep(dx, band.half, band.half + BAND.ramp));
}

const FLOOR_VERT = /* glsl */ `
  attribute float aSpin; attribute float aAlpha; attribute float aRise; attribute float aDetail;
  uniform float uTime; uniform float uDetail;
  varying float vA; varying float vR;
  void main(){
    vec3 q = position;
    float a = aAlpha * mix(1.0, uDetail, aDetail);          // instrument detail is only drawn under the orb
    vR = length(position.xz);
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
    gl_Position = projectionMatrix * modelViewMatrix * vec4(q, 1.0);
  }`;
const FLOOR_FRAG = /* glsl */ `
  uniform vec3 uColor; uniform float uOpacity; uniform float uTime; uniform float uFar;
  varying float vA; varying float vR;
  ${CAPTION_MASK}
  void main(){
    // a slow ripple of light leaving the lens and crossing the disc
    float wave = fract(uTime * 0.07) * 1.5;
    float pulse = smoothstep(0.16, 0.0, abs(vR - wave)) * (1.0 - wave / 1.5);
    float a = vA * uOpacity * (1.0 + pulse * 1.1);
    a *= mix(1.0, uFar, smoothstep(0.1, 0.3, vR));          // the big arcs step back when the viewer is in among them
    a *= captionMask();
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
    this.det = [];
    this.detail = 0; // 1 while sketching instrument detail (shown under the orb only)
  }

  v(x, y, z, spin, alpha, rise = 0) {
    this.pos.push(x, y, z);
    this.spin.push(spin);
    this.alpha.push(alpha);
    this.rise.push(rise);
    this.det.push(this.detail);
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
    geo.setAttribute('aDetail', new THREE.Float32BufferAttribute(this.det, 1));
    return geo;
  }
}

function emitterLines() {
  const s = new Sketch();
  // Always there: the lens, one inner ring, and the rim — a full gauge circle with measurement ticks.
  s.arc(0.045, 0, 0.95);
  s.arc(0.5, 0, 0.3);
  s.arc(1.0, 0.035, 0.6);
  s.ticks(1.0, 0.018, 180, 0.035, 0.6, 5);
  s.ticks(1.0, 0.022, 12, 0.035, 0.75, 1);

  // Everything below is instrument detail, drawn under the orb only.
  s.detail = 1;
  s.ticks(1.0484, 0.048, 12, 0.035, 0.75, 1); // the twelve long gauge marks
  s.arc(0.085, 0.5, 0.7, 0.02, 0.3); s.arc(0.085, 0.5, 0.7, 0.36, 0.63); s.arc(0.085, 0.5, 0.7, 0.69, 0.97);
  s.arc(0.13, 0, 0.5);
  s.ticks(0.13, 0.012, 24, 0, 0.6, 3);

  // polar grid, fixed to the table and fading toward the rim
  for (const [r, a] of [[0.25, 0.3], [0.75, 0.17]]) s.arc(r, 0, a);
  for (let i = 0; i < 12; i++) s.spoke((i / 12) * TAU, 0.13, 1.0, 0, 0.3, 0.08);
  for (let i = 0; i < 36; i++) if (i % 3) s.spoke((i / 36) * TAU, 0.75, 1.0, 0, 0.13, 0.05);

  // inner instrument ring, turning one way
  s.arc(0.36, 0.11, 0.8, 0.0, 0.29); s.arc(0.36, 0.11, 0.8, 0.34, 0.6); s.arc(0.36, 0.11, 0.8, 0.67, 0.95);
  s.ticks(0.325, 0.014, 60, 0.11, 0.6, 5);

  // middle ring, turning the other way
  s.arc(0.62, -0.06, 0.62, 0.0, 0.2); s.arc(0.62, -0.06, 0.62, 0.25, 0.46); s.arc(0.62, -0.06, 0.62, 0.5, 0.7); s.arc(0.62, -0.06, 0.62, 0.76, 0.96);
  s.arc(0.635, -0.06, 0.3, 0.05, 0.16); s.arc(0.635, -0.06, 0.3, 0.55, 0.66);
  s.ticks(0.62, -0.016, 96, -0.06, 0.5, 4, (i) => i % 24 > 19);

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
  s.band(0.0, 1.0, 0, 0.04, 0.0); // the faintest wash, so the disc reads as a surface
  // translucent bands riding the instrument rings
  s.detail = 1;
  for (const [from, to] of [[0.03, 0.2], [0.4, 0.52], [0.7, 0.9]]) s.band(0.385, 0.415, 0.11, 0.17, 0.17, from, to);
  for (const [from, to] of [[0.08, 0.18], [0.3, 0.43], [0.58, 0.64], [0.8, 0.93]]) s.band(0.655, 0.675, -0.06, 0.12, 0.12, from, to);
  for (let i = 0; i < 4; i++) s.band(1.045, 1.062, 0.035, 0.07, 0.07, i / 4 + 0.03, i / 4 + 0.17);
  return s.geometry();
}

// ---------------------------------------------------------------------------
// Cone of light
// ---------------------------------------------------------------------------

const CONE_VERT = /* glsl */ `
  varying vec3 vN; varying vec3 vV; varying float vH; varying vec2 vXZ;
  void main(){
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vN = normalMatrix * normal;
    vV = -mv.xyz;
    vH = uv.y;
    vXZ = position.xz; // the angle is taken per fragment: interpolating it would smear across its branch cut
    gl_Position = projectionMatrix * mv;
  }`;
const CONE_FRAG = /* glsl */ `
  uniform vec3 uColor; uniform float uOpacity; uniform float uTime;
  varying vec3 vN; varying vec3 vV; varying float vH; varying vec2 vXZ;
  ${CAPTION_MASK}
  void main(){
    // thick through the middle, vanishing at the silhouette: reads as a volume of lit air
    float body = pow(abs(dot(normalize(vN), normalize(vV))), 1.4);
    float h = pow(1.0 - vH, 1.7);
    float ang = atan(vXZ.y, vXZ.x);
    float rays = 0.72 + 0.28 * sin(ang * 18.0 + uTime * 0.12) * sin(ang * 7.0 - uTime * 0.07);
    gl_FragColor = vec4(uColor, body * h * rays * uOpacity * captionMask());
  }`;

/**
 * An open, upward-widening cone of faint light. Unit height, base at y = 0.
 * Returns the mesh; drive `material.uniforms.uOpacity / uTime / uColor`. `masked` makes it fade
 * behind the caption; otherwise it is drawn everywhere.
 */
export function lightCone({ bottom = 0.2, top = 0.78, color = '#ff9a2e', opacity = 0.2, masked = false } = {}) {
  const geo = new THREE.CylinderGeometry(top, bottom, 1, 48, 1, true);
  geo.translate(0, 0.5, 0);
  const band = masked ? CAPTION : { uRes: { value: new THREE.Vector2(1, 1) }, uCaption: { value: new THREE.Vector4(-2, -1, -2, -1) } };
  const mat = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(color) }, uOpacity: { value: opacity }, uTime: { value: 0 }, uRes: band.uRes, uCaption: band.uCaption },
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

const EASED = ['y', 'radius', 'height', 'opacity', 'cone', 'detail'];
const CONE_BOTTOM = 0.2, CONE_TOP = 0.78; // the cone's radius at the table and at its top, in disc radii
const smooth = (x, a, b) => THREE.MathUtils.smoothstep(x, a, b);

export class Stage {
  constructor() {
    this.group = new THREE.Group();
    this.time = 0;
    this.color = new THREE.Color('#ff9a2e');
    this.cur = null; // {y, radius, height, opacity, cone, detail}
    this.floorMat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: this.color }, uOpacity: { value: 0 }, uTime: { value: 0 }, uDetail: { value: 1 }, uFar: { value: 1 }, uRes: CAPTION.uRes, uCaption: CAPTION.uCaption },
      vertexShader: FLOOR_VERT, fragmentShader: FLOOR_FRAG,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, side: THREE.DoubleSide,
    });
    this.lines = new THREE.LineSegments(emitterLines(), this.floorMat);
    this.fills = new THREE.Mesh(emitterFills(), this.floorMat);
    this.cone = lightCone({ bottom: CONE_BOTTOM, top: CONE_TOP, masked: true });
    this.cone.material.uniforms.uColor.value = this.color;
    for (const o of [this.fills, this.cone, this.lines]) {
      o.frustumCulled = false;
      this.group.add(o);
    }
  }

  /**
   * @param target {y, radius, height, opacity, cone, detail, color: THREE.Color} — where the disc sits
   *   (world y), how wide it is, how far up the light reaches, how bright the disc and the cone are,
   *   how much instrument detail the disc carries (0..1), and what colour it throws.
   * @param eye the camera's world position: when the viewer is inside the cone of light, or in
   *   close over the table, the haze and the big arcs fade so they do not wash over the picture.
   */
  update(dt, target, eye) {
    this.time += dt;
    if (!this.cur) this.cur = { y: target.y, radius: target.radius, height: target.height, opacity: 0, cone: target.cone, detail: target.detail };
    const k = 1 - Math.exp(-dt * 3.2);
    const c = this.cur;
    for (let i = 0; i < EASED.length; i++) c[EASED[i]] += (target[EASED[i]] - c[EASED[i]]) * k;
    this.color.lerp(target.color, k);
    this.group.position.y = c.y;
    this.group.scale.set(c.radius, c.height, c.radius);
    this.group.visible = c.opacity > 0.01;

    const up = eye.y - c.y;
    const out = Math.hypot(eye.x, eye.z);
    const coneR = c.radius * (CONE_BOTTOM + (CONE_TOP - CONE_BOTTOM) * THREE.MathUtils.clamp(up / c.height, 0, 1));
    const clear = Math.min(smooth(out / coneR, 1.15, 2.6), smooth(Math.hypot(out, up) / c.radius, 1.6, 5));

    this.floorMat.uniforms.uTime.value = this.time;
    this.floorMat.uniforms.uOpacity.value = c.opacity;
    this.floorMat.uniforms.uDetail.value = c.detail;
    this.floorMat.uniforms.uFar.value = 0.1 + 0.9 * clear;
    this.cone.material.uniforms.uTime.value = this.time;
    this.cone.material.uniforms.uOpacity.value = c.opacity * c.cone * clear;
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
    uPixel: { value: 1 }, // scan-line pitch in drawing-buffer pixels (whole)
    uDpr: { value: 1 }, // drawing-buffer pixels per CSS pixel
    uTime: { value: 0 },
    uTint: { value: new THREE.Color('#ff9a2e') },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform vec2 uRes; uniform float uPixel; uniform float uDpr; uniform float uTime; uniform vec3 uTint;
    varying vec2 vUv;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    vec3 toSRGB(vec3 c){ c = max(c, 0.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
    void main(){
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      float aspect = uRes.x / uRes.y;

      // Hologram texture: fine scan lines, as deep as the projected light at that pixel is bright,
      // so they texture the hologram itself and never band the empty room or the soft glow around it.
      float lit = smoothstep(0.03, 0.3, max(c.r, max(c.g, c.b)));
      float row = mod(floor(gl_FragCoord.y / uPixel), 3.0);
      c *= 1.0 - 0.2 * lit * step(row, 0.5);
      float sweep = fract(uTime / 11.0) * 1.3 - 0.15;                 // one slow pass up the picture
      c *= 1.0 + 0.2 * smoothstep(0.09, 0.0, abs(vUv.y - sweep));

      // The room: dark, a little warmth at the centre falling away to nothing in the corners,
      // and the faintest spill of the emitter's colour above the table.
      vec2 p = (vUv - vec2(0.5, 0.46)) * vec2(aspect, 1.0);
      float fall = smoothstep(1.15, 0.05, length(p));
      vec3 room = vec3(0.0034, 0.0025, 0.0019) * (0.12 + 0.88 * fall * fall);
      vec2 q = (vUv - vec2(0.5, 0.30)) * vec2(aspect * 0.8, 1.5);
      float spill = smoothstep(0.75, 0.0, length(q));
      room += uTint * 0.0022 * spill * spill;
      // The hologram is held back a little behind the captions and the top bar, so the words always
      // win. Both bands are sized in CSS pixels, like the HUD itself.
      vec2 css = gl_FragCoord.xy / uDpr, win = uRes / uDpr;
      float capHalf = min(375.0, win.x * 0.26);
      float strip = (1.0 - smoothstep(36.0, 180.0, css.y)) * smoothstep(capHalf * 1.6, capHalf, abs(css.x - 0.5 * win.x));
      float bar = 1.0 - smoothstep(36.0, 117.0, win.y - css.y);
      c = c * (0.72 + 0.28 * fall) * (1.0 - 0.6 * strip) * (1.0 - 0.42 * bar) + room;

      c = toSRGB(c);
      c += (hash(gl_FragCoord.xy) - 0.5) / 255.0;                     // static dither: no banding in the dark
      gl_FragColor = vec4(c, 1.0);
    }`,
};

export function screenPass() {
  return new ShaderPass(SCREEN);
}

// ---------------------------------------------------------------------------
// Bloom: which light glows
// ---------------------------------------------------------------------------

// The bloom pass decides what is bright enough to glow at half resolution, from the average of each
// 2x2 block of pixels. A hairline lies inside one block or is split between two depending on where
// it falls on the pixel grid, so along a beam at a shallow slope the glow would switch on and off
// every couple of rows: beads of light that crawl as the view turns. Here a block that holds some
// light, but not enough to glow by itself, is also judged by the 6x6 pixels around it, where those
// hold one line and nothing else: light all the way across (side to side, or top to bottom), with
// one side of it, or two opposite corners, left dark. Such a block counts as bright as it would be
// if the line ran squarely through it, though never brighter than the brightest pixel next to it,
// so a lone thin line near the horizontal or the vertical (where the beads are long enough to see)
// glows along its whole length or not at all. Everything else is judged exactly as before: a broad
// area of light, a point, a line well off both axes, and above all a crowd of points and lines
// such as the orb or the table's rings, which would otherwise glow in every gap. Nothing glows
// less than it did. The wider look is eight more bilinear samples, and the brightest pixel is only
// searched for where that look finds a line: the dark room and the bright cores cost what they
// always did.
const BLOOM_LONE = 0.2; // a line is alone while the light off it is under this share of its own
const BLOOM_GATE = /* glsl */ `
  uniform sampler2D tDiffuse; uniform float luminosityThreshold; uniform float smoothWidth;
  varying vec2 vUv;
  float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
  void main(){
    vec2 px = 1.0 / vec2(textureSize(tDiffuse, 0));
    vec3 block = textureLod(tDiffuse, vUv, 0.0).rgb;        // this 2x2 block: what goes on to be blurred
    float v = luma(block);
    if (v > 0.002 && v < luminosityThreshold + smoothWidth) {
      mat3 n;                                               // the 6x6 pixels around it, as nine 2x2 averages
      for (int j = 0; j < 3; j++) for (int i = 0; i < 3; i++) n[i][j] = luma(textureLod(tDiffuse, vUv + vec2(float(i - 1), float(j - 1)) * 2.0 * px, 0.0).rgb);
      vec3 cols = vec3(1.0) * n, rows = n[0] + n[1] + n[2]; // their light by column and by row
      // a line's light across its width, as one block would hold it: what the weakest third of its run through here holds
      float line = max(min(cols.x, min(cols.y, cols.z)), min(rows.x, min(rows.y, rows.z)));
      // what lies off the line: the darker side of the neighbourhood, or the darker pair of opposite corners
      float off = min(min(min(cols.x, cols.z), min(rows.x, rows.z)), min(n[0][0] + n[2][2], n[2][0] + n[0][2]));
      if (line > v && line > luminosityThreshold && off < ${BLOOM_LONE.toFixed(2)} * line) {
        float peak = 0.0;
        for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++) peak = max(peak, luma(textureLod(tDiffuse, vUv + (vec2(float(i), float(j)) - 1.5) * px, 0.0).rgb));
        v = max(v, min(peak, line));
      }
    }
    gl_FragColor = vec4(block * smoothstep(luminosityThreshold, luminosityThreshold + smoothWidth, v), 1.0);
  }`;

/** Swaps the steadier bright-pass in on an UnrealBloomPass (same pass, same uniforms). */
export function steadyBloom(bloom) {
  bloom.materialHighPassFilter.fragmentShader = BLOOM_GATE;
  bloom.materialHighPassFilter.needsUpdate = true;
  return bloom;
}
