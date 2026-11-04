/**
 * Tests for additions to docsync by c65-editor. Run: node --test src/store/docsyncEditor.test.mjs
 *
 *   - AI panel "Undo this step" (`revertRemote`): commits inverse operation of Agent's commit as
 *     page identity, with undoOf, enters page's own undo stack; entities modified after this step
 *     by any write **different from that Agent chat** (including page's own later changes) are not
 *     undone (lead session ruling, 2026-09-26);
 *   - Others' modifications emit `remote` notifications (used for timeline stroke);
 *   - Root replacements exceeding 256 KiB go through `project.upload` (real document service,
 *     `server/docservice/modules/project.mjs`); converted to a root replacement when diff itself
 *     exceeds 256 KiB.
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
    tracks: [{ id: "t1", name: "Track 1", clips: [
      { id: "c1", cardId: "title", start: 0, end: 2, params: { text: "One" } },
      { id: "c2", cardId: "title", start: 3, end: 5, params: { text: "Two" } },
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

test("undo this step: undo the whole step, carry undoOf, enter the page's own undo stack, and Ctrl+Z can restore the Agent's edit", () => {
  const { svc, A, B, G } = setup();
  G.ds.commit(withText(withText(G.ds.project, "c1", "G1"), "c2", "G2"));
  svc.drain();
  const agentOp = lastOp(svc).opId;
  assert.equal(A.ds.canRevertRemote(agentOp), true, "the page recorded the inverse op on receipt");
  assert.equal(A.ds.canUndo(), false);
  const r = A.ds.revertRemote({ opId: agentOp });
  assert.equal(r.done, true);
  assert.deepEqual(r.skipped, []);
  svc.drain();
  assert.equal(textOf(svc.project, "c1"), "One");
  assert.equal(textOf(svc.project, "c2"), "Two");
  assert.equal(lastOp(svc).session, "A", "committed as the page");
  assert.equal(lastOp(svc).undoOf, agentOp, "undoOf points to that Agent commit");
  assert.equal(textOf(B.ds.project, "c1"), "One", "others receive it as usual");
  assert.equal(A.ds.canUndo(), true, "entered the page's own undo stack");
  A.ds.undo();
  svc.drain();
  assert.equal(textOf(svc.project, "c1"), "G1");
  assert.equal(textOf(svc.project, "c2"), "G2");
  assert.ok(A.notices.some((n) => n.kind === "revert-remote" && n.of === agentOp));
});

test("undo this step: entities edited later by others are not undone and who did it is reported; later edits by the Agent itself are not conflicts", () => {
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
  assert.equal(textOf(svc.project, "c1"), "One", "c1, edited later by the Agent itself, is still undone (back to before that step)");
  assert.equal(textOf(svc.project, "c2"), "B2", "B's later edits are kept");
});

test("undo this step: later edits by the page itself also block it (including unconfirmed ones); when everything is blocked, no commit is produced", () => {
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
  assert.equal(svc.rev, revBefore, "nothing was undone, so no commit is produced");
  assert.equal(textOf(svc.project, "c1"), "A1");
  // Unconfirmed local modifications
  G.ds.commit(withText(G.ds.project, "c2", "G2"));
  svc.drain();
  const op2 = lastOp(svc).opId;
  A.ds.commit(withText(A.ds.project, "c2", "A2-unconfirmed"));
  const r2 = A.ds.revertRemote({ opId: op2 });
  assert.equal(r2.done, false);
  assert.equal(r2.skipped[0].entity, "/tracks/@t1/clips/@c2");
});

test("undo this step: the inverse carried by the event takes priority; when no inverse op can be found, it cannot be undone", () => {
  const { svc, A, G } = setup();
  G.ds.commit(withText(G.ds.project, "c1", "G1"));
  svc.drain();
  const agentOp = lastOp(svc).opId;
  assert.equal(A.ds.canRevertRemote("nope"), false);
  // Inverse operation provided by event (here deliberately provide one that only changes c1 to
  // "event" to verify it is used)
  const r = A.ds.revertRemote({ opId: agentOp, inverse: [{ op: "set", path: "/tracks/@t1/clips/@c1/params/text", value: "Event" }] });
  assert.equal(r.done, true);
  svc.drain();
  assert.equal(textOf(svc.project, "c1"), "Event");
});

test("others' edits emit a remote notice carrying the entity and the writer identity; one's own do not", () => {
  const { svc, A, B } = setup();
  B.ds.commit(withText(B.ds.project, "c2", "B2"));
  A.ds.commit(withText(A.ds.project, "c1", "A1"));
  svc.drain();
  const remote = A.notices.filter((n) => n.kind === "remote");
  assert.equal(remote.length, 1);
  assert.deepEqual(remote[0].entities, ["/tracks/@t1/clips/@c2"]);
  assert.equal(remote[0].by.session, "B");
});

/* ---------------- Real document service: large root replacements use chunked upload ---------------- */

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

/**
 * Current version of the document service: read by opening another page (for large projects,
 * project.state is sent back in chunks, DocSync reassembles them itself).
 */
async function serverCopy(env) {
  const R = await realPage(env, 'reader-' + Math.random().toString(36).slice(2, 6), {}, 'reader');
  await kit.waitFor(() => R.ds.status === 'online', 10_000, 'reader online');
  const out = { rev: R.ds.rev, project: R.ds.project };
  R.ws.close();
  return out;
}

function bigProject(n = 900) {
  const p = clipsProject();
  p.tracks[0].clips = Array.from({ length: n }, (_, i) => ({ id: `c${i}`, cardId: "title", start: i * 2, end: i * 2 + 1, params: { text: `clip ${i} ${"x".repeat(360)}` } }));
  return p;
}

test("root replacement over 256 KiB: chunked project.upload + project.op referencing it; the document service applies it, and another page gets the same copy via resync", async (t) => {
  const env = await kit.startProjectService();
  t.after(() => env.cleanup());
  const A = await realPage(env, "A", clipsProject());
  await kit.waitFor(() => A.ds.status === "online", 5000, "A online");
  const B = await realPage(env, "B", clipsProject(), "u2");
  await kit.waitFor(() => B.ds.status === "online" && B.ds.rev === A.ds.rev, 5000, "B online");
  const big = bigProject();
  assert.ok(new TextEncoder().encode(JSON.stringify(big)).length > MAX_OPS_BYTES, "the test project really exceeds 256 KiB");
  A.ds.load(big);
  const settled = await A.ds.whenSettled({ timeoutMs: 10_000 });
  const uploads = A.sent.filter((m) => m.type === "project.upload");
  assert.ok(uploads.length >= 2, `chunked: ${uploads.length}`);
  const op = A.sent.filter((m) => m.type === "project.op").at(-1);
  assert.deepEqual(op.ops, [{ op: "set", path: "", upload: uploads[0].uploadId }]);
  const server = await serverCopy(env);
  assert.equal(server.rev, settled.rev);
  assert.equal(JSON.stringify(server.project), JSON.stringify(big));
  await kit.waitFor(() => B.ds.rev === settled.rev && B.ds.status === "online", 10_000, "B gets the new version via resync");
  assert.equal(JSON.stringify(B.ds.project), JSON.stringify(big));
  A.ws.close();
  B.ws.close();
});

test("the diff itself exceeds 256 KiB: changed to a single root replacement via upload, the document service still applies it, and the inverse op can still be undone by diff", async (t) => {
  const env = await kit.startProjectService();
  t.after(() => env.cleanup());
  const A = await realPage(env, "A", clipsProject());
  await kit.waitFor(() => A.ds.status === "online", 5000, "A online");
  await A.ds.whenSettled({ timeoutMs: 5000 });
  const next = { ...A.ds.project, tracks: [{ ...A.ds.project.tracks[0], clips: [...A.ds.project.tracks[0].clips, ...bigProject().tracks[0].clips.map((c) => ({ ...c, id: `n${c.id}`, start: c.start + 10, end: c.end + 10 }))] }] };
  A.ds.commit(next);
  await A.ds.whenSettled({ timeoutMs: 10_000 });
  assert.ok(A.sent.some((m) => m.type === "project.upload"), "went through upload");
  assert.equal(JSON.stringify((await serverCopy(env)).project), JSON.stringify(A.ds.project));
  A.ds.undo();
  await A.ds.whenSettled({ timeoutMs: 10_000 });
  assert.equal((await serverCopy(env)).project.tracks[0].clips.length, 2, "undo back to two clips");
  A.ws.close();
});
