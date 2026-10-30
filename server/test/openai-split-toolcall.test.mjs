/**
 * 网关把一次工具调用拆成两条(实跑:gemini-3.8-flash 经 openlux 的 OpenAI 兼容口):
 * 前一条 set_position 参数为空,后一条参数齐全但名字为空、id 也不同。provider 要把它们合回一次。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createProvider } from '../harness/providers/openai.mjs';

function fakeFetch(chunks) {
  return async () => {
    const text = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
    const bytes = new TextEncoder().encode(text);
    let sent = false;
    return { ok: true, status: 200, headers: new Map(),
      body: { getReader: () => ({ read: async () => (sent ? { done: true } : (sent = true, { done: false, value: bytes })), releaseLock() {} }) } };
  };
}

async function toolUses(toolCalls) {
  const chunks = [
    { choices: [{ index: 0, delta: { tool_calls: toolCalls } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
  ];
  const p = createProvider({ apiKey: 'k', model: 'm', baseUrl: 'http://x/v1' }, { fetchImpl: fakeFetch(chunks) });
  const out = [];
  for await (const ev of p.stream([{ role: 'user', content: [{ type: 'text', text: '挪一下' }] }], [], '', undefined)) if (ev.type === 'tool_use') out.push(ev);
  return out;
}

test('「有名无参」后面紧跟「无名有参」:合成一次调用', async () => {
  const uses = await toolUses([
    { index: 0, id: 'call_a', type: 'function', function: { name: 'set_position', arguments: '{}' } },
    { index: 1, id: 'call_b', type: 'function', function: { arguments: '{"clipId":"c-6","x":1500,"y":600}' } },
  ]);
  assert.equal(uses.length, 1);
  assert.equal(uses[0].name, 'set_position');
  assert.deepEqual(uses[0].input, { clipId: 'c-6', x: 1500, y: 600 });
});

test('正常的两个并行调用各自有名字:不合并', async () => {
  const uses = await toolUses([
    { index: 0, id: 'call_a', type: 'function', function: { name: 'get_project', arguments: '{}' } },
    { index: 1, id: 'call_b', type: 'function', function: { name: 'list_media', arguments: '{}' } },
  ]);
  assert.deepEqual(uses.map((u) => u.name), ['get_project', 'list_media']);
});
