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

test('每个 browser 工具要么在路由表里,要么在表外特殊分支的名单里', () => {
  const handled = new Set([...routed, ...SPECIAL_TOOLS]);
  const missing = browserTools.filter((n) => !handled.has(n));
  assert.deepEqual(missing, [], `没登记的工具：${missing.join('、')}`);
});

test('路由表里没有工具表中不存在的名字', () => {
  const declared = new Set(mcpTools.map((t) => t.name));
  const orphans = routed.filter((n) => !declared.has(n));
  assert.deepEqual(orphans, [], `路由表里多出来的名字：${orphans.join('、')}`);
});

test('表外特殊分支的名单里也没有工具表中不存在的名字', () => {
  const declared = new Set(mcpTools.map((t) => t.name));
  const orphans = SPECIAL_TOOLS.filter((n) => !declared.has(n));
  assert.deepEqual(orphans, [], `特殊分支名单里多出来的名字：${orphans.join('、')}`);
});

test('路由表和特殊分支不重叠,而且都只放 browser 侧的工具', () => {
  const dup = routed.filter((n) => SPECIAL_TOOLS.includes(n));
  assert.deepEqual(dup, [], '同一个工具不能既查表又走特殊分支');
  const browser = new Set(browserTools);
  assert.deepEqual([...routed, ...SPECIAL_TOOLS].filter((n) => !browser.has(n)), [], 'server 侧的工具不经过编辑台');
});

/**
 * 路由表里的方法名必须真的在 EditorApi 上。routes.mjs 是纯数据的 .mjs(为了让本测试能
 * 直接 import),TypeScript 只看得到它的 .d.mts 声明,看不到里面写了什么字符串 ——
 * 方法名打错了编译不会报。所以这一条直接读 EditorApi 的声明来核。
 */
test('路由表里的每个方法名都在 EditorApi 上', () => {
  const start = EXECUTOR.indexOf('export interface EditorApi {');
  assert.ok(start >= 0, '找不到 EditorApi 的声明');
  const body = EXECUTOR.slice(start, EXECUTOR.indexOf('\n}', start));
  const declared = new Set([...body.matchAll(/^ {2}([A-Za-z][A-Za-z0-9_]*)\(/gm)].map((m) => m[1]));
  assert.ok(declared.size > 100, `EditorApi 只解析出 ${declared.size} 个方法,解析多半错了`);
  const bad = routed.filter((n) => !declared.has(TOOL_ROUTES[n].method));
  assert.deepEqual(bad, [], `方法名在 EditorApi 上不存在：${bad.map((n) => `${n} → ${TOOL_ROUTES[n].method}`).join('、')}`);
});

test('每项的 passArgs / awaited 都是布尔值', () => {
  const bad = routed.filter((n) => typeof TOOL_ROUTES[n].passArgs !== 'boolean' || typeof TOOL_ROUTES[n].awaited !== 'boolean');
  assert.deepEqual(bad, []);
});

/** 特殊分支是「有意留在表外」的,不是「忘了登记」。它们必须在执行器里真有自己的分支。 */
test('表外的特殊分支在执行器里都真的有接住的地方', () => {
  const missing = SPECIAL_TOOLS.filter((n) =>
    n.startsWith('web_')
      ? !EXECUTOR.includes(`case "${n}":`)
      : !EXECUTOR.includes(`tool === "${n}"`));
  assert.deepEqual(missing, [], `特殊分支名单里的工具在执行器里没有分支：${missing.join('、')}`);
  assert.ok(EXECUTOR.includes('tool.startsWith("web_")'), 'web_* 靠前缀分发,这一句没了八个网页工具就全掉了');
});

test('未知工具名的报错文案没变', () => {
  assert.ok(EXECUTOR.includes('throw new Error(`未知工具: ${tool}`)'), 'Agent 和测试都按这句文案认「这个工具不存在」');
});
