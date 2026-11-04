/**
 * Online browser execution of user cards and media effect cards: merge wiring and pure logic of
 * block G (online execution of media effect cards) (`docs/plan/online-card-exec-contract.md`
 * sections 3.4, 4.3, 8).
 * Run: node --experimental-test-module-mocks --test src/online/cardRuntime/onlineCardsG.test.mjs
 *
 *   OCE-G-01 Graphics capability check: evaluate WebGL2 unavailable, software rendering, max
 *     texture smaller than aspect ratio's long edge, and lost context separately; sufficient is
 *     ok; panel details
 *   OCE-G-02 Which documents can run media effect cards: cannot by default (editor page,
 *     same-origin single stage, desktop mock-online); allowed only after stage declares "can run
 *     media effect cards" (no longer blocked separately by tier starting 2026-10-21); cards that
 *     encountered errors (`setLocalCardExec` blocked) are treated as unable to run in stage;
 *     desktop runtime environment never counts
 *   OCE-G-03 Incident registration: a single asset decoding failure counts as `media`; evaluation
 *     errors count as `runtime-error` only after two consecutive times, reset by any intervening
 *     success; a single render error counts; cleared on generation switch
 *   OCE-G-04 Visual half gate (page side): execute visual only when isolation is ready and egress
 *     is blocked by browser; with script hardening alone, this page can still "execute" (sound),
 *     while visual does not execute and gives reason
 *   OCE-G-05 Visual half gate (stage side): execute visual only when gate is open and self-check
 *     egress is allowlist; with script, gate remains open (used by sound thread), while visual does
 *     not execute
 *   OCE-G-06 Counted as runnable only when both stages report runnable; if either reports unable to
 *     run, treat as unable to run; when visual does not execute, status is not-isolated with reason
 *   OCE-G-07 Stage RPC: two newly added methods are in method table with timeouts; two new events
 *     are in event table regardless of role
 *   OCE-G-08 Wiring (verified against source): before execution, stage queries its own gate, and
 *     visual queries egress separately; loader and sound host are loaded on demand and tree-shaken
 *     in desktop builds; sound thread bootstraps from blob and creates Trusted Types default
 *     policy first; editor page sends packets without tickets, passes stage-reported states to
 *     `editorRunStates`, and passes graphics capabilities to node registry; editor page and
 *     export page do not import stage wiring
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
    // Editor page: no definition, only check run state
    assert.equal(local("g-synced"), true);
    R.setCardRunStates([["g-synced", { state: "gpu" }]]);
    assert.equal(local("g-synced"), true);
    R.setCardRunStates([["g-synced", { state: "ready" }]]);
    assert.equal(local("g-synced"), false, "Editor page: does not count if the stage says it can run");
    R.setCardRunStates([]);
    // Stage: loaded successfully (defined in runtime registry). Media effect cards also require this
    // document to declare "can run media effect cards"
    R.setRuntimeCards([graphDef("g-synced"), dom("u-synced")]);
    assert.equal(R.graphCardsRunnableHere(), false);
    assert.equal(local("u-synced"), false, "User card: can run once loaded successfully");
    assert.equal(local("g-synced"), true, "Media effect card: this document has not yet declared that media effect cards can run");
    const gen = R.cardsRegistryGen();
    assert.equal(R.setLocalCardExec({ graph: true }), true);
    assert.ok(R.cardsRegistryGen() > gen, "A change must make places that memoize by generation recompute");
    assert.equal(R.setLocalCardExec({ graph: true }), false, "No notification when nothing changed");
    assert.equal(local("g-synced"), false, "Stage that can run media effect cards: the media effect card can run");
    // Starting 2026-10-21, no longer blocked separately by tier: cards loaded successfully in stage and
    // capable of running media effect cards run as usual (pause for exact frame catch-up)
    assert.equal(local("u-synced"), false);
    // Cards that encountered errors: tear down
    R.setLocalCardExec({ graph: true, blocked: ["g-synced", "u-synced"] });
    assert.equal(local("g-synced"), true);
    assert.equal(local("u-synced"), true);
    assert.equal(R.cardRunnableHere("u-synced"), false);
    assert.equal(local("builtin"), false, "built-in cards are unaffected");
    R.setLocalCardExec({ graph: false });
    assert.equal(local("g-synced"), true);
    // Desktop runtime environment: never counts when mode is off
    H.setOnlineBrowserMode(false);
    assert.equal(local("g-synced"), false);
    // Direct query to needsLocalPc (caller of desktop mock-online mode): media effect cards still
    // count in documents that do not declare "can run media effect cards"
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
  // Default (without stageCount) same as before: counts once one stage reports
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
  // Before execution, stage queries its own gate; visual queries egress separately; documents that
  // are not stage entry points are not recorded or executed
  assert.match(stage, /if \(!stageExecGate\(\)\.allowed \|\| !bundles\) \{/);
  assert.match(stage, /if \(cardVisualExecAllowed\(\)\) \{\s+if \(!cardExec\.runtime\) \{\s+const m = await import\("\.\/online\/cardRuntime\/stageRuntime"\);/);
  assert.match(stage, /if \(gate\.reason === "not-stage"\) return \{ ok: false, reason: "unsupported" as const \};/);
  assert.match(stage, /subscribeStageExecGate\(\(\) => \{ void applyCardBundles\(\); \}\)/);
  // Loaded on demand and tree-shaken in desktop builds: all three import() calls are inside
  // functions guarded by compile-time constants, with no static imports in file
  assert.match(stage, /const applyCardBundles = async \(\): Promise<void> => \{\s+if \(import\.meta\.env\.VITE_PC_ONLINE !== "1" \|\| cardExec\.stopped\) return;/);
  for (const mod of ["stageRuntime", "stageSound", "soundSpawn", "loader", "hostModules"]) {
    assert.doesNotMatch(stage, new RegExp(`^import (?!type )[^\\n]*cardRuntime/${mod}`, "m"), `StageView must not statically import ${mod}`);
  }
  // Sound thread: bootstrapped from blob via spawnRuntimeWorker (the guard locks global Worker into
  // an error-throwing constructor; here it uses the native constructor preserved in the module
  // closure before installation), and creates Trusted Types default policy first
  const spawn = read("online/cardRuntime/soundSpawn.ts");
  assert.match(spawn, /spawnRuntimeWorker\(`\$\{trustedTypesPrelude\(\)\}importScripts\(\$\{JSON\.stringify\(abs\)\}\);`/);
  assert.match(spawn, /spawnRuntimeWorker\(`import \$\{JSON\.stringify\(abs\)\};`/);
  assert.doesNotMatch(spawn, /new Worker\(/, "Do not call the global Worker to start threads yourself (the guard has locked it into a constructor that throws; the bootstrap URL is always a blob built by this module, worker-src blob:)");
  // Sound thread module table does not import aggregate files (they bring styles into the thread,
  // preventing it from starting)
  assert.match(read("online/cardRuntime/soundModules.ts"), /"!\/src\/cards\/\*\*\/index\.ts", "!\/src\/parts\/\*\*\/index\.ts"/);
  // Editor page: send packets, receive states, connect sound, set up gates
  const preview = read("editor/Preview.tsx");
  assert.match(preview, /c\.loadUserCards\(list, \{ sound: id === soundStageId\(\) \}\)/);
  assert.match(preview, /function soundStageId\(\): StageId \{\s*return ONLINE && !dualStage\(\) \? "A" : "B";/, "Sound thread: with dual stages it is on instance B, with a single stage on A");
  assert.match(preview, /setCardExecGate\(\{ site: onlineStageState\(\)\.cardExec, isolated: s\.enabled, reason: s\.enabled \? null : s\.reason, visual: true \}\)/);
  // Counted as runnable only when all attached stages report runnable: two for dual stage, one for
  // single stage (first tier of stage gate)
  assert.match(preview, /stages: mountedStageIds\(\)\.map\(\(id\) => stageCardStatesRef\.current\[id\]\), stageCount: Math\.max\(1, mountedStageIds\(\)\.length\),/);
  assert.match(preview, /setNodeGraphCapable\(STAGE_IDS\.every\(\(s\) => stageGraphRef\.current\[s\] === "ok"\)\)/);
  assert.match(preview, /createIsolatedSoundLink\(\{/);
  const push = preview.slice(preview.indexOf("const pushCardBundles = useCallback"), preview.indexOf("const pushCardBundlesRef"));
  assert.ok(push.length > 100 && !/ticket|Ticket|password|credential/.test(push), "The bundle sent to the stage contains no ticket or credentials");
  // Editor page and export page do not import stage wiring or loader (except types)
  for (const dir of ["editor", "export"]) {
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    for (const file of walk(path.join(SRC, dir)).filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\./.test(f))) {
      const text = fs.readFileSync(file, "utf8");
      assert.doesNotMatch(text, /^import (?!type )[^\n]*cardRuntime\/(loader|stageRuntime|hostModules|soundThread|soundWorker|soundHost|soundSpawn|stageSound|gpuCapability)/m, file);
    }
  }
  // Error boundary wraps only cards loaded at runtime
  assert.match(read("render/Stage.tsx"), /return cardId && isRuntimeCard\(cardId\) \? <RuntimeCardBoundary cardId=\{cardId\}>\{body\}<\/RuntimeCardBoundary> : body;/);
});
