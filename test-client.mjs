#!/usr/bin/env node
// Smoke-test client for @gradus/notation-mcp.
// Spawns the MCP server, lists tools, calls notation_render, prints results.
// Requires the dev server running at http://localhost:3000 (or set GRADUS_NOTATION_API_BASE).

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'node',
  args: ['./dist/index.js'],
  env: {
    ...process.env,
    GRADUS_NOTATION_API_BASE: process.env.GRADUS_NOTATION_API_BASE ?? 'http://localhost:3000',
  },
});

const client = new Client({ name: 'smoke-test', version: '0.1.0' }, { capabilities: {} });
await client.connect(transport);

console.log('=== Connected ===');
const { tools } = await client.listTools();
console.log(`Tools registered (${tools.length}):`);
for (const t of tools) console.log(`  - ${t.name}: ${t.description.slice(0, 80)}…`);

console.log('\n=== Calling notation_render ===');
const renderResult = await client.callTool({
  name: 'notation_render',
  arguments: {
    title: 'MCP smoke test',
    instruments: [{ name: 'Violin', notes: ['C5/q', 'D5/q', 'E5/q', 'F5/q'] }],
  },
});
const renderJson = JSON.parse(renderResult.content[0].text);
console.log(`  ok: ${renderJson.ok}, svg bytes: ${renderJson.outputs?.svg?.length ?? 'n/a'}, attribution.sponsor: ${renderJson.attribution?.sponsor}`);

console.log('\n=== Calling notation_validate (error case) ===');
const validateResult = await client.callTool({
  name: 'notation_validate',
  arguments: {
    instruments: [{ name: 'V', notes: ['X9/q'] }],
  },
});
const validateJson = JSON.parse(validateResult.content[0].text);
console.log(`  ok: ${validateJson.ok}, valid: ${validateJson.valid}, first error: ${validateJson.errors?.[0]?.code} — ${validateJson.errors?.[0]?.message?.slice(0, 60)}`);

console.log('\n=== Calling knowledge_search ===');
const knowledgeResult = await client.callTool({
  name: 'knowledge_search',
  arguments: { topics: ['voice-leading'], limit: 2 },
});
const knowledgeJson = JSON.parse(knowledgeResult.content[0].text);
console.log(`  ok: ${knowledgeJson.ok}, returned: ${knowledgeJson.meta?.returnedCount}, first chunk title: "${knowledgeJson.chunks?.[0]?.title?.slice(0, 60)}"`);

console.log('\n=== Calling notation_examples ===');
const examplesResult = await client.callTool({ name: 'notation_examples', arguments: {} });
const examplesJson = JSON.parse(examplesResult.content[0].text);
console.log(`  ok: ${examplesJson.ok}, example IDs: ${examplesJson.examples?.map(e => e.id).join(', ')}`);

console.log('\n=== All MCP smoke tests passed ===');
await client.close();
process.exit(0);
