/**
 * c65-editor 给 docsync 加的几件事的测试。跑:node --test src/store/docsyncEditor.test.mjs
 *
 *   - AI 栏「撤销这一步」(`revertRemote`):以页面身份提交 Agent 那次提交的逆操作,带 undoOf、进页面自己的撤销栈;
 *     这一步之后被**不同于那个 Agent 对话**的任何写入(含页面自己后来的改动)改过的实体不撤(2026-09-26 主会话裁定);
 *   - 别人的改动发 `remote` 通知(时间轴描边用);
 *   - 超过 256 KiB 的根替换走 `project.upload`(真文档服务,`server/docservice/modules/project.mjs`);
 *     差异本身超过 256 KiB 时改成一条根替换。
 */
import { srcUrl } from "../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { MemDocService } from "../testing/memDocService.mjs";

const { DocSync, MAX_OPS_BYTES } = await import(srcUrl("store/docsync.ts"));

function page(svc, session, initial) {
  const notices = [];
  let link = null;
  const sent = [];
  const ds = new DocSync(initial, { projectId: "P", session, send: (m) => { sent.push(m); link?.send(m); } });
  ds.on("notice", (n) => notices.push(n));
  link = svc.connect(session, (msg) => ds.receive(msg));
  ds.connect();
  return { ds, notices, sent };
}

function clipsProject() {
  return {
    version: 1, id: "p", name: "p", width: 1920, height: 1080, fps: 30, duration: 30, themeId: "midnight", media: [],
    tracks: [{ id: "t1", name: "序列 1", clips: [
      { id: "c1", cardId: "title", start: 0, end: 2, params: { text: "一" } },
      { id: "c2", cardId: "title", start: 3, end: 5, params: { text: "二" } },
    ] }],
  };
}
const withText = (p, id, text) => ({ ...p, tracks: p.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => (c.id === id ? { ...c, params: { ...c.params, text } } : c)) })) });
const textOf = (p, id) => p.tracks[0].clips.find((c) => c.id === id)?.params.text;

function setup() {
  const svc = new MemDocService({ project: clipsProject(), rev: 1 });
  const A = page(svc, "A", clipsProject());
  const B = page(svc, "B", clipsProject());
  const G = page(svc, "agent-1", clipsProject());
  svc.drain();
  return { svc, A, B, G };
}

const lastOp = (svc) => svc.log[svc.log.length - 1];

test("撤这一步:整步照撤,带 undoOf、进页面自己的撤销栈,Ctrl+Z 能把 Agent 的改动恢复回来", () => {
  const { svc, A, B, G } = setup();
  G.ds.commit(withText(withText(G.ds.project, "c1", "G1"), "c2", "G2"));
  svc.drain();
  const agentOp = lastOp(svc).opId;
  assert.equal(A.ds.canRevertRemote(agentOp), true, "页面收到时记下了逆操作");
  assert.equal(A.ds.canUndo(), false);
  const r = A.ds.revertRemote({ opId: agentOp });
  assert.equal(r.done, true);
  assert.deepEqual(r.skipped, []);
  svc.drain();
  assert.equal(textOf(svc.project, "c1"), "一");
  assert.equal(textOf(svc.project, "c2"), "二");
  assert.equal(lastOp(svc).session, "A", "以页面身份提交");
  assert.equal(lastOp(svc).undoOf, agentOp, "undoOf 指向 Agent 那次提交");
  assert.equal(textOf(B.ds.project, "c1"), "一", "别人照常收到");
  assert.equal(A.ds.canUndo(), true, "进了页面自己的撤销栈");
  A.ds.undo();
  svc.drain();
  assert.equal(textOf(svc.project, "c1"), "G1");
  assert.equal(textOf(svc.project, "c2"), "G2");
  assert.ok(A.notices.some((n) => n.kind === "revert-remote" && n.of === agentOp));
});

test("撤这一步:之后被别人改过的实体不撤,告诉是谁;Agent 自己后来又改的不算冲突", () => {
  const { svc, A, B, G } = setup();
  G.ds.commit(withText(withText(G.ds.project, "c1", "G1"), "c2", "G2"));
  svc.drain();
  const agentOp = lastOp(svc).opId;
  B.ds.commit(withText(B.ds.project, "c2", "B2"));
  svc.drain();
  G.ds.commit(withText(G.ds.project, "c1", "G1b"));
  svc.drain();
  const r = A.ds.revertRemote({ opId: agentOp });
  assert.equal(r.done, true);
  assert.deepEqual(r.skipped.map((s) => [s.entity, s.by.session]), [["/tracks/@t1/clips/@c2", "B"]]);
  svc.drain();
  assert.equal(textOf(svc.project, "c1"), "一", "Agent 自己后来改的 c1 照撤(撤到那一步之前)");
  assert.equal(textOf(svc.project, "c2"), "B2", "B 后来改的保留");
});

test("撤这一步:页面自己后来改过的也挡(含还没确认的);全部挡住时不产生提交", () => {
  const { svc, A, G } = setup();
  G.ds.commit(withText(G.ds.project, "c1", "G1"));
  svc.drain();
  const agentOp = lastOp(svc).opId;
  A.ds.commit(withText(A.ds.project, "c1", "A1"));
  svc.drain();
  const revBefore = svc.rev;
  const r = A.ds.revertRemote({ opId: agentOp });
  assert.equal(r.done, false);
  assert.deepEqual(r.skipped.map((s) => [s.entity, s.by.session]), [["/tracks/@t1/clips/@c1", "A"]]);
  svc.drain();
  assert.equal(svc.rev, revBefore, "一处都没撤成不产生提交");
  assert.equal(textOf(svc.project, "c1"), "A1");
  // 还没确认的本地修改
  G.ds.commit(withText(G.ds.project, "c2", "G2"));
  svc.drain();
  const op2 = lastOp(svc).opId;
  A.ds.commit(withText(A.ds.project, "c2", "A2-未确认"));
  const r2 = A.ds.revertRemote({ opId: op2 });
  assert.equal(r2.done, false);
  assert.equal(r2.skipped[0].entity, "/tracks/@t1/clips/@c2");
});

test("撤这一步:事件带来的 inverse 优先;查不到逆操作时撤不了", () => {
  const { svc, A, G } = setup();
  G.ds.commit(withText(G.ds.project, "c1", "G1"));
  svc.drain();
  const agentOp = lastOp(svc).opId;
  assert.equal(A.ds.canRevertRemote("nope"), false);
  // 事件给的逆操作(这里故意给一个只改 c1 为「事件」的,验证用的是它)
  const r = A.ds.revertRemote({ opId: agentOp, inverse: [{ op: "set", path: "/tracks/@t1/clips/@c1/params/text", value: "事件" }] });
  assert.equal(r.done, true);
  svc.drain();
  assert.equal(textOf(svc.project, "c1"), "事件");
});

test("别人的改动发 remote 通知,带实体与写入身份;自己的不发", () => {
  const { svc, A, B } = setup();
  B.ds.commit(withText(B.ds.project, "c2", "B2"));
  A.ds.commit(withText(A.ds.project, "c1", "A1"));
  svc.drain();
  const remote = A.notices.filter((n) => n.kind === "remote");
  assert.equal(remote.length, 1);
  assert.deepEqual(remote[0].entities, ["/tracks/@t1/clips/@c2"]);
  assert.equal(remote[0].by.session, "B");
});

/* ---------------- 真文档服务:大的根替换走分片上传 ---------------- */

const kit = await import("../../server/test/c65-kit.mjs");

async function realPage(env, session, initial, user = "u1") {
  const ws = new WebSocket(env.url({ user, dev: `dev-${session}` }));
  const sent = [];
  const ds = new DocSync(initial, { projectId: "BIG", session, send: (m) => { sent.push(m); ws.send(JSON.stringify(m)); } });
  ws.addEventListener("message", (e) => ds.receive(JSON.parse(e.data)));
  await new Promise((res) => ws.addEventListener("open", res));
  ds.connect();
  return { ds, ws, sent };
}

/** 文档服务的当前版本:另开一个页面读(大项目的 project.state 分片发回,DocSync 自己拼) */
async function serverCopy(env) {
  const R = await realPage(env, 'reader-' + Math.random().toString(36).slice(2, 6), {}, 'reader');
  await kit.waitFor(() => R.ds.status === 'online', 10_000, '读者上线');
  const out = { rev: R.ds.rev, project: R.ds.project };
  R.ws.close();
  return out;
}

function bigProject(n = 900) {
  const p = clipsProject();
  p.tracks[0].clips = Array.from({ length: n }, (_, i) => ({ id: `c${i}`, cardId: "title", start: i * 2, end: i * 2 + 1, params: { text: `片段 ${i} ${"字".repeat(120)}` } }));
  return p;
}

test("超过 256 KiB 的根替换:分片 project.upload + 引用它的 project.op;文档服务落地,另一页面经 resync 拿到同一份", async (t) => {
  const env = await kit.startProjectService();
  t.after(() => env.cleanup());
  const A = await realPage(env, "A", clipsProject());
  await kit.waitFor(() => A.ds.status === "online", 5000, "A 上线");
  const B = await realPage(env, "B", clipsProject(), "u2");
  await kit.waitFor(() => B.ds.status === "online" && B.ds.rev === A.ds.rev, 5000, "B 上线");
  const big = bigProject();
  assert.ok(new TextEncoder().encode(JSON.stringify(big)).length > MAX_OPS_BYTES, "测试项目确实超过 256 KiB");
  A.ds.load(big);
  const settled = await A.ds.whenSettled({ timeoutMs: 10_000 });
  const uploads = A.sent.filter((m) => m.type === "project.upload");
  assert.ok(uploads.length >= 2, `分了片:${uploads.length}`);
  const op = A.sent.filter((m) => m.type === "project.op").at(-1);
  assert.deepEqual(op.ops, [{ op: "set", path: "", upload: uploads[0].uploadId }]);
  const server = await serverCopy(env);
  assert.equal(server.rev, settled.rev);
  assert.equal(JSON.stringify(server.project), JSON.stringify(big));
  await kit.waitFor(() => B.ds.rev === settled.rev && B.ds.status === "online", 10_000, "B 经 resync 拿到新版本");
  assert.equal(JSON.stringify(B.ds.project), JSON.stringify(big));
  A.ws.close();
  B.ws.close();
});

test("差异本身超过 256 KiB:改成一条根替换走上传,文档服务照样落地,逆操作仍按差异撤得回来", async (t) => {
  const env = await kit.startProjectService();
  t.after(() => env.cleanup());
  const A = await realPage(env, "A", clipsProject());
  await kit.waitFor(() => A.ds.status === "online", 5000, "A 上线");
  await A.ds.whenSettled({ timeoutMs: 5000 });
  const next = { ...A.ds.project, tracks: [{ ...A.ds.project.tracks[0], clips: [...A.ds.project.tracks[0].clips, ...bigProject().tracks[0].clips.map((c) => ({ ...c, id: `n${c.id}`, start: c.start + 10, end: c.end + 10 }))] }] };
  A.ds.commit(next);
  await A.ds.whenSettled({ timeoutMs: 10_000 });
  assert.ok(A.sent.some((m) => m.type === "project.upload"), "走了上传");
  assert.equal(JSON.stringify((await serverCopy(env)).project), JSON.stringify(A.ds.project));
  A.ds.undo();
  await A.ds.whenSettled({ timeoutMs: 10_000 });
  assert.equal((await serverCopy(env)).project.tracks[0].clips.length, 2, "撤回到两个片段");
  A.ws.close();
});
