/**
 * Edit rules for cut segments in store: placement, trim head with offset, out point cannot exceed
 * referenced cut, split accumulates offset, duplicate, independent mute, deleting referenced cut
 * undone in one step. Run: npm test -- src/store/actions/cutSegments.test.mjs
 */
import { srcUrl } from "../../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const { actions, getState } = await import(srcUrl("store/project.ts"));

function load() {
  const p = {
    version: 1, id: "p-test", name: "t", width: 1280, height: 720, fps: 30, duration: 20, themeId: "midnight", media: [],
    tracks: [{ id: "ta", name: "Track 1", clips: [] }, { id: "ta2", name: "Track 2", clips: [] }],
    cuts: [
      { id: "A", name: "Cut A" },
      { id: "B", name: "Cut B", tracks: [{ id: "tb", name: "Track 1", clips: [{ id: "b1", cardId: "", mediaId: "m", start: 0, end: 8, params: {} }] }], duration: 8, transitions: [] },
    ],
    activeCutId: "A",
  };
  actions.loadProject(p);
}
const seg = () => getState().project.tracks.flatMap((t) => t.clips).find((c) => c.cutId);

test("Placement: default length = total length of the referenced cut; circular references are rejected", () => {
  load();
  const c = actions.addCutSegment("B", 2, { trackId: "ta" });
  assert.deepEqual([c.start, c.end, c.cutId, c.cardId], [2, 10, "B", ""]);
  assert.throws(() => actions.addCutSegment("A", 0, { trackId: "ta2" }), /inside itself/);
  assert.equal(actions.cutCycleReason("A"), "Cannot place cut \"Cut A\" inside itself");
});

test("Trim head: the offset follows, cannot go back past the start of the referenced cut; the out point cannot exceed the remaining length", () => {
  load();
  const c = actions.addCutSegment("B", 2, { trackId: "ta" });
  actions.moveClip(c.id, { start: 3, end: c.end });
  assert.deepEqual([seg().start, seg().end, seg().cutOffset], [3, 10, 1]);
  actions.moveClip(c.id, { start: 0.5, end: 10 });
  assert.deepEqual([seg().start, seg().cutOffset ?? 0], [2, 0], "Dragging backward cannot go past the start of the referenced cut");
  actions.moveClip(c.id, { start: 2, end: 15 });
  assert.equal(seg().end, 10, "The out point cannot exceed the total length of the referenced cut");
  actions.moveClip(c.id, { start: 5, end: 13 });
  assert.deepEqual([seg().start, seg().end, seg().cutOffset ?? 0], [5, 13, 0], "Moving the whole segment does not change the offset");
});

test("Split: the second half's offset accumulates; a copy keeps the reference; independent mute", () => {
  load();
  const c = actions.addCutSegment("B", 2, { trackId: "ta" });
  const right = actions.splitClip(c.id, 5);
  assert.equal(right.cutOffset, 3);
  assert.equal(right.mediaOffset, undefined);
  const dup = actions.duplicateClip(right.id);
  assert.equal(dup.cutId, "B");
  assert.equal(dup.cutOffset, 3);
  const r = actions.setClipMuted(c.id, true);
  assert.equal(r.ok, true);
  assert.equal(getState().project.tracks[0].clips.find((x) => x.id === c.id).audioMuted, true);
});

test("Deleting a referenced cut: its cut segments are deleted along with it, and one undo restores everything", () => {
  load();
  actions.addCutSegment("B", 2, { trackId: "ta" });
  const { removedSegments } = actions.removeCut("B");
  assert.equal(removedSegments.length, 1);
  assert.equal(seg(), undefined);
  assert.equal(getState().project.cuts.length, 1);
  actions.undo();
  assert.equal(getState().project.cuts.length, 2);
  assert.ok(seg(), "The cut segment is back");
});
