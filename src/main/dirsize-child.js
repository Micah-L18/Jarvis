// The child process DirSizer (dirsize.js) runs folder walks in, so that main never waits on the disk.
import { DirWalker } from './dirsize.js';

let walker = new DirWalker();
process.on('message', async (m) => {
  if (m.type === 'init') {
    walker = new DirWalker({ skip: m.skip || [], ...(m.opTimeout ? { opTimeout: m.opTimeout } : {}) });
    walker.onStuck = (where) => process.send({ type: 'stuck', path: where });
  } else if (m.type === 'clear') walker.clear();
  else if (m.type === 'stop') walker.stop();
  else if (m.type === 'measure') {
    try {
      await walker.measure(m.dirs, (dir, r) => process.send({ type: 'size', gen: m.gen, dir, r }), m.opts || {});
    } finally {
      process.send({ type: 'done', gen: m.gen });
    }
  }
});
process.on('disconnect', () => process.exit(0)); // Jarvis is gone
