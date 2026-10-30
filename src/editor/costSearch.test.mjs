/**
 * 只有一个舞台时界限搜索的页面驱动(`costSearch.ts`,原 `lowMemorySearch.ts`):用例 LS-01～LS-08。舞台与文档服务连接都是假的。
 *
 *   LS-01 取记录 → 在唯一那个舞台里测(临时切 back、只走计时趟、一次一个缩水项目)→ 切回 front、整份重灌、restore 一次
 *   LS-02 测量期间 costSearchMeasuring() 为真(父页据此不投快照、不拨时间),测完为假;遮罩状态带进度
 *   LS-03 本地复用:第二次打开全命中,一次都不测、不切角色、不 restore
 *   LS-04 本页跑不了的用户卡、素材效果卡不参加、按重卡;没有记录的卡逐张实测(2026-10-07 用户定);direct 卡按随机帧逐帧 setTime(probe)
 *   LS-05 取不到记录抛错(调用方稍后再试),舞台一下都不碰;项目重灌打断的那一张重来
 *   LS-06 测每张卡之前、之后各叫一次 beforeMeasure / afterMeasure(即时渲染闸门留崩溃记录);真测出来的写进文档服务(publish),本地复用命中的不写
 *   LS-07 搜完之后加了新卡:没有记录的补测那一张(measureNewCards),有记录的按已有的界限判、不测
 *   LS-08 两个舞台的界限搜索测完以后给判重的卡产稀疏版那一段:holdCostSearchMask 立起遮罩、带进度,releaseCostSearchMask 撤下
 *
 * 跑:npm test -- src/editor/costSearch.test.mjs
 */
import { srcUrl } from "../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryCostStore, maxMeasurements } from "../render/boundarySearch.mjs";

const L = await import(srcUrl("editor/costSearch.ts"));

const FPS = 30;
const B = 1000 / FPS * 0.7;
const ENV = { platform: "iPhone", userAgent: "Mozilla/5.0 (iPhone) CriOS/152.0.0.0", renderer: "Apple GPU", vendor: "Apple Inc." };

/** n 张卡 c00…,每张一个片段;identityKey = k<i> */
function fixture(n, { extra = [] } = {}) {
  const clips = Array.from({ length: n }, (_, i) => ({ id: `c${String(i).padStart(2, "0")}`, cardId: `card${i}`, start: i * 0.1, end: i * 0.1 + 2, params: {} }));
  for (const c of extra) clips.push(c);
  const project = { version: 1, name: "p", width: 640, height: 360, fps: FPS, duration: 20, themeId: "midnight", tracks: [{ id: "t", name: "t", clips }] };
  const identityKeys = Object.fromEntries(clips.map((c) => [c.id, `k${c.id.slice(1)}`]));
  const capabilities = new Map(clips.map((c) => [c.id, { frameMode: c.frameMode ?? "stateful" }]));
  return { project, identityKeys, capabilities };
}

/** 假舞台:按当前缩水项目里那张卡的「本机耗时」回计时趟 */
function fakeStage(localMs, log) {
  let current = null;
  let role = "front";
  return {
    role: () => role,
    setProject: (p) => { current = p; },
    async setRole(r) { role = r; log.push(`role:${r}`); return { ok: true }; },
    async setTime(t, opts = {}) {
      if (opts.probe) {
        if (role !== "back") return { aborted: true, reason: "role" };
        const clip = current.tracks[0].clips[0];
        log.push(`probe:${clip.id}@${t.toFixed(3)}`);
        return { path: "set", stepMs: localMs(clip.id) };
      }
      return { path: "set" };
    },
    async render(t, opts = {}) {
      if (role !== "back") return { aborted: true, reason: "role" };
      assert.equal(opts.probe, "time", "只走计时趟,不生成快照");
      const clip = current.tracks[0].clips[0];
      assert.equal(current.tracks.length, 1, "一次只测一个片段");
      assert.equal(clip.start, 0, "缩水项目从 0 开始");
      log.push(`time:${clip.id}`);
      assert.equal(L.costSearchMeasuring(), true, "测量期间 costSearchMeasuring 为真");
      const ms = localMs(clip.id);
      return { remounted: true, caughtUpAtSec: t, elapsedMs: ms * 20, stepMs: ms, steps: Array.from({ length: 20 }, () => ms) };
    },
    async rectsWithBounds() { return []; },
  };
}

function deps({ n = 12, local, records, store = createMemoryCostStore(), extra = [], unsupported = () => false, request }) {
  const f = fixture(n, { extra });
  const log = [];
  const stage = fakeStage(local, log);
  const pushed = [];
  let restores = 0;
  const d = {
    request: request ?? (async (msg) => {
      assert.equal(msg.type, "cost.list");
      assert.deepEqual(msg.environment, ENV, "环境只报原始值");
      return { type: "cost.listing", projectId: msg.projectId, records, truncated: false, envFingerprint: "f00dfacecafe0001" };
    }),
    projectId: "sp_testtesttesttesttesttestte",
    project: f.project,
    environment: ENV,
    identityKeys: f.identityKeys,
    capabilities: f.capabilities,
    unsupported,
    stage: () => stage,
    pushProject: async (p) => { pushed.push(p); stage.setProject(p); },
    restore: () => { restores++; },
    currentProject: () => f.project,
    store,
  };
  return { d, log, pushed, restores: () => restores, f };
}

const recordsFor = (n, rep = (i) => i + 1) => Array.from({ length: n }, (_, i) => ({ identityKey: `k${String(i).padStart(2, "0")}`, envFingerprint: "aaaaaaaaaaaaaaaa", stepMs: rep(i), samples: 16, measuredAt: 1, mode: "dev" }));

test("LS-01 取记录 → 在唯一那个舞台里测(临时切 back)→ 切回 front、整份重灌、restore 一次;判轻的按搜索结果", async () => {
  L.resetCostSearch();
  // 本机耗时 = 3 × 共享记录:i ≤ 6 跑得动(21 ms),7 起跑不动
  const local = (clipId) => 3 * (Number(clipId.slice(1)) + 1);
  const { d, log, pushed, restores, f } = deps({ n: 12, local, records: recordsFor(12) });
  const out = await L.runCostSearch(d);
  assert.equal(out.envFingerprint, "f00dfacecafe0001");
  assert.deepEqual([...out.light].sort(), ["k00", "k01", "k02", "k03", "k04", "k05", "k06"]);
  assert.equal(out.result.boundary, 7);
  assert.ok(out.result.measurements <= maxMeasurements(12), `测了 ${out.result.measurements} 次`);
  assert.equal(log[0], "role:back");
  assert.equal(log.at(-1), "role:front");
  assert.equal(log.filter((x) => x.startsWith("role:")).length, 2, "只切两次角色");
  assert.equal(log.filter((x) => x.startsWith("time:")).length, out.result.measurements);
  assert.equal(pushed.at(-1), f.project, "测完整份重灌");
  assert.equal(restores(), 1);
  assert.ok(B > 21 && B < 24);
});

test("LS-02 测量期间遮罩状态带进度,测完 measuring 回到 false", async () => {
  L.resetCostSearch();
  const seen = [];
  const off = L.onCostSearch((s) => seen.push({ ...s }));
  const { d } = deps({ n: 30, local: () => 5, records: recordsFor(30) });
  const out = await L.runCostSearch(d);
  off();
  assert.equal(L.costSearchMeasuring(), false);
  assert.ok(seen.some((s) => s.measuring && s.estimate === maxMeasurements(30)));
  assert.equal(seen.at(-1).measuring, false);
  assert.equal(Math.max(...seen.map((s) => s.done)), out.result.measurements);
  assert.equal(out.light.size, 30, "全都跑得动");
});

test("LS-03 本地复用:第二次打开全命中,一次都不测、不切角色、不 restore", async () => {
  L.resetCostSearch();
  const store = createMemoryCostStore();
  const local = (clipId) => (Number(clipId.slice(1)) < 5 ? 4 : 40);
  const first = deps({ n: 20, local, records: recordsFor(20), store });
  const a = await L.runCostSearch(first.d);
  assert.ok(a.result.measurements > 0);
  const again = deps({ n: 20, local: () => { throw new Error("不该再测"); }, records: recordsFor(20), store });
  const b = await L.runCostSearch(again.d);
  assert.equal(b.result.measurements, 0);
  assert.deepEqual(again.log, [], "舞台一下都没碰");
  assert.equal(again.restores(), 0);
  assert.deepEqual([...b.light].sort(), [...a.light].sort());
});

test("LS-04 本页跑不了的用户卡、素材效果卡不参加按重卡;没有记录的卡逐张实测;direct 卡按随机帧逐帧 setTime(probe)", async () => {
  L.resetCostSearch();
  const extra = [
    { id: "cuser", cardId: "user-card", start: 0, end: 2, params: {} },
    { id: "cnew", cardId: "brand-new", start: 0, end: 2, params: {} },
  ];
  const records = [...recordsFor(4), { identityKey: "kuser", envFingerprint: "aaaaaaaaaaaaaaaa", stepMs: 1, samples: 16, measuredAt: 1, mode: "dev" }];
  const { d, log } = deps({ n: 4, extra, local: () => 5, records, unsupported: (c) => c.cardId === "user-card" });
  d.capabilities.set("c01", { frameMode: "direct" });
  const out = await L.runCostSearch(d);
  assert.deepEqual(out.forcedHeavy, ["kuser"]);
  assert.ok(!out.light.has("kuser"), "用户卡不判轻(即使有记录)");
  assert.ok(out.light.has("knew"), "没有记录的卡逐张实测:本机 5 ms 跑得动,判轻");
  assert.deepEqual(out.result.unrecorded, ["knew"]);
  assert.ok(out.result.measured.has("knew"), "没有记录的卡测了");
  assert.ok(log.includes("time:cnew"), "没有记录的卡在舞台里测了");
  assert.ok(!log.some((x) => x.includes("cuser")), "本页跑不了的用户卡不测");
  assert.ok(out.result.measured.has("k01"), "余量测了 k01");
  assert.ok(log.filter((x) => x.startsWith("probe:c01@")).length >= 8, "direct 卡按随机帧逐帧 setTime(probe),至少 8 帧");
  assert.ok(!log.includes("time:c01"), "direct 卡不走计时趟");
});

test("LS-05 取不到记录抛错、舞台一下都不碰;被项目重灌打断的那一张重来", async () => {
  L.resetCostSearch();
  const { d, log } = deps({ n: 3, local: () => 5, records: [], request: async () => ({ type: "error", reason: "forbidden" }) });
  await assert.rejects(L.runCostSearch(d), /forbidden/);
  assert.deepEqual(log, []);
  // 打断:第一次计时趟回 'project',第二次照常
  const r = deps({ n: 2, local: () => 5, records: recordsFor(2) });
  const stage = r.d.stage();
  const orig = stage.render.bind(stage);
  let first = true;
  stage.render = async (t, o) => { if (first) { first = false; return { aborted: true, reason: "project", elapsedMs: 1 }; } return orig(t, o); };
  const out = await L.runCostSearch(r.d);
  assert.equal(out.light.size, 2, "重来之后测出来了");
});

test("LS-06 测每张卡之前留崩溃记录、测完收;真测出来的写进文档服务,本地复用命中的不写", async () => {
  L.resetCostSearch();
  const store = createMemoryCostStore();
  const marks = [];
  const published = [];
  const local = (clipId) => (Number(clipId.slice(1)) < 3 ? 4 : 40);
  const a = deps({ n: 6, local, records: recordsFor(6), store });
  a.d.beforeMeasure = (key, cardId) => marks.push(["before", key, cardId]);
  a.d.afterMeasure = (key) => marks.push(["after", key]);
  a.d.publish = (records) => { published.push(...records); };
  const out = await L.runCostSearch(a.d);
  const measuredKeys = out.result.trace.filter((t) => !t.cached).map((t) => t.key);
  assert.ok(measuredKeys.length > 0);
  // 每测一张:先 before、后 after,成对,按测的先后
  assert.deepEqual(marks.filter((m) => m[0] === "before").map((m) => m[1]), measuredKeys);
  for (let i = 0; i < marks.length; i += 2) {
    assert.equal(marks[i][0], "before");
    assert.deepEqual(marks[i + 1], ["after", marks[i][1]], "测完那一张就收");
  }
  assert.equal(marks[0][2], `card${Number(measuredKeys[0].slice(1))}`, "带着 cardId(查看口用)");
  assert.deepEqual(published.map((r) => r.identityKey).sort(), [...measuredKeys].sort(), "真测出来的都写进文档服务");
  for (const r of published) {
    assert.equal(typeof r.stepMs, "number");
    assert.ok(r.samples >= 1);
    assert.equal(r.mode, "build");
  }
  // 第二次打开:本地复用全命中,不测、不留崩溃记录、不写
  marks.length = 0;
  published.length = 0;
  const b = deps({ n: 6, local: () => { throw new Error("不该再测"); }, records: recordsFor(6), store });
  b.d.beforeMeasure = (key) => marks.push(["before", key]);
  b.d.publish = (records) => { published.push(...records); };
  await L.runCostSearch(b.d);
  assert.deepEqual(marks, []);
  assert.deepEqual(published, []);
});

test("LS-07 搜完之后加了新卡:没有记录的补测那一张,有记录的按界限判、不测", async () => {
  L.resetCostSearch();
  const local = (clipId) => (clipId === "cfresh" ? 3 : 3 * (Number(clipId.slice(1)) + 1));
  const first = deps({ n: 8, local, records: recordsFor(8) });
  const out = await L.runCostSearch(first.d);
  // 加两张卡:一张有记录(代表耗时 1,落在界限省的一侧),一张没有记录
  const extra = [
    { id: "crec", cardId: "rec-card", start: 0, end: 2, params: {} },
    { id: "cfresh", cardId: "fresh-card", start: 0, end: 2, params: {} },
  ];
  const second = deps({ n: 8, extra, local, records: recordsFor(8) });
  second.f.identityKeys.crec = "krec";
  second.f.identityKeys.cfresh = "kfresh";
  const outcome = { ...out, records: [...out.records, { identityKey: "krec", envFingerprint: "aaaaaaaaaaaaaaaa", stepMs: 1, samples: 16, measuredAt: 1, mode: "dev" }] };
  const marks = [];
  const next = await L.measureNewCards(outcome, { ...second.d, beforeMeasure: (key) => marks.push(key) });
  assert.deepEqual(marks, ["kfresh"], "只补测没有记录的那一张");
  assert.ok(second.log.includes("time:cfresh"));
  assert.ok(!second.log.some((x) => x.includes("crec")), "有记录的不测");
  assert.ok(next.light.has("kfresh"), "补测出来 3 ms,判轻");
  assert.ok(next.light.has("krec"), "有记录、代表耗时落在省的一侧,判轻");
  assert.equal(second.restores(), 1, "补测完照样切回、重灌、restore");
  // 没有要补测的:原样回、舞台不碰
  const again = deps({ n: 8, extra, local: () => { throw new Error("不该测"); }, records: recordsFor(8) });
  again.f.identityKeys.crec = "krec";
  again.f.identityKeys.cfresh = "kfresh";
  const same = await L.measureNewCards(next, again.d);
  assert.equal(same, next);
  assert.deepEqual(again.log, []);
});

test("LS-08 测完以后产稀疏版那一段遮罩照旧挡着:立起带进度,撤下回空", () => {
  const seen = [];
  const off = L.onCostSearch((st) => seen.push({ ...st }));
  L.holdCostSearchMask("punch-pill", 1, 3);
  assert.deepEqual({ ...L.costSearchState() }, { measuring: true, done: 1, estimate: 3, card: "punch-pill" });
  L.releaseCostSearchMask();
  assert.equal(L.costSearchState().measuring, false);
  assert.equal(L.costSearchState().card, null);
  const n = seen.length;
  L.releaseCostSearchMask();
  assert.equal(seen.length, n, "没立着时撤下不再通知");
  off();
});
