/**
 * K5 第二路(整场景后台补跑后互换角色,`stageSwap.ts`)的单测。跑:
 *   node --experimental-test-module-mocks --test src/editor/stageSwap.test.mjs
 *
 * store、舞台桥、后台任务队列、分派表、身份表、快照投递、K6 父页一半都换成假的;
 * 判据用真的 `pipelinePlan.mjs` / `catchUpEstimate.mjs` / `frameWindow.mjs`。钉的是:
 *   - 谁要走第二路:判重 + `vtOk = false`、判轻 + (b) 档 + `vtOk = false`;没有成本记录的不走;
 *   - 补跑估时按播放位置、封顶整段,没有数就 1 秒;
 *   - 暂停态互换的顺序一步不能省(E0 / K5 (1)～(5));补跑期间用户动了就不换;
 *     运行中来的新请求只记最后一个,做完再补(R5-15);
 *   - 播放态互换:目标拍取整到拍格、武装停、换完 `play(T)`;两次追不上就降级且不清额外抑制(R5-11)。
 */
import { srcUrl } from "../testing/registerTs.mjs";
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { clipWeight } from "../render/pipelinePlan.mjs";

globalThis.window = globalThis;

/* ---------------------------------------------------------------- 假环境 */

const log = [];
const state = { project: null, t: 0, playing: false };
let plan = { segments: [] };
let costs = [];
let identityKeys = {};
let frameModes = {};
const listeners = new Set();
const emit = (e) => { for (const l of [...listeners]) l(e); };
let front = null;
let back = null;

mock.module(srcUrl("store/project.ts"), { exports: { getState: () => state } });
mock.module(srcUrl("editor/stageBridge.ts"), {
  exports: {
    frontStage: () => front,
    backStage: () => back,
    onStageEvent: (l) => { listeners.add(l); return () => listeners.delete(l); },
    pushProject: async (role, project, opts) => { log.push(["pushProject", role, project === state.project, opts]); },
    // 根因 A:互换之后对新 front 补推一次增量
    syncProject: async (role, project) => { log.push(["syncProject", role, project === state.project]); },
  },
});
/*
 * 后台任务队列:和真的 `stageJobs` 一样**单飞、先来后到**(同一档 `catchup`)。以前这里并发地直接跑,
 * 测不出「暂停态第二路排在播放态补跑后面、要等它让出队列」这件事。
 */
let jobChain = Promise.resolve();
mock.module(srcUrl("editor/stageJobs.ts"), {
  exports: {
    runBackJob: (kind, run) => {
      log.push(["runBackJob", kind]);
      const p = jobChain.then(() => run({ stage: back, signal: new AbortController().signal }));
      jobChain = p.catch(() => {});
      return p;
    },
  },
});
mock.module(srcUrl("editor/planDispatch.ts"), {
  exports: {
    currentPlan: () => plan,
    currentCosts: () => costs,
    currentTuning: () => undefined,
    sendPlanTo: async (role, opts) => { log.push(["sendPlanTo", role, opts]); },
  },
});
mock.module(srcUrl("editor/costIdentity.ts"), { exports: { clipIdentityOf: () => ({ identityKeys, frameModes }) } });
mock.module(srcUrl("editor/snapshotFeed.ts"), {
  exports: {
    clearSettled: (role, why) => log.push(["clearSettled", role, why]),
    deliverSnapshots: async (_stage, role, head) => { log.push(["deliverSnapshots", role, head.t, head.playing]); return 0; },
    markBaselineReset: (role) => log.push(["markBaselineReset", role]),
    markAllSettled: (role) => log.push(["markAllSettled", role]),
    setExtraSuppressed: (ids) => log.push(["setExtraSuppressed", [...ids]]),
    suppressedAt: () => ["h"],
    // R8:播放态互换时也发流平面(和抑制集合同一组)
    streamPlanesAt: () => [],
  },
});
mock.module(srcUrl("editor/demote.ts"), { exports: { onStageDemote: async (id) => { log.push(["demote", id]); return { ok: true, clipId: id }; } } });

const swap = await import(srcUrl("editor/stageSwap.ts"));
const {
  needsBackCatchUp, playingCatchUpTargets, staleOnBackCatchUp, guessCatchUpMs,
  runSettleSwap, runPlayingSwap, setSwapHost, resetStageSwap, swapInFlight, DEFAULT_CATCHUP_GUESS_MS,
} = swap;

/**
 * 假舞台客户端。每个方法都往 `log` 里记 `[名字, 方法, 参数…]`。
 * `render` / `setMediaT` / `pause` 的行为可以按测试换。
 */
function fakeStage(name) {
  const st = { name };
  const rec = (method) => async (...args) => { log.push([name, method, ...args]); return { ok: true }; };
  for (const m of ["setRole", "setLocalHashes", "setSuppressed", "setStreamPlanes", "setSnapshots", "setPlaying", "setScrubbing", "setProxy", "play"]) st[m] = rec(m);
  st.render = async (sec, opts) => { log.push([name, "render", sec, opts]); await st.renderGate; return { ok: true }; };
  st.renderGate = null;
  st.setMediaT = async (sec) => { log.push([name, "setMediaT", sec]); if (st.mediaReady !== false) emit({ type: "mediaReady" }); return { ok: true }; };
  st.pause = async (opts) => {
    log.push([name, "pause", opts]);
    const passed = st.passes > 0;
    if (passed) st.passes--;
    else queueMicrotask(() => emit({ type: "frame", sec: opts.atSec }));
    return { ok: true, passed };
  };
  st.passes = 0;
  return st;
}

const FPS = 30;
const card = (id, start, end) => ({ id, cardId: "c", start, end, params: {} });
const project = (clips) => ({ version: 1, name: "p", width: 1920, height: 1080, fps: FPS, duration: 20, media: [], tracks: [{ id: "t", name: "t", clips }] });
const segments = (heavyIds) => ({ segments: [{ fromSec: 0, toSec: 1000, heavy: new Set(heavyIds) }] });
/** 给片段挂一条成本记录(身份键就用 `k-<clipId>`) */
const withRecord = (clipId, record) => {
  identityKeys[clipId] = `k-${clipId}`;
  costs.push({ identityKey: `k-${clipId}`, device: "d", ...record });
};
const REC_B = { vtOk: false, stepMs: 2, stepMaxMs: 3, catchUpMs: 200 };   // 30 fps 下是 (b) 档
const REC_A = { vtOk: false, stepMs: 2, catchUpMs: 10 };                   // (a) 档:一拍内补齐

let host;
beforeEach(() => {
  resetStageSwap();
  jobChain = Promise.resolve();
  log.length = 0;
  listeners.clear();
  plan = { segments: [] };
  costs = [];
  identityKeys = {};
  frameModes = {};
  front = fakeStage("A");
  back = fakeStage("B");
  host = {
    swapRoles() {
      log.push(["swapRoles"]);
      [front, back] = [back, front];
      return { front, back };
    },
    proxy: () => true,
    localHashes: () => ["h1"],
  };
  setSwapHost(host);
  Object.assign(state, { project: project([card("h", 0, 10), card("l", 0, 10)]), t: 1, playing: false });
});

const methodsOf = (name) => log.filter((e) => e[0] === name).map((e) => e[1]);

/* ---------------------------------------------------------------- 判据 */

test("前提:两条记录在 30 fps 下分别是 (b) 档和 (a) 档", () => {
  assert.equal(clipWeight(REC_B, undefined, FPS, undefined).tier, "catchup-b");
  assert.equal(clipWeight(REC_A, undefined, FPS, undefined).tier, "catchup-a");
});

test("needsBackCatchUp:判重且 vtOk 不是 true 的才走;没有成本记录的不走", () => {
  plan = segments(["h", "l"]);
  const p = project([card("h", 0, 10), card("l", 0, 10), card("n", 0, 10), card("ok", 0, 10)]);
  plan = segments(["h", "l", "n", "ok"]);
  withRecord("h", { vtOk: false });
  withRecord("l", {});
  withRecord("ok", { vtOk: true });
  assert.deepEqual(needsBackCatchUp(p, 1), ["h", "l"]);
});

test("needsBackCatchUp:判轻的、不在场的卡不走", () => {
  plan = segments([]);
  withRecord("h", { vtOk: false });
  assert.deepEqual(needsBackCatchUp(project([card("h", 0, 10)]), 1), []);
  plan = segments(["h"]);
  assert.deepEqual(needsBackCatchUp(project([card("h", 5, 10)]), 1), []);
});

test("playingCatchUpTargets:只收判轻、(b) 档、vtOk 不是 true 的", () => {
  const p = project([card("b", 0, 10), card("a", 0, 10), card("t", 0, 10), card("n", 0, 10)]);
  plan = segments([]);
  withRecord("b", REC_B);
  withRecord("a", REC_A);
  withRecord("t", { ...REC_B, vtOk: true });
  assert.deepEqual(playingCatchUpTargets(p, 1), ["b"]);
});

test("staleOnBackCatchUp:两类并起来、去重、排序", () => {
  const p = project([card("z", 0, 10), card("b", 0, 10)]);
  plan = segments(["z"]);
  withRecord("z", { vtOk: false });
  withRecord("b", REC_B);
  assert.deepEqual(staleOnBackCatchUp(p, 1), ["b", "z"]);
});

test("guessCatchUpMs:按播放位置估、封顶整段;没数就 1 秒", () => {
  const p = project([card("b", 0, 10)]);
  withRecord("b", REC_B);
  // 播放头在第 1 秒 = 第 30 帧,每帧最差 3 ms → 90 ms(比整段 200 小)
  assert.equal(guessCatchUpMs(p, ["b"], 1), 90);
  // 第 5 秒:150 帧 × 3 = 450,封顶在整段 200
  assert.equal(guessCatchUpMs(p, ["b"], 5), 200);
  // 场上没有一张卡有数:兜底 1 秒(以前拿一个不在场的 id 测;现在同场的卡也算进来,那样会把 b 的 90 加上)
  assert.equal(guessCatchUpMs(project([card("x", 0, 10)]), ["x"], 1), DEFAULT_CATCHUP_GUESS_MS);
});

/* ---------------------------------------------------------------- 整场景估时(C10-A4 后续) */

/** 判重的慢卡:单帧 40 ms(c10-browser-probe 的 probe-slow-stepped burnMs 40) */
const REC_SLOW = { vtOk: false, stepMs: 40, stepMaxMs: 40 };

test("guessCatchUpMs:后台是整场景补跑,同场判重的卡的推帧成本一起算(C10-A4 后续)", () => {
  // 轻卡 b 在第 1 秒 = 30 帧 × 3 ms = 90;同场判重的 h 从 0 推到 1 秒 = 30 帧 × 40 ms = 1200
  const p = project([card("b", 0, 10), card("h", 0, 10)]);
  plan = segments(["h"]);
  withRecord("b", REC_B);
  withRecord("h", REC_SLOW);
  assert.equal(guessCatchUpMs(p, ["b"], 1), 90 + 1200);
  // 起推点是此刻活跃的卡里最早的入点:早已出场的卡、起推点之前的那段不算
  const q = project([card("b", 0.5, 10), card("gone", 0, 0.4), card("late", 0.8, 10)]);
  withRecord("gone", REC_SLOW);
  withRecord("late", REC_SLOW);
  // b 从 0.5 推到 1 = 15 帧 × 3 = 45;late 从 0.8 推到 1 = 6 帧 × 40 = 240;gone 在起推点 0.5 之前就出场了
  assert.equal(Math.round(guessCatchUpMs(q, ["b"], 1)), 45 + 240);
});

test("播放态:同场的卡每帧加起来超过一拍(后台推帧比播放慢),追不上就不发起 —— 不抑制、不排后台任务", { timeout: 5000 }, async () => {
  Object.assign(state, { project: project([card("b", 0, 10), card("h", 0, 10)]), t: 1, playing: true });
  plan = segments(["h"]);
  withRecord("b", REC_B);
  withRecord("h", REC_SLOW);   // (3 + 40) ms × 30 fps = 1290 ms / 秒:推 1 秒时间线要 1.29 秒
  assert.equal(await runPlayingSwap(["b"]), false);
  assert.deepEqual(log, [], "一条 RPC、一个后台任务、一次额外抑制都没有");
  assert.equal(swapInFlight(), false);
  assert.equal(front.name, "A");
});

test("播放态:解出来的目标拍落在目标卡出场之后,也不发起", { timeout: 5000 }, async () => {
  // rate = (3 + 20) × 30 = 690 ms/秒;积压 90 + 30 × 20 = 690 → 领先 690 / 0.31 ≈ 2226 ms → 目标 3.23 秒,b 在 1.2 秒就出场了
  Object.assign(state, { project: project([card("b", 0, 1.2), card("h", 0, 10)]), t: 1, playing: true });
  plan = segments(["h"]);
  withRecord("b", REC_B);
  withRecord("h", { vtOk: false, stepMs: 20, stepMaxMs: 20 });
  assert.equal(await runPlayingSwap(["b"]), false);
  assert.deepEqual(log, []);
});

test("播放态:目标拍的领先量含「边补边被可见舞台追」的那一截(积压 ÷ (1 − 速率))", { timeout: 5000 }, async () => {
  // 同场一张 10 ms/帧的轻卡:速率 (3 + 10) × 30 = 390 ms/秒,积压 90 + 300 = 390 → 领先 390 / 0.61 ≈ 639 ms
  Object.assign(state, { project: project([card("b", 0, 10), card("m", 0, 10)]), t: 1, playing: true });
  plan = segments([]);
  withRecord("b", REC_B);
  withRecord("m", { vtOk: true, stepMs: 10, stepMaxMs: 10 });
  assert.equal(await runPlayingSwap(["b"]), true);
  // T = ceil((1 + 0.639) × 30) / 30 = 50 / 30(以前只按 b 自己的 90 ms 估:33 / 30,可见舞台先到、白补一趟)
  assert.deepEqual(log.find((e) => e[1] === "render").slice(2), [50 / 30, { jump: true, maxCatchUp: Infinity }]);
});

/* ---------------------------------------------------------------- 暂停态互换 */

test("暂停态互换:(1)～(5) 的顺序一步不少", async () => {
  plan = segments(["h"]);
  withRecord("h", { vtOk: false });
  assert.equal(await runSettleSwap(1), true);
  const steps = log.map((e) => e.slice(0, 2).join("."));
  assert.deepEqual(steps, [
    "runBackJob.catchup",
    "pushProject.back",
    "B.render",
    "B.setMediaT",
    "swapRoles",
    "A.setRole",
    "B.setRole",
    "syncProject.front",
    "sendPlanTo.front",
    "B.setLocalHashes",
    "markBaselineReset.front",
    "markAllSettled.front",
    "B.setStreamPlanes",
    "B.setSuppressed",
    "B.setPlaying",
    "B.setScrubbing",
    "B.setProxy",
  ]);
  const at = (step) => log.find((e) => e.slice(0, 2).join(".") === step);
  assert.deepEqual(at("pushProject.back").slice(2), [true, { reset: true }], "整份重灌当前项目、带 reset");
  assert.deepEqual(at("B.render").slice(2), [1, { jump: true, maxCatchUp: Infinity }], "不传 maxCatchUp 会被 6000 ms 削掉起点");
  assert.deepEqual(at("A.setRole").slice(2), ["back"], "旧 front 先退成 back");
  assert.deepEqual(at("B.setRole").slice(2), ["front"]);
  assert.deepEqual(at("syncProject.front").slice(2), [true], "根因 A:互换后对新 front 补推当前项目(增量由 stageBridge 按客户端基线算)");
  assert.deepEqual(at("sendPlanTo.front").slice(2), [{ force: true }], "它作为 back 时没有表,必须补发");
  assert.deepEqual(at("B.setLocalHashes").slice(2), [["h1"]]);
  assert.deepEqual(at("B.setStreamPlanes").slice(2), [[]]);
  assert.deepEqual(at("B.setSuppressed").slice(2), [["h"]]);
  assert.deepEqual(at("B.setPlaying").slice(2), [false]);
  assert.deepEqual(at("B.setProxy").slice(2), [true], "实体模式要对新 front 重发");
  assert.equal(front.name, "B");
  assert.equal(swapInFlight(), false);
});

test("暂停态:没有要补跑的卡就什么都不做", async () => {
  plan = segments(["h"]);
  withRecord("h", { vtOk: true });
  assert.equal(await runSettleSwap(1), false);
  assert.deepEqual(log, []);
});

test("暂停态:补跑期间用户挪了播放头或开始播放,这一次不换", async () => {
  plan = segments(["h"]);
  withRecord("h", { vtOk: false });
  back.render = async (sec, opts) => { log.push(["B", "render", sec, opts]); state.t = 2; return { ok: true }; };
  assert.equal(await runSettleSwap(1), false);
  assert.equal(log.some((e) => e[0] === "swapRoles"), false);

  log.length = 0;
  state.t = 1;
  back.render = async (sec, opts) => { log.push(["B", "render", sec, opts]); state.playing = true; return { ok: true }; };
  assert.equal(await runSettleSwap(1), false);
  assert.equal(log.some((e) => e[0] === "swapRoles"), false);
});

test("暂停态:素材层不回 mediaReady 也在 300 ms 后照样换", async () => {
  plan = segments(["h"]);
  withRecord("h", { vtOk: false });
  back.mediaReady = false;
  const started = Date.now();
  assert.equal(await runSettleSwap(1), true);
  assert.ok(Date.now() - started >= 290);
});

test("暂停态:运行中来的请求只记最后一个,当前这次做完按它再做一遍(R5-15)", async () => {
  plan = segments(["h"]);
  withRecord("h", { vtOk: false });
  let open;
  back.renderGate = new Promise((r) => { open = r; });
  const first = runSettleSwap(1);
  await new Promise((r) => setImmediate(r));
  assert.equal(swapInFlight(), true);
  assert.equal(await runSettleSwap(2), false, "运行中:先记下");
  assert.equal(await runSettleSwap(3), false);
  // 用户最后停在第 3 秒:第 1 秒那次补完时 t 已经不对,不换;接着按 3 再做
  state.t = 3;
  open();
  assert.equal(await first, true);
  const renders = log.filter((e) => e[1] === "render").map((e) => e[2]);
  assert.deepEqual(renders, [1, 3], "中间的 2 被盖掉,不做");
  assert.equal(log.filter((e) => e[0] === "swapRoles").length, 1);
});

/* ---------------------------------------------------------------- 播放态互换 */

test("播放态互换:先额外抑制,目标拍取整到拍格,武装停到了再换,换完 play(T)", async () => {
  Object.assign(state, { project: project([card("b", 0, 10)]), t: 1, playing: true });
  plan = segments([]);
  withRecord("b", REC_B);
  assert.equal(await runPlayingSwap(["b"]), true);
  // 预估 90 ms:T = ceil((1 + 0.09) × 30) / 30 = 33 / 30
  const T = 33 / 30;
  assert.deepEqual(log[0], ["setExtraSuppressed", ["b"]]);
  assert.deepEqual(log.find((e) => e[1] === "render").slice(2), [T, { jump: true, maxCatchUp: Infinity }]);
  assert.deepEqual(log.find((e) => e[0] === "A" && e[1] === "pause").slice(2), [{ atSec: T }]);
  const i = (pred) => log.findIndex(pred);
  assert.ok(i((e) => e[0] === "A" && e[1] === "pause") > i((e) => e[1] === "setMediaT"), "back 就绪之后才武装停");
  assert.ok(i((e) => e[0] === "setExtraSuppressed" && e[1].length === 0) < i((e) => e[0] === "swapRoles"), "互换前清掉额外抑制");
  // 先发流平面、后发抑制:舞台收到抑制时已经知道有流要来,流画出第一帧之前不藏补跑出来的精确画面(反过来发,这一层会空约 0.1 秒)
  assert.deepEqual(methodsOf("B").slice(-8), ["setRole", "setLocalHashes", "setStreamPlanes", "setSuppressed", "setScrubbing", "setProxy", "play", "setPlaying"]);
  assert.deepEqual(log.find((e) => e[0] === "B" && e[1] === "play").slice(2), [T]);
  assert.deepEqual(log.find((e) => e[0] === "B" && e[1] === "setPlaying").slice(2), [true]);
  assert.equal(log.some((e) => e[0] === "deliverSnapshots"), false, "快照退役后互换不再投快照");
  assert.equal(log.some((e) => e[0] === "demote"), false);
});

test("播放态:可见舞台先走到 T,就翻倍重取 T' 对 back 续推(不带 jump)再武装", async () => {
  Object.assign(state, { project: project([card("b", 0, 10)]), t: 1, playing: true });
  plan = segments([]);
  withRecord("b", REC_B);
  front.passes = 1;
  assert.equal(await runPlayingSwap(["b"]), true);
  const renders = log.filter((e) => e[1] === "render");
  assert.equal(renders.length, 2);
  // 翻倍到 180 ms:T' = ceil(1.18 × 30) / 30 = 36 / 30
  assert.deepEqual(renders[1].slice(2), [36 / 30, { maxCatchUp: Infinity }]);
  assert.deepEqual(log.filter((e) => e[1] === "pause").map((e) => e[2].atSec), [33 / 30, 36 / 30]);
});

test("播放态:两次都追不上就降级(K6),而且不清额外抑制(R5-11)", async () => {
  Object.assign(state, { project: project([card("b", 0, 10), card("c", 0, 10)]), t: 1, playing: true });
  plan = segments([]);
  withRecord("b", REC_B);
  withRecord("c", REC_B);
  front.passes = 2;
  assert.equal(await runPlayingSwap(["b", "c"]), false);
  assert.deepEqual(log.filter((e) => e[0] === "demote").map((e) => e[1]), ["b", "c"]);
  assert.deepEqual(log.filter((e) => e[0] === "setExtraSuppressed"), [["setExtraSuppressed", ["b", "c"]]], "只设过一次,没有清");
  assert.equal(log.some((e) => e[0] === "swapRoles"), false);
  assert.equal(swapInFlight(), false);
});

test("播放态:中途停了播放就收手,额外抑制照清", async () => {
  Object.assign(state, { project: project([card("b", 0, 10)]), t: 1, playing: true });
  plan = segments([]);
  withRecord("b", REC_B);
  back.render = async (sec, opts) => { log.push(["B", "render", sec, opts]); state.playing = false; return { ok: true }; };
  assert.equal(await runPlayingSwap(["b"]), false);
  assert.deepEqual(log.filter((e) => e[0] === "setExtraSuppressed").map((e) => e[1]), [["b"], []]);
});

test("播放态:同时只跑一次;空列表不跑", async () => {
  assert.equal(await runPlayingSwap([]), false);
  Object.assign(state, { project: project([card("b", 0, 10)]), t: 1, playing: true });
  withRecord("b", REC_B);
  let open;
  back.renderGate = new Promise((r) => { open = r; });
  const first = runPlayingSwap(["b"]);
  await new Promise((r) => setImmediate(r));
  assert.equal(await runPlayingSwap(["b"]), false);
  assert.equal(await runSettleSwap(1), false, "暂停态那一路也要等它");
  open();
  assert.equal(await first, true);
});

/**
 * 播放态互换的整场景补跑卡在后台舞台上(第一次 `render` 不回包,直到 `open()`),之后的 `render` 立刻回。
 * 模拟 C10-A4 实测:补到目标拍要推十几秒。
 */
function gateFirstRender() {
  let open;
  const gate = new Promise((r) => { open = r; });
  let n = 0;
  const st = back;
  st.render = async (sec, opts) => {
    log.push([st.name, "render", sec, opts]);
    if (n++ === 0) await gate;
    return { ok: true };
  };
  return () => open();
}

test("停下时播放态补跑立即让路:暂停态第二路马上开始,不等它推完(C10-A4 后续)", { timeout: 5000 }, async () => {
  /*
   * 以前(C10-A4 的修法):停下那一次撞上 `running`,只记进 `pendingSettleT`,等播放态那一次整场景补跑推完、
   * 收手时才交给暂停态那一路 —— 实测白等约 1.5 秒(重的项目十几秒),停下到精确活渲 7～8 秒。
   */
  Object.assign(state, { project: project([card("h", 0, 10), card("b", 0, 10)]), t: 1, playing: true });
  plan = segments(["h"]);
  withRecord("h", { vtOk: false });
  withRecord("b", REC_B);
  const open = gateFirstRender();
  const playingSwap = runPlayingSwap(["b"]);
  await new Promise((r) => setImmediate(r));
  assert.equal(swapInFlight(), true);
  // 用户暂停在 0.5 秒:后台舞台还在推播放态那一次(gate 没开)
  Object.assign(state, { t: 0.5, playing: false });
  const settled = await Promise.race([runSettleSwap(0.5), new Promise((r) => setTimeout(() => r("timeout"), 1000))]);
  assert.equal(settled, true, "不等播放态那一次推完,当场补跑到 0.5 秒并互换");
  assert.equal(await playingSwap, false, "播放态那一次让路收手");
  const renders = log.filter((e) => e[1] === "render").map((e) => e[2]);
  assert.deepEqual(renders, [33 / 30, 0.5]);
  assert.equal(log.filter((e) => e[0] === "swapRoles").length, 1, "只换一次:暂停态那一次");
  assert.ok(log.some((e) => e[0] === "markAllSettled" && e[1] === "front"));
  assert.deepEqual(log.filter((e) => e[0] === "setExtraSuppressed").map((e) => e[1]), [["b"], []], "播放态的额外抑制照清");
  assert.equal(swapInFlight(), false);
  // 让路之后旧的那次 render 才回包:不再引出任何动作
  const before = log.length;
  open();
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  assert.equal(log.length, before);
  assert.equal(swapInFlight(), false);
});

test("停下时这一拍不用补跑:播放态补跑照样让路,并掐掉后台舞台上没人等的那次补跑", { timeout: 5000 }, async () => {
  // 播放到头(10 秒):场上的卡都出场了,暂停态第二路无事可做 —— 但后台还在推播放态那一次,不能让它白推十几秒
  Object.assign(state, { project: project([card("h", 0, 10), card("b", 0, 10)]), t: 1, playing: true });
  plan = segments(["h"]);
  withRecord("h", { vtOk: false });
  withRecord("b", REC_B);
  const open = gateFirstRender();
  const playingSwap = runPlayingSwap(["b"]);
  await new Promise((r) => setImmediate(r));
  Object.assign(state, { t: 10, playing: false });
  const settled = await Promise.race([runSettleSwap(10), new Promise((r) => setTimeout(() => r("timeout"), 1000))]);
  assert.equal(settled, false, "没有要补跑的卡,不换");
  assert.equal(await playingSwap, false);
  const pushes = log.filter((e) => e[0] === "pushProject");
  assert.equal(pushes.length, 2, "播放态补跑开始那一次 + 掐孤儿那一次");
  assert.deepEqual(pushes[1].slice(1), ["back", true, { reset: true }], "整份重灌当前项目:舞台下一次让出时把在飞的 render 回成 'project'");
  assert.equal(log.filter((e) => e[1] === "render").length, 1, "不为 10 秒补跑");
  assert.equal(swap.stageSwapPlayingDebug().preemptCount, 1);
  open();
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  assert.equal(swap.stageSwapPlayingDebug().orphan, false, "旧的 render 落定之后不再算孤儿");
  assert.equal(swapInFlight(), false);
});

test("进了互换那一步才停下:不抢(新 front 换到一半),收手后按停下那一拍补做(R5-15)", { timeout: 5000 }, async () => {
  Object.assign(state, { project: project([card("h", 0, 10), card("b", 0, 10)]), t: 1, playing: true });
  plan = segments(["h"]);
  withRecord("h", { vtOk: false });
  withRecord("b", REC_B);
  // 互换穿戴时卡在新 front(B)的 setRole('front') 上
  let open;
  const gate = new Promise((r) => { open = r; });
  const setRole = back.setRole;
  back.setRole = async (...args) => { if (args[0] === "front") await gate; return setRole(...args); };
  const playingSwap = runPlayingSwap(["b"]);
  for (let i = 0; i < 50 && !log.some((e) => e[0] === "swapRoles"); i++) await new Promise((r) => setImmediate(r));
  assert.ok(log.some((e) => e[0] === "swapRoles"), "已经在互换");
  Object.assign(state, { t: 0.5, playing: false });
  assert.equal(await runSettleSwap(0.5), false, "不抢:先记下");
  open();
  assert.equal(await playingSwap, true, "播放态那一次照常换完");
  for (let i = 0; i < 50 && (swapInFlight() || log.filter((e) => e[0] === "swapRoles").length < 2); i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(log.filter((e) => e[1] === "render").map((e) => e[2]), [33 / 30, 0.5], "收手之后按停下的 0.5 秒补跑");
  assert.equal(log.filter((e) => e[0] === "swapRoles").length, 2);
  assert.equal(swapInFlight(), false);
});

test("播放态互换跑着时来的 settle,收手时又在播放了就不补(下一次停下自己会来)", async () => {
  Object.assign(state, { project: project([card("h", 0, 10), card("b", 0, 10)]), t: 1, playing: true });
  plan = segments(["h"]);
  withRecord("h", { vtOk: false });
  withRecord("b", REC_B);
  let open;
  back.renderGate = new Promise((r) => { open = r; });
  const playingSwap = runPlayingSwap(["b"]);
  await new Promise((r) => setImmediate(r));
  assert.equal(await runSettleSwap(1), false);
  back.renderGate = null;
  open();
  assert.equal(await playingSwap, true);
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(log.filter((e) => e[1] === "render").map((e) => e[2]), [33 / 30]);
  assert.equal(swapInFlight(), false);
});

/* ---------------------------------------------------------------- 只有一个舞台:不经后台舞台追活渲(原 c10a 第 8 节「不追活渲」) */

test("只有一个舞台:暂停态、播放态的补跑与互换一步都不走(不排后台任务、不抑制、不换)", async () => {
  host.singleStage = () => true;
  plan = segments(["h"]);
  withRecord("h", { vtOk: false });
  assert.equal(swap.swapBlockedBySingleStage(), true);
  assert.equal(await runSettleSwap(1), false);
  Object.assign(state, { project: project([card("b", 0, 10)]), t: 1, playing: true });
  withRecord("b", REC_B);
  assert.equal(await runPlayingSwap(["b"]), false);
  assert.deepEqual(log, [], "一条 RPC、一个后台任务都没有");
  assert.equal(front.name, "A");
  host.singleStage = () => false;
  assert.equal(swap.swapBlockedBySingleStage(), false, "双舞台照旧");
});

/* ---------------------------------------------------------------- 自然进场与从卡中间开始播放(swap-tuning 任务 C) */

/** 起播在 `fromSec`,逐拍报到 `toSec`(含),每拍问一次这一拍要发起互换的卡,回每拍的结果里非空的那些 */
function playAndAsk(p, fromSec, toSec) {
  const { notePlayRunStart, notePlayFrame, playingSwapTargets } = swap;
  notePlayRunStart(fromSec);
  const asked = [];
  for (let f = Math.round(fromSec * FPS) + 1; f <= Math.round(toSec * FPS); f++) {
    notePlayFrame(f / FPS);
    const ids = playingSwapTargets(p, f / FPS);
    if (ids.length) asked.push([f, ids]);
  }
  return asked;
}

test("ST-C-11 播放中逐拍跨过挂载帧、自然进场的 (b) 档轻卡:不发起播放态互换;暂停态第二路照旧收它", () => {
  const p = project([card("b", 2, 8)]);
  Object.assign(state, { project: p, playing: true });
  plan = segments([]);
  withRecord("b", REC_B);
  assert.deepEqual(playAndAsk(p, 0, 3), []);
  assert.deepEqual(playingCatchUpTargets(p, 3), ["b"], "判据本身不变");
  assert.deepEqual(staleOnBackCatchUp(p, 3), ["b"], "停下时照旧整场景补跑");
  assert.equal(swap.stageSwapPlayingDebug().naturalSkips > 0, true);
});

test("ST-C-12 跳到卡中间再播 / 暂停后在卡中间继续播:第一拍就照旧交给估时(发起与否由 planPlayingSwap 定)", () => {
  const p = project([card("b", 2, 8)]);
  Object.assign(state, { project: p, playing: true });
  plan = segments([]);
  withRecord("b", REC_B);
  const seek = playAndAsk(p, 3, 3.1);
  assert.deepEqual(seek[0], [91, ["b"]]);
  // 先连续播过挂载帧,暂停在 4 秒,再继续播
  assert.deepEqual(playAndAsk(p, 0, 4), []);
  assert.deepEqual(playAndAsk(p, 4, 4.1)[0], [121, ["b"]]);
});

test("ST-C-13 恰好停在挂载帧起播:照旧交给估时;停在挂载帧前一帧起播:自然进场", () => {
  const p = project([card("b", 2, 8)]);   // 挂载帧 59
  Object.assign(state, { project: p, playing: true });
  plan = segments([]);
  withRecord("b", REC_B);
  assert.deepEqual(playAndAsk(p, 59 / FPS, 61 / FPS)[0], [60, ["b"]]);
  assert.deepEqual(playAndAsk(p, 58 / FPS, 61 / FPS), []);
});

test("ST-C-14 同一拍两张:从中间开始的那张交给估时,自然进场的那张不发起", () => {
  const p = project([card("old", 0, 8), card("new", 2, 8)]);
  Object.assign(state, { project: p, playing: true });
  plan = segments([]);
  withRecord("old", REC_B);
  withRecord("new", REC_B);
  const asked = playAndAsk(p, 1, 2.5);
  assert.ok(asked.length > 0);
  for (const [, ids] of asked) assert.deepEqual(ids, ["old"]);
});

test("ST-C-15 掉帧:拍序号不缺(慢帧就等)算连续;拍序号跳过挂载帧算断开,交给估时", () => {
  const p = project([card("b", 2, 8)]);
  Object.assign(state, { project: p, playing: true });
  plan = segments([]);
  withRecord("b", REC_B);
  const { notePlayRunStart, notePlayFrame, playingSwapTargets } = swap;
  notePlayRunStart(0);
  for (let f = 1; f <= 55; f++) notePlayFrame(f / FPS);
  assert.equal(notePlayFrame(62 / FPS), "break");
  assert.deepEqual(playingSwapTargets(p, 62 / FPS), ["b"]);
});

test("ST-C-16 播放态互换换上来的新舞台从 T 接着报拍:之后挂载的卡仍是自然进场", async () => {
  const p = project([card("b", 0, 10), card("late", 3, 10)]);
  Object.assign(state, { project: p, t: 1, playing: true });
  plan = segments([]);
  withRecord("b", REC_B);
  withRecord("late", REC_B);
  const { notePlayRunStart, notePlayFrame, playingSwapTargets } = swap;
  notePlayRunStart(1);
  notePlayFrame(31 / FPS);
  assert.deepEqual(playingSwapTargets(p, 31 / FPS), ["b"]);
  assert.equal(await runPlayingSwap(["b"]), true);
  const T = 33 / 30;
  assert.equal(swap.stageSwapPlayingDebug().playRun.lastFrame, Math.round(T * FPS));
  // 新舞台从 T 的下一拍接着报,走到 late 的挂载帧(89)之后
  for (let f = Math.round(T * FPS) + 1; f <= 95; f++) assert.equal(notePlayFrame(f / FPS), "continuous");
  assert.deepEqual(playingSwapTargets(p, 95 / FPS), ["b"], "b 仍是从中间开始的(去重由宿主的 swapTried 做)");
});
