/**
 * node --test server/test/codex-mcp-permissions.test.mjs
 *
 * Regression: Codex runner cannot just register the PromptCut MCP server. The global approval policy
 * is never, so it must also explicitly list visible tools and exempt only this server from approval,
 * otherwise invocations will fail directly in Codex locally.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tools } from '../mcp-tools.mjs';
import { buildCodexArgs } from '../runners/codex.mjs';

test('Codex launch arguments allow PromptCut tools one by one and skip MCP approval, without loosening the shell sandbox', () => {
  const argv = buildCodexArgs({
    cwd: 'C:\\project',
    mcp: { command: 'node', args: ['mcp-server.mjs'], env: { PROMPTCUT_PORT: '5195' } },
  });

  assert.ok(argv.includes(
    `mcp_servers.promptcut.enabled_tools=${JSON.stringify(tools.map(t => t.name))}`,
  ));
  assert.ok(argv.includes('mcp_servers.promptcut.default_tools_approval_mode="approve"'));

  // Never secretly introduce global authorization or disable the sandbox here.
  assert.ok(argv.includes('read-only'));
  assert.ok(argv.includes('approval_policy="never"'));
  assert.ok(argv.every(v => !v.includes('dangerously-bypass')));
});
