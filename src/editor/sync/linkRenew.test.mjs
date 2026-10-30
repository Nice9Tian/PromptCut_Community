/**
 * `SyncLink.renew()`(账号云端项目到期前换会话)与换完之后跟着连接走的状态。WebSocket 用替身;
 * 对着真服务的在 `server/test/account-page-link.test.mjs`、`server/test/account-page-selection.test.mjs`。
 * 跑:npm test -- src/editor/sync/linkRenew.test.mjs
 *
 *   LR-01 新会话建成后、等旧会话上的提交落定的那几秒里被服务端关掉:不切过去,按没换成处理,旧会话照常用(审查复现)
 *   LR-02 换完之后在新连接上重新发布选区(同一个页面号)、重新取在场状态(审查复现);旧会话上没有在等回包的请求就当场关
 *   LR-03 旧会话上有在等回包的请求:留着收完再关,回包照常交给等它的人
 *   LR-04 这条连接上报到过的发布方,换完在新连接上原样再报一次
 *   LR-05 传输已经脱开(正在接续)时不换
 */
import { srcUrl } from "../../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const { SyncLink } = await import(srcUrl("editor/sync/link.ts"));
const { setSelectionLink, selectionPresenceStatus } = await import(srcUrl("editor/sync/selectionPresence.ts"));
const { setPresenceLink, resyncPresenceLink } = await import(srcUrl("editor/sync/presence.ts"));
const { createEmptyProject } = await import(srcUrl("kernel/project.ts"));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const wait = async (predicate, what) => { for (let i = 0; i < 600; i++) { if (predicate()) return; await pause(5); } assert.fail(`没等到:${what}`); };

/** 一套受控的连接:每个 socket 自己回 project.state、selection.ok、presence.state;`hold` 里的类型先不回 */
function rig({ hold = [] } = {}) {
  const sockets = [];
  const initial = createEmptyProject("p");
  class Socket extends EventTarget {
    constructor(url, protocols) { super(); this.protocols = protocols; this.readyState = 0; this.sent = []; this.out = 0; this.closedByUs = false; sockets.push(this); }
    send(text) {
      const m = JSON.parse(text);
      this.sent.push(m);
      if (hold.includes(m.type)) return;
      if (m.type === "project.open") this.push({ type: "project.state", projectId: "room", rev: 1, project: initial });
      if (m.type === "selection.set" || m.type === "selection.clear") this.push({ type: "selection.ok", reqId: m.reqId, projectId: m.projectId, pageId: m.pageId, selectionRevision: m.revision });
      if (m.type === "presence.list") this.push({ type: "presence.state", reqId: m.reqId, projectId: m.projectId, entries: [] });
    }
    close() { if (this.readyState === 3) return; this.readyState = 3; this.closedByUs = true; this.dispatchEvent(Object.assign(new Event("close"), { code: 1000, reason: "closed" })); }
    welcome(sid) {
      this.readyState = 1; this.protocol = "promptcut.v1"; this.dispatchEvent(new Event("open"));
      this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "session.welcome", sid, resumed: false, ack: 0, retainMs: 60_000, transport: "ws" }) }));
    }
    push(msg) { const ack = Math.max(0, ...this.sent.map((m) => m.seq ?? 0)); queueMicrotask(() => { if (this.readyState === 1) this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ ...msg, seq: ++this.out, ack }) })); }); }
    serverClose(code, reason) { this.readyState = 3; this.dispatchEvent(Object.assign(new Event("close"), { code, reason })); }
    drop() { this.readyState = 3; this.dispatchEvent(Object.assign(new Event("close"), { code: 1006, reason: "" })); }
  }
  let tickets = 0;
  const closes = [];
  let opens = 0;
  let onReopen = () => {};
  const c = new SyncLink({
    url: "wss://isolated.invalid/hosted/", projectId: "room", session: "pg", initialize: false, initial, WebSocketImpl: Socket,
    protocols: () => ["promptcut.v1", `promptcut.account.${String(++tickets).repeat(43).slice(0, 43)}`],
    isFatalClose: () => false, onClosed: (i) => closes.push(i),
    // 与 `enterAccountProject` 相同:第一次建成之后,再建成会话就把跟着连接走的状态重建一遍
    onOpen: () => { if (++opens > 1) onReopen(); },
    reconnect: { minMs: 1, maxMs: 3 },
  });
  const start = async () => {
    c.start();
    await wait(() => sockets.length === 1, "第一条连接");
    sockets[0].welcome("a".repeat(43));
    await wait(() => c.ds.status === "online", "进项目");
  };
  const renew = async (sid = "b".repeat(43)) => {
    const n = sockets.length;
    const done = c.renew();
    await wait(() => sockets.length === n + 1, "新连接");
    return { done, next: sockets[n], welcome: () => sockets[n].welcome(sid) };
  };
  return { c, sockets, closes, start, renew, initial, setReopen: (fn) => { onReopen = fn; }, opens: () => opens };
}

test("LR-01 新会话建成后、等旧会话上的提交落定时被服务端关掉:不切过去,旧会话照常用", async (t) => {
  const r = rig({ hold: [] });
  t.after(() => r.c.stop());
  await r.start();
  // 一条没确认的提交:换会话会等它落定(最多 8 秒)。旧连接不回它的确认
  const old = r.sockets[0];
  const realSend = old.send.bind(old);
  let op = null;
  old.send = (text) => { const m = JSON.parse(text); if (m.type === "project.op") { old.sent.push(m); op = m; return; } realSend(text); };
  r.c.ds.commit({ ...r.c.ds.project, name: "edited" });
  assert.ok(op);
  const { done, next, welcome } = await r.renew();
  welcome();
  await pause(30);
  // 新会话建成了、还没切过去;这时服务端把它关了(例如权限事件把这个账号的连接都关掉)
  next.serverClose(4003, "access-revoked");
  await pause(30);
  old.push({ type: "project.op.ok", projectId: "room", opId: op.opId, rev: 2 });
  assert.equal(await done, false, "按没换成处理");
  await pause(50);
  assert.equal(r.c.connected, true);
  assert.equal(r.c.ds.status, "online", "没有切到已经关掉的会话上(那样 DocSync 会一直等状态)");
  assert.equal(r.c.ds.unconfirmed, 0);
  assert.equal(old.closedByUs, false, "旧会话还在用");
  assert.deepEqual(r.closes, [], "页面没有断线");
  // 之后再换照常
  const again = await r.renew("c".repeat(43));
  again.welcome();
  assert.equal(await again.done, true);
  await wait(() => r.c.ds.status === "online", "换成之后回到在线");
});

test("LR-02 换完之后在新连接上重新发布选区(同一个页面号)、重新取在场;旧会话没有在等的请求就当场关", async (t) => {
  const r = rig();
  t.after(() => { setPresenceLink(null, null, ""); r.c.stop(); });
  await r.start();
  r.setReopen(() => resyncPresenceLink());
  setPresenceLink(r.c, "room", "account:acc@dev", true);
  const sel = ["clip-1"];
  setSelectionLink(r.c, "room", { readSelection: () => sel, subscribe: () => () => {} });
  await wait(() => r.sockets[0].sent.some((m) => m.type === "selection.set" && m.selection.clipIds[0] === "clip-1"), "旧连接上发布了选区");
  const first = r.sockets[0].sent.filter((m) => m.type === "selection.set").at(-1);
  await pause(30);
  const { done, next, welcome } = await r.renew();
  welcome();
  assert.equal(await done, true);
  assert.equal(r.sockets[0].closedByUs, true, "旧会话当场关(不留两条连接各记一份同一个页面的选区)");
  await wait(() => next.sent.some((m) => m.type === "selection.set"), "新连接上重新发布了选区");
  const again = next.sent.find((m) => m.type === "selection.set");
  assert.equal(again.pageId, first.pageId, "还是同一个页面号");
  assert.deepEqual(again.selection, { clipIds: ["clip-1"] });
  assert.ok(again.revision > first.revision, "版本号往上走");
  assert.equal(selectionPresenceStatus().pageId, first.pageId);
  assert.ok(next.sent.some((m) => m.type === "presence.list"), "重新取了一次在场状态");
  assert.equal(r.opens(), 2);
});

test("LR-03 旧会话上有在等回包的请求:留着收完再关,回包照常交给等它的人", async (t) => {
  const r = rig({ hold: ["cost.list"] });
  t.after(() => r.c.stop());
  await r.start();
  const old = r.sockets[0];
  const pending = r.c.request({ type: "cost.list", projectId: "room" }, 5000);
  await wait(() => old.sent.some((m) => m.type === "cost.list"), "请求发出去了");
  const { done, next, welcome } = await r.renew();
  welcome();
  assert.equal(await done, true);
  assert.equal(old.closedByUs, false, "还有回包没收完:旧会话先留着");
  old.push({ type: "cost.listing", reqId: old.sent.find((m) => m.type === "cost.list").reqId, records: [] });
  assert.equal((await pending).type, "cost.listing");
  await wait(() => old.closedByUs, "回包收完,旧会话关掉");
  // 换完之后的请求走新会话
  next.send = ((orig) => (text) => { const m = JSON.parse(text); orig(text); if (m.type === "cost.list") next.push({ type: "cost.listing", reqId: m.reqId, records: [1] }); })(next.send.bind(next));
  assert.deepEqual((await r.c.request({ type: "cost.list", projectId: "room" }, 2000)).records, [1]);
});

test("LR-04 报到过的发布方,换完在新连接上原样再报一次", async (t) => {
  const r = rig();
  t.after(() => r.c.stop());
  await r.start();
  r.c.send({ type: "publisher.hello", publisherId: "page-abc", reqId: "x1" });
  const { done, next, welcome } = await r.renew();
  welcome();
  assert.equal(await done, true);
  const hello = next.sent.filter((m) => m.type === "publisher.hello");
  assert.equal(hello.length, 1);
  assert.equal(hello[0].publisherId, "page-abc");
  assert.equal(hello[0].reqId, undefined, "不带原来那次请求的号");
  // 没报到过的连接不多发
  const plain = rig();
  t.after(() => plain.c.stop());
  await plain.start();
  const second = await plain.renew();
  second.welcome();
  assert.equal(await second.done, true);
  assert.equal(second.next.sent.some((m) => m.type === "publisher.hello"), false);
});

test("LR-05 传输已经脱开(正在接续)时不换:脱开期间的改动要按离线的规矩核对", async (t) => {
  const r = rig();
  t.after(() => r.c.stop());
  await r.start();
  r.sockets[0].drop();
  await pause(1);
  assert.equal(r.c.connected, true, "会话还在(保留期内接续)");
  const before = r.sockets.length;
  assert.equal(await r.c.renew(), false);
  // 只有接续用的那条新传输,没有为换会话另建的
  await pause(20);
  assert.ok(r.sockets.slice(before).every((s) => s.protocols.some((p) => p.startsWith("promptcut.session.") && p !== "promptcut.session.new")), "没有新建会话");
});
