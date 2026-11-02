// Gates for track tools (list/remove/update/move_track) and cascading cleanup in store.
// Run: node --test src/mcp/tools/trackTools.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
import { tools } from "../../../server/mcp-tools.mjs";

function fixture() {
  return [
    { id: "t-cap", name: "Captions track", clips: [{ id: "cap", cardId: "caption-track", params: {}, start: 0, end: 10 }] },
    { id: "t-v", name: "Video", clips: [
      { id: "a", cardId: "", params: {}, mediaId: "m", start: 0, end: 5 },
      { id: "b", cardId: "", params: {}, mediaId: "m", start: 5, end: 10 },
    ] },
    { id: "t-e1", name: "Media · Sound", clips: [] },
    { id: "t-e2", name: "Media · Sound", clips: [] },
    { id: "t-lock", name: "Locked", locked: true, clips: [] },
  ];
}

test("Track tools: list, delete, edit, move, gates and undo", async () => {
  const server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    const { actions, getState } = await server.ssrLoadModule("/src/store/project.ts");
    const { createEmptyProject } = await server.ssrLoadModule("/src/kernel/project.ts");
    const { createTrackTools } = await server.ssrLoadModule("/src/mcp/tools/trackTools.ts");
    const { diffScopes } = await server.ssrLoadModule("/src/ai/agentBus.ts");
    const tt = createTrackTools({ getState, actions });
    const p = createEmptyProject();
    p.media = [{ id: "m", kind: "video", name: "m.mp4", url: "/media/m.mp4", duration: 20 }];
    p.tracks = fixture();
    actions.loadProject(p);

    // list_tracks: mark empty as empty, mark locked as locked
    const listed = tt.listTracks().tracks;
    assert.deepEqual(listed.filter((t) => t.empty).map((t) => t.trackId), ["t-e1", "t-e2", "t-lock"]);
    assert.equal(listed[1].media, 2);
    assert.equal(listed[4].locked, true);

    // Delete two empty tracks at once, single undo step
    const r = tt.removeTrack({ trackIds: ["t-e1", "t-e2"] });
    assert.deepEqual(r.removed.map((x) => x.trackId), ["t-e1", "t-e2"]);
    assert.deepEqual(getState().project.tracks.map((t) => t.id), ["t-cap", "t-v", "t-lock"]);
    actions.undo();
    assert.equal(getState().project.tracks.length, 5);

    // Gate: tracks with content require force+reason; locked not deleted; unknown id reports existing
    // ones; cannot delete all
    assert.throws(() => tt.removeTrack({ trackId: "t-v" }), /still has content.*force:true/);
    assert.throws(() => tt.removeTrack({ trackId: "t-v", force: true }), /reason/);
    assert.throws(() => tt.removeTrack({ trackId: "t-lock" }), /locked by the user/);
    assert.throws(() => tt.removeTrack({ trackId: "nope" }), /no track nope.*t-cap "Captions track"/);
    assert.throws(() => tt.removeTrack({ trackIds: ["t-cap", "t-v", "t-e1", "t-e2", "t-lock"] }), /At least one track must remain/);
    assert.throws(() => tt.removeTrack({}), /trackId/);
    assert.equal(getState().project.tracks.length, 5);

    // Delete clips together: remove transitions attached to them, leaving no dangling references
    assert.equal(actions.addTransition({ kind: "crossfade", clipId: "a", otherClipId: "b", dur: 0.5 }).ok, true);
    assert.equal(getState().project.transitions.length, 1);
    actions.select(["a"]);
    const forced = tt.removeTrack({ trackId: "t-v", force: true, reason: "The user asked to clear this one" });
    assert.equal(forced.reason, "The user asked to clear this one");
    assert.match(forced.note, /1 transitions/);
    const allIds = new Set(getState().project.tracks.flatMap((t) => t.clips.map((c) => c.id)));
    for (const tr of getState().project.transitions ?? []) {
      assert.ok(allIds.has(tr.aId) && (!tr.bId || allIds.has(tr.bId)), "After deleting a track, no transition may be left pointing to a nonexistent clip");
    }
    assert.deepEqual(getState().selection, []);
    actions.loadProject(p);

    // update_track: rename / hide; reject if type is incorrect
    const before = getState().project;
    const u = tt.updateTrack({ trackId: "t-e1", name: "  Ambient sound ", hidden: true });
    assert.equal(u.track.name, "Ambient sound");
    assert.equal(u.track.hidden, true);
    assert.match(u.note, /does not appear in preview or export/);
    assert.deepEqual(diffScopes(before, getState().project), ["Cut 1->Ambient sound"]);
    assert.throws(() => tt.updateTrack({ trackId: "t-e1", hidden: "yes" }), /true or false/);
    assert.throws(() => tt.updateTrack({ trackId: "t-e1", name: "   " }), /cannot be empty/);
    assert.throws(() => tt.updateTrack({ trackId: "t-e1" }), /Provide at least one/);

    // move_track: move to top; even order-only adjustments must be made known to other Agents
    const beforeMove = getState().project;
    const m = tt.moveTrack({ trackId: "t-lock", index: 0 });
    assert.equal(m.tracks[0].trackId, "t-lock");
    assert.deepEqual(diffScopes(beforeMove, getState().project), ["Cut 1->track order"]);
    assert.throws(() => tt.moveTrack({ trackId: "t-lock", index: 5 }), /0 to 4/);
    assert.throws(() => tt.moveTrack({ trackId: "t-lock", index: 1.5 }), /0 to 4/);

    // add_track with index inserts at specified position
    const added = tt.addTrack({ name: "Background music", index: 1 });
    assert.equal(added.index, 1);
    assert.equal(getState().project.tracks[1].name, "Background music");
  } finally {
    await server.close();
  }
});

test("Declaration of the track tools: required fields match the schema", () => {
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  for (const n of ["list_tracks", "remove_track", "update_track", "move_track"]) assert.equal(byName[n]?.side, "agent", n);
  assert.deepEqual(byName.update_track.inputSchema.required, ["trackId"]);
  assert.deepEqual(byName.move_track.inputSchema.required, ["trackId", "index"]);
});
