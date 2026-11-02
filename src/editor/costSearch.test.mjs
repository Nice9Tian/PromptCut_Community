/**
 * Page driver for bounds search when there is only one stage (`costSearch.ts`, formerly
 * `lowMemorySearch.ts`): test cases LS-01 to LS-08. Stage and document service connections are mocked.
 *
 *   LS-01 Fetch records → measure in that only stage (temporarily switch to back, run timing passes
 *          only, one reduced project at a time) → switch back to front, re-feed entirely, restore once
 *   LS-02 During measurement, costSearchMeasuring() is true (parent page uses this to not deliver
 *          snapshots or advance time), false after measurement completes; overlay state carries
 *          progress
 *   LS-03 Local reuse: all hit on second open, no measurement, no role switching, no restore
 *   LS-04 User cards and media effect cards that cannot run on this page do not participate and are
 *          treated as heavy cards; cards without records are measured individually (user decision,
 *          2026-10-07); direct cards invoke setTime(probe) frame by frame on random frames
 *   LS-05 Throw error when records cannot be fetched (caller retries later), stage is not touched at
 *          all; card interrupted by project re-feed restarts
 *   LS-06 Call beforeMeasure / afterMeasure before and after measuring each card (leaves crash records
 *          for on-demand render gate); genuinely measured records are written to document service
 *          (publish), hits from local reuse are not written
 *   LS-07 New cards added after search completes: catch-up measure those without records
 *          (measureNewCards); those with records are judged by existing bounds, not measured
 *   LS-08 After bounds search completes for two stages, the section producing sparse versions for
 *          cards classified as heavy: holdCostSearchMask raises overlay with progress,
 *          releaseCostSearchMask dismisses it
 *
 * Run: npm test -- src/editor/costSearch.test.mjs
 */
import { srcUrl } from "../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryCostStore, maxMeasurements } from "../render/boundarySearch.mjs";

const L = await import(srcUrl("editor/costSearch.ts"));

const FPS = 30;
const B = 1000 / FPS * 0.7;
const ENV = { platform: "iPhone", userAgent: "Mozilla/5.0 (iPhone) CriOS/152.0.0.0", renderer: "Apple GPU", vendor: "Apple Inc." };

/** n cards c00…, one clip each; identityKey = k<i> */
function fixture(n, { extra = [] } = {}) {
  const clips = Array.from({ length: n }, (_, i) => ({ id: `c${String(i).padStart(2, "0")}`, cardId: `card${i}`, start: i * 0.1, end: i * 0.1 + 2, params: {} }));
  for (const c of extra) clips.push(c);
  const project = { version: 1, name: "p", width: 640, height: 360, fps: FPS, duration: 20, themeId: "midnight", tracks: [{ id: "t", name: "t", clips }] };
  const identityKeys = Object.fromEntries(clips.map((c) => [c.id, `k${c.id.slice(1)}`]));
  const capabilities = new Map(clips.map((c) => [c.id, { frameMode: c.frameMode ?? "stateful" }]));
  return { project, identityKeys, capabilities };
}

/** Mock stage: returns timing pass based on the "local duration" of the card in current reduced project */
function fakeStage(localMs, log) {
  let current = null;
  let role = "front";
  return {
    role: () => role,
    setProject: (p) => { current = p; },
    async setRole(r) { role = r; log.push(`role:${r}`); return { ok: true }; },
    async setTime(t, opts = {}) {
      if (opts.probe) {
        if (role !== "back") return { aborted: true, reason: "role" };
        const clip = current.tracks[0].clips[0];
        log.push(`probe:${clip.id}@${t.toFixed(3)}`);
        return { path: "set", stepMs: localMs(clip.id) };
      }
      return { path: "set" };
    },
    async render(t, opts = {}) {
      if (role !== "back") return { aborted: true, reason: "role" };
      assert.equal(opts.probe, "time", "Only the timing pass runs, no snapshots are generated");
      const clip = current.tracks[0].clips[0];
      assert.equal(current.tracks.length, 1, "Only one clip is measured at a time");
      assert.equal(clip.start, 0, "The reduced project starts at 0");
      log.push(`time:${clip.id}`);
      assert.equal(L.costSearchMeasuring(), true, "costSearchMeasuring is true during measurement");
      const ms = localMs(clip.id);
      return { remounted: true, caughtUpAtSec: t, elapsedMs: ms * 20, stepMs: ms, steps: Array.from({ length: 20 }, () => ms) };
    },
    async rectsWithBounds() { return []; },
  };
}

function deps({ n = 12, local, records, store = createMemoryCostStore(), extra = [], unsupported = () => false, request }) {
  const f = fixture(n, { extra });
  const log = [];
  const stage = fakeStage(local, log);
  const pushed = [];
  let restores = 0;
  const d = {
    request: request ?? (async (msg) => {
      assert.equal(msg.type, "cost.list");
      assert.deepEqual(msg.environment, ENV, "The environment reports raw values only");
      return { type: "cost.listing", projectId: msg.projectId, records, truncated: false, envFingerprint: "f00dfacecafe0001" };
    }),
    projectId: "sp_testtesttesttesttesttestte",
    project: f.project,
    environment: ENV,
    identityKeys: f.identityKeys,
    capabilities: f.capabilities,
    unsupported,
    stage: () => stage,
    pushProject: async (p) => { pushed.push(p); stage.setProject(p); },
    restore: () => { restores++; },
    currentProject: () => f.project,
    store,
  };
  return { d, log, pushed, restores: () => restores, f };
}

const recordsFor = (n, rep = (i) => i + 1) => Array.from({ length: n }, (_, i) => ({ identityKey: `k${String(i).padStart(2, "0")}`, envFingerprint: "aaaaaaaaaaaaaaaa", stepMs: rep(i), samples: 16, measuredAt: 1, mode: "dev" }));

test("LS-01 Fetch records → measure in the one and only stage (temporarily switching to back) → switch back to front, reload the whole project, restore once; the light ones follow the search result", async () => {
  L.resetCostSearch();
  // Local duration = 3 × shared record: i ≤ 6 can run (21 ms), starts failing to run from 7
  const local = (clipId) => 3 * (Number(clipId.slice(1)) + 1);
  const { d, log, pushed, restores, f } = deps({ n: 12, local, records: recordsFor(12) });
  const out = await L.runCostSearch(d);
  assert.equal(out.envFingerprint, "f00dfacecafe0001");
  assert.deepEqual([...out.light].sort(), ["k00", "k01", "k02", "k03", "k04", "k05", "k06"]);
  assert.equal(out.result.boundary, 7);
  assert.ok(out.result.measurements <= maxMeasurements(12), `Measured ${out.result.measurements} times`);
  assert.equal(log[0], "role:back");
  assert.equal(log.at(-1), "role:front");
  assert.equal(log.filter((x) => x.startsWith("role:")).length, 2, "Only two role switches");
  assert.equal(log.filter((x) => x.startsWith("time:")).length, out.result.measurements);
  assert.equal(pushed.at(-1), f.project, "The whole project is reloaded after measurement");
  assert.equal(restores(), 1);
  assert.ok(B > 21 && B < 24);
});

test("LS-02 The overlay state carries progress during measurement, and measuring returns to false when done", async () => {
  L.resetCostSearch();
  const seen = [];
  const off = L.onCostSearch((s) => seen.push({ ...s }));
  const { d } = deps({ n: 30, local: () => 5, records: recordsFor(30) });
  const out = await L.runCostSearch(d);
  off();
  assert.equal(L.costSearchMeasuring(), false);
  assert.ok(seen.some((s) => s.measuring && s.estimate === maxMeasurements(30)));
  assert.equal(seen.at(-1).measuring, false);
  assert.equal(Math.max(...seen.map((s) => s.done)), out.result.measurements);
  assert.equal(out.light.size, 30, "All of them can keep up");
});

test("LS-03 Local reuse: on the second open everything hits, with no measurement, no role switch and no restore", async () => {
  L.resetCostSearch();
  const store = createMemoryCostStore();
  const local = (clipId) => (Number(clipId.slice(1)) < 5 ? 4 : 40);
  const first = deps({ n: 20, local, records: recordsFor(20), store });
  const a = await L.runCostSearch(first.d);
  assert.ok(a.result.measurements > 0);
  const again = deps({ n: 20, local: () => { throw new Error("Should not measure again"); }, records: recordsFor(20), store });
  const b = await L.runCostSearch(again.d);
  assert.equal(b.result.measurements, 0);
  assert.deepEqual(again.log, [], "The stage was not touched at all");
  assert.equal(again.restores(), 0);
  assert.deepEqual([...b.light].sort(), [...a.light].sort());
});

test("LS-04 User cards and media effect cards this page cannot run do not take part and are treated as heavy; cards without records are measured one by one; direct cards are measured frame by frame at random frames via setTime(probe)", async () => {
  L.resetCostSearch();
  const extra = [
    { id: "cuser", cardId: "user-card", start: 0, end: 2, params: {} },
    { id: "cnew", cardId: "brand-new", start: 0, end: 2, params: {} },
  ];
  const records = [...recordsFor(4), { identityKey: "kuser", envFingerprint: "aaaaaaaaaaaaaaaa", stepMs: 1, samples: 16, measuredAt: 1, mode: "dev" }];
  const { d, log } = deps({ n: 4, extra, local: () => 5, records, unsupported: (c) => c.cardId === "user-card" });
  d.capabilities.set("c01", { frameMode: "direct" });
  const out = await L.runCostSearch(d);
  assert.deepEqual(out.forcedHeavy, ["kuser"]);
  assert.ok(!out.light.has("kuser"), "A user card is not classified as light (even with a record)");
  assert.ok(out.light.has("knew"), "Cards without records are measured one by one: this machine runs it in 5 ms, classified as light");
  assert.deepEqual(out.result.unrecorded, ["knew"]);
  assert.ok(out.result.measured.has("knew"), "The card without a record was measured");
  assert.ok(log.includes("time:cnew"), "The card without a record was measured in the stage");
  assert.ok(!log.some((x) => x.includes("cuser")), "A user card this page cannot run is not measured");
  assert.ok(out.result.measured.has("k01"), "The leftover allowance measured k01");
  assert.ok(log.filter((x) => x.startsWith("probe:c01@")).length >= 8, "direct cards go through setTime(probe) frame by frame at random frames, at least 8 frames");
  assert.ok(!log.includes("time:c01"), "direct cards do not use the timing pass");
});

test("LS-05 If records cannot be fetched it throws and the stage is not touched at all; the card interrupted by a project reload is redone", async () => {
  L.resetCostSearch();
  const { d, log } = deps({ n: 3, local: () => 5, records: [], request: async () => ({ type: "error", reason: "forbidden" }) });
  await assert.rejects(L.runCostSearch(d), /forbidden/);
  assert.deepEqual(log, []);
  // Interruption: first timing pass returns 'project', second pass as usual
  const r = deps({ n: 2, local: () => 5, records: recordsFor(2) });
  const stage = r.d.stage();
  const orig = stage.render.bind(stage);
  let first = true;
  stage.render = async (t, o) => { if (first) { first = false; return { aborted: true, reason: "project", elapsedMs: 1 }; } return orig(t, o); };
  const out = await L.runCostSearch(r.d);
  assert.equal(out.light.size, 2, "Measured after the redo");
});

test("LS-06 Leave a crash record before measuring each card and clear it when finished; real measurements are written to the document service, local-reuse hits are not", async () => {
  L.resetCostSearch();
  const store = createMemoryCostStore();
  const marks = [];
  const published = [];
  const local = (clipId) => (Number(clipId.slice(1)) < 3 ? 4 : 40);
  const a = deps({ n: 6, local, records: recordsFor(6), store });
  a.d.beforeMeasure = (key, cardId) => marks.push(["before", key, cardId]);
  a.d.afterMeasure = (key) => marks.push(["after", key]);
  a.d.publish = (records) => { published.push(...records); };
  const out = await L.runCostSearch(a.d);
  const measuredKeys = out.result.trace.filter((t) => !t.cached).map((t) => t.key);
  assert.ok(measuredKeys.length > 0);
  // For each card measured: before first, then after, in pairs, ordered by measurement sequence
  assert.deepEqual(marks.filter((m) => m[0] === "before").map((m) => m[1]), measuredKeys);
  for (let i = 0; i < marks.length; i += 2) {
    assert.equal(marks[i][0], "before");
    assert.deepEqual(marks[i + 1], ["after", marks[i][1]], "Clear it as soon as that card is measured");
  }
  assert.equal(marks[0][2], `card${Number(measuredKeys[0].slice(1))}`, "Carries cardId (used by the viewer)");
  assert.deepEqual(published.map((r) => r.identityKey).sort(), [...measuredKeys].sort(), "All real measurements are written to the document service");
  for (const r of published) {
    assert.equal(typeof r.stepMs, "number");
    assert.ok(r.samples >= 1);
    assert.equal(r.mode, "build");
  }
  // Second opening: local reuse all hit; no measurement, no crash records left, no writes
  marks.length = 0;
  published.length = 0;
  const b = deps({ n: 6, local: () => { throw new Error("Should not measure again"); }, records: recordsFor(6), store });
  b.d.beforeMeasure = (key) => marks.push(["before", key]);
  b.d.publish = (records) => { published.push(...records); };
  await L.runCostSearch(b.d);
  assert.deepEqual(marks, []);
  assert.deepEqual(published, []);
});

test("LS-07 A new card added after the search: the one without a record is measured as a supplement, those with records are judged by the bounds and not measured", async () => {
  L.resetCostSearch();
  const local = (clipId) => (clipId === "cfresh" ? 3 : 3 * (Number(clipId.slice(1)) + 1));
  const first = deps({ n: 8, local, records: recordsFor(8) });
  const out = await L.runCostSearch(first.d);
  // Add two cards: one has a record (duration 1, falls on economical side of the bound), one has no record
  const extra = [
    { id: "crec", cardId: "rec-card", start: 0, end: 2, params: {} },
    { id: "cfresh", cardId: "fresh-card", start: 0, end: 2, params: {} },
  ];
  const second = deps({ n: 8, extra, local, records: recordsFor(8) });
  second.f.identityKeys.crec = "krec";
  second.f.identityKeys.cfresh = "kfresh";
  const outcome = { ...out, records: [...out.records, { identityKey: "krec", envFingerprint: "aaaaaaaaaaaaaaaa", stepMs: 1, samples: 16, measuredAt: 1, mode: "dev" }] };
  const marks = [];
  const next = await L.measureNewCards(outcome, { ...second.d, beforeMeasure: (key) => marks.push(key) });
  assert.deepEqual(marks, ["kfresh"], "Only the card without a record is measured as a supplement");
  assert.ok(second.log.includes("time:cfresh"));
  assert.ok(!second.log.some((x) => x.includes("crec")), "Cards with records are not measured");
  assert.ok(next.light.has("kfresh"), "The supplementary measurement gives 3 ms, classified as light");
  assert.ok(next.light.has("krec"), "Has a record and the representative time falls on the cheap side of the bounds, classified as light");
  assert.equal(second.restores(), 1, "After the supplementary measurement it still switches back, reloads and restores");
  // Nothing to catch-up measure: return as is, stage untouched
  const again = deps({ n: 8, extra, local: () => { throw new Error("Should not measure"); }, records: recordsFor(8) });
  again.f.identityKeys.crec = "krec";
  again.f.identityKeys.cfresh = "kfresh";
  const same = await L.measureNewCards(next, again.d);
  assert.equal(same, next);
  assert.deepEqual(again.log, []);
});

test("LS-08 The overlay stays up during the stretch that produces the sparse version after measurement: raised with progress, lowered back to empty", () => {
  const seen = [];
  const off = L.onCostSearch((st) => seen.push({ ...st }));
  L.holdCostSearchMask("punch-pill", 1, 3);
  assert.deepEqual({ ...L.costSearchState() }, { measuring: true, done: 1, estimate: 3, card: "punch-pill" });
  L.releaseCostSearchMask();
  assert.equal(L.costSearchState().measuring, false);
  assert.equal(L.costSearchState().card, null);
  const n = seen.length;
  L.releaseCostSearchMask();
  assert.equal(seen.length, n, "Taking it down when it is not up sends no notification");
  off();
});
