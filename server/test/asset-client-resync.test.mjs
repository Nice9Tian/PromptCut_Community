/**
 * Asset service client: when `complete` returns 400 `incomplete`, re-query `chunks`, upload
 * missing chunks, then finalize (claude/push-incomplete, report
 * `docs/reports/AGENT-push-incomplete.md`). When two paths push the same content concurrently,
 * the legacy asset service drops chunks the other path had acknowledged as "received";
 * this step is the client fallback.
 *
 * Run: node --test server/test/asset-client-resync.test.mjs
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
 * Fake asset service: drops chunk 0 before `complete` for `dropOnComplete` times (simulating
 * retransmission on the other path revoking the mark), returns 400 incomplete.
 * `completeAfterChunks`: when re-querying chunks, treat directly as already finalized and stored
 * by others.
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

test('put: after complete returns incomplete, re-upload the missing chunks, then finalize successfully', async () => {
  const svc = fakeService({ dropOnComplete: 1 });
  const client = createAssetClient({ base: 'http://x/api/asset', fetch: svc.fetch, retries: 0 });
  const buf = crypto.randomBytes(CS * 2 + 3);
  const out = await client.put('px', buf, { ext: 'webp' });
  assert.equal(out.uploaded, true);
  assert.deepEqual(svc.log, ['GET chunks', 'PUT 0', 'PUT 1', 'PUT 2', 'POST complete', 'GET chunks', 'PUT 0', 'POST complete']);
});

test('putFile: same as above, and records the re-uploaded chunks in sent', async () => {
  const svc = fakeService({ dropOnComplete: 1 });
  const client = createAssetClient({ base: 'http://x/api/asset', fetch: svc.fetch, retries: 0 });
  const buf = crypto.randomBytes(CS + 1);
  const file = path.join(TMP, 'a.bin');
  fs.writeFileSync(file, buf);
  const out = await client.putFile('px', file, { hash: sha256(buf), ext: 'webp' });
  assert.deepEqual(out.sent, [0, 1, 0]);
});

test('when chunks is queried again it has already been finalized and stored by someone else: counts as success right away', async () => {
  const svc = fakeService({ dropOnComplete: 1, completeAfterChunks: true });
  const client = createAssetClient({ base: 'http://x/api/asset', fetch: svc.fetch, retries: 0 });
  const out = await client.put('px', crypto.randomBytes(5));
  assert.equal(out.uploaded, true);
  assert.deepEqual(svc.log, ['GET chunks', 'PUT 0', 'POST complete', 'GET chunks']);
});

test(`still incomplete after ${INCOMPLETE_RESYNC_ROUNDS} resync rounds: throws as 400`, async () => {
  const svc = fakeService({ dropOnComplete: 99 });
  const client = createAssetClient({ base: 'http://x/api/asset', fetch: svc.fetch, retries: 0 });
  await assert.rejects(client.put('px', crypto.randomBytes(5)), (err) => err.status === 400 && err.body?.error === 'incomplete');
  assert.equal(svc.log.filter((l) => l === 'POST complete').length, INCOMPLETE_RESYNC_ROUNDS + 1);
});
