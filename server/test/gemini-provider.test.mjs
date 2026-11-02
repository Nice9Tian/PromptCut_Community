/**
 * node --test server/test/gemini-provider.test.mjs
 *
 * Several contracts for the first-party Gemini provider. All pin down the **fails without
 * reporting errors** variety:
 *
 *   - Thinking tier previously sent nothing at all. cfg.effort was passed all the way from
 *     runners/api.mjs, openai.mjs sent it as reasoning_effort, but gemini.mjs discarded it
 *     entirely: the thinking tier on the panel was dead for Gemini, selecting anything made no
 *     difference, with no indication whatsoever.
 *   - Thinking content is an "ordinary text part with thought:true". If evaluation order is
 *     reversed, it gets hijacked by the text branch: model thinking is broadcast as body text,
 *     while the "thinking" column remains permanently empty.
 *   - functionResponse.response is structurally a Struct (must be an object). Previously it was
 *     always flattened into a string with JSON.stringify, both wasting tokens and flattening
 *     nesting, forcing the model to re-read it from a string.
 *   - When finishReason is MALFORMED_FUNCTION_CALL / SAFETY, it previously also yielded 'stop',
 *     causing the upper layer to assume this round finished normally: no indication appeared in
 *     the UI, either staying stuck in place or spinning for another round.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { createProvider } = await import('../harness/providers/gemini.mjs');

/** Wrap several candidate fragments into a Gemini SSE stream */
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

/** Run stream once and collect events along with the body of each request */
async function run(cfg, { messages = userMsg('Hello'), tools = [], responses } = {}) {
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

/* ── Thinking tier ─────────────────────────────────────────────── */

test('cfg.effort must be sent as thinkingConfig: previously nothing at all was sent here', async () => {
  const { sent } = await run({ ...CFG, effort: 'high' }, { responses: [() => sse(parts({ text: 'Hmm' }))] });
  assert.deepEqual(sent[0].generationConfig.thinkingConfig, { thinkingLevel: 'high', includeThoughts: true });
});

test('when no thinking tier is selected, do not send this field and do not make up a default value', async () => {
  const a = await run({ ...CFG, effort: '' }, { responses: [() => sse(parts({ text: 'Hmm' }))] });
  assert.equal(a.sent[0].generationConfig.thinkingConfig, undefined);
  const b = await run(CFG, { responses: [() => sse(parts({ text: 'Hmm' }))] });
  assert.equal(b.sent[0].generationConfig.thinkingConfig, undefined);
});

test('the tier is passed through as is, not converted into a token budget', async () => {
  for (const lv of ['low', 'medium', 'high']) {
    const { sent } = await run({ ...CFG, effort: lv }, { responses: [() => sse(parts({ text: 'x' }))] });
    assert.equal(sent[0].generationConfig.thinkingConfig.thinkingLevel, lv);
    assert.equal(sent[0].generationConfig.thinkingBudget, undefined);
    assert.equal(sent[0].generationConfig.thinkingBudgetTokens, undefined);
  }
});

test('if an older model does not recognize thinkingConfig, drop it and resend once; do not let one dropdown kill the whole chat turn', async () => {
  const { sent, events, threw } = await run(
    { ...CFG, effort: 'high' },
    { responses: [() => err400('Unknown name "thinkingConfig"'), () => sse(parts({ text: 'OK' }))] },
  );
  assert.equal(threw, null, 'should not throw if the resend succeeds');
  assert.equal(sent.length, 2, 'must resend once');
  assert.ok(sent[0].generationConfig.thinkingConfig, 'the first request carries it');
  assert.equal(sent[1].generationConfig.thinkingConfig, undefined, 'the second request drops it');
  assert.deepEqual(sent[1].contents, sent[0].contents, 'apart from this field, nothing else changes');
  assert.ok(events.some((e) => e.type === 'text_delta' && e.text === 'OK'));
});

test('a 400 when thinkingConfig was not sent is reported as usual; do not resend pointlessly', async () => {
  const { sent, threw } = await run(CFG, { responses: [() => err400('unrelated error')] });
  assert.equal(sent.length, 1);
  assert.match(String(threw?.message), /gemini HTTP 400/);
});

/* ── Thinking content ──────────────────────────────────────────── */

test('a part with thought:true goes through thinking_delta and must not leak into the main text', async () => {
  const { events } = await run(CFG, {
    responses: [() => sse(parts({ text: 'Let me think first', thought: true }, { text: 'The answer is 42' }))],
  });
  const think = events.filter((e) => e.type === 'thinking_delta').map((e) => e.text);
  const text = events.filter((e) => e.type === 'text_delta').map((e) => e.text);
  assert.deepEqual(think, ['Let me think first'], 'this would be empty if the check order were reversed');
  assert.deepEqual(text, ['The answer is 42'], 'thinking must not be emitted as main text');
});

test('the event type must be thinking_delta: agent.mjs only recognizes this name, anything else is silently dropped', async () => {
  const { events } = await run(CFG, { responses: [() => sse(parts({ text: 'Thinking', thought: true }))] });
  const kinds = new Set(events.map((e) => e.type));
  assert.ok(kinds.has('thinking_delta'));
  assert.ok(!kinds.has('thought'), "must not be called thought, the upper layer does not recognize it");
});

/* ── Tool call id ──────────────────────────────────────────────── */

test('use the official functionCall.id when there is one; only assign our own number when there is none', async () => {
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

test('self-assigned numbers never repeat within a stream: on a number collision agent.mjs stops the whole turn outright', async () => {
  const { events } = await run(CFG, {
    responses: [() => sse(parts(
      { functionCall: { name: 'see_frames', args: { t: 1 } } },
      { functionCall: { name: 'see_frames', args: { t: 2 } } },
      { functionCall: { name: 'see_frames', args: { t: 3 } } },
    ))],
  });
  const ids = events.filter((e) => e.type === 'tool_use').map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, `numbers collided: ${ids.join(', ')}`);
});

/* ── Tool result return ────────────────────────────────────────── */

const withToolResult = (content, toolUseId = 'call_abc') => [
  { role: 'user', content: [{ type: 'text', text: 'Take a look' }] },
  { role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: 'see_frames', input: {} }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] },
];
const fnResp = (sent) => sent[0].contents.at(-1).parts[0].functionResponse;

test('if the result is already an object, send it as is; do not flatten it into one big string', async () => {
  const { sent } = await run(CFG, {
    messages: withToolResult({ ok: true, notes: ['One', 'Two'], box: { w: 1920, h: 1080 } }),
    responses: [() => sse(parts({ text: 'OK' }))],
  });
  assert.deepEqual(fnResp(sent).response, { ok: true, notes: ['One', 'Two'], box: { w: 1920, h: 1080 } });
});

test('a string / array / null is not a Struct, so it still has to be wrapped', async () => {
  for (const c of ['Some text', ['a', 'b'], null]) {
    const { sent } = await run(CFG, { messages: withToolResult(c), responses: [() => sse(parts({ text: 'OK' }))] });
    assert.deepEqual(fnResp(sent).response, { result: c }, `content=${JSON.stringify(c)} needs to be wrapped`);
  }
});

test('official ids are sent back; self-assigned numbers are not (Gemini would not recognize them anyway)', async () => {
  const real = await run(CFG, { messages: withToolResult({ ok: true }, 'call_abc'), responses: [() => sse(parts({ text: 'OK' }))] });
  assert.equal(fnResp(real.sent).id, 'call_abc');
  const fake = await run(CFG, { messages: withToolResult({ ok: true }, 'gemini-call-1'), responses: [() => sse(parts({ text: 'OK' }))] });
  assert.equal(fnResp(fake.sent).id, undefined);
});

test('the name in functionResponse is looked up from the current turn\'s tool_use; do not hard-code unknown', async () => {
  const { sent } = await run(CFG, { messages: withToolResult({ ok: true }), responses: [() => sse(parts({ text: 'OK' }))] });
  assert.equal(fnResp(sent).name, 'see_frames');
});

/* ── Finalize ──────────────────────────────────────────────────── */

test('a normal finish still yields stop', async () => {
  for (const reason of ['STOP', 'MAX_TOKENS']) {
    const { events, threw } = await run(CFG, { responses: [() => sse(parts({ text: 'x' }), finish(reason))] });
    assert.equal(threw, null, `${reason} should not throw`);
    assert.equal(events.at(-1).type, 'stop');
    assert.equal(events.at(-1).reason, reason);
  }
});

test('an abnormal finish must throw and must not be disguised as a normal end', async () => {
  for (const reason of ['MALFORMED_FUNCTION_CALL', 'SAFETY', 'RECITATION']) {
    const { threw } = await run(CFG, { responses: [() => sse(parts({ text: 'x' }), finish(reason))] });
    assert.ok(threw, `${reason} was treated as a normal end`);
    assert.match(threw.message, new RegExp(reason));
  }
});

test('usage was already reported before the throw; do not lose this turn\'s usage accounting', async () => {
  const { events } = await run(CFG, {
    responses: [() => sse(parts({ text: 'x' }), { usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 22 }, candidates: [{ finishReason: 'SAFETY' }] })],
  });
  const u = events.find((e) => e.type === 'usage');
  assert.deepEqual([u?.input, u?.output], [11, 22]);
});
