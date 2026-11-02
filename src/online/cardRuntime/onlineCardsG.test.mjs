/**
 * 在线浏览器执行用户卡与素材效果卡:合流接线与块 G(素材效果卡在线执行)的纯逻辑(`docs/plan/online-card-exec-contract.md` 第 3.4、4.3、8 节)。
 * 跑:node --experimental-test-module-mocks --test src/online/cardRuntime/onlineCardsG.test.mjs
 *
 *   OCE-G-01 图形能力判定:拿不到 WebGL2、软件渲染、最大纹理小于画幅长边、丢过上下文各判各的;够就是 ok;面板细节
 *   OCE-G-02 素材效果卡在哪份文档里能跑:缺省不能(编辑页面、同源单舞台、桌面仿在线);舞台写了「能跑素材效果卡」之后才能(2026-10-21 起不按档另挡);
 *            出过事的卡(`setLocalCardExec` 的 blocked)在舞台里按运行不了处理;桌面运行环境恒不算
 *   OCE-G-03 出事登记:素材解不了一次就算 `media`;求值错连着两次才算 `runtime-error`,中间成功过清零;渲染错一次就算;换代清掉
 *   OCE-G-04 画面那一半的闸门(页面一侧):隔离就绪且出口由浏览器拦才执行画面;只靠脚本加固时本页仍「能执行」(声音),画面不执行并给出原因
 *   OCE-G-05 画面那一半的闸门(舞台一侧):闸门开着且自检的出口是 allowlist 才执行画面;script 时闸门仍开(声音线程用)、画面不执行
 *   OCE-G-06 两台舞台都报了能运行才算能运行;有一台说运行不了就按运行不了;画面不执行时是 not-isolated 并带原因
 *   OCE-G-07 舞台 RPC:新增的两个方法在方法表里、有时限;两种新事件在事件表里、不分角色
 *   OCE-G-08 接线(按源码核):舞台执行前问自己的闸门、画面另问出口;加载器与声音宿主按需载入且桌面构建剪得掉;声音线程从 blob 引导并先建
 *            Trusted Types 缺省策略;编辑页面发包时不带票据、把舞台报的状态交给 `editorRunStates`、图形能力交给节点登记处;
 *            编辑页面与导出页不引舞台接线
 */
import { srcUrl } from "../../testing/registerTs.mjs";
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");

globalThis.window = globalThis;
mock.module(srcUrl("editor/stageBridge.ts"), { exports: { frontStage: () => null, backStage: () => null } });

const R = await import(srcUrl("kernel/registry.ts"));
const H = await import(srcUrl("render/placeholderHost.ts"));
const GPU = await import(srcUrl("online/cardRuntime/gpuCapability.ts"));
const T = await import(srcUrl("render/cards/cardTrouble.ts"));
const PG = await import(srcUrl("online/cardRuntime/gate.ts"));
const SG = await import(srcUrl("online/isolation/execGate.ts"));
const ERS = await import(srcUrl("editor/sync/cardRunStates.ts"));
const RPC = await import(srcUrl("render/stageRpc.ts"));

test("OCE-G-01 Graphics capability check: each of the four shortfalls is judged separately; sufficient means ok", () => {
  const good = { webgl2: true, renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)", maxTextureSize: 16384 };
  assert.equal(GPU.judgeGraphCapability(good, { longSide: 1920 }), "ok");
  assert.equal(GPU.judgeGraphCapability(good, { longSide: 16384 }), "ok");
  assert.equal(GPU.judgeGraphCapability(good, { longSide: 16385 }), "texture");
  assert.equal(GPU.judgeGraphCapability(null, { longSide: 1920 }), "no-webgl2");
  assert.equal(GPU.judgeGraphCapability({ ...good, webgl2: false }, { longSide: 1920 }), "no-webgl2");
  for (const renderer of ["ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)", "llvmpipe (LLVM 15.0.7, 256 bits)", "Microsoft Basic Render Driver", "Software Rasterizer"]) {
    assert.equal(GPU.judgeGraphCapability({ ...good, renderer }, { longSide: 1920 }), "software", renderer);
  }
  assert.equal(GPU.judgeGraphCapability(good, { longSide: 1920, contextLost: true }), "context-lost");
  for (const cap of ["no-webgl2", "software", "texture", "context-lost"]) assert.ok(GPU.graphCapabilityDetail(cap).length > 0, cap);
  assert.equal(GPU.graphCapabilityDetail("ok"), "");
});

const dom = (id, extra = {}) => ({ id, name: id, defaults: {}, controls: [], frameMode: "direct", Component: () => null, ...extra });
const graphDef = (id) => dom(id, { Component: undefined, card: () => ({}) });
const local = (id) => H.unsupportedHere(id, R.getCard(id));

test("OCE-G-02 In which document a media effect card can run: by default it cannot; only after the stage declares it; cards that have had trouble count as unable to run; desktop never counts", () => {
  R.resetCards(); R.resetRuntimeCardsForTest();
  R.registerCards([dom("builtin")]);
  R.setSyncedUserCards([{ id: "g-synced", name: "Synced media effect card" }, { id: "u-synced", name: "Synced user card" }]);
  H.setOnlineBrowserMode(true);
  try {
    // 编辑页面:没有定义,只看运行状态
    assert.equal(local("g-synced"), true);
    R.setCardRunStates([["g-synced", { state: "gpu" }]]);
    assert.equal(local("g-synced"), true);
    R.setCardRunStates([["g-synced", { state: "ready" }]]);
    assert.equal(local("g-synced"), false, "Editor page: does not count if the stage says it can run");
    R.setCardRunStates([]);
    // 舞台:载入成功(运行时注册表里有定义)。素材效果卡还要这份文档「能跑素材效果卡」
    R.setRuntimeCards([graphDef("g-synced"), dom("u-synced")]);
    assert.equal(R.graphCardsRunnableHere(), false);
    assert.equal(local("u-synced"), false, "User card: can run once loaded successfully");
    assert.equal(local("g-synced"), true, "Media effect card: this document has not yet declared that media effect cards can run");
    const gen = R.cardsRegistryGen();
    assert.equal(R.setLocalCardExec({ graph: true }), true);
    assert.ok(R.cardsRegistryGen() > gen, "A change must make places that memoize by generation recompute");
    assert.equal(R.setLocalCardExec({ graph: true }), false, "没变不通知");
    assert.equal(local("g-synced"), false, "Stage that can run media effect cards: the media effect card can run");
    // 2026-10-21 起不按档另挡:舞台里载入成功、能跑素材效果卡的照常运行(停下追精确帧)
    assert.equal(local("u-synced"), false);
    // 出过事的卡:撤下
    R.setLocalCardExec({ graph: true, blocked: ["g-synced", "u-synced"] });
    assert.equal(local("g-synced"), true);
    assert.equal(local("u-synced"), true);
    assert.equal(R.cardRunnableHere("u-synced"), false);
    assert.equal(local("builtin"), false, "内置卡不受影响");
    R.setLocalCardExec({ graph: false });
    assert.equal(local("g-synced"), true);
    // 桌面运行环境:模式关着恒不算
    H.setOnlineBrowserMode(false);
    assert.equal(local("g-synced"), false);
    // 直接问 needsLocalPc(桌面仿在线模式的调用方):素材效果卡在没说「能跑素材效果卡」的文档里照旧算
    assert.equal(H.needsLocalPc("x", graphDef("x"), () => false), true);
    assert.equal(H.needsLocalPc("x", graphDef("x"), () => false, () => true, () => true), false);
  } finally {
    H.setOnlineBrowserMode(false); R.resetRuntimeCardsForTest(); R.setSyncedUserCards([]);
  }
});

test("OCE-G-03 Trouble registry: one media decode failure counts; evaluation errors count only twice in a row, reset after a success; one render error counts; cleared on generation change", () => {
  T.resetCardTroubleForTest();
  let fired = 0;
  const off = T.onCardTrouble(() => { fired++; });
  T.noteGraphCardError("g1", new Error("Card media could not be decoded: /@media/abc"));
  assert.deepEqual(T.cardTroubles().get("g1")?.kind, "media");
  assert.equal(fired, 1);
  T.noteGraphCardError("g2", new Error("shader compile failed\nline 2"));
  assert.equal(T.cardTroubles().has("g2"), false, "The first evaluation error does not count");
  T.noteGraphCardOk("g2");
  T.noteGraphCardError("g2", new Error("again"));
  assert.equal(T.cardTroubles().has("g2"), false, "A success in between: count again");
  T.noteGraphCardError("g2", new Error("again"));
  assert.deepEqual(T.cardTroubles().get("g2"), { kind: "runtime-error", detail: "again" });
  assert.equal(T.GRAPH_ERROR_STRIKES, 2);
  T.noteCardRenderError("u1", new Error("boom\n  at X"));
  assert.deepEqual(T.cardTroubles().get("u1"), { kind: "runtime-error", detail: "boom" });
  const before = fired;
  T.noteCardRenderError("u1", new Error("another"));
  assert.equal(fired, before, "Already registered ones are not notified again");
  T.clearCardTrouble(["g1", "u1"]);
  assert.equal(T.cardTroubles().has("g1"), false);
  assert.equal(T.cardTroubles().has("u1"), false);
  assert.equal(T.cardTroubles().has("g2"), true);
  off();
  T.resetCardTroubleForTest();
});

test("OCE-G-04 Page visual execution does not depend on exit capability; site/isolation switches still apply",()=>{
  PG.resetCardExecGateForTest(); assert.equal(PG.cardVisualExecAvailable(),false);
  PG.setCardExecGate({site:true,isolated:true,visual:false});
  assert.equal(PG.cardExecAvailable(),true);assert.equal(PG.cardVisualExecAvailable(),true);assert.equal(PG.cardExecBlockedDetail(),null);
  PG.setCardExecGate({site:false});assert.equal(PG.cardVisualExecAvailable(),false);assert.match(PG.cardExecBlockedDetail(),/does not have online running of user cards/);
  PG.resetCardExecGateForTest();
});

test("OCE-G-05 Stage without allowlist/Trusted Types still executes visuals; parent page/ticket/breach still gate",()=>{
  SG.resetExecGateForTest();SG.markIsolatedStageDocument();
  SG.setIsolationReport({ok:true,crossOrigin:true,csp:'header',egress:'none',hardened:true,trustedTypes:'unsupported',reasons:[]});
  assert.equal(SG.cardVisualExecAllowed(),false);
  SG.noteMediaPolicy({ticket:null,cardExec:true});assert.equal(SG.cardVisualExecAllowed(),true);
  SG.noteBreach();assert.equal(SG.cardVisualExecAllowed(),false);
  SG.resetExecGateForTest();
});

test("OCE-G-06 Counts only when both stages report they can run; if one says it cannot run, treat as unable to run; when visuals do not execute, it is not-isolated with a reason", () => {
  const cards = [{ id: "a", name: "A", source: "src/cards/user/a.tsx" }];
  const bundles = [{ ok: true, entry: "src/cards/user/a.tsx", bundle: { generation: "g1" } }];
  const run = (stages, extra = {}) => ERS.editorRunStates({ cards, available: true, bundles, stages, stageCount: 2, ...extra }).get("a");
  assert.equal(run([undefined, undefined]).state, "loading");
  assert.equal(run([new Map([["a", { state: "ready" }]]), undefined]).state, "loading", "Only one is loaded: still counts as loading");
  assert.equal(run([new Map([["a", { state: "ready" }]]), new Map([["a", { state: "ready" }]])]).state, "ready");
  assert.ok(run([new Map([["a", { state: "ready" }]]), new Map([["a", { state: "ready" }]])]).version, "Ones that can run carry this generation's signature");
  assert.equal(run([new Map([["a", { state: "gpu", detail: "Only software rendering is available" }]]), undefined]).state, "gpu", "If one says no, there is no need to wait for the other");
  assert.equal(run([new Map([["a", { state: "ready" }]]), new Map([["a", { state: "media" }]])]).state, "media");
  // 缺省(不给 stageCount)与原来相同:一台报了就算
  assert.equal(ERS.editorRunStates({ cards, available: true, bundles, stages: [new Map([["a", { state: "ready" }]])] }).get("a").state, "ready");
  const blocked = run([], { available: false, blockedDetail: "Isolation is not ready yet" });
  assert.equal(blocked.state, "not-isolated");
  assert.match(ERS.runStateMessage(blocked), /Isolation is not ready yet/);
  assert.match(ERS.runStateMessage({ state: "gpu" }), /graphics capability is not enough/);
  assert.match(ERS.runStateMessage({ state: "media" }), /cannot decode this media/);
});

test("OCE-G-07 Stage RPC: the two new methods have timeouts; the two new events are in the event table, regardless of role", () => {
  assert.equal(RPC.stageCallTimeoutMs("loadUserCards", [[]]), RPC.STAGE_UPDATE_TIMEOUT_MS);
  assert.equal(RPC.stageCallTimeoutMs("synthCardAudio", [{ count: 48_000, sampleRate: 48_000 }]), 10_000 + 20_000 + RPC.STAGE_RPC_SLACK_MS);
  assert.equal(RPC.stageCallTimeoutMs("synthCardAudio", [{ count: 48_000 * 60, sampleRate: 48_000 }]), 120_000 + 20_000 + RPC.STAGE_RPC_SLACK_MS);
  assert.ok(RPC.stageCallTimeoutMs("synthCardAudio", [{}]) > 0, "Bad arguments also have a timeout");
  for (const type of ["card-states", "sound-state"]) {
    assert.ok(RPC.STAGE_EVENT_TYPES.has(type), type);
    assert.ok(RPC.STAGE_ANY_ROLE_EVENTS.has(type), type);
  }
  const src = read("render/stageRpc.ts");
  assert.match(src, /"bakeCancel", "loadUserCards", "synthCardAudio"\]/);
});

test("OCE-G-08 Wiring (checked against source)", () => {
  const stage = read("StageView.tsx");
  // 舞台执行前问自己的闸门;画面另问出口;不是舞台入口的文档不记、不执行
  assert.match(stage, /if \(!stageExecGate\(\)\.allowed \|\| !bundles\) \{/);
  assert.match(stage, /if \(cardVisualExecAllowed\(\)\) \{\s+if \(!cardExec\.runtime\) \{\s+const m = await import\("\.\/online\/cardRuntime\/stageRuntime"\);/);
  assert.match(stage, /if \(gate\.reason === "not-stage"\) return \{ ok: false, reason: "unsupported" as const \};/);
  assert.match(stage, /subscribeStageExecGate\(\(\) => \{ void applyCardBundles\(\); \}\)/);
  // 按需载入、桌面构建剪得掉:三处 import() 都在编译期常量把关的函数里,文件里没有静态引入
  assert.match(stage, /const applyCardBundles = async \(\): Promise<void> => \{\s+if \(import\.meta\.env\.VITE_PC_ONLINE !== "1" \|\| cardExec\.stopped\) return;/);
  for (const mod of ["stageRuntime", "stageSound", "soundSpawn", "loader", "hostModules"]) {
    assert.doesNotMatch(stage, new RegExp(`^import (?!type )[^\\n]*cardRuntime/${mod}`, "m"), `StageView must not statically import ${mod}`);
  }
  // 声音线程:经 spawnRuntimeWorker 从 blob 引导(守卫把全局 Worker 锁成抛错的构造函数,这里用的是它装上之前留在模块闭包里的原生构造函数),先建 Trusted Types 缺省策略
  const spawn = read("online/cardRuntime/soundSpawn.ts");
  assert.match(spawn, /spawnRuntimeWorker\(`\$\{trustedTypesPrelude\(\)\}importScripts\(\$\{JSON\.stringify\(abs\)\}\);`/);
  assert.match(spawn, /spawnRuntimeWorker\(`import \$\{JSON\.stringify\(abs\)\};`/);
  assert.doesNotMatch(spawn, /new Worker\(/, "Do not call the global Worker to start threads yourself (the guard has locked it into a constructor that throws; the bootstrap URL is always a blob built by this module, worker-src blob:)");
  // 声音线程的模块表不引汇总文件(它们把样式带进线程,线程起不来)
  assert.match(read("online/cardRuntime/soundModules.ts"), /"!\/src\/cards\/\*\*\/index\.ts", "!\/src\/parts\/\*\*\/index\.ts"/);
  // 编辑页面:发包、收状态、接声音、立闸门
  const preview = read("editor/Preview.tsx");
  assert.match(preview, /c\.loadUserCards\(list, \{ sound: id === soundStageId\(\) \}\)/);
  assert.match(preview, /function soundStageId\(\): StageId \{\s*return ONLINE && !dualStage\(\) \? "A" : "B";/, "Sound thread: with dual stages it is on instance B, with a single stage on A");
  assert.match(preview, /setCardExecGate\(\{ site: onlineStageState\(\)\.cardExec, isolated: s\.enabled, reason: s\.enabled \? null : s\.reason, visual: true \}\)/);
  // 挂着的舞台都报了能运行才算能运行:双舞台两台、单舞台(舞台闸门第一级)一台
  assert.match(preview, /stages: mountedStageIds\(\)\.map\(\(id\) => stageCardStatesRef\.current\[id\]\), stageCount: Math\.max\(1, mountedStageIds\(\)\.length\),/);
  assert.match(preview, /setNodeGraphCapable\(STAGE_IDS\.every\(\(s\) => stageGraphRef\.current\[s\] === "ok"\)\)/);
  assert.match(preview, /createIsolatedSoundLink\(\{/);
  const push = preview.slice(preview.indexOf("const pushCardBundles = useCallback"), preview.indexOf("const pushCardBundlesRef"));
  assert.ok(push.length > 100 && !/ticket|Ticket|password|credential/.test(push), "The bundle sent to the stage contains no ticket or credentials");
  // 编辑页面与导出页不引舞台接线、加载器(类型除外)
  for (const dir of ["editor", "export"]) {
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    for (const file of walk(path.join(SRC, dir)).filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\./.test(f))) {
      const text = fs.readFileSync(file, "utf8");
      assert.doesNotMatch(text, /^import (?!type )[^\n]*cardRuntime\/(loader|stageRuntime|hostModules|soundThread|soundWorker|soundHost|soundSpawn|stageSound|gpuCapability)/m, file);
    }
  }
  // 错误边界只包运行时载入的卡
  assert.match(read("render/Stage.tsx"), /return cardId && isRuntimeCard\(cardId\) \? <RuntimeCardBoundary cardId=\{cardId\}>\{body\}<\/RuntimeCardBoundary> : body;/);
});
