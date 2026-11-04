/**
 * The entire path of disconnect → reconnect → item-by-item merge (page-side sync layer + pending
 * merge table + document service pending merge table module).
 * Run: npm test -- src/editor/sync/offlineMerge.test.mjs
 *
 * Using in-memory document service fake (`src/testing/memDocService.mjs`) for project, real pending
 * merge table module (`server/docservice/modules/pending-merge.mjs`) for table, in-memory storage
 * for local staging:
 *   OM-01 Others also modified during disconnect: after reconnect, offline batches are transferred
 *         item-by-item into pending merge table, DocSync returns to cloud current state and syncs
 *         as usual (no longer stalled entirely)
 *   OM-02 Item-by-item merge: check only one item and click "Merge", this item is written to cloud
 *         according to my side and removed from table; unchecked items remain in table; changes from
 *         others are all kept
 *   OM-03 "Delete selected": removed from table, cloud untouched; repeated deletions are idempotent
 *   OM-04 Table changes during disconnect enter local staging first, handed to document service in
 *         order after connecting; switching pages (same user) restores same table from document service
 *   OM-05 Local staging (browser local cache) persisted to disk via IndexedDB: a newly opened page
 *         can read back offline batches and table
 *   OM-06 Untouched by others during disconnect: submitted directly as before, does not enter
 *         pending merge table
 *   OM-07 Limit reached (item count per user per project, entire table size): document service
 *         rejects entire entry, page stays local with reason stated; automatically resubmits after
 *         resolving some items, others not lost
 */
import { srcUrl } from "../../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { MemDocService } from "../../testing/memDocService.mjs";
import { createFakeIndexedDB } from "../../testing/fakeIndexedDB.mjs";
import { pendingMergeModule, MERGE_LIMITS } from "../../../server/docservice/modules/pending-merge.mjs";
import { createMemoryStore } from "../../../server/docservice/store/index.mjs";

const { DocSync } = await import(srcUrl("store/docsync.ts"));
const { offlineThings } = await import(srcUrl("editor/sync/offlineTransfer.ts"));
const M = await import(srcUrl("editor/sync/mergeItems.ts"));
const { MergeTable } = await import(srcUrl("editor/sync/mergeTable.ts"));
const C = await import(srcUrl("editor/sync/offlineCache.ts"));

const clip = (id, start, end, extra = {}) => ({ id, cardId: "", start, end, params: {}, label: id, ...extra });
const project = () => ({
  version: 1, id: "p1", name: "Demo", width: 1920, height: 1080, fps: 30, duration: 20, themeId: "dark", media: [],
  tracks: [{ id: "t1", name: "Main track", clips: [clip("c1", 0, 2, { opacity: 0.4 }), clip("c2", 3, 5), clip("c3", 6, 8)] }],
});
const edit = (p, fn) => { const q = structuredClone(p); fn(q); return q; };
const clipIn = (p, id) => p.tracks.flatMap((t) => t.clips).find((c) => c.id === id);

function page(svc, session) {
  let link = null;
  const backups = [];
  const ds = new DocSync(structuredClone(svc.project), { projectId: "P", session, send: (m) => link?.send(m), saveBackup: (b) => backups.push(b) });
  const up = () => { link = svc.connect(session, (m) => ds.receive(m)); ds.connect(); };
  const down = () => { if (link) svc.disconnect(link.conn); link = null; ds.disconnect(); };
  up();
  return { ds, up, down, backups };
}

/** Pending merge table of document service: a module instance, separating users by connection identity */
function mergeServer(limits) {
  const store = createMemoryStore();
  const mod = pendingMergeModule({ store, ...(limits ? { limits } : {}) });
  let seq = 0;
  const conns = new Map();
  const channel = (username) => {
    const connId = `c${++seq}`;
    const inbox = [];
    conns.set(connId, inbox);
    mod.connect({}, connId, { userId: `${username}@d${seq}`, username, tenantId: "P", scope: "member", role: "page" });
    let online = true;
    return {
      set online(v) { online = v; },
      inbox,
      async request(msg) {
        if (!online) throw new Error("offline");
        const reqId = `q${++seq}`;
        let reply;
        mod.handle({ send: (to, m) => { if (to === connId && m.reqId === reqId) reply = m; else conns.get(to)?.push(m); } }, connId, { ...msg, reqId });
        return reply;
      },
    };
  };
  return { mod, store, channel };
}

/** Following syncManager practice: once stopped, transfer item-by-item into table, then return to cloud current state */
async function transfer(A, table) {
  assert.equal(A.ds.status, "paused");
  const things = offlineThings(A.ds.recoveryJournal(), { batch: "b1", at: 1 });
  assert.ok(things, "the base can be computed");
  await table.add(things);
  A.ds.discardOffline();
  return things;
}

function scenario() {
  const svc = new MemDocService({ project: project(), rev: 3 });
  const A = page(svc, "A"), B = page(svc, "B");
  svc.drain();
  A.down();
  // During A disconnect: c1 opacity modified twice, duration modified once; c3 deleted
  A.ds.commit(edit(A.ds.project, (p) => { clipIn(p, "c1").opacity = 0.6; }));
  A.ds.commit(edit(A.ds.project, (p) => { clipIn(p, "c1").opacity = 0.8; clipIn(p, "c1").end = 2.5; }));
  A.ds.commit(edit(A.ds.project, (p) => { p.tracks[0].clips = p.tracks[0].clips.filter((c) => c.id !== "c3"); }));
  // B concurrently: c1 opacity changed to 0.5, c3 renamed
  B.ds.commit(edit(B.ds.project, (p) => { clipIn(p, "c1").opacity = 0.5; clipIn(p, "c3").label = "Outro"; }));
  svc.drain();
  A.up();
  svc.drain();
  return { svc, A, B };
}

test("OM-01 after reconnecting, the offline batch is converted entry by entry into the pending merge table, and DocSync returns to the cloud's current state and syncs as usual", async () => {
  const { svc, A } = scenario();
  const server = mergeServer();
  const table = new MergeTable({ projectId: "P", user: "user:alice", kv: C.memoryStore() });
  await table.attach(server.channel("alice"));
  const things = await transfer(A, table);
  assert.equal(A.ds.status, "online", "no longer parked as a whole");
  assert.equal(JSON.stringify(A.ds.project), JSON.stringify(svc.project), "local returns to the cloud's current state");
  assert.deepEqual(things.map((t) => `${t.key}:${t.props.map((p) => p.prop).sort().join(",")}`).sort(),
    ["offline:clip:c1:@time,opacity", "offline:clip:c3:"], "two properties on c1 (opacity changed twice is only one entry), c3 deleted");
  const rows = M.mergeRows(A.ds.project, table.things);
  const c1 = rows.find((r) => r.key === "offline:clip:c1");
  assert.equal(c1.props.find((p) => p.prop === "opacity").text, "Opacity 0.4 → 0.8 (The cloud is now 0.5)");
  assert.equal(rows.find((r) => r.key === "offline:clip:c3").conflict, true, "I deleted it, someone else changed it: conflict");
  await table.flush();
  assert.equal(A.backups.length, 1, "a whole-batch backup is still kept as before (safety net)");
});

test("OM-02 check only one entry and click \"Merge\": it is written to the cloud as on my side and removed from the table; unchecked ones stay; other people's changes are all kept", async () => {
  const { svc, A, B } = scenario();
  const server = mergeServer();
  const table = new MergeTable({ projectId: "P", user: "user:alice", kv: C.memoryStore() });
  await table.attach(server.channel("alice"));
  await transfer(A, table);
  const rows = M.mergeRows(A.ds.project, table.things);
  const sel = new Map([["offline:clip:c1", new Set(["@time"])]]);
  const r = M.applyMerge(A.ds.project, table.things, sel);
  assert.equal(r.failed.length, 0);
  A.ds.mergeOffline(r.project, A.ds.rev); // syncManager also submits like this: an ordinary modification
  await table.remove(r.done);
  svc.drain();
  assert.equal(clipIn(svc.project, "c1").end, 2.5, "length follows my side");
  assert.equal(clipIn(svc.project, "c1").opacity, 0.5, "an unchecked opacity keeps the cloud's value");
  assert.equal(clipIn(svc.project, "c3").label, "Outro", "other people's changes are all there");
  assert.equal(JSON.stringify(B.ds.project), JSON.stringify(svc.project));
  const left = table.things.map((t) => `${t.key}:${t.props.map((p) => p.prop).join(",")}`).sort();
  assert.deepEqual(left, ["offline:clip:c1:opacity", "offline:clip:c3:"]);
  assert.ok(rows.length === 2);
});

test("OM-03 \"Delete selected\": removed from the table, the cloud is untouched; repeated deletion is idempotent", async () => {
  const { svc, A } = scenario();
  const server = mergeServer();
  const ch = server.channel("alice");
  const table = new MergeTable({ projectId: "P", user: "user:alice", kv: C.memoryStore() });
  await table.attach(ch);
  await transfer(A, table);
  await table.flush();
  const revBefore = svc.rev;
  await table.remove([{ key: "offline:clip:c3", props: [""] }]);
  await table.remove([{ key: "offline:clip:c3", props: [""] }]);
  await table.flush();
  assert.equal(svc.rev, revBefore, "no new commit in the cloud");
  assert.equal(clipIn(svc.project, "c3").label, "Outro");
  const st = await ch.request({ type: "merge.list", projectId: "P" });
  assert.deepEqual(st.things.map((t) => t.key), ["offline:clip:c1"]);
});

test("OM-04 when offline, table changes first go to local staging and are handed to the document service once connected; the same user on another page restores from the document service", async () => {
  const { A } = scenario();
  const server = mergeServer();
  const ch = server.channel("alice");
  ch.online = false;
  const kv = C.memoryStore();
  const table = new MergeTable({ projectId: "P", user: "user:alice", kv });
  await table.attach(ch);
  await transfer(A, table);
  assert.equal(table.pendingOps, 1, "cannot reach the document service: pending send");
  assert.ok(kv.size > 0, "it is in local staging");
  ch.online = true;
  await table.flush();
  assert.equal(table.pendingOps, 0);
  // Another device (same user, fresh local staging)
  const other = new MergeTable({ projectId: "P", user: "user:alice", kv: C.memoryStore() });
  await other.attach(server.channel("alice"));
  assert.deepEqual(other.things.map((t) => t.key).sort(), ["offline:clip:c1", "offline:clip:c3"]);
  // Invisible to other users
  const bob = new MergeTable({ projectId: "P", user: "user:bob", kv: C.memoryStore() });
  await bob.attach(server.channel("bob"));
  assert.deepEqual(bob.things, []);
});

test("OM-05 local staging is persisted to disk with IndexedDB: a newly opened page can read back the offline batch and the table", async () => {
  const factory = createFakeIndexedDB();
  const kv = C.idbStore(factory);
  const { A } = scenario();
  const journal = A.ds.recoveryJournal();
  await kv.put(C.cacheKey("journal", "P", "user:alice"), journal);
  const table = new MergeTable({ projectId: "P", user: "user:alice", kv });
  await transfer(A, table);
  // "Newly opened page": same store, new instance
  const kv2 = C.idbStore(factory);
  const back = await kv2.get(C.cacheKey("journal", "P", "user:alice"));
  assert.equal(back.pending.length, journal.pending.length);
  const reopened = new MergeTable({ projectId: "P", user: "user:alice", kv: kv2 });
  await reopened.ready();
  assert.deepEqual(reopened.things.map((t) => t.key).sort(), ["offline:clip:c1", "offline:clip:c3"]);
  assert.equal(reopened.pendingOps, 1, "entries not yet handed to the document service are remembered too");
  // Offline batch restored into DocSync of new page: proceeds as usual with "try first item with
  // expected version"; stops if cloud was modified by others, then transfers item-by-item into table
  const svc = new MemDocService({ project: edit(project(), (p) => { clipIn(p, "c2").label = "Changed by others"; }), rev: 4 });
  let link = null;
  const ds = new DocSync(project(), { projectId: "P", session: "A2", send: (m) => link?.send(m) });
  ds.restoreJournal(back);
  assert.equal(ds.unconfirmed, journal.pending.length);
  link = svc.connect("A2", (m) => ds.receive(m));
  ds.connect();
  svc.drain();
  assert.equal(ds.status, "paused");
  assert.deepEqual(offlineThings(ds.recoveryJournal(), { batch: "b2", at: 2 }).map((t) => t.key).sort(), ["offline:clip:c1", "offline:clip:c3"]);
});

test("OM-06 nobody changed anything while offline: commit directly as before, without entering the pending merge table", () => {
  const svc = new MemDocService({ project: project(), rev: 3 });
  const A = page(svc, "A");
  svc.drain();
  A.down();
  A.ds.commit(edit(A.ds.project, (p) => { clipIn(p, "c2").opacity = 0.3; }));
  A.up();
  svc.drain();
  assert.equal(A.ds.status, "online");
  assert.equal(clipIn(svc.project, "c2").opacity, 0.3);
});

test("OM-07 limit reached: the document service rejects the whole entry, the page keeps it locally and explains why; after some are deleted it is resubmitted automatically, and deleted ones are not recorded back", async () => {
  const { A } = scenario();
  const server = mergeServer({ ...MERGE_LIMITS, THINGS_PER_USER: 1 });
  const ch = server.channel("alice");
  const table = new MergeTable({ projectId: "P", user: "user:alice", kv: C.memoryStore() });
  await table.attach(ch);
  await transfer(A, table);
  await table.flush();
  assert.equal(table.blocked, "too-many", "two items exceed the limit of 1: not accepted");
  assert.equal(table.things.length, 2, "the local table is not lost");
  assert.equal(table.pendingOps, 1);
  assert.deepEqual((await ch.request({ type: "merge.list", projectId: "P" })).things, [], "the document service recorded nothing (no half-accepting)");
  // User deletes an item in the dialog: send "remove" first, then resubmit the remaining item
  await table.remove([{ key: "offline:clip:c3", props: [""] }]);
  await table.flush();
  assert.equal(table.blocked, null);
  assert.equal(table.pendingOps, 0);
  assert.deepEqual((await ch.request({ type: "merge.list", projectId: "P" })).things.map((t) => t.key), ["offline:clip:c1"], "the deleted one was not recorded back");
});
