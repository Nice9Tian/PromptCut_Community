/**
 * Online execution of user cards and media effect cards · Light/heavy and UI
 * (`docs/plan/online-card-exec-contract.md` sections 6 and 8). Run:
 *   node --experimental-test-module-mocks --test src/editor/onlineCardsL.test.mjs
 *
 *   OCE-L-01 "Cannot run on this page" heuristic (`placeholderHost.needsLocalPc`): media effect
 *            cards count as before; user cards count only if they cannot run: those in bundle at
 *            build time do not count (no tier blocking starting 2026-10-21); synced cards check
 *            run state (only `ready` does not count); desktop never counts
 *   OCE-L-02 Timeline no longer displays "Requires local PC rendering assistance" badge
 *            (user decision, 2026-10-21: removed): predicate function is gone, clips no longer
 *            reference it
 *   OCE-L-03 Measurement gate: after card sources finish syncing, wait until first load of synced
 *            cards has results (none in `loading`) before opening; both success and failure count;
 *            still capped by same limit; identical to original when no cards are loading
 *   OCE-L-04 Export: synced user cards and media effect cards must use prerendered original size
 *            whether classified as light or heavy (export page does not run their code); counted
 *            as missing if their layer is not in layer table or if no layer table; "Only verify
 *            cards classified as heavy" (by classification table) does not let them pass;
 *            verifying other cards remains as before
 *   OCE-L-05 Parameters panel descriptions follow run state: no description if runnable or still
 *            loading; remaining seven of nine each have a sentence (see `cardRunStates.ts` for text;
 *            former tenth removed with old tier on 2026-10-22)
 *   OCE-L-06 Wiring (verified against source): dispatch table, measurement, timeline clips all
 *            subscribe to run state; all six checks go through same `placeholderHost` function
 */
import { srcUrl } from "../testing/registerTs.mjs";
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

globalThis.window = globalThis;
mock.module(srcUrl("editor/stageBridge.ts"), { exports: { frontStage: () => null, backStage: () => null } });

const R = await import(srcUrl("kernel/registry.ts"));
const H = await import(srcUrl("render/placeholderHost.ts"));
const B = await import(srcUrl("editor/timeline/localPcBadge.ts"));
const G = await import(srcUrl("editor/measureGate.ts"));
const O = await import(srcUrl("export/originals.ts"));
const ERS = await import(srcUrl("editor/sync/cardRunStates.ts"));

const dom = (id, extra = {}) => ({ id, name: id, defaults: {}, controls: [], frameMode: "direct", Component: () => null, ...extra });
function setup() {
  R.resetCards();
  R.registerCards([dom("builtin"), dom("repo-user"), dom("av", { audio: () => new Float32Array(2) }),
    dom("gpu", { Component: undefined, card: () => ({}) }), dom("audio-only", { Component: undefined, audio: () => new Float32Array(2) })]);
  R.setUserCardSources({ "repo-user": "" }, { "repo-user": "repo-user" });
  R.setSyncedUserCards([{ id: "synced", name: "Synced card" }]);
  R.setCardRunStates([]);
  R.setRuntimeCards([]);
  H.setOnlineBrowserMode(true);
}
const cleanup = () => { H.setOnlineBrowserMode(false); R.setCardRunStates([]); R.setRuntimeCards([]); R.setSyncedUserCards([]); };
const local = (id) => H.unsupportedHere(id, R.getCard(id));

test("OCE-L-01 judging method for cards that cannot run on this page: media effect cards as before; user cards depend on whether they can run; no separate blocking by tier; desktop never counts", () => {
  setup();
  try {
    assert.equal(local("builtin"), false);
    assert.equal(local("av"), false, "The built-in audio motion card renders as an ordinary DOM card");
    assert.equal(local("gpu"), true, "Media effect card: online execution is not enabled yet, counted as before");
    assert.equal(local("audio-only"), true);
    assert.equal(local("repo-user"), false, "Repo user card that is already in the bundle at build time: can run on this page");
    assert.equal(local("nobody"), false, "An id that exists on neither side (unknown card) does not count");
    assert.equal(local("synced"), true, "Synced in, no run state yet: counts");
    for (const state of R.CARD_RUN_STATES) {
      R.setCardRunStates([["synced", { state }]]);
      assert.equal(local("synced"), state !== "ready", `Run state ${state}`);
    }
    // In the environment executing it (stage): successful load means a definition exists in runtime
    // registry
    R.setCardRunStates([]);
    R.setRuntimeCards([dom("synced")]);
    assert.equal(local("synced"), false, "A synced card that loaded successfully in the stage");
    R.setRuntimeCards([dom("synced", { Component: undefined, card: () => ({}) })]);
    assert.equal(local("synced"), true, "A synced media effect card loaded in the stage: media effect cards count as before");
    R.setRuntimeCards([]);
    // Starting 2026-10-21, do not block user cards by tier (the switch blocking by tier and that run
    // state were deleted on 2026-10-22): those runnable on this page run as usual; pause and catch up
    // exact frames
    R.setCardRunStates([["synced", { state: "not-isolated" }]]);
    assert.equal(local("repo-user"), false, "A build-time user card can run on this page, does not count");
    assert.equal(local("synced"), true, "Synced card run state is not ready: counts");
    assert.equal(local("builtin"), false);
    assert.deepEqual([...H.localOnlyClipIds([{ id: "a", cardId: "builtin" }, { id: "b", cardId: "repo-user" }, { id: "c", cardId: "synced" }, { id: "d", cardId: "gpu" }])], ["c", "d"]);
    R.setCardRunStates([["synced", { state: "ready" }]]);
    assert.deepEqual([...H.localOnlyClipIds([{ id: "a", cardId: "builtin" }, { id: "b", cardId: "repo-user" }, { id: "c", cardId: "synced" }, { id: "d", cardId: "gpu" }])], ["d"]);
    // Desktop (mode is off)
    H.setOnlineBrowserMode(false);
    for (const id of ["repo-user", "synced", "gpu", "audio-only"]) assert.equal(local(id), false, `Desktop: ${id}`);
    assert.equal(H.localOnlyClipIds([{ id: "d", cardId: "gpu" }]).size, 0);
  } finally { cleanup(); }
});

test("OCE-L-02 the timeline no longer carries the \"Needs local PC render assistance\" badge", () => {
  assert.equal(B.showLocalPcBadge, undefined, "The decision function was removed");
  assert.equal(B.clipCardLabel("x"), "x", "Card name unchanged");
  const clipView = fs.readFileSync(fileURLToPath(srcUrl("editor/timeline/ClipView.tsx")), "utf8");
  assert.doesNotMatch(clipView, /clip-custom-card|ONLINE_CUSTOM_CARD_TEXT|showLocalPcBadge/);
});

function fakeClock() {
  let now = 0, seq = 0;
  const timers = new Map();
  return { now: () => now, setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: now + ms }); return id; }, clearTimer: (id) => { timers.delete(id); },
    advance(ms) { now += ms; for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); t.fn(); } } };
}

test("OCE-L-03 measurement gate: after card source sync finishes, also wait until the first load of synced cards has a result; still capped by the limit", () => {
  globalThis.__pcOnlinePage = true;
  try {
    R.setSyncedUserCards([{ id: "x", name: "x" }, { id: "y", name: "y" }]);
    // No cards loading: same as before, opens once sync finishes
    R.setCardRunStates([["x", { state: "not-isolated" }]]);
    let clock = fakeClock();
    G.resetMeasureGate(clock);
    assert.equal(G.measureGateOpen(), false);
    G.releaseMeasureGate(true);
    assert.equal(G.measureGateOpen(), true);
    assert.equal(G.measureGateDiag().reason, "synced");

    // A card is still loading: do not open yet even after sync finishes
    R.setCardRunStates([["x", { state: "loading" }], ["y", { state: "loading" }]]);
    clock = fakeClock();
    G.resetMeasureGate(clock);
    assert.equal(G.measureGateOpen(), false);
    G.releaseMeasureGate(true);
    assert.equal(G.measureGateOpen(), false, "Source sync finished but a card is still loading: not open");
    R.setCardRunStates([["x", { state: "ready", version: "1" }], ["y", { state: "loading" }]]);
    assert.equal(G.measureGateOpen(), false, "One more is still loading: not open");
    R.setCardRunStates([["x", { state: "ready", version: "1" }], ["y", { state: "load-error", detail: "boom" }]]);
    assert.equal(G.measureGateOpen(), true, "All have a result (success and failure both count): open");
    assert.equal(G.measureGateDiag().reason, "synced");

    // Keeps loading: open anyway once the limit is reached
    R.setCardRunStates([["x", { state: "loading" }]]);
    clock = fakeClock();
    G.resetMeasureGate(clock);
    assert.equal(G.measureGateOpen(), false);
    G.releaseMeasureGate(true);
    clock.advance(G.MEASURE_GATE_MAX_MS - 1);
    assert.equal(G.measureGateOpen(), false);
    clock.advance(1);
    assert.equal(G.measureGateOpen(), true);
    assert.equal(G.measureGateDiag().reason, "timeout");
    // Once opened, subsequent changes to runtime status do not affect the gate
    R.setCardRunStates([["x", { state: "ready", version: "2" }]]);
    assert.equal(G.measureGateOpen(), true);

    // Source code sync returned failure and is stuck loading: wait for a result, reason is failed
    R.setCardRunStates([["x", { state: "loading" }]]);
    clock = fakeClock();
    G.resetMeasureGate(clock);
    G.measureGateOpen();
    G.releaseMeasureGate(false);
    assert.equal(G.measureGateOpen(), false);
    R.setCardRunStates([["x", { state: "unsupported-syntax", detail: "namespace" }]]);
    assert.equal(G.measureGateOpen(), true);
    assert.equal(G.measureGateDiag().reason, "failed");
  } finally {
    delete globalThis.__pcOnlinePage;
    G.resetMeasureGate();
    R.setCardRunStates([]);
    R.setSyncedUserCards([]);
  }
});

test("OCE-L-04 export: synced cards must use the original-size prerender, and if it is missing it counts as missing; checks for other cards are unchanged", async () => {
  const HASH = "a".repeat(64);
  const layer = (clipId, rk) => ({ clipId, kind: "html", key: `k-${clipId}`, resultKey: rk, firstFrame: 0, count: 4, contentKey: `ck-${clipId}`, envFingerprint: "0123456789abcdef" });
  const frames = { frames: [[0, HASH], [1, HASH], [2, HASH], [3, HASH]] };
  const depsOf = (layers, ready) => ({ assetBase: () => "http://x/api/asset", authHeaders: async () => ({}),
    request: async (msg) => {
      if (msg.key === "layers:proj") return layers ? { type: "content.item", body: { kind: "layer-map", projectId: "proj", fps: 30, v: 2, span: 4, layers } } : { type: "content.item", missing: true };
      const rk = String(msg.key).split(":")[0];
      return ready.includes(rk) ? { type: "content.item", body: frames } : { type: "content.item", missing: true };
    } });

  // Layer table has layers for heavy cards; synced card s1 has complete layers, s2 has no layers
  const deps = depsOf([layer("heavy", "rk-h"), layer("s1", "rk-s1")], ["rk-h", "rk-s1"]);
  const base = await O.loadOriginalsIndex("proj", deps);
  assert.deepEqual(base.missing, [], "Without requiredClips: same as before");
  assert.equal(base.hashAt("s2", 1), undefined, "Before: cards missing from the layer table are still live rendered");
  const idx = await O.loadOriginalsIndex("proj", deps, { requiredClips: ["s1", "s2"] });
  assert.deepEqual(idx.missing, ["s2"], "Must use the original size but the layer table has no layer: counts as missing (the pre-export check blocks it and waits for the render node)");
  assert.equal(idx.hashAt("s1", 1), HASH, "Those with a layer are fetched as usual");
  assert.equal(idx.hashAt("s2", 1), null, "Missing ones return null (not undefined: live render is not allowed)");
  assert.equal(idx.hashAt("heavy", 1), HASH);
  assert.equal(idx.hashAt("light", 1), undefined, "Other cards unchanged");

  // "Only check cards classified as heavy" (by classification table) does not let synced cards pass
  const low = await O.loadOriginalsIndex("proj", deps, { onlyClips: ["heavy"], requiredClips: ["s1", "s2"] });
  assert.deepEqual(low.missing, ["s2"]);
  assert.equal(low.hashAt("s1", 2), HASH, "Even if the page classifies it as light, the original size is still fetched");

  // Synced card has layers but incomplete frames: still counted as missing
  const partial = await O.loadOriginalsIndex("proj", depsOf([layer("s1", "rk-s1")], []), { requiredClips: ["s1"] });
  assert.deepEqual(partial.missing, ["s1"]);

  // No layer table: cards classified as heavy by the page and those requiring original size are both
  // counted as missing
  const noMap = await O.loadOriginalsIndex("proj", depsOf(null, []), { fallbackHeavy: ["heavy"], requiredClips: ["s1"] });
  assert.deepEqual(noMap.missing.sort(), ["heavy", "s1"]);
  assert.equal(noMap.hashAt("s1", 0), null);
  assert.equal(noMap.hashAt("light", 0), undefined);
});

test("OCE-L-05 the note in the parameters panel follows the run state", () => {
  const silent = ["ready", "loading"];
  for (const state of R.CARD_RUN_STATES) {
    const text = ERS.runStateMessage({ state });
    if (silent.includes(state)) assert.equal(text, null, `${state} shows no note`);
    else assert.ok(typeof text === "string" && text.length > 8, `${state} has a note`);
  }
  assert.match(ERS.runStateMessage({ state: "missing-module", detail: "lodash" }), /references a module that is not available on the online page: lodash/);
  assert.equal(R.CARD_RUN_STATES.length, 9, "Nine run states (the former tenth was removed along with the old tier)");
  // Panel component reads runtime status from the registry and subscribes to it
  const form = fs.readFileSync(fileURLToPath(srcUrl("editor/left/ParamsForm.tsx")), "utf8");
  assert.match(form, /useSyncExternalStore\(onCardRunStatesChanged, cardRunStatesGen\)/);
  assert.match(form, /runStateMessage\(/);
  assert.match(form, /data-pc="params-run-state"/);
});

test("OCE-L-06 wiring: when the run state changes, the dispatch table, measurement, timeline clips and the feed memo all follow; five places decide with the same function", () => {
  const read = (rel) => fs.readFileSync(fileURLToPath(srcUrl(rel)), "utf8");
  assert.match(read("editor/planDispatch.ts"), /onCardRunStatesChanged\(\(\) => schedule\(\)\)/, "The dispatch table is recomputed");
  assert.match(read("editor/ProbeGate.tsx"), /onCardRunStatesChanged\(\(\) => \{[\s\S]*?requeueProbeRun\(getState\(\)\.project\)/, "Measurement is re-queued (a card that has just loaded successfully is measured right away)");
  assert.match(read("editor/Preview.tsx"), /onPlanUpdated\(trigger\)[\s\S]*?onCardRunStatesChanged\(trigger\)/, "In the paused state, the current frame is recomputed after a synced card becomes ready and after the measurement dispatch is updated");
  assert.match(read("editor/timeline/ClipView.tsx"), /useSyncExternalStore\(onCardRunStatesChanged, cardRunStatesGen\)/, "Timeline clips are redrawn");
  assert.match(read("editor/snapshotFeed.ts"), /cardRunStatesGen\(\)/, "The memo on the feed side carries the run-state generation");
  assert.match(read("editor/costIdentity.ts"), /cardRunStatesGen\(\)/, "The cost identity memo carries the run-state generation");
  // All places in section 6 of the contract go through `localOnlyClipIds` / `unsupportedHere` /
  // `needsLocalPc`, without checking "whether it is a user card" on their own
  for (const [rel, re] of [
    ["editor/costIdentity.ts", /localOnlyClipIds\(/], ["editor/snapshotFeed.ts", /localOnlyClipIds\(/],
    ["StageView.tsx", /localOnlyClipIds\(/], ["render/Stage.tsx", /unsupportedHere\(clip\.cardId, def\)/],
  ]) {
    const text = read(rel);
    assert.match(text, re, `${rel} uses the same judging method`);
    assert.doesNotMatch(text, /isUserCardId\(/, `${rel} does not judge "is it a user card" by itself`);
  }
  // After removing snapshots, stageSwap no longer directly projects snapshots; snapshotFeed.streamPlanesAt /
  // suppressedAt takes over uniformly, without checking "whether it is a user card" on its own
  assert.doesNotMatch(read("editor/stageSwap.ts"), /isUserCardId\(/, "editor/stageSwap.ts does not judge \"is it a user card\" by itself");
});

test("OCE-L-07 during export, ask the render node to fill in the original size of synced cards: record, dedupe, notify, clear; the manifest plan merges them in", async () => {
  const W = await import(srcUrl("export/exportWanted.ts"));
  let calls = 0;
  const off = W.subscribeExportWanted(() => { calls++; });
  try {
    assert.deepEqual([...W.exportWantedClips()], []);
    W.setExportWantedClips(["s2", "s1", "s2"]);
    assert.deepEqual([...W.exportWantedClips()], ["s1", "s2"]);
    assert.equal(calls, 1);
    W.setExportWantedClips(["s1", "s2"]);
    assert.equal(calls, 1, "No notification when nothing changed");
    W.setExportWantedClips([]);
    assert.deepEqual([...W.exportWantedClips()], []);
    assert.equal(calls, 2);
  } finally { off(); W.setExportWantedClips([]); }
  const read = (rel) => fs.readFileSync(fileURLToPath(srcUrl(rel)), "utf8");
  const exp = read("export/onlineExport.ts");
  // As of 2026-10-13, online export is divided into "Fast export" and "Full export": synced card visuals
  // no longer rely on regular manifest plans to supplement "prerender original size" (HTML snapshot of
  // each card); instead, export issues an export-only plan and requests render nodes to render frame by
  // frame (`export/exportFrames.ts`). Export no longer records anything into this table; the table and
  // the manifest-merging spot in `Preview.tsx` are kept (always empty), to be deleted with snapshot removal
  assert.doesNotMatch(exp, /setExportWantedClips/, "Export no longer merges synced card clips into the usual manifest plan");
  assert.match(exp, /nonRunnable: \(\) => nonRunnableClips\(p\)/, "Synced cards are handled as \"not executed on this page\"");
  assert.match(exp, /cardLayers: cardLayerDeps\(\)/, "Export prepares the ready-made sources of card pictures itself");
  assert.match(read("editor/Preview.tsx"), /\[\.\.\.plan\.prerenderSet, \.\.\.exportWantedClips\(\)\]/, "The manifest plan published by the page merges in this table (always empty now)");
});
