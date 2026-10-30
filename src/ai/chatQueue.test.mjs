/**
 * node --test src/ai/chatQueue.test.mjs
 *
 * 输入队列:Agent 跑着的时候用户又交的话先排队,一轮结束按顺序发。
 * 钉住四件事:入队顺序、删中间一条、shift 取队首、不同分页的队列互不影响;
 * 外加「暂停」只在队列非空时成立,清空自动解除。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const q = await import("./chatQueue.ts");

const item = (id, text = id) => ({ id, text, createdAt: 0 });

test("纯函数:入队保持先后顺序,不改原状态", () => {
  const s0 = q.EMPTY_QUEUE;
  const s1 = q.withEnqueued(s0, item("a"));
  const s2 = q.withEnqueued(s1, item("b"));
  const s3 = q.withEnqueued(s2, item("c"));
  assert.deepEqual(s3.items.map((x) => x.id), ["a", "b", "c"]);
  assert.equal(s0.items.length, 0, "原状态不动");
  assert.equal(s1.items.length, 1);
});

test("纯函数:删掉中间一条,前后顺序不乱;删不存在的 id 原样返回", () => {
  let s = q.EMPTY_QUEUE;
  for (const id of ["a", "b", "c"]) s = q.withEnqueued(s, item(id));
  const r = q.withRemoved(s, "b");
  assert.deepEqual(r.items.map((x) => x.id), ["a", "c"]);
  assert.equal(q.withRemoved(s, "nope"), s);
});

test("纯函数:shift 取出队首,剩下的保持顺序;空队列取出 undefined", () => {
  let s = q.EMPTY_QUEUE;
  for (const id of ["a", "b"]) s = q.withEnqueued(s, item(id));
  const [head, rest] = q.withShifted(s);
  assert.equal(head.id, "a");
  assert.deepEqual(rest.items.map((x) => x.id), ["b"]);
  const [none, same] = q.withShifted(q.EMPTY_QUEUE);
  assert.equal(none, undefined);
  assert.equal(same, q.EMPTY_QUEUE);
});

test("纯函数:update 只改那一条;暂停只在非空时成立,删空自动解除", () => {
  let s = q.withEnqueued(q.withEnqueued(q.EMPTY_QUEUE, item("a")), item("b"));
  s = q.withUpdated(s, "b", { text: "改过" });
  assert.deepEqual(s.items.map((x) => x.text), ["a", "改过"]);
  assert.equal(q.withPaused(q.EMPTY_QUEUE, true).paused, false, "空队列不能暂停");
  s = q.withPaused(s, true);
  assert.equal(s.paused, true);
  s = q.withRemoved(s, "a");
  assert.equal(s.paused, true, "还剩一条,暂停保留");
  s = q.withRemoved(s, "b");
  assert.equal(s.paused, false, "删空了自动解除");
});

test("store:enqueue / getQueue / remove / shift / clear,按分页存", () => {
  q._resetQueues();
  const a = q.enqueue("main", { text: "一" });
  const b = q.enqueue("main", { text: "二", attachments: [{ id: "f", name: "x.mp4", kind: "video", url: "" }] });
  const c = q.enqueue("main", { text: "三" });
  assert.deepEqual(q.getQueue("main").map((x) => x.text), ["一", "二", "三"]);
  assert.equal(q.getQueue("main")[1].attachments.length, 1);
  assert.equal(q.getQueue("main")[0].attachments, undefined, "没附件就不带这个字段");
  assert.notEqual(a.id, b.id);

  assert.equal(q.remove("main", b.id).text, "二");
  assert.deepEqual(q.getQueue("main").map((x) => x.id), [a.id, c.id]);
  assert.equal(q.shift("main").id, a.id);
  assert.deepEqual(q.getQueue("main").map((x) => x.id), [c.id]);
  q.clear("main");
  assert.deepEqual(q.getQueue("main"), []);
});

test("store:不同分页的队列互不影响,暂停也各管各的", () => {
  q._resetQueues();
  q.enqueue("main", { text: "主页的" });
  q.enqueue("t2", { text: "第二页的" });
  q.setPaused("t2", true);
  assert.deepEqual(q.getQueue("main").map((x) => x.text), ["主页的"]);
  assert.deepEqual(q.getQueue("t2").map((x) => x.text), ["第二页的"]);
  assert.equal(q.isPaused("main"), false);
  assert.equal(q.isPaused("t2"), true);
  q.shift("main");
  assert.equal(q.getQueue("main").length, 0);
  assert.equal(q.getQueue("t2").length, 1, "别的页没被牵连");
  q.clear("t2");
  assert.equal(q.isPaused("t2"), false);
});

test("store:只有真的变了才通知;快照引用稳定(给 useSyncExternalStore 用)", () => {
  q._resetQueues();
  let calls = 0;
  const off = q.subscribe(() => { calls++; });
  const before = q.getQueueState("main");
  assert.equal(q.getQueueState("main"), before, "没变时同一个引用");
  q.remove("main", "nope");
  q.setPaused("main", true); // 空队列暂停不成立,不算变化
  assert.equal(calls, 0);
  const it = q.enqueue("main", { text: "x" });
  assert.equal(calls, 1);
  q.update("main", it.id, { text: "y" });
  assert.equal(calls, 2);
  assert.equal(q.getQueue("main")[0].text, "y");
  off();
  q.clear("main");
  assert.equal(calls, 2, "退订之后不再通知");
});
