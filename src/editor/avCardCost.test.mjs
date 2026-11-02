/**
 * 有声动效卡(画面是组件、另写了 `audio()`,如 `av-pulse`)的画面成本身份(2026-10-06 用户定:自动、即时补测,不默认判重)。
 * 跑:node --experimental-test-module-mocks --test src/editor/avCardCost.test.mjs
 *
 *   AVC-01 `clipCostNodes` / `clipCostIndex`:片段自己的素材效果卡节点只在调用方说算时才当成本身份节点;键与预渲染进程按输出节点算的
 *          `costKey` 相同;图里的节点不动(不写 `clipId`,预渲染结果的键不变);不给 `ownNode` 与以前逐字相同
 *   AVC-02 `clipIdentityOf`:有声动效卡(就地合成的节点、物化过的节点)有身份、有声明的帧模式、有能力表;桌面与在线双舞台都如此;
 *          画面由 `card()` 出的素材效果卡、只有 `audio()` 的音频素材效果卡照旧没有
 *   AVC-03 分派:没有成本记录时按声明兜底(`direct` 判轻;别的在测完之前判重),记录到了按记录判 —— 判轻就不在预渲染集合里
 *   AVC-04 测量:有声动效卡第一次出现就测一次(只测这一张),测量期间不调它的 `audio()`;记录写进去之后分派表判轻;
 *          重开(记录还在)不重测
 *   AVC-05 卡片图里有悬空输入(摊图会抛):普通卡与有声动效卡照样有身份、照样测,键与图没坏时相同
 */
import { srcUrl } from "../testing/registerTs.mjs";
import { registerHooks } from "node:module";
import { test, mock, after } from "node:test";
import assert from "node:assert/strict";

globalThis.window = globalThis;
globalThis.document = { documentElement: {} };

const runnerUrl = srcUrl("editor/probeRunner.ts");
const hook = registerHooks({ load(url, context, next) {
  const loaded = next(url, context);
  if (url !== runnerUrl) return loaded;
  const source = typeof loaded.source === "string" ? loaded.source : Buffer.from(loaded.source ?? []).toString("utf8");
  return { ...loaded, source: source.replaceAll("import.meta.env.DEV", "true") };
} });
after(() => hook.deregister());

/** 后台舞台的替身:每推一次缩水项目记一笔;`setTime` 回一个很小的耗时(判轻) */
const pushed = [];
let stepMs = 1;
const stage = { setTime: async () => ({ stepMs, snapshot: { inlineMs: 0.1, rasterMs: 0.1, serializeMs: 0.1 } }),
  render: async () => ({ steps: Array.from({ length: 30 }, () => stepMs), snapshotSteps: [], booleans: { vtOk: true, seekOk: true, seekMs: stepMs } }) };
mock.module(srcUrl("editor/stageBridge.ts"), { exports: {
  frontStage: () => null, backStage: () => stage, onStageEvent: () => () => {}, pushProject: async (_role, project) => { pushed.push(project); },
  stageCapabilities: () => ({}), whenStageReady: async () => stage,
} });
mock.module(srcUrl("editor/stageJobs.ts"), { exports: {
  MAX_PROJECT_RESENDS: 1, currentBackJob: () => null, renderAbortAction: () => "error",
  runBackJob: async (_kind, fn) => fn({ stage, signal: { aborted: false } }),
} });
mock.module(srcUrl("render/costDevice.mjs"), { exports: { costDeviceString: () => "test-device", readGpuRenderer: () => "test-gpu", resolveGlRoute: () => "test-route" } });
mock.module(srcUrl("render/dataMirror.ts"), { exports: { mirrorKey: () => ({ session: "test", localRev: 0 }) } });
mock.module(srcUrl("editor/measureGate.ts"), { exports: { measureGateOpen: () => true, whenMeasureGateOpen: async () => {} } });
mock.module(srcUrl("render/cardSourceFiles.mjs"), { exports: { builtinCardSourceFiles: {}, cardSourceFilesVersion: () => 0 } });
mock.module(srcUrl("render/cardSourceVersion.mjs"), { exports: { cardSourceVersion: (card) => `v-${card.id}` } });

const R = await import(srcUrl("kernel/registry.ts"));
const H = await import(srcUrl("render/placeholderHost.ts"));
const G = await import(srcUrl("kernel/cardGraph.mjs"));
const P = await import(srcUrl("render/pipelinePlan.mjs"));
const K = await import(srcUrl("render/cardCostKey.mjs"));
const CI = await import(srcUrl("editor/costIdentity.ts"));
const D = await import(srcUrl("editor/planDispatch.ts"));
const PR = await import(runnerUrl);

const FPS = 30;
let audioCalls = 0;
const audio = () => { audioCalls++; return new Float32Array(2); };
const base = (id, extra = {}) => ({ id, name: `Name-${id}`, source: "native", defaults: { n: 1 }, controls: [], kind: "animation", inputs: {}, ...extra });
/** 形状照 `src/cards/native/av-pulse.tsx`:画面组件加 `audio()`,声明 `direct` */
const avDirect = base("av-direct", { frameMode: "direct", Component: () => null, audio });
/** 没声明 `direct` 的有声动效卡:没有记录时按声明是重卡,要靠测量才判得了轻 */
const avStateful = base("av-stateful", { Component: () => null, audio });
const plain = base("plain", { Component: () => null });
/** 画面由 `card()` 出的素材效果卡(带声音)、只有 `audio()` 的音频素材效果卡 */
const gpuCard = base("gpu-card", { frameMode: "direct", card: () => ({}), audio });
const audioOnly = base("audio-only", { kind: "audio", audio });

function setup() {
  R.resetCards();
  R.registerCards([avDirect, avStateful, plain, gpuCard, audioOnly]);
  R.setSyncedUserCards([]);
  H.setOnlineBrowserMode(false);
  CI.resetClipIdentityCache();
  D.resetPlanDispatch();
  PR.resetProbeRunner();
  pushed.length = 0;
  audioCalls = 0;
  stepMs = 1;
}
const clip = (id, cardId, start, end, extra = {}) => ({ id, cardId, start, end, params: {}, ...extra });
const project = (extra = {}) => ({ version: 1, id: "p", name: "p", width: 1920, height: 1080, fps: FPS, duration: 12, media: [],
  tracks: [{ id: "t", name: "t", clips: [
    clip("a", "av-direct", 0, 2), clip("s", "av-stateful", 2, 4), clip("p", "plain", 4, 6),
    clip("g", "gpu-card", 6, 8), clip("o", "audio-only", 8, 10),
    // 物化过的有声动效卡:片段指着 cardNodes 里的真节点
    clip("m", "av-stateful", 10, 12, { nodeId: "n-m" }),
  ] }],
  cardNodes: [{ id: "n-m", adapter: "card", cardId: "av-stateful", kind: "animation", embeddedAudio: true, timeOffset: 0, inputs: {}, params: { n: 1 } }],
  ...extra });
const settle = () => new Promise((r) => setTimeout(r, 0));
async function until(check, what) {
  for (let i = 0; i < 400; i++) { if (check()) return; await new Promise((r) => setTimeout(r, 5)); }
  assert.fail(`Timed out waiting for: ${what}`);
}
const memoryBackend = (records) => ({ forwardFrames: false,
  load: async () => ({ costs: [...records], tuning: { COST_SCALE: 1, STEP_PERCENTILE: 0.9, STEP_MIN_SAMPLES: 16 } }),
  save: async (next) => { records.push(...next); return true; } });

test("AVC-01 clipCostNodes / clipCostIndex: a clip's own media effect card node counts only when the caller says to count it; the key matches the prerender process's costKey; nodes are left untouched", () => {
  setup();
  const p = project();
  const graph = G.projectCardGraph(p, R.getCard);
  const before = JSON.stringify(graph.nodes);
  const own = { ownNode: (node) => node.cardId === "av-direct" || node.cardId === "av-stateful" };
  const nodes = P.clipCostNodes(p, graph, own);
  assert.equal(nodes.get("a")?.id, "@clip/a/card", "A node synthesized in place");
  assert.equal(nodes.get("m")?.id, "n-m", "A materialized node (the one clip.nodeId points to)");
  assert.equal(nodes.get("p")?.id, "@clip/p/source", "A regular card is still a base node carrying clipId");
  assert.equal(nodes.has("g"), false, "What the caller did not ask to count is not counted");
  assert.equal(JSON.stringify(graph.nodes), before, "Nodes in the graph are not touched at all");
  assert.ok(graph.nodes.filter((n) => n.adapter === "card").every((n) => n.clipId === undefined), "clipId is not written on media effect card nodes (the prerender output key is unchanged)");

  const version = (node) => `builtin:v-${node.cardId}`;
  const index = P.clipCostIndex(p, graph, version, own);
  // 预渲染进程那一端(`server/card-cache.mjs`):按**输出节点**算 costKey
  for (const id of ["a", "s", "m"]) {
    const out = graph.outputs.find((o) => o.clipId === id);
    const node = graph.nodes.find((n) => n.id === out.nodeId);
    assert.equal(index.identityKeys[id], K.cardCostKey(node, version(node), FPS, 60), `The key of ${id} matches the one on the prerender process side`);
  }
  assert.equal(index.frameModes.a, "direct");
  assert.equal(index.frameModes.s, "stateful");

  // 不给 ownNode:与以前逐字相同(只认带 clipId 的节点)
  const old = P.clipCostIndex(p, graph, version);
  assert.deepEqual(Object.keys(old.identityKeys).sort(), ["p"]);
  assert.equal(old.identityKeys.p, index.identityKeys.p, "The key of a regular card is unaffected");
});

test("AVC-02 clipIdentityOf: an audio motion card has an identity, frame mode and capabilities table (both the desktop and online stages); card() media effect cards and audio media effect cards still have none", () => {
  setup();
  const p = project();
  try {
    for (const online of [false, true]) {
      H.setOnlineBrowserMode(online);
      const id = CI.clipIdentityOf(p);
      const where = online ? "online" : "Desktop";
      for (const c of ["a", "s", "m", "p"]) assert.equal(typeof id.identityKeys[c], "string", `${where}: ${c} has an identity`);
      assert.equal(id.frameModes.a, "direct", `${where}: declared frame mode`);
      assert.equal(id.frameModes.s, "stateful");
      assert.equal(id.capabilities.get("a")?.frameMode, "direct", `${where}: capabilities table (measurement uses it to decide between sampling and frame push)`);
      assert.ok(id.capabilities.has("m"));
      for (const c of ["g", "o"]) {
        assert.equal(id.identityKeys[c], undefined, `${where}: ${c} has no identity (a media effect card's input cannot be obtained in the reduced project used for measurement / an audio media effect card has no visuals)`);
        assert.equal(id.frameModes[c], undefined);
      }
      assert.notEqual(id.identityKeys.a, id.identityKeys.s, "Different cards have different keys");
    }
  } finally { H.setOnlineBrowserMode(false); }
});

test("AVC-03 Dispatch: with no record, fall back to the declaration; once a record arrives, judge by the record; cards classified as light are not in the prerender set", async () => {
  setup();
  const p = project();
  D.setPlanProject(p);
  await settle();
  const at = (plan, id, t) => P.pipelineAt(plan, id, t);
  let plan = D.currentPlan();
  assert.equal(at(plan, "a", 1), "light", "An audio motion card declared direct: classified as light even with no record (previously it had no identity and no frame mode, and was classified as heavy)");
  assert.equal(plan.prerenderSet.has("a"), false);
  assert.equal(at(plan, "s", 3), "heavy", "One not declared direct: falls back to the declaration until measurement finishes (same rule as other cards)");
  // 测量写进一条很轻的记录
  const keys = CI.clipIdentityOf(p).identityKeys;
  const light = (identityKey) => ({ identityKey, device: "test-device", fps: FPS, kind: "stepped", stepMs: 1, catchUpMs: 5, seekOk: true, seekMs: 1, demoted: false });
  D.mergePlanCosts([light(keys.s)]);
  await settle();
  plan = D.currentPlan();
  assert.equal(at(plan, "s", 3), "light", "Record arrived: classified as light, live render");
  assert.equal(plan.prerenderSet.has("s"), false, "Not in the prerender set (does not wait for prerender)");
  // 同一张卡的另一个片段(物化过的)时长相同、参数相同 → 同一个键,一起判轻
  assert.equal(keys.m, keys.s);
  assert.equal(at(plan, "m", 11), "light");
  // 素材效果卡照旧按重
  assert.equal(at(plan, "g", 7), "heavy");
});

test("AVC-04 Measurement: measure on first appearance, only once, without calling audio(); classified as light once measured; no re-measure on reopen", async () => {
  setup();
  const records = [];
  PR.setCostBackend(memoryBackend(records));
  try {
    // 先只有普通卡,测完
    const p0 = project();
    p0.tracks[0].clips = p0.tracks[0].clips.filter((c) => c.id === "p");
    p0.cardNodes = [];
    D.setPlanProject(p0);
    PR.syncProbeRun(p0);
    await until(() => PR.probeSettledFor(p0), "First measurement round finished");
    assert.deepEqual(PR.probeRunDiag().probed.map((e) => e.cardId), ["plain"]);

    // 有声动效卡第一次出现
    const p1 = { ...p0, tracks: [{ ...p0.tracks[0], clips: [...p0.tracks[0].clips, clip("a", "av-direct", 0, 2), clip("s", "av-stateful", 2, 4)] }] };
    pushed.length = 0;
    D.setPlanProject(p1);
    PR.syncProbeRun(p1);
    await until(() => PR.probeSettledFor(p1), "Audio motion card measurement finished");
    const probed = PR.probeRunDiag().probed.map((e) => e.cardId);
    assert.deepEqual(probed, ["plain", "av-direct", "av-stateful"], "Only the two new arrivals are measured additionally, once each");
    assert.deepEqual(pushed.map((q) => q.tracks[0].clips.map((c) => c.cardId).join()), ["av-direct", "av-stateful"], "Each measured with a reduced project that keeps only that one clip");
    assert.equal(audioCalls, 0, "audio() is not called during measurement (visual measurement does not synthesize sound)");
    const keys = CI.clipIdentityOf(p1).identityKeys;
    assert.ok(records.some((r) => r.identityKey === keys.a) && records.some((r) => r.identityKey === keys.s), "Cost records were written under their identity keys");
    await settle();
    const plan = D.currentPlan();
    for (const [id, t] of [["a", 1], ["s", 3]]) {
      assert.equal(P.pipelineAt(plan, id, t), "light", `${id} classified as light once measured, live render`);
      assert.equal(plan.prerenderSet.has(id), false, `${id} is not in the prerender set`);
    }

    // 重开:记录还在(同一份存放处),一张都不重测
    PR.resetProbeRunner();
    CI.resetClipIdentityCache();
    PR.setCostBackend(memoryBackend(records));
    const before = records.length;
    const reopened = structuredClone({ ...p1, tracks: p1.tracks });
    PR.syncProbeRun(reopened);
    await until(() => PR.probeSettledFor(reopened), "The round after reopening finished");
    assert.deepEqual(PR.probeRunDiag().probed, [], "No re-measure on reopen");
    assert.equal(records.length, before);
    assert.equal(audioCalls, 0);
  } finally { PR.setCostBackend(null); }
});

test("AVC-05 The card graph has a dangling input: regular cards and audio motion cards still get an identity and are still measured", async () => {
  setup();
  const good = project();
  const goodKeys = CI.clipIdentityOf(good).identityKeys;
  // 一个指向不存在节点的素材效果卡节点:完整的图摊不出来
  const broken = project({ cardNodes: [...good.cardNodes, { id: "dangling", adapter: "card", cardId: "gpu-card", inputs: { source: { nodeId: "gone" } }, params: {} }] });
  assert.throws(() => G.projectCardGraph(broken, R.getCard), "Building the complete graph throws");
  CI.resetClipIdentityCache();
  const id = CI.clipIdentityOf(broken);
  for (const c of ["a", "s", "p"]) assert.equal(id.identityKeys[c], goodKeys[c], `${c}: the key matches the one from when the graph was not broken`);
  assert.equal(typeof id.identityKeys.m, "string", "A materialized segment falls back to being expanded by the clip's own card and also has an identity");
  assert.equal(id.identityKeys.g, undefined);

  const records = [];
  PR.setCostBackend(memoryBackend(records));
  try {
    PR.syncProbeRun(broken);
    await until(() => PR.probeSettledFor(broken), "The project with the broken graph is also measured to completion");
    assert.ok(PR.probeRunDiag().probed.length >= 3, "Still measured (previously the whole project had no identity and not a single card was measured)");
    assert.ok(records.some((r) => r.identityKey === id.identityKeys.s));
  } finally { PR.setCostBackend(null); }
});

test("AVC-06 3D mode (setPlan3DView / plan3DView): when enabled, standalone light cards are also included in prerenderSet", async () => {
  setup();
  const p = project();
  D.setPlanProject(p);
  // 注入轻记录，让 "s" 和 "a" 都判轻
  const keys = CI.clipIdentityOf(p).identityKeys;
  const light = (identityKey) => ({ identityKey, device: "test-device", fps: FPS, kind: "stepped", stepMs: 1, catchUpMs: 5, seekOk: true, seekMs: 1, demoted: false });
  D.mergePlanCosts([light(keys.s)]);
  await settle();

  assert.equal(D.plan3DView(), false);
  let plan = D.currentPlan();
  // 正常模式下，轻卡不在 prerenderSet
  assert.equal(plan.prerenderSet.has("a"), false);
  assert.equal(plan.prerenderSet.has("s"), false);

  // 开启 3D 模式
  D.setPlan3DView(true);
  assert.equal(D.plan3DView(), true);
  await settle();
  plan = D.currentPlan();
  // 3D 模式下，作为独立轻卡的 "a" 和 "s" 均被纳入 prerenderSet
  assert.equal(plan.prerenderSet.has("a"), true);
  assert.equal(plan.prerenderSet.has("s"), true);

  // 关闭 3D 模式后恢复
  D.setPlan3DView(false);
  assert.equal(D.plan3DView(), false);
  await settle();
  plan = D.currentPlan();
  assert.equal(plan.prerenderSet.has("a"), false);
  assert.equal(plan.prerenderSet.has("s"), false);
});

