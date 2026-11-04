/**
 * node --test src/ai/chatQueue.test.mjs
 *
 * Input queue: when the Agent is running, subsequent words submitted by the user are queued first
 * and sent in order after a round finishes.
 * Pins down four things: enqueue order, deleting an item in the middle, shift to take the head of
 * the queue, and queues on different tabs not affecting each other;
 * plus "pause" holds only when the queue is non-empty, and automatically clears when emptied.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const q = await import("./chatQueue.ts");

const item = (id, text = id) => ({ id, text, createdAt: 0 });

test("Pure function: enqueueing preserves order and does not change the original state", () => {
  const s0 = q.EMPTY_QUEUE;
  const s1 = q.withEnqueued(s0, item("a"));
  const s2 = q.withEnqueued(s1, item("b"));
  const s3 = q.withEnqueued(s2, item("c"));
  assert.deepEqual(s3.items.map((x) => x.id), ["a", "b", "c"]);
  assert.equal(s0.items.length, 0, "The original state is untouched");
  assert.equal(s1.items.length, 1);
});

test("Pure function: removing a middle item keeps the order intact; removing a nonexistent id returns the state unchanged", () => {
  let s = q.EMPTY_QUEUE;
  for (const id of ["a", "b", "c"]) s = q.withEnqueued(s, item(id));
  const r = q.withRemoved(s, "b");
  assert.deepEqual(r.items.map((x) => x.id), ["a", "c"]);
  assert.equal(q.withRemoved(s, "nope"), s);
});

test("Pure function: shift takes out the head of the queue and the rest keep their order; taking from an empty queue gives undefined", () => {
  let s = q.EMPTY_QUEUE;
  for (const id of ["a", "b"]) s = q.withEnqueued(s, item(id));
  const [head, rest] = q.withShifted(s);
  assert.equal(head.id, "a");
  assert.deepEqual(rest.items.map((x) => x.id), ["b"]);
  const [none, same] = q.withShifted(q.EMPTY_QUEUE);
  assert.equal(none, undefined);
  assert.equal(same, q.EMPTY_QUEUE);
});

test("Pure function: update changes only that one item; pausing holds only when the queue is non-empty, and emptying it clears the pause automatically", () => {
  let s = q.withEnqueued(q.withEnqueued(q.EMPTY_QUEUE, item("a")), item("b"));
  s = q.withUpdated(s, "b", { text: "Changed" });
  assert.deepEqual(s.items.map((x) => x.text), ["a", "Changed"]);
  assert.equal(q.withPaused(q.EMPTY_QUEUE, true).paused, false, "An empty queue cannot be paused");
  s = q.withPaused(s, true);
  assert.equal(s.paused, true);
  s = q.withRemoved(s, "a");
  assert.equal(s.paused, true, "One item remains, so the pause is kept");
  s = q.withRemoved(s, "b");
  assert.equal(s.paused, false, "Emptying the queue clears the pause automatically");
});

test("store: enqueue / getQueue / remove / shift / clear, stored per tab", () => {
  q._resetQueues();
  const a = q.enqueue("main", { text: "One" });
  const b = q.enqueue("main", { text: "Two", attachments: [{ id: "f", name: "x.mp4", kind: "video", url: "" }] });
  const c = q.enqueue("main", { text: "three" });
  assert.deepEqual(q.getQueue("main").map((x) => x.text), ["One", "Two", "three"]);
  assert.equal(q.getQueue("main")[1].attachments.length, 1);
  assert.equal(q.getQueue("main")[0].attachments, undefined, "Without attachments the field is omitted");
  assert.notEqual(a.id, b.id);

  assert.equal(q.remove("main", b.id).text, "Two");
  assert.deepEqual(q.getQueue("main").map((x) => x.id), [a.id, c.id]);
  assert.equal(q.shift("main").id, a.id);
  assert.deepEqual(q.getQueue("main").map((x) => x.id), [c.id]);
  q.clear("main");
  assert.deepEqual(q.getQueue("main"), []);
});

test("store: queues of different tabs do not affect each other, and each tab manages its own pause", () => {
  q._resetQueues();
  q.enqueue("main", { text: "Main tab's" });
  q.enqueue("t2", { text: "Second tab's" });
  q.setPaused("t2", true);
  assert.deepEqual(q.getQueue("main").map((x) => x.text), ["Main tab's"]);
  assert.deepEqual(q.getQueue("t2").map((x) => x.text), ["Second tab's"]);
  assert.equal(q.isPaused("main"), false);
  assert.equal(q.isPaused("t2"), true);
  q.shift("main");
  assert.equal(q.getQueue("main").length, 0);
  assert.equal(q.getQueue("t2").length, 1, "Other tabs are not affected");
  q.clear("t2");
  assert.equal(q.isPaused("t2"), false);
});

test("store: notifies only on real changes; snapshot references are stable (for useSyncExternalStore)", () => {
  q._resetQueues();
  let calls = 0;
  const off = q.subscribe(() => { calls++; });
  const before = q.getQueueState("main");
  assert.equal(q.getQueueState("main"), before, "The same reference when unchanged");
  q.remove("main", "nope");
  q.setPaused("main", true); // Pausing an empty queue does not hold and does not count as a change
  assert.equal(calls, 0);
  const it = q.enqueue("main", { text: "x" });
  assert.equal(calls, 1);
  q.update("main", it.id, { text: "y" });
  assert.equal(calls, 2);
  assert.equal(q.getQueue("main")[0].text, "y");
  off();
  q.clear("main");
  assert.equal(calls, 2, "No more notifications after unsubscribing");
});
