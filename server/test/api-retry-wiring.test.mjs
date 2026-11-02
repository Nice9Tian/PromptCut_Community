/**
 * node --test server/test/api-retry-wiring.test.mjs
 *
 * Whether retry is **wired into runners/api.mjs**.
 *
 * Unit-testing the retry-fetch module itself is not enough: even if the module is written
 * correctly, if it is not wired to fetchImpl in createProvider, production will still throw an
 * error as soon as it hits 429. So this test goes in from startRun and counts how many requests
 * were actually sent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { startRun } = await import('../runners/api.mjs');

/** A minimal SSE that allows the provider to finalize normally */
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

/** Run a chat once and return { events, runHandle } */
function run({ fetchImpl, idleMsForTest, retryForTest, vendor = 'openai', onStart }) {
  const events = [];
  return new Promise((resolve) => {
    const r = startRun({
      prompt: 'Hello',
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
    // Fallback: in case there is no done/error, avoid hanging the test
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

test('After a 429 it retries automatically and eventually delivers the reply: this is the case users actually run into', async () => {
  let n = 0;
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push(url);
    // Upstream congested the first two times, normal on the third
    return n++ < 2 ? errResponse(429) : okStream('OK');
  };
  const events = await run({ fetchImpl, retryForTest: { baseDelayMs: 5, maxDelayMs: 10 } });
  const err = events.find((e) => e.type === 'error');
  assert.equal(err, undefined, `Should not report an error, actual: ${err?.message}`);
  assert.ok(seen.length >= 3, `Should retry until it succeeds, but it was only sent ${seen.length} times`);
  const text = events.filter((e) => e.type === 'text').map((e) => e.delta).join('');
  assert.match(text, /OK/);
});

test('401 is not retried: sent only once, and the error is reported as is', async () => {
  let n = 0;
  const fetchImpl = async () => { n++; return { ok: false, status: 401, headers: { get: () => null }, text: async () => JSON.stringify({ error: { message: 'invalid api key' } }) }; };
  const events = await run({ fetchImpl });
  assert.equal(n, 1, `401 should stop after one attempt, but it was sent ${n} times`);
  assert.ok(events.some((e) => e.type === 'error'), 'There should be an error event');
});

test('a. When the first packet of an HTTP 200 SSE stream returns an upstream timed out error, it is retried automatically, and later attempts stream normally with no error event', async () => {
  let n = 0;
  const fetchImpl = async () => {
    n++;
    if (n === 1) {
      return sseChunks([
        'data: {"error":{"message":"The upstream service timed out. Please try again later. (request id: 202610180052009722857049rKYajio)"}}\n\n',
      ]);
    }
    if (n === 2) {
      // First an empty role delta frame, then upstream timed out; still has not emitted any content chunk
      return sseChunks([
        'data: {"choices":[{"delta":{"role":"assistant","content":""}}]}\n\n',
        'data: {"error":{"message":"The upstream service timed out. Please try again later. (request id: 202610180052009722857049rKYajio)"}}\n\n',
      ]);
    }
    return okStream('Succeeded after retry');
  };
  const events = await run({ fetchImpl, retryForTest: { baseDelayMs: 5, maxDelayMs: 10 } });
  const err = events.find((e) => e.type === 'error');
  assert.equal(err, undefined, `The whole round should succeed with no error event, actual: ${err?.message}`);
  assert.equal(n, 3, 'Both of the first two SSE first-packet timeouts were retried automatically, and the third attempt succeeded');
  const text = events.filter((e) => e.type === 'text').map((e) => e.delta).join('');
  assert.equal(text, 'Succeeded after retry');
  assert.ok(events.some((e) => e.type === 'done'), 'A done event should be emitted normally');
});

test('b. When a single attempt triggers withIdleTimeout (the external signal is not aborted), it is retried automatically and succeeds; when the user clicks stop, it stops immediately and never retries', async () => {
  let n = 0;
  const fetchImpl = (url, options) => {
    n++;
    if (n === 1) {
      // First attempt has no response at all, triggering withIdleTimeout
      return new Promise((_res, rej) => {
        options.signal.addEventListener('abort', () => rej(options.signal.reason), { once: true });
      });
    }
    return Promise.resolve(okStream('Returned normally after the timeout retry'));
  };
  const events = await run({
    fetchImpl,
    idleMsForTest: 40,
    retryForTest: { baseDelayMs: 5, maxDelayMs: 10 },
  });
  const err = events.find((e) => e.type === 'error');
  assert.equal(err, undefined, `There should be no error event after an idle-timeout retry succeeds, actual: ${err?.message}`);
  assert.equal(n, 2, 'After the first idle timeout, a second attempt should be sent automatically and succeed');
  const text = events.filter((e) => e.type === 'text').map((e) => e.delta).join('');
  assert.equal(text, 'Returned normally after the timeout retry');

  // User clicks stop (abort()): stop immediately, never retry
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
  assert.equal(stopCalls, 1, 'Must never retry automatically after the user clicks stop');
  assert.equal(stopEvents.find((e) => e.type === 'error'), undefined, 'No error is reported when the user clicks stop');
});

test('c. When an SSE stream has already emitted part of its text_delta and then receives parsed.error or is cut off, never resend the same request; wrap up as "cut off midway by the gateway" and let the model continue (stream-cut 2026-10-22)', async () => {
  /*
   * (user decision, 2026-10-22): "Midway cutoffs by the gateway are handled as truncation
   * (preserving partial parameters, continuing via code block continuation)". Previously this
   * asserted "error directly"; now the same request is still never resent (the retry layer does not
   * touch streams that have already emitted content), but this round is no longer treated as an
   * error: words already spoken are preserved, and the next request is a new round, bearing the
   * notice "cut off midway by gateway". Here it breaks at the same place every time leaving nothing
   * behind; after 3 consecutive attempts, explicitly state that it failed.
   */
  // Scenario 1: parsed.error received after emitting half of text_delta
  const bodies1 = [];
  const events1 = await run({
    fetchImpl: async (_url, init) => {
      bodies1.push(String(init?.body ?? ''));
      return sseChunks([
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'Already said half of it' } }] })}\n\n`,
        'data: {"error":{"message":"The upstream service timed out. Please try again later."}}\n\n',
      ]);
    },
    retryForTest: { baseDelayMs: 5, maxDelayMs: 10 },
  });
  assert.equal(bodies1.length, 3, 'Each time is a new round (it stops after 3 consecutive times that leave no content), not a resend by the retry layer');
  assert.equal(new Set(bodies1).size, 3, 'The three requests differ in content: each later one carries the cut-off hint');
  assert.match(bodies1[1], /cut off midway: the gateway closed the connection/);
  const text1 = events1.filter((e) => e.type === 'text').map((e) => e.delta).join('');
  assert.equal(text1, 'Already said half of it'.repeat(3));
  const err1 = events1.find((e) => e.type === 'error');
  assert.ok(err1, 'Exceeding the limit of consecutive cut-offs must report an error');
  assert.match(err1.message, /cut off midway by the gateway 3 times in a row/);

  // Scenario 2: stream disconnected abnormally after emitting half of text_delta (no finish_reason received)
  const bodies2 = [];
  const events2 = await run({
    fetchImpl: async (_url, init) => {
      bodies2.push(String(init?.body ?? ''));
      return sseChunks([
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'Half a sentence' } }] })}\n\n`,
        new Error('socket hang up'),
      ]);
    },
    retryForTest: { baseDelayMs: 5, maxDelayMs: 10 },
  });
  assert.equal(new Set(bodies2).size, bodies2.length, 'The same request is not resent after the stream is cut');
  assert.ok(events2.some((e) => e.type === 'diagnostic' && e.stage === 'stream-cut' && e.data?.how === 'connection'));
  assert.match(events2.find((e) => e.type === 'error')?.message ?? '', /cut off midway by the gateway/);
});

test('d. When the first packet of an SSE stream returns a non-retryable error (such as invalid api key / invalid argument), it is not retried in vain', async () => {
  for (const errMsg of ['Invalid API key provided', 'Invalid argument: temperature out of range']) {
    let calls = 0;
    const events = await run({
      fetchImpl: async () => {
        calls++;
        return sseChunks([`data: ${JSON.stringify({ error: { message: errMsg } })}\n\n`]);
      },
      retryForTest: { baseDelayMs: 5, maxDelayMs: 10 },
    });
    assert.equal(calls, 1, `SSE non-retryable error "${errMsg}" should stop after a single attempt`);
    const err = events.find((e) => e.type === 'error');
    assert.ok(err, 'An error event should be reported directly');
    assert.match(err.message, new RegExp(errMsg.slice(0, 15), 'i'));
  }
});

test('e. anthropic and gemini streams are likewise retried automatically when they hit a transient SSE error or an empty-stream disconnect before producing the first content block', async () => {
  // Anthropic: first sends overloaded_error after message_start, completes normally the second time
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
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Anthropic recovered"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]);
    },
    retryForTest: { baseDelayMs: 5, maxDelayMs: 10 },
  });
  assert.equal(anthCalls, 2);
  assert.equal(anthEvents.find((e) => e.type === 'error'), undefined);
  assert.equal(anthEvents.filter((e) => e.type === 'text').map((e) => e.delta).join(''), 'Anthropic recovered');

  // Gemini: first time empty stream ends unexpectedly, second time first packet upstream
  // timed out, third time completes normally
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
        `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Gemini recovered' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 4 } })}\n\n`,
      ]);
    },
    retryForTest: { baseDelayMs: 5, maxDelayMs: 10 },
  });
  assert.equal(gemCalls, 3);
  assert.equal(gemEvents.find((e) => e.type === 'error'), undefined);
  assert.equal(gemEvents.filter((e) => e.type === 'text').map((e) => e.delta).join(''), 'Gemini recovered');
});


