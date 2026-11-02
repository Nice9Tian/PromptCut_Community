// node --test server/test/idle-timeout.test.mjs: "idle timeout" for streaming requests
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { withIdleTimeout } = await import('../harness/idle-timeout.mjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Create a stream: emit chunk by chunk according to intervals given by gaps */
function streamOf(gaps) {
  return {
    ok: true, status: 200, statusText: 'OK',
    headers: { get: () => 'text/event-stream' },
    text: async () => '',
    json: async () => ({}),
    body: (async function* () {
      for (const g of gaps) { await sleep(g); yield `chunk-${g}`; }
    })(),
  };
}

async function drain(res) {
  const out = [];
  for await (const c of res.body) out.push(c);
  return out;
}

test('data keeps flowing: a stream never times out however long it runs. This is exactly the case the old total-duration cap cut off wrongly', async () => {
  // One chunk every 40ms, 8 chunks in total = 320ms, far exceeding the 100ms idle threshold, but each
  // chunk reset the clock
  const f = withIdleTimeout(async () => streamOf([40, 40, 40, 40, 40, 40, 40, 40]), { idleMs: 100 });
  const res = await f('u', {});
  const chunks = await drain(res);
  assert.equal(chunks.length, 8, 'a healthy stream should not be cut off');
});

test('only a real stall times out: if not a single chunk arrives, TimeoutError is reported', async () => {
  const f = withIdleTimeout(
    (url, init) => new Promise((_res, rej) => {
      init.signal.addEventListener('abort', () => rej(init.signal.reason), { once: true });
    }),
    { idleMs: 60 },
  );
  await assert.rejects(() => f('u', {}), (e) => {
    assert.equal(e.name, 'TimeoutError');
    assert.match(e.message, /no data received/);
    return true;
  });
});

test('the stream stops supplying data midway past the threshold: a timeout is thrown instead of quietly ending', async () => {
  const f = withIdleTimeout(async (url, init) => ({
    ok: true, status: 200, headers: { get: () => null }, text: async () => '', json: async () => ({}),
    body: (async function* () {
      yield 'a';
      await new Promise((_r, rej) => init.signal.addEventListener('abort', () => rej(init.signal.reason), { once: true }));
    })(),
  }), { idleMs: 60 });
  const res = await f('u', {});
  await assert.rejects(async () => { for await (const _ of res.body) { /* drain */ } }, /TimeoutError|timeout/i);
});

test('The caller\'s own signal still works (user clicks stop)', async () => {
  const ac = new AbortController();
  const f = withIdleTimeout(
    (url, init) => new Promise((_res, rej) => {
      init.signal.addEventListener('abort', () => rej(new Error('stopped')), { once: true });
    }),
    { idleMs: 5000 },
  );
  const p = f('u', { signal: ac.signal });
  setTimeout(() => ac.abort(), 20);
  await assert.rejects(() => p, /stopped/);
});

test('Error responses pass through as is, neither wrapped nor changed: assertOk still has to read their body', async () => {
  const err = { ok: false, status: 429, headers: { get: () => null }, text: async () => 'busy' };
  const f = withIdleTimeout(async () => err, { idleMs: 50 });
  const res = await f('u', {});
  assert.equal(res, err, 'Non-2xx is returned directly, as is');
  assert.equal(await res.text(), 'busy');
});

test('After wrapping, ok / status / headers are still there: downstream only looks at these', async () => {
  const f = withIdleTimeout(async () => streamOf([5]), { idleMs: 500 });
  const res = await f('u', {});
  assert.equal(res.ok, true);
  assert.equal(res.status, 200);
  assert.equal(typeof res.headers.get, 'function');
  assert.equal(typeof res.text, 'function');
  await drain(res);
});
