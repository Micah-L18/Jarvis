// Bundles the renderer (three.js, the force layout, and the app) into dist/renderer.js.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/renderer/app.js'],
  bundle: true,
  format: 'esm',
  target: 'chrome130',
  outfile: 'dist/renderer.js',
  minify: !process.argv.includes('--dev'),
  sourcemap: process.argv.includes('--dev') ? 'inline' : false,
  logLevel: 'warning',
});
