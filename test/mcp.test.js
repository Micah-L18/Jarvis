import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpHub } from '../src/main/mcp.js';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/echo-mcp.mjs');

test('mcp: a command-type server connects, exposes namespaced tools, and can be removed', async () => {
  const changes = [];
  const hub = new McpHub((s) => changes.push(s));
  const config = { id: 'a1', name: 'Echo Box', type: 'stdio', command: process.execPath, args: `"${fixture}"`, env: { SUFFIX: '!' }, enabled: true };
  await hub.sync([config]);
  assert.deepEqual(hub.status().map((s) => [s.id, s.status, s.tools.map((t) => t.name)]), [['a1', 'connected', ['shout']]]);
  const [tool] = hub.tools();
  assert.equal(tool.name, 'mcp__echo_box__shout');
  assert.equal(await tool.run({ text: 'hello' }), 'HELLO!');

  await hub.sync([{ ...config, enabled: false }]);
  assert.equal(hub.tools().length, 0);

  await hub.sync([{ id: 'bad', name: 'Broken', type: 'stdio', command: 'definitely-not-a-real-command-xyz', args: '', enabled: true }]);
  assert.equal(hub.status()[0].status, 'error');
  await hub.closeAll();
});
