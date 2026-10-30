/**
 * 推帧补画(`server/bakery/bake.mjs` 文件头):推过去不取图的帧哪些拍画、哪些不画、丢掉的图进不进产物。
 * 用一个假的 bakery 跑(不起 Chrome),把每一帧里发了哪几种拍记下来:
 *   n = 不带截图的一拍,J = 丢掉的 JPEG(补画,或者生成快照前画的那一拍),P = 取图的 PNG。
 *
 * 钉住的行为:
 *   - 推过去的帧:画面有变化的补一拍 J;这一趟的第一帧补两拍(和取图的第一帧一样);
 *   - 画面静止(`__pcStaticProbe` 判静止、这一帧也没有哪一拍报告 `hasDamage`)的帧不补;静止但报告了变化的照补;
 *   - 补画过的帧当「截过」:紧跟着的取图帧不用先丢一张;静止没补的后面,取图帧照旧先丢一张;
 *   - 每帧都取图的那些路(整段、接着租约的满密度分段)一拍 J 都没有;
 *   - 丢掉的图不交给 `onFrame`;`pushDraw: false`(或 `PROMPTCUT_PUSH_DRAW=0`)时和原来一样一拍都不补。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { PNG } from 'pngjs';
import { bakeFrames, bakeStream, createStepper, drawDiscarded, pushDrawEnabled, pushDrawNeeded, PUSH_DRAW_SHOT } from '../bakery/bake.mjs';

const png = (() => { const p = new PNG({ width: 4, height: 2 }); p.data.fill(200); return PNG.sync.write(p); })();
const FPS = 30;

/**
 * `staticFrames`:这些帧 `__pcStaticProbe` 判静止(其余帧有一个在跑的动画);`damageFrames`:这些帧不带截图的拍报告 `hasDamage`。
 * `log.beats`:按发生的顺序记 `T<帧号>`(下发时间)和每一拍的种类。
 */
function fakeBakery({ staticFrames = [], damageFrames = [], duration = 10 } = {}) {
  const still = new Set(staticFrames), damaged = new Set(damageFrames);
  const log = { beats: [], setFrameWindow: 0 };
  let frame = 0;
  const bakery = {
    log,
    page: {
      async evaluate(fn, arg) {
        const src = String(fn);
        if (src.includes('__pcTimeline')) return { fps: FPS, width: 64, height: 32, duration };
        if (src.includes('__pcSetFrameWindow')) { log.setFrameWindow++; return undefined; }
        if (src.includes('__pcCreateSnapshot')) return { html: `<i data-f="${frame}"></i>`, lossy: 0, controls: null };
        if (src.includes('__pcStaticProbe')) return still.has(frame) ? { anims: 0, finished: 0, raf: 0, mut: 0, video: false, canvas: false } : { anims: 1, finished: 0, raf: 0, mut: 0, video: false, canvas: false };
        if (src.includes('__pcSetT')) { frame = Math.round(arg.sec * FPS); log.beats.push(`T${frame}`); return { raf: 0, mut: 0 }; }
        if (src.includes('data-pc-pixel-map')) return false;
        return undefined;
      },
      async setViewport() {},
      viewport: () => ({ width: 64, height: 32, deviceScaleFactor: 1 }),
      url: () => 'http://127.0.0.1/?export=1',
    },
    client: { async send() {} },
    async beginFrame(extra = {}) {
      const format = extra.screenshot?.format;
      log.beats.push(format === 'png' ? 'P' : format === 'jpeg' ? 'J' : 'n');
      if (format === 'png') return { screenshotData: png.toString('base64'), hasDamage: true };
      if (format === 'jpeg') return { screenshotData: 'AA==', hasDamage: true };
      return { hasDamage: damaged.has(frame) };
    },
    async waitNet() {},
  };
  return bakery;
}

/** 预热之后那一趟里,每一帧各发了几拍 J、几拍 P。`warmSteps`:预热时下发了几次时间(缺省 4:三帧预热 + 重挂载后一帧) */
function perFrame(log, warmSteps = 4) {
  const out = new Map();
  let steps = 0, cur = null;
  for (const b of log.beats) {
    if (b[0] === 'T') { steps++; cur = steps > warmSteps ? Number(b.slice(1)) : null; if (cur !== null && !out.has(cur)) out.set(cur, { J: 0, P: 0 }); continue; }
    if (cur !== null && (b === 'J' || b === 'P')) out.get(cur)[b]++;
  }
  return Object.fromEntries([...out].map(([f, c]) => [f, `${'J'.repeat(c.J)}${'P'.repeat(c.P)}`]));
}

async function bake(bakery, opts) {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-push-draw-test-'));
  const frames = [];
  const log = console.log;
  console.log = () => {};
  try {
    const result = await bakeFrames(bakery, { out, fps: FPS, fullFrame: true, quiet: true, writeFrames: false, staticSkip: false, onFrame: async (i, buf) => { frames.push([i, buf]); }, ...opts });
    return { result, frames };
  } finally {
    console.log = log;
    await fs.rm(out, { recursive: true, force: true });
  }
}

test('pushDrawNeeded:这一趟没画过一定画;画面在变就画;静止时报告了变化、而且上一帧没画过才画(上一帧画过的那一次是回声)', () => {
  assert.equal(pushDrawNeeded({ isStatic: true, damaged: false, drawnBefore: false, previousDrawn: false }), true);
  assert.equal(pushDrawNeeded({ isStatic: false, damaged: false, drawnBefore: true, previousDrawn: true }), true);
  assert.equal(pushDrawNeeded({ isStatic: true, damaged: true, drawnBefore: true, previousDrawn: false }), true);
  assert.equal(pushDrawNeeded({ isStatic: true, damaged: true, drawnBefore: true, previousDrawn: true }), false);
  assert.equal(pushDrawNeeded({ isStatic: true, damaged: false, drawnBefore: true, previousDrawn: false }), false);
});

test('pushDrawEnabled:缺省开;PROMPTCUT_PUSH_DRAW=0 关;调用方给了 pushDraw 以它为准', () => {
  assert.equal(pushDrawEnabled({}, {}), true);
  assert.equal(pushDrawEnabled({}, { PROMPTCUT_PUSH_DRAW: '0' }), false);
  assert.equal(pushDrawEnabled({ pushDraw: true }, { PROMPTCUT_PUSH_DRAW: '0' }), true);
  assert.equal(pushDrawEnabled({ pushDraw: false }, {}), false);
  assert.deepEqual(PUSH_DRAW_SHOT, { format: 'jpeg', quality: 0 });
});

test('drawDiscarded:一拍带截图的 JPEG;prime 时两拍;没交回画面就在原地再发,最多四拍,不报错', async () => {
  const a = fakeBakery();
  assert.equal(await drawDiscarded(a, false), 1);
  assert.equal(await drawDiscarded(a, true), 2);
  assert.deepEqual(a.log.beats, ['J', 'J', 'J']);
  let n = 0;
  const empty = { async beginFrame(extra) { n++; assert.deepEqual(extra.screenshot, PUSH_DRAW_SHOT); return {}; } };
  assert.equal(await drawDiscarded(empty, false), 4);
  assert.equal(n, 4);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(drawDiscarded(a, false, controller.signal), e => e.cancelled);
});

test('bakeFrames 只导一段:推过去的帧里有变化的补一拍、第一帧补两拍、静止的不补;丢掉的不进 onFrame', async () => {
  const bakery = fakeBakery({ staticFrames: [2, 3] });
  const { result, frames } = await bake(bakery, { frames: '4-5', pushDraw: true });
  assert.deepEqual(perFrame(bakery.log), { 0: 'JJ', 1: 'J', 2: '', 3: '', 4: 'PP', 5: 'P' },
    '第 0 帧(这一趟第一帧)两拍,第 1 帧一拍,静止的 2、3 不补;第 4 帧前一帧没画过,照旧先丢一张');
  assert.deepEqual(frames.map(([i]) => i), [4, 5]);
  assert.ok(frames.every(([, buf]) => Buffer.from(buf).equals(png)), '交出去的只有取图的 PNG');
  assert.equal(result.pushDrawn, 3);
});

test('bakeFrames:补画过的帧当「截过」,紧跟着的取图帧不再先丢一张;静止但报告了画面变化的帧,上一帧没画过才补', async () => {
  const bakery = fakeBakery({ staticFrames: [2, 3], damageFrames: [2, 3] });
  const { result } = await bake(bakery, { frames: '4-5', pushDraw: true });
  // 第 2 帧:上一帧(1)刚画过,它报告的变化是回声,不补;第 3 帧:上一帧没画,补
  assert.deepEqual(perFrame(bakery.log), { 0: 'JJ', 1: 'J', 2: '', 3: 'J', 4: 'P', 5: 'P' });
  assert.equal(result.pushDrawn, 4);
});

test('bakeFrames:关掉(pushDraw: false)时一拍都不补,取图那几帧和原来一样', async () => {
  const bakery = fakeBakery({ staticFrames: [2, 3] });
  const { result, frames } = await bake(bakery, { frames: '4-5', pushDraw: false });
  assert.deepEqual(perFrame(bakery.log), { 0: '', 1: '', 2: '', 3: '', 4: 'PP', 5: 'P' });
  assert.deepEqual(frames.map(([i]) => i), [4, 5]);
  assert.equal(result.pushDrawn, 0);
});

test('bakeFrames 整段每帧都取图:一拍都不多走(逐字节基线靠这一条)', async () => {
  const on = fakeBakery({ staticFrames: [1] });
  const off = fakeBakery({ staticFrames: [1] });
  const a = await bake(on, { frames: '0-3', pushDraw: true });
  await bake(off, { frames: '0-3', pushDraw: false });
  assert.deepEqual(perFrame(on.log), { 0: 'PP', 1: 'P', 2: 'P', 3: 'P' });
  assert.deepEqual(on.log.beats, off.log.beats, '开和关逐拍相同');
  assert.equal(a.result.pushDrawn, 0);
});

test('bakeFrames 只生成快照的一趟(get_layout 那样):推过去的帧补画,快照那一帧前面画过就只画一拍', async () => {
  const bakery = fakeBakery({ staticFrames: [1] });
  const snapshots = [];
  const { frames } = await bake(bakery, { fullFrame: false, targetFrames: [3], snapshotOnly: true, snapshotFrames: new Set([3]), onSnapshot: (n, html) => { snapshots.push([n, html]); }, pushDraw: true });
  // 第 3 帧的那一拍是生成快照前画的(`flushFrameLoop`),不是补画;第 2 帧补过,所以它只画一拍
  assert.deepEqual(perFrame(bakery.log), { 0: 'JJ', 1: '', 2: 'J', 3: 'J' });
  assert.deepEqual(snapshots, [[3, '<i data-f="3"></i>']]);
  assert.deepEqual(frames, []);
});

// 带截图矩形(产品里的流都带):矩形在预热之前就设好,那一次设矩形顺手丢的一拍不落在任何一帧里
const seg = (n, extra = {}) => ({ streamSignature: 'S', fromFrame: n * 15, toFrame: n * 15 + 14, stride: 1, fps: FPS, mountFrame: 0, clip: { x: 0, y: 0, w: 32, h: 16 }, ...extra });

test('bakeStream 断租约:回放的帧补画(第一帧两拍),补过以后第一张取图不再先丢;丢掉的不进 onFrame', async () => {
  const bakery = fakeBakery({ staticFrames: [24, 25] });
  const frames = [];
  const stats = await bakeStream(bakery, { ...seg(2), mountFrame: 20, onFrame: async (f, shot) => { frames.push(f); assert.ok(Buffer.from(shot).equals(png)); } });
  const per = perFrame(bakery.log);
  assert.equal(per[20], 'JJ');
  for (const f of [21, 22, 23, 26, 27, 28, 29]) assert.equal(per[f], 'J', `回放的第 ${f} 帧补一拍`);
  for (const f of [24, 25]) assert.equal(per[f], '', `静止的第 ${f} 帧不补`);
  for (let f = 30; f <= 44; f++) assert.equal(per[f], 'P', `第 ${f} 帧只截一张`);
  assert.deepEqual(frames, Array.from({ length: 15 }, (_, i) => 30 + i));
  assert.deepEqual({ replayed: stats.replayed, captured: stats.captured, pushDrawn: stats.pushDrawn }, { replayed: 10, captured: 15, pushDrawn: 9 });
});

test('bakeStream 稀疏分段:只取第一帧,其余帧画面有变化的各补一拍;下一段接着租约,第一帧不再先丢', async () => {
  const bakery = fakeBakery({ staticFrames: [5, 6] });
  const frames = [];
  const first = await bakeStream(bakery, { ...seg(0), stride: 15, onFrame: async (f) => { frames.push(f); } });
  const next = await bakeStream(bakery, { ...seg(1), stride: 15, onFrame: async (f) => { frames.push(f); } });
  const per = perFrame(bakery.log);
  assert.equal(per[0], 'PP', '这份租约的第一张照旧先丢一张');
  for (let f = 1; f <= 14; f++) assert.equal(per[f], f === 5 || f === 6 ? '' : 'J');
  assert.equal(per[15], 'P');
  assert.deepEqual(frames, [0, 15]);
  assert.equal(first.pushDrawn, 12);
  assert.equal(next.reset, false);
  assert.equal(next.pushDrawn, 14);
});

test('bakeStream 接着租约的满密度分段:一拍都不补;关掉时回放也不补、第一张取图照旧先丢一张', async () => {
  const dense = fakeBakery();
  await bakeStream(dense, { ...seg(0), onFrame: async () => {} });
  const again = await bakeStream(dense, { ...seg(1), onFrame: async () => {} });
  assert.deepEqual(Object.values(perFrame(dense.log)).filter(x => x.includes('J')), []);
  assert.equal(again.pushDrawn, 0);
  const off = fakeBakery();
  const stats = await bakeStream(off, { ...seg(2), mountFrame: 20, pushDraw: false, onFrame: async () => {} });
  const per = perFrame(off.log);
  assert.deepEqual(Object.values(per).filter(x => x.includes('J')), []);
  assert.equal(per[30], 'PP');
  assert.equal(stats.pushDrawn, 0);
});

test('createStepper:记下这一帧的拍子里有没有报告画面变化(step.last),不改返回值', async () => {
  const bakery = fakeBakery({ staticFrames: [7], damageFrames: [7, 8] });
  const step = createStepper(bakery, { fps: FPS });
  assert.deepEqual(step.last, { frame: null, damaged: false, isStatic: false });
  assert.equal(await step(7, false), true);
  assert.deepEqual(step.last, { frame: 7, damaged: true, isStatic: true });
  assert.equal(await step(9, false), false);
  assert.deepEqual(step.last, { frame: 9, damaged: false, isStatic: false });
});
