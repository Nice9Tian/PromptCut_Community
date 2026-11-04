/**
 * Asset sink `createAssetSink().has` requires all chunks present on asset service even when local
 * frame store covers the entire segment (`docs/archive/agent-reports/AGENT-sink-has.md`).
 * Run: npm test, or node --test server/test/sink-has.test.mjs
 *
 * Semantics: `product/document-service.md` "Completion: node first pushes assets to asset service,
 * then reports completion to document service"; criterion for E3 "items already in asset service
 * complete directly without rerendering".
 *
 *   H1  Local frame store has them, asset service missing half the chunks: has pushes missing
 *       chunks using local bytes (skipping existing ones) and returns true; chunks complete on
 *       asset service, manifest written to content store
 *   H2  Local frame store has them, chunks complete on asset service: has returns true without
 *       pushing any chunks (query only)
 *   H3  Catch-up push fails: has returns false (delegated to execution → put pushes again), logs a
 *       line sink.has-push-failed
 *   H4  End-to-end "lose claim halfway through push, re-claim by itself": real queue + real node
 *       arrangement + real asset sink; first push gets stuck halfway and is reclaimed as stalled,
 *       same node re-claims: completed via deduplication, executor does not rerender, and chunks
 *       for this segment are all present on asset service
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { createAssetSink } from '../artifact-transfer.mjs';
import { createRenderQueue } from '../render-queue/index.mjs';
import { createLocalNode } from '../render-node/local-node.mjs';
import { createLoopback } from './fake-loopback-transport.mjs';
import { createTimerClock } from './fake-render-executor.mjs';

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/** Frame store stand-in: directory + mutable index (frames range) */
function frameLibrary() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-sink-has-'));
  const index = { frames: [], oversize: [] };
  return {
    root,
    write(from, to) {
      for (let f = from; f <= to; f++) fs.writeFileSync(path.join(root, `${f}.html`), `<div>frame ${f}</div>`);
      index.frames = [[0, to]];
    },
    pipeline: {
      snapshots: () => ({ snapshotIndex: async () => ({ frames: index.frames.map((r) => [...r]), oversize: [] }), dir: () => root }),
      whenSmallSettled: async () => {},
    },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * Asset service stand-in (content-addressed, same as put in `asset-store/client.mjs`: returns
 * uploaded:false for existing items).
 * `hangAfter`: when set, hangs all subsequent puts after receiving this many chunks (simulates
 * getting stuck halfway through push); resumes normal operation after `release()`.
 */
function assetStore({ hangAfter = null, failAll = false } = {}) {
  const blocks = new Map();
  const calls = { put: 0, uploaded: 0, has: 0 };
  let hanging = hangAfter !== null;
  return {
    blocks, calls,
    release() { hanging = false; },
    preload(bufs) { for (const b of bufs) blocks.set(sha256(b), b); },
    async put(ns, bytes) {
      calls.put += 1;
      const hash = sha256(bytes);
      if (failAll) throw Object.assign(new Error('Asset service PUT timed out'), { code: 'timeout' });
      if (blocks.has(hash)) return { hash, size: bytes.length, uploaded: false };
      if (hanging && calls.uploaded >= hangAfter) return new Promise(() => {});
      calls.uploaded += 1;
      blocks.set(hash, Buffer.from(bytes));
      return { hash, size: bytes.length, uploaded: true };
    },
    async has(ns, hash) { calls.has += 1; return blocks.has(hash); },
  };
}

function contentStore() {
  const items = new Map();
  return { items, async put(kind, key, body) { items.set(`${kind}|${key}`, body); }, async get(kind, key) { const body = items.get(`${kind}|${key}`); return body ? { body } : null; } };
}

const RESULT_KEY = sha256('rk:sink-has');
const refOf = (from, to) => ({ kind: 'snapshot', tier: 'shared', resultKey: RESULT_KEY, range: { unit: 'localFrame', from, to } });
const frameBytes = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => Buffer.from(`<div>frame ${from + i}</div>`));

test('H1 local frame store has it, asset service is missing half the chunks: has pushes the missing chunks (skipping existing ones) then returns true, and the manifest is written to the content store', async () => {
  const lib = frameLibrary();
  try {
    lib.write(0, 7);
    const store = assetStore();
    store.preload(frameBytes(0, 3));
    const content = contentStore();
    const sink = createAssetSink({ pipeline: lib.pipeline, client: store, content });
    assert.equal(await sink.has(refOf(0, 7)), true);
    for (const b of frameBytes(0, 7)) assert.ok(store.blocks.has(sha256(b)), 'All chunks of this segment are on the asset service');
    assert.equal(store.calls.uploaded, 4, 'Only the 4 missing chunks are pushed');
    assert.equal(content.items.size, 1, 'The manifest is written to the content store');
    const manifest = await sink.resultFor(refOf(0, 7));
    assert.equal(manifest.frames.length, 8, 'resultFor returns the manifest of this segment');
  } finally { lib.cleanup(); }
});

test('H2 local frame store has it, asset service has all chunks: has returns true, no chunk is pushed', async () => {
  const lib = frameLibrary();
  try {
    lib.write(0, 7);
    const store = assetStore();
    store.preload(frameBytes(0, 7));
    const sink = createAssetSink({ pipeline: lib.pipeline, client: store });
    assert.equal(await sink.has(refOf(0, 7)), true);
    assert.equal(store.calls.uploaded, 0);
  } finally { lib.cleanup(); }
});

test('H3 backfill push failed: has returns false and logs a sink.has-push-failed line', async () => {
  const lib = frameLibrary();
  try {
    lib.write(0, 7);
    const store = assetStore({ failAll: true });
    const logs = [];
    const sink = createAssetSink({ pipeline: lib.pipeline, client: store, log: (event, fields) => logs.push({ event, fields }) });
    assert.equal(await sink.has(refOf(0, 7)), false);
    const line = logs.find((l) => l.event === 'sink.has-push-failed');
    assert.ok(line, `Logs a sink.has-push-failed line: ${JSON.stringify(logs)}`);
    assert.equal(line.fields.code, 'timeout');
  } finally { lib.cleanup(); }
});

/* ================================================================== H4 */

test('H4 claim lost halfway through pushing, same node claims again: completes via dedup, the executor does not render again, and the asset service has all chunks', async () => {
  const lib = frameLibrary();
  try {
    const clock = createTimerClock();
    const lb = createLoopback();
    const queue = createRenderQueue({ now: clock.now, send: lb.queueSend, epoch: 'sink-has' });
    lb.attach(queue);
    const page = lb.connect('page', { userId: 'alice', tenantId: 'p' });
    const inbox = [];
    page.onMessage((m) => inbox.push(m));
    page.send({ type: 'publisher.hello', publisherId: 'page-1' });

    // Executor: writes frames of this segment into frame store (batches of 4 frames, reports progress)
    const renders = [];
    const executor = {
      async render(task, { progress }) {
        renders.push(task.id);
        const { from, to } = task.range;
        lib.write(from, to);
        progress?.(to - from + 1);
        return null;
      },
    };
    const store = assetStore({ hangAfter: 30 });
    const content = contentStore();
    const sink = createAssetSink({ pipeline: lib.pipeline, client: store, content });
    const ep = lb.connect('conn-n', { userId: 'alice', tenantId: 'p' });
    const events = [];
    const local = createLocalNode({
      nodeId: 'pc-1', node: { profile: 'pc', envFingerprint: null, codeVersions: ['cv'], cardSourceVersions: {}, capabilities: { userCards: true } },
      endpoint: ep, now: clock.now, random: () => 0, maxConcurrent: 1, codeVersion: 'cv', executor, sink,
      onEvent: (e) => { events.push(e); if (e.type === 'lost') store.release(); },
    });
    local.start();
    const task = {
      id: `snapshot:${RESULT_KEY}:0-59`, kind: 'snapshot', tier: 'shared', resultKey: RESULT_KEY,
      range: { unit: 'localFrame', from: 0, to: 59 }, source: { projectId: 'p', projectRev: 1 },
      input: { clipId: 'c', contentKey: sha256('ck') }, weight: { class: 'medium' }, requires: { codeVersion: 'cv' }, priority: 1,
    };
    page.send({ type: 'task.publish', tasks: [task] });

    const settle = async () => {
      for (let i = 0; i < 1000; i++) {
        lb.flush();
        for (let k = 0; k < 3; k++) await new Promise((r) => setImmediate(r));
        if (lb.pending() === 0) return;
      }
      throw new Error('Did not converge');
    };
    const done = () => inbox.some((m) => m.type === 'task.done' && m.id === task.id);
    for (let i = 0; i < 2000 && !done(); i++) {
      await settle(); local.tick(); await settle(); queue.tick(); await settle();
      // Asset sink reads real files: let real I/O settle on each tick before advancing fake clock;
      // otherwise fake clock ticks away in vain during file reads, measuring test runner timing skew
      await new Promise((r) => setTimeout(r, 5));
      await settle();
      clock.advance(500);
    }
    const lost = events.filter((e) => e.type === 'lost');
    assert.equal(lost.length, 1, `Stalled halfway through pushing, reclaimed once due to the stall: ${JSON.stringify(lost.map((e) => [e.reason, e.phase]))}`);
    assert.equal(lost[0].phase, 'push');
    assert.ok(done(), 'Completed after re-claim');
    const claims = lb.log().filter((e) => e.dir === 'out' && e.message.type === 'task.claimed' && e.message.id === task.id);
    assert.equal(claims.length, 2, 'The same node claimed twice');
    assert.deepEqual(renders, [task.id], 'The second time did not render again (went through dedup)');
    assert.ok(events.some((e) => e.type === 'dedup' && e.id === task.id), 'The second time completed via dedup');
    const missing = frameBytes(0, 59).filter((b) => !store.blocks.has(sha256(b))).length;
    assert.equal(missing, 0, `All chunks of this segment should be on the asset service, ${missing} chunks missing`);
    await local.stop();
  } finally { lib.cleanup(); }
});
