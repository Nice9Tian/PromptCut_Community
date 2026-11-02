/**
 * Cache hits on OpenAI-compatible API: gateway caches automatically; hit count is in
 * usage.prompt_tokens_details.cached_tokens.
 * prompt_tokens already includes it: input reports prompt_tokens as is, must not add it again.
 * Numbers are taken from actual measurements on openlux gateway (gemini-3.8-flash, the second of
 * two consecutive requests with the same prefix).
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
    { choices: [{ index: 0, delta: { content: 'Got it' } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    { choices: [], usage },
  ];
  const p = createProvider({ apiKey: 'k', model: 'm', baseUrl: 'http://x/v1' }, { fetchImpl: fakeFetch(chunks) });
  const events = [];
  for await (const ev of p.stream([{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }], [], '', undefined)) events.push(ev);
  return events.find((e) => e.type === 'usage');
}

test('cache hit: input still reports prompt_tokens (which already includes the cache), cacheRead reports the hit amount', async () => {
  const u = await usageOf({ prompt_tokens: 34057, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 27877 } });
  assert.deepEqual(u, { type: 'usage', input: 34057, output: 1, cacheRead: 27877 });
});

test('when the API does not report prompt_tokens_details, cacheRead is 0 and everything else is unchanged', async () => {
  const u = await usageOf({ prompt_tokens: 120, completion_tokens: 8 });
  assert.deepEqual(u, { type: 'usage', input: 120, output: 8, cacheRead: 0 });
});
