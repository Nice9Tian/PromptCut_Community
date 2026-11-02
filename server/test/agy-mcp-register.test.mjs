/**
 * agy's MCP registration is global: the port cannot be hardcoded in registration, otherwise two
 * instances of the same codebase (different ports) collide, and agy's tool calls keep hitting
 * ports that are closed or occupied by other programs. Port is now passed via environment variables
 * each time agy starts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mcpAddArgs } from '../runners/agy.mjs';

test('The registration command has no port: only the name, node and the script', () => {
  const args = mcpAddArgs({ command: 'C:/node.exe', args: ['C:/app/server/mcp-server.mjs'], env: { PROMPTCUT_PORT: '5198' } });
  assert.deepEqual(args, ['mcp', 'add', 'promptcut', 'C:/node.exe', 'C:/app/server/mcp-server.mjs']);
  assert.ok(!args.includes('-e') && !args.some((a) => /PROMPTCUT_PORT|5198/.test(a)));
});
