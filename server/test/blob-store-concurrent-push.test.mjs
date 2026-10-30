/**
 * 两路同时推同一份内容时，数据层不能把已经答过「收到」的分片又撤掉（claude/push-incomplete，
 * 报告 `docs/reports/AGENT-push-incomplete.md`）。
 *
 * 现场：渲染节点的产物库与本机推送队列几乎同时推同一段的块。A 传完第 0 片（已回 200）、正要收尾时，
 * B 也来传第 0 片：原实现在 B 写之前先撤掉第 0 片的标记，A 的 `complete` 于是回 `incomplete`。
 * 这里用可控的 source 把这两种交错各摆一遍，三种数据层（memory、fs 原布局、fs 分目录）都跑。
 *
 * 跑：node --test server/test/blob-store-concurrent-push.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { PassThrough } from 'node:stream';
import { createMemoryStore, createFsStore } from '../asset-store/index.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-concurrent-push-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const CS = 16;
let seq = 0;
const kinds = {
  memory: () => createMemoryStore({ chunkSize: CS }),
  'fs-flat': () => createFsStore({ dir: path.join(TMP, `flat-${seq++}`), chunkSize: CS }),
  'fs-shard': () => createFsStore({ dir: path.join(TMP, `shard-${seq++}`), chunkSize: CS, shard: true }),
};

/** 等数据层把这个 source 开始读（说明 putChunk 已经过了登记那一步） */
function controlled() {
  const src = new PassThrough();
  const started = new Promise((resolve) => {
    const origRead = src._read.bind(src);
    src._read = (n) => { resolve(); return origRead(n); };
    src.once('resume', resolve);
  });
  return { src, started };
}
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

async function readAll(stream) {
  const parts = [];
  for await (const c of stream) parts.push(c);
  return Buffer.concat(parts);
}

for (const [kind, make] of Object.entries(kinds)) {
  test(`${kind}：A 已收到第 0 片，B 重传同一片还没写完时，A 收尾不回 incomplete`, async () => {
    const store = make();
    const buf = crypto.randomBytes(CS * 2 + 5);
    const h = sha256(buf);
    const meta = { size: buf.length, ext: 'webp' };
    for (let n = 0; n < 3; n++) {
      assert.equal((await store.putChunk(h, n, meta, [buf.subarray(n * CS, Math.min(buf.length, (n + 1) * CS))])).status, 'ok');
    }
    // B 重传第 0 片，字节还在路上
    const b = controlled();
    const bDone = store.putChunk(h, 0, meta, b.src);
    await Promise.race([b.started, tick(200)]);
    await tick();
    assert.deepEqual((await store.chunks(h)).received, [0, 1, 2], '已收到的片不因重传而撤掉');
    const done = await store.complete(h);
    assert.equal(done.status, 'ok', `A 收尾：${JSON.stringify(done)}`);
    b.src.end(buf.subarray(0, CS));
    const bRes = await bDone;
    assert.ok(bRes.status === 'ok' || bRes.status === 'complete', `B 的重传：${JSON.stringify(bRes)}`);
    assert.equal(sha256(await readAll(await store.read(h))), h);
  });

  test(`${kind}：A、B 同时传第 0 片，A 先写完并收尾入库，B 写完回 complete 而不是 discarded`, async () => {
    const store = make();
    const buf = crypto.randomBytes(CS - 3);
    const h = sha256(buf);
    const meta = { size: buf.length, ext: 'webp' };
    const b = controlled();
    const bDone = store.putChunk(h, 0, meta, b.src);
    await Promise.race([b.started, tick(200)]);
    await tick();
    assert.equal((await store.putChunk(h, 0, meta, [buf])).status, 'ok');
    const done = await store.complete(h);
    assert.equal(done.status, 'ok', `A 收尾：${JSON.stringify(done)}`);
    b.src.end(buf);
    const bRes = await bDone;
    assert.ok(bRes.status === 'ok' || bRes.status === 'complete', `B：${JSON.stringify(bRes)}`);
    assert.equal(sha256(await readAll(await store.read(h))), h);
    assert.equal((await store.chunks(h)).complete, true);
  });

  test(`${kind}：已收到的片重传时断流，标记保留（存着的字节没被碰过）`, async () => {
    const store = make();
    const buf = crypto.randomBytes(CS + 4);
    const h = sha256(buf);
    const meta = { size: buf.length, ext: 'webp' };
    assert.equal((await store.putChunk(h, 0, meta, [buf.subarray(0, CS)])).status, 'ok');
    assert.equal((await store.putChunk(h, 1, meta, [buf.subarray(CS)])).status, 'ok');
    const broken = (async function* () { yield buf.subarray(0, 5); throw new Error('断线'); })();
    await assert.rejects(store.putChunk(h, 0, meta, broken));
    assert.deepEqual((await store.chunks(h)).received, [0, 1]);
    assert.equal((await store.complete(h)).status, 'ok');
    assert.equal(sha256(await readAll(await store.read(h))), h);
  });
}
