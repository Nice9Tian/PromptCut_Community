/**
 * 不切换激活剪辑,就地改停放剪辑里的片段(线上 2026-10-21:每轮都要 switch_cut 切过去改完再切回来,
 * activeCutId 是共享字段,所有成员的界面一起翻)。钉住:
 *   - update_clip / get_clip / set_clip / set_position / set_rect / align / nudge / set_emphasis / set_clip_volume / set_clip_muted
 *     找得到停放剪辑里的片段并改在对的那条剪辑里,activeCutId 与激活剪辑的内容(同一份对象)原样不动;
 *   - 没有任何监听者、同步层、撤销栈看到过「视图」形状的项目;提交只改那条剪辑条目(文档差异里只有 /cuts/@B/…);
 *   - 改的全是新对象,没改到的序列 / 片段保持同一份对象;一步撤销就回来;
 *   - 回包标明在哪条剪辑、timeline 是那条剪辑的、look 的调用带上 cutId(see_frames 能看没激活的剪辑,2026-10-21);停放剪辑的总时长跟着内容走;
 *   - 其它按 clipId 找的工具(删、复制、切分)找到停放剪辑里的片段时说清在哪条剪辑、要 switch_cut,而不是静默什么都没做。
 * 跑:node --experimental-test-module-mocks --test src/mcp/handlers/parkedCutEdit.test.mjs
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
  id: "pk-card", name: "停放测试卡", description: "", source: "user",
  defaults: { color: "#ffd27f", size: 10 },
  controls: [{ key: "color", label: "颜色", type: "text" }, { key: "size", label: "大小", type: "number" }],
  Component: () => null,
}]);

const proj = () => ({
  version: 1, id: "p-park", name: "t", width: 1280, height: 720, fps: 30, duration: 10, themeId: "midnight",
  media: [{ id: "m-aud", kind: "audio", name: "配乐", url: "x.mp3", duration: 30 }],
  tracks: [
    { id: "ta1", name: "序列 1", clips: [{ id: "a1", cardId: "pk-card", start: 0, end: 4, params: { color: "#111111", size: 1 } }] },
    { id: "ta2", name: "序列 2", clips: [] },
  ],
  cuts: [
    { id: "A", name: "剪辑A" },
    {
      id: "B", name: "剪辑B", duration: 6, transitions: [],
      tracks: [
        { id: "tb1", name: "B序列 1", clips: [
          { id: "b1", cardId: "pk-card", start: 0, end: 3, params: { color: "#ffd27f", size: 10 } },
          { id: "b2", cardId: "pk-card", start: 3, end: 6, params: { color: "#222222", size: 2 } },
        ] },
        { id: "tb2", name: "B序列 2", clips: [{ id: "bm", cardId: "", mediaId: "m-aud", mediaOffset: 0, start: 0, end: 6, params: {} }] },
      ],
    },
  ],
  activeCutId: "A",
});
const fresh = () => { actions.loadProject(proj()); return getState().project; };
const cutB = (p = getState().project) => p.cuts.find((c) => c.id === "B");
const clipB = (id, p = getState().project) => cutB(p).tracks.flatMap((t) => t.clips).find((c) => c.id === id);

/** 记下每一次通知时 store 里的项目:任何时候都必须是真实形状(激活的是 A、tracks 是 A 的内容) */
function watchShapes() {
  const seen = [];
  const off = subscribe(() => seen.push(getState().project));
  return { seen, off };
}

test("update_clip 改停放剪辑里的片段:改在 B 里,activeCutId 与 A 的内容原样不动,回包标明在哪条剪辑", () => {
  const before = fresh();
  const w = watchShapes();
  const r = call("update_clip", { clipId: "b1", params: { size: 24 }, opacity: 0.5 });
  w.off();
  const after = getState().project;
  assert.equal(after.activeCutId, "A", "没切换");
  assert.equal(after.tracks, before.tracks, "激活剪辑的 tracks 是同一份对象");
  assert.equal(after.duration, before.duration);
  assert.deepEqual(clipB("b1").params, { color: "#ffd27f", size: 24 }, "补丁合并");
  assert.equal(clipB("b1").opacity, 0.5);
  assert.equal(clipB("b2", after), clipB("b2", before), "没改的片段同一份对象");
  assert.notEqual(clipB("b1", after), clipB("b1", before), "改了的是新对象");
  assert.equal(cutB(after).tracks[1], cutB(before).tracks[1], "没改的序列同一份对象");
  assert.equal(r.ok, true);
  assert.deepEqual(r.cut, { id: "B", name: "剪辑B", active: false });
  assert.match(r.cutNote, /没有激活的剪辑「剪辑B」/);
  assert.equal(r.look?.tool, "see_frames");
  assert.equal(r.look.args.cutId, "B", "look 带上 cutId:看它的画面不用切换");
  assert.equal(r.look.args.clipId, "b1");
  assert.match(r.cutNote, /see_frames 传 cutId: "B"/);
  assert.deepEqual(r.timeline.tracks.map((t) => t.trackId), ["tb1", "tb2"], "timeline 是 B 的");
  assert.deepEqual(r.changedParams, { size: { from: 10, to: 24 } });
  assert.ok(w.seen.length > 0);
  for (const p of w.seen) {
    assert.equal(p.activeCutId, "A", "监听者从没见过视图");
    assert.equal(p.tracks, before.tracks);
  }
});

test("文档差异里只有 /cuts/@B/ 下面的路径(不碰激活剪辑、不动 activeCutId),一步撤销全回来", () => {
  const before = fresh();
  call("update_clip", { clipId: "b1", params: { size: 24 } });
  const { ops } = diffProject(before, getState().project);
  assert.ok(ops.length > 0);
  for (const op of ops) assert.match(op.path, /^\/cuts\/@B\/tracks\/@tb1\/clips\/@b1\//, op.path);
  actions.undo();
  assert.equal(getState().project, before, "撤销回到改前的同一份项目");
  assert.equal(getState().project.activeCutId, "A");
});

test("提交给同步层的 prev / next 都是真实形状", () => {
  const before = fresh();
  const commits = [];
  core.attachProjectSync({
    commit(prev, next) { commits.push({ prev, next }); return next; },
    load: (p) => p, undo() {}, redo() {}, canUndo: () => false, canRedo: () => false,
  });
  try {
    call("update_clip", { clipId: "b1", params: { size: 24 } });
  } finally { core.attachProjectSync(null); }
  assert.equal(commits.length, 1, "一次工具调用一次提交(不再有切过去、切回来两次多余的写入)");
  assert.equal(commits[0].prev, before);
  assert.equal(commits[0].next.activeCutId, "A");
  assert.equal(commits[0].next.tracks, before.tracks);
  assert.equal(cutB(commits[0].next).tracks[0].clips[0].params.size, 24);
});

test("get_clip / set_clip 找得到停放剪辑里的片段", () => {
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

test("set_position / set_rect / align / nudge 改停放剪辑里片段的框", () => {
  const before = fresh();
  call("set_rect", { clipId: "b1", x1: 100, y1: 100, x2: 500, y2: 400 });
  const f1 = clipB("b1").frame;
  assert.ok(f1, "set_rect 写了框");
  call("set_position", { clipId: "b1", x: 10, y: 20 });
  assert.equal(clipB("b1").frame.x, 10);
  call("nudge", { clipId: "b1", dx: 5, dy: 5 });
  assert.equal(clipB("b1").frame.x, 15);
  const r = call("align", { clipId: "b1", h: "left" });
  assert.equal(r.cut.id, "B");
  assert.equal(getState().project.tracks, before.tracks);
  assert.equal(getState().project.activeCutId, "A");
});

test("set_emphasis / set_clip_volume / set_clip_muted 改停放剪辑里的片段", () => {
  const before = fresh();
  const e = call("set_emphasis", { clipId: "b1", kind: "shadow", size: 8 });
  assert.equal(e.ok, true);
  assert.ok(clipB("b1").emphasis, "强调写进了 B 里的片段");
  const v = call("set_clip_volume", { clipId: "bm", volume: 0.4 });
  assert.equal(v.ok, true);
  assert.equal(clipB("bm").audioVolume, 0.4);
  const m = call("set_clip_muted", { clipId: "bm", muted: true });
  assert.equal(m.ok, true);
  assert.equal(clipB("bm").audioMuted, true);
  assert.equal(getState().project.tracks, before.tracks);
  assert.equal(getState().project.activeCutId, "A");
});

test("update_clip 换序列:B 里的序列行,A 里的序列不行(说清是哪条剪辑的序列)", () => {
  fresh();
  call("update_clip", { clipId: "b2", trackId: "tb2", start: 7, end: 8 });
  assert.equal(cutB().tracks.find((t) => t.id === "tb2").clips.some((c) => c.id === "b2"), true);
  assert.throws(() => call("update_clip", { clipId: "b1", trackId: "ta2" }), /找不到序列 ta2/);
});

test("停放剪辑的总时长跟着内容走(与激活剪辑同一条规则)", () => {
  fresh();
  assert.equal(cutB().duration, 6);
  call("update_clip", { clipId: "b2", end: 9 });
  assert.equal(cutB().duration, 9, "拉长内容,总时长跟着长");
  call("update_clip", { clipId: "b2", end: 4 });
  assert.equal(cutB().duration, 6, "缩短内容,总时长缩回内容末尾(配乐 bm 到第 6 秒)");
});

test("激活剪辑里的片段照旧:不标 cut、带 look,行为不变", () => {
  const before = fresh();
  const r = call("update_clip", { clipId: "a1", params: { size: 7 } });
  assert.equal(r.ok, true);
  assert.equal("cut" in r, false);
  assert.ok(r.look);
  assert.notEqual(getState().project.tracks, before.tracks);
  assert.equal(cutB(), cutB(before), "B 原样不动");
});

test("删除 / 复制 / 切分找到停放剪辑里的片段:说清在哪条剪辑、要 user_interface_switch_cut,不静默什么都没做", () => {
  const before = fresh();
  for (const [tool, args] of [["remove_clip", { clipId: "b1", force: true, reason: "测" }], ["duplicate_clip", { clipId: "b1" }], ["split_clip", { clipId: "b1", t: 2 }]]) {
    assert.throws(() => call(tool, args), /它在剪辑「剪辑B」\(B\)里.*user_interface_switch_cut/, tool);
  }
  assert.equal(getState().project, before, "什么都没写");
  assert.throws(() => call("update_clip", { clipId: "no-such", params: { size: 1 } }), (e) => e.message === "找不到 clip no-such");
  assert.throws(() => call("get_clip", { clipId: "no-such" }), (e) => e.message === "找不到 clip no-such");
});

test("在 scope 里出错:项目回到真实形状,之后的调用照常", () => {
  const before = fresh();
  assert.throws(() => call("update_clip", { clipId: "b1", opacity: 5 }), /opacity 是 0~1/);
  assert.equal(getState().project, before);
  call("update_clip", { clipId: "b1", params: { size: 3 } });
  assert.equal(clipB("b1").params.size, 3);
  assert.equal(getState().project.activeCutId, "A");
});

test("runInCutScope:嵌套改另一条被拒;包异步函数被拒;激活那条与不存在的剪辑就地照常做", () => {
  fresh();
  assert.throws(() => actions.editInCut("B", () => actions.editInCut("X", () => 1)), /不能在改一条剪辑的过程中嵌套/);
  assert.equal(actions.editInCut("B", () => actions.editInCut("B", () => 7)), 7, "同一条可以嵌套");
  assert.throws(() => actions.editInCut("B", () => Promise.resolve(1)), /只能包同步函数/);
  assert.equal(getState().project.activeCutId, "A", "出错后也还原");
  assert.equal(actions.editInCut("A", () => getState().project.activeCutId), "A");
  assert.equal(actions.editInCut("nope", () => getState().project.activeCutId), "A");
});

test("kernel:cutEditView 把 B 当激活、A 带着自己的内容;foldCutEdit 折回去不改激活剪辑", () => {
  const real = fresh();
  assert.deepEqual(parkedCutOfClip(real, "b1"), { cutId: "B", cutName: "剪辑B" });
  assert.equal(parkedCutOfClip(real, "a1"), null, "激活剪辑里的不算");
  const view = cutEditView(real, "B");
  assert.equal(view.activeCutId, "B");
  assert.equal(view.tracks, cutB(real).tracks);
  const entryA = view.cuts.find((c) => c.id === "A");
  assert.equal(entryA.tracks, real.tracks, "A 退回条目,带着自己的内容");
  assert.equal(cutEditView(real, "A"), null);
  assert.equal(cutEditView(real, "nope"), null);
  const back = foldCutEdit(real, view, "B");
  assert.equal(back.activeCutId, "A");
  assert.equal(back.tracks, real.tracks);
  assert.equal(back.cuts.find((c) => c.id === "A"), real.cuts.find((c) => c.id === "A"), "A 的条目原样");
  assert.equal(cutB(back).tracks, cutB(real).tracks, "没改就是同一份");
  assert.equal(cutB(back).duration, 6);
});

test("折回时项目级的新东西(素材等)照 edited,不凭空给条目加键", () => {
  const real = fresh();
  const p0 = { ...real, cuts: real.cuts.map((c) => (c.id === "B" ? { id: "B", name: "剪辑B", tracks: cutB(real).tracks } : c)) };
  const view = cutEditView(p0, "B");
  const back = foldCutEdit(p0, { ...view, media: [...view.media, { id: "m2", kind: "audio", name: "x", url: "y" }] }, "B");
  assert.equal(back.media.length, 2);
  const entry = cutB(back);
  assert.equal("transitions" in entry, false, "原来没有 transitions 键,改完仍是空,不凭空多一个");
  assert.equal("duration" in entry, false, "原来没有 duration 键、值没变,不凭空多一个");
});

test("list_cuts 带 cutId:多返回那条剪辑的 timeline,拿到片段 id 不用切换", () => {
  fresh();
  const plain = call("list_cuts", undefined);
  assert.equal("timeline" in plain, false);
  const r = call("list_cuts", { cutId: "B" });
  assert.equal(r.activeCutId, "A");
  assert.equal(r.timeline.cutId, "B");
  assert.equal(r.timeline.active, false);
  assert.deepEqual(r.timeline.tracks.map((t) => [t.trackId, t.clips.map((c) => c.id)]), [["tb1", ["b1", "b2"]], ["tb2", ["bm"]]]);
  assert.equal(r.timeline.duration, 6);
  assert.equal(getState().project.activeCutId, "A", "只读,没切换");
  assert.throws(() => call("list_cuts", { cutId: "nope" }), /找不到剪辑/);
});

test("工具说明:list_cuts / user_interface_switch_cut / update_clip 写明改别的剪辑里已有的片段不用切换", async () => {
  const { tools } = await import("../../../server/mcp-tools.mjs");
  const d = (n) => tools.find((t) => t.name === n).description;
  assert.match(d("list_cuts"), /不用 user_interface_switch_cut/);
  assert.match(d("list_cuts"), /不切换激活的剪辑/);
  assert.match(d("list_cuts"), /see_frames 传 cutId/);
  assert.match(d("user_interface_switch_cut"), /会动用户的界面/);
  assert.match(d("user_interface_switch_cut"), /共享的激活剪辑/);
  assert.match(d("update_clip"), /不用 user_interface_switch_cut/);
  assert.equal(tools.some((t) => t.name === "switch_cut"), false, "旧名不再出现在工具清单里");
  assert.ok(tools.find((t) => t.name === "list_cuts").inputSchema.properties.cutId, "list_cuts 收 cutId");
});
