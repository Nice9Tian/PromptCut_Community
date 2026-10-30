/**
 * node --test server/test/gemini-provider.test.mjs
 *
 * Gemini 本家 provider 的几条契约。钉的都是**错了不报错**的那类:
 *
 *   - 思考档位以前一个字都没发。cfg.effort 从 runners/api.mjs 一路传进来,
 *     openai.mjs 发成 reasoning_effort,gemini.mjs 拿到手却整个丢掉 ——
 *     面板上那个思考档对 Gemini 是死的,选什么都一样,而且没有任何迹象。
 *   - 思考内容是「带 thought:true 的普通 text part」。判断顺序写反的话它会被
 *     text 分支劫走:模型的思考被当成正文播出去,而「在想什么」那栏一直空着。
 *   - functionResponse.response 协议上是 Struct(必须是对象)。以前一律 JSON.stringify
 *     拍成字符串,既多烧 token 又把嵌套抹平,模型得自己从字符串里再读一遍。
 *   - finishReason 是 MALFORMED_FUNCTION_CALL / SAFETY 时以前也 yield 'stop',
 *     上层就以为这轮正常讲完了 —— 界面上没有任何提示,要么原地不动,要么再起一轮转圈。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { createProvider } = await import('../harness/providers/gemini.mjs');

/** 把若干个 candidate 片段包成一条 Gemini SSE 流 */
function sse(...chunks) {
  return {
    ok: true, status: 200,
    headers: { get: () => 'text/event-stream' },
    body: (async function* () {
      for (const c of chunks) yield `data: ${JSON.stringify(c)}\n\n`;
    })(),
  };
}
const parts = (...p) => ({ candidates: [{ content: { parts: p } }] });
const finish = (reason) => ({ candidates: [{ finishReason: reason }] });
const err400 = (msg) => ({ ok: false, status: 400, headers: { get: () => null }, text: async () => JSON.stringify({ error: { message: msg } }) });

const userMsg = (text) => [{ role: 'user', content: [{ type: 'text', text }] }];

/** 跑一遍 stream,把事件和每次请求的 body 都收下来 */
async function run(cfg, { messages = userMsg('喂'), tools = [], responses } = {}) {
  const sent = [];
  let i = 0;
  const fetchImpl = async (_url, init) => {
    sent.push(JSON.parse(init.body));
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return typeof r === 'function' ? r() : r;
  };
  const provider = createProvider(cfg, { fetchImpl });
  const events = [];
  let threw = null;
  try {
    for await (const ev of provider.stream(messages, tools, '', undefined)) events.push(ev);
  } catch (e) {
    threw = e;
  }
  return { sent, events, threw };
}

const CFG = { model: 'gemini-3.1-pro', apiKey: 'k' };

/* ── 思考档位 ─────────────────────────────────────────────────── */

test('cfg.effort 要发成 thinkingConfig —— 以前这里一个字都没发', async () => {
  const { sent } = await run({ ...CFG, effort: 'high' }, { responses: [() => sse(parts({ text: '嗯' }))] });
  assert.deepEqual(sent[0].generationConfig.thinkingConfig, { thinkingLevel: 'high', includeThoughts: true });
});

test('没选思考档就别发这个字段,不要自作主张给个默认值', async () => {
  const a = await run({ ...CFG, effort: '' }, { responses: [() => sse(parts({ text: '嗯' }))] });
  assert.equal(a.sent[0].generationConfig.thinkingConfig, undefined);
  const b = await run(CFG, { responses: [() => sse(parts({ text: '嗯' }))] });
  assert.equal(b.sent[0].generationConfig.thinkingConfig, undefined);
});

test('档位原样透传,不换算成 token 预算', async () => {
  for (const lv of ['low', 'medium', 'high']) {
    const { sent } = await run({ ...CFG, effort: lv }, { responses: [() => sse(parts({ text: 'x' }))] });
    assert.equal(sent[0].generationConfig.thinkingConfig.thinkingLevel, lv);
    assert.equal(sent[0].generationConfig.thinkingBudget, undefined);
    assert.equal(sent[0].generationConfig.thinkingBudgetTokens, undefined);
  }
});

test('老模型不认 thinkingConfig 就去掉重发一次,别让一个下拉框打死整轮对话', async () => {
  const { sent, events, threw } = await run(
    { ...CFG, effort: 'high' },
    { responses: [() => err400('Unknown name "thinkingConfig"'), () => sse(parts({ text: '好的' }))] },
  );
  assert.equal(threw, null, '重发成功就不该抛');
  assert.equal(sent.length, 2, '要重发一次');
  assert.ok(sent[0].generationConfig.thinkingConfig, '第一次带着');
  assert.equal(sent[1].generationConfig.thinkingConfig, undefined, '第二次去掉');
  assert.deepEqual(sent[1].contents, sent[0].contents, '除了这个字段,别的一个字不改');
  assert.ok(events.some((e) => e.type === 'text_delta' && e.text === '好的'));
});

test('没发 thinkingConfig 时的 400 照常报错,不要白重发一次', async () => {
  const { sent, threw } = await run(CFG, { responses: [() => err400('无关的错误')] });
  assert.equal(sent.length, 1);
  assert.match(String(threw?.message), /gemini HTTP 400/);
});

/* ── 思考内容 ─────────────────────────────────────────────────── */

test('thought:true 的 part 走 thinking_delta,而且不能漏进正文', async () => {
  const { events } = await run(CFG, {
    responses: [() => sse(parts({ text: '我先想想', thought: true }, { text: '答案是 42' }))],
  });
  const think = events.filter((e) => e.type === 'thinking_delta').map((e) => e.text);
  const text = events.filter((e) => e.type === 'text_delta').map((e) => e.text);
  assert.deepEqual(think, ['我先想想'], '判断顺序写反的话这里会是空的');
  assert.deepEqual(text, ['答案是 42'], '思考不能被当成正文播出去');
});

test('事件类型必须是 thinking_delta —— agent.mjs 只认这个名字,别的会被静默丢掉', async () => {
  const { events } = await run(CFG, { responses: [() => sse(parts({ text: '想', thought: true }))] });
  const kinds = new Set(events.map((e) => e.type));
  assert.ok(kinds.has('thinking_delta'));
  assert.ok(!kinds.has('thought'), "不能叫 thought,上层不认识");
});

/* ── 工具调用的 id ─────────────────────────────────────────────── */

test('有官方 functionCall.id 就用它,没有才自己编号', async () => {
  const { events } = await run(CFG, {
    responses: [() => sse(parts(
      { functionCall: { id: 'call_abc', name: 'see_frames', args: { t: 1 } } },
      { functionCall: { name: 'list_cards', args: {} } },
    ))],
  });
  const calls = events.filter((e) => e.type === 'tool_use');
  assert.equal(calls[0].id, 'call_abc');
  assert.match(calls[1].id, /^gemini-call-\d+$/);
});

test('自己编的号在一条流里不会重复 —— agent.mjs 撞号会直接停掉整轮', async () => {
  const { events } = await run(CFG, {
    responses: [() => sse(parts(
      { functionCall: { name: 'see_frames', args: { t: 1 } } },
      { functionCall: { name: 'see_frames', args: { t: 2 } } },
      { functionCall: { name: 'see_frames', args: { t: 3 } } },
    ))],
  });
  const ids = events.filter((e) => e.type === 'tool_use').map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, `撞号了:${ids.join(', ')}`);
});

/* ── 工具结果回传 ─────────────────────────────────────────────── */

const withToolResult = (content, toolUseId = 'call_abc') => [
  { role: 'user', content: [{ type: 'text', text: '看一下' }] },
  { role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: 'see_frames', input: {} }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] },
];
const fnResp = (sent) => sent[0].contents.at(-1).parts[0].functionResponse;

test('结果本来是对象就原样发,别拍成一整条字符串', async () => {
  const { sent } = await run(CFG, {
    messages: withToolResult({ ok: true, notes: ['一', '二'], box: { w: 1920, h: 1080 } }),
    responses: [() => sse(parts({ text: '好' }))],
  });
  assert.deepEqual(fnResp(sent).response, { ok: true, notes: ['一', '二'], box: { w: 1920, h: 1080 } });
});

test('字符串 / 数组 / null 不是 Struct,仍然要包一层', async () => {
  for (const c of ['一段文字', ['a', 'b'], null]) {
    const { sent } = await run(CFG, { messages: withToolResult(c), responses: [() => sse(parts({ text: '好' }))] });
    assert.deepEqual(fnResp(sent).response, { result: c }, `content=${JSON.stringify(c)} 要包一层`);
  }
});

test('官方 id 回传,自己编的号不回传(发过去 Gemini 也不认识)', async () => {
  const real = await run(CFG, { messages: withToolResult({ ok: true }, 'call_abc'), responses: [() => sse(parts({ text: '好' }))] });
  assert.equal(fnResp(real.sent).id, 'call_abc');
  const fake = await run(CFG, { messages: withToolResult({ ok: true }, 'gemini-call-1'), responses: [() => sse(parts({ text: '好' }))] });
  assert.equal(fnResp(fake.sent).id, undefined);
});

test('functionResponse 的 name 从当轮的 tool_use 里查,别写死 unknown', async () => {
  const { sent } = await run(CFG, { messages: withToolResult({ ok: true }), responses: [() => sse(parts({ text: '好' }))] });
  assert.equal(fnResp(sent).name, 'see_frames');
});

/* ── 收尾 ─────────────────────────────────────────────────────── */

test('正常收尾照旧 yield stop', async () => {
  for (const reason of ['STOP', 'MAX_TOKENS']) {
    const { events, threw } = await run(CFG, { responses: [() => sse(parts({ text: 'x' }), finish(reason))] });
    assert.equal(threw, null, `${reason} 不该抛`);
    assert.equal(events.at(-1).type, 'stop');
    assert.equal(events.at(-1).reason, reason);
  }
});

test('异常收尾要抛出来,不能伪装成正常结束', async () => {
  for (const reason of ['MALFORMED_FUNCTION_CALL', 'SAFETY', 'RECITATION']) {
    const { threw } = await run(CFG, { responses: [() => sse(parts({ text: 'x' }), finish(reason))] });
    assert.ok(threw, `${reason} 被当成正常结束了`);
    assert.match(threw.message, new RegExp(reason));
  }
});

test('抛之前 usage 已经报出去了,别把这一轮的账丢掉', async () => {
  const { events } = await run(CFG, {
    responses: [() => sse(parts({ text: 'x' }), { usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 22 }, candidates: [{ finishReason: 'SAFETY' }] })],
  });
  const u = events.find((e) => e.type === 'usage');
  assert.deepEqual([u?.input, u?.output], [11, 22]);
});
