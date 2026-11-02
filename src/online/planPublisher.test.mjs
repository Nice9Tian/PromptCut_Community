/**
 * 在线页面发布清单计划(C10 契约第 7 节、第 18 节第 9 条):形状与队列侧逐字段相同、队列的入站校验收它;
 * 测量落定后才发、防抖、改了重发、同一版不重发;requires 不带 envFingerprint / preferNode,codeVersion 给了才写;
 * 没人认领、发不出去都不抛。
 * 跑:node --test src/online/planPublisher.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPlanPublisher, clipsPlanTask, clipsSig, CLIPS_KEY_MARK, PLAN_DEBOUNCE_MS, BROWSER_NODE_WAIT_MS, LIST_STREAMS_SIG } from "./planPublisher.ts";
import { clipsPlanTaskOf, backfillSig, CLIPS_KEY_MARK as SERVER_MARK, parseInbound, LIST_STREAMS_SIG as SERVER_STREAMS_SIG } from "../../server/render-queue/messages.mjs";

test("C10-PP-01 the shape is identical field by field to the queue-side clipsPlanTaskOf; inbound validation accepts it", () => {
  const clips = ["c3", "c1", "c2", "c1"];
  for (const codeVersion of [undefined, "cv-123"]) {
    const page = clipsPlanTask({ projectId: "proj-1", projectRev: 7, clips, codeVersion });
    const server = clipsPlanTaskOf({ projectId: "proj-1", projectRev: 7, clips, codeVersion });
    assert.deepEqual(page, server);
    assert.equal(parseInbound({ type: "task.publish", tasks: [page] }).ok, true);
  }
  assert.equal(CLIPS_KEY_MARK, SERVER_MARK);
  assert.equal(clipsSig(["b", "a"]), backfillSig(["a", "b", "a"]));
  const t = clipsPlanTask({ projectId: "p", projectRev: 1, clips: ["x"] });
  assert.equal(t.priority, "normal");
  assert.deepEqual(t.requires, {}, "不带 envFingerprint、preferNode");
});

function fakeQueue({ fail = null } = {}) {
  const sent = [];
  const request = async (msg) => {
    sent.push(msg);
    if (fail) throw new Error(fail);
    if (msg.type === "publisher.hello") return { type: "publisher.welcome" };
    if (msg.type === "task.publish") return { type: "task.published", results: msg.tasks.map((t) => ({ id: t.id, created: true, state: "open" })) };
    return { type: "error" };
  };
  return { sent, request };
}

function timers() {
  const q = [];
  return {
    setTimer: (fn, ms) => { const h = { fn, ms }; q.push(h); return h; },
    clearTimer: (h) => { const i = q.indexOf(h); if (i >= 0) q.splice(i, 1); },
    async flush() { while (q.length) { const h = q.shift(); await h.fn(); await new Promise((r) => setTimeout(r, 0)); } },
    pending: () => q.length,
  };
}

test("C10-PP-02 nothing is sent before measurement settles; after it settles, send once with debounce; the same version is not resent; resend when changed (version or manifest)", async () => {
  const qd = fakeQueue();
  const t = timers();
  let clips = ["c2", "c1"];
  const pub = createPlanPublisher({ request: qd.request, publisherId: "page-x", clips: () => clips, codeVersion: "cv", setTimer: t.setTimer, clearTimer: t.clearTimer });
  pub.changed({ projectId: "p1", projectRev: 3 });
  assert.equal(t.pending(), 0, "Measurement not settled: not scheduled");
  pub.measured({ projectId: "p1", projectRev: 3 });
  pub.changed({ projectId: "p1", projectRev: 3 });
  pub.changed({ projectId: "p1", projectRev: 4 });
  assert.equal(t.pending(), 1, "Debounce: only the last one is scheduled");
  await t.flush();
  const pubs = qd.sent.filter((m) => m.type === "task.publish");
  assert.equal(pubs.length, 1);
  assert.equal(qd.sent[0].type, "publisher.hello");
  const task = pubs[0].tasks[0];
  assert.equal(task.kind, "plan");
  assert.equal(task.source.projectRev, 4);
  assert.match(task.resultKey, new RegExp(`^p1@4${CLIPS_KEY_MARK}`));
  assert.deepEqual(task.input.clips, ["c1", "c2"]);
  assert.deepEqual(task.requires, { codeVersion: "cv" });
  assert.equal("envFingerprint" in task.requires || "preferNode" in task.requires, false);
  pub.changed({ projectId: "p1", projectRev: 4 });
  await t.flush();
  assert.equal(qd.sent.filter((m) => m.type === "task.publish").length, 1, "The same version is not resent");
  clips = ["c1"];
  pub.changed({ projectId: "p1", projectRev: 4 });
  await t.flush();
  assert.equal(qd.sent.filter((m) => m.type === "task.publish").length, 2, "Resent when the manifest changes");
  assert.equal(qd.sent.filter((m) => m.type === "publisher.hello").length, 1, "Checks in only once");
  pub.dispose();
});

test("C10-PP-03 neither a failed send nor nobody claiming throws; an empty manifest is not sent; check in again after reset", async () => {
  const bad = fakeQueue({ fail: "Connection lost" });
  const t = timers();
  const pub = createPlanPublisher({ request: bad.request, clips: () => ["a"], setTimer: t.setTimer, clearTimer: t.clearTimer });
  pub.measured({ projectId: "p", projectRev: 1 });
  await t.flush();
  const d = pub.debug();
  assert.equal(d.log.length, 1);
  assert.equal(d.log[0].ok, false);
  const empty = fakeQueue();
  const t2 = timers();
  const pub2 = createPlanPublisher({ request: empty.request, clips: () => [], setTimer: t2.setTimer, clearTimer: t2.clearTimer });
  pub2.measured({ projectId: "p", projectRev: 1 });
  await t2.flush();
  assert.equal(empty.sent.length, 0, "An empty manifest is not sent");
  const q3 = fakeQueue();
  const t3 = timers();
  const pub3 = createPlanPublisher({ request: q3.request, clips: () => ["a"], setTimer: t3.setTimer, clearTimer: t3.clearTimer });
  pub3.measured({ projectId: "p", projectRev: 1 });
  await t3.flush();
  pub3.reset();
  await t3.flush();
  assert.equal(q3.sent.filter((m) => m.type === "publisher.hello").length, 2, "Checks in again after the connection changes");
  assert.equal(q3.sent.filter((m) => m.type === "task.publish").length, 2, "and resends (the queue is in memory only)");
});

test("C10-PP-04 endpoint shape: waits for the reply by reqId, forwards the task.done pushed by the queue to the host", async () => {
  const handlers = [];
  const out = [];
  const endpoint = {
    send(m) {
      out.push(m);
      queueMicrotask(() => {
        const reply = m.type === "publisher.hello" ? { type: "publisher.welcome", reqId: m.reqId }
          : { type: "task.published", reqId: m.reqId, results: m.tasks.map((t) => ({ id: t.id, created: true })) };
        for (const h of handlers) h(reply);
      });
      return true;
    },
    onMessage(h) { handlers.push(h); },
  };
  const events = [];
  const t = timers();
  const pub = createPlanPublisher({ endpoint, clips: () => ["z"], onTaskEvent: (m) => events.push(m.type), setTimer: t.setTimer, clearTimer: t.clearTimer });
  pub.measured({ projectId: "p", projectRev: 2 });
  await t.flush();
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(out.map((m) => m.type), ["publisher.hello", "task.publish"]);
  assert.equal(pub.debug().log[0].ok, true);
  for (const h of handlers) h({ type: "task.done", id: "plan:x" });
  assert.deepEqual(events, ["task.done"]);
});

/** 带虚拟时钟的计时器:`runFor(ms)` 按到期先后跑,时钟跟着走 */
function clockTimers() {
  let t = 0;
  let q = [];
  return {
    now: () => t,
    setTimer: (fn, ms) => { const h = { fn, at: t + ms }; q.push(h); return h; },
    clearTimer: (h) => { q = q.filter((x) => x !== h); },
    async runFor(ms) {
      const end = t + ms;
      for (;;) {
        q.sort((a, b) => a.at - b.at);
        const h = q[0];
        if (!h || h.at > end) break;
        q.shift();
        t = h.at;
        await h.fn();
        for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
      }
      t = end;
    },
  };
}

test("M7-PP-05 this page acts as a pure browser node: the manifest plan waits until the node finishes checking in (fingerprint obtained) before sending; sends right after check-in; hands over this version before sending (D6 retention)", async () => {
  const qd = fakeQueue();
  const c = clockTimers();
  let node = "pending";
  const kept = [];
  const pub = createPlanPublisher({ request: qd.request, clips: () => ["a"], codeVersion: "cv", setTimer: c.setTimer, clearTimer: c.clearTimer, now: c.now,
    nodeReady: () => node, onPublish: (v) => kept.push(v) });
  pub.measured({ projectId: "p", projectRev: 5 });
  await c.runFor(PLAN_DEBOUNCE_MS + 1000);
  assert.equal(qd.sent.filter((m) => m.type === "task.publish").length, 0, "Node still checking in: not sent");
  assert.ok(pub.debug().nodeWaitMs >= 1000, JSON.stringify(pub.debug()));
  node = "ready";
  pub.nodeChanged();
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  const pubs = qd.sent.filter((m) => m.type === "task.publish");
  assert.equal(pubs.length, 1, "Sends right after check-in, without waiting for the next round");
  assert.deepEqual(kept, [{ projectId: "p", projectRev: 5 }]);
  const log = pub.debug().log.at(-1);
  assert.equal(log.ok, true);
  assert.equal(log.node, "ready");
  assert.ok(log.waitedMs >= 1000 && log.waitedMs < BROWSER_NODE_WAIT_MS, JSON.stringify(log));
  assert.deepEqual(pubs[0].tasks[0].input, { clips: ["a"] }, "The plan does not record browser intent (what the page self-reports does not count)");
  pub.dispose();
});

test("M7-PP-06 node never finishes checking in: waits at most 3 s, sends anyway on timeout; no wait when this page is not a node", async () => {
  const qd = fakeQueue();
  const c = clockTimers();
  const pub = createPlanPublisher({ request: qd.request, clips: () => ["a"], setTimer: c.setTimer, clearTimer: c.clearTimer, now: c.now, nodeReady: () => "pending" });
  pub.measured({ projectId: "p", projectRev: 1 });
  await c.runFor(PLAN_DEBOUNCE_MS + BROWSER_NODE_WAIT_MS - 100);
  assert.equal(qd.sent.filter((m) => m.type === "task.publish").length, 0, "Not sent within 3 s");
  await c.runFor(200);
  assert.equal(qd.sent.filter((m) => m.type === "task.publish").length, 1, "Sent anyway at 3 s");
  assert.equal(pub.debug().log.at(-1).waitedMs, BROWSER_NODE_WAIT_MS);
  assert.equal(pub.debug().nodeWaitMs, null);
  // 下一版:节点还是没报到完,重新等(每一版各等一次)
  pub.changed({ projectId: "p", projectRev: 2 });
  await c.runFor(PLAN_DEBOUNCE_MS + 100);
  assert.equal(qd.sent.filter((m) => m.type === "task.publish").length, 1);
  await c.runFor(BROWSER_NODE_WAIT_MS);
  assert.equal(qd.sent.filter((m) => m.type === "task.publish").length, 2);
  pub.dispose();

  const q2 = fakeQueue();
  const c2 = clockTimers();
  const none = createPlanPublisher({ request: q2.request, clips: () => ["a"], setTimer: c2.setTimer, clearTimer: c2.clearTimer, now: c2.now, nodeReady: () => "none" });
  none.measured({ projectId: "p", projectRev: 1 });
  await c2.runFor(PLAN_DEBOUNCE_MS);
  assert.equal(q2.sent.filter((m) => m.type === "task.publish").length, 1, "Not a node: sends as soon as the debounce elapses");
  assert.equal(none.debug().log.at(-1).waitedMs, undefined);
  none.dispose();
});

/* ---------------- 托管方渲染节点的「生成轨道流」(任务书 `docs/plan/render-refactor-task.md`「甲三」):打开后当场生效 ---------------- */

const PAGE_CARDS = { cardEnvFingerprint: "0123456789abcdef", userCards: true, graphCards: false, cardSources: { "user:a": "v1" } };

test("C10-PP-ST-01 this option is off (or not given): result key and input are identical to when there is no such parameter, so the manifest plan of a project that has always had it off is not re-split by this change", () => {
  const clips = ["c3", "c1", "c2"];
  for (const browser of [undefined, PAGE_CARDS]) {
    const plain = clipsPlanTask({ projectId: "sp_x", projectRev: 7, clips, codeVersion: "cv", browser });
    for (const streams of [false, undefined, null, 0, "true"]) {
      assert.deepEqual(clipsPlanTask({ projectId: "sp_x", projectRev: 7, clips, codeVersion: "cv", browser, streams }), plain);
      assert.deepEqual(clipsPlanTaskOf({ projectId: "sp_x", projectRev: 7, clips, codeVersion: "cv", browser, streams }), plain);
    }
    assert.equal("streams" in plain.input, false);
  }
  // 钉住原来的写法:没有附加内容时签名就是清单本身的签名(改动之前的公式)
  assert.equal(clipsPlanTask({ projectId: "sp_x", projectRev: 7, clips }).resultKey, `sp_x@7${CLIPS_KEY_MARK}${backfillSig(["c1", "c2", "c3"])}`);
  assert.equal(clipsPlanTask({ projectId: "sp_x", projectRev: 7, clips }).id, "plan:sp_x@7#clips:" + backfillSig(["c1", "c2", "c3"]));
});

test("C10-PP-ST-02 this option is on: it is a different plan (different result key, input.streams is true); the page and the queue side are identical field by field; inbound validation accepts it, only the boolean true is recognized", () => {
  const clips = ["c2", "c1"];
  assert.equal(LIST_STREAMS_SIG, SERVER_STREAMS_SIG);
  for (const browser of [undefined, PAGE_CARDS]) {
    const off = clipsPlanTask({ projectId: "sp_x", projectRev: 7, clips, codeVersion: "cv", browser });
    const on = clipsPlanTask({ projectId: "sp_x", projectRev: 7, clips, codeVersion: "cv", browser, streams: true });
    assert.deepEqual(on, clipsPlanTaskOf({ projectId: "sp_x", projectRev: 7, clips, codeVersion: "cv", browser, streams: true }));
    assert.notEqual(on.resultKey, off.resultKey);
    assert.notEqual(on.id, off.id);
    assert.equal(on.input.streams, true);
    assert.deepEqual({ ...on.input, streams: undefined }, { ...off.input, streams: undefined }, "other inputs unchanged");
    assert.deepEqual([on.requires, on.priority, on.source], [off.requires, off.priority, off.source]);
    // 新旧文档服务都只看签名的字符集(1～32 位小写字母与数字)与任务 id 的形状:带这一项的键照样合格
    assert.match(on.resultKey.slice(`sp_x@7${CLIPS_KEY_MARK}`.length), /^[0-9a-z]{1,32}$/);
    const parsed = parseInbound({ type: "task.publish", tasks: [on] });
    assert.equal(parsed.ok, true);
    assert.equal(parsed.body.tasks[0].input.streams, true);
  }
  // 入站:`input.streams` 不是布尔 true 的去掉(任务照收)
  const off = clipsPlanTask({ projectId: "sp_x", projectRev: 7, clips });
  for (const bad of [false, 1, "true", {}, null]) {
    const parsed = parseInbound({ type: "task.publish", tasks: [{ ...off, input: { ...off.input, streams: bad } }] });
    assert.equal(parsed.ok, true);
    assert.equal("streams" in parsed.body.tasks[0].input, false);
  }
  // 旧页面(不带这一项)连新文档服务:照旧收,形状不变
  const legacy = parseInbound({ type: "task.publish", tasks: [off] });
  assert.equal(legacy.ok, true);
  assert.deepEqual(legacy.body.tasks[0].input, { clips: ["c1", "c2"] });
});

test("C10-PP-ST-03 publish: when this item is seen on while on this page, the plan includes it; switching from off to on republishes immediately (no debounce, same project version, different task); calling again does not republish; when off, identical to before, verbatim", async () => {
  const qd = fakeQueue();
  const t = timers();
  let on = false;
  const pub = createPlanPublisher({ request: qd.request, publisherId: "page-x", clips: () => ["c1"], codeVersion: "cv", streams: () => on, setTimer: t.setTimer, clearTimer: t.clearTimer });
  const published = () => qd.sent.filter((m) => m.type === "task.publish").map((m) => m.tasks[0]);
  pub.streamsOn();
  assert.equal(published().length, 0, "measurement not settled: do not publish");
  pub.measured({ projectId: "sp_x", projectRev: 3 });
  await t.flush();
  assert.equal(published().length, 1);
  assert.deepEqual(published()[0], clipsPlanTaskOf({ projectId: "sp_x", projectRev: 3, clips: ["c1"], codeVersion: "cv" }), "off: verbatim identical to when this feature did not exist");
  // 关着时宿主误调:任务 id 没变,不重发
  pub.streamsOn();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(published().length, 1);
  // 创建者打开:宿主调 streamsOn,不等防抖就发
  on = true;
  pub.streamsOn();
  assert.equal(t.pending(), 0, "no debounce queued");
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(published().length, 2, "republished immediately");
  assert.deepEqual(published()[1], clipsPlanTaskOf({ projectId: "sp_x", projectRev: 3, clips: ["c1"], codeVersion: "cv", streams: true }));
  assert.equal(published()[1].source.projectRev, 3, "same project version");
  assert.notEqual(published()[1].id, published()[0].id);
  pub.streamsOn();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(published().length, 2, "this one was already published: do not republish");
  // 开着时项目改了:新一版照样带这一项
  pub.changed({ projectId: "sp_x", projectRev: 4 });
  await t.flush();
  assert.equal(published().length, 3);
  assert.equal(published()[2].input.streams, true);
  assert.equal(qd.sent.filter((m) => m.type === "publisher.hello").length, 1);
  pub.dispose();
  pub.streamsOn();
  assert.equal(published().length, 3, "no publish after destroy");
});

test("C10-PP-ST-04 several members online at once: each republishes the same task id (same version, same manifest), the queue keeps only one, with only one extra split; an error reading this item is treated as off", async () => {
  const mk = (streams) => {
    const qd = fakeQueue();
    const t = timers();
    const pub = createPlanPublisher({ request: qd.request, publisherId: `page-${Math.random()}`, clips: () => ["c2", "c1"], codeVersion: "cv", streams, setTimer: t.setTimer, clearTimer: t.clearTimer });
    return { qd, t, pub, ids: () => qd.sent.filter((m) => m.type === "task.publish").map((m) => m.tasks[0].id) };
  };
  let on = false;
  const a = mk(() => on), b = mk(() => on);
  for (const x of [a, b]) { x.pub.measured({ projectId: "sp_x", projectRev: 9 }); await x.t.flush(); }
  on = true;
  for (const x of [a, b]) { x.pub.streamsOn(); await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); }
  assert.deepEqual(a.ids(), b.ids(), "task ids published by the two members are identical one by one");
  assert.equal(new Set([...a.ids(), ...b.ids()]).size, 2, "only two distinct tasks in total: the one when off and the one after turning on");
  const broken = mk(() => { throw new Error("x"); });
  broken.pub.measured({ projectId: "sp_x", projectRev: 9 });
  await broken.t.flush();
  assert.deepEqual(broken.ids(), [a.ids()[0]], "cannot read this item: publish as off");
  for (const x of [a, b, broken]) x.pub.dispose();
});

test("C10-PP-PS-01 the two things this page needs to produce a stream: current() gives the most recently published version; probe() republishes the same task and reads the status from the returned packet", async () => {
  const sent = [];
  let state = "open";
  const request = async (msg) => {
    sent.push(msg);
    if (msg.type === "publisher.hello") return { type: "publisher.welcome" };
    if (msg.type === "task.publish") return { type: "task.published", results: msg.tasks.map((t) => ({ id: t.id, created: sent.filter((m) => m.type === "task.publish").length === 1, state })) };
    return { type: "error" };
  };
  const t = timers();
  let now = 5000;
  const pub = createPlanPublisher({ request, publisherId: "page-ps", clips: () => ["c2", "c1"], codeVersion: "cv", setTimer: t.setTimer, clearTimer: t.clearTimer, now: () => now });
  assert.equal(pub.current(), null, "not published yet");
  assert.equal(await pub.probe(), null, "never published: cannot query");
  pub.measured({ projectId: "p1", projectRev: 3 });
  await t.flush();
  const cur = pub.current();
  assert.deepEqual({ ...cur, id: undefined }, { id: undefined, projectId: "p1", projectRev: 3, clips: ["c1", "c2"], at: 5000 });
  assert.match(cur.id, /^plan:p1@3#clips:/);
  now = 9000;
  assert.equal(await pub.probe(), "open");
  state = "claimed";
  assert.equal(await pub.probe(), "claimed");
  state = "done";
  assert.equal(await pub.probe(), "done");
  const pubs = sent.filter((m) => m.type === "task.publish");
  assert.equal(pubs.length, 4);
  assert.deepEqual(pubs.map((m) => m.tasks[0].id), Array(4).fill(cur.id), "status queries publish the same task (the queue only merges, never starts a new one)");
  assert.equal(pub.current().at, 5000, "publish time does not change with status queries");
  // 连接换了:队列可能重启过,上一版不算数,等重新发成
  pub.reset();
  assert.equal(pub.current(), null);
  assert.equal(await pub.probe(), null);
  await t.flush();
  assert.equal(pub.current()?.id, cur.id);
  pub.dispose();
  assert.equal(await pub.probe(), null, "no query after destroy");
});
