/**
 * 回归:预渲染管线读成本记录的根目录(开发期 `PROMPTCUT_DATA_DIR` 没设的时候)。
 * 跑:node --test server/test/prerender-costs-root.test.mjs
 *
 * 以前 `recordCardPlan` 把 `this.root`(帧库目录 `<仓库>/out/frame-library`)当成本根传给
 * `prerenderSetOfPlan`,于是读 `<帧库>/out/card-costs.json` —— 没人写这个文件;`vite-plugin-costs`
 * 写的是 `<仓库>/out/card-costs.json`。实测成本因此永远进不了预渲染集合,一律按声明兜底。
 * 探针和桌面版都设了 `PROMPTCUT_DATA_DIR`,所以一直没测出来。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FramePipeline } from '../frame-pipeline.mjs';
import { upsertCosts } from '../costs-store.mjs';
import { cardCostKey } from '../../src/render/cardCostKey.mjs';

const fps = 30;
const caps = {
  a: { frameMode: 'stateful', compositing: 'independent' },
  b: { frameMode: 'stateful', compositing: 'independent' },
};
const clips = [
  { id: 'a', cardId: 'motion', start: 0, end: 6 },
  { id: 'b', cardId: 'lottie', start: 2, end: 20 },
];
// `card-cache.mjs` 的 `plan()` 往 control 上写的那几项(同 prerender-set.test.mjs 的夹具)
const plan = clips.map(clip => {
  const node = { id: `n:${clip.id}`, clipId: clip.id, cardId: clip.cardId, definitionId: `def:${clip.cardId}`, inputs: {},
    params: { text: clip.cardId }, capabilities: caps[clip.id] };
  return { clipId: clip.id, nodeId: node.id, start: clip.start, end: clip.end,
    costKey: cardCostKey(node, `builtin:${clip.cardId}`, fps, Math.max(1, Math.round((clip.end - clip.start) * fps))),
    frameMode: caps[clip.id].frameMode, capabilities: caps[clip.id] };
});
// a:6 秒、每拍 1 ms,各位置都轻;b:18 秒,追帧超上界,各位置都重(口径见 prerender-set.test.mjs)
const costs = [
  { identityKey: plan[0].costKey, device: 'dev', fps, stepMs: 1, stepMaxMs: 2, inlineMs: 0, rasterMs: 0, serializeMs: 0,
    catchUpMs: 180, kind: 'stepped', vtOk: true, seekOk: false, seekMs: null, demoted: false, measuredAt: 10 },
  { identityKey: plan[1].costKey, device: 'dev', fps, stepMs: 1, stepMaxMs: 2, inlineMs: 0, rasterMs: 0, serializeMs: 0,
    catchUpMs: 540, kind: 'stepped', vtOk: false, seekOk: false, seekMs: null, demoted: false, measuredAt: 10 },
];

/** 在没有 `PROMPTCUT_DATA_DIR` 的开发期环境里跑 `fn(仓库根)`,跑完删目录、还原环境变量 */
function devLayout(fn) {
  const saved = process.env.PROMPTCUT_DATA_DIR;
  delete process.env.PROMPTCUT_DATA_DIR;
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-costs-root-'));
  try { return fn(repo); }
  finally {
    if (saved === undefined) delete process.env.PROMPTCUT_DATA_DIR; else process.env.PROMPTCUT_DATA_DIR = saved;
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

test('开发期:成本插件写进 <仓库>/out 的记录,预渲染管线读得到(集合按实测算,不按声明兜底)', () => devLayout(repo => {
  upsertCosts(repo, costs);                                    // vite-plugin-costs 的写法:根 = Vite 的根目录
  assert.ok(fs.existsSync(path.join(repo, 'out', 'card-costs.json')));
  const pipeline = new FramePipeline({ root: path.join(repo, 'out', 'frame-library'), origin: () => '', dataRoot: repo });
  const entry = { key: 'E', project: { fps } };
  pipeline.recordCardPlan(entry, plan);
  assert.deepEqual([...entry.prerenderSet].sort(), ['b'], '判轻的 a 不在集合里 —— 实测成本生效了');
}));

test('开发期:帧库目录下的同名文件不再被当成成本记录(成本根是 dataRoot,不是帧库)', () => devLayout(repo => {
  const library = path.join(repo, 'out', 'frame-library');
  // 旧的错误路径上放一份「两张都判轻」的记录:要是还读它,集合会变成空的
  upsertCosts(library, costs.map(record => ({ ...record, catchUpMs: 0, kind: 'random', stepMs: 1 })));
  assert.ok(fs.existsSync(path.join(library, 'out', 'card-costs.json')));
  // 真正的记录在 <仓库>/out
  upsertCosts(repo, costs);
  const pipeline = new FramePipeline({ root: library, origin: () => '', dataRoot: repo });
  const entry = { key: 'E', project: { fps } };
  pipeline.recordCardPlan(entry, plan);
  assert.deepEqual([...entry.prerenderSet].sort(), ['b']);
}));

test('开发期:<仓库>/out 下一条记录都没有时照旧按声明兜底', () => devLayout(repo => {
  const pipeline = new FramePipeline({ root: path.join(repo, 'out', 'frame-library'), origin: () => '', dataRoot: repo });
  const entry = { key: 'E', project: { fps } };
  pipeline.recordCardPlan(entry, plan);
  assert.deepEqual([...entry.prerenderSet].sort(), ['a', 'b']);
}));

test('设了 PROMPTCUT_DATA_DIR(桌面版、探针)时仍以它为准', () => devLayout(repo => {
  const dataDir = path.join(repo, 'appdata');
  process.env.PROMPTCUT_DATA_DIR = dataDir;
  upsertCosts('ignored-when-env-set', costs);
  assert.ok(fs.existsSync(path.join(dataDir, 'card-costs.json')));
  const pipeline = new FramePipeline({ root: path.join(repo, 'out', 'frame-library'), origin: () => '', dataRoot: repo });
  const entry = { key: 'E', project: { fps } };
  pipeline.recordCardPlan(entry, plan);
  assert.deepEqual([...entry.prerenderSet].sort(), ['b']);
}));

test('不传 dataRoot 时缺省是当前工作目录(从仓库根跑的脚本和成本插件对得上)', () => {
  const pipeline = new FramePipeline({ root: path.join(os.tmpdir(), 'pc-none', 'frame-library'), origin: () => '' });
  assert.equal(pipeline.dataRoot, process.cwd());
});

test('旧会话的整帧后台任务未结束时，新 preload 立即按新成本重算已有 card plan', async () => {
  const saved = process.env.PROMPTCUT_DATA_DIR;
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-costs-preload-'));
  process.env.PROMPTCUT_DATA_DIR = path.join(repo, 'data');
  let unblock;
  try {
    const pipeline = new FramePipeline({ root: path.join(repo, 'frame-library'), origin: () => '', dataRoot: repo });
    const entry = { key: 'same-content', project: { fps }, cardPlan: plan, anchorsReady: false };
    pipeline.entry = async () => entry;
    const waiting = new Promise(resolve => { unblock = resolve; });
    pipeline.acquire = async () => { await waiting; throw new Error('后台渲染夹具停在 acquire'); };

    pipeline.recordCardPlan(entry, plan);
    assert.deepEqual([...entry.prerenderSet].sort(), ['a', 'b']);
    await pipeline.preload(entry.project, { session: 'old', localRev: 1 });
    upsertCosts(repo, costs);
    await pipeline.preload(entry.project, { session: 'new', localRev: 1 });
    assert.deepEqual([...entry.prerenderSet], ['b'], '新会话不能等旧后台视频结束才看到实测成本');
    assert.equal(pipeline.ready.describe().find(s => s.session === 'new')?.entryKey, entry.key);
    unblock();
    await pipeline.background;
  } finally {
    unblock?.();
    if (saved === undefined) delete process.env.PROMPTCUT_DATA_DIR; else process.env.PROMPTCUT_DATA_DIR = saved;
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
