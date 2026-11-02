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
  const out = await agent.run('Keep going');
  return { out, events, history: out.history.get() };
}

/** 模型手里那份上下文里，所有 user 文本拼成一串 */
const userText = (history) => history
  .filter((m) => m.role === 'user')
  .flatMap((m) => m.content.filter((b) => b.type === 'text').map((b) => b.text))
  .join('\n');

test('Normal mode: when the limit is reached, explicitly tell the model "the limit of N rounds has been reached"', async () => {
  const { out, history } = await runTo({ maxIterations: 3 });
  assert.equal(out.outcome, 'round_limit');
  assert.match(userText(history), /Reached the limit of 3 model round trips/);
});

test('Deep autonomy: it still wraps up at the limit, but the message does not mention the number of rounds', async () => {
  const { out, history } = await runTo({ maxIterations: 3, deepAuto: true });
  assert.equal(out.outcome, 'round_limit', 'It must still stop and let the model summarize, not silently return an empty result');
  const text = userText(history);
  assert.match(text, /This run has reached its limit/);
  assert.doesNotMatch(text, /round/, 'No mention of rounds should appear in the model context');
  assert.doesNotMatch(text, /3/, 'The specific limit number certainly must not be disclosed to it');
});

test('The deep autonomy limit really is relaxed, not still running at the normal 48 rounds', async () => {
  const { out } = await runTo({ maxIterations: 40, deepAuto: true });
  // 40 轮才触顶：说明 maxIterations 真的被用上了，而不是构造函数的默认值
  assert.equal(out.outcome, 'round_limit');
  assert.equal(out.completed, 40, 'Running noop once per round should complete exactly 40 times');
});

test('The on-screen progress should still show the round; with no round limit, no denominator is written', async () => {
  const { events } = await runTo({ maxIterations: 3, deepAuto: true });
  const req = events.find((e) => e.type === 'progress' && e.phase === 'requesting');
  assert.match(req.text, /Round 1\/3/, 'With a limit, both numerator and denominator are shown to the user');

  const infinite = [];
  const agent = new Agent({
    provider: { name: 'once', async *stream() { yield { type: 'text_delta', text: 'OK' }; yield { type: 'stop', reason: 'end_turn' }; } },
    system: 's', tools: [noopTool], maxIterations: Infinity, deepAuto: true,
    onEvent: (e) => infinite.push(e),
  });
  await agent.run('whatever');
  const first = infinite.find((e) => e.type === 'progress' && e.phase === 'requesting');
  assert.match(first.text, /Round 1/);
  assert.doesNotMatch(first.text, /Infinity|\//, 'With no round limit, do not write Infinity, and do not leave an empty denominator');
});

test('With no round limit the loop has no end: if the model does not wrap up it just keeps running, and only stopping can halt it', async () => {
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
  await assert.rejects(() => agent.run('Keep going'), (e) => e.name === 'AbortError');
  assert.ok(rounds >= 60, `With no round limit it should run straight past the normal 48 rounds, but it only ran ${rounds}`);
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

test('Autonomous rounds: default 300, filled in even when an old config lacks this field', async () => {
  await withConfig(async ({ publicConfig }) => {
    assert.equal(publicConfig().deepAutoRounds, 300);
  });
});

test('Autonomous rounds: 0 is valid (meaning unlimited), negative numbers and huge values are not', async () => {
  await withConfig(async ({ writeConfig, publicConfig }) => {
    writeConfig({ deepAutoRounds: 0 });
    assert.equal(publicConfig().deepAutoRounds, 0);
    writeConfig({ deepAutoRounds: 1000 });
    assert.equal(publicConfig().deepAutoRounds, 1000);
    assert.throws(() => writeConfig({ deepAutoRounds: -1 }), /0 to 100000/);
    assert.throws(() => writeConfig({ deepAutoRounds: 100001 }), /0 to 100000/);
    assert.throws(() => writeConfig({ deepAutoRounds: 'many' }), /0 to 100000/);
    assert.equal(publicConfig().deepAutoRounds, 1000, 'An invalid value must not overwrite the stored one');
  });
});
