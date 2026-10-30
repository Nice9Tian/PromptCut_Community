/**
 * node --test server/test/openai-think-inline.test.mjs
 *
 * openai 兼容驱动:中转站把 `<think>…</think>` 内联在 content 里发回来时,
 * 它必须被拆到思考通道,而不是原样进正文。
 *
 * 这一条钉的是用户实际撞到的那个现象:聊天气泡里出现一个赤裸的 `</think>`。
 * 只测拆分器不够 —— 拆分器对了、没接进流循环也一样漏,所以这里从 provider 的
 * stream() 出口验。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { createProvider } = await import('../harness/providers/openai.mjs');

/** 把若干 SSE 数据块做成一个假的 fetch 响应 */
function fakeFetch(chunks) {
  return async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'text/event-stream' },
    body: (async function* () {
      for (const c of chunks) yield c;
    })(),
  });
}

/** 把一串 content 增量包成 SSE;最后带 finish_reason 收尾 */
function sseOf(deltas) {
  const out = deltas.map((d) => `data: ${JSON.stringify({ choices: [{ delta: { content: d } }] })}\n\n`);
  out.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
  out.push('data: [DONE]\n\n');
  return out;
}

async function collect(deltas) {
  const p = createProvider({ apiKey: 'k', model: 'm', baseUrl: 'https://x/v1' }, { fetchImpl: fakeFetch(sseOf(deltas)) });
  let text = '';
  let think = '';
  for await (const ev of p.stream([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], [], '', undefined)) {
    if (ev.type === 'text_delta') text += ev.text;
    else if (ev.type === 'thinking_delta') think += ev.text;
  }
  return { text, think };
}

test('内联的 <think> 走思考通道,正文里不留标签', async () => {
  const { text, think } = await collect([
    '<think>**Clarifying article link and scope**\n\n</think>\n\n我先确认素材收集环境。',
  ]);
  assert.equal(think, '**Clarifying article link and scope**\n\n');
  assert.equal(text, '\n\n我先确认素材收集环境。');
  assert.ok(!/<\/?think/.test(text), '正文里不能出现 think 标签');
});

test('标签被切在两个 SSE 包中间也要认出来 —— 流式下这是常态', async () => {
  const { text, think } = await collect(['前言<thi', 'nk>步骤一</thi', 'nk>后话']);
  assert.equal(text, '前言后话');
  assert.equal(think, '步骤一');
});

test('一条回复里多段 think:正文按顺序接起来', async () => {
  const { text, think } = await collect(['A<think>t1</think>B', '<think>t2</think>C']);
  assert.equal(text, 'ABC');
  assert.equal(think, 't1t2');
});

test('不带 think 的普通回复原样通过', async () => {
  const { text, think } = await collect(['你好,', '这是正文。']);
  assert.equal(text, '你好,这是正文。');
  assert.equal(think, '');
});

test('中转站用 reasoning_content 单独字段的老路子不受影响', async () => {
  const chunks = [
    `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: '想一下' } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: '答案' } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
    'data: [DONE]\n\n',
  ];
  const p = createProvider({ apiKey: 'k', model: 'm', baseUrl: 'https://x/v1' }, { fetchImpl: fakeFetch(chunks) });
  let text = '';
  let think = '';
  for await (const ev of p.stream([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], [], '', undefined)) {
    if (ev.type === 'text_delta') text += ev.text;
    else if (ev.type === 'thinking_delta') think += ev.text;
  }
  assert.equal(text, '答案');
  assert.equal(think, '想一下');
});
