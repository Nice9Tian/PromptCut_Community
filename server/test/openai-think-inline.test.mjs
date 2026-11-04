/**
 * node --test server/test/openai-think-inline.test.mjs
 *
 * OpenAI-compatible driver: when the relay service sends back `<think>…</think>` inlined in
 * content, it must be split into the thinking channel rather than entering the body as is.
 *
 * This test pins down the phenomenon users actually encountered: a bare `</think>` appearing in
 * the chat bubble. Testing the splitter alone is not enough: even if the splitter is correct, it
 * will still leak if not wired into the stream loop; so here it is verified from provider's
 * stream() exit.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { createProvider } = await import('../harness/providers/openai.mjs');

/** Assemble multiple SSE data chunks into a fake fetch response */
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

/** Wrap a series of content deltas into SSE; finalize with finish_reason at the end */
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

test('an inline <think> goes through the thinking channel, and no tag is left in the body', async () => {
  const { text, think } = await collect([
    '<think>**Clarifying article link and scope**\n\n</think>\n\nI\'ll first confirm the media collection environment.',
  ]);
  assert.equal(think, '**Clarifying article link and scope**\n\n');
  assert.equal(text, '\n\nI\'ll first confirm the media collection environment.');
  assert.ok(!/<\/?think/.test(text), 'no think tag may appear in the body');
});

test('a tag split across two SSE packets must still be recognized, since this is the norm when streaming', async () => {
  const { text, think } = await collect(['Intro<thi', 'nk>Step one</thi', 'nk>Outro']);
  assert.equal(text, 'IntroOutro');
  assert.equal(think, 'Step one');
});

test('several think blocks in one reply: the body is joined in order', async () => {
  const { text, think } = await collect(['A<think>t1</think>B', '<think>t2</think>C']);
  assert.equal(text, 'ABC');
  assert.equal(think, 't1t2');
});

test('a normal reply without think passes through unchanged', async () => {
  const { text, think } = await collect(['Hello, ', 'This is the body.']);
  assert.equal(text, 'Hello, This is the body.');
  assert.equal(think, '');
});

test('the old approach where the relay service uses a separate reasoning_content field is unaffected', async () => {
  const chunks = [
    `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'Let me think' } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'Answer' } }] })}\n\n`,
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
  assert.equal(text, 'Answer');
  assert.equal(think, 'Let me think');
});
