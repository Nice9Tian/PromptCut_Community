import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  changedClips, applyProjectPatch, isEmptyPatch, projectHash, hashStats, resetHashStats, TOP_FIELDS,
} from "./changedClips.mjs";

/**
 * Two-level diff and three-tier hash cache (A7).
 *
 * This test watches three things; missing any one causes the mirror to silently fail:
 *
 * 1. **Patches can express every kind of change** (track add/delete/reorder, `hidden` / `muted`,
 *    clip add/delete/update), and after `applyProjectPatch` is applied, `projectHash` is
 *    **verbatim equal** to the page's copy: this is the only place the server can detect that
 *    "the diff itself was written incorrectly".
 * 2. **Untouched objects retain the same reference**: the mirror keeps 8 copies by version number;
 *    shared references are why it does not consume memory, and the prerequisite for the next
 *    diff round to compare by reference.
 * 3. **Cache hits for real**: dragging a clip only recalculates 1 clip + 1 track. If it degrades
 *    to recalculating the whole thing, a 17-track × 10-clip project takes tens of milliseconds
 *    per push, making dragging laggy.
 */

let seq = 0;
const clip = (id, over = {}) => ({ id, start: 0, end: 1, kind: "card", cardId: "c", params: { n: seq++ }, ...over });
const track = (id, n, over = {}) => ({ id, name: id, hidden: false, clips: Array.from({ length: n }, (_, i) => clip(`${id}-${i}`)), ...over });

/**
 * Non-track fields share the same references: this is how the store in the editor works
 * (immutable updates, untouched objects are not replaced)
 */
const BASE = {
  id: "p", name: "demo", width: 1920, height: 1080, fps: 30, duration: 10, themeId: "dark", camera3dFov: 50,
  media: [], filters: [], pixelMaps: [], audioFx: [], cardNodes: [], style: {},
};
const project = (tracks) => ({ ...BASE, tracks });

/**
 * Applies patch and asserts matching hashes on both sides (this is how the server checks
 * "whether they matched")
 */
function roundTrip(prev, next) {
  const patch = changedClips(prev, next);
  const applied = applyProjectPatch(prev, patch);
  assert.equal(projectHash(applied), projectHash(next), `Hash does not match after applying the patch: ${JSON.stringify(patch).slice(0, 200)}`);
  return { patch, applied };
}

test("The top-level field list matches the frameClient signature verbatim", () => {
  /*
   * Splitting the two tables breaks silently: if frameClient adds a field and this side doesn't
   * keep up, that field won't enter `projectHash`: mirror 409 validation will never see it,
   * allowing page and server to diverge on that field without any alert. So we read its source
   * directly here to verify.
   */
  const src = readFileSync(new URL("./frameClient.ts", import.meta.url), "utf8");
  const body = /const signatureFields = \(project: Project\) => JSON\.stringify\(\[([^\]]*)\]\)/.exec(src);
  assert.ok(body, "signatureFields() in frameClient.ts no longer matches this regex; if the shape changes, update it here too");
  const fields = body[1].split(",").map((s) => s.trim().replace(/^project\./, ""));
  assert.deepEqual([...TOP_FIELDS], fields);
});

test("No baseline, or a field other than tracks changed → full", () => {
  const a = project([track("t1", 2)]);
  assert.deepEqual(changedClips(null, a), { kind: "full", project: a });
  // Changing aspect ratio / switching theme / changing asset / changing card node: always full project
  for (const [k, v] of [["width", 1280], ["themeId", "light"], ["media", [{ id: "m" }]], ["cardNodes", [{ id: "d" }]], ["style", { a: 1 }]]) {
    const b = { ...a, [k]: v };
    assert.equal(changedClips(a, b).kind, "full", `${k} changed, should be full`);
    assert.notEqual(projectHash(a), projectHash(b), `${k} changed, hash should differ`);
  }
  /*
   * Metadata not in the field table (names) is invisible to hashes: hashes only care about
   * "whether rendering matches". Therefore, the patch layer must compare **by all own keys**;
   * otherwise renaming takes the delta route, which only carries tracks, leaving the name
   * in the mirror stuck on the old one forever (which is what Agent's get_project reads).
   */
  const renamed = { ...a, name: "another name" };
  assert.equal(changedClips(a, renamed).kind, "full");
  assert.equal(projectHash(renamed), projectHash(a));
});

test("references unchanged / tracks unchanged → empty patch", () => {
  const a = project([track("t1", 2)]);
  assert.ok(isEmptyPatch(changedClips(a, a)));
  assert.ok(isEmptyPatch(changedClips(a, { ...a })));
  assert.ok(!isEmptyPatch({ kind: "full", project: a }));
});

test("tracks: add / delete / reorder", () => {
  const t1 = track("t1", 2), t2 = track("t2", 2), t3 = track("t3", 1);
  const a = project([t1, t2]);

  const added = roundTrip(a, project([t1, t2, t3]));
  assert.equal(added.patch.order.length, 3);
  // New track has no baseline to compare against; provide the entire track
  assert.deepEqual(added.patch.tracks, [{ id: "t3", track: t3 }]);

  const removed = roundTrip(a, project([t2]));
  assert.deepEqual(removed.patch.order, ["t2"]);
  assert.deepEqual(removed.patch.tracks, []);
  assert.deepEqual(removed.applied.tracks.map((t) => t.id), ["t2"]);

  const reordered = roundTrip(a, project([t2, t1]));
  assert.deepEqual(reordered.patch.order, ["t2", "t1"]);
  assert.deepEqual(reordered.patch.tracks, []);
  assert.equal(reordered.applied.tracks[0], t2, "reordering should not create new objects");
});

test("track's own properties: hidden / muted are passed as a whole group", () => {
  const t1 = track("t1", 2), t2 = track("t2", 2);
  const a = project([t1, t2]);

  const hidden = roundTrip(a, project([{ ...t1, hidden: true }, t2]));
  assert.equal(hidden.patch.order, null);
  assert.equal(hidden.patch.tracks.length, 1);
  assert.equal(hidden.patch.tracks[0].props.hidden, true);
  assert.equal(hidden.patch.tracks[0].clips, undefined, "changing only properties should not carry clips");
  assert.equal(hidden.applied.tracks[0].clips, t1.clips, "the clip array should be left as is");
  assert.equal(hidden.applied.tracks[1], t2, "an untouched track should be the same object");

  const muted = roundTrip(a, project([{ ...t1, muted: true }, t2]));
  assert.equal(muted.patch.tracks[0].props.muted, true);

  // Deleting a key can also be expressed (props are handled as a whole group, not relying on a delete
  // table)
  const { hidden: _drop, ...noHidden } = t1;
  const dropped = roundTrip(a, project([noHidden, t2]));
  assert.ok(!("hidden" in dropped.applied.tracks[0]));
});

test("clips: change one / add one / delete one / reorder", () => {
  const t1 = track("t1", 3), t2 = track("t2", 3);
  const a = project([t1, t2]);

  // Dragging one clip: only it enters the patch; other two clips on the same track retain their references
  const moved = { ...t1.clips[1], start: 5, end: 6 };
  const drag = roundTrip(a, project([{ ...t1, clips: [t1.clips[0], moved, t1.clips[2]] }, t2]));
  assert.equal(drag.patch.tracks.length, 1);
  assert.equal(drag.patch.tracks[0].props, undefined, "do not carry props if track properties did not change");
  assert.deepEqual(drag.patch.tracks[0].clips, [{ id: moved.id, clip: moved }]);
  assert.equal(drag.patch.tracks[0].clipOrder, undefined, "do not carry clipOrder if the order did not change");
  assert.equal(drag.applied.tracks[0].clips[0], t1.clips[0]);
  assert.equal(drag.applied.tracks[0].clips[2], t1.clips[2]);
  assert.equal(drag.applied.tracks[1], t2);
  // The patch for a single drag should be on the order of "one clip", not the entire project
  assert.ok(JSON.stringify(drag.patch).length < 8 * 1024, "the patch for a single clip should not reach 8 KB");

  const fresh = clip("t1-new");
  const added = roundTrip(a, project([{ ...t1, clips: [...t1.clips, fresh] }, t2]));
  assert.deepEqual(added.patch.tracks[0].clips, [{ id: "t1-new", clip: fresh }]);
  assert.deepEqual(added.patch.tracks[0].clipOrder, ["t1-0", "t1-1", "t1-2", "t1-new"]);

  const removed = roundTrip(a, project([{ ...t1, clips: [t1.clips[0], t1.clips[2]] }, t2]));
  assert.deepEqual(removed.patch.tracks[0].clips, [{ id: "t1-1", clip: null }]);
  assert.deepEqual(removed.applied.tracks[0].clips.map((c) => c.id), ["t1-0", "t1-2"]);

  const reordered = roundTrip(a, project([{ ...t1, clips: [t1.clips[2], t1.clips[0], t1.clips[1]] }, t2]));
  assert.equal(reordered.patch.tracks[0].clips, undefined, "reordering only should not resend clips");
  assert.deepEqual(reordered.patch.tracks[0].clipOrder, ["t1-2", "t1-0", "t1-1"]);
  assert.equal(reordered.applied.tracks[0].clips[0], t1.clips[2]);

  // Dragging across tracks: a clip moves from t1 to t2; both tracks enter the patch
  const c = t1.clips[1];
  const across = roundTrip(a, project([
    { ...t1, clips: [t1.clips[0], t1.clips[2]] },
    { ...t2, clips: [...t2.clips, c] },
  ]));
  assert.deepEqual(across.patch.tracks.map((t) => t.id), ["t1", "t2"]);
  assert.equal(across.applied.tracks[1].clips[3], c);
});

test("media clips and card clips are both compared by reference", () => {
  const mediaClip = clip("m-0", { kind: "media", mediaId: "v1", mediaOffset: 0 });
  const t1 = { id: "t1", name: "t1", hidden: false, clips: [mediaClip] };
  const a = project([t1]);
  const b = project([{ ...t1, clips: [{ ...mediaClip, mediaOffset: 1.5 }] }]);
  const { patch } = roundTrip(a, b);
  assert.equal(patch.tracks[0].clips[0].clip.mediaOffset, 1.5);
});

test("throw if the patch does not match the baseline (so the mirror turns it into a 409)", () => {
  const a = project([track("t1", 1)]);
  assert.throws(() => applyProjectPatch(a, { kind: "tracks", order: null, tracks: [{ id: "nope", props: {} }] }), /nonexistent track/);
  assert.throws(() => applyProjectPatch(a, { kind: "tracks", order: ["nope"], tracks: [] }), /nonexistent track/);
  assert.throws(() => applyProjectPatch(a, { kind: "tracks", order: null, tracks: [{ id: "t1", clipOrder: ["nope"] }] }), /nonexistent clip/);
  assert.throws(() => applyProjectPatch(a, { kind: "weird" }), /Unknown patch type/);
  assert.equal(applyProjectPatch(a, null), a);
});

test("applying a patch does not modify the original object (the mirror must keep old versions by version number)", () => {
  const t1 = track("t1", 2);
  const a = project([t1]);
  const before = JSON.stringify(a);
  const next = project([{ ...t1, clips: [{ ...t1.clips[0], start: 9 }, t1.clips[1]] }]);
  const applied = applyProjectPatch(a, changedClips(a, next));
  assert.equal(JSON.stringify(a), before, "the baseline was modified in place");
  assert.notEqual(applied, a);
  assert.notEqual(applied.tracks, a.tracks);
});

test("three-level cache: dragging one clip recomputes only 1 clip + 1 track", async () => {
  const tracks = Array.from({ length: 17 }, (_, i) => track(`t${i}`, 10));
  const a = project(tracks);

  resetHashStats();
  projectHash(a);
  const cold = hashStats();
  assert.equal(cold.clips, 170);
  assert.equal(cold.tracks, 17);

  // Calculating the same project again: should not recalculate even once
  resetHashStats();
  projectHash(a);
  assert.deepEqual(hashStats(), { fields: 0, tracks: 0, clips: 0, values: 0 });

  // Dragging a clip on a track: store uses immutable updates, so only this clip, this track,
  // tracks, and project get new objects
  const t = tracks[9];
  const dragged = { ...t, clips: t.clips.map((c, i) => (i === 4 ? { ...c, start: 3, end: 4 } : c)) };
  const b = project(tracks.map((x, i) => (i === 9 ? dragged : x)));

  resetHashStats();
  const t0 = performance.now();
  const hash = projectHash(b);
  const ms = performance.now() - t0;
  const warm = hashStats();

  assert.equal(warm.clips, 1, `recomputed ${warm.clips} clips`);
  assert.equal(warm.tracks, 1, `recomputed ${warm.tracks} tracks`);
  assert.equal(warm.fields, 1, "top level is assembled once");
  assert.equal(warm.values, 0, "non-track field references did not change, should not recompute");
  assert.notEqual(hash, projectHash(a));

  // Timing: single run ≤ 2 ms. When the machine is busy (several npm test runs in parallel), a single
  // run might get suspended, so if it fails, drag again to re-measure, up to 8 times spread over
  // ~1 s; passes if any attempt meets the threshold. Each attempt uses a newly dragged track (new
  // object) with the same workload as the first (1 clip + 1 track + top level, checked below as usual);
  // criteria remain unchanged, and genuine regressions will exceed every time and still be caught.
  const times = [ms];
  for (let k = 1; k < 8 && Math.min(...times) > 2; k++) {
    await new Promise((r) => setTimeout(r, 120));
    const again = { ...t, clips: t.clips.map((c, i) => (i === 4 ? { ...c, start: 3 + k, end: 4 + k } : c)) };
    const bk = project(tracks.map((x, i) => (i === 9 ? again : x)));
    resetHashStats();
    const s0 = performance.now();
    projectHash(bk);
    times.push(performance.now() - s0);
    const st = hashStats();
    assert.equal(st.clips, 1, `recompute #${k + 1} recomputed ${st.clips} clips`);
    assert.equal(st.tracks, 1, `recompute #${k + 1} recomputed ${st.tracks} tracks`);
  }
  const best = Math.min(...times);
  assert.ok(best <= 2, `recompute after dragging one clip in 17 tracks × 10 clips, measured ${times.length} times, even the fastest took ${best.toFixed(3)} ms, over 2 ms (${times.map((x) => x.toFixed(2)).join(", ")})`);

  // diff must also be on the order of "one clip"
  const patch = changedClips(a, b);
  assert.equal(patch.tracks.length, 1);
  assert.equal(patch.tracks[0].clips.length, 1);
  assert.equal(projectHash(applyProjectPatch(a, patch)), hash);
});

test("the position of clips inside the track object does not affect the hash", () => {
  /*
   * When applying patches on the server, tracks are rebuilt as `{...props, clips}`: `clips` is
   * always placed last, while on the page it may be in the middle. `trackHash` separates clips
   * from own properties specifically for this: without separation, hashes on both sides would
   * inevitably mismatch after a patch, forcing a full republish on every revision.
   */
  const c = clip("c0");
  const a = project([{ id: "t1", clips: [c], name: "t1", hidden: false }]);
  const b = project([{ id: "t1", name: "t1", hidden: false, clips: [c] }]);
  assert.equal(projectHash(b), projectHash(a));
});

test("cuts referenced by cut segments go into the project hash; the project hash is unchanged for projects without cut segments; changing an unreferenced cut has no effect", () => {
  const seg = { id: "s1", cardId: "", cutId: "B", start: 0, end: 2, params: {} };
  const cuts = (bClips, cClips = []) => [
    { id: "A", name: "A" },
    { id: "B", name: "B", tracks: [{ id: "tb", name: "tb", clips: bClips }], duration: 5, transitions: [] },
    { id: "C", name: "C", tracks: [{ id: "tc", name: "tc", clips: cClips }], duration: 5, transitions: [] },
  ];
  const plain = project([track("t1", 1)]);
  const withCutsNoSeg = { ...plain, cuts: cuts([clip("b1")]), activeCutId: "A" };
  // No cut segments: including extra cuts does not change the hash (cuts is not in the top-level
  // field table anyway)
  assert.equal(projectHash(withCutsNoSeg), projectHash(plain));
  const tracks = [{ id: "t1", name: "t1", clips: [seg] }];
  const a = { ...plain, tracks, cuts: cuts([clip("b1")]), activeCutId: "A" };
  const b = { ...plain, tracks, cuts: cuts([clip("b1", { start: 0.5 })]), activeCutId: "A" };
  const c = { ...plain, tracks, cuts: cuts([clip("b1")], [clip("c1")]), activeCutId: "A" };
  assert.notEqual(projectHash(a), projectHash(b), "referenced cut B changed, the hash must change");
  // c and a differ only by unreferenced C; b1 params differ on each clip(), so rebuild c using a's B entry
  const c2 = { ...c, cuts: [a.cuts[0], a.cuts[1], c.cuts[2]] };
  assert.equal(projectHash(c2), projectHash(a), "unreferenced C changed, the hash stays the same");
});
