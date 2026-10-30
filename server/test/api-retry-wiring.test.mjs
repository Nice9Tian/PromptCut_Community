/**
 * node --test server/test/api-retry-wiring.test.mjs
 *
 * 重试**接进 runners/api.mjs 了没有**。
 *
 * 单测 retry-fetch 模块本身是不够的:模块写对了、没接到 createProvider 的 fetchImpl 上,
 * 线上照样一撞 429 就报错。所以这一条从 startRun 进去,数真正发出去了几次请求。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { startRun } = await import('../runners/api.mjs');

/** 一段最小的、能让 provider 正常收尾的 SSE */
function okStream(text) {
  const chunks = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
    'data: [DONE]\n\n',
  ];
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'text/event-stream' },
    body: (async function* () { for (const c of chunks) yield c; })(),
  };
}

function errResponse(status) {
  return {
    ok: false,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify({ error: { message: 'Current group upstream load is saturated' } }),
  };
}

/** 跑一次对话,返回 { events, runHandle } */
function run({ fetchImpl, idleMsForTest, retryForTest, vendor = 'openai', onStart }) {
  const events = [];
  return new Promise((resolve) => {
    const r = startRun({
      prompt: '你好',
      systemPrompt: '',
      apiConfig: { vendor, apiKey: 'sk-test', model: 'm', baseUrl: 'https://relay.example/v1', maxTokens: 64 },
      sessionId: `retrytest-${Math.random().toString(36).slice(2, 8)}`,
      callTool: async () => ({ ok: true }),
      fetchImpl,
      ...(idleMsForTest ? { idleMsForTest } : {}),
      ...(retryForTest ? { retryForTest } : {}),
      onEvent: (ev) => {
        events.push(ev);
        if (ev.type === 'done' || ev.type === 'error') setTimeout(() => resolve(events), 10);
      },
    });
    onStart?.(r);
    // 兜底:万一没有 done/error 也别把测试挂死
    (r?.done ?? Promise.resolve()).finally?.(() => setTimeout(() => resolve(events), 50));
  });
}

function sseChunks(chunks) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'text/event-stream' },
    body: (async function* () {
      for (const c of chunks) {
        if (c instanceof Error) throw c;
        yield c;
      }
    })(),
  };
}

test('429 之后自动重试,最终把回复交出来 —— 用户撞到的就是这一个', async () => {
  let n = 0;
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push(url);
    // 前两次上游拥挤,第三次正常
    return n++ < 2 ? errResponse(429) : okStream('好的');
  };
  const events = await run({ fetchImpl, retryForTest: { baseDelayMs: 5, maxDelayMs: 10 } });
  const err = events.find((e) => e.type === 'error');
  assert.equal(err, undefined, `不该报错,实际: ${err?.message}`);
  assert.ok(seen.length >= 3, `该重试到成功为止,实际只发了 ${seen.length} 次`);
  const text = events.filter((e) => e.type === 'text').map((e) => e.delta).join('');
  assert.match(text, /好的/);
});

test('401 不重试:只发一次,并且如实报错', async () => {
  let n = 0;
  const fetchImpl = async () => { n++; return { ok: false, status: 401, headers: { get: () => null }, text: async () => JSON.stringify({ error: { message: 'invalid api key' } }) }; };
  const events = await run({ fetchImpl });
  assert.equal(n, 1, `401 该一次就停,实际发了 ${n} 次`);
  assert.ok(events.some((e) => e.type === 'error'), '应该有 error 事件');
});

test('a. HTTP 200 SSE 流首包返回 upstream timed out 错误时自动重试,后续尝试正常流式返回且无 error 事件', async () => {
  let n = 0;
  const fetchImpl = async () => {
    n++;
    if (n === 1) {
      return sseChunks([
        'data: {"error":{"message":"The upstream service timed out. Please try again later. (request id: 202610180052009722857049rKYajio)"}}\n\n',
      ]);
    }
    if (n === 2) {
      // 先来一帧空 role delta、再来 upstream timed out,同样还没吐任何内容块
      return sseChunks([
        'data: {"choices":[{"delta":{"role":"assistant","content":""}}]}\n\n',
        'data: {"error":{"message":"The upstream service timed out. Please try again later. (request id: 202610180052009722857049rKYajio)"}}\n\n',
      ]);
    }
    return okStream('重试后成功');
  };
  const events = await run({ fetchImpl, retryForTest: { baseDelayMs: 5, maxDelayMs: 10 } });
  const err = events.find((e) => e.type === 'error');
  assert.equal(err, undefined, `整轮应当成功且无 error 事件,实际: ${err?.message}`);
  assert.equal(n, 3, '前两次 SSE 首包超时均自动重试,第三次成功');
  const text = events.filter((e) => e.type === 'text').map((e) => e.delta).join('');
  assert.equal(text, '重试后成功');
  assert.ok(events.some((e) => e.type === 'done'), '应正常发出 done 事件');
});

test('b. 单次尝试触发 withIdleTimeout(外部 signal 未 abort)时自动重试并成功;用户点停止时立即停止绝不重试', async () => {
  let n = 0;
  const fetchImpl = (url, options) => {
    n++;
    if (n === 1) {
      // 第一次尝试完全无响应,触发 withIdleTimeout
      return new Promise((_res, rej) => {
        options.signal.addEventListener('abort', () => rej(options.signal.reason), { once: true });
      });
    }
    return Promise.resolve(okStream('超时重试后正常返回'));
  };
  const events = await run({
    fetchImpl,
    idleMsForTest: 40,
    retryForTest: { baseDelayMs: 5, maxDelayMs: 10 },
  });
  const err = events.find((e) => e.type === 'error');
  assert.equal(err, undefined, `闲置超时重试成功后不该有 error 事件,实际: ${err?.message}`);
  assert.equal(n, 2, '第一次闲置超时后应自动重发第二次并成功');
  const text = events.filter((e) => e.type === 'text').map((e) => e.delta).join('');
  assert.equal(text, '超时重试后正常返回');

  // 用户点击停止(abort()):立即停止、绝不重试
  let stopCalls = 0;
  const stopEvents = await run({
    fetchImpl: (url, options) => {
      stopCalls++;
      return new Promise((_res, rej) => {
        options.signal.addEventListener('abort', () => rej(options.signal.reason ?? new Error('aborted')), { once: true });
      });
    },
    idleMsForTest: 5000,
    retryForTest: { baseDelayMs: 5, maxDelayMs: 10 },
    onStart: (handle) => setTimeout(() => handle.abort(), 20),
  });
  assert.equal(stopCalls, 1, '用户点停止后绝不能自动重试');
  assert.equal(stopEvents.find((e) => e.type === 'error'), undefined, '用户点停止不报 error');
});

test('c. SSE 流已经吐出一半 text_delta 后再收到 parsed.error 或断流时,绝不重发同一请求;按「被网关中途掐断」收尾、让模型接着做(stream-cut 2026-10-22)', async () => {
  /*
   * 2026-10-22 用户定:「中途被网关掐断按截断处理(保住半截参数、走代码块续写)」。原来这里断言「直接报错」;
   * 现在同一请求仍然绝不重发(重试层不碰已经出过内容的流),但这一轮不再当错误:已经说的话保留,下一次请求是新的一轮,
   * 带着「被网关中途掐断」的提示。这里每次都在同一处断、什么也没留下,连续 3 次之后明说没做成。
   */
  // 场景 1:吐出一半 text_delta 后收到 parsed.error
  const bodies1 = [];
  const events1 = await run({
    fetchImpl: async (_url, init) => {
      bodies1.push(String(init?.body ?? ''));
      return sseChunks([
        `data: ${JSON.stringify({ choices: [{ delta: { content: '已经说了一半' } }] })}\n\n`,
        'data: {"error":{"message":"The upstream service timed out. Please try again later."}}\n\n',
      ]);
    },
    retryForTest: { baseDelayMs: 5, maxDelayMs: 10 },
  });
  assert.equal(bodies1.length, 3, '每次都是新的一轮(连续 3 次没留下内容就停),不是重试层重发');
  assert.equal(new Set(bodies1).size, 3, '三次请求内容各不相同:后一次带着掐断的提示');
  assert.match(bodies1[1], /网关中途掐断/);
  const text1 = events1.filter((e) => e.type === 'text').map((e) => e.delta).join('');
  assert.equal(text1, '已经说了一半'.repeat(3));
  const err1 = events1.find((e) => e.type === 'error');
  assert.ok(err1, '连续掐断超限要报错');
  assert.match(err1.message, /连续 3 次被网关中途掐断/);

  // 场景 2:吐出一半 text_delta 后流异常断开(未收到 finish_reason)
  const bodies2 = [];
  const events2 = await run({
    fetchImpl: async (_url, init) => {
      bodies2.push(String(init?.body ?? ''));
      return sseChunks([
        `data: ${JSON.stringify({ choices: [{ delta: { content: '半截话' } }] })}\n\n`,
        new Error('socket hang up'),
      ]);
    },
    retryForTest: { baseDelayMs: 5, maxDelayMs: 10 },
  });
  assert.equal(new Set(bodies2).size, bodies2.length, '断流后不重发同一请求');
  assert.ok(events2.some((e) => e.type === 'diagnostic' && e.stage === 'stream-cut' && e.data?.how === 'connection'));
  assert.match(events2.find((e) => e.type === 'error')?.message ?? '', /被网关中途掐断/);
});

test('d. SSE 流首包返回不可重试错误(如 invalid api key / invalid argument)时不白白重试', async () => {
  for (const errMsg of ['Invalid API key provided', 'Invalid argument: temperature out of range']) {
    let calls = 0;
    const events = await run({
      fetchImpl: async () => {
        calls++;
        return sseChunks([`data: ${JSON.stringify({ error: { message: errMsg } })}\n\n`]);
      },
      retryForTest: { baseDelayMs: 5, maxDelayMs: 10 },
    });
    assert.equal(calls, 1, `SSE 不可重试错误 "${errMsg}" 应一次即停`);
    const err = events.find((e) => e.type === 'error');
    assert.ok(err, '应直接报出 error 事件');
    assert.match(err.message, new RegExp(errMsg.slice(0, 15), 'i'));
  }
});

test('e. anthropic 与 gemini 流在产出首个内容块前遇到 SSE 临时错误或空流断线同样自动重试', async () => {
  // Anthropic:第一次 message_start 后发 overloaded_error,第二次正常完成
  let anthCalls = 0;
  const anthEvents = await run({
    vendor: 'anthropic',
    fetchImpl: async () => {
      anthCalls++;
      if (anthCalls === 1) {
        return sseChunks([
          'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":12}}}\n\n',
          'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
        ]);
      }
      return sseChunks([
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":12}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Anthropic 恢复"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]);
    },
    retryForTest: { baseDelayMs: 5, maxDelayMs: 10 },
  });
  assert.equal(anthCalls, 2);
  assert.equal(anthEvents.find((e) => e.type === 'error'), undefined);
  assert.equal(anthEvents.filter((e) => e.type === 'text').map((e) => e.delta).join(''), 'Anthropic 恢复');

  // Gemini:第一次空流意外结束,第二次首包 upstream timed out,第三次正常完成
  let gemCalls = 0;
  const gemEvents = await run({
    vendor: 'gemini',
    fetchImpl: async () => {
      gemCalls++;
      if (gemCalls === 1) return sseChunks([]);
      if (gemCalls === 2) {
        return sseChunks([
          'data: {"error":{"code":504,"message":"The upstream service timed out. Please try again later."}}\n\n',
        ]);
      }
      return sseChunks([
        `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Gemini 恢复' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 4 } })}\n\n`,
      ]);
    },
    retryForTest: { baseDelayMs: 5, maxDelayMs: 10 },
  });
  assert.equal(gemCalls, 3);
  assert.equal(gemEvents.find((e) => e.type === 'error'), undefined);
  assert.equal(gemEvents.filter((e) => e.type === 'text').map((e) => e.delta).join(''), 'Gemini 恢复');
});


