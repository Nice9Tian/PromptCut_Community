/**
 * C6.6 upload queue (`docs/plan/c66-design.md` Section 2 "records in the project", Section 3;
 * acceptance check T2, T3).
 * Run: node --test server/test/c66-upload.test.mjs
 *
 * Written purely against the design doc without inspecting implementation. Name and shape of
 * the queue are assumption K2 (see file header of `c66-kit.mjs`).
 * The asset service is real HTTP (`fake-asset-service.mjs`, in-memory implementation, 64 KiB
 * chunks); every request from the queue goes through a recording `fetch`, where order, chunk
 * numbers, and network disconnections are inspected and simulated. Asset bytes are pseudorandom
 * data (the queue does not inspect content, only transmits by hash).
 * When the module under test is absent, each test case fails individually and reports the reason.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createAssetHarness } from './fake-asset-service.mjs';
import {
  ROOT, tempDir, sha256, bytesOf, recordingFetch, chunksOf, loadUploadQueue, sleep,
} from './c66-kit.mjs';

const CHUNK = 64 * 1024;
const harness = createAssetHarness();
const DIR = tempDir('pc-c66-upload-');
after(async () => { await harness.cleanup(); fs.rmSync(DIR, { recursive: true, force: true }); });

let seq = 0;
/** Writes a pseudorandom file, returning `{ hash, path, ext, size, bytes }` */
function file(size, ext = 'mp4') {
  const bytes = bytesOf(size, ++seq * 7919);
  const p = path.join(DIR, `f${seq}.${ext}`);
  fs.writeFileSync(p, bytes);
  return { hash: sha256(bytes), path: p, ext, size, bytes };
}
const tier = ({ hash, path: p, ext }) => ({ hash, path: p, ext });
const chunkCount = (f) => Math.ceil(f.size / CHUNK);

/** Three assets: A and B are videos (two tiers), C is an image (original-size asset only) */
function materials() {
  const A = { small: file(150 * 1024), original: file(600 * 1024) };
  const B = { small: file(100 * 1024), original: file(300 * 1024) };
  const C = { original: file(70 * 1024, 'png') };
  const items = [
    { id: 'A', tiers: { small: tier(A.small), original: tier(A.original) } },
    { id: 'B', tiers: { small: tier(B.small), original: tier(B.original) } },
    { id: 'C', tiers: { original: tier(C.original) } },
  ];
  return { A, B, C, items };
}

/**
 * Only inspects write requests (PUT chunks, POST complete), and merges consecutive identical
 * hashes into a segment: [{ hash, puts: [n...], completed }]
 */
function writeRuns(log) {
  const runs = [];
  for (const e of log) {
    if (e.ns !== 'media' || (e.action !== 'put' && e.action !== 'complete')) continue;
    let last = runs[runs.length - 1];
    if (!last || last.hash !== e.hash) { last = { hash: e.hash, puts: [], completed: false }; runs.push(last); }
    if (e.action === 'put') last.puts.push(e.n);
    else last.completed = true;
  }
  return runs;
}

let qseq = 0;
const queueFile = () => path.join(DIR, `upload-queue-${++qseq}.json`);

async function drainWithin(q, ms) {
  let settled = false;
  const p = q.drain().then(() => { settled = true; }, () => { settled = true; });
  await Promise.race([p, sleep(ms)]);
  return settled;
}

// ------------------------------------------------------------------ T3

test('C66-T3-01 all small-size assets upload first, then original-size assets in queue order; the next tier is written only after the previous tier is complete', async () => {
  const createQueue = await loadUploadQueue();
  const srv = await harness.serve({ chunkSize: CHUNK, isTrusted: () => true });
  const rec = recordingFetch();
  const { A, B, C, items } = materials();
  const q = createQueue({ file: queueFile(), base: srv.base, fetch: rec.fetch, chunkSize: CHUNK });
  for (const it of items) await q.enqueue(it);
  assert.equal(await drainWithin(q, 20_000), true, 'drain must finish within 20 s');
  await q.close();

  const runs = writeRuns(rec.log);
  const order = [A.small, B.small, A.original, B.original, C.original];
  assert.deepEqual(runs.map((r) => r.hash), order.map((f) => f.hash),
    `write requests must appear in runs in the order "A small, B small, A original, B original, C original", not interleaved; actual run order: ${runs.map((r) => r.hash.slice(0, 6)).join(' → ')}`);
  runs.forEach((r, i) => {
    assert.equal(r.completed, true, `run ${i + 1} (${r.hash.slice(0, 6)}) ends with complete`);
    assert.deepEqual([...new Set(r.puts)].sort((a, b) => a - b), [...Array(chunkCount(order[i])).keys()], `run ${i + 1} uploads all chunks`);
  });
  // In each segment, complete is the last write request
  const writes = rec.log.filter((e) => e.ns === 'media' && (e.action === 'put' || e.action === 'complete'));
  for (const f of order) {
    const idx = writes.map((e, i) => (e.hash === f.hash ? i : -1)).filter((i) => i >= 0);
    assert.equal(writes[idx[idx.length - 1]].action, 'complete', `the last write request of ${f.hash.slice(0, 6)} is complete`);
  }
  for (const f of order) assert.equal((await chunksOf(srv.base, f.hash)).complete, true, `${f.hash.slice(0, 6)} is complete on the asset service`);
  await srv.close();
});

// ------------------------------------------------------------------ T2

test('C66-T2-01 network lost during upload, resume after restart: a new queue built from the same upload-queue.json uploads only the missing chunks; chunks of the small-size asset and the original-size asset each report complete', async () => {
  const createQueue = await loadUploadQueue();
  const srv = await harness.serve({ chunkSize: CHUNK, isTrusted: () => true });
  const { A, B, C, items } = materials();
  const qf = queueFile();

  // First instance: original-size asset A disconnects after transmitting 3 chunks and remains
  // disconnected afterwards (this instance does not recover, simulating a killed process)
  let aOrigPuts = 0;
  const rec1 = recordingFetch((info, _log, state) => {
    if (info.action === 'put' && info.hash === A.original.hash && ++aOrigPuts > 3) {
      state.offline = true;
      throw new TypeError('fetch failed (test network outage)');
    }
    return undefined;
  });
  const q1 = createQueue({ file: qf, base: srv.base, fetch: rec1.fetch, chunkSize: CHUNK });
  for (const it of items) await q1.enqueue(it);
  await drainWithin(q1, 3000);
  await q1.close();

  assert.ok(fs.existsSync(qf), 'upload-queue.json must be written to disk');
  assert.equal((await chunksOf(srv.base, A.small.hash)).complete, true, 'A\'s small-size asset had already finished uploading before the network was cut');
  const mid = await chunksOf(srv.base, A.original.hash);
  assert.equal(mid.complete, false, 'A\'s original-size asset had not finished uploading when the network was cut');
  const received = new Set(mid.received);
  assert.ok(received.size >= 1 && received.size < chunkCount(A.original), `A's original-size asset received only some of its chunks: ${[...received]}`);
  assert.equal((await chunksOf(srv.base, B.small.hash)).complete, true, 'B\'s small-size asset had also finished uploading before the network was cut (all small-size assets come before any original-size asset)');
  for (const f of [B.original, C.original]) {
    assert.equal((await chunksOf(srv.base, f.hash)).received.length, 0, `before A's original-size asset was done, not a single chunk of B's and C's original-size assets was uploaded (${f.hash.slice(0, 6)})`);
  }

  // Second instance: same queue file, no further enqueue, network normal
  const rec2 = recordingFetch();
  const q2 = createQueue({ file: qf, base: srv.base, fetch: rec2.fetch, chunkSize: CHUNK });
  assert.equal(await drainWithin(q2, 20_000), true, 'resume must finish within 20 s');
  await q2.close();

  const puts = (f) => rec2.log.filter((e) => e.action === 'put' && e.hash === f.hash).map((e) => e.n);
  assert.deepEqual(puts(A.small), [], 'A\'s small-size asset that is already complete is not re-uploaded');
  assert.deepEqual(puts(B.small), [], 'B\'s small-size asset that is already complete is not re-uploaded');
  const missing = [...Array(chunkCount(A.original)).keys()].filter((n) => !received.has(n));
  assert.deepEqual([...puts(A.original)].sort((a, b) => a - b), missing, 'A\'s original-size asset uploads only the missing chunks, each once');
  const runs = writeRuns(rec2.log).map((r) => r.hash);
  assert.deepEqual(runs, [A.original.hash, B.original.hash, C.original.hash], 'resume follows "A original, B original, C original" (both small-size assets finished uploading before the restart)');

  for (const [name, f] of Object.entries({ 'A\'s small-size asset': A.small, 'A\'s original-size asset': A.original, 'B\'s small-size asset': B.small, 'B\'s original-size asset': B.original, 'C\'s original-size asset': C.original })) {
    const st = await chunksOf(srv.base, f.hash);
    assert.equal(st.complete, true, `GET media/<hash>/chunks for ${name} reports complete: true`);
  }

  // Dequeues only when both tiers are complete: launch another instance and write nothing
  const rec3 = recordingFetch();
  const q3 = createQueue({ file: qf, base: srv.base, fetch: rec3.fetch, chunkSize: CHUNK });
  assert.equal(await drainWithin(q3, 5000), true);
  await q3.close();
  assert.deepEqual(rec3.log.filter((e) => e.action === 'put' || e.action === 'complete'), [], 'the queue is empty: starting another instance sends no write requests');
  await srv.close();
});

test('C66-T2-02 a tier that is already complete on the asset service is not re-uploaded (skipped once chunks has been queried)', async () => {
  const createQueue = await loadUploadQueue();
  const srv = await harness.serve({ chunkSize: CHUNK, isTrusted: () => true });
  const { A, items } = materials();
  // Prepopulate small-size asset A into asset service in advance
  const st = srv.stores.media;
  for (let n = 0; n < chunkCount(A.small); n++) {
    const part = A.small.bytes.subarray(n * CHUNK, Math.min(A.small.size, (n + 1) * CHUNK));
    const r = await st.putChunk(A.small.hash, n, { size: A.small.size, ext: 'mp4' }, [part]);
    assert.equal(r.status, 'ok');
  }
  assert.equal((await st.complete(A.small.hash)).status, 'ok');
  const rec = recordingFetch();
  const q = createQueue({ file: queueFile(), base: srv.base, fetch: rec.fetch, chunkSize: CHUNK });
  await q.enqueue(items[0]);
  assert.equal(await drainWithin(q, 20_000), true);
  await q.close();
  assert.deepEqual(rec.log.filter((e) => e.action === 'put' && e.hash === A.small.hash), [], 'an already complete small-size asset uploads not a single chunk');
  assert.equal((await chunksOf(srv.base, A.original.hash)).complete, true);
  await srv.close();
});

test('C66-T2-03 sync state does not enter the project: MediaTiers has only small / original, and MediaAsset has no upload, sync or playability fields', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'kernel', 'project.ts'), 'utf8');
  const fieldsOf = (name) => {
    const m = new RegExp(`export interface ${name}\\s*\\{`).exec(src);
    assert.ok(m, `project.ts must have interface ${name}`);
    // Find the matching closing curly brace
    let depth = 0, i = m.index + m[0].length - 1, end = -1;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) { end = i; break; }
    }
    const body = src.slice(m.index + m[0].length, end).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    // Only get top-level field names
    const names = [];
    let d = 0;
    for (const line of body.split('\n')) {
      const hit = d === 0 ? /^\s*([A-Za-z_$][\w$]*)\??\s*:/.exec(line) : null;
      if (hit) names.push(hit[1]);
      d += (line.match(/[{(<[]/g) ?? []).length - (line.match(/[})>\]]/g) ?? []).length;
    }
    return names;
  };
  assert.deepEqual(fieldsOf('MediaTiers').sort(), ['original', 'small'], 'MediaTiers has only the hashes of the two tiers');
  const bad = fieldsOf('MediaAsset').filter((n) => /upload|sync|complete|received|chunk|playab|progress|queue|transfer/i.test(n));
  assert.deepEqual(bad, [], `MediaAsset must not have sync state / playability fields: ${bad.join(', ')}`);
});
