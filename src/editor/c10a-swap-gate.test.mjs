/**
 * C10a 能力闸：只有一个舞台时不经后台舞台追活渲、不起后台舞台的活（`docs/plan/c10a-contract.md` 第 8 节「不追活渲」「不开后台舞台」，
 * 第 12 节「能力闸」；2026-10-22 起闸门从撤销的旧档位改成「只有一个舞台」——舞台闸门第一级、最低一档、握手失败退回）。
 * 跑：node --experimental-test-module-mocks --test src/editor/c10a-swap-gate.test.mjs
 *
 * 做法照 `stageSwap.test.mjs`：store、舞台桥、后台任务队列、分派表、身份表、快照投递都换成假的，
 * 造一个在双舞台下一定会走「后台补跑再互换」的场面（判重、`vtOk = false`），再把「只有一个舞台」打开：
 * `runSettleSwap` / `runPlayingSwap` 必须什么都不做 —— 不排后台任务（`runBackJob`）、不对后台舞台灌项目或 `render`、不互换。
 *
 * 闸从哪来：假设 K3（集成对账后），`stageSwap.ts` 问宿主 `SwapHost.singleStage()`（`singleStageSwapHost` 补上）。
 * `src/online/onlineTier.ts` 不在时整组 skip。
 */
import { srcUrl } from "../testing/registerTs.mjs";
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { exists, skipIf, TIER_FILE, singleStageSwapHost } from "../../server/test/c10a-kit.mjs";

const missing = !exists(TIER_FILE);
const skip = skipIf(missing, `${TIER_FILE}（stageSwap 的单舞台闸随它来）`);
const it = (name, fn) => test(name, { skip }, fn);

globalThis.window = globalThis;

const log = [];
const state = { project: null, t: 0, playing: false };
let plan = { segments: [] };
let costs = [];
let identityKeys = {};
const listeners = new Set();
const emit = (e) => { for (const l of [...listeners]) l(e); };
let front = null;
let back = null;

let swap = null;
if (!missing) {
  mock.module(srcUrl("online/mode.ts"), { exports: { ONLINE: true } });
  mock.module(srcUrl("store/project.ts"), { exports: { getState: () => state } });
  mock.module(srcUrl("editor/stageBridge.ts"), {
    exports: {
      frontStage: () => front,
      backStage: () => back,
      onStageEvent: (l) => { listeners.add(l); return () => listeners.delete(l); },
      pushProject: async (role) => { log.push(["pushProject", role]); },
      syncProject: async (role) => { log.push(["syncProject", role]); },
    },
  });
  mock.module(srcUrl("editor/stageJobs.ts"), {
    exports: {
      runBackJob: async (kind, run) => { log.push(["runBackJob", kind]); return run({ stage: back, signal: new AbortController().signal }); },
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
  mock.module(srcUrl("editor/costIdentity.ts"), { exports: { clipIdentityOf: () => ({ identityKeys, frameModes: {} }) } });
  mock.module(srcUrl("editor/snapshotFeed.ts"), {
    exports: {
      clearSettled: () => {},
      deliverSnapshots: async () => 0,
      markBaselineReset: () => {},
      markAllSettled: () => {},
      setExtraSuppressed: (ids) => log.push(["setExtraSuppressed", [...ids]]),
      suppressedAt: () => [],
      streamPlanesAt: () => [],
    },
  });
  mock.module(srcUrl("editor/demote.ts"), { exports: { onStageDemote: async (id) => ({ ok: true, clipId: id }) } });
  swap = await import(srcUrl("editor/stageSwap.ts"));
}

function fakeStage(name) {
  const st = { name };
  const rec = (method) => async (...args) => { log.push([name, method, ...args]); return { ok: true }; };
  for (const m of ["setRole", "setLocalHashes", "setSuppressed", "setStreamPlanes", "setSnapshots", "setPlaying", "setScrubbing", "setProxy", "play", "render"]) st[m] = rec(m);
  st.setMediaT = async (sec) => { log.push([name, "setMediaT", sec]); emit({ type: "mediaReady" }); return { ok: true }; };
  st.pause = async (opts) => { log.push([name, "pause", opts]); queueMicrotask(() => emit({ type: "frame", sec: opts.atSec })); return { ok: true, passed: false }; };
  return st;
}

const FPS = 30;
const card = (id, start, end) => ({ id, cardId: "c", start, end, params: {} });
const project = (clips) => ({ version: 1, name: "p", width: 1920, height: 1080, fps: FPS, duration: 20, media: [], tracks: [{ id: "t", name: "t", clips }] });
const withRecord = (clipId, record) => {
  identityKeys[clipId] = `k-${clipId}`;
  costs.push({ identityKey: `k-${clipId}`, device: "d", ...record });
};

beforeEach(() => {
  if (!swap) return;
  swap.resetStageSwap();
  log.length = 0;
  listeners.clear();
  costs = [];
  identityKeys = {};
  front = fakeStage("A");
  back = fakeStage("B");
  // 集成对账（K3）：单舞台闸在 SwapHost.singleStage() 上
  swap.setSwapHost(singleStageSwapHost({
    swapRoles() { log.push(["swapRoles"]); [front, back] = [back, front]; return { front, back }; },
    proxy: () => true,
    localHashes: () => ["h1"],
  }));
});

/** 双舞台下这两个场面一定会走补跑（与 stageSwap.test.mjs 的「暂停态互换」「播放态互换」同一组数据） */
const TOUCHES_BACK = (e) => e[0] === "runBackJob" || e[0] === "swapRoles" || (e[0] === "pushProject" && e[1] === "back") || (e[0] === "B" && (e[1] === "render" || e[1] === "setMediaT"));

it("C10A-GT-05 暂停后不追活渲：判重、vtOk = false 的卡在场，只有一个舞台时 runSettleSwap 什么都不做", async () => {
  Object.assign(state, { project: project([card("h", 0, 10)]), t: 1, playing: false });
  plan = { segments: [{ fromSec: 0, toSec: 1000, heavy: new Set(["h"]) }] };
  withRecord("h", { vtOk: false });
  assert.equal(await swap.runSettleSwap(1), false);
  assert.deepEqual(log.filter(TOUCHES_BACK), [], `不该碰后台舞台：${JSON.stringify(log)}`);
  assert.equal(front.name, "A", "没有互换");
  assert.equal(swap.swapInFlight(), false);
});

it("C10A-GT-06 播放中也不追：判轻、(b) 档的卡在场，只有一个舞台时 runPlayingSwap 什么都不做", async () => {
  Object.assign(state, { project: project([card("b", 0, 10)]), t: 1, playing: true });
  plan = { segments: [{ fromSec: 0, toSec: 1000, heavy: new Set() }] };
  withRecord("b", { vtOk: false, stepMs: 2, stepMaxMs: 3, catchUpMs: 200 });
  assert.equal(await swap.runPlayingSwap(["b"]), false);
  assert.deepEqual(log.filter(TOUCHES_BACK), [], `不该碰后台舞台：${JSON.stringify(log)}`);
  assert.equal(front.name, "A");
});
