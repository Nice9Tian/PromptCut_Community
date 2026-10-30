/**
 * 父页快照 / 抑制投递(`snapshotFeed.ts`,C4 / C5 / A3c / K6 的消费方)的单测。跑:
 *   node --experimental-test-module-mocks --test src/editor/snapshotFeed.test.mjs
 *
 * 就绪索引和取字节换成假的快照来源,分派表和镜像键换成假的;选帧(`snapshotPick.mjs`)、
 * 就绪索引的合并(`snapshotSource.ts`)用真的。钉的是:
 *   - 只有判重的活跃卡进 heavy,按就绪索引回溯选帧,缺的报 wanted(最多 8 条);
 *   - K6 降级卡在死素材覆盖「从播放头起 min(fps, 剩余帧)」之前照常活渲;
 *   - 投递基线:增量、摘掉、33 ms 节流、reset 不受节流且带 reset、2 MB 拆包、失败后下次带 reset;
 *   - `pickForSetTime` 同步回手里已有的字节,`awaiting` 只点「有表但没带上快照」的卡;
 *   - settled 把卡从基线里删掉,下次同一帧会重投;
 *   - 抑制集合只在播放中有,并上 K3(b) 的额外抑制。
 */
import { srcUrl } from "../testing/registerTs.mjs";
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

let plan = { segments: [] };
const wantedPushed = [];

mock.module(srcUrl("editor/planDispatch.ts"), { exports: { currentPlan: () => plan } });
mock.module(srcUrl("render/dataMirror.ts"), {
  exports: { mirrorKey: () => ({ session: "s", localRev: 1 }), pushWanted: (w) => wantedPushed.push(w) },
});

const feed = await import(srcUrl("editor/snapshotFeed.ts"));
const {
  planFeed, pickForSetTime, deliverSnapshots, noteSettled, markBaselineReset, markPendingDemote, pendingDemotes,
  setExtraSuppressed, suppressedAt, setSnapshotSource, syncSnapshotSubscription, resetSnapshotFeed, setSnapshotArrive,
  MAX_WANTED, SNAPSHOT_THROTTLE_MS, SNAPSHOT_DELIVERY_MAX_BYTES,
} = feed;

/* ---------------------------------------------------------------- 假环境 */

let now = 1000;
performance.now = () => now;

/** 假快照来源:手动推就绪消息;取字节回 `html:<id>`,可以指定某些 id 的内容 */
function fakeSource() {
  const src = {
    push: null,
    bodies: new Map(),
    fetched: [],
    subscribeReady(_session, _rev, onMessage) { src.push = onMessage; return () => { src.push = null; }; },
    async fetchSnapshot(kind, key, localFrame) {
      const id = `${kind}/${key}/${localFrame}`;
      src.fetched.push(id);
      return src.bodies.get(id) ?? `html:${id}`;
    },
  };
  return src;
}

/** 假舞台客户端:记下每次 setSnapshots,可以让它失败 */
function fakeStage() {
  const st = { calls: [], fail: false };
  st.setSnapshots = async (patch, opts) => {
    if (st.fail) throw new Error("iframe gone");
    st.calls.push({ patch, opts });
  };
  return st;
}

const FPS = 30;
const card = (id, start, end) => ({ id, cardId: "c", start, end, params: {} });
const project = (clips) => ({ version: 1, name: "p", width: 1920, height: 1080, fps: FPS, duration: 20, media: [], tracks: [{ id: "t", name: "t", clips }] });
const heavyEverywhere = (...ids) => ({ segments: [{ fromSec: 0, toSec: 1000, heavy: new Set(ids) }] });
const layer = (clipId, ranges, kind = "html", key = `k-${clipId}`) => ({ type: "layer", clipId, kind, key, ranges });
const settle = () => new Promise((r) => setImmediate(r));

let src;
beforeEach(() => {
  resetSnapshotFeed();
  src = fakeSource();
  setSnapshotSource(src);
  syncSnapshotSubscription(() => {});
  setExtraSuppressed([]);
  plan = { segments: [] };
  wantedPushed.length = 0;
  now += 10_000;
});

/* ---------------------------------------------------------------- 选帧 */

test("只有判重、正在挂载的卡进 heavy;轻卡和不在场的卡不进", () => {
  const p = project([card("h", 0, 10), card("l", 0, 10), card("gone", 12, 15)]);
  plan = heavyEverywhere("h", "gone");
  assert.deepEqual(planFeed({ project: p, t: 1, playing: false }).heavy, ["h"]);
});

test("快照退役:planFeed 不再选帧,picks 恒为空,wanted 恒为空", () => {
  const p = project([card("h", 0, 10)]);
  plan = heavyEverywhere("h");
  src.push(layer("h", [[0, 20]]));
  const f = planFeed({ project: p, t: 1, playing: false });
  assert.equal(f.picks.size, 0);
  assert.deepEqual(f.wanted, []);

  src.push(layer("h", [[0, 40]]));
  const g = planFeed({ project: p, t: 1, playing: false });
  assert.equal(g.picks.size, 0);
  assert.deepEqual(g.wanted, []);
});

test("html 与 local 快照退役:不选帧、不报缺口", () => {
  const p = project([card("h", 0, 10), card("g", 0, 10)]);
  plan = heavyEverywhere("h", "g");
  src.push(layer("h", [[0, 100]], "local"));
  const f = planFeed({ project: p, t: 1, playing: false });
  assert.equal(f.picks.size, 0);
  assert.deepEqual(f.wanted, []);
});

test("缺口上报已退役:wanted 恒为空数组", () => {
  const ids = Array.from({ length: 12 }, (_, i) => `h${String(i).padStart(2, "0")}`);
  plan = heavyEverywhere(...ids);
  const f = planFeed({ project: project(ids.map((id) => card(id, 0, 10))), t: 1, playing: false });
  assert.equal(f.heavy.length, 12);
  assert.equal(f.wanted.length, 0);
});

/* ---------------------------------------------------------------- K6 */

test("K6:降级卡死素材就绪之前照常活渲,不进 heavy", () => {
  const p = project([card("h", 0, 10)]);
  plan = heavyEverywhere("h");
  markPendingDemote("h");
  // 播放头在第 30 帧:要覆盖 [30, 59](一秒，即第 2、3 分段)才算就绪
  const streamLayer = (ranges, originFrame = 0) => ({ ...layer("h", ranges, "stream"), originFrame });
  src.push(streamLayer([[0, 1]]));
  assert.deepEqual(planFeed({ project: p, t: 1, playing: true }).heavy, []);
  assert.ok(pendingDemotes().has("h"));
  src.push(streamLayer([[0, 3]]));
  assert.deepEqual(planFeed({ project: p, t: 1, playing: true }).heavy, ["h"]);
  assert.equal(pendingDemotes().has("h"), false, "就绪之后移出 pending");
});

test("K6:片段剩下不到一秒时,覆盖到片尾就算就绪;流要按分段盖住当前位置起的一秒才算(根因 D)", () => {
  const p = project([card("h", 0, 10)]);   // 300 帧,本地 0..299
  plan = heavyEverywhere("h");
  markPendingDemote("h");
  const streamLayer = (ranges, originFrame = 0) => ({ ...layer("h", ranges, "stream"), originFrame });
  src.push(streamLayer([[19, 19]]));
  assert.deepEqual(planFeed({ project: p, t: 290 / FPS, playing: true }).heavy, ["h"]);

  resetSnapshotFeed();
  setSnapshotSource(src);
  syncSnapshotSubscription(() => {});
  markPendingDemote("h");
  // 流的层带着这条流自己的第一帧(片段从第 0 帧起,所以是 0);分段从它起数
  src.push(streamLayer([[0, 0]]));
  assert.deepEqual(planFeed({ project: p, t: 1, playing: true }).heavy, [], "流表有别的段不算:当前位置没料");
  // 第 1 秒 = 第 30 帧,一秒到第 59 帧 = 第 2、3 段
  src.push(streamLayer([[2, 3]]));
  assert.deepEqual(planFeed({ project: p, t: 1, playing: true }).heavy, ["h"]);
  // 没带第一帧的层(改分段规则之前的生产者发的)没法换算:当作没有流
  src.push(layer("h", [[2, 3]], "stream"));
  markPendingDemote("h");
  assert.deepEqual(planFeed({ project: p, t: 1, playing: true }).heavy, [], "没带第一帧的流层不算就绪");
});

/* ---------------------------------------------------------------- 投递 */

/* ---------------------------------------------------------------- 投递 */

test("pickForSetTime:快照退役后恒返回空快照与空 awaiting,不发起取字节", async () => {
  const p = project([card("h", 0, 10)]);
  plan = heavyEverywhere("h");
  src.push(layer("h", [[0, 100]]));
  const head = { project: p, t: 1, playing: false };
  const first = pickForSetTime(head);
  assert.deepEqual(first, { snapshots: {}, awaiting: [] });
  assert.deepEqual(src.fetched, []);
});

test("pickForSetTime:没有表的判重卡不 awaiting(等也等不来)", () => {
  plan = heavyEverywhere("h");
  assert.deepEqual(pickForSetTime({ project: project([card("h", 0, 10)]), t: 1, playing: false }).awaiting, []);
});

test("deliverSnapshots:快照退役后返回 0,不再向舞台派发快照补丁", async () => {
  const p = project([card("h", 0, 10)]);
  plan = heavyEverywhere("h");
  src.push(layer("h", [[0, 100]]));
  const stage = fakeStage();
  const head = { project: p, t: 1, playing: true };
  assert.equal(await deliverSnapshots(stage, "front", head), 0);
  assert.equal(stage.calls.length, 0);
});

test("deliverSnapshots:播放中投递清空 settled", async () => {
  const p = project([card("h", 0, 10)]);
  plan = heavyEverywhere("h");
  const stage = fakeStage();
  noteSettled("front", ["h"]);
  assert.deepEqual(suppressedAt({ project: p, t: 1, playing: false }), []);
  await deliverSnapshots(stage, "front", { project: p, t: 1, playing: true });
  assert.deepEqual(suppressedAt({ project: p, t: 1, playing: false }), ["h"]);
});

test("markBaselineReset:保留向后兼容接口", () => {
  markBaselineReset("front");
  markBaselineReset("back");
});

test("settled 状态影响 suppressedAt 与 scrub", () => {
  const p = project([card("h", 0, 10)]);
  plan = heavyEverywhere("h");
  const head = { project: p, t: 1, playing: false };
  assert.deepEqual(suppressedAt(head), ["h"]);
  noteSettled("front", ["h"]);
  assert.deepEqual(suppressedAt(head), []);
  pickForSetTime(head);
  assert.deepEqual(suppressedAt(head), ["h"]);
});

/*
 * c10a 契约第 17 节「停下追当前一帧」(2026-10-22 起归「只有一个舞台」):停下时舞台在可见舞台里把当前这一帧逐层追一次,
 * 画好的层收 `settled`,和双舞台一样暂停中不再抑制;下一次 setTime / 播放照常进入抑制。
 */
test("单舞台停下追一帧画好的层(settled)暂停中不再抑制;下一次 setTime 照常进入抑制", () => {
  const p = project([card("h", 0, 10)]);
  plan = heavyEverywhere("h");
  const head = { project: p, t: 1, playing: false, single: true, sparseOnly: true };
  assert.deepEqual(suppressedAt(head), ["h"]);
  noteSettled("front", ["h"]);
  assert.deepEqual(suppressedAt(head), []);
  pickForSetTime(head);
  assert.deepEqual(suppressedAt(head), ["h"]);
});

/* ---------------------------------------------------------------- 抑制 */

test("重卡抑制集合:播放中为 heavy 并上 K3(b) 的额外抑制;暂停时未 settled 进 scrub", () => {
  const p = project([card("h", 0, 10), card("l", 0, 10)]);
  plan = heavyEverywhere("h");
  assert.deepEqual(suppressedAt({ project: p, t: 1, playing: true }), ["h"]);
  setExtraSuppressed(["l", "h"]);
  assert.deepEqual(suppressedAt({ project: p, t: 1, playing: true }), ["h", "l"]);
  // 暂停中未 settled 的重卡进 scrub 占位
  assert.deepEqual(suppressedAt({ project: p, t: 1, playing: false }), ["h"]);
  // settled 之后暂停中不再抑制
  noteSettled("front", ["h"]);
  assert.deepEqual(suppressedAt({ project: p, t: 1, playing: false }), []);
});

test("快照退役后不再向预渲染进程上报 wanted 缺口", () => {
  plan = heavyEverywhere("h");
  pickForSetTime({ project: project([card("h", 0, 10)]), t: 1, playing: false });
  assert.deepEqual(wantedPushed, []);
});

test("最低一档:小尺寸快照退役,picks 恒为空,未就绪重卡在暂停时进 scrub 占位", () => {
  const p = project([card("h", 0, 10)]);
  plan = heavyEverywhere("h");
  src.push(layer("h", [[1, 27], [32, 119]]));
  const f = planFeed({ project: p, t: 1, playing: false, single: true, sparseOnly: true });
  assert.equal(f.picks.size, 0);
  assert.deepEqual(f.scrub, ["h"]);
});

/* ---------------------------------------------------------------- C10 第 9 节:在线的用户卡、素材效果卡 */

test("在线浏览器模式:用户卡、素材效果卡(含同步来的)一律按重卡;停下不认「已精确」;桌面照旧(C10 契约第 9 节,2026-09-29)", async () => {
  const registry = await import(srcUrl("kernel/registry.ts"));
  const host = await import(srcUrl("render/placeholderHost.ts"));
  registry.registerCards([{ id: "graphish", card: () => null, params: {} }]);
  registry.setUserCardSources({ "mine.tsx": "" }, { mine: "mine.tsx" });
  registry.setSyncedUserCards([{ id: "synced", name: "同步卡" }]);
  const clips = [
    { ...card("u", 0, 10), cardId: "mine" },
    { ...card("g", 0, 10), cardId: "graphish" },
    { ...card("s", 0, 10), cardId: "synced" },
    card("b", 0, 10),
  ];
  const p = project(clips);
  // 分派表只判 u、g、b 重:同步卡 s 表里没判重(本机测不了它)
  plan = heavyEverywhere("u", "g", "b");
  for (const id of ["u", "g", "s", "b"]) src.push(layer(id, [[0, 299]]));
  try {
    // 桌面:按分派表,同步表不起作用
    host.setOnlineBrowserMode(false);
    assert.deepEqual(planFeed({ project: p, t: 1, playing: true }).heavy, ["b", "g", "u"]);
    // 在线:四张都按重卡
    host.setOnlineBrowserMode(true);
    resetSnapshotFeed(); src = fakeSource(); setSnapshotSource(src); syncSnapshotSubscription(() => {});
    for (const id of ["u", "g", "s", "b"]) src.push(layer(id, [[0, 100]]));
    const got = planFeed({ project: p, t: 5, playing: true });
    assert.deepEqual(got.heavy, ["b", "g", "s", "u"]);
    assert.equal(got.picks.size, 0, "快照已退役");
    assert.deepEqual(got.wanted, [], "不再报缺口");
    assert.deepEqual(suppressedAt({ project: p, t: 5, playing: true }), ["b", "g", "s", "u"], "播放中一律抑制");
    const stage = fakeStage();
    await deliverSnapshots(stage, "front", { project: p, t: 1, playing: true });
    await settle();
    assert.equal(src.fetched.length, 0, "不再取快照字节");
    // 暂停态:舞台报了 settled(停下追到精确)的内置卡不再抑制;本机跑不了的卡停下不追,一直在 scrub 占位
    noteSettled("front", ["b", "u", "s"]);
    const paused = planFeed({ project: p, t: 1, playing: false });
    assert.deepEqual(paused.scrub.sort(), ["g", "s", "u"]);
  } finally {
    host.setOnlineBrowserMode(false);
    registry.setSyncedUserCards([]);
    registry.setUserCardSources({}, {});
  }
});
