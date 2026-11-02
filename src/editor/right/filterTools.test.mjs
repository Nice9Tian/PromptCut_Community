// Filter library tools (list/create/update/remove/apply_filter) and related cleanup of the store.
// Run: node --test src/editor/right/filterTools.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
import { tools } from "../../../server/mcp-tools.mjs";

test("Filter library: create, attach, edit, delete; gate, undo, cross-cut cleanup", async () => {
  const server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    const { actions, getState } = await server.ssrLoadModule("/src/store/project.ts");
    const { createEmptyProject } = await server.ssrLoadModule("/src/kernel/project.ts");
    const { createFilterTools } = await server.ssrLoadModule("/src/editor/right/filterTools.ts");
    const { timelineDigest } = await server.ssrLoadModule("/src/mcp/tools/toolEcho.ts");
    const ft = createFilterTools({ getState, actions });
    const p = createEmptyProject();
    p.media = [
      { id: "v", kind: "video", name: "v.mp4", url: "/media/v.mp4", duration: 20 },
      { id: "a", kind: "audio", name: "a.mp3", url: "/media/a.mp3", duration: 20 },
    ];
    p.tracks = [
      { id: "t1", name: "Video", clips: [{ id: "c1", cardId: "", params: {}, mediaId: "v", start: 0, end: 5 }, { id: "c2", cardId: "", params: {}, mediaId: "v", start: 5, end: 10 }] },
      { id: "t2", name: "Cards", clips: [{ id: "k1", cardId: "caption-track", params: {}, start: 0, end: 5 }] },
      { id: "t3", name: "Audio", clips: [{ id: "s1", cardId: "", params: {}, mediaId: "a", start: 0, end: 5 }] },
      { id: "t4", name: "Locked", locked: true, clips: [{ id: "c3", cardId: "", params: {}, mediaId: "v", start: 0, end: 5 }] },
    ];
    actions.loadProject(p);

    // Create + attach together; create nothing if clip is invalid
    assert.throws(() => ft.createFilter({ name: "x", ops: [{ kind: "blur", value: 1 }], clipId: "k1" }), /cards use their own style parameters/);
    assert.throws(() => ft.createFilter({ name: "x", ops: [{ kind: "blur", value: 1 }], clipId: "s1" }), /audio with no picture/);
    assert.throws(() => ft.createFilter({ name: "x", ops: [{ kind: "blur", value: 1 }], clipId: "c3" }), /is locked/);
    assert.equal(getState().project.filters, undefined, "A failed validation must not leave half a filter behind");
    const made = ft.createFilter({
      name: "Breathing", params: { amount: { default: 0.2, min: 0, max: 0.5 } },
      ops: [{ kind: "brightness", value: "1 + amount*sin(t*2*PI)" }], clipId: "c1", clipParams: { amount: 9 },
    });
    const fid = made.filterId;
    assert.match(fid, /^fx-/);
    assert.equal(made.filter.animated, true);
    assert.deepEqual(getState().project.tracks[0].clips[0].filter, { id: fid, params: { amount: 0.5 } }); // Clamp to max
    assert.equal(timelineDigest(getState().project).tracks[0].clips[0].filterId, fid);
    // Create + attach is a single undo step: undo once, gone from the library and detached from the
    // clip; redo brings it back
    actions.undo();
    assert.equal(getState().project.filters?.length ?? 0, 0);
    assert.equal(getState().project.tracks[0].clips[0].filter, undefined);
    actions.redo();
    assert.equal(getState().project.tracks[0].clips[0].filter.id, fid);

    // Attach to the second clip, change parameters, detach
    assert.equal(ft.applyFilter({ clipId: "c2", filterId: fid }).filterId, fid);
    assert.throws(() => ft.applyFilter({ clipId: "c2", filterId: fid, params: { nope: 1 } }), /no parameter nope/);
    assert.throws(() => ft.applyFilter({ clipId: "c2", filterId: "fx-none" }), /No fx-none in the filter library.*Breathing/);
    assert.equal(ft.listFilters().filters[0].usedBy.length, 2);
    assert.equal(ft.applyFilter({ clipId: "c2", filterId: "" }).removed, true);
    assert.equal("filter" in getState().project.tracks[0].clips[1], false, "Detaching must remove the field entirely");
    actions.undo();
    assert.equal(getState().project.tracks[0].clips[1].filter.id, fid);

    // Update: attached ones update accordingly; warn if declared parameters are removed
    const upd = ft.updateFilter({ filterId: fid, params: {}, ops: [{ kind: "grayscale", value: "p" }] });
    assert.match(upd.note, /The 2 clips using it/);
    assert.match(upd.warning, /c1/);
    assert.throws(() => ft.updateFilter({ filterId: fid, ops: [{ kind: "saturate", value: 9 }] }), /between 0 and 2/);

    // Delete: requires force + reason if attached; attached ones in parked cuts must also be detached
    const other = actions.addCut("Cut backup", { switchTo: false });
    const q = getState().project;
    actions.loadProject({
      ...q,
      cuts: q.cuts.map((c) => (c.id === other.id ? { ...c, tracks: [{ id: "tp", name: "p", clips: [{ id: "cp", cardId: "", params: {}, mediaId: "v", start: 0, end: 3, filter: { id: fid } }] }] } : c)),
    });
    assert.equal(ft.listFilters().filters[0].usedBy.length, 3);
    assert.throws(() => ft.removeFilter({ filterId: fid }), /is still attached to 3 clips.*cp of Cut backup/);
    assert.throws(() => ft.removeFilter({ filterId: fid, force: true }), /reason/);
    const rm = ft.removeFilter({ filterId: fid, force: true, reason: "The user no longer wants it" });
    assert.equal(rm.detached.length, 3);
    const after = getState().project;
    assert.deepEqual(after.filters, []);
    for (const t of after.tracks) for (const c of t.clips) assert.equal(c.filter, undefined);
    for (const cut of after.cuts) for (const t of cut.tracks ?? []) for (const c of t.clips) assert.equal(c.filter, undefined, "Must be fully detached in parked cuts too");
  } finally {
    await server.close();
  }
});

test("Filter tool declaration: required fields", () => {
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  for (const n of ["list_filters", "create_filter", "update_filter", "remove_filter", "apply_filter"]) assert.equal(byName[n]?.side, "agent", n);
  assert.deepEqual(byName.create_filter.inputSchema.required, ["name", "ops"]);
  assert.deepEqual(byName.apply_filter.inputSchema.required, ["clipId", "filterId"]);
  // Eight with numeric values + two lookup kinds (curves / matrix); the latter two do not write
  // value, so each ops item only requires kind
  const item = byName.create_filter.inputSchema.properties.ops.items;
  assert.deepEqual(item.properties.kind.enum.length, 10);
  assert.deepEqual(item.properties.kind.enum.slice(-2), ["curves", "matrix"]);
  assert.deepEqual(item.required, ["kind"]);
});
