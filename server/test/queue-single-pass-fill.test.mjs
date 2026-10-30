/**
 * 队列细任务一段一趟顺推(`fillCardControls` 的 `singlePass`,`docs/archive/agent-reports/AGENT-uc-latency.md`)的编排:
 * 换页次数、交给推帧的帧集合、入库与进度的粒度、最后盘上的快照,与原来逐批相同的部分逐项核对。
 * 跑:node --experimental-test-module-mocks --test server/test/queue-single-pass-fill.test.mjs
 *
 * 不起 Chrome:`server/bakery/index.mjs` 换成假的(同 `card-lock-pipeline.test.mjs`),假 `bakeFrames` 记下每次调用,
 * 对 `targetFrames` 按顺序先调 `onSnapshot`(在 `snapshotFrames` 里的)再调 `onFrame` —— 与真的一样,一帧的快照先于它的截图。
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const bakeLog = [];
mock.module(new URL('../bakery/index.mjs', import.meta.url).href, {
  exports: {
    openBakery: async () => { throw new Error('单测不开 Chrome'); },
    findFfmpeg: async () => 'ffmpeg',
    streamPngVideo: () => { throw new Error('单测不编码'); },
    bakeFrames: async (bakery, opts = {}) => {
      const rec = { targetFrames: [...(opts.targetFrames ?? [])], snapshotFrames: [...(opts.snapshotFrames ?? [])], events: [] };
      bakeLog.push(rec);
      for (const frame of rec.targetFrames) {
        if (rec.snapshotFrames.includes(frame)) {
          await opts.onSnapshot?.(frame, '<div data-pc-scene=""></div>', [{ id: 'clip-a', frame, html: `<p>a ${frame}</p>` }]);
          rec.events.push(`snap ${frame}`);
        }
        await opts.onFrame?.(frame, Buffer.from(`png-${frame}`));
        rec.events.push(`shot ${frame}`);
      }
      return { advancedFrames: rec.targetFrames.length };
    },
  },
});

const { FramePipeline } = await import('../frame-pipeline.mjs');
const { describeEnvironment } = await import('../render-node/fingerprint.mjs');

const ENV = describeEnvironment({
  platform: 'win32', renderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
  vendor: 'Google Inc. (Google)', chromeVersion: 'HeadlessChrome/138.0.7204.49',
});
const N = 30;   // 1 秒 @ 30 fps
const project = { id: 'qsp-fill', fps: 30, width: 320, height: 180, duration: 1, style: {}, media: [],
  tracks: [{ id: 't1', clips: [{ id: 'clip-a', cardId: 'demo-a', start: 0, end: 1 }] }] };
const graph = { definitions: [], nodes: [{ id: 'n-a', adapter: 'chrome', cardId: 'demo-a', capabilities: { compositing: 'independent', frameMode: 'stateful' }, inputs: {} }],
  outputs: [{ nodeId: 'n-a', clipId: 'clip-a', start: 0, end: 1, opacity: 1 }] };

async function run(root, { singlePass, range }) {
  bakeLog.length = 0;
  const pipeline = new FramePipeline({ root, origin: () => 'http://127.0.0.1:1', environment: ENV, dataRoot: root, interactive: false });
  await pipeline.ensureCardLocks();
  // 入库时在当前这次推帧的事件流里记一笔(看入库与推帧的先后)
  const store = pipeline.snapshots();
  const commit = store.commitSnapshots.bind(store);
  store.commitSnapshots = (args) => { bakeLog.at(-1)?.events.push(`commit ${args.items.map(i => i.localFrame).join(',')}`); return commit(args); };
  const entry = await pipeline.entry(project);
  pipeline.recordCardPlan(entry, entry.cardCache.plan(graph).map(c => ({ ...c, tier: 'shared' })));
  entry.cardCache.hasComplete = async () => false;
  entry.cardCache.put = async () => true;
  entry.cardCache.finish = async () => {};
  const control = entry.cardPlan.find(c => c.clipId === 'clip-a');
  const resets = [];
  const bakery = { page: { setViewport: async () => {}, evaluate: async () => graph }, reset: async (p) => { resets.push(p?.tracks?.length ?? null); } };
  const batches = [];
  await pipeline.fillCardControls(entry, bakery, null, [control], { range, singlePass, onBatch: ({ first, frames, snapshotFrames }) => batches.push({ first, frames: [...frames], snapshotFrames: [...snapshotFrames] }) });
  const index = await pipeline.snapshots().snapshotIndex({ tier: 'shared', key: control.snapshotKey });
  const dir = pipeline.snapshots().dir({ tier: 'shared', key: control.snapshotKey });
  const files = {};
  for (let n = 0; n < N; n++) { try { files[n] = await fs.readFile(path.join(dir, `${n}.html`), 'utf8'); } catch { /* 没有 */ } }
  await pipeline.close().catch(() => {});
  return { resets, batches, index, files, bakes: bakeLog.map(r => ({ ...r })) };
}

const withTmp = async (fn) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-qsp-fill-'));
  try { return await fn(root); } finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
};

test('QSP4 一段(帧 6～25)顺推:换一次页 + 收尾一次;帧集合与逐批的并集相同;每 4 帧入库一次、报一次进度;盘上的快照相同', async () => {
  const range = { from: 6, to: 25 };
  const batch = await withTmp(root => run(root, { singlePass: false, range }));
  const single = await withTmp(root => run(root, { singlePass: true, range }));
  // 逐批:批首 4、8、…、24,每批换一页,外加收尾一次
  assert.deepEqual(batch.bakes.map(b => b.targetFrames[0]), [4, 8, 12, 16, 20, 24]);
  assert.equal(batch.resets.length, 6 + 1);
  // 顺推:一次推帧,帧集合 = 逐批各批的并集;换页 1 次 + 收尾 1 次
  assert.equal(single.bakes.length, 1);
  assert.deepEqual(single.bakes[0].targetFrames, batch.bakes.flatMap(b => b.targetFrames));
  assert.deepEqual(single.bakes[0].snapshotFrames, batch.bakes.flatMap(b => b.snapshotFrames));
  assert.equal(single.resets.length, 1 + 1);
  // 进度:每 4 帧一次,帧加起来与逐批一样
  assert.deepEqual(single.batches.map(b => b.frames.length), [4, 4, 4, 4, 4, 4]);
  assert.deepEqual(single.batches.flatMap(b => b.frames), batch.batches.flatMap(b => b.frames));
  assert.deepEqual(single.batches.flatMap(b => b.snapshotFrames), batch.batches.flatMap(b => b.snapshotFrames));
  // 盘上:同一组帧、同样的内容,index 一样
  assert.deepEqual(single.index.frames, batch.index.frames);
  assert.deepEqual(single.index.frames, [[6, 25]]);
  assert.deepEqual(single.files, batch.files);
});

test('QSP5 顺推时每 4 帧先入库再截下一帧:入库跟着推帧走,不是全推完才一次交', async () => {
  const single = await withTmp(root => run(root, { singlePass: true, range: { from: 0, to: 11 } }));
  assert.equal(single.bakes.length, 1);
  assert.deepEqual(single.batches.map(b => b.first), [0, 4, 8]);
  const ev = single.bakes[0].events;
  assert.deepEqual(ev.filter(e => e.startsWith('commit')), ['commit 0,1,2,3', 'commit 4,5,6,7', 'commit 8,9,10,11']);
  assert.ok(ev.indexOf('commit 0,1,2,3') > ev.indexOf('snap 3') && ev.indexOf('commit 0,1,2,3') < ev.indexOf('snap 4'), '第一批 4 帧在推第 5 帧之前入库');
});

test('QSP6 只有一批(一段不到 5 帧)或没给 range:照原来逐批走', async () => {
  const one = await withTmp(root => run(root, { singlePass: true, range: { from: 0, to: 3 } }));
  assert.equal(one.bakes.length, 1);
  assert.deepEqual(one.bakes[0].targetFrames, [0, 1, 2, 3]);
  const whole = await withTmp(root => run(root, { singlePass: true, range: null }));
  assert.equal(whole.bakes.length, Math.ceil(N / 4), '没给 range(后台那一趟):逐批');
});
