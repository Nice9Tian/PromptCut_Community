/**
 * node --test server/test/api-effort.test.mjs
 *
 * API 直连的思考强度。
 *
 * 之前这条路是断的:CLI 那三家各自把 effort 翻译成命令行参数(claude 的 --effort、
 * codex 的 -c model_reasoning_effort、agy 的 --effort),而 API 直连从头到尾没读过它 ——
 * 界面上那个档位对 API 是死的(modelOptions 里 api 档的 efforts 干脆是空数组,
 * 连选都选不了)。
 *
 * 走 OpenAI 兼容口径的中转站是收 `reasoning_effort` 的。这里从 provider 的**请求体**验:
 * 光把值传进 cfg 不够,发不出去一样是断的。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { createProvider } = await import('../harness/providers/openai.mjs');

/** 拦下请求体,再回一段最小的 SSE 让 stream() 正常收尾 */
function spyFetch(seen) {
  return async (url, options) => {
    seen.url = url;
    seen.body = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'text/event-stream' },
      body: (async function* () {
        yield `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`;
        yield `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`;
        yield 'data: [DONE]\n\n';
      })(),
    };
  };
}

async function requestBodyFor(cfg) {
  const seen = {};
  const p = createProvider(
    { apiKey: 'k', model: 'm', baseUrl: 'https://relay.example/v1', ...cfg },
    { fetchImpl: spyFetch(seen) },
  );
  for await (const _ of p.stream([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], [], '', undefined)) {
    /* 跑完就行,事件内容这条测试不关心 */
  }
  return seen.body;
}

test('选了档位:reasoning_effort 进请求体', async () => {
  for (const effort of ['low', 'medium', 'high']) {
    const body = await requestBodyFor({ effort });
    assert.equal(body.reasoning_effort, effort, `${effort} 应该原样发出去`);
  }
});

test('选「默认」(空):一个字段都不发 —— 上游对不认识的参数可能直接 400', async () => {
  assert.ok(!('reasoning_effort' in await requestBodyFor({ effort: '' })));
  assert.ok(!('reasoning_effort' in await requestBodyFor({})), '压根没这个字段时也不能凭空冒出来');
});

test('加了 reasoning_effort 不影响原有字段', async () => {
  const body = await requestBodyFor({ effort: 'high' });
  assert.equal(body.model, 'm');
  assert.equal(body.stream, true);
  assert.ok(Array.isArray(body.messages) && body.messages.length > 0);
  assert.ok(body.max_tokens > 0);
});

/*
 * 上面验的是 provider 那一头。下面验 runner 那一头:opts.effort 有没有真的走到 cfg 里。
 * 两头分开验是有原因的 —— 任何一头断了,现象都是「档位选了没反应」,而只测一头看不出来。
 */
/** 跑一次 mock 驱动,把 configuration 那条诊断事件捞出来 */
async function configDiagnostic(effort) {
  const api = await import('../runners/api.mjs');
  const events = [];
  const run = api.startRun({
    apiConfig: { vendor: 'mock', apiKey: 'k', model: 'm', baseUrl: 'https://relay.example/v1' },
    prompt: 'hi',
    effort,
    onEvent: (ev) => events.push(ev),
  });
  await run.done.catch(() => {});
  return events.find((e) => e.type === 'diagnostic' && e.stage === 'configuration')?.data;
}

test('runner:startRun 的 opts.effort 进 cfg,并且在诊断里看得见', async () => {
  const high = await configDiagnostic('high');
  assert.equal(high?.effort, 'high', '档位没进 cfg 的话,现象就是「选了没反应」而且无从查起');

  const none = await configDiagnostic('');
  assert.equal(none?.effort, '(默认)', '没选档位时诊断里要说明是走默认,不要显示成空白');
});
