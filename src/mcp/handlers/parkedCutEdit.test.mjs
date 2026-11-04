/**
 * Edit clips in parked cuts in place without switching the active cut (production, 2026-10-21:
 * every round required switch_cut to switch over, make edits, and switch back; activeCutId is
 * a shared field, flipping the UI for all members at once). Pin down:
 *   - update_clip / get_clip / set_clip / set_position / set_rect / align / nudge / set_emphasis /
 *     set_clip_volume / set_clip_muted find clips in parked cuts and edit them in the right cut,
 *     leaving activeCutId and active cut content (the same object identity) intact;
 *   - No listener, sync layer, or undo stack ever sees a "view"-shaped project; commits only
 *     modify that cut entry (document diff only has /cuts/@B/…);
 *   - Modifications produce all-new objects, while untouched tracks / clips retain identical
 *     object references; a single undo step restores them;
 *   - Response indicates which cut it is in, timeline belongs to that cut, look calls include
 *     cutId (see_frames can view non-active cuts, 2026-10-21); total duration of parked cuts
 *     follows their content;
 *   - Other tools finding by clipId (delete, duplicate, split) state clearly which cut it is in
 *     and require switch_cut when finding a clip in a parked cut, rather than silently doing
 *     nothing.
 * Run: node --experimental-test-module-mocks --test src/mcp/handlers/parkedCutEdit.test.mjs
 */
import { srcUrl } from "../../testing/registerTs.mjs";
import test, { mock } from "node:test";
import assert from "node:assert/strict";

mock.module(srcUrl("ai/mcpExecutor.ts"), { exports: { EditorApi: undefined } });

const { actions, getState, subscribe } = await import(srcUrl("store/project.ts"));
const core = await import(srcUrl("store/core.ts"));
const { registerCards } = await import(srcUrl("kernel/registry.ts"));
const { TOOL_ROUTES } = await import(srcUrl("mcp/routes.mjs"));
const { clipsHandlers } = await import(srcUrl("mcp/handlers/clips.ts"));
const { layoutHandlers } = await import(srcUrl("mcp/handlers/layout.ts"));
const { audioHandlers } = await import(srcUrl("mcp/handlers/audio.ts"));
const { effectsHandlers } = await import(srcUrl("mcp/handlers/effects.ts"));
const { diffProject } = await import(srcUrl("kernel/diffProject.ts"));
const { cutEditView, foldCutEdit, parkedCutOfClip } = await import(srcUrl("kernel/cuts.ts"));
const api = { ...clipsHandlers, ...layoutHandlers, ...audioHandlers, ...effectsHandlers };
const call = (tool, args) => api[TOOL_ROUTES[tool].method](args);

registerCards([{
  id: "pk-card", name: "Parked test card", description: "", source: "user",
  defaults: { color: "#ffd27f", size: 10 },
  controls: [{ key: "color", label: "Color", type: "text" }, { key: "size", label: "Size", type: "number" }],
  Component: () => null,
}]);

const proj = () => ({
  version: 1, id: "p-park", name: "t", width: 1280, height: 720, fps: 30, duration: 10, themeId: "midnight",
  media: [{ id: "m-aud", kind: "audio", name: "Background music", url: "x.mp3", duration: 30 }],
  tracks: [
    { id: "ta1", name: "Track 1", clips: [{ id: "a1", cardId: "pk-card", start: 0, end: 4, params: { color: "#111111", size: 1 } }] },
    { id: "ta2", name: "Track 2", clips: [] },
  ],
  cuts: [
    { id: "A", name: "Cut A" },
    {
      id: "B", name: "Cut B", duration: 6, transitions: [],
      tracks: [
        { id: "tb1", name: "B track 1", clips: [
          { id: "b1", cardId: "pk-card", start: 0, end: 3, params: { color: "#ffd27f", size: 10 } },
          { id: "b2", cardId: "pk-card", start: 3, end: 6, params: { color: "#222222", size: 2 } },
        ] },
        { id: "tb2", name: "B track 2", clips: [{ id: "bm", cardId: "", mediaId: "m-aud", mediaOffset: 0, start: 0, end: 6, params: {} }] },
      ],
    },
  ],
  activeCutId: "A",
});
const fresh = () => { actions.loadProject(proj()); return getState().project; };
const cutB = (p = getState().project) => p.cuts.find((c) => c.id === "B");
const clipB = (id, p = getState().project) => cutB(p).tracks.flatMap((t) => t.clips).find((c) => c.id === id);

/**
 * Records the project in the store at each notification: it must always be the real shape
 * (A is active, tracks are A's content)
 */
function watchShapes() {
  const seen = [];
  const off = subscribe(() => seen.push(getState().project));
  return { seen, off };
}

test("update_clip edits a clip inside a parked cut: the edit lands in B, activeCutId and the content of A stay untouched, and the response says which cut it was in", () => {
  const before = fresh();
  const w = watchShapes();
  const r = call("update_clip", { clipId: "b1", params: { size: 24 }, opacity: 0.5 });
  w.off();
  const after = getState().project;
  assert.equal(after.activeCutId, "A", "Not switched");
  assert.equal(after.tracks, before.tracks, "The tracks of the active cut are the same object");
  assert.equal(after.duration, before.duration);
  assert.deepEqual(clipB("b1").params, { color: "#ffd27f", size: 24 }, "Patch merge");
  assert.equal(clipB("b1").opacity, 0.5);
  assert.equal(clipB("b2", after), clipB("b2", before), "An unchanged clip is the same object");
  assert.notEqual(clipB("b1", after), clipB("b1", before), "A changed one is a new object");
  assert.equal(cutB(after).tracks[1], cutB(before).tracks[1], "An unchanged track is the same object");
  assert.equal(r.ok, true);
  assert.deepEqual(r.cut, { id: "B", name: "Cut B", active: false });
  assert.match(r.cutNote, /inactive cut "Cut B"/);
  assert.equal(r.look?.tool, "see_frames");
  assert.equal(r.look.args.cutId, "B", "look carries cutId: you can view its frames without switching");
  assert.equal(r.look.args.clipId, "b1");
  assert.match(r.cutNote, /see_frames with cutId: "B"/);
  assert.deepEqual(r.timeline.tracks.map((t) => t.trackId), ["tb1", "tb2"], "timeline is B's");
  assert.deepEqual(r.changedParams, { size: { from: 10, to: 24 } });
  assert.ok(w.seen.length > 0);
  for (const p of w.seen) {
    assert.equal(p.activeCutId, "A", "The listener never saw the view");
    assert.equal(p.tracks, before.tracks);
  }
});

test("The document diff has only paths under /cuts/@B/ (does not touch the active cut or activeCutId), and one undo brings everything back", () => {
  const before = fresh();
  call("update_clip", { clipId: "b1", params: { size: 24 } });
  const { ops } = diffProject(before, getState().project);
  assert.ok(ops.length > 0);
  for (const op of ops) assert.match(op.path, /^\/cuts\/@B\/tracks\/@tb1\/clips\/@b1\//, op.path);
  actions.undo();
  assert.equal(getState().project, before, "Undo returns to the very same project as before the edit");
  assert.equal(getState().project.activeCutId, "A");
});

test("The prev / next committed to the sync layer both have the real shape", () => {
  const before = fresh();
  const commits = [];
  core.attachProjectSync({
    commit(prev, next) { commits.push({ prev, next }); return next; },
    load: (p) => p, undo() {}, redo() {}, canUndo: () => false, canRedo: () => false,
  });
  try {
    call("update_clip", { clipId: "b1", params: { size: 24 } });
  } finally { core.attachProjectSync(null); }
  assert.equal(commits.length, 1, "One tool call, one commit (no more two redundant writes for switching over and switching back)");
  assert.equal(commits[0].prev, before);
  assert.equal(commits[0].next.activeCutId, "A");
  assert.equal(commits[0].next.tracks, before.tracks);
  assert.equal(cutB(commits[0].next).tracks[0].clips[0].params.size, 24);
});

test("get_clip / set_clip can find clips inside a parked cut", () => {
  const before = fresh();
  const env = call("get_clip", { clipId: "b1" });
  assert.equal(env.card.id, "pk-card");
  assert.deepEqual(env.params, { color: "#ffd27f", size: 10 });
  assert.equal(env.cut.id, "B");
  const r = call("set_clip", { clipId: "b1", envelope: { blend: { opacity: 0.3 }, time: { start: 0, end: 2.5 } } });
  assert.equal(r.ok, true);
  assert.equal(clipB("b1").opacity, 0.3);
  assert.equal(clipB("b1").end, 2.5);
  assert.equal(r.cut.id, "B");
  assert.equal(getState().project.tracks, before.tracks);
  assert.equal(getState().project.activeCutId, "A");
});

test("set_position / set_rect / align / nudge change the box of a clip inside a parked cut", () => {
  const before = fresh();
  call("set_rect", { clipId: "b1", x1: 100, y1: 100, x2: 500, y2: 400 });
  const f1 = clipB("b1").frame;
  assert.ok(f1, "set_rect wrote the box");
  call("set_position", { clipId: "b1", x: 10, y: 20 });
  assert.equal(clipB("b1").frame.x, 10);
  call("nudge", { clipId: "b1", dx: 5, dy: 5 });
  assert.equal(clipB("b1").frame.x, 15);
  const r = call("align", { clipId: "b1", h: "left" });
  assert.equal(r.cut.id, "B");
  assert.equal(getState().project.tracks, before.tracks);
  assert.equal(getState().project.activeCutId, "A");
});

test("set_emphasis / set_clip_volume / set_clip_muted change a clip inside a parked cut", () => {
  const before = fresh();
  const e = call("set_emphasis", { clipId: "b1", kind: "shadow", size: 8 });
  assert.equal(e.ok, true);
  assert.ok(clipB("b1").emphasis, "The emphasis was written into the clip in B");
  const v = call("set_clip_volume", { clipId: "bm", volume: 0.4 });
  assert.equal(v.ok, true);
  assert.equal(clipB("bm").audioVolume, 0.4);
  const m = call("set_clip_muted", { clipId: "bm", muted: true });
  assert.equal(m.ok, true);
  assert.equal(clipB("bm").audioMuted, true);
  assert.equal(getState().project.tracks, before.tracks);
  assert.equal(getState().project.activeCutId, "A");
});

test("update_clip moving to another track: a track in B works, a track in A does not (the error says which cut the track belongs to)", () => {
  fresh();
  call("update_clip", { clipId: "b2", trackId: "tb2", start: 7, end: 8 });
  assert.equal(cutB().tracks.find((t) => t.id === "tb2").clips.some((c) => c.id === "b2"), true);
  assert.throws(() => call("update_clip", { clipId: "b1", trackId: "ta2" }), /Track ta2 not found/);
});

test("The total duration of a parked cut follows its content (the same rule as the active cut)", () => {
  fresh();
  assert.equal(cutB().duration, 6);
  call("update_clip", { clipId: "b2", end: 9 });
  assert.equal(cutB().duration, 9, "Lengthen the content and the total duration grows with it");
  call("update_clip", { clipId: "b2", end: 4 });
  assert.equal(cutB().duration, 6, "Shorten the content and the total duration shrinks back to the end of the content (the background music bm runs to second 6)");
});

test("Clips in the active cut work as before: no cut tag, with look, behavior unchanged", () => {
  const before = fresh();
  const r = call("update_clip", { clipId: "a1", params: { size: 7 } });
  assert.equal(r.ok, true);
  assert.equal("cut" in r, false);
  assert.ok(r.look);
  assert.notEqual(getState().project.tracks, before.tracks);
  assert.equal(cutB(), cutB(before), "B is left untouched");
});

test("Delete / duplicate / split find a clip inside a parked cut: say which cut it is in and that user_interface_switch_cut is needed, and do not silently do nothing", () => {
  const before = fresh();
  for (const [tool, args] of [["remove_clip", { clipId: "b1", force: true, reason: "test" }], ["duplicate_clip", { clipId: "b1" }], ["split_clip", { clipId: "b1", t: 2 }]]) {
    assert.throws(() => call(tool, args), /it is in cut "Cut B" \(B\).*user_interface_switch_cut/, tool);
  }
  assert.equal(getState().project, before, "Nothing was written");
  assert.throws(() => call("update_clip", { clipId: "no-such", params: { size: 1 } }), (e) => e.message === "clip no-such not found");
  assert.throws(() => call("get_clip", { clipId: "no-such" }), (e) => e.message === "clip no-such not found");
});

test("Error inside the scope: the project returns to its real shape, and later calls work as usual", () => {
  const before = fresh();
  assert.throws(() => call("update_clip", { clipId: "b1", opacity: 5 }), /opacity must be 0~1/);
  assert.equal(getState().project, before);
  call("update_clip", { clipId: "b1", params: { size: 3 } });
  assert.equal(clipB("b1").params.size, 3);
  assert.equal(getState().project.activeCutId, "A");
});

test("runInCutScope: nested editing of another cut is rejected; wrapping an async function is rejected; the active cut and a nonexistent cut are handled in place as usual", () => {
  fresh();
  assert.throws(() => actions.editInCut("B", () => actions.editInCut("X", () => 1)), /Cannot edit another cut while editing one cut/);
  assert.equal(actions.editInCut("B", () => actions.editInCut("B", () => 7)), 7, "The same cut can be nested");
  assert.throws(() => actions.editInCut("B", () => Promise.resolve(1)), /can only wrap synchronous functions/);
  assert.equal(getState().project.activeCutId, "A", "Restored even after an error");
  assert.equal(actions.editInCut("A", () => getState().project.activeCutId), "A");
  assert.equal(actions.editInCut("nope", () => getState().project.activeCutId), "A");
});

test("kernel: cutEditView treats B as active with A carrying its own content; foldCutEdit folds back without changing the active cut", () => {
  const real = fresh();
  assert.deepEqual(parkedCutOfClip(real, "b1"), { cutId: "B", cutName: "Cut B" });
  assert.equal(parkedCutOfClip(real, "a1"), null, "Ones in the active cut do not count");
  const view = cutEditView(real, "B");
  assert.equal(view.activeCutId, "B");
  assert.equal(view.tracks, cutB(real).tracks);
  const entryA = view.cuts.find((c) => c.id === "A");
  assert.equal(entryA.tracks, real.tracks, "A goes back to being an entry, carrying its own content");
  assert.equal(cutEditView(real, "A"), null);
  assert.equal(cutEditView(real, "nope"), null);
  const back = foldCutEdit(real, view, "B");
  assert.equal(back.activeCutId, "A");
  assert.equal(back.tracks, real.tracks);
  assert.equal(back.cuts.find((c) => c.id === "A"), real.cuts.find((c) => c.id === "A"), "A's entry is unchanged");
  assert.equal(cutB(back).tracks, cutB(real).tracks, "Unchanged means the same object");
  assert.equal(cutB(back).duration, 6);
});

test("On folding back, new project-level things (assets, etc.) follow edited, without adding keys to the entry out of thin air", () => {
  const real = fresh();
  const p0 = { ...real, cuts: real.cuts.map((c) => (c.id === "B" ? { id: "B", name: "Cut B", tracks: cutB(real).tracks } : c)) };
  const view = cutEditView(p0, "B");
  const back = foldCutEdit(p0, { ...view, media: [...view.media, { id: "m2", kind: "audio", name: "x", url: "y" }] }, "B");
  assert.equal(back.media.length, 2);
  const entry = cutB(back);
  assert.equal("transitions" in entry, false, "There was no transitions key originally, it is still empty after the edit, and none is added out of thin air");
  assert.equal("duration" in entry, false, "There was no duration key originally and the value did not change, so none is added out of thin air");
});

test("list_cuts with cutId: additionally returns that cut's timeline, so clip ids can be obtained without switching", () => {
  fresh();
  const plain = call("list_cuts", undefined);
  assert.equal("timeline" in plain, false);
  const r = call("list_cuts", { cutId: "B" });
  assert.equal(r.activeCutId, "A");
  assert.equal(r.timeline.cutId, "B");
  assert.equal(r.timeline.active, false);
  assert.deepEqual(r.timeline.tracks.map((t) => [t.trackId, t.clips.map((c) => c.id)]), [["tb1", ["b1", "b2"]], ["tb2", ["bm"]]]);
  assert.equal(r.timeline.duration, 6);
  assert.equal(getState().project.activeCutId, "A", "Read-only, not switched");
  assert.throws(() => call("list_cuts", { cutId: "nope" }), /Cut not found/);
});

test("Tool descriptions: list_cuts / user_interface_switch_cut / update_clip state that editing existing clips in other cuts needs no switch", async () => {
  const { tools } = await import("../../../server/mcp-tools.mjs");
  const d = (n) => tools.find((t) => t.name === n).description;
  assert.match(d("list_cuts"), /does not need user_interface_switch_cut/);
  assert.match(d("list_cuts"), /without switching the active cut/);
  assert.match(d("list_cuts"), /pass cutId to see_frames/);
  assert.match(d("user_interface_switch_cut"), /Acts on the user's interface/);
  assert.match(d("user_interface_switch_cut"), /active cut shared by all members/);
  assert.match(d("update_clip"), /no need for user_interface_switch_cut/);
  assert.equal(tools.some((t) => t.name === "switch_cut"), false, "The old name no longer appears in the tool list");
  assert.ok(tools.find((t) => t.name === "list_cuts").inputSchema.properties.cutId, "list_cuts accepts cutId");
});
