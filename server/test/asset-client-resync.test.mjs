/**
 * 素材服务客户端：`complete` 回 400 `incomplete` 时重问 `chunks`、补传缺的片再收尾（claude/push-incomplete，
 * 报告 `docs/reports/AGENT-push-incomplete.md`）。老的素材服务在两路同时推同一内容时会撤掉另一路已答过「收到」的片，
 * 这一步是客户端的兜底。
 *
 * 跑：node --test server/test/asset-client-resync.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { createAssetClient, INCOMPLETE_RESYNC_ROUNDS } from '../asset-store/client.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-client-resync-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const CS = 8;

/**
 * 假素材服务：`dropOnComplete` 次 `complete` 前把第 0 片撤掉（模拟另一路的重传撤了标记），回 400 incomplete。
 * `completeAfterChunks`：重问 chunks 时直接当作别人已收尾入库。
 */
function fakeService({ dropOnComplete = 1, completeAfterChunks = false } = {}) {
  const parts = new Map();
  let done = false;
  let drops = dropOnComplete;
  let chunkCalls = 0;
  const log = [];
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetch = async (url, init = {}) => {
    const { pathname } = new URL(url);
    const m = /\/api\/asset\/px\/([0-9a-f]{64})\/(chunks|complete|\d+)$/.exec(pathname);
    const method = init.method || 'GET';
    log.push(`${method} ${m?.[2]}`);
    if (!m) return json(404, { ok: false });
    const size = Number(init.headers?.['X-Media-Size'] ?? 0) || null;
    if (m[2] === 'chunks') {
      chunkCalls++;
      if (completeAfterChunks && chunkCalls > 1) done = true;
      return json(200, { size, chunkSize: CS, received: done ? [] : [...parts.keys()].sort((a, b) => a - b), complete: done });
    }
    if (m[2] === 'complete') {
      if (done) return json(200, { ok: true, complete: true });
      if (drops > 0) { drops--; parts.delete(0); return json(400, { ok: false, error: 'incomplete', missing: [0] }); }
      const total = [...parts.keys()].sort((a, b) => a - b).map((k) => parts.get(k));
      if (sha256(Buffer.concat(total)) !== m[1]) return json(400, { ok: false, error: 'incomplete', missing: [] });
      done = true;
      return json(200, { ok: true, complete: true });
    }
    parts.set(Number(m[2]), Buffer.from(init.body));
    return json(200, { ok: true });
  };
  return { fetch, log };
}

test('put：complete 回 incomplete 后补传缺的片、再收尾成功', async () => {
  const svc = fakeService({ dropOnComplete: 1 });
  const client = createAssetClient({ base: 'http://x/api/asset', fetch: svc.fetch, retries: 0 });
  const buf = crypto.randomBytes(CS * 2 + 3);
  const out = await client.put('px', buf, { ext: 'webp' });
  assert.equal(out.uploaded, true);
  assert.deepEqual(svc.log, ['GET chunks', 'PUT 0', 'PUT 1', 'PUT 2', 'POST complete', 'GET chunks', 'PUT 0', 'POST complete']);
});

test('putFile：同上，并把补传的片记进 sent', async () => {
  const svc = fakeService({ dropOnComplete: 1 });
  const client = createAssetClient({ base: 'http://x/api/asset', fetch: svc.fetch, retries: 0 });
  const buf = crypto.randomBytes(CS + 1);
  const file = path.join(TMP, 'a.bin');
  fs.writeFileSync(file, buf);
  const out = await client.putFile('px', file, { hash: sha256(buf), ext: 'webp' });
  assert.deepEqual(out.sent, [0, 1, 0]);
});

test('重问 chunks 时已被别人收尾入库：直接算成', async () => {
  const svc = fakeService({ dropOnComplete: 1, completeAfterChunks: true });
  const client = createAssetClient({ base: 'http://x/api/asset', fetch: svc.fetch, retries: 0 });
  const out = await client.put('px', crypto.randomBytes(5));
  assert.equal(out.uploaded, true);
  assert.deepEqual(svc.log, ['GET chunks', 'PUT 0', 'POST complete', 'GET chunks']);
});

test(`补 ${INCOMPLETE_RESYNC_ROUNDS} 轮仍不齐：照 400 抛`, async () => {
  const svc = fakeService({ dropOnComplete: 99 });
  const client = createAssetClient({ base: 'http://x/api/asset', fetch: svc.fetch, retries: 0 });
  await assert.rejects(client.put('px', crypto.randomBytes(5)), (err) => err.status === 400 && err.body?.error === 'incomplete');
  assert.equal(svc.log.filter((l) => l === 'POST complete').length, INCOMPLETE_RESYNC_ROUNDS + 1);
});
