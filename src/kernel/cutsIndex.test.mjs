/**
 * Clip index for parked cuts (`parkedCutsIndex` / `otherCutsHint` at the end of `agentScopes.mjs`):
 * get_project / list_cuts / tool responses read by the Agent first use it to expose clipIds in
 * other cuts, so the model does not have to switch_cut just to "look into" Cut 2 (in production
 * on 2026-10-21, two attempts both did switch_cut -> update_clip -> switch_cut).
 * Run: node --test src/kernel/cutsIndex.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parkedCutsIndex, otherCutsHint, CUTS_INDEX_LIMITS, PARKED_EDIT_NOTE } from "./agentScopes.mjs";

const clip = (id, start, end, extra = {}) => ({ id, cardId: "particles", start, end, params: { count: 50 }, ...extra });
const proj = (over = {}) => ({
  tracks: [{ id: "ta", name: "Track A", clips: [clip("a1", 0, 5)] }],
  duration: 5,
  cuts: [
    { id: "cutA", name: "Cut 1" },
    { id: "cutB", name: "Cut 2", duration: 8, tracks: [
      { id: "tb1", name: "Track B1", clips: [clip("b1", 0, 4, { label: "Particle background" }), { id: "bm", cardId: "", mediaId: "m1", start: 4.123, end: 8 }] },
      { id: "tb2", name: "Track B2", clips: [{ id: "bs", cardId: "", cutId: "cutA", start: 0, end: 3 }] },
    ] },
    { id: "cutC", name: "Cut 3", tracks: [] },
  ],
  activeCutId: "cutA",
  ...over,
});

test("With only one cut (or no cuts) there is no index and no hint", () => {
  assert.equal(parkedCutsIndex({ tracks: [], cuts: [{ id: "x", name: "Cut 1" }], activeCutId: "x" }), null);
  assert.equal(parkedCutsIndex({ tracks: [] }), null);
  assert.equal(otherCutsHint({ tracks: [], cuts: [{ id: "x", name: "Cut 1" }], activeCutId: "x" }), null);
});

test("The index lists only the non-active cuts; a clip carries id / trackId / card or media or referenced cut / label / start and end", () => {
  const idx = parkedCutsIndex(proj());
  assert.equal(idx.activeCutId, "cutA");
  assert.deepEqual(idx.cuts.map((c) => c.cutId), ["cutB", "cutC"], "The active cutA is not in it");
  const b = idx.cuts[0];
  assert.deepEqual([b.name, b.duration, b.trackCount, b.clipCount], ["Cut 2", 8, 2, 3]);
  assert.deepEqual(b.clips, [
    { id: "b1", trackId: "tb1", cardId: "particles", label: "Particle background", start: 0, end: 4 },
    { id: "bm", trackId: "tb1", mediaId: "m1", start: 4.12, end: 8 },
    { id: "bs", trackId: "tb2", cutSegmentOf: "cutA", start: 0, end: 3 },
  ]);
  assert.equal("params" in b.clips[0], false, "No params, saves tokens");
  assert.deepEqual(idx.cuts[1].clips, [], "Empty cuts are listed too, with empty clips");
  assert.equal(idx.cuts[1].duration, 30, "A parked cut missing duration uses the fallback 30");
  assert.match(idx.note, /do not use user_interface_switch_cut/);
  assert.match(idx.note, /pass cutId to see_frames/);
  assert.equal(idx.note, PARKED_EDIT_NOTE);
});

test("When cutB is active, cutA and cutC are listed (activeCutId decides, falling back to the first one by default)", () => {
  const idx = parkedCutsIndex(proj({ activeCutId: "cutB" }));
  assert.deepEqual(idx.cuts.map((c) => c.cutId), ["cutA", "cutC"]);
  const idx2 = parkedCutsIndex(proj({ activeCutId: "nonexistent" }));
  assert.equal(idx2.activeCutId, "cutA");
});

test("cardName: the side that has a registry can additionally carry the card display name; long labels are truncated", () => {
  const p = proj();
  p.cuts[1].tracks[0].clips[0].label = "x".repeat(40);
  const idx = parkedCutsIndex(p, { cardName: (id) => (id === "particles" ? "particles" : undefined) });
  assert.equal(idx.cuts[0].clips[0].cardName, "particles");
  assert.equal(idx.cuts[0].clips[0].label, `${"x".repeat(CUTS_INDEX_LIMITS.labelMax)}…`);
  assert.equal("cardName" in idx.cuts[0].clips[1], false, "A media clip has no cardName");
});

test("Has limits: each cut and the total are capped, and the excess is given as a count that points to list_cuts({ cutId })", () => {
  const many = (n, prefix) => Array.from({ length: n }, (_, i) => clip(`${prefix}${i}`, i, i + 1));
  const p = proj();
  p.cuts[1].tracks = [{ id: "tb1", name: "x", clips: many(100, "b") }];
  p.cuts[2].tracks = [{ id: "tc1", name: "y", clips: many(100, "c") }];
  const idx = parkedCutsIndex(p);
  const [b, c] = idx.cuts;
  assert.equal(b.clips.length, CUTS_INDEX_LIMITS.perCutMax);
  assert.equal(b.clipCount, 100);
  assert.equal(b.omitted, 100 - CUTS_INDEX_LIMITS.perCutMax);
  assert.match(b.more, /list_cuts\(\{ cutId: "cutB" \}\)/);
  assert.equal(c.clips.length, CUTS_INDEX_LIMITS.maxClips - CUTS_INDEX_LIMITS.perCutMax, "The slots left after the total is used up");
  assert.equal(b.clips.length + c.clips.length, CUTS_INDEX_LIMITS.maxClips);
  assert.equal(c.omitted, 100 - c.clips.length);
  const tiny = parkedCutsIndex(p, { maxClips: 2, perCutMax: 5 });
  assert.equal(tiny.cuts[0].clips.length, 2);
  assert.equal(tiny.cuts[1].clips.length, 0);
  assert.ok(JSON.stringify(idx).length < 20000, "Output size is bounded");
});

test("Bad data does not throw: a parked entry without tracks, a track without clips", () => {
  const p = proj();
  p.cuts[1].tracks = [{ id: "t", name: "t" }, null].filter(Boolean);
  p.cuts.push({ id: "cutD", name: "Bad", tracks: "x" });
  const idx = parkedCutsIndex(p);
  assert.equal(idx.cuts.find((c) => c.cutId === "cutD").clipCount, 0);
});

test("otherCutsHint: lists only the counts of other cuts that have content, not their clips; null when no other cut has content", () => {
  const h = otherCutsHint(proj());
  assert.deepEqual(h.cuts, [{ cutId: "cutB", name: "Cut 2", clipCount: 3 }]);
  assert.match(h.hint, /do not use user_interface_switch_cut/);
  assert.match(h.hint, /parkedCuts/);
  const empty = proj();
  empty.cuts[1].tracks = [];
  assert.equal(otherCutsHint(empty), null);
});
