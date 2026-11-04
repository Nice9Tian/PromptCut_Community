/**
 * Unit tests for kernel/cutSegments.ts and cut-segment-related parts in cuts.ts.
 * Run: npm test -- src/kernel/cutSegments.test.mjs
 *
 * Pinned down:
 *   - New projects / legacy files without cuts have only "Cut 1"; projects with cuts stay as-is;
 *   - Circular references (self, A→B→A, A→B→C→A) are rejected on placement with a clear reason;
 *   - Dangling references, cycles from collaboration merge: skipped on render side, do not throw;
 *   - Deleting a referenced cut: cut segments referencing it are deleted together with transitions;
 *   - Cut segment clips produced by subproject rendering, preroll, and flattenOverlay;
 *   - Derived project for audio: translation, window cropping, offset, mute, volume, envelope.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createEmptyProject, flattenOverlay, opacityAt } from "./project.ts";
import { normalizeCuts, listCuts, removeCut, placeCutSegment, addCut } from "./cuts.ts";
import {
  cutCycleReason, cutCycles, cutReferences, cutSubProject, cutSegmentRender, audioProjectOf, cutContent,
  stripCutReferences, setCutClipFrameMode, cutPreroll, CUT_SEGMENT_CARD, isCutSegment,
} from "./cutSegments.ts";

const track = (id, clips) => ({ id, name: id, clips });
const card = (id, start, end, extra = {}) => ({ id, cardId: "x", start, end, params: {}, ...extra });
const media = (id, start, end, extra = {}) => ({ id, cardId: "", mediaId: "m1", mediaOffset: 0, start, end, params: {}, ...extra });
const seg = (id, cutId, start, end, extra = {}) => ({ id, cardId: "", cutId, start, end, params: {}, ...extra });

/** Three cuts: A (active), B, C; content supplied by parameters */
function proj({ a = [], b = [], c = [], bDur = 10, cDur = 10 } = {}) {
  const p = createEmptyProject("t");
  return {
    ...p,
    media: [{ id: "m1", kind: "audio", name: "m", url: "/m.wav", duration: 60 }],
    tracks: [track("ta", a)],
    duration: 20,
    cuts: [
      { id: "A", name: "Cut A" },
      { id: "B", name: "Cut B", tracks: [track("tb", b)], duration: bDur, transitions: [] },
      { id: "C", name: "Cut C", tracks: [track("tc", c)], duration: cDur, transitions: [] },
    ],
    activeCutId: "A",
  };
}

test("A new project or an old file with no cuts has only Cut 1; one with cuts is left as is", () => {
  const fresh = normalizeCuts(createEmptyProject());
  assert.deepEqual(fresh.cuts.map((c) => c.name), ["Cut 1"]);
  const old = proj();
  assert.equal(normalizeCuts(old).cuts.length, 3, "The existing three are not deleted");
});

test("Circular reference: self, direct and indirect are all rejected, with the reason stated", () => {
  assert.match(cutCycleReason(proj(), "A", "A"), /inside itself/);
  const ab = proj({ b: [seg("s1", "A", 0, 5)] });
  assert.match(cutCycleReason(ab, "A", "B"), /already references "Cut A"/);
  const abc = proj({ b: [seg("s1", "C", 0, 5)], c: [seg("s2", "A", 0, 5)] });
  assert.match(cutCycleReason(abc, "A", "B"), /indirectly references "Cut A"/);
  assert.equal(cutCycleReason(proj({ b: [seg("s1", "C", 0, 5)] }), "A", "B"), null);
  assert.throws(() => placeCutSegment(ab, "B", 0), /circular reference/);
  assert.throws(() => placeCutSegment(proj(), "A", 0), /inside itself/);
});

test("Placing a cut segment: the default length = the remaining length of the referenced cut and cannot exceed it; overlap is rejected", () => {
  const p = proj({ bDur: 8 });
  const r = placeCutSegment(p, "B", 2);
  assert.equal(r.clip.cutId, "B");
  assert.equal(r.clip.end - r.clip.start, 8);
  assert.equal(r.clip.cardId, "");
  const r2 = placeCutSegment(p, "B", 0, { offset: 3, duration: 100 });
  assert.equal(r2.clip.end - r2.clip.start, 5, "Only 5 seconds remain from second 3");
  assert.equal(r2.clip.cutOffset, 3);
  assert.throws(() => placeCutSegment(r.project, "C", 3), /already has a clip/);
  assert.throws(() => placeCutSegment(p, "Z", 0), /Cut not found/);
});

test("list_cuts includes the reference relations", () => {
  const p = proj({ a: [seg("s1", "B", 0, 5)], c: [seg("s2", "B", 0, 5)] });
  const rows = listCuts(p);
  const b = rows.find((r) => r.id === "B");
  assert.deepEqual(b.referencedBy.map((r) => r.cutId).sort(), ["A", "C"]);
  assert.deepEqual(rows.find((r) => r.id === "A").references, ["B"]);
});

test("Deleting a referenced cut: the cut segments that reference it are deleted together with their transitions, and the fade on the other side is erased", () => {
  const p = {
    ...proj({ a: [card("c1", 0, 4, { fadeOut: 1 }), seg("s1", "B", 3, 8, { fadeIn: 1 })], c: [seg("s2", "B", 0, 5)] }),
    transitions: [{ id: "x1", kind: "crossfade", aId: "c1", bId: "s1", dur: 1 }],
  };
  const r = removeCut(p, "B", 0);
  assert.deepEqual(r.removedSegments.map((x) => x.cutId).sort(), ["A", "C"]);
  assert.equal(r.project.cuts.length, 2);
  assert.deepEqual(r.project.tracks[0].clips.map((c) => c.id), ["c1"]);
  assert.equal(r.project.tracks[0].clips[0].fadeOut, 0, "The fade-out on the other side of the transition is erased");
  assert.equal(r.project.transitions.length, 0);
  assert.equal(r.project.cuts.find((c) => c.id === "C").tracks[0].clips.length, 0);
  assert.throws(() => removeCut(normalizeCuts(createEmptyProject()), "cut-1", 0), /last cut/);
});

test("Dangling references and cycles: the sub-project is null, flattenOverlay skips them, and does not throw", () => {
  const dangling = proj({ a: [seg("s1", "Z", 0, 5)] });
  assert.equal(cutSubProject(dangling, "Z"), null);
  assert.equal(flattenOverlay(dangling).clips.length, 0);
  // Cycle B→C→B from collaboration merge: rendering B from A, C in B points back to B, that layer is skipped
  const loop = proj({ a: [seg("s1", "B", 0, 5)], b: [seg("s2", "C", 0, 5)], c: [seg("s3", "B", 0, 5)] });
  assert.deepEqual(cutCycles(loop).map((c) => c.sort()), [["B", "C"]]);
  const b = cutSubProject(loop, "B");
  const c = cutSubProject(b, "C");
  assert.ok(b && c);
  assert.equal(cutSubProject(c, "B"), null, "B is already on the path");
  assert.equal(flattenOverlay(c).clips.length, 0);
  // Pointing back to the root (active cut) is also skipped
  const root = proj({ a: [seg("s1", "B", 0, 5)], b: [seg("s2", "A", 0, 5)] });
  assert.equal(cutSubProject(cutSubProject(root, "B"), "A"), null);
});

test("flattenOverlay turns a cut segment into an @cut card with a sub-project; the sub-project is memoized", () => {
  const p = proj({ a: [seg("s1", "B", 2, 7, { opacity: 0.5, frame: { x: 10, y: 20 } })], b: [card("b1", 0, 3)] });
  const tl = flattenOverlay(p);
  assert.equal(tl.clips.length, 1);
  const c = tl.clips[0];
  assert.equal(c.cardId, CUT_SEGMENT_CARD);
  assert.equal(c.start, 2);
  assert.equal(c.cut.offset, 0);
  assert.equal(c.cut.from, 2);
  assert.equal(c.cut.duration, 10);
  assert.equal(c.opacity, 0.5);
  assert.deepEqual(c.cut.project.tracks, p.cuts[1].tracks);
  assert.equal(c.cut.project.activeCutId, "B");
  // Recompute with the same cuts to get the same subproject object (so stage memo is not wasted)
  assert.equal(flattenOverlay({ ...p, tracks: [...p.tracks] }).clips[0].cut.project, c.cut.project);
});

test("Preroll: when the offset cuts into a card that must advance by its history, the timeline clip's start moves earlier to that card's start", () => {
  setCutClipFrameMode((clip) => (clip.params?.direct ? "direct" : "stateful"));
  try {
    const p = proj({ a: [seg("s1", "B", 5, 9, { cutOffset: 3 })], b: [card("b1", 1, 6), card("b2", 4, 8)] });
    assert.equal(cutPreroll(p, p.tracks[0].clips[0]), 2, "b1 starts at second 1, offset 3 seconds: preroll 2 seconds");
    const c = flattenOverlay(p).clips[0];
    assert.equal(c.start, 3);
    assert.equal(c.cut.offset, 1);
    assert.equal(c.cut.from, 5);
    assert.equal(c.cut.frameMode, "stateful");
    // Flush against timeline start: preroll clamped to segment start
    const q = proj({ a: [seg("s1", "B", 1, 5, { cutOffset: 3 })], b: [card("b1", 0, 6)] });
    assert.equal(cutPreroll(q, q.tracks[0].clips[0]), 1);
    // All are directly evaluated cards: no preroll, caliber direct
    const d = proj({ a: [seg("s1", "B", 5, 9, { cutOffset: 3 })], b: [card("b1", 1, 6, { params: { direct: true } })] });
    assert.equal(cutPreroll(d, d.tracks[0].clips[0]), 0);
    assert.equal(flattenOverlay(d).clips[0].cut.frameMode, "direct");
  } finally {
    setCutClipFrameMode(null);
  }
});

test("Sound-derived project: shift, crop to the window, media offset follows along, envelope, volume, mute", () => {
  const p = proj({
    a: [seg("s1", "B", 10, 16, { cutOffset: 2, audioVolume: 0.5, fadeIn: 1 })],
    b: [media("v1", 0, 5, { fadeOut: 1 }), media("v2", 6, 9, { audioVolume: 0.8 })],
  });
  const q = audioProjectOf(p);
  assert.notEqual(q, p);
  assert.equal(audioProjectOf(p), q, "Memoized");
  const clips = q.tracks.flatMap((t) => t.clips).filter((c) => !isCutSegment(c));
  const v1 = clips.find((c) => c.cutOrigin?.clipId === "v1");
  const v2 = clips.find((c) => c.cutOrigin?.clipId === "v2");
  // Child time τ ↔ parent time τ + 8; v1 originally 0~5 → 8~13, cropped to window 10~16 → 10~13, asset offset +2
  assert.deepEqual([v1.start, v1.end, v1.mediaOffset], [10, 13, 2]);
  assert.equal(v1.audioVolume, 0.5);
  assert.equal(v1.fadeOut, undefined, "Its own fade moves into the envelope");
  // v2 originally 6~9 → 14~17, cropped to 14~16
  assert.deepEqual([v2.start, v2.end], [14, 16]);
  assert.ok(Math.abs(v2.audioVolume - 0.4) < 1e-9);
  // Envelope: segment fade-in 1s (10~11), v1's own fade-out 1s (12~13) based on original range 8~13
  assert.ok(Math.abs(opacityAt(v1, 10.5) - 0.5) < 1e-9);
  assert.ok(Math.abs(opacityAt(v1, 12.5) - 0.5) < 1e-9);
  assert.equal(opacityAt(v1, 11.5), 1);
  // Segment muted → all expanded clips are muted
  const m = audioProjectOf(proj({ a: [seg("s1", "B", 0, 5, { audioMuted: true })], b: [media("v1", 0, 5)] }));
  assert.ok(m.tracks.flatMap((t) => t.clips).filter((c) => c.cutOrigin).every((c) => c.audioMuted));
  // Referenced cut becomes shorter later: window clamped to its total duration
  const short = audioProjectOf(proj({ a: [seg("s1", "B", 0, 10)], b: [media("v1", 0, 10)], bDur: 4 }));
  const v = short.tracks.flatMap((t) => t.clips).find((c) => c.cutOrigin);
  assert.equal(v.end, 4);
  // No cut segments: return the same object as-is
  const plain = proj({ a: [media("v1", 0, 5)] });
  assert.equal(audioProjectOf(plain), plain);
});

test("Sound nested two levels deep: offsets accumulate level by level, ids carry a path prefix", () => {
  const p = proj({
    a: [seg("s1", "B", 10, 20, { cutOffset: 1 })],
    b: [seg("s2", "C", 2, 8, { cutOffset: 3 })],
    c: [media("v1", 0, 10)],
  });
  const clips = audioProjectOf(p).tracks.flatMap((t) => t.clips).filter((c) => c.cutOrigin);
  assert.equal(clips.length, 1);
  const v = clips[0];
  // B time τB ↔ parent τB + 9; C time τC ↔ B time τC − 1 (s2 start 2, offset 3) ↔ parent τC + 8
  // s2 on parent 11~17; v1 in C 0~10 → parent 8~18, cropped to 11~17, asset offset 3
  assert.deepEqual([v.start, v.end, v.mediaOffset], [11, 17, 3]);
  assert.equal(v.id, "s1/s2/v1");
  assert.deepEqual(v.cutOrigin.segments, ["s1", "s2"]);
});

test("cutContent: the active one's content is on tracks, a parked one's is in its entry", () => {
  const p = proj({ a: [card("a1", 0, 1)], b: [card("b1", 0, 1)] });
  assert.equal(cutContent(p, "A").tracks[0].clips[0].id, "a1");
  assert.equal(cutContent(p, "B").tracks[0].clips[0].id, "b1");
  assert.equal(cutContent(p, "nope"), null);
  assert.deepEqual(cutReferences(proj({ a: [seg("s", "B", 0, 1)] }), "B"), [{ cutId: "A", name: "Cut A", clipIds: ["s"] }]);
  assert.equal(stripCutReferences(proj(), "B").tracks[0].clips.length, 0);
  const added = addCut(normalizeCuts(createEmptyProject())).project;
  assert.equal(added.cuts.length, 2);
});

test("Export mix manifest: cut segments expand into audioPlanOf, envelopes go into gainCurve", async () => {
  const { audioPlanOf, gainCurve, needsGainCurve, fadeEnvelope } = await import("./audioPlan.mjs");
  const p = proj({ a: [seg("s1", "B", 10, 14, { fadeIn: 2 })], b: [media("v1", 0, 4)] });
  const plan = audioPlanOf(p);
  assert.equal(plan.length, 1);
  const e = plan[0];
  assert.equal(e.clipId, "s1/v1");
  assert.deepEqual([e.start, e.dur, e.offset], [10, 4, 0]);
  assert.ok(needsGainCurve(e));
  const curve = gainCurve(e, 5); // 10, 11, 12, 13, 14
  assert.ok(Math.abs(curve[0]) < 1e-6 && Math.abs(curve[1] - 0.5) < 1e-6 && Math.abs(curve[2] - 1) < 1e-6);
  // No envelope: identical point-by-point to fadeEnvelope
  const plainEntry = { volume: 0.7, fadeIn: 1, fadeOut: 1, dur: 3, start: 0 };
  assert.deepEqual([...gainCurve(plainEntry, 7)], [...fadeEnvelope(0.7, 1, 1, 3, 7)]);
  // Projects without cut segments: manifest is the same as before (no env key)
  assert.equal("env" in audioPlanOf(proj({ a: [media("v1", 0, 4)] }))[0], false);
});
