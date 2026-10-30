/**
 * 断网 → 重连 → 逐项合并的整条路(页面一侧的同步层 + 待合并表 + 文档服务的待合并表模块)。
 * 跑:npm test -- src/editor/sync/offlineMerge.test.mjs
 *
 * 用内存文档服务假件(`src/testing/memDocService.mjs`)做项目,真的待合并表模块(`server/docservice/modules/pending-merge.mjs`)
 * 做表,内存存储做本机暂存:
 *   OM-01 断网期间别人也改过:重连后离线批次逐项转进待合并表,DocSync 回到云端现状照常同步(不再整份停着)
 *   OM-02 逐项合并:只勾一项点「合并」,这一项照我这边写进云端、从表里拿掉;没勾的留在表里;别人的改动都在
 *   OM-03 「删除选中」:从表里拿掉,云端不动;重复删除幂等
 *   OM-04 断网时表的改动先进本机暂存,连上后按顺序交给文档服务;换一个页面(同一用户)从文档服务恢复同一张表
 *   OM-05 本机暂存(浏览器本地缓存)用 IndexedDB 落盘:新开一个页面读得回离线批次与表
 *   OM-06 断网期间没人改过:照旧直接提交,不进待合并表
 *   OM-07 到上限(每用户每项目条数、整表大小):文档服务整条不收,页面留在本机、说明原因;处理掉一些之后自动再交,别的不丢
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
  version: 1, id: "p1", name: "演示", width: 1920, height: 1080, fps: 30, duration: 20, themeId: "dark", media: [],
  tracks: [{ id: "t1", name: "主序列", clips: [clip("c1", 0, 2, { opacity: 0.4 }), clip("c2", 3, 5), clip("c3", 6, 8)] }],
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

/** 文档服务的待合并表:一个模块实例,按连接身份分用户 */
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

/** 照 syncManager 的做法:停下就逐项转进表,再回到云端现状 */
async function transfer(A, table) {
  assert.equal(A.ds.status, "paused");
  const things = offlineThings(A.ds.recoveryJournal(), { batch: "b1", at: 1 });
  assert.ok(things, "算得出基准");
  await table.add(things);
  A.ds.discardOffline();
  return things;
}

function scenario() {
  const svc = new MemDocService({ project: project(), rev: 3 });
  const A = page(svc, "A"), B = page(svc, "B");
  svc.drain();
  A.down();
  // A 断网期间:c1 透明度改两次、长度改一次;删了 c3
  A.ds.commit(edit(A.ds.project, (p) => { clipIn(p, "c1").opacity = 0.6; }));
  A.ds.commit(edit(A.ds.project, (p) => { clipIn(p, "c1").opacity = 0.8; clipIn(p, "c1").end = 2.5; }));
  A.ds.commit(edit(A.ds.project, (p) => { p.tracks[0].clips = p.tracks[0].clips.filter((c) => c.id !== "c3"); }));
  // B 同时:c1 透明度改成 0.5、c3 改了名字
  B.ds.commit(edit(B.ds.project, (p) => { clipIn(p, "c1").opacity = 0.5; clipIn(p, "c3").label = "片尾"; }));
  svc.drain();
  A.up();
  svc.drain();
  return { svc, A, B };
}

test("OM-01 重连后离线批次逐项转进待合并表,DocSync 回到云端现状照常同步", async () => {
  const { svc, A } = scenario();
  const server = mergeServer();
  const table = new MergeTable({ projectId: "P", user: "user:alice", kv: C.memoryStore() });
  await table.attach(server.channel("alice"));
  const things = await transfer(A, table);
  assert.equal(A.ds.status, "online", "不再整份停着");
  assert.equal(JSON.stringify(A.ds.project), JSON.stringify(svc.project), "本地回到云端现状");
  assert.deepEqual(things.map((t) => `${t.key}:${t.props.map((p) => p.prop).sort().join(",")}`).sort(),
    ["offline:clip:c1:@time,opacity", "offline:clip:c3:"], "c1 两个属性(透明度改两次只一条),c3 删除");
  const rows = M.mergeRows(A.ds.project, table.things);
  const c1 = rows.find((r) => r.key === "offline:clip:c1");
  assert.equal(c1.props.find((p) => p.prop === "opacity").text, "透明度 0.4 → 0.8（云端现在是 0.5）");
  assert.equal(rows.find((r) => r.key === "offline:clip:c3").conflict, true, "我删了、别人改了:冲突");
  await table.flush();
  assert.equal(A.backups.length, 1, "照旧留一份整批备份(安全网)");
});

test("OM-02 只勾一项点「合并」:照我这边写进云端、从表里拿掉;没勾的留着;别人的改动都在", async () => {
  const { svc, A, B } = scenario();
  const server = mergeServer();
  const table = new MergeTable({ projectId: "P", user: "user:alice", kv: C.memoryStore() });
  await table.attach(server.channel("alice"));
  await transfer(A, table);
  const rows = M.mergeRows(A.ds.project, table.things);
  const sel = new Map([["offline:clip:c1", new Set(["@time"])]]);
  const r = M.applyMerge(A.ds.project, table.things, sel);
  assert.equal(r.failed.length, 0);
  A.ds.mergeOffline(r.project, A.ds.rev); // syncManager 也是这么提交的:一次普通修改
  await table.remove(r.done);
  svc.drain();
  assert.equal(clipIn(svc.project, "c1").end, 2.5, "长度照我这边");
  assert.equal(clipIn(svc.project, "c1").opacity, 0.5, "没勾的透明度保留云端");
  assert.equal(clipIn(svc.project, "c3").label, "片尾", "别人的改动都在");
  assert.equal(JSON.stringify(B.ds.project), JSON.stringify(svc.project));
  const left = table.things.map((t) => `${t.key}:${t.props.map((p) => p.prop).join(",")}`).sort();
  assert.deepEqual(left, ["offline:clip:c1:opacity", "offline:clip:c3:"]);
  assert.ok(rows.length === 2);
});

test("OM-03 「删除选中」:从表里拿掉,云端不动;重复删除幂等", async () => {
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
  assert.equal(svc.rev, revBefore, "云端没有新提交");
  assert.equal(clipIn(svc.project, "c3").label, "片尾");
  const st = await ch.request({ type: "merge.list", projectId: "P" });
  assert.deepEqual(st.things.map((t) => t.key), ["offline:clip:c1"]);
});

test("OM-04 断网时表的改动先进本机暂存,连上后交给文档服务;同一用户换个页面从文档服务恢复", async () => {
  const { A } = scenario();
  const server = mergeServer();
  const ch = server.channel("alice");
  ch.online = false;
  const kv = C.memoryStore();
  const table = new MergeTable({ projectId: "P", user: "user:alice", kv });
  await table.attach(ch);
  await transfer(A, table);
  assert.equal(table.pendingOps, 1, "文档服务连不上:待发");
  assert.ok(kv.size > 0, "本机暂存里有");
  ch.online = true;
  await table.flush();
  assert.equal(table.pendingOps, 0);
  // 另一台设备(同一用户、全新的本机暂存)
  const other = new MergeTable({ projectId: "P", user: "user:alice", kv: C.memoryStore() });
  await other.attach(server.channel("alice"));
  assert.deepEqual(other.things.map((t) => t.key).sort(), ["offline:clip:c1", "offline:clip:c3"]);
  // 别的用户看不见
  const bob = new MergeTable({ projectId: "P", user: "user:bob", kv: C.memoryStore() });
  await bob.attach(server.channel("bob"));
  assert.deepEqual(bob.things, []);
});

test("OM-05 本机暂存用 IndexedDB 落盘:新开页面读得回离线批次与表", async () => {
  const factory = createFakeIndexedDB();
  const kv = C.idbStore(factory);
  const { A } = scenario();
  const journal = A.ds.recoveryJournal();
  await kv.put(C.cacheKey("journal", "P", "user:alice"), journal);
  const table = new MergeTable({ projectId: "P", user: "user:alice", kv });
  await transfer(A, table);
  // 「新开页面」:同一个库,新的实例
  const kv2 = C.idbStore(factory);
  const back = await kv2.get(C.cacheKey("journal", "P", "user:alice"));
  assert.equal(back.pending.length, journal.pending.length);
  const reopened = new MergeTable({ projectId: "P", user: "user:alice", kv: kv2 });
  await reopened.ready();
  assert.deepEqual(reopened.things.map((t) => t.key).sort(), ["offline:clip:c1", "offline:clip:c3"]);
  assert.equal(reopened.pendingOps, 1, "还没交到文档服务的也记着");
  // 离线批次恢复进新页面的 DocSync:照常走「第一条带期望版本去试」;云端已被别人改过就停下,再逐项转进表
  const svc = new MemDocService({ project: edit(project(), (p) => { clipIn(p, "c2").label = "别人改的"; }), rev: 4 });
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

test("OM-06 断网期间没人改过:照旧直接提交,不进待合并表", () => {
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

test("OM-07 到上限:文档服务整条不收,页面留在本机并说明;删掉一些后自动再交,已删的不会被记回去", async () => {
  const { A } = scenario();
  const server = mergeServer({ ...MERGE_LIMITS, THINGS_PER_USER: 1 });
  const ch = server.channel("alice");
  const table = new MergeTable({ projectId: "P", user: "user:alice", kv: C.memoryStore() });
  await table.attach(ch);
  await transfer(A, table);
  await table.flush();
  assert.equal(table.blocked, "too-many", "两样东西超过 1 条的上限:不收");
  assert.equal(table.things.length, 2, "本机的表不丢");
  assert.equal(table.pendingOps, 1);
  assert.deepEqual((await ch.request({ type: "merge.list", projectId: "P" })).things, [], "文档服务里什么都没记(不收一半)");
  // 用户在窗口里删掉一样:先把「拿掉」发出去,再重交剩下的一样
  await table.remove([{ key: "offline:clip:c3", props: [""] }]);
  await table.flush();
  assert.equal(table.blocked, null);
  assert.equal(table.pendingOps, 0);
  assert.deepEqual((await ch.request({ type: "merge.list", projectId: "P" })).things.map((t) => t.key), ["offline:clip:c1"], "删掉的没被记回去");
});
