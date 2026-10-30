/**
 * 导出专用的逐帧位图(`server/export-frames.mjs`、`server/render-node/export-plan.mjs`;在线浏览器导出时本页不执行的卡的画面)。
 * 跑:node --test server/test/export-frames.test.mjs
 *
 *   EF-01 键:导出位图的内容键由流的内容键派生、与它不同;同一个输入同一个键
 *   EF-02 PNG:原始像素编成的 PNG 解回来逐字节相同;取帧钩子交来的两种形状都认
 *   EF-03 切分:只为导出的计划只切导出位图任务 —— 沿用流任务的种类与范围,带 `exportFrames`、不带 `contentKey`(不占指纹锁),
 *         结果键 = 导出键 × 自己的指纹,名次排在最前;队列的入站校验原样收下;不给 `exportStreams` 时切分与原来相同
 *   EF-04 清单计划的覆盖:只为导出的计划预渲染集合是空的、不切轨道流;执行器没给 `exportStreamsFor` 时全记成出不了
 *   EF-05 索引:任务全发布成功的流才列;没发全的、节点说出不了的进 `unsupported`
 *   EF-06 产物库:本机落盘的帧 → 清单 → 推 `px` → 写内容库 → 删本机的帧;缺帧不算完成;清单在、块在就直接算已有
 *   EF-07 节点侧的认法:导出位图任务不是稀疏流任务、不被当成要满密度分段的流
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { collectExportResult, createExportFramesSink, exportFramesKey, exportResultComplete, exportSpecOf, exportStreamOf, exportTaskFrames,
  rgbaToPng, shotToPng, storeExportFrame, exportFramesDir, EXPORT_FRAMES_KIND, sweepExpiredExportFrames, releaseExportFrames, EXPORT_FRAMES_TTL_MS } from '../export-frames.mjs';
import { exportIndexOf, isExportFramesTask, isExportOnlyPlan, EXPORT_FRAMES_PRIORITY } from '../render-node/export-plan.mjs';
import { splitPlan, SPARSE_STREAM_PRIORITY } from '../render-node/split.mjs';
import { listPlanOverrides } from '../render-node/local-node.mjs';
import { checkClaimable } from '../render-node/filter.mjs';
import { resultKeyOf } from '../render-node/fingerprint.mjs';
import { parseInbound, lockKeyOf, isSparseStreamTask, clipsPlanTaskOf, backfillSig, CLIPS_KEY_MARK } from '../render-queue/messages.mjs';
import { decodePngRgba } from '../bakery/capture-canvas.mjs';
import { wantsDenseStream } from '../artifact-transfer.mjs';

const sha256 = data => createHash('sha256').update(data).digest('hex');
const FP = 'a'.repeat(16);
const STREAM_KEY = sha256('stream-content');

/** `planStreams` 的一项的样子(只带这里用到的字段) */
const specOf = (over = {}) => ({
  streamKey: resultKeyOf(STREAM_KEY, FP), contentKey: STREAM_KEY, envFingerprint: FP, kind: 'card', plane: 'local', clipIds: ['c1'], topClipId: 'c1',
  offset: { x: 320, y: 180 }, bound: { x: -32, y: -32, w: 704, h: 424 }, fps: 30, originFrame: 12, lastFrame: 143, firstSegment: 0, lastSegment: 8, mountFrame: 12, ...over,
});
const planTask = { id: 'plan:p1@7#clips:abc', kind: 'plan', resultKey: 'p1@7#clips:abc', source: { projectId: 'p1', projectRev: 7 }, input: { clips: ['c1'], exportOnly: true } };

test('EF-01 导出位图的内容键由流的内容键派生', () => {
  const key = exportFramesKey(STREAM_KEY);
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.notEqual(key, STREAM_KEY);
  assert.equal(exportFramesKey(STREAM_KEY), key);
  assert.notEqual(exportFramesKey(sha256('other')), key);
  const spec = exportSpecOf(specOf(), FP);
  assert.equal(spec.exportKey, key);
  assert.equal(spec.exportResultKey, resultKeyOf(key, FP), '结果键与切分用的 resultKeyOf 同一个算式');
  assert.equal(exportSpecOf(specOf({ kind: 'group', clipIds: ['c1', 'c2'] }), FP), null, '组流不出导出位图');
  assert.equal(exportSpecOf(specOf(), ''), null, '没有环境指纹不出');
  assert.equal(exportSpecOf(specOf({ kind: 'below', plane: 'stage', belowClipIds: ['v0'] }), FP).kind, 'below', '依赖下层的流的形状照出');
});

test('EF-02 原始像素编成 PNG,解回来相同', () => {
  const w = 5, h = 3;
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < rgba.length; i++) rgba[i] = (i * 37 + 11) & 0xff;
  const png = rgbaToPng(rgba, w, h);
  const back = decodePngRgba(png);
  assert.equal(back.width, w);
  assert.equal(back.height, h);
  assert.deepEqual(Buffer.from(back.data ?? back.rgba), rgba);
  assert.deepEqual(shotToPng({ rgba, width: w, height: h }), png);
  assert.equal(shotToPng(png), png, 'PNG 原样');
  assert.throws(() => rgbaToPng(rgba, w, h + 1));
  assert.throws(() => shotToPng(null));
});

test('EF-03 只为导出的计划只切导出位图任务', () => {
  const spec = exportSpecOf(specOf(), FP);
  const base = { planTask, entryKey: 'e1', cardPlan: [{ clipId: 'c1', cardId: 'user-x', snapshotKey: 'sk', contentKey: 'ck', count: 132, tier: 'shared', capabilities: { compositing: 'independent' } }],
    prerenderSet: new Set(), streams: [], envFingerprint: FP, codeVersion: 'cv1', cardSourceVersions: { 'user-x': 'v1' } };
  const tasks = splitPlan({ ...base, exportStreams: [exportStreamOf(spec)] });
  // 分段 0..8,每 8 段一份 → 两份任务
  assert.equal(tasks.length, 2);
  const [a, b] = tasks;
  assert.equal(a.kind, 'stream');
  assert.equal(a.resultKey, spec.exportResultKey);
  assert.deepEqual(a.range, { unit: 'segment', from: 0, to: 7 });
  assert.deepEqual(b.range, { unit: 'segment', from: 8, to: 8 });
  assert.equal(a.id, `stream:${spec.exportResultKey}:0-7`);
  assert.equal(a.input.exportFrames, true);
  assert.equal(a.input.exportKey, spec.exportKey);
  assert.equal(a.input.contentKey, undefined, '不带内容键:不占卡片级指纹锁');
  assert.equal(lockKeyOf(a), null);
  assert.deepEqual(a.input.stream, { clipId: 'c1', kind: 'card', plane: 'local', fps: 30, originFrame: 12, lastFrame: 143, rect: spec.bound, offset: spec.offset });
  assert.equal(a.requires.envFingerprint, FP);
  assert.equal(a.requires.transcode, false, '不要求本机转码');
  assert.equal(a.requires.capabilities, undefined, '不要求能产流:取位图不用编码器');
  // 谁能认领:不带 --streams 的独立渲染主机(不能转码、不报能产流)能;纯浏览器节点不能(它只收带 input.bake 的浏览器形状的流任务)
  const node = over => ({ nodeId: 'n1', userId: 'u1', envFingerprint: FP, codeVersions: ['cv1'], cardSourceVersions: { 'user-x': ['v1'] }, ...over });
  const mine = { ...a, source: { ...a.source, userId: 'u1' } };
  assert.equal(checkClaimable(mine, node({ profile: 'host', capabilities: { userCards: true, graphCards: false, transcode: false, streams: false } })).ok, true);
  assert.equal(checkClaimable(mine, node({ profile: 'pc', capabilities: { transcode: true, streams: true } })).ok, true);
  assert.deepEqual(checkClaimable({ ...mine, weight: { class: 'medium' } }, node({ profile: 'browser', capabilities: { streams: true, userCards: true } })), { ok: false, rule: 7, reason: 'no-bake-input' });
  assert.equal(checkClaimable(mine, node({ profile: 'browser', capabilities: { streams: true, userCards: true } })).ok, false);
  assert.equal(checkClaimable(mine, node({ profile: 'host', capabilities: {}, cardSourceVersions: {} })).ok, false, '手里没有这张卡的代码的节点不认领');
  assert.deepEqual(a.requires.cardSources, { 'user-x': 'v1' });
  assert.equal(a.priority, EXPORT_FRAMES_PRIORITY);
  assert.ok(EXPORT_FRAMES_PRIORITY > 50 && EXPORT_FRAMES_PRIORITY > SPARSE_STREAM_PRIORITY, '排在锚帧、稀疏流任务前面');
  assert.equal(a.weight.frames, 120);
  assert.equal(b.weight.frames, 12, '末段按实际帧数');
  assert.equal(a.source.derivedFrom, planTask.id);
  assert.ok(isExportFramesTask(a));
  // 队列的入站校验原样收下(队列不用改)
  const parsed = parseInbound({ type: 'task.publish', tasks });
  assert.equal(parsed.ok, true, parsed.detail);
  assert.equal(parsed.body.tasks[0].input.exportFrames, true);
  assert.deepEqual(parsed.body.tasks[0].input.stream, a.input.stream);
  // 不给 exportStreams:一个任务都不多
  assert.deepEqual(splitPlan(base), []);
  // 依赖下层的那一种:整场景渲,记重
  const below = exportSpecOf(specOf({ kind: 'below', plane: 'stage', belowClipIds: ['v0'], offset: { x: 0, y: 0 }, bound: { x: 0, y: 0, w: 1280, h: 720 } }), FP);
  const belowTasks = splitPlan({ ...base, exportStreams: [exportStreamOf(below)] });
  assert.equal(belowTasks[0].requires.belowDependent, true);
  assert.equal(belowTasks[0].weight.class, 'heavy');
  assert.equal(belowTasks[0].input.stream.plane, 'stage');
});

test('EF-04 清单计划的覆盖:只为导出的计划', () => {
  const page = { ...clipsPlanTaskOf({ projectId: 'p1', projectRev: 7, clips: ['c1', 'c2'] }) };
  const resultKey = `p1@7${CLIPS_KEY_MARK}${backfillSig(['c1', 'c2'], 'export=1')}`;
  const task = { ...page, id: `plan:${resultKey}`, resultKey, input: { clips: ['c1', 'c2'], exportOnly: true } };
  const parsed = parseInbound({ type: 'task.publish', tasks: [task] });
  assert.equal(parsed.ok, true, parsed.detail);
  assert.equal(parsed.body.tasks[0].input.exportOnly, true, '队列原样留着这一项');
  assert.ok(isExportOnlyPlan(parsed.body.tasks[0]));
  assert.equal(isExportOnlyPlan(page), false);
  let asked = null;
  const spec = exportStreamOf(exportSpecOf(specOf(), FP));
  const over = listPlanOverrides(task, {
    browserStreamsFor: () => { throw new Error('只为导出的计划不该切轨道流'); },
    exportStreamsFor: clips => { asked = [...clips].sort(); return { streams: [spec], unsupported: [{ clipId: 'c2', reason: 'no-card' }] }; },
  });
  assert.deepEqual(asked, ['c1', 'c2']);
  assert.equal(over.prerenderSet.size, 0, '不切快照');
  assert.deepEqual(over.streams, []);
  assert.deepEqual(over.exportStreams, [spec]);
  assert.deepEqual(over.exportUnsupported, [{ clipId: 'c2', reason: 'no-card' }]);
  const old = listPlanOverrides(task, {});
  assert.deepEqual(old.exportStreams, []);
  assert.deepEqual(old.exportUnsupported, [{ clipId: 'c1', reason: 'no-executor' }, { clipId: 'c2', reason: 'no-executor' }]);
  // 平时的清单计划不受影响:没有导出那两项
  const normal = listPlanOverrides(page, {});
  assert.equal(normal.exportStreams, undefined);
  assert.deepEqual([...normal.prerenderSet].sort(), ['c1', 'c2']);
});

test('EF-05 计划完成时回给页面的索引', () => {
  const s1 = exportStreamOf(exportSpecOf({ ...specOf(), inputSig: 's1-abc' }, FP));
  const s2 = exportStreamOf(exportSpecOf(specOf({ clipIds: ['c2'], topClipId: 'c2', contentKey: sha256('other') }), FP));
  const base = { planTask, entryKey: 'e1', cardPlan: [], prerenderSet: new Set(), streams: [], envFingerprint: FP, codeVersion: 'cv1' };
  const tasks = splitPlan({ ...base, exportStreams: [s1, s2] });
  // c2 的第二份任务没发成
  const published = tasks.filter(t => !(t.input.clipId === 'c2' && t.range.from === 8));
  const index = exportIndexOf({ exportStreams: [s1, s2], exportUnsupported: [{ clipId: 'c3', reason: 'no-card' }], published, projectRev: 9, segmentsPerTask: 8 });
  assert.equal(index.projectRev, 9);
  assert.equal(index.streams.length, 1);
  const { tasks: indexTasks, ...row } = index.streams[0];
  assert.equal(indexTasks.length, 2, '每条流的任务原样带一份');
  assert.deepEqual(row, { clipId: 'c1', kind: 'card', plane: 'local', resultKey: resultKeyOf(s1.exportKey, FP), envFingerprint: FP,
    originFrame: 12, lastFrame: 143, lastSegment: 8, segmentsPerTask: 8, fps: 30, rect: s1.rect, offset: s1.offset, inputSig: 's1-abc' });
  assert.deepEqual(index.unsupported, [{ clipId: 'c3', reason: 'no-card' }, { clipId: 'c2', reason: 'publish-failed' }]);
});

test('EF-06 产物库:落盘的帧 → 清单 → 推 px → 写内容库 → 删本机的帧', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-export-frames-'));
  try {
    const spec = exportSpecOf(specOf({ originFrame: 12, lastFrame: 20, lastSegment: 0 }), FP);
    const [task] = splitPlan({ planTask, entryKey: 'e1', cardPlan: [], prerenderSet: new Set(), streams: [], envFingerprint: FP, codeVersion: 'cv1', exportStreams: [exportStreamOf(spec)] });
    assert.deepEqual(exportTaskFrames(task), [12, 20]);
    const ref = { resultKey: task.resultKey, kind: task.kind, tier: null, range: task.range, input: task.input, requires: task.requires };
    const stored = new Map(), manifests = new Map();
    const client = {
      async has(ns, hash) { return stored.has(`${ns}/${hash}`); },
      async put(ns, bytes, { ext }) { const hash = sha256(bytes); const fresh = !stored.has(`${ns}/${hash}`); stored.set(`${ns}/${hash}`, { bytes, ext }); return { hash, uploaded: fresh }; },
    };
    const content = {
      async get(kind, key) { const body = manifests.get(`${kind}|${key}`); return body ? { body } : null; },
      async put(kind, key, body) { manifests.set(`${kind}|${key}`, structuredClone(body)); },
    };
    const sink = createExportFramesSink({ root, client, content });
    assert.equal(await sink.has(ref), false, '内容库里还没有清单');
    // 只落了一部分帧:不算完成,什么都不写
    const png = n => rgbaToPng(Buffer.from([n, n, n, 255]), 1, 1);
    for (let f = 12; f <= 18; f++) await storeExportFrame(root, task.resultKey, f, png(f));
    const partial = await sink.put(ref);
    assert.equal(partial.complete, false);
    assert.equal(partial.reason, 'range-missing');
    assert.equal(manifests.size, 0);
    // 补齐:第 19、20 帧和第 18 帧同一张图(静止的画面)→ 同一个块
    await storeExportFrame(root, task.resultKey, 19, png(18));
    await storeExportFrame(root, task.resultKey, 20, png(18));
    const { result } = await collectExportResult(root, ref);
    assert.equal(result.kind, EXPORT_FRAMES_KIND);
    assert.equal(result.frames.length, 9);
    assert.deepEqual(result.header, { kind: 'card', plane: 'local', clipIds: ['c1'], fps: 30, originFrame: 12, lastFrame: 20, rect: spec.bound, offset: spec.offset });
    assert.ok(exportResultComplete(result, ref));
    const done = await sink.put(ref);
    assert.equal(done.complete, true);
    assert.equal(done.stats.blocks, 7, '相同的帧只推一块');
    assert.equal(stored.size, 7);
    assert.ok([...stored.keys()].every(k => k.startsWith('px/')));
    assert.ok([...stored.values()].every(v => v.ext === 'png'));
    const body = manifests.get(`render-manifest|${task.resultKey}:0-0`);
    assert.deepEqual(body.frames.map(f => f[0]), [12, 13, 14, 15, 16, 17, 18, 19, 20]);
    assert.equal(body.frames[6][1], body.frames[8][1]);
    // 只给这一次导出用:本机不留
    await assert.rejects(fs.stat(exportFramesDir(root, task.resultKey)));
    // 重发的计划:清单在、块在 → 直接算已有,带回那份清单
    assert.equal(await sink.has(ref), true);
    assert.deepEqual(await sink.resultFor(ref), body);
    // 素材服务上少了一块:不算已有
    stored.delete([...stored.keys()][0]);
    assert.equal(await sink.has(ref), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('EF-07 导出位图任务不被当成稀疏流任务、不被当成要满密度分段的流', () => {
  const spec = exportSpecOf(specOf(), FP);
  const [task] = splitPlan({ planTask, entryKey: 'e1', cardPlan: [], prerenderSet: new Set(), streams: [], envFingerprint: FP, codeVersion: 'cv1', sparseStreams: true, exportStreams: [exportStreamOf(spec)] });
  assert.equal(isSparseStreamTask(task), false);
  assert.equal(task.input.density, undefined, '没有稀疏那一份');
  // 产物库按 `isExportFramesTask` 先分走,轮不到按流的规矩查满密度
  assert.equal(isExportFramesTask(task), true);
  assert.equal(wantsDenseStream(task), true, '它的种类仍是流任务(队列与节点过滤按流任务收)');
});

test('EF-08 过期清理与显式释放:TTL 24小时清理过期位图与清单,保留期内不动', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-export-sweep-'));
  try {
    const expiredKey = '1'.repeat(64);
    const freshKey = '2'.repeat(64);
    const now = Date.now();

    // 构造过期位图文件（mtime 为 25 小时前）和未过期文件（mtime 为现在）
    const expiredDir = exportFramesDir(root, expiredKey);
    const freshDir = exportFramesDir(root, freshKey);
    await fs.mkdir(expiredDir, { recursive: true });
    await fs.mkdir(freshDir, { recursive: true });
    await fs.writeFile(path.join(expiredDir, '1.png'), Buffer.from('png-old'));
    await fs.writeFile(path.join(freshDir, '2.png'), Buffer.from('png-fresh'));

    const oldTime = (now - EXPORT_FRAMES_TTL_MS - 3600_000) / 1000;
    await fs.utimes(expiredDir, oldTime, oldTime);

    const manifests = new Map();
    manifests.set(`render-manifest|${expiredKey}:0-0`, {
      body: { kind: EXPORT_FRAMES_KIND, createdAt: now - EXPORT_FRAMES_TTL_MS - 3600_000, frames: [[1, 'hash-old', 10]] },
    });
    manifests.set(`render-manifest|${freshKey}:0-0`, {
      body: { kind: EXPORT_FRAMES_KIND, createdAt: now - 1000, frames: [[2, 'hash-fresh', 10]] },
    });
    const droppedBlocks = [];
    const content = {
      async list(kind, prefix) {
        const items = [];
        for (const k of manifests.keys()) {
          const [mKind, mKey] = k.split('|');
          if (mKind === kind && (!prefix || mKey.startsWith(prefix))) items.push({ key: mKey });
        }
        return { items };
      },
      async get(kind, key) { return manifests.get(`${kind}|${key}`) ?? null; },
      async del(kind, key) { manifests.delete(`${kind}|${key}`); },
    };
    const client = {
      async drop(ns, hash) { droppedBlocks.push(`${ns}/${hash}`); },
    };

    // 运行清理
    const stats = await sweepExpiredExportFrames(root, { maxAgeMs: EXPORT_FRAMES_TTL_MS, now, content, client });
    assert.equal(stats.cleanedDirs, 1, '清理了 1 个过期的本地目录');
    assert.equal(stats.cleanedFrames, 1, '清理了 1 帧本地文件');
    assert.equal(stats.cleanedManifests, 1, '清理了 1 份过期清单');
    assert.deepEqual(droppedBlocks, ['px/hash-old'], '通知客户端释放了过期块');

    // 检查过期目录已被删除，未过期目录仍在
    await assert.rejects(fs.stat(expiredDir));
    const freshStat = await fs.stat(freshDir);
    assert.ok(freshStat.isDirectory());
    assert.ok(manifests.has(`render-manifest|${freshKey}:0-0`));

    // 显式释放未过期结果键
    await releaseExportFrames(root, freshKey, { content, client });
    await assert.rejects(fs.stat(freshDir));
    assert.equal(manifests.has(`render-manifest|${freshKey}:0-0`), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

