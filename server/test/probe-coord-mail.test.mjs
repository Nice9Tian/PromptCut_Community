// 协调口里两个 Agent 之间的 HTTP 信箱（scripts/probes/probe-coord.mjs 的 createMailbox）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startCoordServer, mailClient, coordClient } from '../../scripts/probes/probe-coord.mjs';

const TOKEN = 'test-mail-token-0123456789abcdef';

async function withCoord(mail, fn) {
  const c = await startCoordServer({ port: 0, mail });
  try { await fn(c); } finally { await c.close(); }
}

test('没有令牌或令牌不对回 401；没开信箱回 404', async () => {
  await withCoord({ token: TOKEN }, async (c) => {
    const none = await fetch(`${c.url}/mail/to-cloud`);
    assert.equal(none.status, 401);
    const wrong = await fetch(`${c.url}/mail/to-cloud`, { headers: { 'X-Mail-Token': 'x'.repeat(TOKEN.length) } });
    assert.equal(wrong.status, 401);
    const post = await fetch(`${c.url}/mail/to-cloud`, { method: 'POST', body: '{"from":"a","kind":"instruction","body":"x"}' });
    assert.equal(post.status, 401);
  });
  await withCoord(undefined, async (c) => {
    const r = await fetch(`${c.url}/mail/to-cloud`, { headers: { 'X-Mail-Token': TOKEN } });
    assert.equal(r.status, 404);
    assert.equal((await r.json()).error, 'mail-disabled');
  });
});

test('追加补 seq 与时间戳，按 after 取；两个队列各自编号', async () => {
  await withCoord({ token: TOKEN }, async (c) => {
    const mc = mailClient(c.url, TOKEN);
    const a = await mc.send('to-cloud', { from: 'local', kind: 'instruction', body: '第一条' });
    const b = await mc.send('to-cloud', { from: 'local', kind: 'question', body: { q: 1 } });
    const r = await mc.send('to-local', { from: 'cloud', kind: 'receipt', ref: a.seq, body: '收到' });
    assert.deepEqual([a.seq, b.seq, r.seq], [1, 2, 1]);
    const all = await mc.read('to-cloud', 0, 0);
    assert.equal(all.last, 2);
    assert.deepEqual(all.messages.map((m) => [m.seq, m.from, m.kind, m.ref, m.queue]), [[1, 'local', 'instruction', null, 'to-cloud'], [2, 'local', 'question', null, 'to-cloud']]);
    assert.ok(!Number.isNaN(Date.parse(all.messages[0].t)));
    assert.deepEqual((await mc.read('to-cloud', 1, 0)).messages.map((m) => m.seq), [2]);
    const back = await mc.read('to-local', 0, 0);
    assert.equal(back.messages[0].ref, 1);
    assert.equal(back.messages[0].body, '收到');
  });
});

test('长轮询：没有新消息就挂着，新消息一到就回', async () => {
  await withCoord({ token: TOKEN }, async (c) => {
    const mc = mailClient(c.url, TOKEN);
    const started = Date.now();
    const pending = mc.read('to-local', 0, 20);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(c.mailbox.summary()['to-local'].waiting, 1);
    await mc.send('to-local', { from: 'cloud', kind: 'receipt', body: 'ok' });
    const got = await pending;
    assert.equal(got.messages.length, 1);
    assert.ok(Date.now() - started < 5000);
    assert.equal(c.mailbox.summary()['to-local'].waiting, 0);
  });
});

test('挂起时长有上限，到时回空列表', async () => {
  await withCoord({ token: TOKEN, maxWaitMs: 200 }, async (c) => {
    const started = Date.now();
    const r = await mailClient(c.url, TOKEN).read('to-cloud', 0, 25);
    assert.deepEqual(r.messages, []);
    assert.equal(r.last, 0);
    assert.ok(Date.now() - started < 3000);
  });
});

test('信封校验：kind、from、ref、body、队列名', async () => {
  await withCoord({ token: TOKEN }, async (c) => {
    const post = (queue, body) => fetch(`${c.url}/mail/${queue}`, { method: 'POST', headers: { 'X-Mail-Token': TOKEN }, body: JSON.stringify(body) });
    const ok = { from: 'local', kind: 'instruction', body: 'x' };
    assert.equal((await post('to-cloud', { ...ok, kind: 'order' })).status, 400);
    assert.equal((await post('to-cloud', { ...ok, from: 'has space' })).status, 400);
    assert.equal((await post('to-cloud', { ...ok, ref: 0 })).status, 400);
    assert.equal((await post('to-cloud', { from: 'local', kind: 'instruction' })).status, 400);
    assert.equal((await post('nowhere', ok)).status, 404);
    assert.equal((await post('to-cloud', { ...ok, body: 'x'.repeat(300 * 1024) })).status, 413);
    assert.equal((await post('to-cloud', ok)).status, 200);
  });
});

test('给了文件就持久化，重启后 seq 接着编', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-'));
  const file = path.join(dir, 'mail.jsonl');
  try {
    await withCoord({ token: TOKEN, file }, async (c) => {
      const mc = mailClient(c.url, TOKEN);
      await mc.send('to-cloud', { from: 'local', kind: 'instruction', body: 'a' });
      await mc.send('to-cloud', { from: 'local', kind: 'instruction', body: 'b' });
    });
    assert.ok(!fs.readFileSync(file, 'utf8').includes(TOKEN));
    await withCoord({ token: TOKEN, file }, async (c) => {
      const mc = mailClient(c.url, TOKEN);
      assert.equal((await mc.read('to-cloud', 0, 0)).messages.length, 2);
      assert.equal((await mc.send('to-cloud', { from: 'local', kind: 'instruction', body: 'c' })).seq, 3);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('没开信箱时 KV 不要令牌（本机与局域网探针照旧）', async () => {
  await withCoord(undefined, async (c) => {
    const kv = coordClient(c.url, '');
    await kv.put('k', { v: 3 });
    assert.deepEqual(await kv.get('k'), { v: 3 });
  });
});

test('KV 照旧能用，healthz 带信箱摘要', async () => {
  await withCoord({ token: TOKEN }, async (c) => {
    const kv = coordClient(c.url, TOKEN);
    await kv.put('k', { v: 1 });
    assert.deepEqual(await kv.get('k'), { v: 1 });
    const h = await (await fetch(`${c.url}/healthz`)).json();
    assert.deepEqual(h.mail, { 'to-cloud': { last: 0, waiting: 0 }, 'to-local': { last: 0, waiting: 0 } });
  });
});

test('开了信箱时 KV 也要令牌；coordClient 带上令牌照常可用', async () => {
  await withCoord({ token: TOKEN }, async (c) => {
    assert.equal((await fetch(`${c.url}/kv/k?wait=0`)).status, 401);
    assert.equal((await fetch(`${c.url}/kv/k`, { method: 'PUT', body: '{}' })).status, 401);
    await assert.rejects(coordClient(c.url, '').put('k', { v: 1 }), /401/);
    const kv = coordClient(c.url, TOKEN);
    await kv.put('k', { v: 2 });
    assert.deepEqual(await kv.get('k'), { v: 2 });
  });
});

test('MB10 kind: status 能写进信箱并按 seq 读回（云端报到用）', async () => {
  await withCoord({ token: TOKEN }, async (c) => {
    const mc = mailClient(c.url, TOKEN);
    const s = await mc.send('to-local', { from: 'cloud', kind: 'status', body: { title: '云端会话', node: 'v24' } });
    assert.equal(s.seq, 1);
    const r = await mc.read('to-local', 0, 0);
    assert.deepEqual(r.messages.map((m) => [m.seq, m.from, m.kind, m.ref, m.queue]), [[1, 'cloud', 'status', null, 'to-local']]);
    assert.deepEqual(r.messages[0].body, { title: '云端会话', node: 'v24' });
  });
});

test('MB11 未知的 kind 仍回 400 bad-kind，不写进队列', async () => {
  await withCoord({ token: TOKEN }, async (c) => {
    const post = (kind) => fetch(`${c.url}/mail/to-local`, { method: 'POST', headers: { 'X-Mail-Token': TOKEN }, body: JSON.stringify({ from: 'cloud', kind, body: 'x' }) });
    for (const kind of ['report', 'STATUS', '', undefined]) {
      const r = await post(kind);
      assert.equal(r.status, 400);
      assert.equal((await r.json()).error, 'bad-kind');
    }
    assert.equal((await mailClient(c.url, TOKEN).read('to-local', 0, 0)).last, 0);
  });
});
