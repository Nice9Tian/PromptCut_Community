// node --test server/test/idle-timeout.test.mjs —— 流式请求的「闲置超时」
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { withIdleTimeout } = await import('../harness/idle-timeout.mjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 造一个流:按 gaps 给的间隔逐块吐出来 */
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

test('一直在吐数据:流多久都不算超时 —— 这正是原来那个总时长上限掐错的场景', async () => {
  // 每 40ms 一块、共 8 块 = 320ms,远超 100ms 的闲置阈值,但每一块都把表拨回去了
  const f = withIdleTimeout(async () => streamOf([40, 40, 40, 40, 40, 40, 40, 40]), { idleMs: 100 });
  const res = await f('u', {});
  const chunks = await drain(res);
  assert.equal(chunks.length, 8, '正常流下去不该被掐断');
});

test('真的卡住了才超时:一块都不来就报 TimeoutError', async () => {
  const f = withIdleTimeout(
    (url, init) => new Promise((_res, rej) => {
      init.signal.addEventListener('abort', () => rej(init.signal.reason), { once: true });
    }),
    { idleMs: 60 },
  );
  await assert.rejects(() => f('u', {}), (e) => {
    assert.equal(e.name, 'TimeoutError');
    assert.match(e.message, /没有收到任何数据/);
    return true;
  });
});

test('流中途断供超过阈值:抛超时,而不是悄悄结束', async () => {
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

test('调用方自己的 signal 照样管用(用户点停止)', async () => {
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

test('错误响应原样透出去,不包也不改 —— assertOk 还要读它的正文', async () => {
  const err = { ok: false, status: 429, headers: { get: () => null }, text: async () => 'busy' };
  const f = withIdleTimeout(async () => err, { idleMs: 50 });
  const res = await f('u', {});
  assert.equal(res, err, '非 2xx 直接原样返回');
  assert.equal(await res.text(), 'busy');
});

test('包装之后 ok / status / headers 这些还在 —— 下游只认这几样', async () => {
  const f = withIdleTimeout(async () => streamOf([5]), { idleMs: 500 });
  const res = await f('u', {});
  assert.equal(res.ok, true);
  assert.equal(res.status, 200);
  assert.equal(typeof res.headers.get, 'function');
  assert.equal(typeof res.text, 'function');
  await drain(res);
});
