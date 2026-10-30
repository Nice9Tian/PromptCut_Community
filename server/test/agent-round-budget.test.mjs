/**
 * 两道通用闸(2026-10-24 用户定,起因见 docs/plan/agent-blind-stop.md):
 *
 * 1. **轮次预算提示**:屏幕上的「第 N/M 轮」不进模型上下文,模型于是按「时间无限」干活 ——
 *    一次实跑里它把一张卡的源码打磨了 18 轮,`create_card` 一次没调到就撞上限,时间轴是空的。
 *    过半和只剩四分之一时各提醒一次。deepAuto 下一条都不发(那个开关的全部意思就是不跟模型谈轮次)。
 * 2. **同一个工具 + 同一个错误连成串**:第 2 次给硬提示,第 3 次停。现有的重复操作检测按整轮指纹算,
 *    一轮里只要还有别的调用指纹就不同,拦不住「同一个能力反复要」。
 *
 * 断言都落在**模型看得见的那份上下文**(history)上,不落在 progress 事件上 —— 理由同 deep-auto.test.mjs。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent, failureKey } from '../harness/agent.mjs';

/** 永远只调工具、从不收尾:拿它把循环逼到上限。每轮 input 不同,免得撞上整轮重复检测 */
function neverStops(toolName = 'noop') {
  let n = 0;
  return { name: 'never', async *stream() {
    n++;
    yield { type: 'tool_use', id: `call_${n}`, name: toolName, input: { n } };
    yield { type: 'stop', reason: 'tool_use' };
  } };
}

const noopTool = {
  name: 'noop',
  inputSchema: { type: 'object', properties: { n: { type: 'number' } } },
  execute: async (input) => ({ ok: true, seq: input.n }),
};

/** 永远用同一个代号失败的工具:模拟「这个能力这次拿不到」 */
const deadTool = {
  name: 'see_frames',
  inputSchema: { type: 'object', properties: { n: { type: 'number' } } },
  execute: async () => ({ ok: false, code: 'media-fetch-failed', error: '这台云节点现在读不了项目素材的字节,重试也没用。' }),
};

const userText = (history) => history
  .filter((m) => m.role === 'user')
  .flatMap((m) => m.content.filter((b) => b.type === 'text').map((b) => b.text))
  .join('\n');

async function run(opts, tools = [noopTool], provider = neverStops()) {
  const events = [];
  const agent = new Agent({ provider, system: 's', tools, onEvent: (e) => events.push(e), ...opts });
  const out = await agent.run('一直做');
  return { out, events, text: userText(out.history.get()) };
}

const count = (text, re) => (text.match(re) ?? []).length;

// ── 轮次预算提示 ───────────────────────────────────────────────

test('过半和只剩四分之一时各提醒一次,各只发一次', async () => {
  const { text } = await run({ maxIterations: 8 });
  // 8 轮:过半线是剩 4 轮(第 4 轮末),四分之一线是剩 2 轮(第 6 轮末)
  assert.match(text, /还剩 4 轮模型往返/);
  assert.match(text, /只剩 2 轮模型往返了/);
  assert.equal(count(text, /还剩 \d+ 轮模型往返/g), 1, '过半那条只发一次');
  assert.equal(count(text, /只剩 \d+ 轮模型往返了/g), 1, '四分之一那条只发一次');
  assert.match(text, /先把能交付的最小版本真正落到项目里/);
  assert.match(text, /代码块里的卡片源码 → create_card → add_clip/);
});

test('预算提示不写在最后一轮:那一轮本来就要收尾', async () => {
  const { out, text } = await run({ maxIterations: 4 });
  assert.equal(out.outcome, 'round_limit');
  // 4 轮:过半线剩 2 轮(第 2 轮末)、四分之一线剩 1 轮(第 3 轮末);第 4 轮末 left 为 0,不提
  assert.match(text, /还剩 2 轮模型往返/);
  assert.match(text, /只剩 1 轮模型往返了/);
  assert.match(text, /已达到 4 轮模型往返上限/);
});

test('深度自主:一条预算提示都不发,上下文里不出现轮次字样', async () => {
  const { out, text } = await run({ maxIterations: 8, deepAuto: true });
  assert.equal(out.outcome, 'round_limit');
  assert.doesNotMatch(text, /轮/, 'deepAuto 的全部意思就是不跟模型谈轮次');
});

test('不限轮次:没有分母可算,不发预算提示', async () => {
  let rounds = 0;
  const ac = new AbortController();
  const provider = { name: 'never', async *stream() {
    if (++rounds >= 12) ac.abort();
    yield { type: 'tool_use', id: `c${rounds}`, name: 'noop', input: { n: rounds } };
    yield { type: 'stop', reason: 'tool_use' };
  } };
  const agent = new Agent({ provider, system: 's', tools: [noopTool], maxIterations: Infinity, signal: ac.signal, onEvent: () => {} });
  await assert.rejects(() => agent.run('一直做'), (e) => e.name === 'AbortError');
  assert.doesNotMatch(userText(agent.history.get()), /轮模型往返/);
});

// ── 同一个工具 + 同一个错误连成串 ──────────────────────────────

test('连续 2 次同一个错误:给硬提示,点名这个能力这次拿不到,并给出两条路', async () => {
  const { text } = await run({ maxIterations: 2 }, [deadTool], neverStops('see_frames'));
  assert.match(text, /see_frames 带着同一个错误连续失败 2 次了/);
  assert.match(text, /不要再用同样的参数调第 3 次/);
  assert.match(text, /硬前提/, '要指回提示词里那张决策表的判据');
  assert.match(text, /report_progress/);
  assert.match(text, /读不了项目素材的字节/, '原话要带上,模型才知道是哪个毛病');
});

test('连续 3 次同一个错误:直接停,停下的原因点名那个工具', async () => {
  const { out } = await run({ maxIterations: 20 }, [deadTool], neverStops('see_frames'));
  assert.equal(out.outcome, 'stalled');
  assert.match(out.text, /see_frames 带着同一个错误连续失败 3 次/);
  assert.equal(out.failed, 3, '第 3 次之后就不再往下调了');
});

test('中间成功过一次就不算连着:不发硬提示、不停', async () => {
  // 失败、失败、成功、失败:第 2 轮发一次硬提示,之后清零,不该停
  const script = [false, false, true, false, true, true];
  let n = 0;
  const flaky = {
    name: 'see_frames',
    inputSchema: { type: 'object', properties: { n: { type: 'number' } } },
    execute: async () => (script[n++] ? { ok: true } : { ok: false, code: 'media-fetch-failed', error: '读不了' }),
  };
  const { out } = await run({ maxIterations: 6 }, [flaky], neverStops('see_frames'));
  assert.equal(out.outcome, 'round_limit', '不该被当成无效重试停掉');
});

test('两次失败的毛病不一样:不算连着', async () => {
  let n = 0;
  const twoFaults = {
    name: 'see_frames',
    inputSchema: { type: 'object', properties: { n: { type: 'number' } } },
    execute: async () => ({ ok: false, code: n++ === 0 ? 'media-fetch-failed' : 'asset-missing', error: 'x' }),
  };
  const { out, text } = await run({ maxIterations: 2 }, [twoFaults], neverStops('see_frames'));
  assert.equal(out.outcome, 'round_limit');
  assert.doesNotMatch(text, /连续失败 2 次/);
});

test('失败的身份:优先用代号,没代号退回报错文字,两者都没有算 unknown', () => {
  assert.equal(failureKey('t', { ok: false, code: 'c1', error: 'e' }), 't\u0000c1');
  assert.equal(failureKey('t', { ok: false, error: '缺少必填参数 x' }), 't\u0000缺少必填参数 x');
  assert.notEqual(failureKey('t', { error: '缺少必填参数 x' }), failureKey('t', { error: '缺少必填参数 y' }), '带具体参数的报错本来就该算不同的毛病');
  assert.equal(failureKey('t', 'plain text'), 't\u0000plain text');
  assert.equal(failureKey('t', null), 't\u0000unknown');
  assert.notEqual(failureKey('a', { code: 'c' }), failureKey('b', { code: 'c' }), '不同工具不是同一个毛病');
});
