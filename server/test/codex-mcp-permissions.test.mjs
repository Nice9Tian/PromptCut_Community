/**
 * node --test server/test/codex-mcp-permissions.test.mjs
 *
 * 回归：Codex runner 不能只注册 PromptCut MCP server。全局审批策略是 never，所以还
 * 必须显式列出可见工具并只对这个 server 免批，否则调用会在 Codex 本地直接失败。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tools } from '../mcp-tools.mjs';
import { buildCodexArgs } from '../runners/codex.mjs';

test('Codex 启动参数逐个放行 PromptCut 工具并免批 MCP，不放宽 shell 沙箱', () => {
  const argv = buildCodexArgs({
    cwd: 'C:\\project',
    mcp: { command: 'node', args: ['mcp-server.mjs'], env: { PROMPTCUT_PORT: '5195' } },
  });

  assert.ok(argv.includes(
    `mcp_servers.promptcut.enabled_tools=${JSON.stringify(tools.map(t => t.name))}`,
  ));
  assert.ok(argv.includes('mcp_servers.promptcut.default_tools_approval_mode="approve"'));

  // 这里绝不能偷偷引入全局放权或关闭沙箱。
  assert.ok(argv.includes('read-only'));
  assert.ok(argv.includes('approval_policy="never"'));
  assert.ok(argv.every(v => !v.includes('dangerously-bypass')));
});
