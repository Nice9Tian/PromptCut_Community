/**
 * 最低一档的显示与单舞台「停下追一帧」页面一侧的单测(编号沿用 c10a 契约第 17 节的 C10A-L17-…;原文件 `c10a-l17-lowmem.test.mjs`,
 * 2026-10-22 随旧档位撤销改名,语义见 `product/platforms.md`「在线浏览器」的「最低一档」与「停下」):
 *
 *   H1 全部按重卡(`allHeavy`):最低一档播放时不做任何即时渲染,所有卡(包括声明为 direct、实测很轻的)在每个位置都判重、整段进预渲染集合
 *   H2 分派表下发:`planDispatch.setPlanLowest` 打开后,父页显示用的这一份表(`currentPlan`,发给舞台)里所有卡判重;关上回到按成本记录
 *      (只有一个舞台时的判定的表另见 `c10-cost-plan.test.mjs`)
 *   S1 停下追一帧:直接定位的先、推帧卡要推的帧少的先;**不设时限**(2026-10-07 用户定),给了时限(测试与诊断)才截
 *   S2 给了时限而时限到了:还没画好的层维持兜底(记进 timedOut),没开始画的一并算;画好的记下耗时
 *   S3 本页跑不了的用户卡、素材效果卡不追:单列 skipped;有这一帧的预渲染结果就贴着,没有就是沙漏、等渲染节点
 *      (unsupported 占位,进显隐调度;2026-09-29 用户改语义)。同步来的用户卡没有定义也认
 *   S4 被新的跳转 / 播放打断:回 ok: false,没画的层照样算没画
 *   S5 舞台 RPC:settleLayers 不设时限时父页按上限 `SETTLE_RPC_CAP_MS` 判超时;给了时限按「它的时限 + 余量」,别的调用不变
 *
 * 跑:npm test -- src/render/settleFrame.test.mjs
 */
import { srcUrl } from "../testing/registerTs.mjs";
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { planPipelines, pipelineAt } from "./pipelinePlan.mjs";

globalThis.window = globalThis;

const FPS = 30;
function project(clips) {
  return { version: 1, name: "p", width: 1920, height: 1080, fps: FPS, duration: 60, themeId: "midnight",
    tracks: [{ id: "tr", name: "tr", clips: clips.map((c) => ({ id: c.id, cardId: `card-${c.id}`, start: c.start, end: c.end, params: {} })) }] };
}
const light = (id) => ({ identityKey: `key-${id}`, fps: FPS, device: "d", measuredAt: 1, stepMs: 0.5, kind: "random", vtOk: true, seekOk: true, seekMs: 0.5, catchUpMs: 0.5 });

test("C10A-L17-H1 最低一档所有卡判重:不看成本记录与声明,每个位置都判重、整段进预渲染集合", () => {
  const clips = [{ id: "a", start: 0, end: 4 }, { id: "b", start: 1, end: 3 }, { id: "c", start: 2, end: 6 }];
  const p = project(clips);
  const costs = [light("a"), light("b")];                     // a、b 实测很轻;c 没测过
  const opts = { identityKeys: { a: "key-a", b: "key-b", c: "key-c" }, frameModes: { a: "direct", b: "stateful", c: "direct" } };
  // 别的档:按实测与声明,三张都判轻
  const normal = planPipelines(p, costs, FPS, opts);
  assert.deepEqual([...normal.prerenderSet], []);
  // 最低一档:全部判重
  const low = planPipelines(p, costs, FPS, { ...opts, allHeavy: true });
  assert.deepEqual([...low.prerenderSet], ["a", "b", "c"]);
  for (const seg of low.segments) {
    assert.equal(seg.light.size, 0, `位置 ${seg.fromSec}～${seg.toSec} 没有轻卡`);
  }
  for (const c of clips) {
    for (let t = c.start; t < c.end; t += 0.5) assert.equal(pipelineAt(low, c.id, t), "heavy", `${c.id} 在 ${t} 秒判重`);
  }
});

test("C10A-L17-H2 分派表:最低一档打开后父页显示用的表里所有卡判重(播放不活渲),关上回到按成本记录", async () => {
  mock.module(srcUrl("editor/stageBridge.ts"), { exports: { frontStage: () => null, backStage: () => null } });
  mock.module(srcUrl("editor/costIdentity.ts"), { exports: { clipIdentityOf: () => ({ identityKeys: {}, frameModes: { a: "direct", b: "direct" } }) } });
  // 夹具里的卡要在注册表里有定义:两边都没有定义的「未知卡片」不进分派表(2026-09-29 起,舞台不画它们)
  (await import(srcUrl("kernel/registry.ts"))).registerCards(["a", "b"].map((id) => ({ id: `card-${id}`, name: id, defaults: {}, controls: [], frameMode: "direct", Component: () => null })));
  const d = await import(srcUrl("editor/planDispatch.ts"));
  d.resetPlanDispatch();
  const p = project([{ id: "a", start: 0, end: 2 }, { id: "b", start: 0, end: 2 }]);
  const settle = () => new Promise((r) => queueMicrotask(r));
  d.setPlanProject(p);
  await settle();
  assert.deepEqual([...d.currentPlan().prerenderSet], [], "别的档:声明 direct 的卡判轻");
  d.setPlanLowest(true);
  await settle();
  assert.equal(d.planLowest(), true);
  assert.deepEqual([...d.currentPlan().prerenderSet], ["a", "b"], "最低一档:全部判重");
  assert.equal(pipelineAt(d.currentPlan(), "a", 1), "heavy");
  assert.deepEqual([...d.judgedPlan().prerenderSet], [], "判定的表照成本记录与声明:最低一档只改显示");
  d.setPlanLowest(false);
  await settle();
  assert.deepEqual([...d.currentPlan().prerenderSet], []);
  d.resetPlanDispatch();
});

const S = await import(srcUrl("render/settleFrame.ts"));

/** 假时钟 + 每层要画多久(ms);`Infinity` = 画不完 */
function fakeDraw(costs) {
  let now = 0;
  const calls = [];
  return {
    now: () => now,
    calls,
    draw: async (item, deadline) => {
      calls.push(item.clipId);
      const cost = costs[item.clipId] ?? 0;
      if (now + cost > deadline) { now = deadline; return "timeout"; }
      now += cost;
      return "drawn";
    },
  };
}

test("C10A-L17-S1 停下追一帧:不设时限;直接定位的先、推帧卡要推的帧少的先", async () => {
  assert.equal(S.clampSettleTimeout(undefined), null, "不给 = 不设时限");
  assert.equal(S.clampSettleTimeout(null), null);
  assert.equal(S.clampSettleTimeout(-1), null);
  assert.equal(S.clampSettleTimeout(1234.7), 1234);
  assert.equal(S.clampSettleTimeout(10 ** 9), S.SETTLE_MAX_MS);
  assert.equal(S.settleKindOf({ unsupported: false, frameMode: "direct", mountFrame: 0, targetFrame: 90 }), "direct");
  assert.equal(S.settleKindOf({ unsupported: false, frameMode: "stateful", mountFrame: 30, targetFrame: 30 }), "direct", "播放头就在入点上:一步到位");
  assert.equal(S.settleKindOf({ unsupported: false, frameMode: "stateful", mountFrame: 0, targetFrame: 90 }), "catchup", "推帧卡从入点逐帧推");
  assert.equal(S.settleKindOf({ unsupported: true, frameMode: "direct", mountFrame: 0, targetFrame: 9 }), "unsupported");
  const items = [
    { clipId: "long", kind: "catchup", frames: 300 },
    { clipId: "d2", kind: "direct", frames: 0 },
    { clipId: "short", kind: "catchup", frames: 12 },
    { clipId: "d1", kind: "direct", frames: 0 },
  ];
  const { queue } = S.orderSettle(items);
  assert.deepEqual(queue.map((i) => i.clipId), ["d1", "d2", "short", "long"]);
  // 推帧卡要推很久(原来 5 秒时限会截掉的):不设时限时一直画到全部画好,画好一层替换一层
  const f = fakeDraw({ d1: 5, d2: 5, short: 400, long: 120_000 });
  const r = await S.runSettle({ sec: 3, items, now: f.now, draw: f.draw });
  assert.equal(r.ok, true);
  assert.deepEqual(r.drawn.map((d) => d.clipId), ["d1", "d2", "short", "long"]);
  assert.deepEqual(r.drawn.map((d) => d.ms), [5, 10, 410, 120_410], "每层画好时离开始多久");
  assert.deepEqual(r.timedOut, []);
  assert.equal(r.ms, 120_410);
  assert.equal(r.timeoutMs, null);
});

test("C10A-L17-S2 给了时限(测试、诊断)而时限到了:画到一半的与还没开始画的都维持占位(timedOut),已画好的照常替换", async () => {
  const items = [
    { clipId: "d1", kind: "direct", frames: 0 },
    { clipId: "c1", kind: "catchup", frames: 30 },
    { clipId: "c2", kind: "catchup", frames: 600 },      // 推到一半到时限
    { clipId: "c3", kind: "catchup", frames: 900 },      // 轮不到
  ];
  const f = fakeDraw({ d1: 10, c1: 1000, c2: 60_000, c3: 10 });
  const r = await S.runSettle({ sec: 8, items, timeoutMs: 5000, now: f.now, draw: f.draw });
  assert.equal(r.ok, true);
  assert.deepEqual(r.drawn.map((d) => d.clipId), ["d1", "c1"]);
  assert.deepEqual(r.timedOut, ["c2", "c3"], "c2 画到时限,c3 没开始画:都维持占位");
  assert.deepEqual(f.calls, ["d1", "c1", "c2"], "到时限之后不再开始画新的层");
  assert.equal(r.ms, 5000, "耗时封在时限上");
  // 时限可调:同样的层,给 70 秒(夹到上界 60 秒)就都画完
  const g = fakeDraw({ d1: 10, c1: 1000, c2: 50_000, c3: 10 });
  const r2 = await S.runSettle({ sec: 8, items, timeoutMs: 70_000, now: g.now, draw: g.draw });
  assert.deepEqual(r2.timedOut, []);
  assert.equal(r2.timeoutMs, 60_000);
});

test("C10A-L17-S3 本机跑不了的用户卡、素材效果卡不追:单列 skipped;在线浏览器模式下贴预渲染结果,没有就是沙漏、等渲染节点", async () => {
  const H = await import(srcUrl("render/placeholderHost.ts"));
  const isUser = (id) => id === "my-user-card";
  const graphDef = { card: () => null };
  const plainDef = {};
  H.setOnlineBrowserMode(true);
  try {
    assert.equal(H.unsupportedHere("my-user-card", plainDef, isUser), true, "用户卡:这台设备渲染不了");
    assert.equal(H.unsupportedHere("graph-card", graphDef, isUser), true, "素材效果卡:这台设备渲染不了");
    assert.equal(H.unsupportedHere("builtin", plainDef, isUser), false, "内置卡照常");
    const kind = (cardId, def) => S.settleKindOf({ unsupported: H.unsupportedHere(cardId, def, isUser), frameMode: "stateful", mountFrame: 0, targetFrame: 60 });
    const items = [
      { clipId: "u", kind: kind("my-user-card", plainDef), frames: 60 },
      { clipId: "g", kind: kind("graph-card", graphDef), frames: 60 },
      { clipId: "b", kind: kind("builtin", plainDef), frames: 60 },
    ];
    const f = fakeDraw({ b: 100 });
    const r = await S.runSettle({ sec: 2, items, timeoutMs: 5000, now: f.now, draw: f.draw });
    assert.deepEqual(r.skipped, ["g", "u"], "不追:舞台上贴着预渲染结果,没有就是沙漏(结果由渲染节点出;2026-10-21 起没有「需要本地 PC 渲染辅助」)");
    // 同步来的用户卡:本机没有定义,缺省判法查注册表的同步表
    const R = await import(srcUrl("kernel/registry.ts"));
    R.setSyncedUserCards([{ id: "synced-card", name: "同步卡" }]);
    try {
      assert.equal(S.settleKindOf({ unsupported: H.unsupportedHere("synced-card", undefined), frameMode: undefined, mountFrame: 0, targetFrame: 60 }), "unsupported");
      assert.equal(H.unsupportedHere("unknown-card", undefined), false, "两边都没有的 id 不算(与桌面一致:不画)");
    } finally {
      R.setSyncedUserCards([]);
    }
    assert.deepEqual(f.calls, ["b"], "只画内置卡");
    assert.deepEqual(r.drawn.map((d) => d.clipId), ["b"]);
  } finally {
    H.setOnlineBrowserMode(false);
  }
  // 桌面(不是在线浏览器模式)不拦
  assert.equal(H.unsupportedHere("my-user-card", plainDef, isUser), false);
});

test("C10A-L17-S4 被新的跳转 / 播放打断:回 ok: false,没画的层算没画", async () => {
  let gen = 0;
  const items = [{ clipId: "a", kind: "direct", frames: 0 }, { clipId: "b", kind: "catchup", frames: 10 }, { clipId: "c", kind: "catchup", frames: 20 }];
  let now = 0;
  const r = await S.runSettle({
    sec: 1, items, timeoutMs: 5000, now: () => now, aborted: () => gen !== 0,
    draw: async (item) => { now += 10; if (item.clipId === "a") { gen = 1; } return "drawn"; },
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "superseded");
  assert.deepEqual(r.drawn.map((d) => d.clipId), ["a"]);
  assert.deepEqual(r.timedOut, ["b", "c"]);
  // draw 自己回 aborted(舞台那一层被打断)同样收摊
  const r2 = await S.runSettle({ sec: 1, items, timeoutMs: 5000, now: () => 0, draw: async () => "aborted" });
  assert.equal(r2.ok, false);
  assert.deepEqual(r2.timedOut, ["a", "b", "c"]);
});

test("C10A-L17-S5 舞台 RPC:settleLayers 不设时限时按上限判超时,给了时限按它加余量,别的调用不变", async () => {
  const R = await import(srcUrl("render/stageRpc.ts"));
  assert.equal(R.stageCallTimeoutMs("settleLayers", [3, { timeoutMs: 5000 }]), 5000 + R.STAGE_RPC_SLACK_MS);
  assert.equal(R.stageCallTimeoutMs("settleLayers", [3]), S.SETTLE_RPC_CAP_MS);
  assert.equal(R.stageCallTimeoutMs("settleLayers", [3, { timeoutMs: 10 ** 9 }]), S.SETTLE_MAX_MS + R.STAGE_RPC_SLACK_MS);
  assert.equal(R.stageCallTimeoutMs("setGlRoute", ["perDocument"]), R.STAGE_UPDATE_TIMEOUT_MS);
  assert.equal(R.stageCallTimeoutMs("setSnapshots", [{}]), R.STAGE_UPDATE_TIMEOUT_MS);
  assert.equal(R.stageCallTimeoutMs("setTime", [1, {}]), R.STAGE_UPDATE_TIMEOUT_MS);
  assert.equal(R.stageCallTimeoutMs("setTime", [1, { probe: true }]), null);
  assert.equal(R.stageCallTimeoutMs("render", [1]), null);
});
