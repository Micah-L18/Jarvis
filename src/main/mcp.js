// MCP connections: each configured server becomes a set of tools named mcp__<server>__<tool>.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { slugify } from './store.js';

function splitArgs(args) {
  if (Array.isArray(args)) return args;
  return (String(args || '').match(/"[^"]*"|'[^']*'|\S+/g) || []).map((a) => a.replace(/^["']|["']$/g, ''));
}

export class McpHub {
  constructor(onChange = () => {}) {
    this.connections = new Map(); // id -> {config, client, tools, status, error}
    this.onChange = onChange;
  }

  status() {
    return [...this.connections.values()].map(({ config, tools, status, error }) => ({
      id: config.id, status, error: error || '', tools: tools.map((t) => ({ name: t.name, description: t.description || '' })),
    }));
  }

  /** Bring live connections in line with the configured server list. */
  async sync(servers) {
    const wanted = new Map(servers.filter((s) => s.enabled !== false).map((s) => [s.id, s]));
    for (const [id, conn] of this.connections) {
      if (!wanted.has(id) || JSON.stringify(wanted.get(id)) !== JSON.stringify(conn.config)) await this.disconnect(id);
    }
    await Promise.all([...wanted.values()].filter((s) => !this.connections.has(s.id)).map((s) => this.connect(s)));
    this.onChange(this.status());
  }

  async connect(config) {
    const conn = { config, client: null, tools: [], status: 'connecting', error: '' };
    this.connections.set(config.id, conn);
    this.onChange(this.status());
    try {
      const client = new Client({ name: 'jarvis', version: '0.1.0' });
      if (config.type === 'http') {
        const opts = { requestInit: { headers: config.headers || {} } };
        try {
          await client.connect(new StreamableHTTPClientTransport(new URL(config.url), opts));
        } catch {
          await client.connect(new SSEClientTransport(new URL(config.url), opts));
        }
      } else {
        await client.connect(new StdioClientTransport({
          command: config.command,
          args: splitArgs(config.args),
          env: { ...process.env, ...(config.env || {}) },
          stderr: 'ignore',
        }));
      }
      conn.client = client;
      conn.tools = (await client.listTools()).tools || [];
      conn.status = 'connected';
      client.onclose = () => {
        if (this.connections.get(config.id) === conn) {
          conn.status = 'disconnected';
          this.onChange(this.status());
        }
      };
    } catch (err) {
      conn.status = 'error';
      conn.error = err?.message || String(err);
    }
    this.onChange(this.status());
  }

  async disconnect(id) {
    const conn = this.connections.get(id);
    this.connections.delete(id);
    try {
      await conn?.client?.close();
    } catch {
      /* already gone */
    }
  }

  /** Tool definitions in the app's neutral shape. */
  tools() {
    const out = [];
    for (const conn of this.connections.values()) {
      if (conn.status !== 'connected') continue;
      const prefix = `mcp__${slugify(conn.config.name).replace(/-/g, '_')}__`;
      for (const t of conn.tools) {
        out.push({
          name: (prefix + t.name).slice(0, 64),
          description: `[${conn.config.name}] ${t.description || t.name}`,
          schema: t.inputSchema || { type: 'object', properties: {} },
          run: async (input) => {
            const res = await conn.client.callTool({ name: t.name, arguments: input || {} });
            const text = (res.content || []).map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
            if (res.isError) throw new Error(text || 'MCP tool failed');
            return text || 'Done.';
          },
        });
      }
    }
    return out;
  }

  async closeAll() {
    await Promise.all([...this.connections.keys()].map((id) => this.disconnect(id)));
  }
}
