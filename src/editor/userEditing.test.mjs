/**
 * 「用户正在编辑」的接线(src/editor/userEditing.ts,计划 docs/plan/agent-workflow-plan.md A2)。用例 UE-W1～UE-W2。
 * 旁听 store:选中的片段被本页面改了算「刚动过」;没选中的、Agent 让页面执行的工具期间的修改不算;推送走 /api/agent/editing。
 * 跑:node --test src/editor/userEditing.test.mjs
 */
import { srcUrl } from "../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const posts = [];
globalThis.fetch = async (url, init) => {
  posts.push({ url, body: JSON.parse(init.body) });
  return { ok: true, json: async () => ({ ok: true }) };
};

const { actions, getState } = await import(srcUrl("store/project.ts"));
const { createEmptyProject } = await import(srcUrl("kernel/project.ts"));
const ue = await import(srcUrl("editor/userEditing.ts"));
/** 一个两段片段的项目(不依赖卡片注册表) */
function load(name) {
  const p = createEmptyProject(name);
  p.tracks = [{ id: "t1", name: "画面", clips: [
    { id: "a", cardId: "title", params: {}, start: 0, end: 2 },
    { id: "b", cardId: "title", params: {}, start: 5, end: 7 },
  ] }];
  actions.loadProject(p);
  return { a: { id: "a" }, b: { id: "b" } };
}
const kinds = () => ue.userEditingSnapshot().map((e) => `${e.clipId}:${e.kind}`);

test("UE-W1 选中的片段被本页面改了算「刚动过」;只选中、改没选中的都不算;推送到 /api/agent/editing", async () => {
  const { a, b } = load("ue");
  const stop = ue.startUserEditing();
  try {
    actions.select([a.id]);
    assert.deepEqual(kinds(), [], "只选中不算");
    actions.updateClip(b.id, { opacity: 0.5 });
    assert.deepEqual(kinds(), [], "改没选中的不算");
    actions.updateClip(a.id, { opacity: 0.4 });
    assert.deepEqual(kinds(), [`${a.id}:recent`]);
    await new Promise((r) => setTimeout(r, 300));
    const last = posts.at(-1);
    assert.equal(last.url, "/api/agent/editing");
    assert.match(last.body.session, /^ue-/);
    assert.deepEqual(last.body.entities.map((e) => [e.clipId, e.kind]), [[a.id, "recent"]]);
    assert.ok(last.body.entities[0].remainingMs > 29_000 && last.body.entities[0].remainingMs <= 30_000);
    actions.select([]);
    assert.deepEqual(kinds(), [], "取消选中就撤");
  } finally {
    stop();
  }
});

test("UE-W2 Agent 让页面执行的工具期间的修改不算用户动过", () => {
  const { a } = load("ue2");
  const stop = ue.startUserEditing();
  try {
    actions.select([a.id]);
    ue.beginAgentTool();
    actions.updateClip(a.id, { opacity: 0.3 });
    ue.endAgentTool();
    assert.deepEqual(kinds(), []);
    assert.equal(getState().project.tracks.flatMap((t) => t.clips).find((c) => c.id === a.id).opacity, 0.3);
  } finally {
    stop();
  }
});
