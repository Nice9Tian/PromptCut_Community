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

test("OCE-G-01 图形能力判定:四种不够各判各的;够就是 ok", () => {
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

test("OCE-G-02 素材效果卡在哪份文档里能跑:缺省不能;舞台写了之后才能;出过事的卡按运行不了;桌面恒不算", () => {
  R.resetCards(); R.resetRuntimeCardsForTest();
  R.registerCards([dom("builtin")]);
  R.setSyncedUserCards([{ id: "g-synced", name: "同步素材效果卡" }, { id: "u-synced", name: "同步用户卡" }]);
  H.setOnlineBrowserMode(true);
  try {
    // 编辑页面:没有定义,只看运行状态
    assert.equal(local("g-synced"), true);
    R.setCardRunStates([["g-synced", { state: "gpu" }]]);
    assert.equal(local("g-synced"), true);
    R.setCardRunStates([["g-synced", { state: "ready" }]]);
    assert.equal(local("g-synced"), false, "编辑页面:舞台说能运行就不算");
    R.setCardRunStates([]);
    // 舞台:载入成功(运行时注册表里有定义)。素材效果卡还要这份文档「能跑素材效果卡」
    R.setRuntimeCards([graphDef("g-synced"), dom("u-synced")]);
    assert.equal(R.graphCardsRunnableHere(), false);
    assert.equal(local("u-synced"), false, "用户卡:载入成功就能运行");
    assert.equal(local("g-synced"), true, "素材效果卡:这份文档还没说能跑素材效果卡");
    const gen = R.cardsRegistryGen();
    assert.equal(R.setLocalCardExec({ graph: true }), true);
    assert.ok(R.cardsRegistryGen() > gen, "变了要让按代数记忆的地方重算");
    assert.equal(R.setLocalCardExec({ graph: true }), false, "没变不通知");
    assert.equal(local("g-synced"), false, "能跑素材效果卡的舞台:素材效果卡能运行");
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

test("OCE-G-03 出事登记:素材解不了一次就算;求值错连着两次才算,成功过清零;渲染错一次就算;换代清掉", () => {
  T.resetCardTroubleForTest();
  let fired = 0;
  const off = T.onCardTrouble(() => { fired++; });
  T.noteGraphCardError("g1", new Error("Card media could not be decoded: /@media/abc"));
  assert.deepEqual(T.cardTroubles().get("g1")?.kind, "media");
  assert.equal(fired, 1);
  T.noteGraphCardError("g2", new Error("shader compile failed\nline 2"));
  assert.equal(T.cardTroubles().has("g2"), false, "第一次求值错不算");
  T.noteGraphCardOk("g2");
  T.noteGraphCardError("g2", new Error("again"));
  assert.equal(T.cardTroubles().has("g2"), false, "中间成功过:重新数");
  T.noteGraphCardError("g2", new Error("again"));
  assert.deepEqual(T.cardTroubles().get("g2"), { kind: "runtime-error", detail: "again" });
  assert.equal(T.GRAPH_ERROR_STRIKES, 2);
  T.noteCardRenderError("u1", new Error("boom\n  at X"));
  assert.deepEqual(T.cardTroubles().get("u1"), { kind: "runtime-error", detail: "boom" });
  const before = fired;
  T.noteCardRenderError("u1", new Error("another"));
  assert.equal(fired, before, "已经登记的不重复通知");
  T.clearCardTrouble(["g1", "u1"]);
  assert.equal(T.cardTroubles().has("g1"), false);
  assert.equal(T.cardTroubles().has("u1"), false);
  assert.equal(T.cardTroubles().has("g2"), true);
  off();
  T.resetCardTroubleForTest();
});

test("OCE-G-04 页面画面执行不以出口能力为条件，站点/隔离开关仍有效",()=>{
  PG.resetCardExecGateForTest(); assert.equal(PG.cardVisualExecAvailable(),false);
  PG.setCardExecGate({site:true,isolated:true,visual:false});
  assert.equal(PG.cardExecAvailable(),true);assert.equal(PG.cardVisualExecAvailable(),true);assert.equal(PG.cardExecBlockedDetail(),null);
  PG.setCardExecGate({site:false});assert.equal(PG.cardVisualExecAvailable(),false);assert.match(PG.cardExecBlockedDetail(),/站点没有开启/);
  PG.resetCardExecGateForTest();
});

test("OCE-G-05 舞台无allowlist/Trusted Types仍执行画面，父页/票据/breach仍把关",()=>{
  SG.resetExecGateForTest();SG.markIsolatedStageDocument();
  SG.setIsolationReport({ok:true,crossOrigin:true,csp:'header',egress:'none',hardened:true,trustedTypes:'unsupported',reasons:[]});
  assert.equal(SG.cardVisualExecAllowed(),false);
  SG.noteMediaPolicy({ticket:null,cardExec:true});assert.equal(SG.cardVisualExecAllowed(),true);
  SG.noteBreach();assert.equal(SG.cardVisualExecAllowed(),false);
  SG.resetExecGateForTest();
});

test("OCE-G-06 两台舞台都报了能运行才算;有一台说运行不了就按运行不了;画面不执行时是 not-isolated 并带原因", () => {
  const cards = [{ id: "a", name: "A", source: "src/cards/user/a.tsx" }];
  const bundles = [{ ok: true, entry: "src/cards/user/a.tsx", bundle: { generation: "g1" } }];
  const run = (stages, extra = {}) => ERS.editorRunStates({ cards, available: true, bundles, stages, stageCount: 2, ...extra }).get("a");
  assert.equal(run([undefined, undefined]).state, "loading");
  assert.equal(run([new Map([["a", { state: "ready" }]]), undefined]).state, "loading", "只有一台载入好:还算载入中");
  assert.equal(run([new Map([["a", { state: "ready" }]]), new Map([["a", { state: "ready" }]])]).state, "ready");
  assert.ok(run([new Map([["a", { state: "ready" }]]), new Map([["a", { state: "ready" }]])]).version, "能运行的带这一代的签名");
  assert.equal(run([new Map([["a", { state: "gpu", detail: "只有软件渲染" }]]), undefined]).state, "gpu", "有一台说不行就不用等另一台");
  assert.equal(run([new Map([["a", { state: "ready" }]]), new Map([["a", { state: "media" }]])]).state, "media");
  // 缺省(不给 stageCount)与原来相同:一台报了就算
  assert.equal(ERS.editorRunStates({ cards, available: true, bundles, stages: [new Map([["a", { state: "ready" }]])] }).get("a").state, "ready");
  const blocked = run([], { available: false, blockedDetail: "隔离尚未就绪" });
  assert.equal(blocked.state, "not-isolated");
  assert.match(ERS.runStateMessage(blocked), /隔离尚未就绪/);
  assert.match(ERS.runStateMessage({ state: "gpu" }), /图形能力不够/);
  assert.match(ERS.runStateMessage({ state: "media" }), /解不了这段素材/);
});

test("OCE-G-07 舞台 RPC:两个新方法有时限;两种新事件在事件表里、不分角色", () => {
  assert.equal(RPC.stageCallTimeoutMs("loadUserCards", [[]]), RPC.STAGE_UPDATE_TIMEOUT_MS);
  assert.equal(RPC.stageCallTimeoutMs("synthCardAudio", [{ count: 48_000, sampleRate: 48_000 }]), 10_000 + 20_000 + RPC.STAGE_RPC_SLACK_MS);
  assert.equal(RPC.stageCallTimeoutMs("synthCardAudio", [{ count: 48_000 * 60, sampleRate: 48_000 }]), 120_000 + 20_000 + RPC.STAGE_RPC_SLACK_MS);
  assert.ok(RPC.stageCallTimeoutMs("synthCardAudio", [{}]) > 0, "坏参数也有时限");
  for (const type of ["card-states", "sound-state"]) {
    assert.ok(RPC.STAGE_EVENT_TYPES.has(type), type);
    assert.ok(RPC.STAGE_ANY_ROLE_EVENTS.has(type), type);
  }
  const src = read("render/stageRpc.ts");
  assert.match(src, /"bakeCancel", "loadUserCards", "synthCardAudio"\]/);
});

test("OCE-G-08 接线(按源码核)", () => {
  const stage = read("StageView.tsx");
  // 舞台执行前问自己的闸门;画面另问出口;不是舞台入口的文档不记、不执行
  assert.match(stage, /if \(!stageExecGate\(\)\.allowed \|\| !bundles\) \{/);
  assert.match(stage, /if \(cardVisualExecAllowed\(\)\) \{\s+if \(!cardExec\.runtime\) \{\s+const m = await import\("\.\/online\/cardRuntime\/stageRuntime"\);/);
  assert.match(stage, /if \(gate\.reason === "not-stage"\) return \{ ok: false, reason: "unsupported" as const \};/);
  assert.match(stage, /subscribeStageExecGate\(\(\) => \{ void applyCardBundles\(\); \}\)/);
  // 按需载入、桌面构建剪得掉:三处 import() 都在编译期常量把关的函数里,文件里没有静态引入
  assert.match(stage, /const applyCardBundles = async \(\): Promise<void> => \{\s+if \(import\.meta\.env\.VITE_PC_ONLINE !== "1" \|\| cardExec\.stopped\) return;/);
  for (const mod of ["stageRuntime", "stageSound", "soundSpawn", "loader", "hostModules"]) {
    assert.doesNotMatch(stage, new RegExp(`^import (?!type )[^\\n]*cardRuntime/${mod}`, "m"), `StageView 不能静态引 ${mod}`);
  }
  // 声音线程:经 spawnRuntimeWorker 从 blob 引导(守卫把全局 Worker 锁成抛错的构造函数,这里用的是它装上之前留在模块闭包里的原生构造函数),先建 Trusted Types 缺省策略
  const spawn = read("online/cardRuntime/soundSpawn.ts");
  assert.match(spawn, /spawnRuntimeWorker\(`\$\{trustedTypesPrelude\(\)\}importScripts\(\$\{JSON\.stringify\(abs\)\}\);`/);
  assert.match(spawn, /spawnRuntimeWorker\(`import \$\{JSON\.stringify\(abs\)\};`/);
  assert.doesNotMatch(spawn, /new Worker\(/, "不许自己调全局 Worker 起线程(守卫已把它锁成抛错的构造函数;引导地址一律是本模块建的 blob,worker-src blob:)");
  // 声音线程的模块表不引汇总文件(它们把样式带进线程,线程起不来)
  assert.match(read("online/cardRuntime/soundModules.ts"), /"!\/src\/cards\/\*\*\/index\.ts", "!\/src\/parts\/\*\*\/index\.ts"/);
  // 编辑页面:发包、收状态、接声音、立闸门
  const preview = read("editor/Preview.tsx");
  assert.match(preview, /c\.loadUserCards\(list, \{ sound: id === soundStageId\(\) \}\)/);
  assert.match(preview, /function soundStageId\(\): StageId \{\s*return ONLINE && !dualStage\(\) \? "A" : "B";/, "声音线程:双舞台在实例 B,单舞台在 A");
  assert.match(preview, /setCardExecGate\(\{ site: onlineStageState\(\)\.cardExec, isolated: s\.enabled, reason: s\.enabled \? null : s\.reason, visual: true \}\)/);
  // 挂着的舞台都报了能运行才算能运行:双舞台两台、单舞台(舞台闸门第一级)一台
  assert.match(preview, /stages: mountedStageIds\(\)\.map\(\(id\) => stageCardStatesRef\.current\[id\]\), stageCount: Math\.max\(1, mountedStageIds\(\)\.length\),/);
  assert.match(preview, /setNodeGraphCapable\(STAGE_IDS\.every\(\(s\) => stageGraphRef\.current\[s\] === "ok"\)\)/);
  assert.match(preview, /createIsolatedSoundLink\(\{/);
  const push = preview.slice(preview.indexOf("const pushCardBundles = useCallback"), preview.indexOf("const pushCardBundlesRef"));
  assert.ok(push.length > 100 && !/ticket|Ticket|password|credential/.test(push), "发给舞台的包里不带票据或凭证");
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
