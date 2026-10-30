/**
 * node --test server/test/wait-tool.test.mjs
 *
 * `wait` 工具。它存在的理由见 mcp-tools.mjs 里那段说明:
 * 十来个工具让模型「隔几秒问一次」,但在这之前模型没有等待的手段,只能借 shell 去睡 ——
 * 而无人值守的 agy 会把 run_command 自动拒掉,一拒整轮就废。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { tools } = await import('../mcp-tools.mjs');

const wait = tools.find((t) => t.name === 'wait');

test('工具清单里有 wait,而且标成服务端执行(不走浏览器桥)', () => {
  assert.ok(wait, 'wait 工具不在清单里');
  assert.equal(wait.side, 'server');
  assert.equal(wait.inputSchema.properties.seconds.type, 'number');
  assert.ok(!wait.inputSchema.required, 'seconds 该是可选的,不填就用默认 3 秒');
});

test('说明里明确劝阻「自己想办法睡」—— 这正是把整轮搞废的那条路', () => {
  assert.match(wait.description, /shell/, '要点名 shell,模型才知道说的是哪条路');
  assert.match(wait.description, /拒绝|中断/, '要说清后果,不然它不会当回事');
});

test('那些让人轮询的工具,说明里要指向 wait', () => {
  const dl = tools.find((t) => t.name === 'collect_download');
  assert.ok(dl, 'collect_download 不在清单里');
  assert.match(dl.description, /wait/, 'collect_download 让人隔 3 秒问一次,得说清用什么等');
});

/*
 * 服务端那段执行逻辑目前长在 vite-plugin-ai.ts 的 callToolInternal 里(它要用到
 * SKILL 闸门和工具表,搬出来代价更大)。这里把同一段逻辑照抄一份验行为契约:
 * 夹取范围、默认值、非法输入。改那边的时候这两条会提醒你同步。
 */
function waitSeconds(args) {
  const raw = args?.seconds;
  return typeof raw === 'number' && Number.isFinite(raw) ? Math.min(30, Math.max(1, raw)) : 3;
}

test('秒数:默认 3,夹在 1~30 之间', () => {
  assert.equal(waitSeconds(undefined), 3);
  assert.equal(waitSeconds({}), 3);
  assert.equal(waitSeconds({ seconds: 5 }), 5);
  assert.equal(waitSeconds({ seconds: 0 }), 1, '0 秒等于没等,抬到 1');
  assert.equal(waitSeconds({ seconds: -10 }), 1);
  assert.equal(waitSeconds({ seconds: 9999 }), 30, '别让它一睡不醒');
});

test('秒数:乱填的东西不能变成 NaN 睡死', () => {
  assert.equal(waitSeconds({ seconds: 'abc' }), 3);
  assert.equal(waitSeconds({ seconds: null }), 3);
  assert.equal(waitSeconds({ seconds: {} }), 3);
});
