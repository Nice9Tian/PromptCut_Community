// 序列工具(list/remove/update/move_track)的门槛和 store 的连带清理。
// 跑法:node --test src/mcp/tools/trackTools.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
import { tools } from "../../../server/mcp-tools.mjs";

function fixture() {
  return [
    { id: "t-cap", name: "字幕轨", clips: [{ id: "cap", cardId: "caption-track", params: {}, start: 0, end: 10 }] },
    { id: "t-v", name: "视频", clips: [
      { id: "a", cardId: "", params: {}, mediaId: "m", start: 0, end: 5 },
      { id: "b", cardId: "", params: {}, mediaId: "m", start: 5, end: 10 },
    ] },
    { id: "t-e1", name: "素材 · 声音", clips: [] },
    { id: "t-e2", name: "素材 · 声音", clips: [] },
    { id: "t-lock", name: "锁住的", locked: true, clips: [] },
  ];
}

test("序列工具:列、删、改、挪,门槛和撤销", async () => {
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
    assert.throws(() => tt.removeTrack({ trackId: "t-v" }), /还有内容.*force:true/);
    assert.throws(() => tt.removeTrack({ trackId: "t-v", force: true }), /reason/);
    assert.throws(() => tt.removeTrack({ trackId: "t-lock" }), /锁定着/);
    assert.throws(() => tt.removeTrack({ trackId: "nope" }), /没有序列 nope.*t-cap「字幕轨」/);
    assert.throws(() => tt.removeTrack({ trackIds: ["t-cap", "t-v", "t-e1", "t-e2", "t-lock"] }), /至少要留一条/);
    assert.throws(() => tt.removeTrack({}), /trackId/);
    assert.equal(getState().project.tracks.length, 5);

    // 连片段一起删:挂在上面的转场撤掉,不留悬空引用
    assert.equal(actions.addTransition({ kind: "crossfade", clipId: "a", otherClipId: "b", dur: 0.5 }).ok, true);
    assert.equal(getState().project.transitions.length, 1);
    actions.select(["a"]);
    const forced = tt.removeTrack({ trackId: "t-v", force: true, reason: "用户要求清掉这条" });
    assert.equal(forced.reason, "用户要求清掉这条");
    assert.match(forced.note, /1 处/);
    const allIds = new Set(getState().project.tracks.flatMap((t) => t.clips.map((c) => c.id)));
    for (const tr of getState().project.transitions ?? []) {
      assert.ok(allIds.has(tr.aId) && (!tr.bId || allIds.has(tr.bId)), "删完序列不能留下指向不存在片段的转场");
    }
    assert.deepEqual(getState().selection, []);
    actions.loadProject(p);

    // update_track:改名 / 隐藏,类型不对就拒
    const before = getState().project;
    const u = tt.updateTrack({ trackId: "t-e1", name: "  环境音 ", hidden: true });
    assert.equal(u.track.name, "环境音");
    assert.equal(u.track.hidden, true);
    assert.match(u.note, /不出现在预览和导出/);
    assert.deepEqual(diffScopes(before, getState().project), ["剪辑1->环境音"]);
    assert.throws(() => tt.updateTrack({ trackId: "t-e1", hidden: "yes" }), /true 或 false/);
    assert.throws(() => tt.updateTrack({ trackId: "t-e1", name: "   " }), /不能为空/);
    assert.throws(() => tt.updateTrack({ trackId: "t-e1" }), /至少给一个/);

    // move_track:挪到最上面;只调顺序也要让别的 Agent 知道
    const beforeMove = getState().project;
    const m = tt.moveTrack({ trackId: "t-lock", index: 0 });
    assert.equal(m.tracks[0].trackId, "t-lock");
    assert.deepEqual(diffScopes(beforeMove, getState().project), ["剪辑1->序列顺序"]);
    assert.throws(() => tt.moveTrack({ trackId: "t-lock", index: 5 }), /0~4/);
    assert.throws(() => tt.moveTrack({ trackId: "t-lock", index: 1.5 }), /0~4/);

    // add_track 带 index 插在指定位置
    const added = tt.addTrack({ name: "配乐", index: 1 });
    assert.equal(added.index, 1);
    assert.equal(getState().project.tracks[1].name, "配乐");
  } finally {
    await server.close();
  }
});

test("序列工具的声明:必填项和 schema 对得上", () => {
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  for (const n of ["list_tracks", "remove_track", "update_track", "move_track"]) assert.equal(byName[n]?.side, "agent", n);
  assert.deepEqual(byName.update_track.inputSchema.required, ["trackId"]);
  assert.deepEqual(byName.move_track.inputSchema.required, ["trackId", "index"]);
});
