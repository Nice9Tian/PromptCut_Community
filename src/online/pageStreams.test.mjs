/**
 * 本页产流的编排(`pageStreams.ts`,任务书 `docs/plan/render-refactor-task.md`「甲二」):什么时候轮到本页自己产、先查、让路、停手、层表。
 *
 *   PS-01  计划发出去没人认领:等满 PAGE_STREAM_WAIT_MS 才动手;先查、把自己的那一行写进层表、再产;产完叫宿主认这个结果键
 *   PS-02  有能切分的节点接了活(计划是 claimed / done):不产;done 之后不再问队列
 *   PS-03  先查:自己的键已经有 → 不产;层表里别的能播的流已经有(同内容键,或内容键不同但输入签名没过期)→ 不产,认的是那个候选的键;
 *          输入签名过期的行(旧参数的流)不算
 *   PS-04  让路:播放、拖动、更急的活 —— 当前帧做完就停,闲下来接着做;页面隐藏马上中止;让路后当前帧 1 秒做不完就中止
 *   PS-05  产到一半有切分方接了活:做完当前帧就停,不再开工
 *   PS-06  产到一半别处产出来了:停下,改用现成的
 *   PS-07  不闲不开工;不是节点(不能产)时什么都不做;换了一版计划,旧一版在产的马上中止
 *   PS-08  层表:开工前写;本页的那一行被别人盖掉之后重写;有切分方接了活之后不再写
 *   PS-09  口子:产几趟、每趟多密由 passes 定(先稀疏后满密度时,先把每条流的稀疏那一趟都做完)
 *   PS-10  做不成:退避后再试,连着不成放下这一段;没活了不再问队列
 *   PS-11  本页的那一行被别的写层表的一方盖掉、而它整条产好了:不写回去(不来回盖)
 *   PS-12  缺省两趟:先稀疏后满密度;稀疏的任务是稀疏流任务(id 末尾 `:sparse`);稀疏的都落定了满密度才开始(稀疏的在退避,满密度的也等);
 *          先查按这一趟的密度认(稀疏的一趟有一版就算,满密度的一趟要满密度)
 *   PS-13  测量时就产稀疏版(`measure()`):不等清单计划、不问有没有切分方;先查、写层表、产、认;已经有的不产;只做稀疏的一趟
 *   PS-14  遮罩等稀疏版最多 MEASURE_SPARSE_MAX_MS:从这一轮第一次调起算,到时当场回、在产的做完当前帧就停(迟迟不停就中止),
 *          这一轮之后再调马上回;换一轮时钟重来
 *   PS-15  测量时的那一份记账在清单计划发出来之前留着;计划发出来就换成计划的,测量时产的稀疏版查得到、不重产,之后才补满密度
 *   PS-16  测量时本页还没当上节点:等 MEASURE_READY_WAIT_MS,等到了照常产,等不到回 incapable(归闲时)
 *   PS-17  只为本页产稀疏版(身份为手机、只有一个舞台)时 isConfigSupported 通过:只产稀疏版、不产满密度版
 *   PS-18  只为本页产稀疏版时 isConfigSupported 返回不支持:停产退回
 *   PS-19  只为本页产稀疏版时编码连错 3 次:停产退回
 *
 * 跑:npm test -- src/online/pageStreams.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPageStreams, PAGE_STREAM_WAIT_MS, PAGE_STREAM_POLL_MS, PAGE_STREAM_RECHECK_MS, PAGE_STREAM_ROWS_MS, PAGE_STREAM_ATTEMPTS,
  PAGE_STREAM_PASSES, MEASURE_SPARSE_MAX_MS, MEASURE_READY_WAIT_MS } from "./pageStreams.ts";
import { YIELD_FRAME_MAX_MS } from "./browserNode.ts";

const flush = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const FP = "2222222222222222";
const PROJECT = { id: "proj", fps: 30, width: 1920, height: 1080, tracks: [{ id: "t", clips: [{ id: "clip-a", cardId: "punch-pill", start: 0, end: 4 }, { id: "clip-b", cardId: "focus-card", start: 4, end: 5 }] }] };
/**
 * 一条单卡流的计划:片段从项目的第 `startFrame` 帧起,共 `segments` 个满的分段。分段从这条流自己的第一帧起数
 * (`originFrame` = `startFrame`),所以 `firstSegment` 恒为 0、`lastSegment` = `segments - 1`。
 */
const specOf = (clipId, contentKey, startFrame, segments) => ({
  kind: "card", plane: "local", clipIds: [clipId], topClipId: clipId, cardId: "punch-pill", contentKey, streamKey: `rk-${contentKey}`, envFingerprint: FP,
  fps: 30, stage: { width: 1920, height: 1080 }, total: 300, firstFrame: startFrame, lastFrame: startFrame + segments * 15 - 1, originFrame: startFrame, firstSegment: 0, lastSegment: segments - 1,
  offset: { x: 0, y: 0 }, bound: { x: 0, y: 0, w: 640, h: 360 }, compositing: "independent",
  bake: { start: startFrame / 30, end: (startFrame + segments * 15) / 30, count: segments * 15, sampling: { firstFrame: startFrame, fps: { numerator: "30", denominator: "1" }, phase: { numerator: "0", denominator: "1" } } },
});
const PLAN = { id: "plan:proj@7#clips:x", projectId: "proj", projectRev: 7, clips: ["clip-a", "clip-b"], at: 1000 };

/** 一套假的宿主:假时钟、队列状态、内容库(层表与清单)、产一段的活 */
function rig(over = {}) {
  const w = {
    now: 1000, idle: true, capable: true, plan: PLAN, state: "open",
    specs: [specOf("clip-a", "ka", 0, 10), specOf("clip-b", "kb", 120, 2)],
    /** 结果键 → 已有清单的范围(`from-to`) */
    present: new Set(), layerMap: null, written: [], alive: [], produced: [], probes: 0, specCalls: 0,
    /** 在产的那一段:测试里手动放行 */
    current: null, readFails: false, lookups: [],
  };
  const has = (key, need) => w.present.has(key) || (need?.dense === false && w.present.has(`${key}#sparse`));
  const deps = {
    // 旧的条目(PS-01 ～ PS-11)只看满密度的一趟;两趟的次序在 PS-09、PS-12 里看
    passes: [{ name: "dense", stride: 1 }],
    now: () => w.now,
    capable: () => w.capable,
    isIdle: () => w.idle,
    plan: () => w.plan,
    planState: async () => { w.probes++; return w.state; },
    codeVersion: "cv",
    specs: async () => { w.specCalls++; return { specs: w.specs, skipped: { other: "canvas" }, project: PROJECT }; },
    // `present` 里 `<键>:<起>-<止>` 是满密度的清单,后面多 `#sparse` 是只有稀疏版的清单;稀疏的一趟两种都认
    lookupOwn: async (task, need) => { w.lookups.push({ id: task.id, dense: need?.dense }); return has(`${task.resultKey}:${task.range.from}-${task.range.to}`, need); },
    lookupOther: async (resultKey, range, need) => has(`${resultKey}:${range.from}-${range.to}`, need),
    readLayerMap: async () => { if (w.readFails) throw new Error("断了"); return w.layerMap; },
    writeLayerMap: async (_project, body) => { w.layerMap = body; w.written.push(body); },
    produce: (job) => new Promise((resolve, reject) => {
      w.produced.push({ id: job.task.id, stride: job.stride });
      w.current = { job, resolve, reject };
      job.signal.addEventListener("abort", () => reject(Object.assign(new Error("已中止"), { retryable: true })), { once: true });
    }),
    onAlive: (key) => w.alive.push(key),
    ...over,
  };
  const pages = createPageStreams(deps);
  /** 走 ms 毫秒,每 250 毫秒一拍(宿主的节拍) */
  const run = async (ms) => { for (let t = 0; t < ms; t += 250) { w.now += 250; pages.tick(); await flush(); } };
  /** 把在产的这一段做完(清单进内容库) */
  const finish = async () => {
    const c = w.current;
    w.current = null;
    w.present.add(`${c.job.task.resultKey}:${c.job.task.range.from}-${c.job.task.range.to}${c.job.stride > 1 ? "#sparse" : ""}`);
    c.resolve("done");
    await flush();
  };
  /** 在产的这一段因让路停手 */
  const yielded = async () => { const c = w.current; w.current = null; c.resolve("yielded"); await flush(); };
  return { w, pages, run, finish, yielded };
}

test("PS-01 没人认领:等满等待时间才动手;先查、写层表、再产;产完认这个结果键", async () => {
  const { w, pages, run, finish } = rig();
  pages.tick();
  await flush();
  assert.equal(pages.debug().state, "waiting");
  await run(PAGE_STREAM_WAIT_MS - 500);
  assert.equal(w.produced.length, 0, "没等满不动手");
  assert.equal(pages.debug().planState, "open");
  await run(1000);
  assert.equal(w.produced.length, 1, "等满了开工");
  assert.deepEqual(w.produced[0], { id: "stream:rk-ka:0-9", stride: 1 }, "任务 id 与切分方给浏览器出的那一份同一个式子;满密度");
  // 开工前层表里已经有本页的那一行
  assert.equal(w.written.length, 1);
  assert.equal(w.written[0].kind, "layer-map");
  assert.deepEqual(w.written[0].streams.map((r) => [r.topClipId, r.contentKey, r.candidates[0].resultKey, r.originFrame, r.lastSegment, r.segmentsPerTask, "firstSegment" in r]), [["clip-a", "ka", "rk-ka", 0, 9, 8, false]]);
  assert.equal(pages.running(), true);
  assert.equal(pages.debug().state, "producing");
  await finish();
  assert.deepEqual(w.alive, ["rk-ka"]);
  // 接着做下一条流(clip-a 为 motion 卡不足 30 秒一口气做完，下一条流为 clip-b)
  await run(500);
  assert.equal(w.produced[1].id, "stream:rk-kb:0-1");
  await finish();
  await run(500);
  const d = pages.debug();
  assert.equal(d.state, "done");
  assert.equal(d.counters.produced, 2);
  assert.deepEqual(d.jobs.map((j) => j.state), ["produced", "produced"]);
  assert.deepEqual(w.layerMap.streams.map((r) => r.topClipId).sort(), ["clip-a", "clip-b"]);
  assert.deepEqual(d.skipped, { other: "canvas" });
  assert.equal(w.specCalls, 1, "这一版的流只算一次");
});

test("PS-02 有能切分的节点接了活:不产;done 之后不再问队列", async () => {
  for (const state of ["claimed", "done"]) {
    const { w, pages, run } = rig();
    w.state = state;
    await run(PAGE_STREAM_WAIT_MS + 6000);
    assert.equal(w.produced.length, 0, state);
    assert.equal(w.written.length, 0, "层表归切分方,不写");
    assert.equal(pages.debug().state, "taken");
    if (state === "done") assert.equal(w.probes, 1, "done 是终态,只问一次");
    else assert.ok(w.probes > 2, "claimed 接着问(切分方可能放回)");
  }
  // 认领的节点放回了(又成了 open):过了等待时间照常自己产
  const { w, run } = rig();
  w.state = "claimed";
  await run(PAGE_STREAM_WAIT_MS + 2000);
  w.state = "open";
  await run(PAGE_STREAM_POLL_MS + 1000);
  assert.equal(w.produced.length, 1);
});

test("PS-03 先查:自己的键已经有、别的候选已经有,都不产", async () => {
  // 自己的键:两段都有
  const own = rig();
  for (const k of ["rk-ka:0-9", "rk-kb:0-1"]) own.w.present.add(k);
  await own.run(PAGE_STREAM_WAIT_MS + 3000);
  assert.equal(own.w.produced.length, 0);
  assert.equal(own.pages.debug().counters.have, 2);
  assert.equal(own.pages.debug().state, "done");
  assert.deepEqual([...new Set(own.w.alive)].sort(), ["rk-ka", "rk-kb"]);
  assert.ok(own.w.written.length >= 1, "自己的键有了,层表里要有本页的那一行");
  // 别的候选(桌面产的):层表里这张卡、这个内容键的行列着它的键
  const other = rig();
  other.w.specs = [specOf("clip-a", "ka", 0, 8)];
  other.w.layerMap = { v: 3, kind: "layer-map", projectId: "proj", layers: [], streams: [
    { topClipId: "clip-a", clipIds: ["clip-a"], kind: "card", plane: "local", contentKey: "ka", candidates: [{ envFingerprint: "desktop", resultKey: "rk-desktop" }], originFrame: 0, lastSegment: 7, segmentsPerTask: 8 }] };
  other.w.present.add("rk-desktop:0-7");
  await other.run(PAGE_STREAM_WAIT_MS + 2000);
  assert.equal(other.w.produced.length, 0, "桌面产好的直接用");
  assert.deepEqual(other.w.alive, ["rk-desktop"], "认的是那个候选的键");
  assert.equal(other.w.written.length, 0, "别人的流,本页不往层表里加自己的候选");
  assert.equal(other.pages.debug().jobs[0].state, "elsewhere");
  // 内容键不同、输入签名没过期的行(别的环境按它自己的键产的同一条流:代码版本不同、字体不同):同样直接用;它的清单按它那一行的范围分份
  const foreign = rig();
  foreign.w.specs = [specOf("clip-a", "ka", 0, 10)];
  foreign.w.layerMap = { ...other.w.layerMap, streams: [{ ...other.w.layerMap.streams[0], contentKey: "their-ka", lastSegment: 9, segmentsPerTask: 4 }] };
  for (const k of ["rk-desktop:0-3", "rk-desktop:4-7", "rk-desktop:8-9"]) foreign.w.present.add(k);
  await foreign.run(PAGE_STREAM_WAIT_MS + 3000);
  assert.equal(foreign.w.produced.length, 0);
  assert.deepEqual(foreign.pages.debug().jobs.map((j) => [j.state, j.via]), [["elsewhere", "rk-desktop"]]);
  // 它只产了一部分(缺 8～9 那一份):本页整张(0～9)自己产,因为 motion 卡切分至少 30 秒不足 30 秒整卡产
  const partly = rig();
  partly.w.specs = [specOf("clip-a", "ka", 0, 10)];
  partly.w.layerMap = structuredClone(foreign.w.layerMap);
  for (const k of ["rk-desktop:0-3", "rk-desktop:4-7"]) partly.w.present.add(k);
  await partly.run(PAGE_STREAM_WAIT_MS + 3000);
  assert.deepEqual(partly.w.produced.map((x) => x.id), ["stream:rk-ka:0-9"]);
  // 输入签名过期的行(旧参数的流)不算
  const stale = rig();
  stale.w.specs = [specOf("clip-a", "ka", 0, 8)];
  stale.w.layerMap = { ...other.w.layerMap, streams: [{ ...other.w.layerMap.streams[0], contentKey: "old", inputSig: "s1-0000000000000000" }] };
  stale.w.present.add("rk-desktop:0-7");
  await stale.run(PAGE_STREAM_WAIT_MS + 2000);
  assert.equal(stale.w.produced.length, 1);
  assert.deepEqual(stale.w.layerMap.streams.map((r) => r.contentKey), ["ka"], "过期的那一行换成本页的");
});

test("PS-04 让路:播放、拖动做完当前帧就停,闲下来接着做;隐藏马上中止;当前帧 1 秒做不完就中止", async () => {
  const { w, pages, run, yielded } = rig();
  await run(PAGE_STREAM_WAIT_MS + 500);
  assert.equal(w.produced.length, 1);
  const first = w.current.job;
  assert.equal(first.yielding(), false);
  // 播放开始:不中止,等当前帧
  w.idle = false;
  pages.yieldFor("play");
  assert.equal(first.yielding(), true, "每帧前问到要让路");
  assert.equal(first.signal.aborted, false, "当前帧做完再停,不中止");
  await yielded();
  assert.equal(pages.running(), false);
  assert.equal(pages.debug().counters.yields.play, 1);
  // 播放期间不开工
  await run(3000);
  assert.equal(w.produced.length, 1, "播放期间不产");
  // 停下、闲了:接着做同一段(已推完的分段由宿主按任务 id 留着)
  w.idle = true;
  await run(500);
  assert.equal(w.produced.length, 2);
  assert.equal(w.produced[1].id, w.produced[0].id, "接着做同一段");
  // 拖动:同样等当前帧;1 秒做不完就中止
  const second = w.current.job;
  w.idle = false;
  pages.yieldFor("drag");
  assert.equal(second.signal.aborted, false);
  await run(YIELD_FRAME_MAX_MS + 250);
  assert.equal(second.signal.aborted, true, "当前帧迟迟做不完:中止");
  await flush();
  assert.equal(pages.running(), false);
  assert.equal(pages.debug().counters.yields.drag, 1);
  assert.equal(pages.debug().counters.aborts, 1);
  // 页面隐藏:不等当前帧
  w.idle = true;
  await run(500);
  const third = w.current.job;
  pages.yieldFor("hidden");
  assert.equal(third.signal.aborted, true, "隐藏马上中止");
  await flush();
  assert.equal(pages.debug().counters.yields.hidden, 1);
  // 让路不算做不成
  assert.deepEqual(pages.debug().jobs.map((j) => j.fails), [0, 0]);
});

test("PS-05 产到一半有切分方接了活:做完当前帧就停,不再开工", async () => {
  const { w, pages, run, yielded } = rig();
  await run(PAGE_STREAM_WAIT_MS + 500);
  const job = w.current.job;
  w.state = "claimed";
  await run(PAGE_STREAM_POLL_MS + 500);
  assert.equal(job.yielding(), true);
  assert.equal(job.signal.aborted, false);
  await yielded();
  assert.equal(pages.debug().counters.stops.splitter, 1);
  await run(8000);
  assert.equal(w.produced.length, 1, "不再自己产");
  assert.equal(pages.debug().state, "taken");
});

test("PS-06 产到一半别处产出来了:停下,改用现成的", async () => {
  const { w, pages, run, yielded } = rig();
  w.specs = [specOf("clip-a", "ka", 0, 8)];
  await run(PAGE_STREAM_WAIT_MS + 500);
  const job = w.current.job;
  // 桌面连上来、产好了、把自己的候选写进了层表
  w.layerMap = { ...w.layerMap, streams: [{ ...w.layerMap.streams[0], candidates: [{ envFingerprint: "desktop", resultKey: "rk-desktop" }, ...w.layerMap.streams[0].candidates] }] };
  w.present.add("rk-desktop:0-7");
  await run(PAGE_STREAM_RECHECK_MS + 500);
  assert.equal(job.yielding(), true, "查到别处有了:当前帧做完就停");
  await yielded();
  const d = pages.debug();
  assert.equal(d.counters.stops.elsewhere, 1);
  assert.equal(d.jobs[0].state, "elsewhere");
  assert.equal(d.jobs[0].via, "rk-desktop");
  assert.deepEqual(w.alive, ["rk-desktop"]);
  await run(3000);
  assert.equal(w.produced.length, 1, "不重产");
});

test("PS-07 不闲不开工;不能产时什么都不做;换了一版计划,旧一版在产的马上中止", async () => {
  const busy = rig();
  busy.w.idle = false;
  await busy.run(PAGE_STREAM_WAIT_MS + 5000);
  assert.equal(busy.w.produced.length, 0);
  assert.equal(busy.pages.debug().state, "idle-wait");
  assert.equal(busy.w.written.length, 0, "没开工,不写层表");
  const off = rig();
  off.w.capable = false;
  await off.run(PAGE_STREAM_WAIT_MS + 3000);
  assert.equal(off.w.specCalls, 0);
  assert.equal(off.w.probes, 0, "不是节点:一条消息也不发");
  assert.equal(off.pages.debug().state, "off");
  const none = rig();
  none.w.plan = null;
  await none.run(3000);
  assert.equal(none.w.probes, 0);
  // 换了一版
  const { w, pages, run } = rig();
  await run(PAGE_STREAM_WAIT_MS + 500);
  const job = w.current.job;
  w.plan = { ...PLAN, id: "plan:proj@8#clips:x", projectRev: 8, at: w.now };
  w.specs = [specOf("clip-a", "ka2", 0, 8)];
  await run(250);
  assert.equal(job.signal.aborted, true, "旧一版在产的马上停");
  assert.equal(pages.debug().counters.stops["plan-changed"], 1);
  await run(PAGE_STREAM_WAIT_MS + 1000);
  assert.equal(w.produced.at(-1).id, "stream:rk-ka2:0-7", "新一版等满之后产新的键");
  // 下线
  pages.stop("offline");
  assert.equal(pages.running() && !w.current.job.signal.aborted, false);
  assert.equal(pages.debug().state, "off");
});

test("PS-08 层表:本页的那一行被别人盖掉之后重写;有切分方接了活之后不再写", async () => {
  const { w, pages, run, finish } = rig();
  w.specs = [specOf("clip-a", "ka", 0, 8)];
  await run(PAGE_STREAM_WAIT_MS + 500);
  await finish();
  await run(500);
  const writes = w.written.length;
  assert.ok(writes >= 1);
  // 没有变化:核对了也不写
  await run(PAGE_STREAM_ROWS_MS + 1000);
  assert.equal(w.written.length, writes);
  // 另一个页面后写,把本页的那一行盖掉了
  w.layerMap = { v: 3, kind: "layer-map", projectId: "proj", layers: [], streams: [{ topClipId: "clip-z", clipIds: ["clip-z"], kind: "card", plane: "local", contentKey: "z", candidates: [{ envFingerprint: "x", resultKey: "rz" }], firstSegment: 0, lastSegment: 0, segmentsPerTask: 8 }] };
  await run(PAGE_STREAM_ROWS_MS + 1000);
  assert.equal(w.written.length, writes + 1, "重写");
  assert.deepEqual(w.layerMap.streams.map((r) => r.topClipId).sort(), ["clip-a", "clip-z"], "别人的行留着");
  // 读不到层表:不写,下一拍再试
  assert.equal(pages.debug().counters.rowsFailed, 0);
});

test("PS-09 口子:产几趟、每趟多密由 passes 定", async () => {
  const { w, run, finish } = rig({ passes: [{ name: "sparse", stride: 15 }, { name: "dense", stride: 1 }] });
  w.specs = [specOf("clip-a", "ka", 0, 8), specOf("clip-b", "kb", 120, 2)];
  // 自己的键查不到(每一趟都要做):这里让「先查」一直查不到
  w.present = { has: () => false, add: () => {} };
  await run(PAGE_STREAM_WAIT_MS + 500);
  for (let i = 0; i < 4; i++) { await finish(); await run(500); }
  assert.deepEqual(w.produced.slice(0, 4), [
    { id: "stream:rk-ka:0-7:sparse", stride: 15 }, { id: "stream:rk-kb:0-1:sparse", stride: 15 },
    { id: "stream:rk-ka:0-7", stride: 1 }, { id: "stream:rk-kb:0-1", stride: 1 },
  ], "先把每条流稀疏的那一趟做完,再补满密度");
});

test("PS-10 做不成:退避后再试,连着不成放下这一段;没活了不再问队列", async () => {
  const { w, pages, run } = rig();
  w.specs = [specOf("clip-a", "ka", 0, 8)];
  await run(PAGE_STREAM_WAIT_MS + 500);
  for (let i = 1; i <= PAGE_STREAM_ATTEMPTS; i++) {
    assert.equal(w.produced.length, i, `第 ${i} 次`);
    const c = w.current;
    w.current = null;
    c.reject(Object.assign(new Error("舞台没有交出这一帧的像素"), { retryable: true }));
    await flush();
    await run(2000 * i + 500);
  }
  const d = pages.debug();
  assert.equal(d.jobs[0].state, "failed");
  assert.equal(d.counters.failed, 1);
  assert.match(d.lastError, /像素/);
  const probes = w.probes;
  await run(10_000);
  assert.equal(w.produced.length, PAGE_STREAM_ATTEMPTS, "不再试");
  assert.equal(w.probes, probes, "没活了不再问队列");
});

test("PS-11 本页的那一行被别的写层表的一方盖掉、而它整条产好了:不写回去", async () => {
  const { w, pages, run, finish } = rig();
  w.specs = [specOf("clip-a", "ka", 0, 8)];
  await run(PAGE_STREAM_WAIT_MS + 500);
  await finish();
  await run(500);
  const writes = w.written.length;
  // 另一方(比如代码版本不同的桌面)按它自己的键把同一条流整条产好了,并用它的层表盖掉了本页的
  w.layerMap = { v: 3, kind: "layer-map", projectId: "proj", layers: [], streams: [
    { topClipId: "clip-a", clipIds: ["clip-a"], kind: "card", plane: "local", contentKey: "their-ka", candidates: [{ envFingerprint: "desktop", resultKey: "rk-desktop" }], originFrame: 0, lastSegment: 7, segmentsPerTask: 8 }] };
  w.present.add("rk-desktop:0-7");
  await run(PAGE_STREAM_ROWS_MS + 1000);
  await run(PAGE_STREAM_ROWS_MS + 1000);
  assert.equal(w.written.length, writes, "不写回去");
  assert.equal(pages.debug().counters.rowsYielded, 1);
  assert.deepEqual(w.layerMap.streams.map((r) => r.contentKey), ["their-ka"]);
  // 对照:盖掉本页那一行的一方并没有产好(清单不在):写回去
  const again = rig();
  again.w.specs = [specOf("clip-a", "ka", 0, 8)];
  await again.run(PAGE_STREAM_WAIT_MS + 500);
  await again.finish();
  await again.run(500);
  const n = again.w.written.length;
  again.w.layerMap = structuredClone(w.layerMap);
  await again.run(PAGE_STREAM_ROWS_MS + 1000);
  assert.equal(again.w.written.length, n + 1);
  assert.deepEqual(again.w.layerMap.streams.map((r) => r.contentKey), ["ka", "their-ka"], "本页的在前,别人没过期的那一行留在后面");
});

test("PS-12 缺省两趟:稀疏的都落定了满密度才开始;先查按这一趟的密度认", async () => {
  assert.deepEqual(PAGE_STREAM_PASSES.map((p) => p.stride), [15, 1], "缺省先稀疏(一个分段的帧数)后满密度");
  const { w, pages, run, finish } = rig({ passes: undefined });
  w.specs = [specOf("clip-a", "ka", 0, 8), specOf("clip-b", "kb", 120, 2)];
  await run(PAGE_STREAM_WAIT_MS + 500);
  assert.deepEqual(w.produced[0], { id: "stream:rk-ka:0-7:sparse", stride: 15 }, "先做稀疏的一趟;任务是稀疏流任务");
  assert.deepEqual(w.lookups[0], { id: "stream:rk-ka:0-7:sparse", dense: false }, "稀疏的一趟先查不要求满密度");
  await finish();
  await run(500);
  assert.equal(w.produced[1].id, "stream:rk-kb:0-1:sparse");
  // 第二条流的稀疏那一趟做不成(退避中):满密度的不许先开工
  const c = w.current;
  w.current = null;
  c.reject(Object.assign(new Error("舞台没有交出这一帧的像素"), { retryable: true }));
  await run(1500);
  assert.equal(w.produced.length, 2, "稀疏的在退避,满密度的等着");
  assert.equal(pages.debug().jobs.filter((j) => j.pass === "dense").every((j) => j.state === "todo"), true);
  await run(1000);
  assert.equal(w.produced[2].id, "stream:rk-kb:0-1:sparse", "退避完再试的还是稀疏的那一段");
  await finish();
  await run(500);
  assert.deepEqual(w.produced[3], { id: "stream:rk-ka:0-7", stride: 1 }, "稀疏的都齐了才补满密度");
  assert.equal(w.lookups.find((l) => l.id === "stream:rk-ka:0-7").dense, true, "满密度的一趟先查要满密度:只有稀疏版不算有");
  await finish();
  await run(500);
  await finish();
  await run(500);
  assert.equal(pages.debug().state, "done");
  assert.deepEqual(pages.debug().jobs.map((j) => [j.pass, j.state]), [["sparse", "produced"], ["sparse", "produced"], ["dense", "produced"], ["dense", "produced"]]);
});

const REQ = { round: 1, projectId: "proj", projectRev: 7, clips: ["clip-a"], heavy: ["clip-a", "clip-b"] };

test("PS-13 测量时就产稀疏版:不等计划、不问切分方、不看闲不闲;先查、写层表、产、认;已经有的不产", async () => {
  const { w, pages, run, finish } = rig({ passes: undefined });
  w.plan = null;        // 测量还没落定,清单计划没发
  w.state = "claimed";  // 就算有切分方也照产(它管的是清单计划)
  w.idle = false;       // 闲时闸不管测量时这一趟
  w.specs = [specOf("clip-a", "ka", 0, 10), specOf("clip-b", "kb", 120, 2)];
  let out = null;
  void pages.measure(REQ).then((o) => { out = o; });
  await flush();
  assert.deepEqual(w.produced, [{ id: "stream:rk-ka:0-9:sparse", stride: 15 }], "只产刚测完的这张卡;稀疏的一趟");
  assert.equal(pages.running(), true);
  assert.equal(w.written.length, 1, "开工前写了层表里本页的那一行");
  assert.deepEqual(w.written[0].streams.map((r) => r.topClipId), ["clip-a"]);
  assert.equal(out, null, "产完之前遮罩等着");
  await finish();
  assert.deepEqual(out, { result: "ok", produced: 1, have: 0, elsewhere: 0, left: 0 });
  assert.deepEqual([...new Set(w.alive)], ["rk-ka"], "叫宿主认这个结果键(本页先用自己产的)");
  assert.equal(w.produced.length, 1, "满密度的一趟不在测量时做");
  assert.equal(w.probes, 0, "不问队列");
  // 没有计划的时候节拍照走:这一份记账留着,不被当成「没有计划」清掉
  await run(2000);
  assert.equal(pages.debug().state, "measuring");
  assert.equal(pages.debug().streams.length, 1);
  // 下一张卡:素材服务里已经有稀疏版(别人产的、上次打开产的)就直接用
  w.present.add("rk-kb:0-1#sparse");
  const second = await pages.measure({ ...REQ, clips: ["clip-b"] });
  assert.deepEqual(second, { result: "ok", produced: 0, have: 1, elsewhere: 0, left: 0 });
  assert.equal(w.produced.length, 1, "已经有的不重产");
  assert.deepEqual(pages.debug().measure.results, { ok: 2 });
  // 判轻的卡、本页产不了的卡:没有它的流
  const none = await pages.measure({ ...REQ, clips: ["clip-x"] });
  assert.equal(none.result, "none");
});

test("PS-14 遮罩等稀疏版最多 MEASURE_SPARSE_MAX_MS:到时当场回、在产的停手;之后这一轮马上回;换一轮重来", async () => {
  assert.equal(MEASURE_SPARSE_MAX_MS, 50_000);
  const { w, pages, run } = rig({ passes: undefined });
  w.plan = null;
  w.specs = [specOf("clip-a", "ka", 0, 10), specOf("clip-b", "kb", 120, 2)];
  let out = null;
  const t0 = w.now;
  void pages.measure(REQ).then((o) => { out = o; });
  await flush();
  assert.equal(w.produced.length, 1);
  await run(MEASURE_SPARSE_MAX_MS - 500);
  assert.equal(out, null, "没到时遮罩等着");
  assert.equal(w.current.job.yielding(), false);
  await run(500);
  assert.equal(out?.result, "deadline", "到 50 秒当场回(这张卡拖得再久也进编辑)");
  assert.equal(out.left, 1);
  assert.equal(w.now - t0, MEASURE_SPARSE_MAX_MS);
  assert.equal(w.current.job.yielding(), true, "在产的做完当前这一帧就停");
  assert.equal(w.current.job.signal.aborted, false);
  // 当前这一帧迟迟做不完:照让路的时限中止
  await run(YIELD_FRAME_MAX_MS + 250);
  assert.equal(pages.running(), false);
  assert.equal(pages.debug().counters.stops.deadline, 1);
  // 这一轮之后再调:马上回,不产
  const again = await pages.measure({ ...REQ, clips: ["clip-b"] });
  assert.equal(again.result, "deadline");
  assert.equal(w.produced.length, 1);
  // 时钟从这一轮第一次调起算:第二张卡开始得晚,等的时间也只到同一个时刻
  const two = rig({ passes: undefined });
  two.w.plan = null;
  two.w.specs = w.specs;
  void two.pages.measure(REQ).then(() => {});
  await flush();
  await two.run(30_000);
  await two.finish();
  let late = null;
  void two.pages.measure({ ...REQ, clips: ["clip-b"] }).then((o) => { late = o; });
  await flush();
  await two.run(19_500);
  assert.equal(late, null);
  await two.run(500);
  assert.equal(late?.result, "deadline", "第二张卡只等到这一轮的第 50 秒");
  // 换一轮(切了帧率,遮罩又出现):时钟重来
  await two.run(YIELD_FRAME_MAX_MS + 250);
  let next = null;
  void two.pages.measure({ ...REQ, round: 2, clips: ["clip-b"] }).then((o) => { next = o; });
  await flush();
  assert.equal(next, null, "新的一轮照常产");
  assert.equal(two.pages.running(), true);
  two.pages.stop();
  await flush();
  assert.equal(next?.result, "stopped", "下线时在等的那一次当场回,不把遮罩挂住");
});

test("PS-15 计划发出来就换成计划的那一份:测量时产的稀疏版查得到、不重产;之后才补满密度", async () => {
  const { w, pages, run, finish } = rig({ passes: undefined });
  w.plan = null;
  w.specs = [specOf("clip-a", "ka", 0, 8), specOf("clip-b", "kb", 120, 2)];
  void pages.measure(REQ);
  await flush();
  await finish();
  assert.equal(w.produced.length, 1);
  // 测量落定,清单计划发出来(发成的时刻晚于测量)
  w.plan = { ...PLAN, at: w.now + 250 };
  await run(PAGE_STREAM_WAIT_MS + 1000);
  assert.equal(pages.debug().planId, PLAN.id);
  assert.equal(pages.debug().jobs.find((j) => j.id === "stream:rk-ka:0-7:sparse").state, "have", "测量时产的那一段:先查查到,不重产");
  assert.equal(w.produced[1].id, "stream:rk-kb:0-1:sparse", "没测到的卡的稀疏版闲时接着产");
  await finish();
  await run(500);
  assert.equal(w.produced[2].id, "stream:rk-ka:0-7", "稀疏的都齐了才补满密度");
  // 旧的计划(发成的时刻早于测量的那一份记账)不把测量的那一份换掉:切帧率重走遮罩时手里还留着上一版计划
  const old = rig({ passes: undefined });
  old.w.specs = w.specs;
  old.w.plan = { ...PLAN, at: old.w.now - 5000 };
  old.w.idle = false;
  await old.run(1000);
  assert.equal(old.pages.debug().planId, PLAN.id);
  void old.pages.measure(REQ);
  await flush();
  await old.run(1000);
  assert.equal(old.pages.debug().planId, "measure:proj@7");
  assert.equal(old.pages.running(), true);
});

test("PS-16 测量时本页还没当上节点:等一会儿,等到了照常产,等不到回 incapable", async () => {
  const { w, pages, run } = rig({ passes: undefined });
  w.plan = null;
  w.capable = false;
  let out = null;
  void pages.measure(REQ).then((o) => { out = o; });
  await run(MEASURE_READY_WAIT_MS - 500);
  assert.equal(out, null);
  w.capable = true;
  await run(500);
  assert.equal(w.produced.length, 1, "拿到指纹、探到编码器了:照常产");
  pages.stop();
  await flush();
  const never = rig({ passes: undefined });
  never.w.plan = null;
  never.w.capable = false;
  let got = null;
  void never.pages.measure(REQ).then((o) => { got = o; });
  await never.run(MEASURE_READY_WAIT_MS + 250);
  assert.equal(got?.result, "incapable");
  assert.equal(never.w.produced.length, 0);
});

test("PS-17 只为本页产稀疏版时 isConfigSupported 通过:只产稀疏版、不产满密度版", async () => {
  let checkedConfig = null;
  const { w, pages, run, finish } = rig({
    sparseOnly: true,
    passes: undefined,
    isConfigSupported: async (cfg) => { checkedConfig = cfg; return true; },
  });
  w.specs = [specOf("clip-a", "ka", 0, 8), specOf("clip-b", "kb", 120, 2)];
  await run(PAGE_STREAM_WAIT_MS + 1000);
  assert.ok(checkedConfig, "开工前调用了 isConfigSupported 检查配置");
  assert.equal(checkedConfig.codec, "avc1.64001f");
  assert.equal(w.produced.length, 1);
  assert.equal(w.produced[0].id, "stream:rk-ka:0-7:sparse", "产出的第一段是稀疏版");
  assert.equal(w.produced[0].stride, 15);
  await finish();
  await run(500);
  assert.equal(w.produced.length, 2);
  assert.equal(w.produced[1].id, "stream:rk-kb:0-1:sparse", "第二段也是稀疏版");
  assert.equal(w.produced[1].stride, 15);
  await finish();
  await run(1000);
  assert.equal(w.produced.length, 2, "绝不产满密度版 (不会开工 dense)");
  const dbg = pages.debug();
  assert.equal(dbg.state, "done");
  assert.ok(dbg.jobs.every((j) => j.pass === "sparse"), "只为本页产稀疏版:任务清单里只有稀疏版");
});

test("PS-18 只为本页产稀疏版时 isConfigSupported 返回不支持:停产退回", async () => {
  const { w, pages, run } = rig({
    sparseOnly: true,
    passes: undefined,
    isConfigSupported: async () => false,
  });
  w.specs = [specOf("clip-a", "ka", 0, 8)];
  // 1. 闲时本页产流入口
  await run(PAGE_STREAM_WAIT_MS + 1000);
  assert.equal(w.produced.length, 0, "不支持时不产任何流");
  const dbg = pages.debug();
  assert.equal(dbg.jobs[0].state, "failed");
  assert.equal(dbg.counters.failed, 1);
  pages.stop();

  // 2. 测量趟入口
  const measureRig = rig({
    sparseOnly: true,
    passes: undefined,
    isConfigSupported: async () => false,
  });
  measureRig.w.specs = [specOf("clip-a", "ka", 0, 8)];
  const out = await measureRig.pages.measure({ round: 1, projectId: "proj", projectRev: 7, clips: ["clip-a"], heavy: ["clip-a"] });
  assert.equal(out.result, "failed", "测量趟不支持时回 failed 退出");
  assert.equal(measureRig.w.produced.length, 0, "测量趟不支持时不产流");
});

test("PS-19 只为本页产稀疏版时编码连错 3 次:停产退回", async () => {
  let produceCalls = 0;
  const { w, pages, run } = rig({
    sparseOnly: true,
    passes: undefined,
    isConfigSupported: async () => true,
    produce: () => {
      produceCalls++;
      return Promise.reject(new Error("编码器崩溃"));
    },
  });
  w.specs = [specOf("clip-a", "ka", 0, 8)];
  // 连跑直到退避重试 3 次做不成
  await run(PAGE_STREAM_WAIT_MS + 20_000);
  assert.equal(produceCalls, 3, "连试 3 次");
  const dbg = pages.debug();
  assert.equal(dbg.jobs[0].state, "failed");
  assert.equal(dbg.counters.failed, 1);
  assert.equal(dbg.state, "done");
  assert.equal(w.current, null);

  // 测量趟中连续失败 3 次停产并回 failed
  let measureProduceCalls = 0;
  const measureRig = rig({
    sparseOnly: true,
    passes: undefined,
    isConfigSupported: async () => true,
    produce: () => {
      measureProduceCalls++;
      return Promise.reject(new Error("编码器崩溃"));
    },
  });
  measureRig.w.specs = [specOf("clip-a", "ka", 0, 8)];
  const out = await measureRig.pages.measure({ round: 1, projectId: "proj", projectRev: 7, clips: ["clip-a"], heavy: ["clip-a"] });
  assert.equal(out.result, "failed");
  assert.equal(measureProduceCalls, 1);
});
