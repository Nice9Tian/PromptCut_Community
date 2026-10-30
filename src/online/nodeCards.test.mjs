/**
 * 块 N 的页面一侧与整条链路(`docs/plan/online-card-exec-contract.md` 第 7 节,任务书第二段第 16 条)。
 * 舞台里真正执行用户卡、素材效果卡的接线还没合流,所以这里用「替身渲染结果」(`bakeFrame` 直接回确定的哈希)把
 * 认领、指纹、结果键、入库后别的成员能贴上这条链路钉住;真执行的端到端见 `scripts/probes/online-card-node-probe.mjs`。
 *
 *   OCN-08 登记处:算能运行的卡、换代后一小段时间不报、订阅
 *   OCN-09 browserNode:hello 多报运行时版本、welcome 的 cardEnvFingerprint、能力位与代码身份、晚到的运行时版本重新报到
 *   OCN-10 planPublisher:input.browser 随清单计划发出、签名带它、登记变了重发、与队列侧逐字段相同
 *   OCN-11 整条链路:页面发清单计划 → 切分(桌面同机的另一份)→ 浏览器节点认领自己的 → 替身渲染 → 完成 →
 *          层表候选里有浏览器那份、别的成员按它贴上;别人的任务、代码身份对不上的页面一个都不认领
 *
 * 跑:node --experimental-test-module-mocks --test src/online/nodeCards.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  NODE_CARD_SETTLE_MS, computeNodeCardInfo, getNodeCardInfo, resetNodeCardInfo, setNodeCardEnvFingerprint, setNodeCardInfo, subscribeNodeCardInfo, __setNodeCardInfoTimers,
} from "./nodeCardInfo.ts";
import { createBrowserNode } from "./browserNode.ts";
import { createPlanPublisher, clipsPlanTask, browserCardsFromInfo, browserCardsOf, browserCardsSig } from "./planPublisher.ts";
import { layerRefOf } from "../render/snapshotSource.ts";
import { clipsPlanTaskOf, browserCardsOf as serverBrowserCardsOf, browserCardsSig as serverBrowserCardsSig, parseInbound } from "../../server/render-queue/messages.mjs";
import { createLocalNode } from "../../server/render-node/local-node.mjs";
import { describeCardEnvironment, describeEnvironment, resultKeyOf } from "../../server/render-node/fingerprint.mjs";
import { layerMapOf, splitCandidatesOf } from "../../server/artifact-transfer.mjs";
import { createDocQueueRig, memberPrincipal, ENV } from "../../server/test/m7-kit.mjs";

const flush = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const sha = (text) => crypto.createHash("sha256").update(text).digest("hex");
const RUNTIME = "ocr1:sucrase@3.35.1:tailwindcss@4.3.3";
const BR = describeCardEnvironment({ platform: ENV.winNvidiaChrome.platform, renderer: ENV.winNvidiaChrome.renderer, vendor: ENV.winNvidiaChrome.vendor, chromeVersion: ENV.winNvidiaChrome.userAgent, cardRuntime: RUNTIME });
const CARDFP = BR.cardEnvFingerprint;
const ENVFP = BR.fingerprint;
/** 同一台机器上的桌面节点 */
const DESK_FP = describeEnvironment({ platform: "win32", renderer: ENV.winNvidiaChrome.renderer, vendor: ENV.winNvidiaChrome.vendor, chromeVersion: "HeadlessChrome/152.0.7977.75" }).fingerprint;
const IDENT = "ab".repeat(16);
const USER = "zoe@devA";

/* ================================================================== OCN-08 */

test("OCN-08 登记处:只有 ready 且身份算得出的卡才登记;不能执行时一张也没有;换代后过了 NODE_CARD_SETTLE_MS 才报;到点通知订阅方", () => {
  resetNodeCardInfo();
  const cards = [{ id: "a", source: "src/cards/user/a.tsx" }, { id: "b", source: "src/cards/user/b.tsx" }, { id: "c", source: "src/cards/user/c.tsx" }, { id: "d" }];
  const states = { a: "ready", b: "loading", c: "ready", d: "ready" };
  const identities = { "src/cards/user/a.tsx": "ia", "src/cards/user/b.tsx": "ib" };
  const info = computeNodeCardInfo({ runtime: RUNTIME, available: true, graphCapable: false, cards, stateOf: (id) => states[id], identities });
  assert.deepEqual(info, { cardRuntime: RUNTIME, userCards: true, graphCards: false, cardSources: { a: "ia" } }, "b 还没 ready、c 算不出身份、d 没有入口文件");
  assert.equal(computeNodeCardInfo({ runtime: RUNTIME, available: true, graphCapable: true, cards, stateOf: (id) => states[id], identities }).graphCards, true);
  assert.deepEqual(computeNodeCardInfo({ runtime: RUNTIME, available: false, graphCapable: true, cards, stateOf: () => "ready", identities }),
    { cardRuntime: null, userCards: false, graphCards: false, cardSources: {} }, "本页不能执行:一样都没有");

  // 登记与换代
  const timers = [];
  __setNodeCardInfoTimers({ set: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; }, clear: (t) => { t.cleared = true; } });
  try {
    let notified = 0;
    const off = subscribeNodeCardInfo(() => { notified++; });
    assert.equal(setNodeCardInfo({ cardRuntime: RUNTIME, userCards: true, graphCards: false, cardSources: { a: "ia" } }, 10_000), true);
    assert.equal(notified, 1);
    assert.equal(setNodeCardInfo({ cardRuntime: RUNTIME, userCards: true, graphCards: false, cardSources: { a: "ia" } }, 10_100), false, "没变不通知");
    assert.deepEqual(getNodeCardInfo(10_000 + NODE_CARD_SETTLE_MS - 1).cardSources, {}, "新出现的卡:定下来之前不报");
    assert.deepEqual(getNodeCardInfo(10_000 + NODE_CARD_SETTLE_MS).cardSources, { a: "ia" }, "过了就报");
    const last = timers.filter((t) => !t.cleared).at(-1);
    assert.ok(last && last.ms >= NODE_CARD_SETTLE_MS, "起了一个到点通知的计时器");
    last.fn();
    assert.equal(notified, 2, "到点再通知订阅方");
    // 换代:身份变了就重新计时,旧身份不再报
    setNodeCardInfo({ cardRuntime: RUNTIME, userCards: true, graphCards: false, cardSources: { a: "ia2" } }, 50_000);
    assert.deepEqual(getNodeCardInfo(50_000 + 10).cardSources, {}, "换代后一小段时间不报(也不报旧身份)");
    assert.deepEqual(getNodeCardInfo(50_000 + NODE_CARD_SETTLE_MS).cardSources, { a: "ia2" });
    // cardEnvFingerprint 单独登记
    assert.equal(setNodeCardEnvFingerprint(CARDFP), true);
    assert.equal(setNodeCardEnvFingerprint(CARDFP), false);
    assert.equal(getNodeCardInfo(99_999_999).cardEnvFingerprint, CARDFP);
    setNodeCardEnvFingerprint(null);
    assert.equal(getNodeCardInfo(99_999_999).cardEnvFingerprint, null);
    off();
  } finally {
    __setNodeCardInfoTimers(null);
    resetNodeCardInfo();
  }
});

/* ================================================================== OCN-09 */

const TASK = (extra = {}) => ({
  id: "snapshot:rk-card:0-2", kind: "snapshot", tier: "shared", resultKey: "rk-card", range: { unit: "localFrame", from: 0, to: 2 },
  source: { projectId: "p1", projectRev: 7, userId: USER },
  input: { clipId: "c-u", cardId: "ouc-user", compositing: "independent", canvasHeavy: false, dual: true, bake: { start: 0, end: 0.1, count: 3, sampling: { phase: { numerator: 0, denominator: 1 } } } },
  weight: { class: "medium" },
  requires: { envFingerprint: CARDFP, codeVersion: "cv", cardSources: { "ouc-user": IDENT }, transcode: false, userCards: true, graphCards: false, belowDependent: false },
  ...extra,
});

function nodeRig({ info = null, cardFp = CARDFP } = {}) {
  let t = 1_000_000;
  const sent = [];
  const events = { cardFp: [] };
  const state = { info };
  const node = createBrowserNode({
    nodeId: "n-br", projectId: "p1", userId: USER, codeVersion: "cv", environment: { ...ENV.winNvidiaChrome },
    now: () => t, isIdle: () => true, send: (m) => { sent.push(JSON.parse(JSON.stringify(m))); return true; },
    keptProject: () => ({ rev: 7 }), fetchSnapshot: async () => null,
    bakeFrame: () => new Promise(() => {}), finishTask: async () => ({ v: 1 }),
    cardInfo: () => state.info,
    onCardEnvFingerprint: (fp) => events.cardFp.push(fp),
  });
  const welcome = (extra = {}) => node.receive({ type: "node.welcome", nodeId: "n-br", resumed: [], lost: [], envFingerprint: ENVFP, ...(cardFp ? { cardEnvFingerprint: cardFp } : {}), ...extra });
  return { node, sent, events, state, welcome, advance: (ms) => { t += ms; }, of: (type) => sent.filter((m) => m.type === type) };
}
const INFO = (extra = {}) => ({ cardRuntime: RUNTIME, userCards: true, graphCards: false, cardSources: { "ouc-user": IDENT }, ...extra });

test("OCN-09 browserNode:能执行时 node.hello 多报运行时版本(原始值,没有指纹);不能执行时 hello 与原来一字不差", () => {
  const plain = nodeRig({ info: null });
  plain.node.start();
  const h0 = plain.of("node.hello")[0];
  assert.equal("cardRuntime" in h0, false);
  assert.equal("cardEnvFingerprint" in h0, false);
  assert.equal("envFingerprint" in h0, false, "页面从不自报指纹");
  assert.deepEqual(Object.keys(h0).sort(), ["capabilities", "codeVersions", "environment", "maxConcurrent", "nodeId", "profile", "resume", "type"].sort());

  const rig = nodeRig({ info: INFO() });
  rig.node.start();
  const h = rig.of("node.hello")[0];
  assert.equal(h.cardRuntime, RUNTIME);
  assert.equal("cardEnvFingerprint" in h, false, "页面不自报 cardEnvFingerprint,由文档服务算");
  assert.equal(h.profile, "browser");
  assert.deepEqual(rig.of("queue.watch")[0].projects, ["p1"]);
});

test("OCN-09 browserNode:welcome 的 cardEnvFingerprint 记下并交给宿主;用户卡任务按它认领,代码身份与能力位都要对;内置卡任务照旧按 envFingerprint", async () => {
  const rig = nodeRig({ info: INFO() });
  rig.node.start();
  rig.welcome();
  assert.equal(rig.node.cardEnvFingerprint, CARDFP);
  assert.deepEqual(rig.events.cardFp, [CARDFP]);
  assert.equal(rig.node.envFingerprint, ENVFP);
  rig.node.tick();
  const d = rig.node.debug();
  assert.equal(d.cardEnvFingerprint, CARDFP);
  assert.deepEqual(d.cards, { runtime: RUNTIME, userCards: true, graphCards: false, sources: { "ouc-user": IDENT } });

  // 用户卡任务(指纹 cardEnvFingerprint):认领
  const task = TASK();
  rig.node.receive({ type: "queue.snapshot", tasks: [{ ...task, state: "open", version: 1 }] });
  rig.node.tick();
  await flush();
  assert.deepEqual(rig.of("task.claim").map((m) => m.id), [task.id], "对得上的用户卡任务认领");

  // 对不上的不认领:另一个身份、素材效果卡但没有图形能力、桌面那份指纹、别人的
  const other = nodeRig({ info: INFO({ cardSources: { "ouc-user": "other-version" } }) });
  other.node.start(); other.welcome();
  other.node.receive({ type: "queue.snapshot", tasks: [{ ...task, state: "open", version: 1 }] });
  other.node.tick();
  assert.equal(other.of("task.claim").length, 0, "页面手里是另一版代码");
  assert.equal(other.node.debug().counters.blocked["1:card-source"], 1);

  const noGraph = nodeRig({ info: INFO() });
  noGraph.node.start(); noGraph.welcome();
  const graphTask = TASK({ id: "snapshot:rk-g:0-2", resultKey: "rk-g", requires: { ...TASK().requires, graphCards: true } });
  noGraph.node.receive({ type: "queue.snapshot", tasks: [{ ...graphTask, state: "open", version: 1 }, { ...TASK({ id: "snapshot:rk-d:0-2", resultKey: "rk-d", requires: { ...TASK().requires, envFingerprint: DESK_FP } }), state: "open", version: 1 },
    { ...TASK({ id: "snapshot:rk-x:0-2", resultKey: "rk-x", source: { projectId: "p1", projectRev: 7, userId: "mallory@devB" } }), state: "open", version: 1 }] });
  noGraph.node.tick();
  assert.equal(noGraph.of("task.claim").length, 0);
  assert.deepEqual(Object.keys(noGraph.node.debug().counters.blocked).sort(), ["0:other-user", "1:env-fingerprint", "3:graph-cards"]);
  // 有图形能力:素材效果卡任务认领
  const withGraph = nodeRig({ info: INFO({ graphCards: true }) });
  withGraph.node.start(); withGraph.welcome();
  withGraph.node.receive({ type: "queue.snapshot", tasks: [{ ...graphTask, state: "open", version: 1 }] });
  withGraph.node.tick();
  assert.equal(withGraph.of("task.claim").length, 1);

  // 内置卡任务:照旧按 envFingerprint,不管有没有卡片登记
  const builtin = { ...TASK({ id: "snapshot:rk-b:0-2", resultKey: "rk-b", requires: { envFingerprint: ENVFP, codeVersion: "cv", cardSources: {}, transcode: false, userCards: false, graphCards: false, belowDependent: false } }), state: "open", version: 1 };
  const plain = nodeRig({ info: null });
  plain.node.start(); plain.welcome({ cardEnvFingerprint: undefined });
  plain.node.receive({ type: "queue.snapshot", tasks: [builtin, { ...task, state: "open", version: 1 }] });
  plain.node.tick();
  assert.deepEqual(plain.of("task.claim").map((m) => m.id), ["snapshot:rk-b:0-2"], "不能执行用户卡的页面只认内置卡的任务");
});

test("OCN-09 browserNode:运行时版本在报到之后才可报(闸门晚立起来)→ 重新报到一次、带手里的认领;文档服务没回 cardEnvFingerprint 时不报能力", () => {
  const rig = nodeRig({ info: null });
  rig.node.start();
  rig.welcome({ cardEnvFingerprint: undefined });
  rig.node.tick();
  assert.equal(rig.of("node.hello").length, 1);
  rig.state.info = INFO();
  rig.node.tick();
  const hellos = rig.of("node.hello");
  assert.equal(hellos.length, 2, "运行时版本可报了:再报到一次");
  assert.equal(hellos[1].cardRuntime, RUNTIME);
  rig.node.tick();
  assert.equal(rig.of("node.hello").length, 2, "welcome 没回来之前不反复报");
  rig.welcome();
  rig.node.tick();
  assert.equal(rig.node.debug().cards.userCards, true);
  assert.equal(rig.of("node.hello").length, 2);
  // 运行时版本又没了(闸门关了):重新报到,清掉
  rig.state.info = null;
  rig.node.tick();
  assert.equal(rig.of("node.hello").length, 3);
  assert.equal("cardRuntime" in rig.of("node.hello")[2], false);
  rig.welcome({ cardEnvFingerprint: undefined });
  assert.equal(rig.node.cardEnvFingerprint, null);
  assert.deepEqual(rig.events.cardFp, [CARDFP, null]);
  rig.node.tick();
  assert.deepEqual(rig.node.debug().cards, { runtime: null, userCards: false, graphCards: false, sources: {} });

  // 旧队列(welcome 不带 cardEnvFingerprint):报了运行时版本也不声明能力
  const old = nodeRig({ info: INFO(), cardFp: null });
  old.node.start(); old.welcome();
  old.node.tick();
  assert.equal(old.node.debug().cards.userCards, false);
  old.node.receive({ type: "queue.snapshot", tasks: [{ ...TASK(), state: "open", version: 1 }] });
  old.node.tick();
  assert.equal(old.of("task.claim").length, 0);
});

/* ================================================================== OCN-10 */

function timers() {
  const q = [];
  return {
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; q.push(t); return t; },
    clearTimer: (t) => { if (t) t.cleared = true; },
    fire: () => { const t = q.filter((x) => !x.cleared).pop(); if (t) { t.cleared = true; t.fn(); } return !!t; },
  };
}
function fakeQueue() {
  const sent = [];
  return { sent, request: async (msg) => {
    sent.push(msg);
    if (msg.type === "publisher.hello") return { type: "publisher.welcome" };
    if (msg.type === "task.publish") return { type: "task.published", results: msg.tasks.map((t) => ({ id: t.id, created: true, state: "open" })) };
    return { type: "error" };
  } };
}
const published = (q) => q.sent.filter((m) => m.type === "task.publish").map((m) => m.tasks[0]);

test("OCN-10 planPublisher:本页能运行的卡进 input.browser 与签名;不能运行时与原来逐字相同;登记变了重发;与队列侧逐字段相同", async () => {
  resetNodeCardInfo();
  const page = { cardEnvFingerprint: CARDFP, userCards: true, graphCards: false, cardSources: { b: "vb", a: "va" } };
  for (const codeVersion of [undefined, "cv-9"]) {
    const mine = clipsPlanTask({ projectId: "p1", projectRev: 7, clips: ["c2", "c1"], codeVersion, browser: page });
    const server = clipsPlanTaskOf({ projectId: "p1", projectRev: 7, clips: ["c2", "c1"], codeVersion, browser: page });
    assert.deepEqual(mine, server, "页面与队列侧两份实现逐字段相同(含签名)");
    assert.equal(parseInbound({ type: "task.publish", tasks: [mine] }).ok, true);
    assert.deepEqual(clipsPlanTask({ projectId: "p1", projectRev: 7, clips: ["c2", "c1"], codeVersion }), clipsPlanTaskOf({ projectId: "p1", projectRev: 7, clips: ["c2", "c1"], codeVersion }), "不带时也相同");
  }
  assert.deepEqual(browserCardsOf(page), serverBrowserCardsOf(page));
  assert.equal(browserCardsSig(browserCardsOf(page)), serverBrowserCardsSig(serverBrowserCardsOf(page)));

  // 默认读登记处
  assert.equal(browserCardsFromInfo({ cardRuntime: null, userCards: false, graphCards: false, cardSources: {}, cardEnvFingerprint: CARDFP }), null, "不能执行:不带");
  assert.equal(browserCardsFromInfo({ cardRuntime: RUNTIME, userCards: true, graphCards: false, cardSources: { a: "va" }, cardEnvFingerprint: null }), null, "没拿到 cardEnvFingerprint:不带");
  assert.equal(browserCardsFromInfo({ cardRuntime: RUNTIME, userCards: true, graphCards: false, cardSources: {}, cardEnvFingerprint: CARDFP }), null, "一张能运行的卡也没有:不带");
  const q = fakeQueue();
  const tm = timers();
  const pub = createPlanPublisher({ request: q.request, publisherId: "pg", clips: () => ["c1", "c2"], codeVersion: "cv-9", ...tm });
  try {
    pub.measured({ projectId: "p1", projectRev: 7 });
    tm.fire();
    await flush();
    const first = published(q)[0];
    assert.equal("browser" in first.input, false, "登记处是空的:计划与没有这个功能时相同");
    assert.deepEqual(first, clipsPlanTaskOf({ projectId: "p1", projectRev: 7, clips: ["c1", "c2"], codeVersion: "cv-9" }));

    // 节点报到、卡载入成功:登记变了 → 防抖后重发,input.browser 带上,是另一个计划
    setNodeCardEnvFingerprint(CARDFP);
    setNodeCardInfo({ cardRuntime: RUNTIME, userCards: true, graphCards: false, cardSources: { a: "va" } }, 0);
    assert.equal(tm.fire(), true, "登记变了排了一次重发");
    await flush();
    const second = published(q)[1];
    assert.deepEqual(second.input.browser, { cardEnvFingerprint: CARDFP, userCards: true, graphCards: false, cardSources: { a: "va" } });
    assert.notEqual(second.id, first.id);
    assert.equal(second.id, clipsPlanTaskOf({ projectId: "p1", projectRev: 7, clips: ["c1", "c2"], codeVersion: "cv-9", browser: second.input.browser }).id);
    // 换代:另一个计划
    setNodeCardInfo({ cardRuntime: RUNTIME, userCards: true, graphCards: false, cardSources: { a: "va2" } }, 0);
    assert.equal(tm.fire(), true);
    await flush();
    assert.notEqual(published(q)[2].id, second.id);
    assert.equal(published(q).length, 3);
    // 同一份登记不重发
    assert.equal(setNodeCardInfo({ cardRuntime: RUNTIME, userCards: true, graphCards: false, cardSources: { a: "va2" } }, 0), false);
  } finally {
    pub.dispose();
    resetNodeCardInfo();
  }
});

/* ================================================================== OCN-11 */

const CK = "c".repeat(64);
function planContext(OWN) {
  const control = {
    clipId: "clip-u", cardId: "ouc-user", snapshotKey: resultKeyOf(CK, OWN), contentKey: CK, tier: "shared", count: 6, start: 0, end: 0.2,
    sampling: { firstFrame: 0, step: 1 }, compositing: "independent", capabilities: { compositing: "independent" },
  };
  return {
    entryKey: "entry-1", cardPlan: [control], prerenderSet: new Set(["clip-u"]), streams: [], anchorFrames: [0],
    cardSourceVersions: { "ouc-user": IDENT }, weightOf: () => ({ class: "medium", estMs: null }), isUserCard: () => true, isGraphCard: () => false,
  };
}

test("OCN-11 整条链路:页面发清单计划(带本页能运行的卡)→ 桌面同机切分出两份 → 浏览器节点认领自己的 → 替身渲染并完成 → 层表候选含浏览器那份、别的成员贴得上;别人的任务与代码身份对不上的页面一个都不认领", async () => {
  resetNodeCardInfo();
  const rig = createDocQueueRig();
  rig.connect("page", memberPrincipal({ username: "zoe", device: "devA", role: "page" }));
  rig.connect("host", memberPrincipal({ username: "boss", device: "pc", role: "render" }));
  rig.connect("br", memberPrincipal({ username: "zoe", device: "devA", role: "render", owner: "browser" }));
  rig.connect("brX", memberPrincipal({ username: "zoe", device: "devA", role: "render", owner: "browser" }));
  rig.connect("brM", memberPrincipal({ username: "mallory", device: "devB", role: "render", owner: "browser" }));

  const handlers = new Map();
  const cursors = new Map();
  const pump = () => {
    for (const [conn, fn] of handlers) {
      const box = rig.inbox(conn);
      let i = cursors.get(conn) ?? 0;
      while (i < box.length) fn(box[i++]);
      cursors.set(conn, i);
    }
  };

  /* 切分方:桌面同机(env 指纹与浏览器相同)的独立主机,只切分不认领 */
  let afterSplitTasks = null;
  const hostEndpoint = { send: (m) => { rig.send("host", m); return true; }, onMessage: (h) => { handlers.set("host", h); } };
  const host = createLocalNode({
    nodeId: "HOST", endpoint: hostEndpoint, now: rig.now, random: () => 0, codeVersion: "cv-1", maxConcurrent: 1, projects: ["p1"],
    node: { profile: "host", envFingerprint: DESK_FP, codeVersions: ["cv-1"], cardSourceVersions: { "ouc-user": [IDENT] }, capabilities: { userCards: true, graphCards: true }, planOnly: true },
    executor: { plan: async () => planContext(DESK_FP), render: () => new Promise(() => {}), afterSplit: async (_t, { tasks }) => { afterSplitTasks = tasks; } },
    sink: { has: async () => false, put: async () => ({ complete: true }) },
  });

  /* 浏览器节点(本人,代码身份对)、本人但代码身份是另一版、别人的 */
  const bakes = [];
  const finishes = [];
  const makeBrowser = (conn, userId, cardInfo, extra = {}) => {
    const node = createBrowserNode({
      nodeId: `n-${conn}`, projectId: "p1", userId, codeVersion: "cv-1", environment: { ...ENV.winNvidiaChrome },
      now: rig.now, isIdle: () => true, send: (m) => { rig.send(conn, m); return true; },
      keptProject: (rev) => ({ rev }), fetchSnapshot: async () => null,
      bakeFrame: async ({ task, localFrame }) => { bakes.push({ conn, id: task.id, localFrame }); return { hash: sha(`${task.resultKey}:${localFrame}`), bytes: 100 + localFrame, small: null }; },
      finishTask: async ({ task, frames }) => { finishes.push({ conn, id: task.id, frames: frames.length }); return { v: 1, kind: "snapshot", resultKey: task.resultKey, frames: frames.map((f) => [f.localFrame, f.hash, f.bytes]) }; },
      cardInfo: () => cardInfo(), ...extra,
    });
    handlers.set(conn, (m) => node.receive(m));
    return node;
  };
  const infoFor = (identity) => () => ({ cardRuntime: RUNTIME, userCards: true, graphCards: false, cardSources: { "ouc-user": identity } });
  const br = makeBrowser("br", USER, () => getNodeCardInfo(), { onCardEnvFingerprint: (fp) => setNodeCardEnvFingerprint(fp) });
  const brX = makeBrowser("brX", USER, infoFor("not-the-same-version"));
  const brM = makeBrowser("brM", "mallory@devB", infoFor(IDENT));
  setNodeCardInfo({ cardRuntime: RUNTIME, userCards: true, graphCards: false, cardSources: { "ouc-user": IDENT } }, 0);

  const step = async (n = 6) => {
    for (let i = 0; i < n; i++) {
      await flush(3);
      pump();
      for (const node of [br, brX, brM]) node.tick();
      host.tick();
      rig.advance(300);
      rig.tick();
      pump();
    }
  };

  host.start();
  for (const node of [br, brX, brM]) node.start();
  await step(2);
  assert.equal(br.cardEnvFingerprint, CARDFP, "文档服务按运行时版本算给浏览器节点");
  assert.equal(getNodeCardInfo().cardEnvFingerprint, CARDFP, "宿主把它登记进登记处");
  assert.equal(brM.cardEnvFingerprint, CARDFP, "别人的页面算出同一个指纹(同环境同版本),但它拿不到本人的任务");

  /* 页面发清单计划:本页能运行的卡随计划交出 */
  rig.ask("page", { type: "publisher.hello", publisherId: "page-1" });
  const request = async (msg) => rig.ask("page", msg);
  const pub = createPlanPublisher({ request, publisherId: "page-1", clips: () => ["clip-u"], codeVersion: "cv-1", debounceMs: 0, nodeReady: () => "ready",
    // 防抖计时器换成立即执行:不靠真实计时
    setTimer: (fn) => { queueMicrotask(fn); return 0; }, clearTimer: () => {} });
  try {
    pub.measured({ projectId: "p1", projectRev: 7 });
    await step(12);
    const planId = pub.debug().last;
    assert.ok(planId, `页面发出了清单计划:${JSON.stringify(pub.debug().log)}`);
    const claimedPlan = rig.of("host", "task.claimed").find((m) => m.id === planId);
    assert.deepEqual(claimedPlan?.task.input.browser, { cardEnvFingerprint: CARDFP, userCards: true, graphCards: false, cardSources: { "ouc-user": IDENT } }, "本页能运行的卡随计划交到切分方");
    assert.deepEqual(claimedPlan.browserCardEnvFingerprints, [CARDFP], "文档服务确认有这样一台本人的在线节点");
    assert.equal(rig.describe().tasks.find((t) => t.id === planId)?.state, "done", "桌面同机的独立主机认领并切分");

    const spec = afterSplitTasks ?? [];
    const state = (id) => rig.describe().tasks.find((t) => t.id === id);
    const brCopy = spec.filter((t) => t.requires.envFingerprint === CARDFP).map((t) => ({ ...t, ...state(t.id) }));
    const deskCopy = spec.filter((t) => t.requires.envFingerprint === DESK_FP).map((t) => ({ ...t, ...state(t.id) }));
    assert.equal(brCopy.length, 1);
    assert.equal(deskCopy.length, 1);
    assert.equal(brCopy[0].resultKey, resultKeyOf(CK, CARDFP));
    assert.equal(deskCopy[0].resultKey, resultKeyOf(CK, DESK_FP));
    assert.notEqual(brCopy[0].resultKey, deskCopy[0].resultKey, "同一台机器上桌面与浏览器的结果键不同");

    /* 浏览器节点(本人、身份对)认领并完成;身份对不上的与别人的一个都没认领 */
    assert.equal(brCopy[0].state, "done", `浏览器那份完成:${JSON.stringify(brCopy[0])}`);
    assert.deepEqual(deskCopy.map((t) => [t.state, t.lastError]), [["failed", "superseded"]], "桌面那份作废:这一层只出自浏览器这一种环境");
    assert.deepEqual(bakes.map((b) => [b.conn, b.localFrame]), [0, 1, 2, 3, 4, 5].map((f) => ["br", f]), "六帧都由本人的页面生成");
    assert.deepEqual(finishes, [{ conn: "br", id: brCopy[0].id, frames: 6 }]);
    assert.equal(brX.debug().counters.claims, 0, "代码身份是另一版的页面不认领");
    assert.equal(brX.debug().counters.blocked["1:card-source"] ?? 0, 1);
    assert.equal(brM.debug().counters.claims, 0, "别人的页面不认领");
    assert.deepEqual(brM.debug().counters.blocked, {}, "连任务都看不见(服务端只给本人看)");
    assert.equal(rig.describe().locks.find((l) => l.lockKey === `snapshot:${CK}`)?.envFingerprint, CARDFP);

    /* 入库后别的成员能贴上:层表的候选里有浏览器那份,按「活着」认定就贴它 */
    const ctx = planContext(DESK_FP);
    const entry = { key: "entry-1", project: { id: "p1", fps: 30, width: 1920, height: 1080, tracks: [] }, cardPlan: ctx.cardPlan };
    const candidates = splitCandidatesOf(afterSplitTasks);
    assert.deepEqual(candidates.get(CK), [DESK_FP, CARDFP], "切分实际出键的指纹:桌面那份在前、浏览器那份在后");
    const table = layerMapOf(entry, { fingerprint: DESK_FP, span: 60, now: 0, candidatesOf: (c) => candidates.get(c.contentKey) ?? [] });
    assert.equal(table.v, 3);
    const layer = table.layers[0];
    assert.deepEqual(layer.candidates.map((c) => [c.envFingerprint, c.resultKey]), [[DESK_FP, resultKeyOf(CK, DESK_FP)], [CARDFP, resultKeyOf(CK, CARDFP)]]);
    const alive = new Set([brCopy[0].resultKey]);   // task.done 与清单认定它活着
    const picked = layerRefOf(table, "clip-u", { alive });
    assert.ok(picked, "别的成员按层表取到这一层");
    assert.equal(picked.envFingerprint, CARDFP);
    assert.equal(picked.resultKey, resultKeyOf(CK, CARDFP));
    assert.equal(layerRefOf(table, "clip-u", { alive: new Set() })?.envFingerprint, DESK_FP, "没有活着的候选时仍是第一个候选(桌面那份)");
  } finally {
    pub.dispose();
    host.stop();
    for (const node of [br, brX, brM]) node.stop();
    resetNodeCardInfo();
  }
});
