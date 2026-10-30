// 滤镜库工具(list/create/update/remove/apply_filter)和 store 的连带清理。
// 跑法:node --test src/editor/right/filterTools.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
import { tools } from "../../../server/mcp-tools.mjs";

test("滤镜库:建、挂、改、删,门槛、撤销、跨剪辑清理", async () => {
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
      { id: "t1", name: "画面", clips: [{ id: "c1", cardId: "", params: {}, mediaId: "v", start: 0, end: 5 }, { id: "c2", cardId: "", params: {}, mediaId: "v", start: 5, end: 10 }] },
      { id: "t2", name: "卡片", clips: [{ id: "k1", cardId: "caption-track", params: {}, start: 0, end: 5 }] },
      { id: "t3", name: "声音", clips: [{ id: "s1", cardId: "", params: {}, mediaId: "a", start: 0, end: 5 }] },
      { id: "t4", name: "锁住的", locked: true, clips: [{ id: "c3", cardId: "", params: {}, mediaId: "v", start: 0, end: 5 }] },
    ];
    actions.loadProject(p);

    // 建 + 顺手挂;片段不合规时什么都不建
    assert.throws(() => ft.createFilter({ name: "x", ops: [{ kind: "blur", value: 1 }], clipId: "k1" }), /卡片/);
    assert.throws(() => ft.createFilter({ name: "x", ops: [{ kind: "blur", value: 1 }], clipId: "s1" }), /声音/);
    assert.throws(() => ft.createFilter({ name: "x", ops: [{ kind: "blur", value: 1 }], clipId: "c3" }), /锁定/);
    assert.equal(getState().project.filters, undefined, "校验没过不能留下半个滤镜");
    const made = ft.createFilter({
      name: "呼吸", params: { amount: { default: 0.2, min: 0, max: 0.5 } },
      ops: [{ kind: "brightness", value: "1 + amount*sin(t*2*PI)" }], clipId: "c1", clipParams: { amount: 9 },
    });
    const fid = made.filterId;
    assert.match(fid, /^fx-/);
    assert.equal(made.filter.animated, true);
    assert.deepEqual(getState().project.tracks[0].clips[0].filter, { id: fid, params: { amount: 0.5 } }); // 夹到 max
    assert.equal(timelineDigest(getState().project).tracks[0].clips[0].filterId, fid);
    // 建 + 挂是一步撤销:撤一次库里没了、片段上也摘了;重做回来
    actions.undo();
    assert.equal(getState().project.filters?.length ?? 0, 0);
    assert.equal(getState().project.tracks[0].clips[0].filter, undefined);
    actions.redo();
    assert.equal(getState().project.tracks[0].clips[0].filter.id, fid);

    // 挂到第二段、换参数、摘掉
    assert.equal(ft.applyFilter({ clipId: "c2", filterId: fid }).filterId, fid);
    assert.throws(() => ft.applyFilter({ clipId: "c2", filterId: fid, params: { nope: 1 } }), /没有参数 nope/);
    assert.throws(() => ft.applyFilter({ clipId: "c2", filterId: "fx-none" }), /滤镜库里没有 fx-none.*呼吸/);
    assert.equal(ft.listFilters().filters[0].usedBy.length, 2);
    assert.equal(ft.applyFilter({ clipId: "c2", filterId: "" }).removed, true);
    assert.equal("filter" in getState().project.tracks[0].clips[1], false, "摘掉要把字段整个拿掉");
    actions.undo();
    assert.equal(getState().project.tracks[0].clips[1].filter.id, fid);

    // 改:挂着的都跟着变;删掉了声明的参数要提醒
    const upd = ft.updateFilter({ filterId: fid, params: {}, ops: [{ kind: "grayscale", value: "p" }] });
    assert.match(upd.note, /2 段/);
    assert.match(upd.warning, /c1/);
    assert.throws(() => ft.updateFilter({ filterId: fid, ops: [{ kind: "saturate", value: 9 }] }), /0~2/);

    // 删:挂着要 force + reason;停放剪辑里挂着的也要摘
    const other = actions.addCut("剪辑备份", { switchTo: false });
    const q = getState().project;
    actions.loadProject({
      ...q,
      cuts: q.cuts.map((c) => (c.id === other.id ? { ...c, tracks: [{ id: "tp", name: "p", clips: [{ id: "cp", cardId: "", params: {}, mediaId: "v", start: 0, end: 3, filter: { id: fid } }] }] } : c)),
    });
    assert.equal(ft.listFilters().filters[0].usedBy.length, 3);
    assert.throws(() => ft.removeFilter({ filterId: fid }), /还挂在 3 段上.*剪辑备份 的 cp/);
    assert.throws(() => ft.removeFilter({ filterId: fid, force: true }), /reason/);
    const rm = ft.removeFilter({ filterId: fid, force: true, reason: "用户不要了" });
    assert.equal(rm.detached.length, 3);
    const after = getState().project;
    assert.deepEqual(after.filters, []);
    for (const t of after.tracks) for (const c of t.clips) assert.equal(c.filter, undefined);
    for (const cut of after.cuts) for (const t of cut.tracks ?? []) for (const c of t.clips) assert.equal(c.filter, undefined, "停放剪辑里也要摘干净");
  } finally {
    await server.close();
  }
});

test("滤镜工具的声明:必填项", () => {
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  for (const n of ["list_filters", "create_filter", "update_filter", "remove_filter", "apply_filter"]) assert.equal(byName[n]?.side, "agent", n);
  assert.deepEqual(byName.create_filter.inputSchema.required, ["name", "ops"]);
  assert.deepEqual(byName.apply_filter.inputSchema.required, ["clipId", "filterId"]);
  // 八种带数值的 + curves / matrix 两种查表类;后两种不写 value,所以 ops 每项只必填 kind
  const item = byName.create_filter.inputSchema.properties.ops.items;
  assert.deepEqual(item.properties.kind.enum.length, 10);
  assert.deepEqual(item.properties.kind.enum.slice(-2), ["curves", "matrix"]);
  assert.deepEqual(item.required, ["kind"]);
});
