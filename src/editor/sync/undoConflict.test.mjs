/**
 * 按撤销按钮遇到冲突 → 「冲突合并」窗口(0.7.20 接上 0.7.19 留的口子)。跑:node --test src/editor/sync/undoConflict.test.mjs
 *
 * UC-01 撤销按修改项细分:同一片段里没被别人改过的属性直接撤(不进撤销栈),别人改过的进待合并表(来源 undo),
 *       窗口里写「落地后 → 撤回后(云端现在是 …)」;点「合并」照撤回后的值写回去(安全论证 2、4)
 * UC-02 没有冲突:照旧直接撤,不给窗口材料
 * UC-03 AI 栏「撤销这一步」(撤 Agent 那一步)遇到冲突同样给材料、同样细分
 * UC-04 改密退出触发的撤回到达页面:只是一次远端修改,不产生撤销提示、不进窗口(两条路不混,安全论证 4);
 *       气泡的字是「〈用户名〉撤回了内容」(安全论证 5)
 */
import { srcUrl } from "../../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { MemDocService } from "../../testing/memDocService.mjs";

const { DocSync } = await import(srcUrl("store/docsync.ts"));
const { undoConflictPlan } = await import(srcUrl("editor/sync/undoConflict.ts"));
const { mergeRows, applyMerge } = await import(srcUrl("editor/sync/mergeItems.ts"));
const { rolledBackText } = await import(srcUrl("editor/sync/labels.ts"));

function project() {
  return {
    version: 1, id: "p", name: "p", width: 1920, height: 1080, fps: 30, duration: 30, themeId: "midnight", media: [],
    tracks: [{ id: "t1", name: "序列 1", clips: [
      { id: "c1", cardId: "title", start: 0, end: 2, opacity: 0.4, label: "一", params: { text: "一" } },
      { id: "c2", cardId: "title", start: 3, end: 5, opacity: 1, label: "二", params: { text: "二" } },
    ] }],
  };
}
function page(svc, session) {
  const notices = [];
  let link = null;
  const ds = new DocSync(project(), { projectId: "P", session, send: (msg) => link?.send(msg), saveBackup: () => {} });
  ds.on("notice", (n) => notices.push(n));
  link = svc.connect(session, (msg) => ds.receive(msg));
  ds.connect();
  return { ds, notices };
}
const edit = (p, id, patch) => ({ ...p, tracks: p.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => (c.id === id ? { ...c, ...patch } : c)) })) });
const clip = (p, id) => p.tracks[0].clips.find((c) => c.id === id);
const meta = { batch: "u1", baseRev: 0, at: 1 };

test("UC-01 撤销按修改项细分:没被别人改过的直接撤,被改过的进窗口;合并照撤回后的值写", () => {
  const svc = new MemDocService({ project: project(), rev: 1 });
  const A = page(svc, "A"), B = page(svc, "B");
  svc.drain();
  A.ds.commit(edit(A.ds.project, "c1", { opacity: 0.8, end: 3 }));
  svc.drain();
  B.ds.commit(edit(B.ds.project, "c1", { opacity: 0.6 }));
  svc.drain();
  const res = A.ds.undo();
  assert.equal(res.done, false, "DocSync 按实体挡:c1 整样没撤");
  assert.ok(res.conflict, "给了窗口要的材料");
  const plan = undoConflictPlan(A.ds.project, res.conflict, meta);
  assert.equal(plan.directCount, 1);
  assert.equal(clip(plan.direct, "c1").end, 2, "长度没人再改:直接撤");
  assert.equal(clip(plan.direct, "c1").opacity, 0.6, "透明度别人改过:不动,进窗口");
  assert.deepEqual(plan.things.map((t) => [t.key, t.source, t.props.map((p) => p.prop)]), [["undo:clip:c1", "undo", ["opacity"]]]);
  A.ds.commitAside(plan.direct);
  svc.drain();
  assert.equal(clip(B.ds.project, "c1").end, 2);
  assert.equal(A.ds.canUndo(), false, "直接撤的那一部分是这次撤销的一部分,不另进撤销栈");
  const rows = mergeRows(A.ds.project, plan.things);
  assert.equal(rows[0].props[0].text, "透明度 0.8 → 0.4（云端现在是 0.6）");
  assert.equal(rows[0].conflict, true);
  // 用户在窗口里勾上、点「合并」:照撤回后的值写
  const merged = applyMerge(A.ds.project, plan.things, new Map([["undo:clip:c1", new Set(["opacity"])]]));
  assert.equal(clip(merged.project, "c1").opacity, 0.4);
});

test("UC-02 没有冲突:直接撤,不给窗口材料", () => {
  const svc = new MemDocService({ project: project(), rev: 1 });
  const A = page(svc, "A"), B = page(svc, "B");
  svc.drain();
  A.ds.commit(edit(A.ds.project, "c1", { opacity: 0.8 }));
  svc.drain();
  B.ds.commit(edit(B.ds.project, "c2", { opacity: 0.2 }));
  svc.drain();
  const res = A.ds.undo();
  assert.equal(res.done, true); assert.deepEqual(res.skipped, []); assert.equal(res.conflict, undefined);
  svc.drain();
  assert.equal(clip(B.ds.project, "c1").opacity, 0.4);
});

test("UC-03 AI 栏「撤销这一步」遇到冲突:同样给材料、同样细分", () => {
  const svc = new MemDocService({ project: project(), rev: 1 });
  const A = page(svc, "A"), Agent = page(svc, "agent");
  svc.drain();
  Agent.ds.commit(edit(Agent.ds.project, "c2", { label: "Agent 改的", opacity: 0.5 }));
  svc.drain();
  const opId = svc.log[svc.log.length - 1].opId;
  A.ds.commit(edit(A.ds.project, "c2", { opacity: 0.9 }));
  svc.drain();
  const res = A.ds.revertRemote({ opId });
  assert.ok(res.conflict);
  const plan = undoConflictPlan(A.ds.project, res.conflict, meta);
  assert.equal(clip(plan.direct, "c2").label, "二", "名称没人再改:直接撤");
  assert.deepEqual(plan.things.map((t) => t.props.map((p) => p.prop)), [["opacity"]], "透明度我这个页面后来改过:进窗口");
});

test("UC-04 改密退出触发的撤回到达页面:只是一次远端修改,不产生撤销提示、不给窗口材料;气泡的字", () => {
  const svc = new MemDocService({ project: project(), rev: 1 });
  const A = page(svc, "A");
  svc.drain();
  const before = A.notices.length;
  A.ds.receive({ type: "project.ops", projectId: "P", rev: A.ds.rev + 1, opId: "logout-rollback:pw_1:1",
    ops: [{ op: "set", path: "/tracks/@t1/clips/@c1/opacity", value: 0.1 }],
    actor: { userId: "acc_x", role: "system", accountId: "acc_x", rollbackEventId: "pw_1", session: null }, at: 1 });
  assert.equal(clip(A.ds.project, "c1").opacity, 0.1);
  const kinds = A.notices.slice(before).map((n) => n.kind);
  assert.deepEqual(kinds, ["remote"]);
  assert.equal(rolledBackText("小王"), "小王撤回了内容");
  assert.equal(rolledBackText(null), "有成员撤回了内容");
});
