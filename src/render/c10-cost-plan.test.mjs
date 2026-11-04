/**
 * C10 Remaining Section 3 (complete rules for bounds search; originally "low-memory tier",
 * changed on 2026-10-22 to "judge by bounds search when there is only one stage" and "lowest tier")
 * integrated into dispatch and export: test cases CP-01-CP-06 (CP-03 was deleted along with
 * revocation of prerender retry publisher, see below).
 *
 *   CP-01 planPipelines searchLight: cards in the set are classified as light at every
 *         position (not pushed out by budget), others (including those without identity) are
 *         classified as heavy at every position
 *   CP-02 planDispatch: when judging by bounds search, the judgment table follows its results;
 *         before search completes, all are classified as heavy and searchJudged is false;
 *         when not the lowest tier, the display table is the judgment table; in the lowest tier,
 *         the display table is always entirely classified as heavy
 *   CP-03 Prerender retry only for layers classified as heavy and lacking outputs: cards classified
 *         as light are not sent
 *   CP-04 Export: based on the judgment table, only verify and only fetch prerender original size
 *         for cards classified as heavy; cards classified as light (even if in the layer table)
 *         are rendered locally
 *   CP-05 Desktop unaffected: when both switches are off, the judgment table is the display table;
 *         when planPipelines is given no new options, results are identical field-by-field to original
 *   CP-06 searchLight and allHeavy given simultaneously: allHeavy takes precedence (for display)
 *
 * Run: node --experimental-test-module-mocks --test src/render/c10-cost-plan.test.mjs
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

test("CP-01 searchLight: cards judged light are judged light at every position (40 at once are not squeezed out either), all others and cards without identity are judged heavy at every position", () => {
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
  assert.ok(plan.prerenderSet.has("noid"), "a card without identity is judged heavy");
});

test("CP-02 planDispatch: the judgment table follows the search result; before the search completes everything is judged heavy and searchJudged=false; the display table at the lowest tier is always all judged heavy", async () => {
  mock.module(srcUrl("editor/stageBridge.ts"), { exports: { frontStage: () => null, backStage: () => null } });
  mock.module(srcUrl("editor/costIdentity.ts"), { exports: { clipIdentityOf: () => ({ identityKeys: { a: "ka", b: "kb", c: "kc" }, frameModes: { a: "direct", b: "direct", c: "direct" } }) } });
  // Cards in fixture must be defined in registry: "unknown cards" defined on neither side do not
  // enter dispatch table (starting from 2026-09-29, the stage does not render them)
  (await import(srcUrl("kernel/registry.ts"))).registerCards(["a", "b", "c"].map((id) => ({ id: `card-${id}`, name: id, defaults: {}, controls: [], frameMode: "direct", Component: () => null })));
  const d = await import(srcUrl("editor/planDispatch.ts"));
  d.resetPlanDispatch();
  const settle = () => new Promise((r) => queueMicrotask(r));
  d.setPlanProject(project([{ id: "a", start: 0, end: 2 }, { id: "b", start: 0, end: 2 }, { id: "c", start: 1, end: 3 }]));
  await settle();
  assert.equal(d.searchJudged(), true, "always true when not judging by boundary search");
  assert.equal(d.judgedPlan(), d.currentPlan(), "both switches off: the two tables are the same one");
  d.setPlanSearch(true);
  await settle();
  assert.equal(d.planSearch(), true);
  assert.equal(d.searchJudged(), false, "search not finished yet");
  assert.deepEqual([...d.judgedPlan().prerenderSet], ["a", "b", "c"], "with no result the judgment table is all judged heavy");
  d.setPlanSearchLight(["ka", "kc"]);
  assert.equal(d.searchJudged(), true);
  assert.deepEqual([...d.judgedPlan().prerenderSet], ["b"], "judgment table follows the search result (recomputed synchronously)");
  assert.equal(pipelineAt(d.judgedPlan(), "a", 1), "light");
  await settle();
  assert.equal(d.currentPlan(), d.judgedPlan(), "lean mode: the display table is the judgment table (cards judged light are still live rendered as usual)");
  d.setPlanLowest(true);
  await settle();
  assert.deepEqual([...d.currentPlan().prerenderSet], ["a", "b", "c"], "lowest tier: the display table is all judged heavy");
  assert.deepEqual([...d.judgedPlan().prerenderSet], ["b"], "the judgment table is unchanged");
  assert.deepEqual([...d.planSearchLight()].sort(), ["ka", "kc"]);
  d.setPlanLowest(false);
  d.setPlanSearch(false);
  await settle();
  assert.equal(d.planSearchLight(), null, "no longer judged by boundary search: discard the result");
  assert.equal(d.judgedPlan(), d.currentPlan());
  d.resetPlanDispatch();
});

/*
 * CP-03 (prerender retry only for layers classified as heavy and lacking outputs) was deleted:
 * `lowMemoryBackfill.ts` was revoked along with "prerender tasks for weak devices" (user decision,
 * 2026-10-07, tasks published by online pages always have normal priority); pages with only one stage
 * send manifest plans just like other pages, and the manifest is the clips classified as heavy in
 * the judgment table (`heavyCardClips` in `Preview.tsx`).
 */

const O = await import(srcUrl("export/originals.ts"));

test("CP-04 export: by the judgment table, only check and only fetch the prerender original size of cards judged heavy; cards judged light are rendered locally even if the layer map has them", async () => {
  const H = "a".repeat(64);
  const map = { kind: "layer-map", projectId: "proj", fps: 30, v: 2, span: 4, layers: [
    { clipId: "heavyCard", kind: "html", key: "k-h", resultKey: "rk-h", firstFrame: 0, count: 4, contentKey: "ck-h", envFingerprint: "0123456789abcdef" },
    { clipId: "lightCard", kind: "html", key: "k-l", resultKey: "rk-l", firstFrame: 0, count: 4, contentKey: "ck-l", envFingerprint: "0123456789abcdef" },
  ] };
  const request = async (msg) => {
    if (msg.key === "layers:proj") return { type: "content.item", body: map };
    if (msg.key === "rk-h:0-3") return { type: "content.item", body: { frames: [[0, H], [1, H], [2, H], [3, H]] } };
    return { type: "content.item", missing: true }; // Original size is missing for cards classified as light
  };
  const deps = { request, assetBase: () => "http://x/api/asset", authHeaders: async () => ({}) };
  const normal = await O.loadOriginalsIndex("proj", deps);
  assert.deepEqual(normal.missing, ["lightCard"], "no judgment table given: everything in the layer map counts as a heavy card, and missing ones must be waited for");
  const low = await O.loadOriginalsIndex("proj", deps, { onlyClips: ["heavyCard"] });
  assert.deepEqual(low.missing, [], "by the judgment table: cards judged light are not checked");
  assert.equal(low.hashAt("heavyCard", 2), H);
  assert.equal(low.hashAt("lightCard", 2), undefined, "cards judged light do not fetch the original size (rendered locally)");
  const noMap = await O.loadOriginalsIndex(null, deps, { fallbackHeavy: ["heavyCard", "lightCard"], onlyClips: ["heavyCard"] });
  assert.deepEqual(noMap.missing, ["heavyCard"]);
});

test("CP-05 desktop app unaffected: without the new options, the planPipelines result is identical field by field to before (run the same input twice, compare paths other than allHeavy)", () => {
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
  assert.deepEqual([...x.prerenderSet], ["b", "c"], "b measured over budget, c has no record and declares stateful");
});

test("CP-06 searchLight and allHeavy given together: allHeavy takes priority", () => {
  const plan = planPipelines(project([{ id: "a", start: 0, end: 1 }]), [], FPS, { identityKeys: { a: "ka" }, searchLight: ["ka"], allHeavy: true });
  assert.deepEqual([...plan.prerenderSet], ["a"]);
});

test("CP-07 on-demand render gate: a card whose measurement crashed is treated as a heavy card directly (recorded ones are pinned as heavy, unrecorded ones get an entry added), and is also removed from the judged-light set when judging by boundary search", async () => {
  const d = await import(srcUrl("editor/planDispatch.ts"));
  d.resetPlanDispatch();
  const settle = () => new Promise((r) => queueMicrotask(r));
  d.setPlanProject(project([{ id: "a", start: 0, end: 2 }, { id: "b", start: 0, end: 2 }, { id: "c", start: 1, end: 3 }]));
  await settle();
  assert.deepEqual([...d.currentPlan().prerenderSet], [], "all three that declare direct are judged light");
  d.setPlanForcedHeavy(["kb"]);
  await settle();
  assert.deepEqual([...d.currentPlan().prerenderSet], ["b"], "b, whose measurement crashed, is treated as a heavy card");
  d.setPlanSearch(true);
  d.setPlanSearchLight(["ka", "kb", "kc"]);
  await settle();
  assert.deepEqual([...d.judgedPlan().prerenderSet], ["b"], "still treated as a heavy card even if boundary search judges it light");
  d.setPlanForcedHeavy([]);
  d.resetPlanDispatch();
});
