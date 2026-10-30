/**
 * A3a 快照库的单测。跑:node --test server/test/snapshot-store.test.mjs
 *
 * 目录形状是这一层唯一的对外契约(将来上云的那一侧按同一个形状取件),所以路径
 * 逐字钉死、不靠「能读回来就行」:共享档一层键目录、本地档两层(entry.key /
 * 共享键),文件是原始 UTF-8 HTML。index.json 是播放调度每拍都要问的
 * 「哪些本地帧已经有了」,区间合并错一格就会去贴一张不存在的快照。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SnapshotStore, snapshotTier, snapshotDir, mergeRanges, rangeCount, rangeHas, SHARED_DIR, LOCAL_DIR,
  snapshotLimit, snapshotBytes, overSnapshotLimit, DOM_SNAPSHOT_LIMIT, CANVAS_SNAPSHOT_LIMIT } from '../snapshot-store.mjs';

const withRoot = async body => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-snapshot-store-'));
  try { return await body(root); } finally { await fs.rm(root, { recursive: true, force: true }); }
};

test('directory shape: shared is one level, local is two (entry key / shared key)', () => {
  assert.equal(snapshotDir('R', { tier: 'shared', key: 'K' }), path.join('R', SHARED_DIR, 'K'));
  assert.equal(snapshotDir('R', { tier: 'local', entryKey: 'E', key: 'K' }), path.join('R', LOCAL_DIR, 'E', 'K'));
  // 两层目录,不拼成一个名字 —— 换项目时整棵 <entry.key>/ 一起丢得掉,而共享键那
  // 一层在两种档里同名,将来把某一份提升成共享档只是挪目录。
  assert.notEqual(snapshotDir('R', { tier: 'local', entryKey: 'E', key: 'K' }), path.join('R', LOCAL_DIR, 'E-K'));
  assert.throws(() => snapshotDir('R', { tier: 'local', key: 'K' }), /entry key/);
  assert.throws(() => snapshotDir('R', { tier: 'shared' }), /key is required/);
  assert.throws(() => snapshotDir('R', { tier: 'none', key: 'K' }), /Unknown snapshot tier/);
});

test('tier follows the contract: all cards return none (2026-10-13 契约 1.1 每张卡的 HTML 快照作废)', () => {
  const caps = (compositing, frameMode = 'stateful') => ({ compositing, frameMode });
  assert.equal(snapshotTier(caps('independent')), 'none');
  assert.equal(snapshotTier(caps('sourceDependent')), 'none');
  assert.equal(snapshotTier(caps('belowDependent')), 'none');
  assert.equal(snapshotTier(caps('context')), 'none');
  assert.equal(snapshotTier(caps('unknown')), 'none');
  assert.equal(snapshotTier(caps(undefined)), 'none');
  assert.equal(snapshotTier(caps('independent', 'direct')), 'none');
  assert.equal(snapshotTier(caps('unknown', 'direct')), 'none');
  assert.equal(snapshotTier({ compositing: 'independent', need_prerendering: true }), 'none');
  assert.equal(snapshotTier({ compositing: 'belowDependent', needPrerendering: true }), 'none');
  assert.equal(snapshotTier(undefined), 'none');
});

test('A3c size cap: DOM 300 KB, canvas 1 MB; over-limit frames are diagnosed, not indexed', async () => withRoot(async root => {
  assert.equal(snapshotLimit({ compositing: 'independent' }), DOM_SNAPSHOT_LIMIT);
  // canvas 卡的字节大半是 toDataURL 的位图,差异样式内联对它无效 —— 按位图那一档算。
  assert.equal(snapshotLimit({ canvasHeavy: true }), CANVAS_SNAPSHOT_LIMIT);
  assert.equal(snapshotBytes('数'), 3, 'UTF-8 口径,和落盘的字节完全一致');
  assert.equal(overSnapshotLimit('x'.repeat(10), {}), null);
  assert.deepEqual(overSnapshotLimit('x'.repeat(DOM_SNAPSHOT_LIMIT + 1), {}), { bytes: DOM_SNAPSHOT_LIMIT + 1, limit: DOM_SNAPSHOT_LIMIT });
  // 同一份超标 DOM 快照放在 canvas 卡上没超
  assert.equal(overSnapshotLimit('x'.repeat(DOM_SNAPSHOT_LIMIT + 1), { canvasHeavy: true }), null);

  const store = new SnapshotStore(root);
  const huge = 'x'.repeat(DOM_SNAPSHOT_LIMIT + 1);
  // 照常落盘(下一次不用重渲),但不进就绪索引
  await store.writeSnapshot({ tier: 'shared', key: 'BIG', localFrame: 0, html: huge });
  assert.equal(store.noteSnapshotSize({ clipId: 'clip-big', key: 'BIG', localFrame: 0, html: huge, capabilities: {} }), false);
  assert.equal((await store.readSnapshot({ tier: 'shared', key: 'BIG', localFrame: 0 })).length, huge.length);
  assert.equal(store.oversize.length, 1);
  assert.equal(store.oversize[0].clipId, 'clip-big');
  assert.equal(store.oversize[0].bytes, DOM_SNAPSHOT_LIMIT + 1);
  assert.equal(store.noteSnapshotSize({ clipId: 'clip-ok', key: 'OK', localFrame: 0, html: 'small', capabilities: {} }), true);
  assert.equal(store.oversize.length, 1, '合格的帧不记诊断');
}));

test('mergeRanges sorts, merges overlaps and closes one-frame gaps', () => {
  assert.deepEqual(mergeRanges([[3, 4], [0, 1], [2, 2]]), [[0, 4]], 'adjacent ranges are one range');
  assert.deepEqual(mergeRanges([[0, 5], [2, 3]]), [[0, 5]]);
  assert.deepEqual(mergeRanges([[0, 1], [3, 4]]), [[0, 1], [3, 4]], 'a real hole stays a hole');
  // 裸帧号和区间混排。
  assert.deepEqual(mergeRanges([7, [0, 2], 3, 9, 8]), [[0, 3], [7, 9]]);
  // 坏值直接丢掉,不让它把整段区间撑坏。
  assert.deepEqual(mergeRanges([[5, 1], ['a', 'b'], [1.5, 2], null, [0, 0]]), [[0, 0]]);
  assert.deepEqual(mergeRanges(undefined), []);
  assert.equal(rangeCount([[0, 3], [7, 9]]), 7, 'closed intervals: both ends count');
  assert.equal(rangeHas([[0, 3], [7, 9]], 3), true);
  assert.equal(rangeHas([[0, 3], [7, 9]], 5), false);
});

test('put/get round-trips raw UTF-8 HTML in the shared tier and misses return null', async () => withRoot(async root => {
  const store = new SnapshotStore(root);
  const html = '<div data-pc-clip="a">价格 &amp; <span style="width:800px">42</span></div>';
  const file = await store.writeSnapshot({ tier: 'shared', key: 'KEY1', localFrame: 0, html });
  assert.equal(file, path.join(root, SHARED_DIR, 'KEY1', '0.html'));
  // 原始 UTF-8,不 base64、不 deflate:盘上这一个文件就是快照本身。
  assert.equal(await fs.readFile(file, 'utf8'), html);
  assert.equal(await store.readSnapshot({ tier: 'shared', key: 'KEY1', localFrame: 0 }), html);
  // 缺帧返回 null(不抛):缺料那一层透明、播放头不停。
  assert.equal(await store.readSnapshot({ tier: 'shared', key: 'KEY1', localFrame: 9 }), null);
  assert.equal(await store.readSnapshot({ tier: 'shared', key: 'NOPE', localFrame: 0 }), null);
  await assert.rejects(store.writeSnapshot({ tier: 'shared', key: 'KEY1', localFrame: -1, html }), /Invalid local frame/);
}));

test('local tier writes under <root>/controls-local/<entry.key>/<shared key>/ and never collides with shared', async () => withRoot(async root => {
  const store = new SnapshotStore(root);
  await store.writeSnapshot({ tier: 'local', entryKey: 'ENTRY', key: 'KEY1', localFrame: 2, html: 'local' });
  await store.writeSnapshot({ tier: 'shared', key: 'KEY1', localFrame: 2, html: 'shared' });
  assert.equal(await fs.readFile(path.join(root, LOCAL_DIR, 'ENTRY', 'KEY1', '2.html'), 'utf8'), 'local');
  assert.equal(await fs.readFile(path.join(root, SHARED_DIR, 'KEY1', '2.html'), 'utf8'), 'shared');
  // 同一个共享键、两个项目:各自一棵子树。
  await store.writeSnapshot({ tier: 'local', entryKey: 'OTHER', key: 'KEY1', localFrame: 2, html: 'other' });
  assert.equal(await store.readSnapshot({ tier: 'local', entryKey: 'ENTRY', key: 'KEY1', localFrame: 2 }), 'local');
  assert.equal(await store.readSnapshot({ tier: 'local', entryKey: 'OTHER', key: 'KEY1', localFrame: 2 }), 'other');
}));

test('index.json is per key dir, updated per batch, and merges across batches', async () => withRoot(async root => {
  const store = new SnapshotStore(root);
  const target = { tier: 'shared', key: 'KEY1' };
  assert.deepEqual(await store.snapshotIndex(target), { count: 0, frames: [], oversize: [] }, 'no index yet is not an error');
  // fillCardControls 的批大小是 4:写完一批更新一次。
  for (const frame of [0, 1, 2, 3]) await store.writeSnapshot({ ...target, localFrame: frame, html: `f${frame}` });
  assert.deepEqual(await store.updateIndex({ ...target, frames: [0, 1, 2, 3] }), { count: 4, frames: [[0, 3]], oversize: [] });
  for (const frame of [4, 5, 6, 7]) await store.writeSnapshot({ ...target, localFrame: frame, html: `f${frame}` });
  await store.updateIndex({ ...target, frames: [4, 5, 6, 7] });
  // 相邻批次并成一个区间,不是两条。
  assert.deepEqual(await store.snapshotIndex(target), { count: 8, frames: [[0, 7]], oversize: [] });
  // 一段被取消、后来补上的洞:先有 12～13,再补 8～11,最后并成一条。
  for (const frame of [12, 13]) await store.writeSnapshot({ ...target, localFrame: frame, html: `f${frame}` });
  await store.updateIndex({ ...target, frames: [12, 13] });
  assert.deepEqual(await store.snapshotIndex(target), { count: 10, frames: [[0, 7], [12, 13]], oversize: [] });
  for (const frame of [8, 9, 10, 11]) await store.writeSnapshot({ ...target, localFrame: frame, html: `f${frame}` });
  await store.updateIndex({ ...target, frames: [8, 9, 10, 11] });
  assert.deepEqual(await store.snapshotIndex(target), { count: 14, frames: [[0, 13]], oversize: [] });
  const raw = JSON.parse(await fs.readFile(path.join(root, SHARED_DIR, 'KEY1', 'index.json'), 'utf8'));
  // 盘上那份没有超限帧时**不写** `oversize` 字段:老 index.json 原样读得回来
  assert.deepEqual(raw, { count: 14, frames: [[0, 13]] });
  // index.json 住在键目录里、和帧文件同级:一个键的「有哪些帧」读一个小 JSON 就够,
  // 不用 readdir 几千个文件。
  const names = (await fs.readdir(path.join(root, SHARED_DIR, 'KEY1'))).filter(name => !name.startsWith('.'));
  assert.equal(names.includes('index.json'), true);
  assert.equal(names.filter(name => name.endsWith('.html')).length, 14);
  assert.equal(await store.readSnapshot({ ...target, localFrame: 13 }), 'f13');
}));

test('R6-14:超限帧记进 index.json 的 oversize,跨进程留得住', async () => withRoot(async root => {
  const store = new SnapshotStore(root);
  const target = { tier: 'shared', key: 'BIGK' };
  // 一批 4 帧:两帧合格、两帧超限
  const index = await store.updateIndex({ ...target, frames: [0, 1], oversize: [2, 3] });
  assert.deepEqual(index, { count: 2, frames: [[0, 1]], oversize: [[2, 3]] });
  // 两份名单互不相干,后面的批次各并各的
  await store.updateIndex({ ...target, frames: [4], oversize: [5] });
  assert.deepEqual(await store.snapshotIndex(target), { count: 3, frames: [[0, 1], [4, 4]], oversize: [[2, 3], [5, 5]] });
  // 盘上那份带 oversize —— 换一个 SnapshotStore(重启预渲染进程)照样读得回来
  const raw = JSON.parse(await fs.readFile(path.join(root, SHARED_DIR, 'BIGK', 'index.json'), 'utf8'));
  assert.deepEqual(raw.oversize, [[2, 3], [5, 5]]);
  assert.deepEqual(await new SnapshotStore(root).snapshotIndex(target), { count: 3, frames: [[0, 1], [4, 4]], oversize: [[2, 3], [5, 5]] });
  // rebuildIndex 按盘上的帧文件重建 frames,但**留着**超限名单:
  // 帧文件在盘上不代表它合格(先写文件、后判超限),丢了名单下一趟又白渲一遍
  for (const frame of [0, 1, 2, 3, 4, 5]) await store.writeSnapshot({ ...target, localFrame: frame, html: 'x' });
  assert.deepEqual(await store.rebuildIndex(target), { count: 6, frames: [[0, 5]], oversize: [[2, 3], [5, 5]] });
}));

test('concurrent batches on one key never lose a range', async () => withRoot(async root => {
  const store = new SnapshotStore(root);
  const target = { tier: 'local', entryKey: 'E', key: 'K' };
  // 读-改-写之间插进另一批就会丢段;`updateIndex` 按目录串行。
  await Promise.all([[0, 1], [2, 3], [4, 5], [10, 11]].map(frames => store.updateIndex({ ...target, frames })));
  assert.deepEqual(await store.snapshotIndex(target), { count: 8, frames: [[0, 5], [10, 11]], oversize: [] });
}));

test('rebuildIndex recovers the index from the frame files on disk', async () => withRoot(async root => {
  const store = new SnapshotStore(root);
  const target = { tier: 'shared', key: 'KEY2' };
  for (const frame of [0, 1, 2, 5]) await store.writeSnapshot({ ...target, localFrame: frame, html: 'x' });
  // 掉过电、index.json 没写成:按盘上实际的 <localFrame>.html 重建。
  assert.deepEqual(await store.rebuildIndex(target), { count: 4, frames: [[0, 2], [5, 5]], oversize: [] });
  assert.deepEqual(await store.snapshotIndex(target), { count: 4, frames: [[0, 2], [5, 5]], oversize: [] });
  assert.deepEqual(await store.rebuildIndex({ tier: 'shared', key: 'ABSENT' }), { count: 0, frames: [], oversize: [] });
}));

/**
 * 整场景路(`record`)写控件 HTML 时必须同时写进快照库。这条是「去向」和「现状」
 * 并存那一段的唯一保障:老的 `entry.controls` → `html-manifest.json` 还在,但新的
 * 目录必须同步长出来,否则第 4 步换读侧的时候盘上一片空。
 *
 * 直接拿 `FramePipeline.prototype` 上的三个方法配一个最小假 entry 跑:这一段不碰
 * Chrome、不碰 ffmpeg,不值得为它起一整条管线。
 */
test('record routes control HTML into the snapshot store, shared and local side by side', async () => withRoot(async root => {
  const { FramePipeline } = await import('../frame-pipeline.mjs');
  const pipeline = { root, _snapshots: new SnapshotStore(root),
    snapshots: FramePipeline.prototype.snapshots,
    snapshotTargets: FramePipeline.prototype.snapshotTargets,
    prerenderPicked: FramePipeline.prototype.prerenderPicked,
    recordSnapshots: FramePipeline.prototype.recordSnapshots,
    flushSnapshots: FramePipeline.prototype.flushSnapshots };
  const entry = { key: 'ENTRY', cardPlan: [
    { clipId: 'clip-shared', snapshotKey: 'SHARED-KEY', tier: 'shared', capabilities: { compositing: 'independent', frameMode: 'stateful' } },
    // 毛玻璃:只能由整场景路产,走本地档、键目录下再套 entry.key。
    { clipId: 'clip-blur', snapshotKey: 'BLUR-KEY', tier: 'local', capabilities: { compositing: 'belowDependent', frameMode: 'stateful' } },
    // 拿不准的卡按下层依赖卡处理:本地档(计划 3.1(2))。
    { clipId: 'clip-unknown', snapshotKey: 'U-KEY', tier: 'local', capabilities: { compositing: 'unknown', frameMode: 'stateful' } },
    // 在所有位置都判轻的卡不产快照(渲染 9)。
    { clipId: 'clip-direct', snapshotKey: 'D-KEY', tier: 'none', capabilities: { compositing: 'independent', frameMode: 'direct' } },
    // 计划里没有共享键的条目(手工构造 / 还没接上键的调用方)直接跳过,不写半张。
    { clipId: 'clip-nokey', capabilities: { compositing: 'independent', frameMode: 'stateful' } },
  ] };
  for (const frame of [0, 1]) {
    pipeline.recordSnapshots(entry, [
      { id: 'clip-shared', frame, html: `<i>shared ${frame}</i>` },
      { id: 'clip-blur', frame, html: `<i>blur ${frame}</i>` },
      { id: 'clip-unknown', frame, html: `<i>unknown ${frame}</i>` },
      { id: 'clip-direct', frame, html: 'never' },
      { id: 'clip-nokey', frame, html: 'never' },
      { id: 'clip-absent', frame, html: 'never' },        // 图里没有的片段
      { id: 'clip-shared', frame: undefined, html: 'no' }, // 没有本地帧号就没法寻址
    ]);
  }
  await pipeline.flushSnapshots(entry);
  const store = pipeline.snapshots();
  assert.equal(await store.readSnapshot({ tier: 'shared', key: 'SHARED-KEY', localFrame: 1 }), '<i>shared 1</i>');
  assert.equal(await store.readSnapshot({ tier: 'local', entryKey: 'ENTRY', key: 'BLUR-KEY', localFrame: 1 }), '<i>blur 1</i>');
  assert.deepEqual(await store.snapshotIndex({ tier: 'shared', key: 'SHARED-KEY' }), { count: 2, frames: [[0, 1]], oversize: [] });
  assert.deepEqual(await store.snapshotIndex({ tier: 'local', entryKey: 'ENTRY', key: 'BLUR-KEY' }), { count: 2, frames: [[0, 1]], oversize: [] });
  // unknown 卡进本地档,和毛玻璃同一棵树。
  assert.equal(await store.readSnapshot({ tier: 'local', entryKey: 'ENTRY', key: 'U-KEY', localFrame: 0 }), '<i>unknown 0</i>');
  // 共享档目录下不该出现 entry.key 那一层;本地档里没有判轻的卡、也没有无键的卡。
  assert.deepEqual((await fs.readdir(path.join(root, SHARED_DIR))).sort(), ['SHARED-KEY']);
  assert.deepEqual((await fs.readdir(path.join(root, LOCAL_DIR, 'ENTRY'))).sort(), ['BLUR-KEY', 'U-KEY']);
  // 下一批接着并,不重开一段。
  pipeline.recordSnapshots(entry, [{ id: 'clip-shared', frame: 2, html: '<i>shared 2</i>' }]);
  await pipeline.flushSnapshots(entry);
  assert.deepEqual(await store.snapshotIndex({ tier: 'shared', key: 'SHARED-KEY' }), { count: 3, frames: [[0, 2]], oversize: [] });
  // 没有 cardPlan 的 entry(前台单帧路)什么都不写,也不报错。
  const bare = { key: 'BARE' };
  bare.cardPlan = undefined;
  pipeline.recordSnapshots(bare, [{ id: 'clip-shared', frame: 0, html: 'x' }]);
  await pipeline.flushSnapshots(bare);
  assert.deepEqual((await fs.readdir(path.join(root, LOCAL_DIR))).sort(), ['ENTRY']);
}));

// ── T1a 审查 #9:写快照的唯一入口 ─────────────────────────────────────────

test('commitSnapshots: 写帧、判体积、并 index 一步做完,超限帧落盘但进 oversize', () => withRoot(async root => {
  const store = new SnapshotStore(root);
  const target = { tier: 'shared', key: 'COMMIT' };
  const huge = 'x'.repeat(DOM_SNAPSHOT_LIMIT + 1);
  const out = await store.commitSnapshots({ ...target, clipId: 'c', capabilities: {}, items: [
    { localFrame: 0, html: 'a' }, { localFrame: 1, html: huge }, { localFrame: 2, html: 'c' },
  ] });
  assert.deepEqual(out.written, [0, 2]);
  assert.deepEqual(out.oversized, [1]);
  assert.deepEqual(out.frames, [[0, 0], [2, 2]]);
  assert.deepEqual(out.oversize, [[1, 1]]);
  // 盘上三帧都在(超限帧照常落盘),index 与返回值一致
  assert.equal(await store.readSnapshot({ ...target, localFrame: 1 }), huge);
  assert.deepEqual(await store.snapshotIndex(target), { count: 2, frames: [[0, 0], [2, 2]], oversize: [[1, 1]] });
  // 空批不动 index,回当前 index
  const empty = await store.commitSnapshots({ ...target, items: [] });
  assert.deepEqual({ count: empty.count, written: empty.written }, { count: 2, written: [] });
}));

test('batch: 攒满 size 帧交一次;帧要么还在内存里,要么已经落盘且进了 index', () => withRoot(async root => {
  const store = new SnapshotStore(root);
  const target = { tier: 'local', entryKey: 'E', key: 'B' };
  const batch = store.batch({ ...target, clipId: 'c', capabilities: {} }, { size: 2 });
  await batch.add(0, 'f0');
  // 没攒满:盘上没有、index 里也没有(不存在「盘上有、index 里没有」)
  assert.equal(await store.readSnapshot({ ...target, localFrame: 0 }), null);
  assert.deepEqual(await store.snapshotIndex(target), { count: 0, frames: [], oversize: [] });
  await batch.add(1, 'f1');
  assert.deepEqual(await store.snapshotIndex(target), { count: 2, frames: [[0, 1]], oversize: [] });
  await batch.add(2, 'f2');
  const index = await batch.close();
  assert.deepEqual(index.frames, [[0, 2]]);
  assert.equal(batch.written, 3);
  // 盘上每一帧都在 index 里
  const names = (await fs.readdir(snapshotDir(root, target))).filter(n => n.endsWith('.html')).map(n => Number(n.slice(0, -5))).sort();
  assert.deepEqual(names, [0, 1, 2]);
  // 什么都没交过的 batch close 回 null
  assert.equal(await store.batch({ ...target, key: 'NONE' }).close(), null);
}));

test('生产代码不直接调 writeSnapshot / updateIndex(只走 commitSnapshots / batch)', async () => {
  const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const offenders = [];
  const walk = async dir => {
    for (const item of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name);
      if (item.isDirectory()) { if (item.name !== 'test' && item.name !== 'node_modules') await walk(file); continue; }
      if (!/\.(mjs|ts)$/.test(item.name) || item.name === 'snapshot-store.mjs') continue;
      const text = await fs.readFile(file, 'utf8');
      if (/\.(writeSnapshot|updateIndex)\(/.test(text)) offenders.push(path.relative(serverDir, file));
    }
  };
  await walk(serverDir);
  assert.deepEqual(offenders, []);
});
