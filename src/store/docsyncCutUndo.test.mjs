/**
 * 「撤销这步」撤 Agent 在停放剪辑里改过的片段(线上 2026-10-21,项目 验收018-复验2):Agent 做了
 * switch_cut→剪辑2 → update_clip → switch_cut→剪辑1,之后点操作卡上的「撤销这步」毫无反应。
 * 跑:node --experimental-test-module-mocks --test src/store/docsyncCutUndo.test.mjs
 */
import { srcUrl } from "../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { MemDocService } from "../testing/memDocService.mjs";

const { DocSync } = await import(srcUrl("store/docsync.ts"));
const { switchCut } = await import(srcUrl("kernel/cuts.ts"));

function page(svc, session, initial) {
  const notices = [];
  let link = null;
  const ds = new DocSync(initial, { projectId: "P", session, send: (m) => link?.send(m) });
  ds.on("notice", (n) => notices.push(n));
  link = svc.connect(session, (msg) => ds.receive(msg));
  ds.connect();
  return { ds, notices };
}

const base = () => ({
  version: 1, id: "p", name: "p", width: 1920, height: 1080, fps: 30, duration: 10, themeId: "midnight", media: [],
  tracks: [{ id: "ta", name: "序列 1", clips: [{ id: "ca", cardId: "title", start: 0, end: 4, params: { size: 1 } }] }],
  cuts: [
    { id: "cut1", name: "剪辑1" },
    { id: "cut2", name: "剪辑2", duration: 6, transitions: [], tracks: [{ id: "tb", name: "序列 B", clips: [{ id: "cb", cardId: "title", start: 0, end: 6, params: { size: 3, color: "#fff" } }] }] },
  ],
  activeCutId: "cut1",
});
const setSize = (p, id, size) => ({ ...p, tracks: p.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => (c.id === id ? { ...c, params: { ...c.params, size } } : c)) })) });
const sizeIn = (p, cutId, id) => {
  const tracks = p.activeCutId === cutId ? p.tracks : p.cuts.find((c) => c.id === cutId).tracks;
  return tracks.flatMap((t) => t.clips).find((c) => c.id === id)?.params.size;
};
const lastOp = (svc) => svc.log[svc.log.length - 1];

function setup() {
  const svc = new MemDocService({ project: base(), rev: 1 });
  const A = page(svc, "A", base());
  const G = page(svc, "agent-1", base());
  svc.drain();
  return { svc, A, G };
}

/** Agent 的老做法:切过去、改、切回来,三次提交 */
function agentSwitchEditSwitch(svc, G) {
  const ops = [];
  const commit = (p) => { G.ds.commit(p); svc.drain(); ops.push(lastOp(svc).opId); };
  commit(switchCut(G.ds.project, "cut2", 0).project);
  commit(setSize(G.ds.project, "cb", 5));
  commit(switchCut(G.ds.project, "cut1", 0).project);
  return ops;
}

test("复现:switch_cut→改→switch_cut 之后撤销那次改动,应当撤成功、不切换激活剪辑", () => {
  const { svc, A, G } = setup();
  const [, editOp] = agentSwitchEditSwitch(svc, G);
  assert.equal(A.ds.project.activeCutId, "cut1");
  assert.equal(sizeIn(A.ds.project, "cut2", "cb"), 5);
  const r = A.ds.revertRemote({ opId: editOp });
  assert.deepEqual([r.done, r.failed, r.skipped], [true, [], []], JSON.stringify(r));
  svc.drain();
  assert.equal(sizeIn(svc.project, "cut2", "cb"), 3, "撤回到 3");
  assert.equal(svc.project.activeCutId, "cut1", "没有切换激活剪辑");
  assert.equal(sizeIn(svc.project, "cut1", "ca"), 1, "激活剪辑没动");
});

/** 不切换、直接改停放剪辑里的片段(另一条分支的做法:路径在 /cuts/@cut2/tracks 下) */
const setSizeParked = (p, cutId, id, size) => ({
  ...p,
  cuts: p.cuts.map((c) => (c.id !== cutId ? c : { ...c, tracks: c.tracks.map((t) => ({ ...t, clips: t.clips.map((cl) => (cl.id === id ? { ...cl, params: { ...cl.params, size } } : cl)) })) })),
});

test("撤销之后 Ctrl+Z(重做那次改动)也不受剪辑切换影响", () => {
  const { svc, A, G } = setup();
  const [, editOp] = agentSwitchEditSwitch(svc, G);
  assert.equal(A.ds.revertRemote({ opId: editOp }).done, true);
  svc.drain();
  // 页面撤销栈里的这一步是「撤销这步」本身;撤回它 = 把 Agent 的改动恢复
  assert.equal(A.ds.canUndo(), true);
  A.ds.undo();
  svc.drain();
  assert.equal(sizeIn(svc.project, "cut2", "cb"), 5);
  assert.equal(svc.project.activeCutId, "cut1");
});

test("反方向:Agent 在停放剪辑里就地改了(路径在 /cuts/@cut2 下),之后 cut2 被激活,再撤也撤得掉", () => {
  const { svc, A, G } = setup();
  G.ds.commit(setSizeParked(G.ds.project, "cut2", "cb", 5));
  svc.drain();
  const editOp = lastOp(svc).opId;
  // 用户点标签把 cut2 切成激活
  A.ds.commit(switchCut(A.ds.project, "cut2", 0).project);
  svc.drain();
  assert.equal(svc.project.activeCutId, "cut2");
  const r = A.ds.revertRemote({ opId: editOp });
  assert.deepEqual([r.done, r.failed, r.skipped], [true, [], []], JSON.stringify(r));
  svc.drain();
  assert.equal(sizeIn(svc.project, "cut2", "cb"), 3);
  assert.equal(svc.project.activeCutId, "cut2", "没有切换激活剪辑");
});

test("自己的撤销也一样:在 cut2 激活时改了片段,别人把激活剪辑切走之后,Ctrl+Z 仍撤得掉", () => {
  const { svc, A, G } = setup();
  A.ds.commit(switchCut(A.ds.project, "cut2", 0).project);
  svc.drain();
  A.ds.commit(setSize(A.ds.project, "cb", 9));
  svc.drain();
  G.ds.commit(switchCut(G.ds.project, "cut1", 0).project);
  svc.drain();
  assert.equal(svc.project.activeCutId, "cut1");
  assert.equal(A.ds.canUndo(), true);
  A.ds.undo();
  svc.drain();
  assert.equal(sizeIn(svc.project, "cut2", "cb"), 3, "撤回到 3");
  assert.equal(svc.project.activeCutId, "cut1");
});

test("真冲突仍按撤销的规矩处理:之后别人改过同一个片段(不论当时那条剪辑是不是激活的),不撤并告诉改的是谁", () => {
  const { svc, A, G } = setup();
  const [, editOp] = agentSwitchEditSwitch(svc, G);
  // 用户 A 在 cut2 停放时直接改了同一个片段(路径在 /cuts/@cut2 下)
  A.ds.commit(setSizeParked(A.ds.project, "cut2", "cb", 8));
  svc.drain();
  const r = A.ds.revertRemote({ opId: editOp });
  assert.equal(r.done, false);
  assert.deepEqual(r.skipped.map((s) => s.entity), ["/tracks/@tb/clips/@cb"], "实体不分它当时住在哪");
  assert.equal(sizeIn(svc.project, "cut2", "cb"), 8, "保留了现在的样子");
  assert.ok(A.notices.some((n) => n.kind === "revert-remote" && n.result.skipped.length === 1), "有通知(撤销提示条)");
});

test("真冲突:之后别人切到 cut2 把同一个片段改了、又切回去", () => {
  const { svc, A, G } = setup();
  const [, editOp] = agentSwitchEditSwitch(svc, G);
  A.ds.commit(switchCut(A.ds.project, "cut2", 0).project);
  svc.drain();
  A.ds.commit(setSize(A.ds.project, "cb", 8));
  svc.drain();
  A.ds.commit(switchCut(A.ds.project, "cut1", 0).project);
  svc.drain();
  const r = A.ds.revertRemote({ opId: editOp });
  assert.equal(r.done, false);
  assert.deepEqual(r.skipped.map((s) => s.entity), ["/tracks/@tb/clips/@cb"]);
  assert.equal(sizeIn(svc.project, "cut2", "cb"), 8);
});

test("别的片段后来被改过,不挡这一步的撤销", () => {
  const { svc, A, G } = setup();
  const [, editOp] = agentSwitchEditSwitch(svc, G);
  A.ds.commit(setSize(A.ds.project, "ca", 2)); // 激活剪辑 cut1 里另一个片段
  svc.drain();
  const r = A.ds.revertRemote({ opId: editOp });
  assert.deepEqual([r.done, r.skipped, r.failed], [true, [], []]);
  svc.drain();
  assert.equal(sizeIn(svc.project, "cut2", "cb"), 3);
  assert.equal(sizeIn(svc.project, "cut1", "ca"), 2, "别处的改动保留");
});

test("序列真的被删了:撤不成,走 failed(提示条里说没法退回),不是静默", () => {
  const { svc, A, G } = setup();
  const [, editOp] = agentSwitchEditSwitch(svc, G);
  const gone = { ...A.ds.project, cuts: A.ds.project.cuts.map((c) => (c.id === "cut2" ? { ...c, tracks: [] } : c)) };
  A.ds.commit(gone);
  svc.drain();
  const r = A.ds.revertRemote({ opId: editOp });
  assert.equal(r.done, false);
  assert.ok(r.failed.length + r.skipped.length > 0, JSON.stringify(r));
});
