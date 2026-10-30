/**
 * agy 的 MCP 登记是全局的:登记里不能写死端口,否则同一份代码的两个实例(不同端口)会互相踩,
 * agy 的工具调用一直打到已经关掉、或者被别的程序占着的端口上。端口改由每次起 agy 时的环境变量带。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mcpAddArgs } from '../runners/agy.mjs';

test('登记命令里没有端口:只有名字、node、脚本', () => {
  const args = mcpAddArgs({ command: 'C:/node.exe', args: ['C:/app/server/mcp-server.mjs'], env: { PROMPTCUT_PORT: '5198' } });
  assert.deepEqual(args, ['mcp', 'add', 'promptcut', 'C:/node.exe', 'C:/app/server/mcp-server.mjs']);
  assert.ok(!args.includes('-e') && !args.some((a) => /PROMPTCUT_PORT|5198/.test(a)));
});
