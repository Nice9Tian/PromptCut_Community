/**
 * C10 其余第 3 节(界限搜索的完整规则;原「低内存档」,2026-10-22 改为「只有一个舞台时按界限搜索判」与「最低一档」两样)
 * 接进分派与导出:用例 CP-01～CP-06(CP-03 随预渲染重试发布方撤销删掉,见下)。
 *
 *   CP-01 planPipelines 的 searchLight:集合里的卡每个位置都判轻(不受预算挤出),其余(含没有身份的)每个位置都判重
 *   CP-02 planDispatch:按界限搜索判时判定表按它的结果;搜索完成前全部判重、searchJudged 为 false;不是最低一档时显示用的表就是判定的表,
 *         最低一档显示用的表一直全部判重
 *   CP-03 预渲染重试只对判重又缺产物的层:判轻的卡不发
 *   CP-04 导出:按判定的表只核对、只取判重卡的预渲染原尺寸,判轻的卡(层表里有也)本机渲
 *   CP-05 桌面不受影响:两样开关都关时判定表就是显示表,planPipelines 不给新选项时结果与原来逐字段相同
 *   CP-06 searchLight 与 allHeavy 同时给:allHeavy 优先(显示用)
 *
 * 跑:node --experimental-test-module-mocks --test src/render/c10-cost-plan.test.mjs
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

test("CP-01 searchLight:判轻的卡在每个位置都判轻(同时 40 张也不挤出),其余与没有身份的每个位置都判重", () => {
  const clips = Array.from({ length: 40 }, (_, i) => ({ id: `c${String(i).padStart(2, "0")}`, start: 0, end: 5 }));
  clips.push({ id: "noid", start: 1, end: 3 });
  const identityKeys = Object.fromEntries(clips.filter((c) => c.id !== "noid").map((c) => [c.id, `key-${c.id}`]));
  const lightKeys = new Set(clips.filter((_, i) => i % 2 === 0 && i < 40).map((c) => `key-${c.id}`));
  const plan = planPipelines(project(clips), [], FPS, { identityKeys, searchLight: lightKeys });
  for (const c of clips) {
    const isLight = lightKeys.has(identityKeys[c.id]);
    for (let t = c.start; t < c.end; t += 0.5) assert.equal(pipelineAt(plan, c.id, t), isLight ? "light" : "heavy", `${c.id} @ ${t}`);
    assert.equal(plan.prerenderSet.has(c.id), !isLight, c.id);
  }
  assert.ok(plan.prerenderSet.has("noid"), "没有身份的卡判重");
});

test("CP-02 planDispatch:判定表按搜索结果;搜索完成前全部判重、searchJudged=false;最低一档显示表一直全部判重", async () => {
  mock.module(srcUrl("editor/stageBridge.ts"), { exports: { frontStage: () => null, backStage: () => null } });
  mock.module(srcUrl("editor/costIdentity.ts"), { exports: { clipIdentityOf: () => ({ identityKeys: { a: "ka", b: "kb", c: "kc" }, frameModes: { a: "direct", b: "direct", c: "direct" } }) } });
  // 夹具里的卡要在注册表里有定义:两边都没有定义的「未知卡片」不进分派表(2026-09-29 起,舞台不画它们)
  (await import(srcUrl("kernel/registry.ts"))).registerCards(["a", "b", "c"].map((id) => ({ id: `card-${id}`, name: id, defaults: {}, controls: [], frameMode: "direct", Component: () => null })));
  const d = await import(srcUrl("editor/planDispatch.ts"));
  d.resetPlanDispatch();
  const settle = () => new Promise((r) => queueMicrotask(r));
  d.setPlanProject(project([{ id: "a", start: 0, end: 2 }, { id: "b", start: 0, end: 2 }, { id: "c", start: 1, end: 3 }]));
  await settle();
  assert.equal(d.searchJudged(), true, "不按界限搜索判时恒为 true");
  assert.equal(d.judgedPlan(), d.currentPlan(), "两样开关都关:两张表是同一张");
  d.setPlanSearch(true);
  await settle();
  assert.equal(d.planSearch(), true);
  assert.equal(d.searchJudged(), false, "搜索还没做完");
  assert.deepEqual([...d.judgedPlan().prerenderSet], ["a", "b", "c"], "没有结果时判定表全部判重");
  d.setPlanSearchLight(["ka", "kc"]);
  assert.equal(d.searchJudged(), true);
  assert.deepEqual([...d.judgedPlan().prerenderSet], ["b"], "判定表按搜索结果(同步重算)");
  assert.equal(pipelineAt(d.judgedPlan(), "a", 1), "light");
  await settle();
  assert.equal(d.currentPlan(), d.judgedPlan(), "精简模式:显示用的表就是判定的表(判轻的照常活渲)");
  d.setPlanLowest(true);
  await settle();
  assert.deepEqual([...d.currentPlan().prerenderSet], ["a", "b", "c"], "最低一档:显示用的表全部判重");
  assert.deepEqual([...d.judgedPlan().prerenderSet], ["b"], "判定的表不变");
  assert.deepEqual([...d.planSearchLight()].sort(), ["ka", "kc"]);
  d.setPlanLowest(false);
  d.setPlanSearch(false);
  await settle();
  assert.equal(d.planSearchLight(), null, "不按界限搜索判了:丢掉结果");
  assert.equal(d.judgedPlan(), d.currentPlan());
  d.resetPlanDispatch();
});

/*
 * CP-03(预渲染重试只对判重又缺产物的层)删了:`lowMemoryBackfill.ts` 随「为弱设备预渲染任务」撤销(2026-10-07 用户定,在线页面发布的任务
 * 一律普通优先级),只有一个舞台的页面与别的页面一样发清单计划,清单就是判定的表里判重的片段(`Preview.tsx` 的 `heavyCardClips`)。
 */

const O = await import(srcUrl("export/originals.ts"));

test("CP-04 导出:按判定的表只核对、只取判重卡的预渲染原尺寸;判轻的卡层表里有也本机渲", async () => {
  const H = "a".repeat(64);
  const map = { kind: "layer-map", projectId: "proj", fps: 30, v: 2, span: 4, layers: [
    { clipId: "heavyCard", kind: "html", key: "k-h", resultKey: "rk-h", firstFrame: 0, count: 4, contentKey: "ck-h", envFingerprint: "0123456789abcdef" },
    { clipId: "lightCard", kind: "html", key: "k-l", resultKey: "rk-l", firstFrame: 0, count: 4, contentKey: "ck-l", envFingerprint: "0123456789abcdef" },
  ] };
  const request = async (msg) => {
    if (msg.key === "layers:proj") return { type: "content.item", body: map };
    if (msg.key === "rk-h:0-3") return { type: "content.item", body: { frames: [[0, H], [1, H], [2, H], [3, H]] } };
    return { type: "content.item", missing: true }; // 判轻的卡原尺寸缺
  };
  const deps = { request, assetBase: () => "http://x/api/asset", authHeaders: async () => ({}) };
  const normal = await O.loadOriginalsIndex("proj", deps);
  assert.deepEqual(normal.missing, ["lightCard"], "不给判定的表:层表里的都算重卡,缺了要等");
  const low = await O.loadOriginalsIndex("proj", deps, { onlyClips: ["heavyCard"] });
  assert.deepEqual(low.missing, [], "按判定的表:判轻的卡不核对");
  assert.equal(low.hashAt("heavyCard", 2), H);
  assert.equal(low.hashAt("lightCard", 2), undefined, "判轻的卡不取原尺寸(本机渲)");
  const noMap = await O.loadOriginalsIndex(null, deps, { fallbackHeavy: ["heavyCard", "lightCard"], onlyClips: ["heavyCard"] });
  assert.deepEqual(noMap.missing, ["heavyCard"]);
});

test("CP-05 桌面不受影响:不给新选项时 planPipelines 的结果与原来逐字段相同(同一份输入跑两遍、对照 allHeavy 以外的路径)", () => {
  const clips = [{ id: "a", start: 0, end: 4 }, { id: "b", start: 1, end: 3 }, { id: "c", start: 2, end: 6 }];
  const costs = [
    { identityKey: "ka", fps: FPS, device: "d", stepMs: 3, kind: "random", catchUpMs: 0 },
    { identityKey: "kb", fps: FPS, device: "d", stepMs: 30, kind: "random", catchUpMs: 0 },
  ];
  const opts = { identityKeys: { a: "ka", b: "kb", c: "kc" }, frameModes: { a: "direct", b: "direct", c: "stateful" } };
  const x = planPipelines(project(clips), costs, FPS, opts);
  const y = planPipelines(project(clips), costs, FPS, { ...opts, searchLight: null });
  const wire = (p) => JSON.stringify({ s: p.segments.map((g) => [g.fromSec, g.toSec, [...g.heavy], [...g.light]]), set: [...p.prerenderSet] });
  assert.equal(wire(x), wire(y));
  assert.deepEqual([...x.prerenderSet], ["b", "c"], "b 实测超预算、c 没记录且声明 stateful");
});

test("CP-06 searchLight 与 allHeavy 同时给:allHeavy 优先", () => {
  const plan = planPipelines(project([{ id: "a", start: 0, end: 1 }]), [], FPS, { identityKeys: { a: "ka" }, searchLight: ["ka"], allHeavy: true });
  assert.deepEqual([...plan.prerenderSet], ["a"]);
});

test("CP-07 即时渲染闸门:测崩过的卡直接当重卡(有记录的钉死为重,没有记录的补一条),按界限搜索判时也从判轻里去掉", async () => {
  const d = await import(srcUrl("editor/planDispatch.ts"));
  d.resetPlanDispatch();
  const settle = () => new Promise((r) => queueMicrotask(r));
  d.setPlanProject(project([{ id: "a", start: 0, end: 2 }, { id: "b", start: 0, end: 2 }, { id: "c", start: 1, end: 3 }]));
  await settle();
  assert.deepEqual([...d.currentPlan().prerenderSet], [], "声明 direct 的三张都判轻");
  d.setPlanForcedHeavy(["kb"]);
  await settle();
  assert.deepEqual([...d.currentPlan().prerenderSet], ["b"], "测崩过的 b 当重卡");
  d.setPlanSearch(true);
  d.setPlanSearchLight(["ka", "kb", "kc"]);
  await settle();
  assert.deepEqual([...d.judgedPlan().prerenderSet], ["b"], "界限搜索判它轻也照样当重卡");
  d.setPlanForcedHeavy([]);
  d.resetPlanDispatch();
});
