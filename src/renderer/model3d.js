// A 3D model in the viewer pane: its own small three.js renderer, made on open and fully released
// on close. Two looks: "hologram" (amber edges and points with a passing scan line, like the maps)
// and "solid" (the model's own materials under plain light, over a faint grid).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js';
import { ColladaLoader } from 'three/addons/loaders/ColladaLoader.js';
import { dirOf } from './viewkit.js';

const AMBER = new THREE.Color('#ffb347');
const EDGE_LIMIT = 300000; // triangles per mesh above which only points are drawn (edges cost too much to find)
const DIST = new URL('../../dist/', location.href).href;
// An error worth showing as it is (the loaders' own errors are not).
const plain = (message) => Object.assign(new Error(message), { plain: true });

const holoVertex = /* glsl */ `
  uniform float uSize;
  varying float vY;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vY = wp.y;
    vec4 mv = viewMatrix * wp;
    gl_Position = projectionMatrix * mv;
    gl_PointSize = clamp(uSize / max(0.001, -mv.z), 1.0, 3.0);
  }`;
const holoFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity, uScan, uBand, uRound;
  varying float vY;
  void main() {
    if (uRound > 0.5 && length(gl_PointCoord - 0.5) > 0.5) discard;
    float band = exp(-pow((vY - uScan) / uBand, 2.0));
    gl_FragColor = vec4(uColor * (1.0 + band * 1.8), uOpacity * (0.75 + band));
  }`;

function holoMaterial(opacity, points = false) {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: AMBER.clone() }, uOpacity: { value: opacity }, uScan: { value: 0 }, uBand: { value: 1 }, uSize: { value: 1 }, uRound: { value: points ? 1 : 0 } },
    vertexShader: holoVertex,
    fragmentShader: holoFragment,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}


export class ModelView {
  /**
   * @param host element the canvas goes in
   * @param opts {path, ext, url(absPath) -> jarvis-file URL, onProgress(fraction)}
   */
  constructor(host, opts) {
    this.host = host;
    this.opts = opts;
    this.look = 'hologram';
    this.disposed = false;
    this.holo = []; // {mesh, original, fill, extras:[]}
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.canvas = this.renderer.domElement;
    this.canvas.className = 'model-canvas';
    host.append(this.canvas);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.01, 1000);
    this.scene.add(this.camera);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 1.1;
    this.controls.addEventListener('start', () => { this.controls.autoRotate = false; });
    this.lights = new THREE.Group();
    this.lights.add(new THREE.HemisphereLight(0xfff4e6, 0x302820, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(1, 1.6, 1.2);
    this.camera.add(sun);
    this.sun = sun;
    this.scene.add(this.lights);
    this.born = performance.now();
    this.resizer = new ResizeObserver(() => this._resize());
    this.resizer.observe(host);
    this._resize();
    const loop = () => {
      if (this.disposed) return;
      this.raf = requestAnimationFrame(loop);
      this._frame();
    };
    this.raf = requestAnimationFrame(loop);
  }

  /** Loads and frames the model. Resolves to its stats; rejects with a plain message. */
  async load() {
    const { path, ext } = this.opts;
    const base = this.opts.url(dirOf(path));
    const data = await this._fetch(this.opts.url(path), ['obj', 'dae', 'gltf'].includes(ext));
    if (this.disposed) return null;
    // a decoder that fails inside its worker never answers: give up rather than load forever
    let timer;
    const late = new Promise((_, reject) => { timer = setTimeout(() => reject(plain('That model took too long to load.')), 120000); });
    const root = await Promise.race([this._parse(ext, data, base), late]).finally(() => clearTimeout(timer));
    if (this.disposed) { disposeTree(root); return null; }
    this.root = root;
    this._place(root);
    this.setLook(this.look);
    return this.stats;
  }

  async _fetch(url, text) {
    const res = await fetch(url);
    if (!res.ok) throw plain(res.status === 403 ? 'That file is outside the folders I can see.' : 'I could not read that file.');
    const total = Number(res.headers.get('content-length')) || 0;
    if (!res.body || !total || !this.opts.onProgress) return text ? res.text() : res.arrayBuffer();
    const reader = res.body.getReader();
    const buf = new Uint8Array(total);
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done || this.disposed) break;
      buf.set(value.subarray(0, Math.max(0, total - got)), got);
      got += value.length;
      this.opts.onProgress(Math.min(1, got / total));
    }
    return text ? new TextDecoder().decode(buf) : buf.buffer;
  }

  async _parse(ext, data, base) {
    const manager = new THREE.LoadingManager();
    if (ext === 'glb' || ext === 'gltf') {
      const loader = new GLTFLoader(manager);
      this.draco = new DRACOLoader(manager).setDecoderPath(`${DIST}draco/`);
      loader.setDRACOLoader(this.draco);
      loader.setMeshoptDecoder(MeshoptDecoder);
      const gltf = await new Promise((resolve, reject) => loader.parse(data, base, resolve, reject));
      return gltf.scene || gltf.scenes?.[0];
    }
    if (ext === 'obj') {
      const loader = new OBJLoader(manager);
      const lib = /^\s*mtllib\s+(.+?)\s*$/m.exec(data)?.[1];
      if (lib) {
        try {
          const mtl = await (await fetch(this.opts.url(dirOf(this.opts.path) + lib))).text();
          const materials = new MTLLoader(manager).parse(mtl, base);
          materials.preload();
          loader.setMaterials(materials);
        } catch { /* no materials: plain grey */ }
      }
      return loader.parse(data);
    }
    if (ext === 'stl' || ext === 'ply') {
      const geometry = (ext === 'stl' ? new STLLoader(manager) : new PLYLoader(manager)).parse(data);
      const colors = Boolean(geometry.attributes.color);
      if (!geometry.attributes.normal && geometry.index) geometry.computeVertexNormals();
      const faces = geometry.index ? geometry.index.count : ext === 'stl' ? geometry.attributes.position.count : 0;
      const object = faces
        ? new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: colors ? 0xffffff : 0xc9c4bc, vertexColors: colors, metalness: 0.1, roughness: 0.65 }))
        : new THREE.Points(geometry, new THREE.PointsMaterial({ size: 0.01, sizeAttenuation: true, vertexColors: colors, color: colors ? 0xffffff : 0xc9c4bc }));
      const group = new THREE.Group();
      group.add(object);
      return group;
    }
    if (ext === 'fbx') return new FBXLoader(manager).parse(data, base);
    if (ext === '3mf') return new ThreeMFLoader(manager).parse(data);
    if (ext === 'dae') {
      const collada = new ColladaLoader(manager).parse(data, base);
      if (!collada?.scene) throw plain('That file has no model I can read.');
      return collada.scene;
    }
    throw plain('I cannot show that kind of model.');
  }

  /** Centre the model, frame it, and prepare its hologram look. */
  _place(root) {
    root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(root);
    if (box.isEmpty()) throw plain('That model is empty.');
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const pivot = new THREE.Group();
    pivot.add(root);
    root.position.sub(center);
    this.scene.add(pivot);
    this.pivot = pivot;
    pivot.updateMatrixWorld(true);

    const r = Math.max(1e-6, size.length() / 2);
    this.radius = r;
    this.minY = -size.y / 2;
    const fov = THREE.MathUtils.degToRad(this.camera.fov / 2);
    const dist = (r / Math.sin(fov)) * 1.08;
    this.camera.position.set(0.62, 0.42, 0.78).normalize().multiplyScalar(dist);
    this.camera.near = dist / 200;
    this.camera.far = dist * 50;
    this.camera.updateProjectionMatrix();
    this.controls.target.set(0, 0, 0);
    this.controls.minDistance = r * 0.15;
    this.controls.maxDistance = dist * 8;
    this.controls.update();

    this.grid = new THREE.GridHelper(r * 4, 24, 0x6a5232, 0x2a2118);
    this.grid.position.y = this.minY;
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.55;
    this.scene.add(this.grid);

    let vertices = 0;
    let triangles = 0;
    const edgeMat = holoMaterial(0.55);
    const pointMat = holoMaterial(0.5, true);
    const fillMat = new THREE.MeshBasicMaterial({ color: AMBER, transparent: true, opacity: 0.045, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    this.holoMats = [edgeMat, pointMat, fillMat];
    const found = [];
    root.traverse((o) => found.push(o));
    for (const o of found) {
      const g = o.geometry;
      if (!g?.attributes?.position) continue;
      const count = g.attributes.position.count;
      vertices += count;
      const entry = { mesh: o, original: o.material, extras: [] };
      if (o.isMesh) {
        const tris = g.index ? g.index.count / 3 : count / 3;
        triangles += tris;
        entry.fill = fillMat;
        if (tris <= EDGE_LIMIT && !o.isSkinnedMesh) {
          const edges = new THREE.LineSegments(new THREE.EdgesGeometry(g, 28), edgeMat);
          entry.extras.push(edges);
        }
        entry.extras.push(new THREE.Points(g, pointMat));
      } else if (o.isPoints) {
        entry.fill = pointMat;
      } else continue;
      for (const x of entry.extras) { x.visible = false; x.raycast = () => {}; o.add(x); }
      this.holo.push(entry);
    }
    pointMat.uniforms.uSize.value = dist * 1.6;
    for (const m of [edgeMat, pointMat]) m.uniforms.uBand.value = Math.max(1e-6, size.y * 0.06);
    const fmt = (n) => (n >= 100 ? n.toFixed(0) : n >= 1 ? n.toFixed(2) : n.toPrecision(2));
    this.stats = { vertices, triangles: Math.round(triangles), size: [size.x, size.y, size.z].map(fmt).join(' × ') };
  }

  setLook(look) {
    this.look = look;
    const holo = look === 'hologram';
    for (const e of this.holo) {
      e.mesh.material = holo ? e.fill : e.original;
      for (const x of e.extras) x.visible = holo;
    }
    this.lights.visible = !holo;
    this.sun.visible = !holo;
    if (this.grid) this.grid.visible = !holo;
  }

  _frame() {
    const t = (performance.now() - this.born) / 1000;
    if (this.holoMats && this.look === 'hologram') {
      const span = -this.minY * 2;
      const scan = this.minY - span * 0.15 + ((t * 0.22) % 1) * span * 1.3;
      for (const m of this.holoMats) if (m.uniforms) m.uniforms.uScan.value = scan;
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  _resize() {
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Release everything: geometries, materials, textures, the WebGL context itself. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.resizer.disconnect();
    this.controls.dispose();
    for (const e of this.holo) {
      e.mesh.material = e.original;
      for (const x of e.extras) if (x.isLineSegments) x.geometry.dispose();
    }
    for (const m of this.holoMats || []) m.dispose();
    disposeTree(this.scene);
    this.draco?.dispose();
    this.renderer.renderLists.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.canvas.remove();
    this.scene = this.root = this.pivot = null;
  }
}

function disposeTree(root) {
  if (!root) return;
  const seen = new Set();
  root.traverse((o) => {
    if (o.geometry && !seen.has(o.geometry)) { seen.add(o.geometry); o.geometry.dispose(); }
    for (const m of [].concat(o.material || [])) {
      if (seen.has(m)) continue;
      seen.add(m);
      for (const v of Object.values(m)) {
        if (v?.isTexture && !seen.has(v)) { seen.add(v); v.source?.data?.close?.(); v.dispose(); }
      }
      m.dispose();
    }
  });
}
