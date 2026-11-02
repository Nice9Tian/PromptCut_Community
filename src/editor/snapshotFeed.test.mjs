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

test("Only cards classified as heavy and currently mounted enter heavy; light cards and cards not present do not", () => {
  const p = project([card("h", 0, 10), card("l", 0, 10), card("gone", 12, 15)]);
  plan = heavyEverywhere("h", "gone");
  assert.deepEqual(planFeed({ project: p, t: 1, playing: false }).heavy, ["h"]);
});

test("Snapshots retired: planFeed no longer picks frames, picks is always empty, wanted is always empty", () => {
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

test("html and local snapshots retired: no frames are picked, no gaps are reported", () => {
  const p = project([card("h", 0, 10), card("g", 0, 10)]);
  plan = heavyEverywhere("h", "g");
  src.push(layer("h", [[0, 100]], "local"));
  const f = planFeed({ project: p, t: 1, playing: false });
  assert.equal(f.picks.size, 0);
  assert.deepEqual(f.wanted, []);
});

test("Gap reporting is retired: wanted is always an empty array", () => {
  const ids = Array.from({ length: 12 }, (_, i) => `h${String(i).padStart(2, "0")}`);
  plan = heavyEverywhere(...ids);
  const f = planFeed({ project: project(ids.map((id) => card(id, 0, 10))), t: 1, playing: false });
  assert.equal(f.heavy.length, 12);
  assert.equal(f.wanted.length, 0);
});

/* ---------------------------------------------------------------- K6 */

test("K6: before the dead asset of a downgraded card is ready, live render as usual and do not enter heavy", () => {
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
  assert.equal(pendingDemotes().has("h"), false, "Removed from pending once ready");
});

test("K6: when less than a second of the clip remains, covering up to the end of the clip counts as ready; a stream counts only if its segments cover the second starting from the current position (root cause D)", () => {
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
  assert.deepEqual(planFeed({ project: p, t: 1, playing: true }).heavy, [], "Other segments in the stream table do not count: there is no data at the current position");
  // 第 1 秒 = 第 30 帧,一秒到第 59 帧 = 第 2、3 段
  src.push(streamLayer([[2, 3]]));
  assert.deepEqual(planFeed({ project: p, t: 1, playing: true }).heavy, ["h"]);
  // 没带第一帧的层(改分段规则之前的生产者发的)没法换算:当作没有流
  src.push(layer("h", [[2, 3]], "stream"));
  markPendingDemote("h");
  assert.deepEqual(planFeed({ project: p, t: 1, playing: true }).heavy, [], "A stream layer without its first frame is not ready");
});

/* ---------------------------------------------------------------- 投递 */

/* ---------------------------------------------------------------- 投递 */

test("pickForSetTime: after snapshots retire it always returns empty snapshots and empty awaiting, and starts no byte fetch", async () => {
  const p = project([card("h", 0, 10)]);
  plan = heavyEverywhere("h");
  src.push(layer("h", [[0, 100]]));
  const head = { project: p, t: 1, playing: false };
  const first = pickForSetTime(head);
  assert.deepEqual(first, { snapshots: {}, awaiting: [] });
  assert.deepEqual(src.fetched, []);
});

test("pickForSetTime: a heavy-classified card without a table is not put in awaiting (it would never arrive anyway)", () => {
  plan = heavyEverywhere("h");
  assert.deepEqual(pickForSetTime({ project: project([card("h", 0, 10)]), t: 1, playing: false }).awaiting, []);
});

test("deliverSnapshots: returns 0 after snapshots retire and no longer dispatches snapshot patches to the stage", async () => {
  const p = project([card("h", 0, 10)]);
  plan = heavyEverywhere("h");
  src.push(layer("h", [[0, 100]]));
  const stage = fakeStage();
  const head = { project: p, t: 1, playing: true };
  assert.equal(await deliverSnapshots(stage, "front", head), 0);
  assert.equal(stage.calls.length, 0);
});

test("deliverSnapshots: delivery during playback clears settled", async () => {
  const p = project([card("h", 0, 10)]);
  plan = heavyEverywhere("h");
  const stage = fakeStage();
  noteSettled("front", ["h"]);
  assert.deepEqual(suppressedAt({ project: p, t: 1, playing: false }), []);
  await deliverSnapshots(stage, "front", { project: p, t: 1, playing: true });
  assert.deepEqual(suppressedAt({ project: p, t: 1, playing: false }), ["h"]);
});

test("markBaselineReset: kept as a backward-compatible interface", () => {
  markBaselineReset("front");
  markBaselineReset("back");
});

test("The settled state affects suppressedAt and scrub", () => {
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
test("Single stage: a layer that has caught up and drawn a frame after stopping (settled) is no longer suppressed while paused; the next setTime enters suppression as usual", () => {
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

test("Heavy-card suppression set: during playback it is heavy plus the extra suppression of K3(b); when paused, cards not yet settled enter scrub", () => {
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

test("After snapshots retire, wanted gaps are no longer reported to the prerender process", () => {
  plan = heavyEverywhere("h");
  pickForSetTime({ project: project([card("h", 0, 10)]), t: 1, playing: false });
  assert.deepEqual(wantedPushed, []);
});

test("Lowest tier: small-size snapshots retired, picks is always empty, and heavy cards not yet ready enter scrub for a placeholder when paused", () => {
  const p = project([card("h", 0, 10)]);
  plan = heavyEverywhere("h");
  src.push(layer("h", [[1, 27], [32, 119]]));
  const f = planFeed({ project: p, t: 1, playing: false, single: true, sparseOnly: true });
  assert.equal(f.picks.size, 0);
  assert.deepEqual(f.scrub, ["h"]);
});

/* ---------------------------------------------------------------- C10 第 9 节:在线的用户卡、素材效果卡 */

test("Online browser mode: user cards and media effect cards (including synced ones) are all treated as heavy cards; \"already exact\" is not honored once stopped; desktop unchanged (C10 contract, section 9, 2026-09-29)", async () => {
  const registry = await import(srcUrl("kernel/registry.ts"));
  const host = await import(srcUrl("render/placeholderHost.ts"));
  registry.registerCards([{ id: "graphish", card: () => null, params: {} }]);
  registry.setUserCardSources({ "mine.tsx": "" }, { mine: "mine.tsx" });
  registry.setSyncedUserCards([{ id: "synced", name: "Synced card" }]);
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
    assert.equal(got.picks.size, 0, "Snapshots are retired");
    assert.deepEqual(got.wanted, [], "Gaps are no longer reported");
    assert.deepEqual(suppressedAt({ project: p, t: 5, playing: true }), ["b", "g", "s", "u"], "Always suppressed while playing");
    const stage = fakeStage();
    await deliverSnapshots(stage, "front", { project: p, t: 1, playing: true });
    await settle();
    assert.equal(src.fetched.length, 0, "Snapshot bytes are no longer fetched");
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
