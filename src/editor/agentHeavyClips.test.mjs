/**
 * 云端 Agent 发布预渲染之前的轻重判定(`agentHeavyClips.ts`;语义 `product/agent.md`「发出任务后可以离开」:托管方只为被改动的重卡产流)。
 * 跑:node --experimental-test-module-mocks --test src/editor/agentHeavyClips.test.mjs
 *
 *   JH-01 有共享成本记录:单帧耗时在预算内的判轻(不发),超出预算的判重(发);同一张卡几条记录取中位数
 *   JH-02 没有记录:按页面测完之前的兜底 —— 声明 `direct` 的判轻,其余判重;服务端注册表里没有定义的卡判重(照原来发)
 *   JH-03 剪辑段里的卡(虚拟片段 `<段 id>~<片段 id>`)与顶层的卡同一条规则;同一张卡的记录对各实例都管用
 *   JH-04 不在项目里的候选(写入之后又删了)两边都不放;候选顺序保持
 *   JH-05 与页面的分派表同一份:结果就是 `planPipelines` 的预渲染集合与候选的交集(同一位置挤不下时判重)
 *   JH-06 改过参数的卡(新身份没有记录):同一张卡别的身份有记录就按那些记录估(中位数),轻的不发;
 *         之前的身份可以来自此刻项目里同一张卡的别的片段,也可以来自调用方记下的改之前的项目(`cardIdentityGroups` → `opts.sameCard`)
 *   JH-07 同一张卡一条记录都没有:照原来的兜底(stateful 判重、direct 判轻);别的卡的记录不借;源码版本不同不算同一张卡
 */
import { srcUrl } from "../testing/registerTs.mjs";
import { test, mock } from "node:test";
import assert from "node:assert/strict";

globalThis.window = globalThis;
globalThis.document = {};

mock.module(srcUrl("render/cardSourceFiles.mjs"), { exports: { builtinCardSourceFiles: {}, cardSourceFilesVersion: () => 0 } });
mock.module(srcUrl("render/cardSourceVersion.mjs"), { exports: { cardSourceVersion: (card) => `v-${card.id}` } });

const R = await import(srcUrl("kernel/registry.ts"));
const CI = await import(srcUrl("editor/costIdentity.ts"));
const P = await import(srcUrl("render/pipelinePlan.mjs"));
const J = await import(srcUrl("editor/agentHeavyClips.ts"));

const def = (id, frameMode) => ({ id, name: id, defaults: { text: "" }, controls: [], frameMode, Component: () => null });
R.registerCards([def("stateful-card", "stateful"), def("direct-card", "direct")]);

const FPS = 30;
const B = P.budgetOf(FPS); // 23.33 ms
const card = (id, cardId, start, end, params = {}) => ({ id, cardId, start, end, params: { text: id, ...params } });
const seg = (id, cutId, start, end) => ({ id, cardId: "", cutId, start, end });

function project(clips, cuts = []) {
  return { version: 1, id: "p", name: "p", width: 1280, height: 720, fps: FPS, duration: 60, themeId: "midnight", media: [], activeCutId: "A",
    tracks: [{ id: "t", name: "t", clips }], ...(cuts.length ? { cuts: [{ id: "A", name: "剪辑1" }, ...cuts] } : {}) };
}

/** 这个项目里某个片段的成本身份(与判定用的是同一份 `clipIdentityOf`) */
const keyOf = (p, clipId) => CI.clipIdentityOf(p).identityKeys[clipId];
/** 只看判重、判轻两边(JH-01～05 写在 `estimated` 加进来之前) */
const judgeHL = (...args) => { const { heavy, light } = J.judgeHeavyClips(...args); return { heavy, light }; };
const rec = (identityKey, stepMs, env = "0000000000000001") => ({ identityKey, envFingerprint: env, stepMs, samples: 30, measuredAt: 1, mode: "build" });

test("JH-01 有记录:预算内的判轻、超出的判重;多条取中位数", () => {
  CI.resetClipIdentityCache();
  const p = project([card("light", "stateful-card", 0, 4), card("heavy", "stateful-card", 5, 9, { size: 2 })]);
  const kl = keyOf(p, "light"), kh = keyOf(p, "heavy");
  assert.ok(kl && kh && kl !== kh, "两张卡各有身份");
  // 粒子卡在线上实测约 2 ms/帧(轻);另一张 40 ms/帧(超出 B = 23.3 ms)
  const r = judgeHL(p, [rec(kl, 2.3), rec(kh, 40)], ["light", "heavy"]);
  assert.deepEqual(r, { heavy: ["heavy"], light: ["light"] });
  // 同一张卡几台机器测的:取中位数(1、2、60 → 2,轻;30、30、1 → 30,重)
  const multi = judgeHL(p, [rec(kl, 1, "a000000000000001"), rec(kl, 2, "a000000000000002"), rec(kl, 60, "a000000000000003"),
    rec(kh, 30, "a000000000000001"), rec(kh, 30, "a000000000000002"), rec(kh, 1, "a000000000000003")], ["light", "heavy"]);
  assert.deepEqual(multi, { heavy: ["heavy"], light: ["light"] });
  assert.ok(B > 2.3 && B < 30);
});

test("JH-02 没有记录:direct 判轻,其余判重;注册表里没有的卡判重", () => {
  CI.resetClipIdentityCache();
  const p = project([card("s", "stateful-card", 0, 4), card("d", "direct-card", 0, 4), card("u", "not-registered-card", 0, 4)]);
  const r = judgeHL(p, [], ["s", "d", "u"]);
  assert.deepEqual(r, { heavy: ["s", "u"], light: ["d"] });
  // 记录到了(在线成员的页面测完写进来)就按记录:stateful 的那张实测很轻 → 不发
  const r2 = judgeHL(p, [rec(keyOf(p, "s"), 2)], ["s", "d", "u"]);
  assert.deepEqual(r2, { heavy: ["u"], light: ["s", "d"] });
});

test("JH-03 剪辑段里的卡与顶层同一条规则;同一张卡的记录对两个实例都管用", () => {
  CI.resetClipIdentityCache();
  const inner = [card("X", "stateful-card", 0, 4), card("Y", "stateful-card", 4, 8, { size: 3 })];
  const p = project([seg("S", "B", 0, 8), seg("S2", "B", 10, 18)], [{ id: "B", name: "剪辑2", duration: 8, tracks: [{ id: "b1", name: "b1", clips: inner }] }]);
  const kx = keyOf(p, "S~X"), ky = keyOf(p, "S~Y");
  assert.ok(kx && ky, "剪辑段里的卡按虚拟片段给身份");
  assert.equal(keyOf(p, "S2~X"), kx, "成本键剥掉 flat:同一张卡在两个实例同一个键");
  const candidates = ["S~X", "S~Y", "S2~X", "S2~Y"];
  assert.deepEqual(judgeHL(p, [rec(kx, 2), rec(ky, 50)], candidates), { heavy: ["S~Y", "S2~Y"], light: ["S~X", "S2~X"] });
  assert.deepEqual(judgeHL(p, [], candidates), { heavy: candidates, light: [] }, "没有记录的 stateful 卡判重");
});

test("JH-04 不在项目里的候选两边都不放;顺序保持", () => {
  CI.resetClipIdentityCache();
  const p = project([card("a", "stateful-card", 0, 4), card("b", "stateful-card", 0, 4, { k: 1 })]);
  assert.deepEqual(judgeHL(p, [], ["b", "gone", "a"]), { heavy: ["b", "a"], light: [] });
  assert.deepEqual(judgeHL(null, [], ["a"]), { heavy: [], light: [] });
  assert.deepEqual(judgeHL(p, null, []), { heavy: [], light: [] });
});

test("JH-05 与页面的分派同一份:同一位置几张轻卡挤不下预算时,挤出去的判重", () => {
  CI.resetClipIdentityCache();
  // 四张卡同一位置,各 8 ms:贪心装三张就超(8×3 = 24 > 23.3 再加重卡的换帧成本),挤出去的那张判重
  const clips = ["c1", "c2", "c3", "c4"].map((id, i) => card(id, "stateful-card", 0, 4, { i }));
  const p = project(clips);
  const records = clips.map((c) => rec(keyOf(p, c.id), 8));
  const r = judgeHL(p, records, clips.map((c) => c.id));
  const ids = CI.clipIdentityOf(p);
  const plan = P.planPipelines(p, records.map((x) => ({ identityKey: x.identityKey, stepMs: x.stepMs })), FPS, { identityKeys: ids.identityKeys, frameModes: ids.frameModes });
  assert.ok(r.heavy.length >= 1 && r.light.length >= 1, JSON.stringify(r));
  for (const id of r.heavy) assert.ok(plan.prerenderSet.has(id), `${id} 在页面那张表里也判重`);
});

test("JH-06 改过参数、新身份没有记录:按同一张卡别的身份的记录估,轻的不发", () => {
  CI.resetClipIdentityCache();
  // 改之前:粒子卡一样的 stateful 卡,页面测过约 2 ms/帧(线上 particles 的样子)
  const before = project([card("p", "stateful-card", 0, 4, { count: 100 })]);
  const kOld = keyOf(before, "p");
  const groups = J.cardIdentityGroups(before);
  assert.deepEqual(Object.values(groups), [[kOld]], "改之前的项目:这张卡一个身份");
  // Agent 改了参数:身份换了,新身份没有记录
  const after = project([card("p", "stateful-card", 0, 4, { count: 120 })]);
  const kNew = keyOf(after, "p");
  assert.notEqual(kNew, kOld, "改参数换成本身份");
  const records = [rec(kOld, 1.8, "a000000000000001"), rec(kOld, 2.2, "a000000000000002"), rec(kOld, 90, "a000000000000003")];
  // 不给改之前的身份:同一张卡在此刻项目里没有别的身份 → 照原来的兜底判重
  assert.deepEqual(J.judgeHeavyClips(after, records, ["p"]), { heavy: ["p"], light: [], estimated: [] });
  // 给了(调用方开工时记下的):按那三条记录的中位数 2.2 ms 估 → 轻,不发;估出来的列在 estimated
  assert.deepEqual(J.judgeHeavyClips(after, records, ["p"], { sameCard: groups }), { heavy: [], light: ["p"], estimated: ["p"] });
  // 同一张卡改之前测得很重(40 ms) → 估出来也重,照发
  assert.deepEqual(J.judgeHeavyClips(after, [rec(kOld, 40)], ["p"], { sameCard: groups }), { heavy: ["p"], light: [], estimated: ["p"] });
  // 新身份自己的记录到了:按它自己的,不再估
  assert.deepEqual(J.judgeHeavyClips(after, [...records, rec(kNew, 50)], ["p"], { sameCard: groups }), { heavy: ["p"], light: [], estimated: [] });
  // 此刻项目里同一张卡的别的片段有记录(参数、长度都不同):不用 sameCard 也估得出
  CI.resetClipIdentityCache();
  const both = project([card("p", "stateful-card", 0, 4, { count: 120 }), card("q", "stateful-card", 5, 12, { count: 7 })]);
  const kq = keyOf(both, "q");
  assert.deepEqual(J.judgeHeavyClips(both, [rec(kq, 3)], ["p"]), { heavy: [], light: ["p"], estimated: ["p"] });
});

test("JH-07 同一张卡一条记录都没有:照原来的兜底;别的卡的记录不借;源码版本不同不算同一张卡", () => {
  CI.resetClipIdentityCache();
  const p = project([card("s", "stateful-card", 0, 4), card("d", "direct-card", 5, 9)]);
  // 只有 direct 卡的记录:stateful 卡不借它的,照兜底判重
  assert.deepEqual(J.judgeHeavyClips(p, [rec(keyOf(p, "d"), 1)], ["s"]), { heavy: ["s"], light: [], estimated: [] });
  // 没有任何记录:stateful 判重、direct 判轻(和 JH-02 一样)
  assert.deepEqual(J.judgeHeavyClips(p, [], ["s", "d"]), { heavy: ["s"], light: ["d"], estimated: [] });
  // 调用方记下的身份挂在别的「同一张卡」键下(例如源码版本变了的旧身份):不算同一张卡,不借
  const ghost = "ghost-identity";
  assert.deepEqual(J.judgeHeavyClips(p, [rec(ghost, 1)], ["s"], { sameCard: { "stateful-card v-old": [ghost] } }),
    { heavy: ["s"], light: [], estimated: [] });
});
