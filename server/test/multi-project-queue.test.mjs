/**
 * Queue ordering in multi-project mode (`server/render-node/multi-queue.mjs`; semantics
 * `product/rendering.md` "Two modes of render service").
 * Run: npm test -- server/test/multi-project-queue.test.mjs (pure logic, no processes spawned)
 *
 *   MPQ1  Frame viewing before stream production: all frame viewing requests are queued ahead of
 *         all stream production requests, even if stream production arrived first
 *   MPQ2  Projects take turns within same category: once a project yields one, it moves to the back;
 *         projects that have not had a turn are ordered by arrival of their leading request
 *   MPQ3  FIFO within the same project
 *   MPQ4  Pick next: if the front request cannot be processed right now, it does not block ones
 *         behind that can; the picked project moves to the back of this category (not holding slot)
 *   MPQ5  Accounting categories for turns: having had a turn in frame viewing does not affect its
 *         position in stream production
 *
 * Each item prints actual dequeue order (`console.log`), referenced in report.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMultiQueue, orderByPolicy, createRotation, MULTI_QUEUE_CLASSES } from '../render-node/multi-queue.mjs';

const fmt = (items) => items.map((x) => `${x.kind}:${x.projectId}#${x.id}`).join(' → ');

test('MPQ1 frame views go before stream production: a stream request that came earlier is also queued behind a frame-view request that came later', () => {
  assert.deepEqual([...MULTI_QUEUE_CLASSES], ['look', 'stream']);
  const q = createMultiQueue();
  q.add({ id: 's1', projectId: 'A', kind: 'stream' });
  q.add({ id: 's2', projectId: 'B', kind: 'stream' });
  q.add({ id: 'l1', projectId: 'C', kind: 'look' });
  q.add({ id: 's3', projectId: 'A', kind: 'stream' });
  q.add({ id: 'l2', projectId: 'A', kind: 'look' });
  const order = q.order();
  console.log('[MPQ1] dequeue order', fmt(order));
  assert.deepEqual(order.map((x) => x.id), ['l1', 'l2', 's1', 's2', 's3']);
});

test('MPQ2 projects take turns within the same class; MPQ3 within the same project, first come first served', () => {
  const q = createMultiQueue();
  // A sends 4 at once, B sends 2, and C sends 1 last
  for (const [id, p] of [['a1', 'A'], ['a2', 'A'], ['a3', 'A'], ['a4', 'A'], ['b1', 'B'], ['b2', 'B'], ['c1', 'C']]) q.add({ id, projectId: p, kind: 'look' });
  const planned = q.order();
  console.log('[MPQ2] planned order', fmt(planned));
  assert.deepEqual(planned.map((x) => x.id), ['a1', 'b1', 'c1', 'a2', 'b2', 'a3', 'a4'], 'A came first, but after one item it is B\'s and C\'s turn; within the same project, by order of arrival');
  // Popped one by one, actual dequeue order matches the queued order
  const taken = [];
  for (let x = q.take(); x; x = q.take()) taken.push(x);
  console.log('[MPQ2] actual dequeue order', fmt(taken));
  assert.deepEqual(taken.map((x) => x.id), planned.map((x) => x.id));
});

test('MPQ2 a later project need not wait for an earlier project to finish: A is being dequeued one by one, B arrives midway, and the next turn goes to B', () => {
  const q = createMultiQueue();
  for (const id of ['a1', 'a2', 'a3']) q.add({ id, projectId: 'A', kind: 'stream' });
  const out = [q.take()];
  q.add({ id: 'b1', projectId: 'B', kind: 'stream' });
  for (let x = q.take(); x; x = q.take()) out.push(x);
  console.log('[MPQ2b] actual dequeue order', fmt(out));
  assert.deepEqual(out.map((x) => x.id), ['a1', 'b1', 'a2', 'a3']);
});

test('MPQ4 taking the next one: an item that cannot be done does not block those behind it; the project just taken goes to the end', () => {
  const q = createMultiQueue();
  for (const [id, p] of [['a1', 'A'], ['b1', 'B'], ['a2', 'A'], ['c1', 'C']]) q.add({ id, projectId: p, kind: 'look' });
  // B cannot be processed right now (e.g. its environment is still installing): A leaves first, then C;
  // B remains
  const first = q.take((x) => x.projectId !== 'B');
  const second = q.take((x) => x.projectId !== 'B');
  console.log('[MPQ4] when B cannot be done', fmt([first, second]), '| remaining', fmt(q.order()));
  assert.deepEqual([first.id, second.id], ['a1', 'c1']);
  // Now B can be processed: it has waited longest for a turn, so it ranks first
  assert.deepEqual(q.order().map((x) => x.id), ['b1', 'a2']);
  assert.equal(q.take().id, 'b1');
  assert.equal(q.take().id, 'a2');
  assert.equal(q.take(), null);
});

test('MPQ5 turn-taking is accounted for separately per class; the pure function does not mutate its input', () => {
  const rotation = createRotation();
  rotation.served('look', 'A'); // A just had a turn in the frame viewing category
  const items = [
    { id: 's-a', projectId: 'A', kind: 'stream', seq: 1 },
    { id: 's-b', projectId: 'B', kind: 'stream', seq: 2 },
    { id: 'l-a', projectId: 'A', kind: 'look', seq: 3 },
    { id: 'l-b', projectId: 'B', kind: 'look', seq: 4 },
  ];
  const copy = structuredClone(items);
  const order = orderByPolicy(items, rotation);
  console.log('[MPQ5] dequeue order', fmt(order));
  // Frame viewing: A just had a turn, so B goes first; stream production: neither had a turn, so A
  // goes first by arrival order
  assert.deepEqual(order.map((x) => x.id), ['l-b', 'l-a', 's-a', 's-b']);
  assert.deepEqual(items, copy);
  rotation.forget('A');
  assert.deepEqual(orderByPolicy(items, rotation).map((x) => x.id), ['l-a', 'l-b', 's-a', 's-b'], 'after forgetting A\'s accounting, by order of arrival');
});
