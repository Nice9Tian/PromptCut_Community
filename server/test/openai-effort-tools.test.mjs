/**
 * node --test server/test/openai-effort-tools.test.mjs
 *
 * 「Function tools with reasoning_effort are not supported for gpt-5.6-terra」这条 400。
 *
 * **它是路由问题,不是模型能力问题。**中转站的账单页把这一点说死了:
 *
 *   01:00:04  分组 Openai-Gpt-2  gpt-5.6-terra  错误  0 tokens  $0.000000
 *   01:00:43  分组 Codex-Gpt-1   gpt-5.6-terra  成功  18s       $0.001894
 *
 * 同一个模型名、同一个请求(后一次是用户手动重发的,内容一个字没改),落到不同上游,
 * 一个不吃一个吃。所以对策是**原样重发去碰另一条路由** —— 而不是改请求、更不是
 * 记住「这个模型不支持」(那等于凭一次坏运气把思考档永久关掉)。
 *
 * 重发几乎免费:被拒那次是 0 tokens、$0.000000、1 秒返回。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { createProvider } = await import('../harness/providers/openai.mjs');

const REJECT = JSON.stringify({
  error: {
    message: "Function tools with reasoning_effort are not supported for gpt-5.6-terra in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.",
  },
});

function okStream(text = '好的') {
  return {
    ok: true, status: 200,
    headers: { get: () => 'text/event-stream' },
    body: (async function* () {
      yield `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
      yield `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`;
      yield 'data: [DONE]\n\n';
    })(),
  };
}

const errRes = (status, payload) => ({ ok: false, status, headers: { get: () => null }, text: async () => payload });

const TOOLS = [{ name: 'get_project', description: 'x', inputSchema: { type: 'object', properties: {} } }];

/** 跑一次;`responses` 是每次请求依次返回什么(不够就一直用最后一个) */
async function run({ effort = 'high', tools = TOOLS, responses }) {
  const sent = [];
  let n = 0;
  const fetchImpl = async (url, init) => {
    sent.push(JSON.parse(init.body));
    const r = responses[Math.min(n, responses.length - 1)];
    n++;
    return typeof r === 'function' ? r() : r;
  };
  const p = createProvider(
    { apiKey: 'k', model: 'gpt-5.6-terra', effort, baseUrl: 'https://relay.example/v1' },
    { fetchImpl },
  );
  let text = '';
  for await (const ev of p.stream([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools, '', undefined)) {
    if (ev.type === 'text_delta') text += ev.text;
  }
  return { sent, text };
}

test('撞上这条 400:原样重发,碰到好路由就成 —— 请求内容一个字都不改', async () => {
  const { sent, text } = await run({ responses: [errRes(400, REJECT), okStream('好的')] });
  assert.equal(sent.length, 2, '应该重发了一次');
  assert.deepEqual(sent[1], sent[0], '重发的必须是**同一个请求**:换路由靠的是重发本身,不是改内容');
  assert.equal(sent[1].reasoning_effort, 'high', '思考档要留着 —— 它在对的上游上是好的');
  assert.equal(text, '好的');
});

test('坏路由连撞几次也不放弃,一直到碰上好的', async () => {
  const { sent, text } = await run({
    responses: [errRes(400, REJECT), errRes(400, REJECT), okStream('第三次成了')],
  });
  assert.equal(sent.length, 3);
  assert.ok(sent.every((b) => b.reasoning_effort === 'high'), '每一次都照原样发');
  assert.equal(text, '第三次成了');
});

test('几条路由全是坏的:最后退一步去掉思考档,别把整条对话红在那儿', async () => {
  const { sent, text } = await run({
    responses: [errRes(400, REJECT), errRes(400, REJECT), errRes(400, REJECT), errRes(400, REJECT), okStream('降级之后成了')],
  });
  const last = sent[sent.length - 1];
  assert.equal('reasoning_effort' in last, false, '最后那次才去掉思考档');
  assert.ok(last.tools?.length, '让步的是思考档,不是工具 —— 工具没了 agent 什么都做不成');
  assert.ok(sent.slice(0, -1).every((b) => b.reasoning_effort === 'high'), '之前每次都先试原样');
  assert.equal(text, '降级之后成了');
});

test('不记忆:下一轮照样先带思考档去试 —— 一次坏路由不该永久关掉它', async () => {
  await run({ responses: [errRes(400, REJECT), okStream()] });
  const second = await run({ responses: [okStream('第二轮')] });
  assert.equal(second.sent.length, 1);
  assert.equal(second.sent[0].reasoning_effort, 'high', '不许因为上一轮撞过就不带了');
});

test('别的 400 照常报错,不许悄悄重发', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return errRes(400, JSON.stringify({ error: { message: 'model not found' } })); };
  const p = createProvider(
    { apiKey: 'k', model: 'gpt-5.6-terra', effort: 'high', baseUrl: 'https://relay.example/v1' },
    { fetchImpl },
  );
  await assert.rejects(
    async () => { for await (const _ of p.stream([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], TOOLS, '', undefined)) { /* drain */ } },
    /model not found/,
    '正文已经被读过一次,原文不能因此丢掉',
  );
  assert.equal(calls, 1, '不是那个原因就不该重发');
});

test('没选思考档时本来就不带,也就没有这一出', async () => {
  const { sent } = await run({ effort: '', responses: [okStream()] });
  assert.equal(sent.length, 1);
  assert.equal('reasoning_effort' in sent[0], false);
});

test('没有工具时不走这条路 —— 那种 400 是别的原因', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return errRes(400, REJECT); };
  const p = createProvider(
    { apiKey: 'k', model: 'gpt-5.6-terra', effort: 'high', baseUrl: 'https://relay.example/v1' },
    { fetchImpl },
  );
  await assert.rejects(async () => {
    for await (const _ of p.stream([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], [], '', undefined)) { /* drain */ }
  });
  assert.equal(calls, 1);
});
