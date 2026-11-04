/**
 * Unit tests for kernel/cuts.ts. Run: node --test src/kernel/cuts.test.mjs
 *
 * The multi-cut model has only one invariant: **the content of each cut is stored only once**:
 * the active cut in Project.tracks, parked cuts in their respective entries. Switching, deleting,
 * and loading legacy files must never lose content or duplicate it. Pinned down:
 *   - Legacy files (without cuts) after loading: tracks are as-is for "Cut 1", this one only
 *     (user decision, 2026-10-20: keep only one by default);
 *   - Switching is a round-trip: after A→B→A, tracks / duration / playhead are identical item by item;
 *   - Active entries never carry tracks;
 *   - Deleting the last cut is rejected; deleting the active cut switches to an adjacent cut;
 *   - Deleting an asset must clean into parked cuts.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createEmptyProject } from "./project.ts";
import {
  normalizeCuts, listCuts, switchCut, addCut, renameCut, removeCut, nextCutName, resolveCut,
  stripMediaFromCuts,
} from "./cuts.ts";

const clip = (id, extra = {}) => ({ id, cardId: "x", start: 0, end: 1, params: {}, ...extra });
const legacy = () => ({ ...createEmptyProject("Old project"), tracks: [{ id: "t-1", name: "Track 1", clips: [clip("a")] }], duration: 12 });
const empty = (id) => [{ id: `${id}-1`, name: "Track 1", clips: [] }, { id: `${id}-2`, name: "Track 2", clips: [] }];
/** Projects created before 0.7.18: three cuts exist in cuts by default (preserved as-is on load) */
const three = () => ({
  ...legacy(),
  cuts: [
    { id: "cut-1", name: "Cut 1" },
    { id: "cut-2", name: "Cut 2", tracks: empty("t2"), duration: 30, transitions: [] },
    { id: "cut-3", name: "Cut 3", tracks: empty("t3"), duration: 30, transitions: [] },
  ],
  activeCutId: "cut-1",
});

test("Loading an old file: the current tracks is Cut 1, the only one, and the active entry carries no tracks", () => {
  const p = normalizeCuts(legacy());
  assert.equal(p.cuts.length, 1);
  assert.deepEqual(p.cuts.map((c) => c.name), ["Cut 1"]);
  assert.equal(p.activeCutId, "cut-1");
  assert.equal(p.cuts[0].tracks, undefined);
  assert.equal(p.tracks[0].clips[0].id, "a");
  assert.equal(p.duration, 12);
});

test("A project that already has three cuts: kept as is, none deleted", () => {
  const p = normalizeCuts(three());
  assert.deepEqual(p.cuts.map((c) => c.name), ["Cut 1", "Cut 2", "Cut 3"]);
  assert.equal(p.cuts[1].tracks.length, 2);
  assert.equal(p.cuts[1].duration, 30);
});

test("normalizeCuts is idempotent", () => {
  const once = normalizeCuts(three());
  assert.deepEqual(normalizeCuts(once), once);
});

test("A new project normalized by loadProject has only Cut 1", () => {
  const p = normalizeCuts(createEmptyProject("新"));
  assert.equal(listCuts(p).length, 1);
  assert.equal(listCuts(p)[0].name, "Cut 1");
  assert.equal(listCuts(p)[0].active, true);
  assert.deepEqual(p.tracks.map((t) => t.name), ["Track 1", "Track 2"], "Cut 1's content is the two tracks given by createEmptyProject");
});

test("listCuts: the active one's counts come from Project.tracks", () => {
  const l = listCuts(three());
  assert.deepEqual(l[0], { id: "cut-1", name: "Cut 1", active: true, trackCount: 1, clipCount: 1, duration: 12, referencedBy: [], references: [] });
  assert.equal(l[1].clipCount, 0);
});

test("Switching round-trip: A→B→A restores both the content and the playhead", () => {
  const p0 = normalizeCuts(three());
  const s1 = switchCut(p0, "cut-2", 7.5);
  assert.equal(s1.project.activeCutId, "cut-2");
  assert.equal(s1.t, 0, "Cut 2 has not been visited, so the playhead starts at 0");
  assert.equal(s1.project.tracks.length, 2, "What is switched in is Cut 2's two empty tracks");
  assert.equal(s1.project.duration, 30);
  const parked = s1.project.cuts.find((c) => c.id === "cut-1");
  assert.equal(parked.tracks[0].clips[0].id, "a", "Cut 1's content is parked in its entry");
  assert.equal(parked.t, 7.5);
  assert.equal(s1.project.cuts.find((c) => c.id === "cut-2").tracks, undefined, "The active entry carries no tracks");

  const s2 = switchCut(s1.project, "cut-1", 3);
  assert.equal(s2.t, 7.5, "Switching back continues from the last playhead");
  assert.deepEqual(s2.project.tracks, p0.tracks);
  assert.equal(s2.project.duration, 12);
});

test("Switching to the current one: unchanged", () => {
  const p = normalizeCuts(three());
  assert.deepEqual(switchCut(p, "cut-1", 2), { project: p, t: 2 });
});

test("addCut: the default name increments as Cut N, parking does not switch", () => {
  const p = normalizeCuts(three());
  const a = addCut(p);
  assert.equal(a.cut.name, "Cut 4");
  assert.equal(a.project.activeCutId, "cut-1");
  assert.equal(a.project.cuts.length, 4);
  assert.equal(a.cut.tracks.length, 2);
  const b = addCut(a.project, "  Intro  ");
  assert.equal(b.cut.name, "Intro");
  assert.equal(nextCutName(b.project.cuts), "Cut 5");
});

test("renameCut: trims whitespace, rejects an empty name", () => {
  const p = renameCut(normalizeCuts(three()), "cut-2", " Extras ");
  assert.equal(p.cuts[1].name, "Extras");
  assert.throws(() => renameCut(p, "cut-2", "  "), /cannot be empty/);
  assert.throws(() => renameCut(p, "nope", "x"), /Cut not found/);
});

test("resolveCut: by id or name, lists the existing ones when not found", () => {
  const p = normalizeCuts(three());
  assert.equal(resolveCut(p, { name: "Cut 2" }).id, "cut-2");
  assert.equal(resolveCut(p, { cutId: "cut-3" }).name, "Cut 3");
  assert.throws(() => resolveCut(p, { name: "Cut 9" }), /Cut 1\(cut-1\)/);
});

test("removeCut: a parked cut is deleted directly; deleting the active one first switches to its left neighbor; the last remaining one is rejected", () => {
  const p = normalizeCuts(three());
  const r1 = removeCut(p, "cut-3", 1);
  assert.equal(r1.switchedTo, null);
  assert.equal(r1.project.cuts.length, 2);

  const s = switchCut(r1.project, "cut-2", 4);
  const r2 = removeCut(s.project, "cut-2", 9);
  assert.equal(r2.switchedTo, "cut-1");
  assert.equal(r2.project.activeCutId, "cut-1");
  assert.equal(r2.project.tracks[0].clips[0].id, "a", "Switching back to Cut 1, the content is still there");
  assert.equal(r2.t, 4, "The playhead when Cut 1 was last left");
  assert.equal(r2.project.cuts.length, 1);

  assert.throws(() => removeCut(r2.project, "cut-1", 0), /last cut/);
});

test("stripMediaFromCuts: segments in parked cuts that reference this media are cleared too", () => {
  const p = normalizeCuts(three());
  p.cuts[1].tracks[0].clips.push({ id: "m1", mediaId: "vid", start: 0, end: 2, params: {} }, clip("keep"));
  const q = stripMediaFromCuts(p, "vid");
  assert.deepEqual(q.cuts[1].tracks[0].clips.map((c) => c.id), ["keep"]);
});
