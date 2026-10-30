/**
 * 「深度自主」：轮次上限放宽，且不给模型任何关于轮次的话。
 *
 * 这里盯住的是**模型看得见的那份上下文**。屏幕上显示第几轮是好事，但同一句话
 * 一旦进了 history，模型就会替自己算预算、提前草草收工 —— 而这正是开这个开关
 * 想避免的。所以断言都落在 history 上，不落在 progress 事件上。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Agent } from '../harness/agent.mjs';

/** 一个永远只调工具、从不收尾的模型：拿它把循环逼到上限 */
function neverStops() {
  let n = 0;
  return { name: 'never', async *stream() {
    n++;
    yield { type: 'tool_use', id: `call_${n}`, name: 'noop', input: { n } };
    yield { type: 'stop', reason: 'tool_use' };
  } };
}

/** 每次返回都不一样，免得撞上「重复操作」检测，那会在到上限之前就把循环停掉 */
const noopTool = {
  name: 'noop',
  inputSchema: { type: 'object', properties: { n: { type: 'number' } } },
  execute: async (input) => ({ ok: true, seq: input.n }),
};

async function runTo(limitOpts) {
  const events = [];
  const agent = new Agent({
    provider: neverStops(),
    system: 's',
    tools: [noopTool],
    onEvent: (e) => events.push(e),
    ...limitOpts,
  });
  const out = await agent.run('一直做');
  return { out, events, history: out.history.get() };
}

/** 模型手里那份上下文里，所有 user 文本拼成一串 */
const userText = (history) => history
  .filter((m) => m.role === 'user')
  .flatMap((m) => m.content.filter((b) => b.type === 'text').map((b) => b.text))
  .join('\n');

test('常规模式：到上限时明确告诉模型「已达到 N 轮上限」', async () => {
  const { out, history } = await runTo({ maxIterations: 3 });
  assert.equal(out.outcome, 'round_limit');
  assert.match(userText(history), /已达到 3 轮模型往返上限/);
});

test('深度自主：到上限照样收尾，但那句话里不出现轮数', async () => {
  const { out, history } = await runTo({ maxIterations: 3, deepAuto: true });
  assert.equal(out.outcome, 'round_limit', '仍然要停下来并让模型总结，不能闷头返回空结果');
  const text = userText(history);
  assert.match(text, /本次运行已到上限/);
  assert.doesNotMatch(text, /轮/, '模型上下文里不该出现任何轮次字样');
  assert.doesNotMatch(text, /3/, '更不能把具体的上限数字告诉它');
});

test('深度自主的上限是真放宽了，不是还按常规 48 轮跑', async () => {
  const { out } = await runTo({ maxIterations: 40, deepAuto: true });
  // 40 轮才触顶：说明 maxIterations 真的被用上了，而不是构造函数的默认值
  assert.equal(out.outcome, 'round_limit');
  assert.equal(out.completed, 40, '每一轮执行一次 noop，应该正好做满 40 次');
});

test('屏幕上的进度还是要有轮次；不限轮次时不写分母', async () => {
  const { events } = await runTo({ maxIterations: 3, deepAuto: true });
  const req = events.find((e) => e.type === 'progress' && e.phase === 'requesting');
  assert.match(req.text, /第 1\/3 轮/, '有上限时分子分母都给用户看');

  const infinite = [];
  const agent = new Agent({
    provider: { name: 'once', async *stream() { yield { type: 'text_delta', text: '好' }; yield { type: 'stop', reason: 'end_turn' }; } },
    system: 's', tools: [noopTool], maxIterations: Infinity, deepAuto: true,
    onEvent: (e) => infinite.push(e),
  });
  await agent.run('随便');
  const first = infinite.find((e) => e.type === 'progress' && e.phase === 'requesting');
  assert.match(first.text, /第 1 轮/);
  assert.doesNotMatch(first.text, /Infinity|\//, '不限轮次时别写出 Infinity，也别留个空分母');
});

test('不限轮次时循环没有终点：模型不收尾就一直跑，只有停止能拦下它', async () => {
  const ac = new AbortController();
  let rounds = 0;
  const agent = new Agent({
    provider: { name: 'never', async *stream() {
      // 跑够 60 轮就当作「已经远远越过 48 这个常规上限」，然后模拟用户点停止
      if (++rounds >= 60) ac.abort();
      yield { type: 'tool_use', id: `c${rounds}`, name: 'noop', input: { n: rounds } };
      yield { type: 'stop', reason: 'tool_use' };
    } },
    system: 's', tools: [noopTool], maxIterations: Infinity, deepAuto: true,
    signal: ac.signal,
    onEvent: () => {},
  });
  await assert.rejects(() => agent.run('一直做'), (e) => e.name === 'AbortError');
  assert.ok(rounds >= 60, `不限轮次下应该一路跑过常规的 48 轮，实际只跑了 ${rounds}`);
});

// ── 「自主轮次」这个设置项本身 ──────────────────────────────────
// 0 是有意义的取值(不限),所以下界必须是 0 —— 一旦有人顺手写成 `v < 1`,
// 用户在设置里填 0 会被当成非法值退回去,而界面上明写着 0 表示不限。

async function withConfig(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-deep-'));
  const file = path.join(dir, 'ai.json');
  const previous = process.env.PROMPTCUT_AI_CONFIG;
  process.env.PROMPTCUT_AI_CONFIG = file;
  try {
    const mod = await import(`../ai-config.mjs?deep=${encodeURIComponent(file)}`);
    await fn(mod);
  } finally {
    if (previous === undefined) delete process.env.PROMPTCUT_AI_CONFIG;
    else process.env.PROMPTCUT_AI_CONFIG = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('自主轮次:默认 300,老配置里没有这个字段也补得上', async () => {
  await withConfig(async ({ publicConfig }) => {
    assert.equal(publicConfig().deepAutoRounds, 300);
  });
});

test('自主轮次:0 是合法的(表示不限),负数和超大值不是', async () => {
  await withConfig(async ({ writeConfig, publicConfig }) => {
    writeConfig({ deepAutoRounds: 0 });
    assert.equal(publicConfig().deepAutoRounds, 0);
    writeConfig({ deepAutoRounds: 1000 });
    assert.equal(publicConfig().deepAutoRounds, 1000);
    assert.throws(() => writeConfig({ deepAutoRounds: -1 }), /0~100000/);
    assert.throws(() => writeConfig({ deepAutoRounds: 100001 }), /0~100000/);
    assert.throws(() => writeConfig({ deepAutoRounds: 'many' }), /0~100000/);
    assert.equal(publicConfig().deepAutoRounds, 1000, '非法值不该把已存的改掉');
  });
});
