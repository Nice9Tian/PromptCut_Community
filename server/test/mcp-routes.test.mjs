/**
 * 路由表(src/mcp/routes.mjs)和工具表(server/mcp-tools.mjs)的对账。
 *
 * 加一个 MCP 工具要在三处登记:工具表的 schema、这张路由表、src/mcp/handlers 的实现。
 * 后两处缺了会编译失败(EditorApi 拼不齐 / 方法名对不上),**工具表和路由表对不上却不会** ——
 * 它只在模型真的去调那个工具时报一句「未知工具」,那时候一次任务已经跑废了。
 * 上一次重构就是这样丢过两个工具。这里两边都钉死:多一个少一个当场失败。
 *
 * 跑法:node --test server/test/mcp-routes.test.mjs
 */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tools as mcpTools } from '../mcp-tools.mjs';
import { TOOL_ROUTES, SPECIAL_TOOLS } from '../../src/mcp/routes.mjs';

const EXECUTOR = readFileSync(new URL('../../src/ai/mcpExecutor.ts', import.meta.url), 'utf8');
// 页面执行器接得住的工具:side 为 page(只在页面)与 agent(有项目副本时在 Agent 服务端执行,没有时照旧经页面;C6.5 D1)
const browserTools = mcpTools.filter((t) => t.side === 'page' || t.side === 'agent').map((t) => t.name);
const routed = Object.keys(TOOL_ROUTES);

test('Every browser tool is either in the route table or in the list of special branches outside the table', () => {
  const handled = new Set([...routed, ...SPECIAL_TOOLS]);
  const missing = browserTools.filter((n) => !handled.has(n));
  assert.deepEqual(missing, [], `Unregistered tools: ${missing.join(', ')}`);
});

test('The route table has no names that do not exist in the tool table', () => {
  const declared = new Set(mcpTools.map((t) => t.name));
  const orphans = routed.filter((n) => !declared.has(n));
  assert.deepEqual(orphans, [], `Extra names in the route table: ${orphans.join(', ')}`);
});

test('The list of special branches outside the table also has no names that do not exist in the tool table', () => {
  const declared = new Set(mcpTools.map((t) => t.name));
  const orphans = SPECIAL_TOOLS.filter((n) => !declared.has(n));
  assert.deepEqual(orphans, [], `Extra names in the special-branch list: ${orphans.join(', ')}`);
});

test('The route table and the special branches do not overlap, and both hold only browser-side tools', () => {
  const dup = routed.filter((n) => SPECIAL_TOOLS.includes(n));
  assert.deepEqual(dup, [], 'The same tool cannot both use the table and take a special branch');
  const browser = new Set(browserTools);
  assert.deepEqual([...routed, ...SPECIAL_TOOLS].filter((n) => !browser.has(n)), [], 'Server-side tools do not go through the editor');
});

/**
 * 路由表里的方法名必须真的在 EditorApi 上。routes.mjs 是纯数据的 .mjs(为了让本测试能
 * 直接 import),TypeScript 只看得到它的 .d.mts 声明,看不到里面写了什么字符串 ——
 * 方法名打错了编译不会报。所以这一条直接读 EditorApi 的声明来核。
 */
test('Every method name in the route table exists on EditorApi', () => {
  const start = EXECUTOR.indexOf('export interface EditorApi {');
  assert.ok(start >= 0, 'Cannot find the declaration of EditorApi');
  const body = EXECUTOR.slice(start, EXECUTOR.indexOf('\n}', start));
  const declared = new Set([...body.matchAll(/^ {2}([A-Za-z][A-Za-z0-9_]*)\(/gm)].map((m) => m[1]));
  assert.ok(declared.size > 100, `Only ${declared.size} methods were parsed from EditorApi, so the parsing is probably wrong`);
  const bad = routed.filter((n) => !declared.has(TOOL_ROUTES[n].method));
  assert.deepEqual(bad, [], `Method names that do not exist on EditorApi: ${bad.map((n) => `${n} → ${TOOL_ROUTES[n].method}`).join(', ')}`);
});

test('passArgs / awaited of every entry are booleans', () => {
  const bad = routed.filter((n) => typeof TOOL_ROUTES[n].passArgs !== 'boolean' || typeof TOOL_ROUTES[n].awaited !== 'boolean');
  assert.deepEqual(bad, []);
});

/** 特殊分支是「有意留在表外」的,不是「忘了登记」。它们必须在执行器里真有自己的分支。 */
test('Every special branch outside the table has a place in the executor that actually handles it', () => {
  const missing = SPECIAL_TOOLS.filter((n) =>
    n.startsWith('web_')
      ? !EXECUTOR.includes(`case "${n}":`)
      : !EXECUTOR.includes(`tool === "${n}"`));
  assert.deepEqual(missing, [], `Tools in the special-branch list that have no branch in the executor: ${missing.join(', ')}`);
  assert.ok(EXECUTOR.includes('tool.startsWith("web_")'), 'web_* is dispatched by prefix; without this line all eight web tools would be lost');
});

test('The error message for an unknown tool name is unchanged', () => {
  assert.ok(EXECUTOR.includes('throw new Error(trText("Unknown tool: {0}", tool))'), 'The Agent and the tests both rely on this message text to recognize "this tool does not exist"');
});
