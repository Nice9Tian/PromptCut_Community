/**
 * Browser produces streams for cards in cut segments ([ruling] R02): snapshot generation job
 * (`stageBake.ts`) feeds cards in cut segments (virtual clips flattened out) an isolated project
 * with the cut segment chain, and each frame's request carries `frameBase` (which project frame
 * local frame 0 corresponds to); top-level cards remain as before (isolated single-card project,
 * without `frameBase`). Does not launch a browser; the stage is fake.
 *
 *   QM-FLAT-01 Cards in cut segments: fed project top level only has cut segment, referenced cut
 *   only has target card (time not shifted); request carries frameBase = first frame of card
 *   QM-FLAT-02 Top-level cards: feeds isolated single-card project, request does not carry
 *   frameBase (verbatim identical to before)
 *
 * Run: npm test -- src/editor/stageBakeFlat.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { createStageBaker } = await import("./stageBake.ts");

const PROJECT = {
  id: "p", fps: 30, duration: 10, width: 1280, height: 720, activeCutId: "A",
  tracks: [
    { id: "t1", clips: [{ id: "top", cardId: "punch-pill", start: 0, end: 4, params: { text: "top" } }] },
    { id: "t2", clips: [{ id: "S", cardId: "", cutId: "B", start: 1, end: 5, cutOffset: 0.5, params: {}, frame: { x: 0, y: 0, w: 640, h: 360 } }] },
  ],
  cuts: [
    { id: "A", name: "Main" },
    { id: "B", name: "Inner", duration: 8, tracks: [
      { id: "b1", clips: [{ id: "m", cardId: "punch-pill", start: 0, end: 8, params: { text: "m" }, opacity: 0.5 }] },
      { id: "b2", clips: [{ id: "n", cardId: "caption-track", start: 0, end: 8, params: {} }] },
    ] },
  ],
};

function harness() {
  const pushed = [], requests = [];
  let listener = null;
  const stage = {
    async bakeFrame(req) {
      requests.push(req);
      const ev = { type: "bake-frame", session: req.session, clipId: req.clipId, localFrame: req.localFrame, hash: `h${req.localFrame}`, bytes: 1 };
      listener?.(ev);
      return { ok: true, localFrame: req.localFrame, hash: `h${req.localFrame}`, bytes: 1, small: null, ms: 1, pausedMs: 0, remounted: false, smallMs: 0, readyMs: 0 };
    },
    async bakeCancel() { return { ok: true }; },
  };
  const baker = createStageBaker({
    runBackJob: async (_kind, run) => run({ stage, signal: new AbortController().signal }),
    backStage: () => stage,
    pushProject: async (_role, project) => { pushed.push(project); },
    onStageEvent: (l) => { listener = l; return () => { listener = null; }; },
    onUrgent: () => {}, isIdle: () => false, mode: "seq", small: false,
  });
  return { baker, pushed, requests };
}
const taskOf = (clipId, bake) => ({ id: `stream:k:${clipId}`, kind: "stream", range: { unit: "segment", from: 0, to: 0 }, input: { clipId, bake } });

test("QM-FLAT-01 A card inside a cut segment: push an isolated project carrying the cut-segment chain, and the request carries frameBase", async () => {
  const { baker, pushed, requests } = harness();
  const task = taskOf("S~m", { start: 1, end: 5, count: 120, sampling: { firstFrame: 30, phase: { numerator: "0", denominator: "1" } } });
  const signal = new AbortController().signal;
  await baker.bakeFrame({ task, project: PROJECT, localFrame: 0, signal, ahead: null });
  await baker.bakeFrame({ task, project: PROJECT, localFrame: 5, signal, ahead: null });
  baker.close();
  assert.equal(pushed.length, 1, "The same segment is pushed only once");
  const iso = pushed[0];
  assert.deepEqual(iso.tracks.filter((t) => !t.hidden).flatMap((t) => t.clips).map((c) => [c.id, c.start]), [["S", 1]], "The top level has only the cut segment, and time is not shifted");
  const inner = iso.cuts.find((c) => c.id === "B").tracks.filter((t) => !t.hidden).flatMap((t) => t.clips);
  assert.deepEqual(inner.map((c) => c.id), ["m"], "The referenced cut contains only the target card");
  assert.equal(inner[0].opacity, undefined, "The target card's own appearance is removed (added by its wrapper layer on the stage)");
  assert.deepEqual(requests.map((r) => [r.clipId, r.localFrame, r.frameBase]), [["S~m", 0, 30], ["S~m", 5, 30]]);
});

test("QM-FLAT-02 A top-level card: an isolated single-card project, and the request carries no frameBase", async () => {
  const { baker, pushed, requests } = harness();
  const task = taskOf("top", { start: 0, end: 4, count: 120, sampling: { firstFrame: 0, phase: { numerator: "0", denominator: "1" } } });
  await baker.bakeFrame({ task, project: PROJECT, localFrame: 3, signal: new AbortController().signal, ahead: null });
  baker.close();
  assert.deepEqual(pushed[0].tracks.filter((t) => !t.hidden).flatMap((t) => t.clips).map((c) => c.id), ["top"]);
  assert.equal(requests.length, 1);
  assert.equal("frameBase" in requests[0], false, "The request for a top-level card has no frameBase");
});
