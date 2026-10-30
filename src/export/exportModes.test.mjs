/**
 * 在线浏览器导出分「快速导出」「完整导出」(语义 `docs/semantics/product/platforms.md`「在线浏览器」的「导出」)——页面这一侧的纯逻辑。
 * 跑:node --test src/export/exportModes.test.mjs
 *
 *   XM-01 每张卡怎么出(`cardLayers.planCardLayers`):完整导出不看流,本页能运行的活渲、本页不执行的全请渲染节点;
 *         快速导出只认满密度的分段 —— 整段都有的卡导出页不挂组件,只有一部分有的照旧活渲、有流的帧贴流,
 *         本页不执行的卡有流的帧取流、其余请渲染节点
 *   XM-02 这一帧取哪一样(`layerChoiceAt`):流 → 位图 → 活渲;稀疏的分段不取
 *   XM-03 只为导出的清单计划(`exportFrames.exportPlanTask`):队列的入站校验收它,和平时那份清单计划不是一个任务
 *   XM-04 请渲染节点、等到齐(`requestExportFrames`):没人认领时报「没有节点」;索引到了取清单;全到齐才回;按帧取 PNG
 *   XM-05 节点说出不了、任务失败、渲的不是这一版:各自抛带说明的错误,不出半截
 *   XM-06 流的一帧上下两半合成(`streamFrames.composeHalves`):预乘色钳到不透明度以内再除回去;全透明的像素归零
 *   XM-07 流清单的读法(`readStreamManifest`):只收范围内、形状对的分段
 *   XM-08 贴进快照(`frameCompositor.pasteLayer`)的规矩由探针在真浏览器里核(这里没有 DOM)
 */
import { srcUrl } from "../testing/registerTs.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseInbound, isClipsPlan } from "../../server/render-queue/messages.mjs";

const L = await import(srcUrl("export/cardLayers.ts"));
const F = await import(srcUrl("export/exportFrames.ts"));
const S = await import(srcUrl("export/streamFrames.ts"));
const P = await import(srcUrl("online/planPublisher.ts"));
const T = await import(srcUrl("export/text.ts"));
const R = await import(srcUrl("kernel/registry.ts"));

const FPS = 30;
/** 满密度的分段表:分段号 → 样本数 */
const dense = (...segs) => new Map(segs.map((n) => [n, 15]));
const clip = (id, start, end, cardId = "card") => ({ id, start, end, cardId });

test("XM-01 每张卡怎么出", () => {
  // a:第 12～71 帧(60 帧,4 段);b、s 同长
  const clips = [clip("a", 0.4, 2.4), clip("b", 0.4, 2.4), clip("s", 0.4, 2.4), clip("light", 0, 3), { id: "video", start: 0, end: 3 }];
  assert.deepEqual(L.clipFrameWindow(clips[0], FPS, 90), { first: 12, last: 71 });
  const streams = [
    { clipId: "a", plane: "local", resultKey: "ka", originFrame: 12, dense: dense(0, 1, 2, 3) },
    { clipId: "b", plane: "local", resultKey: "kb", originFrame: 12, dense: dense(0, 2) },          // 第 1、3 段只有稀疏版
    { clipId: "s", plane: "local", resultKey: "ks", originFrame: 12, dense: dense(0, 1) },
    { clipId: "s", plane: "local", resultKey: "ks-other", originFrame: 12, dense: dense(0) },        // 另一条满密度分段更少的:不选
  ];
  const nonRunnable = new Set(["s"]);
  const full = L.planCardLayers({ clips, fps: FPS, total: 90, mode: "full", nonRunnable, streams });
  assert.equal(full.streamOf.size, 0, "完整导出不取流");
  assert.deepEqual(full.wrapperOnly, ["s"]);
  assert.deepEqual(full.needFrames, ["s"]);
  assert.equal(full.nodeFrames, 60);
  const fast = L.planCardLayers({ clips, fps: FPS, total: 90, mode: "fast", nonRunnable, streams });
  assert.deepEqual([...fast.streamOf.keys()].sort(), ["a", "b", "s"]);
  assert.equal(fast.streamOf.get("s").resultKey, "ks");
  assert.deepEqual(fast.wrapperOnly.sort(), ["a", "s"], "整段都有满密度流的卡导出页不挂组件;只有一部分有的照旧活渲");
  assert.deepEqual(fast.needFrames, ["s"], "本页不执行的卡没被满密度流盖满:请渲染节点");
  assert.equal(fast.streamFrames, 60 + 30 + 30);
  assert.equal(fast.nodeFrames, 30);
  // 本页不执行的卡整段都有满密度流:不用请渲染节点
  const covered = L.planCardLayers({ clips: [clips[2]], fps: FPS, total: 90, mode: "fast", nonRunnable, streams: [{ ...streams[2], dense: dense(0, 1, 2, 3) }] });
  assert.deepEqual(covered.needFrames, []);
  assert.deepEqual(covered.wrapperOnly, ["s"]);
  // 末段不满 15 帧:样本数之外的帧不算盖住
  const short = { clipId: "a", plane: "local", resultKey: "ka", originFrame: 12, dense: new Map([[0, 15], [1, 5]]) };
  assert.equal(L.streamCovers(short, 31), true);
  assert.equal(L.streamCovers(short, 32), false);
  assert.equal(L.streamCovers(short, 11), false, "这条流的第一帧之前");
});

test("XM-02 这一帧取哪一样", () => {
  const clips = [clip("b", 0.4, 2.4), clip("s", 0.4, 2.4)];
  const nonRunnable = new Set(["s"]);
  const streams = [
    { clipId: "b", plane: "local", resultKey: "kb", originFrame: 12, dense: dense(0, 2) },
    { clipId: "s", plane: "local", resultKey: "ks", originFrame: 12, dense: dense(0, 1) },
  ];
  const plan = L.planCardLayers({ clips, fps: FPS, total: 90, mode: "fast", nonRunnable, streams });
  const frames = new Map([["s", { clipId: "s", plane: "local", rect: { x: 0, y: 0, w: 4, h: 4 }, frames: new Set(Array.from({ length: 60 }, (_, i) => 12 + i)) }]]);
  assert.equal(L.layerChoiceAt(plan, "b", 12, frames, nonRunnable).from, "stream");
  assert.equal(L.layerChoiceAt(plan, "b", 27, frames, nonRunnable).from, "live", "这一段只有稀疏版:本页逐帧渲,不拿稀疏版顶");
  assert.equal(L.layerChoiceAt(plan, "b", 42, frames, nonRunnable).from, "stream", "衔接处:下一段有满密度的又取流");
  assert.equal(L.layerChoiceAt(plan, "s", 41, frames, nonRunnable).from, "stream");
  assert.equal(L.layerChoiceAt(plan, "s", 42, frames, nonRunnable).from, "frames", "本页不执行的卡没有流的帧取渲染节点的位图");
  assert.equal(L.layerChoiceAt(plan, "s", 80, frames, nonRunnable).from, "missing");
  assert.equal(L.layerChoiceAt(plan, "other", 20, frames, nonRunnable).from, "live");
});

test("XM-03 只为导出的清单计划:队列收它,和平时那份不是一个任务", () => {
  const task = F.exportPlanTask({ projectId: "proj-1", projectRev: 7, clips: ["c2", "c1", "c2"], codeVersion: "cv-1" });
  assert.deepEqual(task.input, { clips: ["c1", "c2"], exportOnly: true });
  assert.deepEqual(task.requires, { codeVersion: "cv-1" });
  assert.equal(task.priority, 70, "排在所有细任务前面(整数名次仍是 normal 档)");
  const parsed = parseInbound({ type: "task.publish", tasks: [task] });
  assert.equal(parsed.ok, true, parsed.detail);
  assert.equal(parsed.body.tasks[0].input.exportOnly, true);
  assert.ok(isClipsPlan(parsed.body.tasks[0]));
  const normal = P.clipsPlanTask({ projectId: "proj-1", projectRev: 7, clips: ["c1", "c2"], codeVersion: "cv-1" });
  assert.notEqual(task.id, normal.id, "签名里多一段:同一份清单也是另一个任务");
  assert.equal(F.exportPlanTask({ projectId: "proj-1", projectRev: 7, clips: ["c1", "c2"] }).id, F.exportPlanTask({ projectId: "proj-1", projectRev: 7, clips: ["c2", "c1"] }).id);
});

const RK = "a".repeat(64);
const hashOf = (n) => n.toString(16).padStart(64, "0");
/** 一台假的文档服务 + 素材服务:队列事件由测试手动推 */
function fakeService({ project }) {
  const listeners = new Set();
  const manifests = new Map();
  const log = [];
  let state = "open";
  const deps = {
    publisherId: "page-test",
    codeVersion: null,
    async request(msg) {
      log.push(msg.type === "content.get" ? `get ${msg.key}` : msg.type);
      if (msg.type === "publisher.hello") return { type: "publisher.welcome" };
      if (msg.type === "task.publish") return { type: "task.published", results: [{ id: msg.tasks[0].id, state }] };
      if (msg.type === "content.get") { const body = manifests.get(msg.key); return body ? { type: "content.item", body } : { type: "content.item", missing: true }; }
      return { type: "error" };
    },
    subscribeQueue(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    assetBase: () => "https://asset.test/api/asset",
    authHeaders: async () => ({ Authorization: "Bearer t" }),
    fetch: async (url) => {
      log.push(`fetch ${String(url).split("/").pop().slice(-4)}`);
      return new Response(new Uint8Array([137, 80, 78, 71, Number.parseInt(String(url).slice(-2), 16)]));
    },
    sleep: async (_ms, signal) => { if (signal.aborted) throw Object.assign(new Error("cancelled"), { cancelled: true }); await new Promise((r) => setImmediate(r)); await hooks.onSleep?.(); },
  };
  const hooks = { onSleep: null };
  return { deps, log, manifests, hooks, emit: (msg) => { for (const l of [...listeners]) l(msg); }, setState: (s) => { state = s; }, project, listeners };
}
const manifestOf = (from, to, origin, last) => {
  const frames = [];
  for (let f = origin + from * 15; f <= Math.min(last, origin + (to + 1) * 15 - 1); f++) frames.push([f, hashOf(f), 100]);
  return { v: 1, kind: "export-frames", resultKey: RK, range: { from, to }, header: {}, frames };
};
const indexOf = (over = {}) => ({ v: 1, projectRev: 7, unsupported: [], streams: [{ clipId: "s", kind: "card", plane: "local", resultKey: RK, envFingerprint: "f".repeat(16),
  originFrame: 12, lastFrame: 143, lastSegment: 8, segmentsPerTask: 8, fps: 30, rect: { x: -32, y: -32, w: 704, h: 424 }, offset: { x: 0, y: 0 }, inputSig: "s1-abc" }], ...over });

test("XM-04 请渲染节点、等到齐、按帧取", async () => {
  F.resetExportRetry();
  const svc = fakeService({ project: {} });
  const statuses = [];
  const task = F.exportPlanTask({ projectId: "p1", projectRev: 7, clips: ["s"] });
  let step = 0;
  svc.hooks.onSleep = async () => {
    step++;
    // 第 1 轮:没人认领。第 2 轮:节点接了。第 3 轮:计划完成(索引到了),清单还没有。第 4 轮:第一份清单到。第 5 轮:第二份到
    if (step === 1) svc.setState("claimed");
    if (step === 2) { svc.setState("done"); svc.emit({ type: "task.done", id: task.id, result: { ranges: null, derived: [], exportIndex: indexOf() } }); }
    if (step === 3) svc.manifests.set(`${RK}:0-7`, manifestOf(0, 7, 12, 143));
    if (step === 4) svc.manifests.set(`${RK}:8-8`, manifestOf(8, 8, 12, 143));
  };
  const got = await F.requestExportFrames({ projectId: "p1", projectRev: 7, project: {}, clips: ["s"], deps: svc.deps, signal: new AbortController().signal, onStatus: (s) => statuses.push(s) });
  assert.deepEqual(statuses.map((s) => s.phase), ["publishing", "no-node", "planning", "rendering", "rendering"]);
  assert.deepEqual(statuses[3], { phase: "rendering", clips: 1, done: 0, total: 132 });
  assert.deepEqual(statuses[4], { phase: "rendering", clips: 1, done: 120, total: 132 });
  const cov = got.coverage.get("s");
  assert.equal(cov.frames.size, 132);
  assert.deepEqual(cov.rect, { x: -32, y: -32, w: 704, h: 424 });
  assert.equal(cov.plane, "local");
  const url = await got.dataUrl("s", 20);
  assert.match(url, /^data:image\/png;base64,/);
  assert.equal(Buffer.from(url.split(",")[1], "base64")[4], 0x14, "取的是第 20 帧的那一块");
  assert.equal(got.stats.fetched, 1);
  await assert.rejects(got.dataUrl("s", 200));
  assert.equal(svc.listeners.size, 0, "退订了队列事件");
  assert.equal(svc.log.filter((x) => x === "publisher.hello").length, 1);
  assert.equal(svc.log.filter((x) => x === "task.publish").length, 2, "没等到索引就隔一会儿重发一次:问状态、要回完成通知");
});

test("XM-05 出不了、失败、不是这一版:各自停下并说明", async () => {
  const run = async (prepare) => {
    F.resetExportRetry();
    const svc = fakeService({ project: {} });
    const task = F.exportPlanTask({ projectId: "p1", projectRev: 7, clips: ["s"] });
    let step = 0;
    svc.hooks.onSleep = async () => { step++; await prepare(svc, task, step); };
    return F.requestExportFrames({ projectId: "p1", projectRev: 7, project: svc.project, clips: ["s"], deps: svc.deps, signal: new AbortController().signal });
  };
  const done = (svc, task, index) => svc.emit({ type: "task.done", id: task.id, result: { exportIndex: index } });
  // 节点说这张卡出不了
  await assert.rejects(run((svc, task, step) => { if (step === 1) done(svc, task, { v: 1, streams: [], unsupported: [{ clipId: "s", reason: "no-card" }] }); }),
    (e) => e.message === T.ONLINE_EXPORT_TEXT.nodeCannot(1, "no-card") && /没有这张卡片的代码/.test(e.message));
  // 计划本身失败
  await assert.rejects(run((svc, task, step) => { if (step === 1) svc.emit({ type: "task.failed", id: task.id, error: "bad-snapshot" }); }),
    (e) => e.message === T.ONLINE_EXPORT_TEXT.nodeFailed("bad-snapshot"));
  // 某一段位图任务彻底失败
  await assert.rejects(run((svc, task, step) => {
    if (step === 1) done(svc, task, indexOf());
    if (step === 2) svc.emit({ type: "task.failed", id: `stream:${RK}:0-7`, error: "export-frames-failed" });
  }), (e) => e.message === T.ONLINE_EXPORT_TEXT.nodeFailed("export-frames-failed"));
  // 项目往前走了,这份内容被作废
  await assert.rejects(run((svc, task, step) => {
    if (step === 1) done(svc, task, indexOf());
    if (step === 2) svc.emit({ type: "task.failed", id: `stream:${RK}:8-8`, error: "superseded" });
  }), (e) => e.message === T.ONLINE_EXPORT_TEXT.projectChanged);
  // 别的流任务失败(不是这次导出要的)不管
  const ok = await run((svc, task, step) => {
    if (step === 1) { done(svc, task, indexOf({ streams: [{ ...indexOf().streams[0], lastFrame: 20, lastSegment: 0 }] })); svc.emit({ type: "task.failed", id: `stream:${"b".repeat(64)}:0-7`, error: "x" }); }
    if (step === 2) svc.manifests.set(`${RK}:0-0`, manifestOf(0, 0, 12, 20));
  });
  assert.equal(ok.coverage.get("s").frames.size, 9);
  // 取消
  F.resetExportRetry();
  const svc = fakeService({ project: {} });
  const ac = new AbortController();
  svc.hooks.onSleep = async () => { ac.abort(); };
  await assert.rejects(F.requestExportFrames({ projectId: "p1", projectRev: 7, project: {}, clips: ["s"], deps: svc.deps, signal: ac.signal }), (e) => e.cancelled === true);
  // 索引的形状不对的条目跳过
  assert.equal(F.parseExportIndex({ streams: [{ clipId: "s" }, indexOf().streams[0]], unsupported: [{ clipId: "x" }] }).streams.length, 1);
  assert.equal(F.parseExportIndex(null), null);
  assert.deepEqual(F.exportSpans({ lastSegment: 8, segmentsPerTask: 8 }), [[0, 7], [8, 8]]);
});

test("XM-06 流的一帧上下两半合成", () => {
  // 宽 2、色半区高 2;整帧高 = 2 × 2 + 16 = 20;不透明度从第 2 + 8 = 10 行起
  const w = 2, h = 2, total = 2 * h + 16;
  const raw = new Uint8ClampedArray(w * total * 4);
  const px = (x, y, r, g, b) => { const o = (y * w + x) * 4; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = 255; };
  px(0, 0, 100, 50, 0); px(0, 10, 200, 200, 200);    // 预乘 (100, 50, 0),不透明度 200 → straight (128, 64, 0)
  px(1, 0, 255, 10, 10); px(1, 10, 40, 40, 40);      // 色比不透明度大(编码噪声):先钳到 40 → (255, 64, 64)
  px(0, 1, 90, 90, 90); px(0, 11, 0, 0, 0);          // 全透明:归零
  px(1, 1, 255, 255, 255); px(1, 11, 255, 255, 255); // 不透明的白
  const out = S.composeHalves(raw, w, total, h);
  assert.deepEqual([...out.subarray(0, 4)], [128, 64, 0, 200]);
  assert.deepEqual([...out.subarray(4, 8)], [255, 64, 64, 40]);
  assert.deepEqual([...out.subarray(8, 12)], [0, 0, 0, 0]);
  assert.deepEqual([...out.subarray(12, 16)], [255, 255, 255, 255]);
  assert.throws(() => S.composeHalves(raw, w, 10, h), /放不下/);
  assert.equal(S.HALF_GAP_ROWS, 8);
});

test("XM-07 流清单的读法", () => {
  const init = "0123456789abcdef";
  const body = { kind: "stream", resultKey: RK, header: { fps: 30 },
    inits: { [init]: { hash: hashOf(1), rect: { x: 0, y: 0, w: 64, h: 32 } }, bad: { hash: "x", rect: null } },
    segments: { 0: { hash: hashOf(2), init, stride: 1, samples: 15 }, 1: { hash: hashOf(3), init, stride: 15, samples: 15 }, 2: { hash: hashOf(4), init: "missing", stride: 1, samples: 15 },
      9: { hash: hashOf(5), init, stride: 1, samples: 15 } } };
  const got = S.readStreamManifest(body, RK, [0, 7]);
  assert.equal(got.fps, 30);
  assert.deepEqual([...got.segments.keys()], [0, 1], "范围外的、开头文件不在的不收");
  assert.equal(got.segments.get(1).stride, 15);
  assert.deepEqual(got.inits.get(init).rect, { x: 0, y: 0, w: 64, h: 32 });
  assert.equal(S.readStreamManifest({ ...body, resultKey: "other" }, RK, [0, 7]), null);
  assert.equal(S.readStreamManifest({ ...body, kind: "export-frames" }, RK, [0, 7]), null);
  assert.equal(S.readStreamManifest(null, RK, [0, 7]), null);
});

test("XM-08 在线导出可执行卡判定与 nonRunnableClips: 就绪的同步卡活渲、错误状态等节点", () => {
  R.resetRuntimeCardsForTest();
  R.registerCards([{ id: "builtin-card", name: "Builtin Card" }]);
  // 模拟同步卡
  R.setSyncedUserCards([
    { id: "synced-ready", name: "Ready Card" },
    { id: "synced-bad", name: "Bad Card" },
  ]);
  R.setCardRunStates({
    "synced-ready": { state: "ready" },
    "synced-bad": { state: "unsupported-syntax", detail: "SyntaxError" },
  });
  assert.equal(L.isCardRunnable("builtin-card"), true, "内置卡一律可运行");
  assert.equal(L.isCardRunnable("synced-ready"), true, "运行状态为 ready 的同步用户卡可运行");
  assert.equal(L.isCardRunnable("synced-bad"), false, "运行状态为 unsupported-syntax 的不可运行");
  assert.equal(L.isCardRunnable("unknown-card"), false, "未知卡不可运行");

  const p = {
    width: 1280, height: 720, fps: 30, duration: 3,
    tracks: [
      { id: "t1", clips: [
        { id: "c1", cardId: "builtin-card", start: 0, end: 1 },
        { id: "c2", cardId: "synced-ready", start: 1, end: 2 },
        { id: "c3", cardId: "synced-bad", start: 2, end: 3 },
        { id: "c4", cardId: "unknown-card", start: 0, end: 2 },
        { id: "c5", start: 0, end: 3 }, // 素材片段（无 cardId）
      ] },
    ],
  };
  const nonRunnable = L.nonRunnableClips(p);
  assert.deepEqual(nonRunnable.sort(), ["c3", "c4"].sort(), "只有真正不能在浏览器运行的卡进入 nonRunnableClips");
  R.resetRuntimeCardsForTest();
  R.resetCards();
});

