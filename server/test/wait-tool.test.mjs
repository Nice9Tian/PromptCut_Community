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

test('The tool manifest has wait, and it is marked as server-side execution (not through the browser bridge)', () => {
  assert.ok(wait, 'The wait tool is not in the manifest');
  assert.equal(wait.side, 'server');
  assert.equal(wait.inputSchema.properties.seconds.type, 'number');
  assert.ok(!wait.inputSchema.required, 'seconds should be optional, defaulting to 3 seconds when omitted');
});

test('The description explicitly discourages "finding your own way to sleep": that is exactly the path that wrecks the whole round', () => {
  assert.match(wait.description, /shell/, 'It must name shell so the model knows which path is meant');
  assert.match(wait.description, /reject|interrupt/, 'The consequences must be spelled out, otherwise it will not take it seriously');
});

test('Tools that make the caller poll must point to wait in their description', () => {
  const dl = tools.find((t) => t.name === 'collect_download');
  assert.ok(dl, 'collect_download is not in the manifest');
  assert.match(dl.description, /wait/, 'collect_download makes the caller ask every 3 seconds, so it must say what to wait with');
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

test('Seconds: default 3, clamped to 1~30', () => {
  assert.equal(waitSeconds(undefined), 3);
  assert.equal(waitSeconds({}), 3);
  assert.equal(waitSeconds({ seconds: 5 }), 5);
  assert.equal(waitSeconds({ seconds: 0 }), 1, '0 seconds is the same as not waiting, raised to 1');
  assert.equal(waitSeconds({ seconds: -10 }), 1);
  assert.equal(waitSeconds({ seconds: 9999 }), 30, 'Do not let it sleep forever');
});

test('Seconds: garbage input must not turn into NaN and sleep forever', () => {
  assert.equal(waitSeconds({ seconds: 'abc' }), 3);
  assert.equal(waitSeconds({ seconds: null }), 3);
  assert.equal(waitSeconds({ seconds: {} }), 3);
});
