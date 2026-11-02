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

function okStream(text = 'OK') {
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

test('hitting this 400: resend unchanged, it succeeds once it lands on a good route, and the request content is not changed at all', async () => {
  const { sent, text } = await run({ responses: [errRes(400, REJECT), okStream('OK')] });
  assert.equal(sent.length, 2, 'it should have been resent once');
  assert.deepEqual(sent[1], sent[0], 'the resend must be **the same request**: switching routes relies on the resend itself, not on changing the content');
  assert.equal(sent[1].reasoning_effort, 'high', 'keep the thinking effort, it is fine on the right upstream');
  assert.equal(text, 'OK');
});

test('hitting a bad route several times in a row does not give up, until a good one is reached', async () => {
  const { sent, text } = await run({
    responses: [errRes(400, REJECT), errRes(400, REJECT), okStream('the third time worked')],
  });
  assert.equal(sent.length, 3);
  assert.ok(sent.every((b) => b.reasoning_effort === 'high'), 'every attempt is sent exactly as is');
  assert.equal(text, 'the third time worked');
});

test('all routes are bad: as a last resort step back and drop the thinking effort, so the whole chat is not left in an error state', async () => {
  const { sent, text } = await run({
    responses: [errRes(400, REJECT), errRes(400, REJECT), errRes(400, REJECT), errRes(400, REJECT), okStream('it worked after the downgrade')],
  });
  const last = sent[sent.length - 1];
  assert.equal('reasoning_effort' in last, false, 'the thinking effort is dropped only on the last attempt');
  assert.ok(last.tools?.length, 'what gives way is the thinking effort, not the tools: without tools the agent can do nothing');
  assert.ok(sent.slice(0, -1).every((b) => b.reasoning_effort === 'high'), 'every earlier attempt first tried the unchanged request');
  assert.equal(text, 'it worked after the downgrade');
});

test('no memory: the next round still tries with the thinking effort first, since one bad route should not turn it off permanently', async () => {
  await run({ responses: [errRes(400, REJECT), okStream()] });
  const second = await run({ responses: [okStream('Second round')] });
  assert.equal(second.sent.length, 1);
  assert.equal(second.sent[0].reasoning_effort, 'high', 'it must not be left out just because the previous round hit it');
});

test('other 400s are reported as usual, with no silent resend', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return errRes(400, JSON.stringify({ error: { message: 'model not found' } })); };
  const p = createProvider(
    { apiKey: 'k', model: 'gpt-5.6-terra', effort: 'high', baseUrl: 'https://relay.example/v1' },
    { fetchImpl },
  );
  await assert.rejects(
    async () => { for await (const _ of p.stream([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], TOOLS, '', undefined)) { /* drain */ } },
    /model not found/,
    'the body has already been read once, and the original text must not be lost because of that',
  );
  assert.equal(calls, 1, 'if it is not that cause, it should not be resent');
});

test('when no thinking effort is selected it is not sent anyway, so this never happens', async () => {
  const { sent } = await run({ effort: '', responses: [okStream()] });
  assert.equal(sent.length, 1);
  assert.equal('reasoning_effort' in sent[0], false);
});

test('this path is not taken when there are no tools, since such a 400 has another cause', async () => {
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
