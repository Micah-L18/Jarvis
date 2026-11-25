// A minimal MCP server over stdio, used to test connections.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'echo', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: 'shout', description: 'Upper-case some text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }],
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => ({
  content: [{ type: 'text', text: String(req.params.arguments.text).toUpperCase() + (process.env.SUFFIX || '') }],
}));
await server.connect(new StdioServerTransport());
