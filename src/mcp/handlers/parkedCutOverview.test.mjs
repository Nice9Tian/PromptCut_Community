/**
 * 让模型第一眼就看见别的剪辑里的片段 id(线上 2026-10-21:工具说明与系统提示词都写了「改别的剪辑里的片段不用 switch_cut」,
 * 新对话里模型仍 switch_cut -> update_clip -> switch_cut,两次尝试两次如此;它先读的 get_project / timeline 只有激活剪辑,
 * 切过去是它「看进」剪辑2 的办法)。钉住:
 *   - get_project 最前面有 parkedCuts(停放剪辑的片段索引,不带 params),单剪辑项目没有;
 *   - list_cuts 不带 cutId 也有 parkedCuts,带 cutId 时给那条的 timeline、不重复;
 *   - 工具回包的 timeline 有 otherCuts 提示(只在别的剪辑有内容时),就地改停放剪辑时的回包没有(视图是颠倒的);
 *   - switch_cut 的回包 note 说明切换会让所有成员的界面翻、改已有片段不需要它;
 *   - 一个照着工具回包办事的「模型」(只读 get_project 的 parkedCuts 找片段)全程不 switch_cut 就改成了停放剪辑里的片段。
 * 跑:node --experimental-test-module-mocks --test src/mcp/handlers/parkedCutOverview.test.mjs
 */
import { srcUrl } from "../../testing/registerTs.mjs";
import test, { mock } from "node:test";
import assert from "node:assert/strict";

mock.module(srcUrl("ai/mcpExecutor.ts"), { exports: { EditorApi: undefined } });

const { actions, getState } = await import(srcUrl("store/project.ts"));
const { registerCards } = await import(srcUrl("kernel/registry.ts"));
const { TOOL_ROUTES } = await import(srcUrl("mcp/routes.mjs"));
const { clipsHandlers } = await import(srcUrl("mcp/handlers/clips.ts"));
const { layoutHandlers } = await import(srcUrl("mcp/handlers/layout.ts"));
const { audioHandlers } = await import(srcUrl("mcp/handlers/audio.ts"));
const { effectsHandlers } = await import(srcUrl("mcp/handlers/effects.ts"));
const { projectHandlers } = await import(srcUrl("mcp/handlers/project.ts"));
const api = { ...clipsHandlers, ...layoutHandlers, ...audioHandlers, ...effectsHandlers, ...projectHandlers };
const call = (tool, args) => api[TOOL_ROUTES[tool].method](TOOL_ROUTES[tool].passArgs ? args : undefined);

registerCards([{
  id: "particles-pk", name: "粒子背景", description: "", source: "user",
  defaults: { count: 50, color: "#ffffff" },
  controls: [{ key: "count", label: "粒子数量", type: "number" }, { key: "color", label: "颜色", type: "text" }],
  Component: () => null,
}]);

const proj = (extra = {}) => ({
  version: 1, id: "p-ov", name: "t", width: 1280, height: 720, fps: 30, duration: 10, themeId: "midnight",
  media: [],
  tracks: [{ id: "ta1", name: "序列 1", clips: [{ id: "a1", cardId: "particles-pk", start: 0, end: 4, params: { count: 10 } }] }],
  cuts: [
    { id: "A", name: "剪辑1" },
    { id: "B", name: "剪辑2", duration: 6, transitions: [], tracks: [
      { id: "tb1", name: "B序列 1", clips: [
        { id: "b1", cardId: "particles-pk", label: "粒子背景", start: 0, end: 6, params: { count: 50, color: "#abcdef" } },
        { id: "b2", cardId: "particles-pk", start: 1, end: 2, params: { count: 5 } },
      ] },
    ] },
  ],
  activeCutId: "A",
  ...extra,
});
const fresh = (extra) => { actions.loadProject(proj(extra)); return getState().project; };
const cutB = () => getState().project.cuts.find((c) => c.id === "B");

test("get_project:parkedCuts 排在最前面,列出停放剪辑的片段(不带 params),激活的剪辑不在里面", () => {
  fresh();
  const r = call("get_project");
  assert.equal(Object.keys(r)[0], "parkedCuts", "放最前,模型先读到");
  assert.equal(r.parkedCuts.activeCutId, "A");
  assert.deepEqual(r.parkedCuts.cuts.map((c) => c.cutId), ["B"]);
  assert.deepEqual(r.parkedCuts.cuts[0].clips, [
    { id: "b1", trackId: "tb1", cardId: "particles-pk", cardName: "粒子背景", label: "粒子背景", start: 0, end: 6 },
    { id: "b2", trackId: "tb1", cardId: "particles-pk", cardName: "粒子背景", start: 1, end: 2 },
  ]);
  assert.match(r.parkedCuts.note, /不用 user_interface_switch_cut/);
  assert.deepEqual(r.tracks.map((t) => t.id), ["ta1"], "tracks 仍是激活剪辑的");
  assert.equal(getState().project.activeCutId, "A", "只读");
});

test("get_project:单剪辑项目没有 parkedCuts(老项目的回包形状不变)", () => {
  fresh({ cuts: [{ id: "A", name: "剪辑1" }], activeCutId: "A" });
  assert.equal("parkedCuts" in call("get_project"), false);
});

test("list_cuts:不带 cutId 就带 parkedCuts;带 cutId 给那条的 timeline、不重复列索引,timeline 不带 otherCuts", () => {
  fresh();
  const plain = call("list_cuts", undefined);
  assert.deepEqual(plain.parkedCuts.cuts[0].clips.map((c) => c.id), ["b1", "b2"]);
  assert.equal("timeline" in plain, false);
  const one = call("list_cuts", { cutId: "B" });
  assert.equal("parkedCuts" in one, false);
  assert.equal(one.timeline.cutId, "B");
  assert.equal("otherCuts" in one.timeline, false);
});

test("工具回包的 timeline:别的剪辑有内容时带 otherCuts;就地改停放剪辑的回包不带(那里的视图是颠倒的)", () => {
  fresh();
  const a = call("update_clip", { clipId: "a1", opacity: 0.8 });
  assert.deepEqual(a.timeline.otherCuts.cuts, [{ cutId: "B", name: "剪辑2", clipCount: 2 }]);
  assert.match(a.timeline.otherCuts.hint, /不用 user_interface_switch_cut/);
  const b = call("update_clip", { clipId: "b1", opacity: 0.8 });
  assert.equal(b.cut.id, "B");
  assert.equal("otherCuts" in b.timeline, false);
  fresh({ cuts: [{ id: "A", name: "剪辑1" }, { id: "B", name: "剪辑2", duration: 6, transitions: [], tracks: [] }] });
  const c = call("update_clip", { clipId: "a1", opacity: 0.5 });
  assert.equal("otherCuts" in c.timeline, false, "别的剪辑是空的就不提");
});

test("switch_cut 的回包带 note:切换会让所有成员的界面一起翻,改已有片段不需要它", () => {
  fresh();
  const r = call("user_interface_switch_cut", { cutId: "B" });
  assert.equal(r.activeCutId, "B");
  assert.match(r.note, /已切换到「剪辑2」/);
  assert.match(r.note, /所有成员的界面一起翻/);
  assert.match(r.note, /不需要它/);
  assert.match(r.note, /parkedCuts/);
});

test("工具说明:get_project / list_cuts / switch_cut 指路 parkedCuts,switch_cut 说清只在新增删除切分复制或用户明说时才用", async () => {
  const { tools } = await import("../../../server/mcp-tools.mjs");
  const d = (n) => tools.find((t) => t.name === n).description;
  assert.match(d("get_project"), /parkedCuts/);
  assert.match(d("get_project"), /不用 user_interface_switch_cut/);
  assert.match(d("list_cuts"), /parkedCuts/);
  assert.match(d("list_cuts"), /不要 user_interface_switch_cut/);
  assert.match(d("user_interface_switch_cut"), /不要用它/);
  assert.match(d("user_interface_switch_cut"), /所有成员的界面/);
});

test("系统提示词:多条剪辑一节开头就说不要 switch_cut,并指路 parkedCuts", async () => {
  const fs = await import("node:fs");
  const text = fs.readFileSync(new URL("../../../server/ai-system-prompt.md", import.meta.url), "utf8");
  const line = text.split(/\r?\n/).find((l) => l.includes("一个项目里可以有多条剪辑"));
  assert.ok(line);
  assert.ok(line.indexOf("不要 `user_interface_switch_cut`") >= 0 && line.indexOf("不要 `user_interface_switch_cut`") < line.indexOf("add_clip、序列"), "不要切换的话在最前");
  assert.match(line, /see_frames\(\{ cutId/, "看别的剪辑的画面用 see_frames 的 cutId");
  assert.match(line, /parkedCuts/);
});

/**
 * 一个照着工具回包办事的「模型」:用户说「把剪辑2里「粒子背景」卡的粒子数量改成 120」,激活的是剪辑1。
 * 它只能靠读到的 JSON 决定下一步 —— 先 get_project,找 parkedCuts 里标签 / 卡名对得上的片段,再 update_clip。
 * 记下它调过的工具:不许出现 switch_cut。
 */
function mockModel(userText) {
  const calls = [];
  const run = (tool, args) => { calls.push(tool); return call(tool, args); };
  const wantCut = /剪辑\d+/.exec(userText)[0];
  const wantCard = /「(.+?)」/.exec(userText)[1];
  const wantValue = Number(/成\s*(\d+)/.exec(userText)[1]);
  const project = run("get_project");
  let hit = null;
  for (const cut of project.parkedCuts?.cuts ?? []) {
    if (cut.name !== wantCut) continue;
    hit = cut.clips.find((c) => c.label === wantCard || c.cardName === wantCard) ?? null;
  }
  if (!hit) {
    // 没找到才会想到去切 —— 这条路径就是线上观察到的行为,测试要求不要走到
    run("user_interface_switch_cut", { name: wantCut });
    throw new Error("模型在 get_project 里没找到停放剪辑的片段");
  }
  const r = run("update_clip", { clipId: hit.id, params: { count: wantValue } });
  return { calls, result: r, hit };
}

test("模型流程:只读 get_project 就找到并改好剪辑2里的「粒子背景」,全程没有 switch_cut,激活的剪辑不变", () => {
  fresh();
  const before = getState().project;
  const { calls, result, hit } = mockModel("把剪辑2里「粒子背景」卡的粒子数量改成 120，别的不动。");
  assert.deepEqual(calls, ["get_project", "update_clip"]);
  assert.equal(hit.id, "b1");
  assert.equal(result.ok, true);
  assert.equal(result.cut.id, "B");
  const after = getState().project;
  assert.equal(after.activeCutId, "A", "没有切换");
  assert.equal(after.tracks, before.tracks, "激活剪辑的内容原样");
  assert.deepEqual(cutB().tracks[0].clips[0].params, { count: 120, color: "#abcdef" }, "只改数量,别的不动");
  assert.deepEqual(cutB().tracks[0].clips[1].params, { count: 5 });
});
