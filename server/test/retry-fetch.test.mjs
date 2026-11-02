// node --test server/test/retry-fetch.test.mjs: automatic retry for direct API
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { createRetryingFetch, RETRYABLE_STATUS, backoffMs, DEFAULT_RETRY, isRetryableSseError } =
  await import('../harness/retry-fetch.mjs');
const { withIdleTimeout } = await import('../harness/idle-timeout.mjs');
const { readSse } = await import('../harness/providers/base.mjs');

/** Mock response. headers.get only recognizes retry-after */
function res(status, { retryAfter } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => (k.toLowerCase() === 'retry-after' ? (retryAfter ?? null) : null) },
    text: async () => '',
  };
}

/** Construct an HTTP 200 SSE stream response */
function sseRes(chunks) {
  return {
    status: 200,
    ok: true,
    headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'text/event-stream' : null) },
    text: async () => '',
    body: (async function* () {
      for (const c of chunks) {
        if (c instanceof Error) throw c;
        yield c;
      }
    })(),
  };
}

/** Return in sequence by script; number = status code, Error instance = throw, function = call to get response */
function scripted(seq) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const step = seq[Math.min(calls.length, seq.length - 1)];
    calls.push({ url, init });
    if (step instanceof Error) throw step;
    if (typeof step === 'function') return step(url, init);
    return res(step);
  };
  return { fetchImpl, calls };
}

/** Do not actually sleep: record the wait time */
function noSleep() {
  const waits = [];
  return { waits, opts: { rand: () => 0.5, onRetry: (i) => waits.push(i.delayMs) } };
}

test('Only the status codes listed in the docs are retried: 408/429/500/502/503/504', () => {
  assert.deepEqual([...RETRYABLE_STATUS].sort((a, b) => a - b), [408, 429, 500, 502, 503, 504]);
  for (const s of [400, 401, 403, 404, 200, 201]) {
    assert.ok(!RETRYABLE_STATUS.has(s), `${s} should not be retried`);
  }
});

test('Retry after 429 and return the successful attempt: this is exactly the case the user reported', async () => {
  const { fetchImpl, calls } = scripted([429, 429, 200]);
  const { waits, opts } = noSleep();
  const f = createRetryingFetch(fetchImpl, { ...opts, baseDelayMs: 1, maxDelayMs: 2 });
  const r = await f('u', {});
  assert.equal(r.status, 200);
  assert.equal(calls.length, 3, 'First attempt + two retries');
  assert.equal(waits.length, 2);
});

test('Responses like 401 / 400 return immediately without a single retry: sending a hundred more times gives the same result', async () => {
  for (const code of [400, 401, 403, 404]) {
    const { fetchImpl, calls } = scripted([code]);
    const f = createRetryingFetch(fetchImpl, { baseDelayMs: 1 });
    const r = await f('u', {});
    assert.equal(r.status, code);
    assert.equal(calls.length, 1, `${code} should not be retried`);
  }
});

test('429 every time: after 10 retries, hand over the last response and let the upper layer report the error', async () => {
  const { fetchImpl, calls } = scripted([429]);
  const { opts } = noSleep();
  const f = createRetryingFetch(fetchImpl, { ...opts, baseDelayMs: 1, maxDelayMs: 2 });
  const r = await f('u', {});
  assert.equal(r.status, 429);
  assert.equal(calls.length, 1 + DEFAULT_RETRY.maxRetries, '11 attempts in total');
});

test('Network errors are retried too, but AbortError is thrown immediately: once the user clicks stop, stop sending', async () => {
  const net = scripted([new Error('socket hang up'), 200]);
  const { opts } = noSleep();
  const f1 = createRetryingFetch(net.fetchImpl, { ...opts, baseDelayMs: 1 });
  assert.equal((await f1('u', {})).status, 200);
  assert.equal(net.calls.length, 2);

  const abort = new Error('The operation was aborted');
  abort.name = 'AbortError';
  const stopped = scripted([abort, 200]);
  const f2 = createRetryingFetch(stopped.fetchImpl, { baseDelayMs: 1 });
  await assert.rejects(() => f2('u', {}), /abort/i);
  assert.equal(stopped.calls.length, 1, 'Nothing should be sent after stop');
});

test('When every attempt hits a network error and there is nothing left to fall back on, the last error is thrown, not undefined', async () => {
  const { fetchImpl } = scripted([new Error('ECONNRESET')]);
  const { opts } = noSleep();
  const f = createRetryingFetch(fetchImpl, { ...opts, baseDelayMs: 1, maxRetries: 2 });
  await assert.rejects(() => f('u', {}), /ECONNRESET/);
});

test('If the server sends Retry-After, follow it rather than our own computed backoff', async () => {
  const { fetchImpl } = scripted([429, 200]);
  const waits = [];
  const f = createRetryingFetch(fetchImpl, {
    baseDelayMs: 1, maxDelayMs: 60000,
    onRetry: (i) => waits.push(i.delayMs),
  });
  // Mock response does not include retry-after; first confirm that backoff is used
  await f('u', {});
  assert.ok(waits[0] <= 1, `Without Retry-After the backoff should be used, got ${waits[0]}`);

  const withHeader = {
    fetchImpl: (() => {
      let n = 0;
      return async () => (n++ === 0 ? res(429, { retryAfter: '2' }) : res(200));
    })(),
  };
  const waits2 = [];
  const f2 = createRetryingFetch(withHeader.fetchImpl, {
    baseDelayMs: 1, maxDelayMs: 60000,
    onRetry: (i) => waits2.push(i.delayMs),
  });
  await f2('u', {});
  assert.equal(waits2[0], 2000, 'Retry-After: 2 should wait 2 seconds');
});

test('However large Retry-After is, it is clamped by maxDelayMs so the other side cannot hang us', async () => {
  let n = 0;
  const fetchImpl = async () => (n++ === 0 ? res(503, { retryAfter: '9999' }) : res(200));
  const waits = [];
  const f = createRetryingFetch(fetchImpl, { baseDelayMs: 1, maxDelayMs: 3000, onRetry: (i) => waits.push(i.delayMs) });
  await f('u', {});
  assert.equal(waits[0], 3000);
});

test('Backoff is exponential with jitter, and the cap holds', () => {
  const cfg = { baseDelayMs: 500, maxDelayMs: 8000 };
  const half = (n) => backoffMs(n, cfg, () => 1); // rand=1 → take full amount
  assert.equal(half(0), 500);
  assert.equal(half(1), 1000);
  assert.equal(half(2), 2000);
  assert.equal(half(5), 8000, 'Stops growing once it reaches the cap');
  assert.equal(half(9), 8000);
  // Jitter: same tier is between 50% and 100%
  assert.equal(backoffMs(1, cfg, () => 0), 500);
  assert.equal(backoffMs(1, cfg, () => 1), 1000);
});

test('Stop retrying once the total budget runs out, even if retries remain', async () => {
  const { fetchImpl, calls } = scripted([429]);
  let clock = 0;
  const f = createRetryingFetch(fetchImpl, {
    baseDelayMs: 1, maxDelayMs: 1, maxTotalMs: 50,
    now: () => (clock += 30),   // Jump forward 30ms each time time is queried
    onRetry: () => {},
  });
  const r = await f('u', {});
  assert.equal(r.status, 429);
  assert.ok(calls.length < 1 + DEFAULT_RETRY.maxRetries, `Should have been cut off by the budget, actually sent ${calls.length} times`);
});

test('The body of an error response is consumed so that the connection can be returned', async () => {
  let drained = 0;
  let n = 0;
  const fetchImpl = async () => {
    if (n++ === 0) return { ...res(502), text: async () => { drained++; return ''; } };
    return res(200);
  };
  const f = createRetryingFetch(fetchImpl, { baseDelayMs: 1, onRetry: () => {} });
  await f('u', {});
  assert.equal(drained, 1);
});

test('When the first packet of an HTTP 200 SSE stream returns an upstream timed out error, retry automatically, and the rest then streams back normally', async () => {
  const upstreamTimeoutChunk =
    'data: {"error":{"message":"The upstream service timed out. Please try again later. (request id: 202610180052009722857049rKYajio)"}}\n\n';
  const { fetchImpl, calls } = scripted([
    () => sseRes([upstreamTimeoutChunk]),
    () => sseRes([
      'data: {"choices":[{"delta":{"role":"assistant","content":""}}]}\n\n',
      upstreamTimeoutChunk,
    ]),
    () => sseRes([
      'data: {"choices":[{"delta":{"content":"Back to normal"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ]),
  ]);
  const reasons = [];
  const f = createRetryingFetch(fetchImpl, {
    baseDelayMs: 1,
    maxDelayMs: 2,
    onRetry: (i) => reasons.push(i.reason),
  });
  const r = await f('u', {});
  assert.equal(calls.length, 3, 'The first two SSE first-packet timeouts should each trigger a retry');
  assert.equal(reasons.length, 2);
  assert.match(reasons[0], /upstream service timed out/i);

  const evs = [];
  for await (const ev of readSse(r)) evs.push(ev.data);
  assert.ok(evs.some((d) => d.includes('Back to normal')), 'The first packet of the successful attempt must not be lost during pre-read');
  assert.ok(evs.includes('[DONE]'), 'The rest of the stream is also read to the end');
});

test('A single attempt that triggers withIdleTimeout (external signal not aborted) is retried automatically and succeeds; when the external signal.aborted is set, stop immediately without retrying', async () => {
  let attempt = 0;
  const userAc = new AbortController();
  const rawFetch = (url, init) => {
    attempt++;
    if (attempt === 1) {
      // First attempt hangs until withIdleTimeout triggers
      return new Promise((_res, rej) => {
        init.signal.addEventListener('abort', () => rej(init.signal.reason), { once: true });
      });
    }
    return Promise.resolve(sseRes([
      'data: {"choices":[{"delta":{"content":"Second try worked"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ]));
  };
  const f = createRetryingFetch(
    withIdleTimeout(rawFetch, { idleMs: 30 }),
    { signal: userAc.signal, baseDelayMs: 1, maxDelayMs: 2 },
  );
  const r = await f('u', { signal: userAc.signal });
  assert.equal(attempt, 2, 'Idle timeout (external signal not aborted) must trigger a retry');
  assert.equal(userAc.signal.aborted, false);
  const evs = [];
  for await (const ev of readSse(r)) evs.push(ev.data);
  assert.ok(evs.some((d) => d.includes('Second try worked')));

  // Never retry when the user explicitly clicks stop (external signal.aborted === true)
  let stopAttempts = 0;
  const stopAc = new AbortController();
  const stopFetch = (url, init) => {
    stopAttempts++;
    return new Promise((_res, rej) => {
      init.signal.addEventListener('abort', () => rej(init.signal.reason ?? new Error('user stopped')), { once: true });
    });
  };
  const fStop = createRetryingFetch(
    withIdleTimeout(stopFetch, { idleMs: 5000 }),
    { signal: stopAc.signal, baseDelayMs: 1 },
  );
  const p = fStop('u', { signal: stopAc.signal });
  setTimeout(() => stopAc.abort(new Error('user stopped')), 15);
  await assert.rejects(() => p, /user stopped|abort/i);
  assert.equal(stopAttempts, 1, 'Never retry after the user stops it');
});

test('Do not retry in vain when the first packet of an SSE stream returns a non-retryable error (invalid api key / invalid argument)', async () => {
  for (const msg of ['Invalid API key provided', 'Invalid argument: model parameters malformed']) {
    assert.equal(isRetryableSseError({ message: msg }), false, `${msg} should not be classified as retryable`);
    const { fetchImpl, calls } = scripted([
      () => sseRes([`data: ${JSON.stringify({ error: { message: msg } })}\n\n`]),
      () => sseRes(['data: {"choices":[{"delta":{"content":"Should not get here"}}]}\n\n']),
    ]);
    const f = createRetryingFetch(fetchImpl, { baseDelayMs: 1, maxDelayMs: 2 });
    const r = await f('u', {});
    assert.equal(calls.length, 1, `Non-retryable error "${msg}" should stop after one attempt`);
    const evs = [];
    for await (const ev of readSse(r)) evs.push(ev.data);
    assert.ok(evs[0].includes(msg), 'The error event should be left as is for the downstream provider to throw');
  }
});

test('DEFAULT_RETRY.maxTotalMs is 20 minutes: when each attempt takes 95 seconds to return an SSE upstream timed out and 4 failures in a row occur (380 seconds in total > the old 5 minutes), it does not abort early, continues with the 4th retry, and returns the body successfully on the 5th attempt', async () => {
  assert.equal(DEFAULT_RETRY.maxTotalMs, 20 * 60 * 1000, 'The default total time budget should be 20 minutes');
  assert.equal(DEFAULT_RETRY.maxRetries, 10, 'The default maximum number of retries should be 10');

  const upstreamTimeoutChunk =
    'data: {"error":{"message":"The upstream service timed out. Please try again later. (request id: 202610180052009722857049rKYajio)"}}\n\n';
  let clock = 0;
  const timedTimeoutStep = () => {
    clock += 95_000; // Simulate a single upstream hang of 95 seconds before returning SSE error
    return sseRes([upstreamTimeoutChunk]);
  };
  const { fetchImpl, calls } = scripted([
    timedTimeoutStep,
    timedTimeoutStep,
    timedTimeoutStep,
    timedTimeoutStep,
    () => sseRes([
      'data: {"choices":[{"delta":{"content":"Attempt 5 succeeded and returned the body"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ]),
  ]);

  const retries = [];
  const f = createRetryingFetch(fetchImpl, {
    baseDelayMs: 1,
    maxDelayMs: 2,
    now: () => clock,
    onRetry: (info) => {
      retries.push(info);
      clock += info.delayMs;
    },
  });

  const r = await f('u', {});
  assert.ok(clock >= 380_000, `4 timeouts of 95 seconds should add up to more than the old 5 minutes (300_000ms), actual ${clock}ms`);
  assert.equal(calls.length, 5, 'First attempt + 4 retries make 5 attempts');
  assert.equal(retries.length, 4, 'Should go through all 4 retries instead of giving up after the 3rd retry because the old 5-minute budget ran out');
  assert.equal(retries[3].attempt, 4);
  assert.equal(retries[3].of, 10);

  const evs = [];
  for await (const ev of readSse(r)) evs.push(ev.data);
  assert.ok(evs.some((d) => d.includes('Attempt 5 succeeded and returned the body')), 'Attempt 5 should get the body normally');
  assert.ok(evs.includes('[DONE]'));
});


