/**
 * Chunk N page side and full pipeline (`docs/plan/online-card-exec-contract.md` section 7,
 * task brief paragraph 2 item 16).
 * Wiring for actually executing user cards and media effect cards in the stage is not yet merged,
 * so "stand-in render output" (`bakeFrame` directly returns a deterministic hash) is used here to pin
 * down the pipeline: claim, fingerprint, result key, and pasting by other members once stored;
 * for actual end-to-end execution see `scripts/probes/online-card-node-probe.mjs`.
 *
 *   OCN-08 Registry: compute runnable cards, do not report briefly after generation change, subscribe
 *   OCN-09 browserNode: hello additionally reports runtime version, welcome's cardEnvFingerprint,
 *          capability bits and code identity, late-arriving runtime version re-checks in
 *   OCN-10 planPublisher: input.browser sent with manifest plan, included in signature, resent on
 *          registry change, field-by-field identical to queue side
 *   OCN-11 Full pipeline: page sends manifest plan → split (another copy on same machine as
 *          desktop) → browser node claims own → stand-in render → complete → layer table
 *          candidates include browser copy, other members paste from it; page claims none of
 *          others' tasks or tasks with mismatched code identity
 *
 * Run: node --experimental-test-module-mocks --test src/online/nodeCards.test.mjs
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
/** Desktop node on the same machine */
const DESK_FP = describeEnvironment({ platform: "win32", renderer: ENV.winNvidiaChrome.renderer, vendor: ENV.winNvidiaChrome.vendor, chromeVersion: "HeadlessChrome/152.0.7977.75" }).fingerprint;
const IDENT = "ab".repeat(16);
const USER = "zoe@devA";

/* ================================================================== OCN-08 */

test("OCN-08 registry: only cards that are ready and have a computable identity are registered; none when execution is impossible; after a generation change, reported only once NODE_CARD_SETTLE_MS has passed; subscribers are notified when due", () => {
  resetNodeCardInfo();
  const cards = [{ id: "a", source: "src/cards/user/a.tsx" }, { id: "b", source: "src/cards/user/b.tsx" }, { id: "c", source: "src/cards/user/c.tsx" }, { id: "d" }];
  const states = { a: "ready", b: "loading", c: "ready", d: "ready" };
  const identities = { "src/cards/user/a.tsx": "ia", "src/cards/user/b.tsx": "ib" };
  const info = computeNodeCardInfo({ runtime: RUNTIME, available: true, graphCapable: false, cards, stateOf: (id) => states[id], identities });
  assert.deepEqual(info, { cardRuntime: RUNTIME, userCards: true, graphCards: false, cardSources: { a: "ia" } }, "b is not ready yet, c has no computable identity, d has no entry file");
  assert.equal(computeNodeCardInfo({ runtime: RUNTIME, available: true, graphCapable: true, cards, stateOf: (id) => states[id], identities }).graphCards, true);
  assert.deepEqual(computeNodeCardInfo({ runtime: RUNTIME, available: false, graphCapable: true, cards, stateOf: () => "ready", identities }),
    { cardRuntime: null, userCards: false, graphCards: false, cardSources: {} }, "this page cannot execute: nothing at all");

  // Registration and generation change
  const timers = [];
  __setNodeCardInfoTimers({ set: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; }, clear: (t) => { t.cleared = true; } });
  try {
    let notified = 0;
    const off = subscribeNodeCardInfo(() => { notified++; });
    assert.equal(setNodeCardInfo({ cardRuntime: RUNTIME, userCards: true, graphCards: false, cardSources: { a: "ia" } }, 10_000), true);
    assert.equal(notified, 1);
    assert.equal(setNodeCardInfo({ cardRuntime: RUNTIME, userCards: true, graphCards: false, cardSources: { a: "ia" } }, 10_100), false, "No notification when nothing changed");
    assert.deepEqual(getNodeCardInfo(10_000 + NODE_CARD_SETTLE_MS - 1).cardSources, {}, "newly appeared card: not reported before it settles");
    assert.deepEqual(getNodeCardInfo(10_000 + NODE_CARD_SETTLE_MS).cardSources, { a: "ia" }, "reported once the time has passed");
    const last = timers.filter((t) => !t.cleared).at(-1);
    assert.ok(last && last.ms >= NODE_CARD_SETTLE_MS, "started a timer to notify when due");
    last.fn();
    assert.equal(notified, 2, "subscribers are notified when due");
    // Generation change: restart timer when identity changes; stop reporting old identity
    setNodeCardInfo({ cardRuntime: RUNTIME, userCards: true, graphCards: false, cardSources: { a: "ia2" } }, 50_000);
    assert.deepEqual(getNodeCardInfo(50_000 + 10).cardSources, {}, "not reported for a short time after a generation change (nor the old identity)");
    assert.deepEqual(getNodeCardInfo(50_000 + NODE_CARD_SETTLE_MS).cardSources, { a: "ia2" });
    // cardEnvFingerprint registered separately
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

test("OCN-09 browserNode: when it can execute, node.hello additionally reports the runtime version (raw value, no fingerprint); when it cannot execute, hello is identical to the original, character for character", () => {
  const plain = nodeRig({ info: null });
  plain.node.start();
  const h0 = plain.of("node.hello")[0];
  assert.equal("cardRuntime" in h0, false);
  assert.equal("cardEnvFingerprint" in h0, false);
  assert.equal("envFingerprint" in h0, false, "the page never reports a fingerprint itself");
  assert.deepEqual(Object.keys(h0).sort(), ["capabilities", "codeVersions", "environment", "maxConcurrent", "nodeId", "profile", "resume", "type"].sort());

  const rig = nodeRig({ info: INFO() });
  rig.node.start();
  const h = rig.of("node.hello")[0];
  assert.equal(h.cardRuntime, RUNTIME);
  assert.equal("cardEnvFingerprint" in h, false, "the page does not report cardEnvFingerprint itself, the document service computes it");
  assert.equal(h.profile, "browser");
  assert.deepEqual(rig.of("queue.watch")[0].projects, ["p1"]);
});

test("OCN-09 browserNode: the cardEnvFingerprint from welcome is recorded and handed to the host; user card tasks are claimed by it, and both the code identity and the capability bits must match; built-in card tasks are still claimed by envFingerprint", async () => {
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

  // User card task (fingerprint cardEnvFingerprint): claim
  const task = TASK();
  rig.node.receive({ type: "queue.snapshot", tasks: [{ ...task, state: "open", version: 1 }] });
  rig.node.tick();
  await flush();
  assert.deepEqual(rig.of("task.claim").map((m) => m.id), [task.id], "matching user card tasks are claimed");

  // Do not claim mismatches: different identity, media effect card without graphics capability,
  // desktop fingerprint, others'
  const other = nodeRig({ info: INFO({ cardSources: { "ouc-user": "other-version" } }) });
  other.node.start(); other.welcome();
  other.node.receive({ type: "queue.snapshot", tasks: [{ ...task, state: "open", version: 1 }] });
  other.node.tick();
  assert.equal(other.of("task.claim").length, 0, "the page holds a different version of the code");
  assert.equal(other.node.debug().counters.blocked["1:card-source"], 1);

  const noGraph = nodeRig({ info: INFO() });
  noGraph.node.start(); noGraph.welcome();
  const graphTask = TASK({ id: "snapshot:rk-g:0-2", resultKey: "rk-g", requires: { ...TASK().requires, graphCards: true } });
  noGraph.node.receive({ type: "queue.snapshot", tasks: [{ ...graphTask, state: "open", version: 1 }, { ...TASK({ id: "snapshot:rk-d:0-2", resultKey: "rk-d", requires: { ...TASK().requires, envFingerprint: DESK_FP } }), state: "open", version: 1 },
    { ...TASK({ id: "snapshot:rk-x:0-2", resultKey: "rk-x", source: { projectId: "p1", projectRev: 7, userId: "mallory@devB" } }), state: "open", version: 1 }] });
  noGraph.node.tick();
  assert.equal(noGraph.of("task.claim").length, 0);
  assert.deepEqual(Object.keys(noGraph.node.debug().counters.blocked).sort(), ["0:other-user", "1:env-fingerprint", "3:graph-cards"]);
  // With graphics capability: claim media effect card tasks
  const withGraph = nodeRig({ info: INFO({ graphCards: true }) });
  withGraph.node.start(); withGraph.welcome();
  withGraph.node.receive({ type: "queue.snapshot", tasks: [{ ...graphTask, state: "open", version: 1 }] });
  withGraph.node.tick();
  assert.equal(withGraph.of("task.claim").length, 1);

  // Built-in card tasks: use envFingerprint as before, regardless of whether cards are registered
  const builtin = { ...TASK({ id: "snapshot:rk-b:0-2", resultKey: "rk-b", requires: { envFingerprint: ENVFP, codeVersion: "cv", cardSources: {}, transcode: false, userCards: false, graphCards: false, belowDependent: false } }), state: "open", version: 1 };
  const plain = nodeRig({ info: null });
  plain.node.start(); plain.welcome({ cardEnvFingerprint: undefined });
  plain.node.receive({ type: "queue.snapshot", tasks: [builtin, { ...task, state: "open", version: 1 }] });
  plain.node.tick();
  assert.deepEqual(plain.of("task.claim").map((m) => m.id), ["snapshot:rk-b:0-2"], "a page that cannot execute user cards only claims built-in card tasks");
});

test("OCN-09 browserNode: the runtime version becomes reportable only after check-in (the gate is set up late) → check in once more, carrying the claims in hand; capabilities are not reported when the document service did not return cardEnvFingerprint", () => {
  const rig = nodeRig({ info: null });
  rig.node.start();
  rig.welcome({ cardEnvFingerprint: undefined });
  rig.node.tick();
  assert.equal(rig.of("node.hello").length, 1);
  rig.state.info = INFO();
  rig.node.tick();
  const hellos = rig.of("node.hello");
  assert.equal(hellos.length, 2, "the runtime version is reportable now: check in once more");
  assert.equal(hellos[1].cardRuntime, RUNTIME);
  rig.node.tick();
  assert.equal(rig.of("node.hello").length, 2, "does not report repeatedly before welcome comes back");
  rig.welcome();
  rig.node.tick();
  assert.equal(rig.node.debug().cards.userCards, true);
  assert.equal(rig.of("node.hello").length, 2);
  // Runtime version gone again (gate closed): check in again and clear
  rig.state.info = null;
  rig.node.tick();
  assert.equal(rig.of("node.hello").length, 3);
  assert.equal("cardRuntime" in rig.of("node.hello")[2], false);
  rig.welcome({ cardEnvFingerprint: undefined });
  assert.equal(rig.node.cardEnvFingerprint, null);
  assert.deepEqual(rig.events.cardFp, [CARDFP, null]);
  rig.node.tick();
  assert.deepEqual(rig.node.debug().cards, { runtime: null, userCards: false, graphCards: false, sources: {} });

  // Legacy queue (welcome without cardEnvFingerprint): do not declare capabilities even if runtime version reported
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

test("OCN-10 planPublisher: cards that can run on this page go into input.browser and the signature; identical to the original, character for character, when none can run; resent when the registry changes; identical field by field to the queue side", async () => {
  resetNodeCardInfo();
  const page = { cardEnvFingerprint: CARDFP, userCards: true, graphCards: false, cardSources: { b: "vb", a: "va" } };
  for (const codeVersion of [undefined, "cv-9"]) {
    const mine = clipsPlanTask({ projectId: "p1", projectRev: 7, clips: ["c2", "c1"], codeVersion, browser: page });
    const server = clipsPlanTaskOf({ projectId: "p1", projectRev: 7, clips: ["c2", "c1"], codeVersion, browser: page });
    assert.deepEqual(mine, server, "the page and queue-side implementations are identical field by field (including the signature)");
    assert.equal(parseInbound({ type: "task.publish", tasks: [mine] }).ok, true);
    assert.deepEqual(clipsPlanTask({ projectId: "p1", projectRev: 7, clips: ["c2", "c1"], codeVersion }), clipsPlanTaskOf({ projectId: "p1", projectRev: 7, clips: ["c2", "c1"], codeVersion }), "identical when not included too");
  }
  assert.deepEqual(browserCardsOf(page), serverBrowserCardsOf(page));
  assert.equal(browserCardsSig(browserCardsOf(page)), serverBrowserCardsSig(serverBrowserCardsOf(page)));

  // Read registry by default
  assert.equal(browserCardsFromInfo({ cardRuntime: null, userCards: false, graphCards: false, cardSources: {}, cardEnvFingerprint: CARDFP }), null, "cannot execute: not included");
  assert.equal(browserCardsFromInfo({ cardRuntime: RUNTIME, userCards: true, graphCards: false, cardSources: { a: "va" }, cardEnvFingerprint: null }), null, "did not get cardEnvFingerprint: not included");
  assert.equal(browserCardsFromInfo({ cardRuntime: RUNTIME, userCards: true, graphCards: false, cardSources: {}, cardEnvFingerprint: CARDFP }), null, "no card that can run: not included");
  const q = fakeQueue();
  const tm = timers();
  const pub = createPlanPublisher({ request: q.request, publisherId: "pg", clips: () => ["c1", "c2"], codeVersion: "cv-9", ...tm });
  try {
    pub.measured({ projectId: "p1", projectRev: 7 });
    tm.fire();
    await flush();
    const first = published(q)[0];
    assert.equal("browser" in first.input, false, "the registry is empty: the plan is the same as without this feature");
    assert.deepEqual(first, clipsPlanTaskOf({ projectId: "p1", projectRev: 7, clips: ["c1", "c2"], codeVersion: "cv-9" }));

    // Node checked in, card loaded successfully: registry changed → debounced resend,
    // include input.browser, which is a different plan
    setNodeCardEnvFingerprint(CARDFP);
    setNodeCardInfo({ cardRuntime: RUNTIME, userCards: true, graphCards: false, cardSources: { a: "va" } }, 0);
    assert.equal(tm.fire(), true, "the registry change scheduled one resend");
    await flush();
    const second = published(q)[1];
    assert.deepEqual(second.input.browser, { cardEnvFingerprint: CARDFP, userCards: true, graphCards: false, cardSources: { a: "va" } });
    assert.notEqual(second.id, first.id);
    assert.equal(second.id, clipsPlanTaskOf({ projectId: "p1", projectRev: 7, clips: ["c1", "c2"], codeVersion: "cv-9", browser: second.input.browser }).id);
    // Generation change: a different plan
    setNodeCardInfo({ cardRuntime: RUNTIME, userCards: true, graphCards: false, cardSources: { a: "va2" } }, 0);
    assert.equal(tm.fire(), true);
    await flush();
    assert.notEqual(published(q)[2].id, second.id);
    assert.equal(published(q).length, 3);
    // Do not resend for the same registration
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

test("OCN-11 full pipeline: the page sends a manifest plan (with the cards that can run on this page) → the desktop on the same machine splits it into two parts → the browser node claims its own → a stand-in renders and completes → the layer table candidates include the browser's part, and other members can attach to it; a page whose task belongs to someone else or whose code identity does not match claims none", async () => {
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

  /* Splitter: standalone host on same machine as desktop (same env fingerprint as browser), only splits, does not claim */
  let afterSplitTasks = null;
  const hostEndpoint = { send: (m) => { rig.send("host", m); return true; }, onMessage: (h) => { handlers.set("host", h); } };
  const host = createLocalNode({
    nodeId: "HOST", endpoint: hostEndpoint, now: rig.now, random: () => 0, codeVersion: "cv-1", maxConcurrent: 1, projects: ["p1"],
    node: { profile: "host", envFingerprint: DESK_FP, codeVersions: ["cv-1"], cardSourceVersions: { "ouc-user": [IDENT] }, capabilities: { userCards: true, graphCards: true }, planOnly: true },
    executor: { plan: async () => planContext(DESK_FP), render: () => new Promise(() => {}), afterSplit: async (_t, { tasks }) => { afterSplitTasks = tasks; } },
    sink: { has: async () => false, put: async () => ({ complete: true }) },
  });

  /* Browser node (self, matching code identity), self but different code identity version, others' */
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
  assert.equal(br.cardEnvFingerprint, CARDFP, "the document service computes it for the browser node from the runtime version");
  assert.equal(getNodeCardInfo().cardEnvFingerprint, CARDFP, "the host records it in the registry");
  assert.equal(brM.cardEnvFingerprint, CARDFP, "another person's page computes the same fingerprint (same environment, same version), but it cannot get this user's tasks");

  /* Page sends manifest plan: cards runnable on this page are provided with the plan */
  rig.ask("page", { type: "publisher.hello", publisherId: "page-1" });
  const request = async (msg) => rig.ask("page", msg);
  const pub = createPlanPublisher({ request, publisherId: "page-1", clips: () => ["clip-u"], codeVersion: "cv-1", debounceMs: 0, nodeReady: () => "ready",
    // Replace debounce timer with immediate execution: do not rely on real time
    setTimer: (fn) => { queueMicrotask(fn); return 0; }, clearTimer: () => {} });
  try {
    pub.measured({ projectId: "p1", projectRev: 7 });
    await step(12);
    const planId = pub.debug().last;
    assert.ok(planId, `the page sent a manifest plan: ${JSON.stringify(pub.debug().log)}`);
    const claimedPlan = rig.of("host", "task.claimed").find((m) => m.id === planId);
    assert.deepEqual(claimedPlan?.task.input.browser, { cardEnvFingerprint: CARDFP, userCards: true, graphCards: false, cardSources: { "ouc-user": IDENT } }, "cards that can run on this page are handed to the splitter along with the plan");
    assert.deepEqual(claimedPlan.browserCardEnvFingerprints, [CARDFP], "the document service confirms there is such an online node belonging to this user");
    assert.equal(rig.describe().tasks.find((t) => t.id === planId)?.state, "done", "the standalone host on the same desktop machine claims and splits it");

    const spec = afterSplitTasks ?? [];
    const state = (id) => rig.describe().tasks.find((t) => t.id === id);
    const brCopy = spec.filter((t) => t.requires.envFingerprint === CARDFP).map((t) => ({ ...t, ...state(t.id) }));
    const deskCopy = spec.filter((t) => t.requires.envFingerprint === DESK_FP).map((t) => ({ ...t, ...state(t.id) }));
    assert.equal(brCopy.length, 1);
    assert.equal(deskCopy.length, 1);
    assert.equal(brCopy[0].resultKey, resultKeyOf(CK, CARDFP));
    assert.equal(deskCopy[0].resultKey, resultKeyOf(CK, DESK_FP));
    assert.notEqual(brCopy[0].resultKey, deskCopy[0].resultKey, "on the same machine, the desktop and browser result keys differ");

    /* Browser node (self, matching identity) claims and completes; claims none with mismatched identity or belonging to others */
    assert.equal(brCopy[0].state, "done", `the browser's part completed: ${JSON.stringify(brCopy[0])}`);
    assert.deepEqual(deskCopy.map((t) => [t.state, t.lastError]), [["failed", "superseded"]], "the desktop's part is voided: this layer comes only from the browser environment");
    assert.deepEqual(bakes.map((b) => [b.conn, b.localFrame]), [0, 1, 2, 3, 4, 5].map((f) => ["br", f]), "all six frames are generated by this user's page");
    assert.deepEqual(finishes, [{ conn: "br", id: brCopy[0].id, frames: 6 }]);
    assert.equal(brX.debug().counters.claims, 0, "a page whose code identity is a different version does not claim");
    assert.equal(brX.debug().counters.blocked["1:card-source"] ?? 0, 1);
    assert.equal(brM.debug().counters.claims, 0, "other people's pages do not claim");
    assert.deepEqual(brM.debug().counters.blocked, {}, "the task is not even visible (the server only shows it to its owner)");
    assert.equal(rig.describe().locks.find((l) => l.lockKey === `snapshot:${CK}`)?.envFingerprint, CARDFP);

    /* Other members can paste once stored: layer table candidates include browser copy; paste it if deemed "alive" */
    const ctx = planContext(DESK_FP);
    const entry = { key: "entry-1", project: { id: "p1", fps: 30, width: 1920, height: 1080, tracks: [] }, cardPlan: ctx.cardPlan };
    const candidates = splitCandidatesOf(afterSplitTasks);
    assert.deepEqual(candidates.get(CK), [DESK_FP, CARDFP], "fingerprints of the keys actually produced by the split: the desktop app's first, the browser's second");
    const table = layerMapOf(entry, { fingerprint: DESK_FP, span: 60, now: 0, candidatesOf: (c) => candidates.get(c.contentKey) ?? [] });
    assert.equal(table.v, 3);
    const layer = table.layers[0];
    assert.deepEqual(layer.candidates.map((c) => [c.envFingerprint, c.resultKey]), [[DESK_FP, resultKeyOf(CK, DESK_FP)], [CARDFP, resultKeyOf(CK, CARDFP)]]);
    const alive = new Set([brCopy[0].resultKey]);   // task.done and manifest consider it alive
    const picked = layerRefOf(table, "clip-u", { alive });
    assert.ok(picked, "other members pick up this layer from the layer table");
    assert.equal(picked.envFingerprint, CARDFP);
    assert.equal(picked.resultKey, resultKeyOf(CK, CARDFP));
    assert.equal(layerRefOf(table, "clip-u", { alive: new Set() })?.envFingerprint, DESK_FP, "with no live candidates it is still the first candidate (the desktop app's)");
  } finally {
    pub.dispose();
    host.stop();
    for (const node of [br, brX, brM]) node.stop();
    resetNodeCardInfo();
  }
});
