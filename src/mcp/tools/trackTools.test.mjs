// 序列工具(list/remove/update/move_track)的门槛和 store 的连带清理。
// 跑法:node --test src/mcp/tools/trackTools.test.mjs
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

    // list_tracks:空的标 empty,锁定标 locked
    const listed = tt.listTracks().tracks;
    assert.deepEqual(listed.filter((t) => t.empty).map((t) => t.trackId), ["t-e1", "t-e2", "t-lock"]);
    assert.equal(listed[1].media, 2);
    assert.equal(listed[4].locked, true);

    // 空序列一次删两条,一步撤销
    const r = tt.removeTrack({ trackIds: ["t-e1", "t-e2"] });
    assert.deepEqual(r.removed.map((x) => x.trackId), ["t-e1", "t-e2"]);
    assert.deepEqual(getState().project.tracks.map((t) => t.id), ["t-cap", "t-v", "t-lock"]);
    actions.undo();
    assert.equal(getState().project.tracks.length, 5);

    // 门槛:有内容要 force+reason;锁定不删;不认识的 id 报出现有的;不能删光
    assert.throws(() => tt.removeTrack({ trackId: "t-v" }), /still has content.*force:true/);
    assert.throws(() => tt.removeTrack({ trackId: "t-v", force: true }), /reason/);
    assert.throws(() => tt.removeTrack({ trackId: "t-lock" }), /is locked/);
    assert.throws(() => tt.removeTrack({ trackId: "nope" }), /No track nope.*t-cap "Captions track"/);
    assert.throws(() => tt.removeTrack({ trackIds: ["t-cap", "t-v", "t-e1", "t-e2", "t-lock"] }), /at least one must remain/);
    assert.throws(() => tt.removeTrack({}), /trackId/);
    assert.equal(getState().project.tracks.length, 5);

    // 连片段一起删:挂在上面的转场撤掉,不留悬空引用
    assert.equal(actions.addTransition({ kind: "crossfade", clipId: "a", otherClipId: "b", dur: 0.5 }).ok, true);
    assert.equal(getState().project.transitions.length, 1);
    actions.select(["a"]);
    const forced = tt.removeTrack({ trackId: "t-v", force: true, reason: "The user asked to clear this one" });
    assert.equal(forced.reason, "The user asked to clear this one");
    assert.match(forced.note, /1 place/);
    const allIds = new Set(getState().project.tracks.flatMap((t) => t.clips.map((c) => c.id)));
    for (const tr of getState().project.transitions ?? []) {
      assert.ok(allIds.has(tr.aId) && (!tr.bId || allIds.has(tr.bId)), "After deleting a track, no transition may be left pointing to a nonexistent clip");
    }
    assert.deepEqual(getState().selection, []);
    actions.loadProject(p);

    // update_track:改名 / 隐藏,类型不对就拒
    const before = getState().project;
    const u = tt.updateTrack({ trackId: "t-e1", name: "  Ambient sound ", hidden: true });
    assert.equal(u.track.name, "Ambient sound");
    assert.equal(u.track.hidden, true);
    assert.match(u.note, /does not appear in the preview and export/);
    assert.deepEqual(diffScopes(before, getState().project), ["Cut 1->Ambient sound"]);
    assert.throws(() => tt.updateTrack({ trackId: "t-e1", hidden: "yes" }), /true or false/);
    assert.throws(() => tt.updateTrack({ trackId: "t-e1", name: "   " }), /cannot be empty/);
    assert.throws(() => tt.updateTrack({ trackId: "t-e1" }), /provide at least one/);

    // move_track:挪到最上面;只调顺序也要让别的 Agent 知道
    const beforeMove = getState().project;
    const m = tt.moveTrack({ trackId: "t-lock", index: 0 });
    assert.equal(m.tracks[0].trackId, "t-lock");
    assert.deepEqual(diffScopes(beforeMove, getState().project), ["Cut 1->Track order"]);
    assert.throws(() => tt.moveTrack({ trackId: "t-lock", index: 5 }), /0~4/);
    assert.throws(() => tt.moveTrack({ trackId: "t-lock", index: 1.5 }), /0~4/);

    // add_track 带 index 插在指定位置
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
