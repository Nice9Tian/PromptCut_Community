/**
 * OpenAI 兼容接口的缓存命中量:网关自动缓存,命中多少在 usage.prompt_tokens_details.cached_tokens。
 * prompt_tokens 已经含着它 —— input 照报 prompt_tokens,不能再加一遍。
 * 数字取自对 openlux 网关的实测(gemini-3.8-flash,同一前缀连发两次的第二次)。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createProvider } from '../harness/providers/openai.mjs';

function fakeFetch(chunks) {
  return async () => {
    const text = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
    const bytes = new TextEncoder().encode(text);
    let sent = false;
    return {
      ok: true, status: 200, headers: new Map(),
      body: { getReader: () => ({ read: async () => (sent ? { done: true } : (sent = true, { done: false, value: bytes })), releaseLock() {} }) },
    };
  };
}

async function usageOf(usage) {
  const chunks = [
    { choices: [{ index: 0, delta: { content: '收到' } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    { choices: [], usage },
  ];
  const p = createProvider({ apiKey: 'k', model: 'm', baseUrl: 'http://x/v1' }, { fetchImpl: fakeFetch(chunks) });
  const events = [];
  for await (const ev of p.stream([{ role: 'user', content: [{ type: 'text', text: '你好' }] }], [], '', undefined)) events.push(ev);
  return events.find((e) => e.type === 'usage');
}

test('命中缓存:input 照报 prompt_tokens(已含缓存),cacheRead 报命中量', async () => {
  const u = await usageOf({ prompt_tokens: 34057, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 27877 } });
  assert.deepEqual(u, { type: 'usage', input: 34057, output: 1, cacheRead: 27877 });
});

test('接口不报 prompt_tokens_details 时 cacheRead 为 0,其余不变', async () => {
  const u = await usageOf({ prompt_tokens: 120, completion_tokens: 8 });
  assert.deepEqual(u, { type: 'usage', input: 120, output: 8, cacheRead: 0 });
});
