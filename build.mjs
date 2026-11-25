// Bundles the renderer (three.js, the force layout, and the app) into dist/renderer.js. The file
// viewer's heavier parts (pdf.js, markdown, the 3D model loaders) are split into chunks loaded on
// first use, and the decoders they need at run time are copied next to them.
import { build } from 'esbuild';
import fs from 'node:fs';

const dev = process.argv.includes('--dev');
fs.rmSync('dist/chunks', { recursive: true, force: true });

await build({
  entryPoints: { renderer: 'src/renderer/app.js' },
  bundle: true,
  format: 'esm',
  splitting: true,
  target: 'chrome130',
  outdir: 'dist',
  chunkNames: 'chunks/[name]-[hash]',
  minify: !dev,
  sourcemap: dev ? 'inline' : false,
  logLevel: 'warning',
});

const copy = (from, to) => fs.cpSync(from, to, { recursive: true });
copy('node_modules/three/examples/jsm/libs/draco/gltf', 'dist/draco');
copy('node_modules/pdfjs-dist/build/pdf.worker.min.mjs', 'dist/pdfjs/pdf.worker.mjs');
copy('node_modules/pdfjs-dist/standard_fonts', 'dist/pdfjs/standard_fonts');
copy('node_modules/pdfjs-dist/cmaps', 'dist/pdfjs/cmaps');
copy('node_modules/pdfjs-dist/wasm', 'dist/pdfjs/wasm');
