/**
 * Tests for docsync (sync layer from page to document service). Run:
 * node --test src/store/docsync.test.mjs
 *
 * Using in-memory document service mock from src/testing/memDocService.mjs, messages delivered
 * randomly interleaved. Pins c65-design.md:
 *   V2: 200 random edits interleaved and committed from each of two pages; all three copies (both
 *     sides and document service) byte-for-byte identical;
 *   V5: Undo does not overwrite others (entities modified by other write identities after this step
 *     are not undone);
 *   V6: Offline queue (landed in order; entire batch stops if first item rejected, "Replay",
 *     "Discard");
 *   V7: .proc written only after all local operations are confirmed (whenSettled);
 *   V8: Project with 1000 clips, diff computation on commit side ≤ 5 ms.
 */
import { srcUrl } from "../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { MemDocService } from "../testing/memDocService.mjs";
import { rng, randProject, mutateOnce, realisticEdit, bigProject } from "../testing/randomProject.mjs";

const { DocSync } = await import(srcUrl("store/docsync.ts"));

const json = (v) => JSON.stringify(v);

/** One page: DocSync + connection attached to the mock */
function page(svc, session, initial, extra = {}) {
  const sent = [];
  const backups = [];
  const notices = [];
  let link = null;
  const ds = new DocSync(initial, {
    projectId: "P",
    session,
    send: (msg) => {
      sent.push(msg);
      link?.send(msg);
    },
    saveBackup: (b) => backups.push(b),
    ...extra,
  });
  ds.on("notice", (n) => notices.push(n));
  const up = () => {
    link = svc.connect(session, (msg) => ds.receive(msg));
    ds.connect();
  };
  const down = (opts) => {
    if (link) svc.disconnect(link.conn, opts);
    link = null;
    ds.disconnect();
  };
  up();
  return { ds, sent, backups, notices, up, down, get conn() { return link?.conn; } };
}

/**
 * Make a random local modification and pass to docsync. chaos: deep copy the whole thing then
 * arbitrarily mutate anywhere (change type, delete key, duplicate id…)
 */
function randomEdit(r, ds, chaos) {
  if (!chaos) return ds.commit(realisticEdit(r, ds.project));
  const next = structuredClone(ds.project);
  mutateOnce(r, next);
  ds.commit(next);
}

function twoPages(seed, projectOpts) {
  const r = rng(seed);
  const p0 = randProject(r, projectOpts);
  const svc = new MemDocService({ project: structuredClone(p0), rev: 7 });
  const A = page(svc, "A", structuredClone(p0));
  const B = page(svc, "B", structuredClone(p0));
  svc.drain();
  return { r, svc, A, B };
}

function assertSame(svc, ...pages) {
  const s = json(svc.project);
  for (const p of pages) {
    assert.equal(json(p.ds.project), s, `${p.ds.session} does not match the document service`);
    assert.equal(p.ds.rev, svc.rev, `Revision of ${p.ds.session} ${p.ds.rev} ≠ ${svc.rev}`);
    assert.equal(p.ds.unconfirmed, 0);
  }
}

/* ---------------- V2 ---------------- */

for (const [seed, chaos] of [[1, false], [2, false], [3, false], [4, false], [5, false], [6, true], [7, true], [8, true]]) {
  test(`V2-two pages each make 200 random ${chaos ? "chaotic edits" : "Edit"} interleaved commits, all three copies byte-identical (seed ${seed})`, () => {
    const { r, svc, A, B } = twoPages(seed);
    const left = { A: 200, B: 200 };
    let undos = 0;
    while (left.A || left.B) {
      const roll = r.int(10);
      if (roll < 4) {
        svc.step(r);
      } else {
        const who = left.A && (!left.B || r.chance(0.5)) ? "A" : "B";
        const p = who === "A" ? A : B;
        left[who]--;
        // Occasionally undo / redo; undo is also a regular write
        if (roll === 9 && p.ds.canUndo()) { p.ds.undo(); undos++; }
        else if (roll === 8 && p.ds.canRedo()) p.ds.redo();
        else randomEdit(r, p.ds, chaos);
      }
    }
    svc.drain(r);
    assertSame(svc, A, B);
    // Reconciled: every sent commit either landed or was rejected with page notified, none silently
    // dropped; no duplicates among landed
    for (const p of [A, B]) {
      const sentIds = new Set(p.sent.filter((m) => m.type === "project.op").map((m) => m.opId));
      const landed = svc.log.filter((e) => e.session === p.ds.session).map((e) => e.opId);
      const rejectedIds = p.notices.filter((n) => n.kind === "rejected").map((n) => n.opId);
      assert.equal(new Set(landed).size, landed.length);
      assert.equal(sentIds.size, landed.length + rejectedIds.length, `${p.ds.session}: sent ${sentIds.size}, landed ${landed.length}, rejected ${rejectedIds.length}`);
    }
    const bySession = { A: 0, B: 0 };
    for (const e of svc.log) bySession[e.session]++;
    const rejected = [...A.notices, ...B.notices].filter((n) => n.kind === "rejected" || n.kind === "replay-dropped").length;
    console.log(`V2 seed ${seed}${chaos ? " (chaotic edits)" : ""}: landed A ${bySession.A}, B ${bySession.B}, rejected or dropped on replay ${rejected}, undone ${undos}, final rev ${svc.rev}`);
    assert.ok(bySession.A >= 60 && bySession.B >= 60, JSON.stringify(bySession));
    assert.ok(undos > 0);
  });
}

test("V2-operations received from others do not enter your own undo stack and are not sent back", () => {
  const { svc, A, B } = twoPages(11);
  const next = structuredClone(A.ds.project);
  next.name = "Edited by A";
  A.ds.commit(next);
  svc.drain();
  assert.equal(B.ds.project.name, "Edited by A");
  assert.equal(B.ds.canUndo(), false);
  assert.equal(B.sent.filter((m) => m.type === "project.op").length, 0);
  assertSame(svc, A, B);
});

test("V2-remote operation received while local operations are unconfirmed: roll back, apply remote, replay; local user sees their own change first", () => {
  const { svc, A, B } = twoPages(12);
  const a = structuredClone(A.ds.project);
  a.width = 111;
  A.ds.commit(a);
  const b = structuredClone(B.ds.project);
  b.height = 222;
  B.ds.commit(b);
  // B's lands first; while A's is still in flight, receives B's first
  svc.handle(B.conn, B.conn.up.shift());
  svc.handle(A.conn, A.conn.up.shift());
  A.conn.onMessage(A.conn.down.shift()); // project.ops (B's)
  assert.equal(A.ds.project.width, 111);
  assert.equal(A.ds.project.height, 222);
  svc.drain();
  assertSame(svc, A, B);
});

/* ---------------- V5 ---------------- */

function clipsProject() {
  return {
    version: 1, id: "p", name: "p", width: 1920, height: 1080, fps: 30, duration: 30, themeId: "midnight", media: [],
    tracks: [{ id: "t1", name: "Track 1", clips: [
      { id: "c1", cardId: "title", start: 0, end: 2, params: { text: "One" } },
      { id: "c2", cardId: "title", start: 3, end: 5, params: { text: "Two" } },
    ] }],
  };
}

function setupClips(extra) {
  const svc = new MemDocService({ project: clipsProject(), rev: 1, ...extra });
  const A = page(svc, "A", clipsProject());
  const B = page(svc, "B", clipsProject());
  svc.drain();
  return { svc, A, B };
}

const withText = (p, id, text) => ({ ...p, tracks: p.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => (c.id === id ? { ...c, params: { ...c.params, text } } : c)) })) });
const textOf = (p, id) => p.tracks[0].clips.find((c) => c.id === id)?.params.text;

test("V5-A edits clips 1 and 2, then B edits clip 2; A undoes: clip 1 reverts, clip 2 keeps B's change, A is told clip 2 was not undone because B changed it", () => {
  const { svc, A, B } = setupClips();
  A.ds.commit(withText(withText(A.ds.project, "c1", "A1"), "c2", "A2"));
  svc.drain();
  B.ds.commit(withText(B.ds.project, "c2", "B2"));
  svc.drain();
  const res = A.ds.undo();
  assert.equal(res.done, true);
  assert.deepEqual(res.skipped.map((s) => [s.entity, s.by.session]), [["/tracks/@t1/clips/@c2", "B"]]);
  assert.equal(textOf(A.ds.project, "c1"), "One");
  assert.equal(textOf(A.ds.project, "c2"), "B2");
  svc.drain();
  assertSame(svc, A, B);
  // Undo is a new write, with undoOf, received by others as usual
  const last = svc.log[svc.log.length - 1];
  assert.equal(last.session, "A");
  assert.equal(last.undoOf, svc.log[svc.log.length - 3].opId);
  assert.equal(textOf(B.ds.project, "c1"), "One");
  // Redo: apply back the undone change (clip 1)
  assert.equal(A.ds.canRedo(), true);
  const redo = A.ds.redo();
  assert.equal(redo.done, true);
  svc.drain();
  assert.equal(textOf(B.ds.project, "c1"), "A1");
  assert.equal(textOf(B.ds.project, "c2"), "B2");
  assertSame(svc, A, B);
  assert.ok(A.notices.some((n) => n.kind === "undo" && n.result.skipped.length === 1));
});

test("V5-nothing could be undone: pop from the stack, but do not push onto the redo stack", () => {
  const { svc, A, B } = setupClips();
  A.ds.commit(withText(A.ds.project, "c2", "A2"));
  svc.drain();
  B.ds.commit(withText(B.ds.project, "c2", "B2"));
  svc.drain();
  const res = A.ds.undo();
  assert.equal(res.done, false);
  assert.equal(res.skipped.length, 1);
  assert.equal(A.ds.canUndo(), false);
  assert.equal(A.ds.canRedo(), false);
  assert.equal(textOf(A.ds.project, "c2"), "B2");
  svc.drain();
  assertSame(svc, A, B);
});

test("V5-own later edits do not count as conflicts; edits by others still block, even if I undid an intermediate step", () => {
  const { svc, A, B } = setupClips();
  A.ds.commit(withText(A.ds.project, "c2", "A2")); // Step 1
  svc.drain();
  B.ds.commit(withText(B.ds.project, "c2", "B2"));
  svc.drain();
  A.ds.commit(withText(A.ds.project, "c2", "A3")); // Step 2, overwrites B's
  svc.drain();
  // Undo step 2: no one modified after it → undo succeeds, returns to B2
  assert.equal(A.ds.undo().done, true);
  svc.drain();
  assert.equal(textOf(A.ds.project, "c2"), "B2");
  // Undo step 1: B modified after it → do not undo
  const res = A.ds.undo();
  assert.equal(res.done, false);
  assert.equal(textOf(A.ds.project, "c2"), "B2");
  svc.drain();
  assertSame(svc, A, B);
});

test("V5-parent deleted by someone else: the spot that cannot be applied counts as not undone, the rest are undone as usual", () => {
  const svc = new MemDocService({ project: clipsProject(), rev: 1 });
  const base = { ...clipsProject(), tracks: [...clipsProject().tracks, { id: "t2", name: "Track 2", clips: [{ id: "c9", cardId: "x", start: 0, end: 1, params: {} }] }] };
  svc.project = structuredClone(base);
  const A = page(svc, "A", structuredClone(base));
  const B = page(svc, "B", structuredClone(base));
  svc.drain();
  const a = structuredClone(A.ds.project);
  a.tracks[1].clips[0].start = 0.5;
  a.name = "A's name";
  A.ds.commit(a);
  svc.drain();
  const b = structuredClone(B.ds.project);
  b.tracks.splice(1, 1); // B deleted track 2 (entity /tracks/@t2, not the same entity as clip c9)
  B.ds.commit(b);
  svc.drain();
  const res = A.ds.undo();
  assert.equal(res.done, true);
  assert.deepEqual(res.failed, ["/tracks/@t2/clips/@c9"]);
  assert.equal(A.ds.project.name, "p");
  svc.drain();
  assertSame(svc, A, B);
});

test("V5-an unconfirmed step can also be undone; a new operation after undo clears the redo stack", () => {
  const { svc, A, B } = setupClips();
  A.ds.commit(withText(A.ds.project, "c1", "x"));
  A.ds.undo();
  assert.equal(textOf(A.ds.project, "c1"), "One");
  assert.equal(A.ds.canRedo(), true);
  A.ds.commit(withText(A.ds.project, "c2", "y"));
  assert.equal(A.ds.canRedo(), false);
  svc.drain();
  assertSame(svc, A, B);
});

test("V5-consecutive input in a number field within 300 ms merges into one step; beyond 300 ms starts a new step; stack limit 100", () => {
  let t = 1000;
  const svc = new MemDocService({ project: clipsProject(), rev: 1 });
  const A = page(svc, "A", clipsProject(), { now: () => t });
  svc.drain();
  for (let i = 0; i < 5; i++) {
    A.ds.commit({ ...A.ds.project, width: 1000 + i }, { mergeKey: "width" });
    t += 100;
  }
  t += 400;
  A.ds.commit({ ...A.ds.project, width: 7 }, { mergeKey: "width" });
  svc.drain();
  assert.equal(svc.log.filter((e) => e.session === "A").length, 6); // Each input still commits once as usual
  A.ds.undo();
  assert.equal(A.ds.project.width, 1004);
  A.ds.undo();
  assert.equal(A.ds.project.width, 1920);
  assert.equal(A.ds.canUndo(), false);
  svc.drain();
  assertSame(svc, A);
  // Upper limit
  for (let i = 0; i < 130; i++) { t += 1000; A.ds.commit({ ...A.ds.project, fps: i + 1 }); }
  let n = 0;
  while (A.ds.canUndo()) { A.ds.undo(); n++; }
  assert.equal(n, 100);
  assert.equal(A.ds.project.fps, 30);
  svc.drain();
  assertSame(svc, A);
});

test("V5-someone else's undo: the picture changes directly, without entering my stack", () => {
  const { svc, A, B } = setupClips();
  A.ds.commit(withText(A.ds.project, "c1", "A1"));
  svc.drain();
  A.ds.undo();
  svc.drain();
  assert.equal(textOf(B.ds.project, "c1"), "One");
  assert.equal(B.ds.canUndo(), false);
  assertSame(svc, A, B);
});

/* ---------------- Overwrite notice ---------------- */

test("Overwrite notice-the overwritten side first saves its own version as a local backup, the overwriting side receives overwrote", () => {
  const { svc, A, B } = setupClips({ overwriteWindowMs: 600_000 });
  A.ds.commit(withText(A.ds.project, "c1", "A1"));
  svc.drain();
  B.ds.commit(withText(B.ds.project, "c1", "B1"));
  svc.drain();
  assert.ok(B.notices.some((n) => n.kind === "overwrote" && n.entities[0].entity === "/tracks/@t1/clips/@c1"));
  assert.equal(A.backups.length, 1);
  assert.equal(A.backups[0].kind, "overwritten");
  assert.equal(A.backups[0].entity, "/tracks/@t1/clips/@c1");
  assert.equal(A.backups[0].value.params.text, "A1"); // It is A's own original version
  assert.equal(textOf(A.ds.project, "c1"), "B1");
  assertSame(svc, A, B);
});

/* ---------------- V6 ---------------- */

test("V6-20 edits made while disconnected, applied in order after recovery, only the first carries expectRev", () => {
  const { svc, A, B } = setupClips();
  const rev0 = svc.rev;
  A.down();
  assert.equal(A.ds.status, "offline");
  for (let i = 0; i < 20; i++) A.ds.commit(withText(A.ds.project, "c1", `Offline ${i}`));
  assert.equal(svc.rev, rev0);
  A.sent.length = 0;
  A.up();
  svc.drain();
  const ops = A.sent.filter((m) => m.type === "project.op");
  assert.equal(ops.length, 20);
  assert.equal(ops[0].expectRev, rev0);
  assert.ok(ops.slice(1).every((m) => m.expectRev === undefined));
  assert.equal(svc.rev, rev0 + 20);
  assert.deepEqual(svc.log.slice(-20).map((e) => e.opId), ops.map((m) => m.opId));
  assert.equal(textOf(svc.project, "c1"), "Offline 19");
  assert.equal(A.ds.status, "online");
  assertSame(svc, A, B);
});

function offlineConflict() {
  const ctx = setupClips();
  const { svc, A, B } = ctx;
  A.down();
  for (let i = 0; i < 20; i++) A.ds.commit(withText(A.ds.project, "c1", `Offline ${i}`));
  B.ds.commit(withText(B.ds.project, "c2", "Edited by B while A was offline"));
  svc.drain();
  A.sent.length = 0;
  A.up();
  svc.drain();
  return ctx;
}

test("V6-others also edited during the offline period: the first is rejected, the whole batch stops", () => {
  const { svc, A } = offlineConflict();
  assert.equal(A.ds.status, "paused");
  const info = A.ds.pausedInfo;
  assert.equal(info.queued, 20);
  assert.equal(info.since.length, 1);
  assert.equal(info.since[0].session, "B");
  assert.equal(A.sent.filter((m) => m.type === "project.op").length, 1); // Remaining 19 items not sent
  assert.equal(svc.log.filter((e) => e.session === "A").length, 0);
  assert.equal(textOf(A.ds.project, "c1"), "Offline 19"); // Local remains as it was when offline
});

test("V6-choose \"replay\": drop the expected revision and commit in order, all three copies match, others' changes are included too", async () => {
  const { svc, A, B } = offlineConflict();
  A.ds.replayOffline();
  svc.drain();
  assert.equal(A.ds.status, "online");
  const sessions = svc.log.slice(-21).map((e) => e.session);
  assert.deepEqual(sessions, ["B", ...Array(20).fill("A")]);
  assert.ok(svc.log.slice(-20).every((e) => e.expectRev === undefined));
  assert.equal(textOf(svc.project, "c1"), "Offline 19");
  assert.equal(textOf(svc.project, "c2"), "Edited by B while A was offline");
  assertSame(svc, A, B);
  const settled = await A.ds.whenSettled({ timeoutMs: 100 });
  assert.equal(settled.rev, svc.rev);
});

test("V6-choose \"discard\": first save this batch as a local backup, local reverts to the server version", () => {
  const { svc, A, B } = offlineConflict();
  const revBefore = svc.rev;
  A.ds.discardOffline();
  assert.equal(A.ds.status, "online");
  assert.equal(A.backups.length, 1);
  const b = A.backups[0];
  assert.equal(b.kind, "offline-discard");
  assert.equal(b.batch.length, 20);
  assert.equal(textOf(b.project, "c1"), "Offline 19");
  assert.equal(A.ds.canUndo(), false);
  svc.drain();
  assert.equal(svc.rev, revBefore);
  assert.equal(textOf(A.ds.project, "c1"), "One");
  assertSame(svc, A, B);
});

test("V6-in-flight commit was actually applied but the ok was lost on disconnect: after reconnecting the original opId is resent, the document service dedupes it, no false conflict", () => {
  const { svc, A, B } = setupClips();
  A.ds.commit(withText(A.ds.project, "c1", "In flight"));
  svc.handle(A.conn, A.conn.up.shift()); // Document service received and landed
  A.down(); // Disconnected before ok was delivered
  A.ds.commit(withText(A.ds.project, "c2", "offline"));
  A.up();
  svc.drain();
  assert.equal(A.ds.status, "online");
  assert.equal(svc.log.filter((e) => e.session === "A").length, 2);
  assertSame(svc, A, B);
});

test("V6-in-flight commit never reached the document service on disconnect: resent as usual after reconnecting", () => {
  const { svc, A, B } = setupClips();
  A.ds.commit(withText(A.ds.project, "c1", "In flight"));
  A.down(); // Upstream lost
  A.up();
  svc.drain();
  assert.equal(textOf(svc.project, "c1"), "In flight");
  assertSame(svc, A, B);
});

/* ---------------- V7 ---------------- */

test("V7-clicking save with unconfirmed operations: wait until confirmed before writing, the written content matches the document service's rev", async () => {
  const { svc, A, B } = setupClips();
  for (let i = 0; i < 5; i++) A.ds.commit(withText(A.ds.project, "c1", `Save ${i}`));
  let written = null;
  const save = A.ds.whenSettled({ timeoutMs: 1000 }).then((s) => { written = { rev: s.rev, text: json(s.project) }; });
  await Promise.resolve();
  assert.equal(written, null); // Not yet confirmed, do not write
  svc.drain();
  await save;
  assert.equal(written.rev, svc.rev);
  assert.equal(written.text, json(svc.project));
  assertSame(svc, A, B);
});

test("V7-save while offline: keep waiting, report an error on timeout", async () => {
  const { A } = setupClips();
  A.down();
  A.ds.commit(withText(A.ds.project, "c1", "x"));
  await assert.rejects(A.ds.whenSettled({ timeoutMs: 30 }), /Timed out waiting for document service confirmation/);
});

test("V7-no unconfirmed operations: return the current version immediately", async () => {
  const { svc, A } = setupClips();
  const s = await A.ds.whenSettled();
  assert.equal(s.rev, svc.rev);
});

/* ---------------- Other protocol details ---------------- */

test("The document service does not have this project yet: write the local copy in with a root replace", () => {
  const svc = new MemDocService();
  const A = page(svc, "A", clipsProject());
  A.ds.commit(withText(A.ds.project, "c1", "Edited first"));
  svc.drain();
  assert.equal(svc.rev, 1);
  assert.deepEqual(svc.log[0].ops[0].path, "");
  assert.equal(textOf(svc.project, "c1"), "Edited first");
  const B = page(svc, "B", clipsProject());
  svc.drain();
  assertSame(svc, A, B);
});

test("A rejected (bad-path) commit is rolled back locally and its corresponding undo step is removed", () => {
  const { svc, A, B } = setupClips();
  // B deleted clip 1; A does not know yet and modified text of clip 1: when A's operation reaches
  // document service, path no longer exists
  const b = structuredClone(B.ds.project);
  b.tracks[0].clips.splice(0, 1);
  B.ds.commit(b);
  A.ds.commit(withText(A.ds.project, "c1", "A1"));
  svc.handle(B.conn, B.conn.up.shift());
  svc.handle(A.conn, A.conn.up.shift());
  svc.drain();
  assert.ok(A.notices.some((n) => n.kind === "rejected" && n.reason === "bad-path"));
  assert.equal(A.ds.canUndo(), false);
  assertSame(svc, A, B);
});

/* ---------------- V8 ---------------- */

// Timed batches: 40 commits per batch, at most 8 batches, 100 ms batch interval, stop as soon as
// median on the commit side for any batch ≤ 5 ms. When machine is busy (several npm test running in
// parallel), a batch might be slowed down as a whole; criterion (batch median ≤ 5 ms) unchanged,
// the first batch is the original batch; if code truly regresses, every batch exceeds and is still
// caught. Same approach as timeIt in src/kernel/diffProject.test.mjs. Drain after each commit,
// finally verify consistency among A, B, and server as usual.
test("V8-project with 1000 clips: the page-side commit (diff + local apply) takes ≤ 5 ms, and the change appears on the other page", async () => {
  const r = rng(8);
  const big = bigProject(r, 1000);
  const svc = new MemDocService({ project: structuredClone(big), rev: 1 });
  const A = page(svc, "A", structuredClone(big));
  const B = page(svc, "B", structuredClone(big));
  svc.drain();
  const batches = [];
  for (let b = 0; b < 8 && !(batches.length && Math.min(...batches.map((x) => x.med)) <= 5); b++) {
    if (b > 0) await new Promise((res) => setTimeout(res, 100));
    const times = [];
    const e2e = [];
    for (let i = 0; i < 40; i++) {
      const p = A.ds.project;
      const ti = i % 10;
      const next = { ...p, tracks: p.tracks.map((t, k) => (k === ti ? { ...t, clips: t.clips.map((c, j) => (j === 42 ? { ...c, start: c.start + 0.01, end: c.end + 0.01 } : c)) } : t)) };
      const t0 = performance.now();
      A.ds.commit(next);
      const t1 = performance.now();
      svc.drain();
      const t2 = performance.now();
      times.push(t1 - t0);
      e2e.push(t2 - t0);
    }
    times.sort((a, c) => a - c);
    e2e.sort((a, c) => a - c);
    batches.push({ med: times[times.length >> 1], e2e: e2e[e2e.length >> 1] });
  }
  const best = batches.reduce((a, c) => (c.med < a.med ? c : a));
  console.log(`V8 docsync commit (1000 clips): median ${best.med.toFixed(3)} ms; via in-memory fake to B: median ${best.e2e.toFixed(3)} ms (${batches.length} batches measured)`);
  assert.ok(best.med <= 5, `Commit side: ${batches.length} batches measured, median of the best batch ${best.med} ms`);
  assertSame(svc, A, B);
});

test("V5-each top-level field of the project settings counts as one entity (integration ruling): if someone else changed fps, I can still undo name; it only blocks if someone else changed name", () => {
  const { svc, A, B } = setupClips();
  const name0 = A.ds.project.name;
  A.ds.commit({ ...A.ds.project, name: "A's name" });
  svc.drain();
  B.ds.commit({ ...B.ds.project, fps: 60 });
  svc.drain();
  const res = A.ds.undo();
  assert.equal(res.done, true);
  assert.deepEqual(res.skipped, []);
  svc.drain();
  assert.equal(A.ds.project.name, name0);
  assert.equal(A.ds.project.fps, 60, "B's fps is kept");
  assertSame(svc, A, B);

  A.ds.commit({ ...A.ds.project, name: "A renames again" });
  svc.drain();
  B.ds.commit({ ...B.ds.project, name: "B renames" });
  svc.drain();
  const res2 = A.ds.undo();
  assert.equal(res2.done, false);
  assert.deepEqual(res2.skipped.map((s) => [s.entity, s.by.session]), [["/meta/name", "B"]]);
  assertSame(svc, A, B);
});

/* ---------------- Protocol details aligned with document service implementation ---------------- */

test("Protocol-project.state of a large project in chunks: project.ops arriving before reassembly completes are held back, then applied in order once complete", () => {
  const p0 = clipsProject();
  const sent = [];
  const ds = new DocSync(p0, { projectId: "P", session: "A", send: (m) => sent.push(m) });
  ds.connect();
  const text = JSON.stringify(p0);
  const chunks = [text.slice(0, 50), text.slice(50, 120), text.slice(120)];
  ds.receive({ type: "project.state", rev: 10, parts: 3 });
  ds.receive({ type: "project.state.part", rev: 10, index: 0, count: 3, data: chunks[0] });
  ds.receive({ type: "project.ops", rev: 10, opId: "old", ops: [{ op: "set", path: "/name", value: "Old, already in the snapshot" }], actor: { session: "B" } });
  ds.receive({ type: "project.ops", rev: 11, opId: "x", ops: [{ op: "set", path: "/name", value: "Edited by B" }], actor: { session: "B" } });
  ds.receive({ type: "project.state.part", rev: 10, index: 2, count: 3, data: chunks[2] });
  ds.receive({ type: "project.state.part", rev: 10, index: 1, count: 3, data: chunks[1] });
  assert.equal(ds.status, "connecting");
  ds.receive({ type: "project.state.end", rev: 10 });
  assert.equal(ds.status, "online");
  assert.equal(ds.rev, 11);
  assert.equal(ds.project.name, "Edited by B");
});

test("Protocol-project.ops with resync (large root replace carries no operations): re-run project.open", () => {
  const { svc, A } = setupClips();
  const opens = A.sent.filter((m) => m.type === "project.open").length;
  A.ds.receive({ type: "project.ops", rev: svc.rev + 1, opId: "big", resync: true, actor: { session: "B" } });
  assert.equal(A.sent.filter((m) => m.type === "project.open").length, opens + 1);
  assert.ok(A.notices.some((n) => n.kind === "resync"));
});

test("Protocol-two people delete the same clip at the same time: the later one is applied as usual (no-op), all three copies match", () => {
  const { svc, A, B } = setupClips();
  const del = (p) => ({ ...p, tracks: p.tracks.map((t) => ({ ...t, clips: t.clips.filter((c) => c.id !== "c1") })) });
  A.ds.commit({ ...del(A.ds.project), name: "Other changes in the same batch by A" });
  B.ds.commit(del(B.ds.project));
  svc.handle(B.conn, B.conn.up.shift());
  svc.handle(A.conn, A.conn.up.shift());
  svc.drain();
  assert.equal(A.notices.filter((n) => n.kind === "rejected").length, 0);
  assert.equal(svc.project.name, "Other changes in the same batch by A");
  assertSame(svc, A, B);
});

/* ---------------- Planned connection handover (handover; switch to new session
   before account cloud project connection expires) ---------------- */

/**
 * Page capable of connection swap: `swap()` = new connection already established, old connection
 * invalidated (unhandled upstream on old connection dropped or not per `dropUp`, undelivered
 * downstream all dropped)
 */
function swappable(svc, session, initial) {
  const notices = [];
  const projects = [];
  let link = null;
  const sent = [];
  const ds = new DocSync(initial, { projectId: "P", session, send: (msg) => { sent.push(msg); link?.send(msg); }, saveBackup: () => {} });
  ds.on("notice", (n) => notices.push(n));
  ds.on("project", (p, cause) => projects.push(cause));
  link = svc.connect(session, (msg) => ds.receive(msg));
  ds.connect();
  const swap = (opts) => {
    const old = link;
    link = svc.connect(session, (msg) => ds.receive(msg));
    svc.disconnect(old.conn, opts);
    ds.handover();
  };
  /**
   * Swap connection but keep old connection on server (caller manages its upstream and downstream):
   * simulate in-flight commits on old connection landing only after swap completes
   */
  swap.keepOld = () => {
    link = svc.connect(session, (msg) => ds.receive(msg));
    ds.handover();
  };
  return { ds, notices, projects, sent, swap };
}

test("HO-01 commits unconfirmed during a connection switch (sent with no reply, newly made during the switch) are all resent and confirmed after the switch; others' changes in the meantime are also received; does not go through the offline batch", () => {
  const svc = new MemDocService({ project: clipsProject(), rev: 1 });
  const A = swappable(svc, "A", clipsProject());
  const B = page(svc, "B", clipsProject());
  svc.drain();
  const rev0 = svc.rev;
  // A sent one, server has not processed it yet (left on old connection during connection swap);
  // B concurrently modified another clip and it has landed
  A.ds.commit(withText(A.ds.project, "c1", "A before the switch"));
  B.ds.commit(withText(B.ds.project, "c2", "B in the meantime"));
  while (svc.conns.size && [...svc.conns].find((c) => c.session === "B").up.length) svc.handle([...svc.conns].find((c) => c.session === "B"), [...svc.conns].find((c) => c.session === "B").up.shift());
  A.sent.length = 0;
  A.swap({ dropUp: true });
  // At the moment of swap (new connection still waiting for state), made another one
  A.ds.commit(withText(A.ds.project, "c1", "A during the switch"));
  assert.notEqual(A.ds.status, "offline", "A planned connection switch does not show offline");
  svc.drain();
  assert.equal(A.ds.status, "online");
  assert.equal(A.ds.unconfirmed, 0);
  assert.equal(svc.rev, rev0 + 3);
  assert.equal(textOf(svc.project, "c1"), "A during the switch");
  assert.equal(textOf(svc.project, "c2"), "B in the meantime");
  assert.equal(textOf(A.ds.project, "c2"), "B in the meantime", "Others' changes were received");
  const ops = A.sent.filter((m) => m.type === "project.op");
  assert.equal(ops.length, 2);
  assert.ok(ops.every((m) => m.expectRev === undefined), "No expected revision: even if someone else happens to edit at that moment, it is not judged an offline conflict");
  assert.equal(A.notices.filter((n) => n.kind === "rejected" || n.kind === "resync" || n.kind === "replay-dropped").length, 0);
  assertSame(svc, A, B);
});

test("HO-02 a commit already applied on the old connection whose confirmation was just not received: after the switch it is deduped by opId, not applied a second time", () => {
  const svc = new MemDocService({ project: clipsProject(), rev: 1 });
  const A = swappable(svc, "A", clipsProject());
  svc.drain();
  const rev0 = svc.rev;
  A.ds.commit(withText(A.ds.project, "c1", "Already applied"));
  // Old connection upstream processed as usual (dropUp: false), confirmation dropped in old
  // connection's downstream
  A.swap({ dropUp: false });
  assert.equal(svc.rev, rev0 + 1);
  svc.drain();
  assert.equal(svc.rev, rev0 + 1, "Not applied a second time");
  assert.equal(A.ds.unconfirmed, 0);
  assert.equal(textOf(A.ds.project, "c1"), "Already applied");
  assert.equal(A.notices.length, 0);
});

test("HO-03 no new version from this switch: the project object in hand is kept as is (no new object, UI does not recompute)", () => {
  const svc = new MemDocService({ project: clipsProject(), rev: 1 });
  const A = swappable(svc, "A", clipsProject());
  svc.drain();
  const before = A.ds.project;
  A.projects.length = 0;
  A.swap({ dropUp: true });
  svc.drain();
  assert.equal(A.ds.project, before);
  assert.deepEqual(A.projects, []);
  assert.equal(A.ds.status, "online");
  // Commit as usual afterwards
  A.ds.commit(withText(A.ds.project, "c1", "After the switch"));
  svc.drain();
  assert.equal(textOf(svc.project, "c1"), "After the switch");
});

test("HO-04 is already in the offline batch: switching connections does not change the offline rules (the first op still carries the expected version)", () => {
  const { svc, A } = setupClips();
  const rev0 = svc.rev;
  A.down();
  A.ds.commit(withText(A.ds.project, "c1", "edited offline"));
  A.sent.length = 0;
  A.up();
  A.ds.handover();
  svc.drain();
  const ops = A.sent.filter((m) => m.type === "project.op");
  assert.equal(ops.at(-1).expectRev, rev0);
  assert.equal(textOf(svc.project, "c1"), "edited offline");
  assert.equal(A.ds.status, "online");
});

test("HO-05 two ops in flight on the old connection when switching: the first is already included in the new state, the second lands after the switch and replies first -- refetch the whole document once, and end up consistent with the document service", () => {
  const svc = new MemDocService({ project: clipsProject(), rev: 1 });
  const A = swappable(svc, "A", clipsProject());
  svc.drain();
  const rev0 = svc.rev;
  const connA = () => [...svc.conns].filter((c) => c.session === "A");
  A.ds.commit(withText(A.ds.project, "c1", "X"));
  A.ds.commit(withText(A.ds.project, "c2", "Y"));
  const old = connA()[0];
  // X lands first on old connection (confirmation remains in old connection's downstream, dropped
  // after swap)
  svc.handle(old, old.up.shift());
  const yMsg = old.up.shift();
  A.swap({ dropUp: true });
  const fresh = connA()[0];
  // New connection gets state first (including X); only then Y lands via old connection and is sent
  // back to new connection; echoes of resent X and Y follow behind
  svc.handle(fresh, fresh.up.shift());
  fresh.onMessage(fresh.down.shift());
  svc.handle({ ...old, open: true, down: [] }, yMsg);
  svc.drain();
  assert.equal(svc.rev, rev0 + 2);
  assert.equal(A.ds.unconfirmed, 0);
  assert.equal(textOf(A.ds.project, "c1"), "X");
  assert.equal(textOf(A.ds.project, "c2"), "Y");
  // Do not guess whether previous one landed: if confirmation order is inverted, refetch the whole
  // copy (silently, no user prompt); only this type of notification is allowed
  assert.deepEqual(A.notices.filter((n) => n.kind !== "remote").map((n) => n.kind), ["resync"]);
  assert.equal(JSON.stringify(A.ds.project), JSON.stringify(svc.project));
  assert.equal(JSON.stringify(A.ds.confirmedProject), JSON.stringify(svc.project));
});

test("HO-06 review repro: the first op did not land on the old connection (the gate rejected it and the page did not know), the second lands via the old connection after the switch -- the page must not stay on content that is inconsistent with the document service", () => {
  const svc = new MemDocService({ project: clipsProject(), rev: 1 });
  const A = swappable(svc, "A", clipsProject());
  svc.drain();
  const connA = () => [...svc.conns].filter((c) => c.session === "A");
  A.ds.commit({ ...A.ds.project, name: "X" });
  A.ds.commit({ ...A.ds.project, name: "Y" });
  const old = connA()[0];
  old.up.shift();                 // X: did not land on old connection (gate returned error without commit number)
  const yMsg = old.up.shift();    // Y: still in flight
  A.swap({ dropUp: true });
  const fresh = connA()[0];
  svc.handle(fresh, fresh.up.shift());                  // New connection gets state (excluding X, Y)
  fresh.onMessage(fresh.down.shift());
  svc.handle({ ...old, open: true, down: [] }, yMsg);   // Y lands via old connection, sent back to new connection
  svc.drain();
  // On document service it is Y then X; page must be the same
  assert.equal(svc.project.name, "X");
  assert.equal(A.ds.project.name, "X");
  assert.equal(A.ds.confirmedProject.name, "X");
  assert.equal(A.ds.unconfirmed, 0);
  assert.equal(A.ds.rev, svc.rev);
});

/**
 * Exhaustive test: at the moment of connection swap, 2–3 in-flight commits on old connection (all
 * modifying the same field, plus each with its own field), enumerating three destinations for each:
 *   gate   Rejected by gate on old connection (returned error without commit number, page
 *     unaware), did not land;
 *   before Landed via old connection before new connection got state (echo dropped on old
 *     connection);
 *   after  Landed via old connection only after swap (echo returns via new connection,
 *     indeterminate order with the resent one and other echoes).
 * Layered with: whether another commit was made at the moment of swap, whether other members
 * modified concurrently; delivery order scrambled for each combination using several random seeds.
 * Once settled, only two outcomes permitted: page local replica and confirmed replica match
 * document service content with no unconfirmed items (refetching the whole copy midway is not an
 * error); never allow "inconsistent without any activity".
 */
test("HO-07 exhaustively cover every outcome and echo order of in-flight commits when switching connections: once quiet, the page is consistent with the document service and unconfirmed is 0", () => {
  const FATES = ["gate", "before", "after"];
  const combos = (n) => (n === 0 ? [[]] : combos(n - 1).flatMap((c) => FATES.map((f) => [...c, f])));
  const canon = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
  let cases = 0, resynced = 0;
  for (const n of [2, 3]) for (const fates of combos(n)) for (const late of [false, true]) for (const other of [false, true]) for (let seed = 1; seed <= 8; seed++) {
    const label = `${fates.join(",")} late=${late} other=${other} seed=${seed}`;
    const svc = new MemDocService({ project: clipsProject(), rev: 1 });
    const A = swappable(svc, "A", clipsProject());
    const B = page(svc, "B", clipsProject());
    svc.drain();
    for (let i = 0; i < n; i++) A.ds.commit({ ...A.ds.project, name: `v${i}`, [`k${i}`]: i });
    const old = [...svc.conns].find((c) => c.session === "A");
    const msgs = old.up.splice(0);
    assert.equal(msgs.length, n, label);
    // before: lands right now (echo remains on old connection, not delivered to page)
    msgs.forEach((m, i) => { if (fates[i] === "before") svc.handle(old, m); });
    old.down.length = 0;
    // Connection swap: old connection remains on server (no longer delivers to page); after items are
    // still in its upstream queue, random delivery determines when they land
    const quiet = old.onMessage;
    old.onMessage = () => {};
    msgs.forEach((m, i) => { if (fates[i] === "after") old.up.push(m); });
    A.swap.keepOld();
    if (late) A.ds.commit({ ...A.ds.project, name: "late", late: 1 });
    if (other) B.ds.commit({ ...B.ds.project, other: seed });
    svc.drain(rng(seed));
    svc.drain();
    void quiet;
    cases++;
    if (A.notices.some((x) => x.kind === "resync")) resynced++;
    assert.equal(A.ds.unconfirmed, 0, `${label}: there are still unconfirmed ops`);
    assert.equal(canon(A.ds.project), canon(svc.project), `${label}: the page's local copy is inconsistent with the document service`);
    assert.equal(canon(A.ds.confirmedProject), canon(svc.project), `${label}: the page's confirmed copy is inconsistent with the document service`);
    assert.equal(A.ds.rev, svc.rev, `${label}: version number`);
    assert.equal(canon(B.ds.project), canon(svc.project), `${label}: another member is inconsistent with the document service`);
    assert.deepEqual(A.notices.filter((x) => !["remote", "resync"].includes(x.kind)).map((x) => x.kind), [], `${label}: there should be no notices such as rejected or discarded`);
    assert.equal(A.ds.status, "online", label);
  }
  assert.equal(cases, (9 + 27) * 2 * 2 * 8);
  assert.ok(resynced > 0 && resynced < cases, `of which ${resynced} / ${cases} went through a full refetch`);
});
