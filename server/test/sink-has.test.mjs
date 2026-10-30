/**
 * 产物库 `createAssetSink().has` 在本机帧库覆盖整段时也要素材服务上块齐(`docs/archive/agent-reports/AGENT-sink-has.md`)。
 * 跑:npm test,或 node --test server/test/sink-has.test.mjs
 *
 * 语义:`product/document-service.md`「完成:节点先把产物推送到素材服务,再向文档服务报完成」;E3 的判据
 * 「已经在素材服务里的直接完成、不重渲」。
 *
 *   H1  本机帧库有、素材服务上缺一半块:has 把缺的块用本机字节补推(已有的跳过),回 true;素材服务上块齐,清单写进内容库
 *   H2  本机帧库有、素材服务上块齐:has 回 true,一块都不推(只问)
 *   H3  补推失败:has 回 false(交给执行 → put 再推),记一行 sink.has-push-failed
 *   H4  端到端「推到一半丢认领、自己重新认领」:真队列 + 真节点编排 + 真产物库;第一次推到一半卡住、按停滞收回,
 *       同一节点重新认领 —— 以去重完成、执行器没再渲,且素材服务上这一段的块全齐
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

/** 帧库替身:目录 + 可变的 index(frames 区间) */
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
 * 素材服务替身(按内容寻址,同 `asset-store/client.mjs` 的 put:已有的回 uploaded:false)。
 * `hangAfter`:设了就在收下这么多块之后,之后的 put 一律挂住(模拟推到一半卡住);`release()` 之后恢复正常。
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
      if (failAll) throw Object.assign(new Error('素材服务 PUT 超时'), { code: 'timeout' });
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

test('H1 本机帧库有、素材服务上缺一半块:has 补推缺的块(已有的跳过)后回 true,清单写进内容库', async () => {
  const lib = frameLibrary();
  try {
    lib.write(0, 7);
    const store = assetStore();
    store.preload(frameBytes(0, 3));
    const content = contentStore();
    const sink = createAssetSink({ pipeline: lib.pipeline, client: store, content });
    assert.equal(await sink.has(refOf(0, 7)), true);
    for (const b of frameBytes(0, 7)) assert.ok(store.blocks.has(sha256(b)), '素材服务上这一段的块齐了');
    assert.equal(store.calls.uploaded, 4, '只推缺的 4 块');
    assert.equal(content.items.size, 1, '清单写进内容库');
    const manifest = await sink.resultFor(refOf(0, 7));
    assert.equal(manifest.frames.length, 8, 'resultFor 回这一段的清单');
  } finally { lib.cleanup(); }
});

test('H2 本机帧库有、素材服务上块齐:has 回 true,一块都不推', async () => {
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

test('H3 补推失败:has 回 false,记一行 sink.has-push-failed', async () => {
  const lib = frameLibrary();
  try {
    lib.write(0, 7);
    const store = assetStore({ failAll: true });
    const logs = [];
    const sink = createAssetSink({ pipeline: lib.pipeline, client: store, log: (event, fields) => logs.push({ event, fields }) });
    assert.equal(await sink.has(refOf(0, 7)), false);
    const line = logs.find((l) => l.event === 'sink.has-push-failed');
    assert.ok(line, `记一行 sink.has-push-failed:${JSON.stringify(logs)}`);
    assert.equal(line.fields.code, 'timeout');
  } finally { lib.cleanup(); }
});

/* ================================================================== H4 */

test('H4 推到一半丢认领、同一节点重新认领:以去重完成、执行器没再渲,素材服务上块齐', async () => {
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

    // 执行器:把这一段的帧写进帧库(每 4 帧一批、报进度)
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
      throw new Error('不收敛');
    };
    const done = () => inbox.some((m) => m.type === 'task.done' && m.id === task.id);
    for (let i = 0; i < 2000 && !done(); i++) {
      await settle(); local.tick(); await settle(); queue.tick(); await settle();
      // 产物库读的是真文件:每拍让真 I/O 落定再推进假时钟,不然读文件的那几拍假时钟白白走过,测到的是测试台的时差
      await new Promise((r) => setTimeout(r, 5));
      await settle();
      clock.advance(500);
    }
    const lost = events.filter((e) => e.type === 'lost');
    assert.equal(lost.length, 1, `推到一半卡住、按停滞收回一次:${JSON.stringify(lost.map((e) => [e.reason, e.phase]))}`);
    assert.equal(lost[0].phase, 'push');
    assert.ok(done(), '重新认领后完成');
    const claims = lb.log().filter((e) => e.dir === 'out' && e.message.type === 'task.claimed' && e.message.id === task.id);
    assert.equal(claims.length, 2, '同一节点认领了两次');
    assert.deepEqual(renders, [task.id], '第二次没有再渲(走去重)');
    assert.ok(events.some((e) => e.type === 'dedup' && e.id === task.id), '第二次以去重完成');
    const missing = frameBytes(0, 59).filter((b) => !store.blocks.has(sha256(b))).length;
    assert.equal(missing, 0, `素材服务上这一段的块应全齐,缺 ${missing} 块`);
    await local.stop();
  } finally { lib.cleanup(); }
});
