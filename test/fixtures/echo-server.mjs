#!/usr/bin/env node
// Minimal mock MCP-ish server for proxy tests. Reads newline-delimited JSON
// requests on stdin and writes responses on stdout. NOT a real MCP server —
// just enough JSON-RPC framing to exercise the proxy.

import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin });

rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === 'ping') {
    process.stdout.write(
      JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { pong: true } }) + '\n',
    );
  } else if (msg.method === 'tools/call') {
    const result = {
      content: [{ type: 'text', text: `called ${msg.params?.name}` }],
    };
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
  } else if (msg.method === 'shutdown') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\n');
    process.exit(0);
  }
});

rl.on('close', () => process.exit(0));
