/**
 * 多项目模式的队列次序（`server/render-node/multi-queue.mjs`；语义 `product/rendering.md`「渲染服务的两种模式」）。
 * 跑：npm test -- server/test/multi-project-queue.test.mjs（纯逻辑，不起进程）
 *
 *   MPQ1  看画面先于产流：所有看画面的请求排在所有产流请求前面，哪怕产流的先来
 *   MPQ2  同一类里各项目轮流：一个项目出一个就排到最后；没轮到过的按排头请求来的先后
 *   MPQ3  同一项目内先来先做
 *   MPQ4  取下一个：排在前面的此刻做不了时不挡后面做得了的；取走的那个项目排到这一类最后（不占着）
 *   MPQ5  轮流的记账分类：看画面那一类轮到过，不影响它在产流那一类的位置
 *
 * 每条都把实际的出队次序打出来（`console.log`），报告里引用。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMultiQueue, orderByPolicy, createRotation, MULTI_QUEUE_CLASSES } from '../render-node/multi-queue.mjs';

const fmt = (items) => items.map((x) => `${x.kind}:${x.projectId}#${x.id}`).join(' → ');

test('MPQ1 看画面先于产流：先来的产流请求也排在后来的看画面请求后面', () => {
  assert.deepEqual([...MULTI_QUEUE_CLASSES], ['look', 'stream']);
  const q = createMultiQueue();
  q.add({ id: 's1', projectId: 'A', kind: 'stream' });
  q.add({ id: 's2', projectId: 'B', kind: 'stream' });
  q.add({ id: 'l1', projectId: 'C', kind: 'look' });
  q.add({ id: 's3', projectId: 'A', kind: 'stream' });
  q.add({ id: 'l2', projectId: 'A', kind: 'look' });
  const order = q.order();
  console.log('[MPQ1] 出队次序', fmt(order));
  assert.deepEqual(order.map((x) => x.id), ['l1', 'l2', 's1', 's2', 's3']);
});

test('MPQ2 同一类里各项目轮流；MPQ3 同一项目内先来先做', () => {
  const q = createMultiQueue();
  // A 一口气来了 4 个，B 来了 2 个，C 最后来 1 个
  for (const [id, p] of [['a1', 'A'], ['a2', 'A'], ['a3', 'A'], ['a4', 'A'], ['b1', 'B'], ['b2', 'B'], ['c1', 'C']]) q.add({ id, projectId: p, kind: 'look' });
  const planned = q.order();
  console.log('[MPQ2] 排出来的次序', fmt(planned));
  assert.deepEqual(planned.map((x) => x.id), ['a1', 'b1', 'c1', 'a2', 'b2', 'a3', 'a4'], 'A 先来，但出一个就轮到 B、C；同一项目内按来的先后');
  // 逐个取走，实际出队的次序与排出来的一致
  const taken = [];
  for (let x = q.take(); x; x = q.take()) taken.push(x);
  console.log('[MPQ2] 实际出队次序', fmt(taken));
  assert.deepEqual(taken.map((x) => x.id), planned.map((x) => x.id));
});

test('MPQ2 后来的项目不必等先来的项目做完：A 正在一个个出，B 中途来了，下一个就轮到 B', () => {
  const q = createMultiQueue();
  for (const id of ['a1', 'a2', 'a3']) q.add({ id, projectId: 'A', kind: 'stream' });
  const out = [q.take()];
  q.add({ id: 'b1', projectId: 'B', kind: 'stream' });
  for (let x = q.take(); x; x = q.take()) out.push(x);
  console.log('[MPQ2b] 实际出队次序', fmt(out));
  assert.deepEqual(out.map((x) => x.id), ['a1', 'b1', 'a2', 'a3']);
});

test('MPQ4 取下一个：做不了的不挡后面；取走的项目排到最后', () => {
  const q = createMultiQueue();
  for (const [id, p] of [['a1', 'A'], ['b1', 'B'], ['a2', 'A'], ['c1', 'C']]) q.add({ id, projectId: p, kind: 'look' });
  // B 此刻做不了（例如它的环境还在装）：先出 A，再出 C；B 留着
  const first = q.take((x) => x.projectId !== 'B');
  const second = q.take((x) => x.projectId !== 'B');
  console.log('[MPQ4] B 做不了时', fmt([first, second]), '｜剩下', fmt(q.order()));
  assert.deepEqual([first.id, second.id], ['a1', 'c1']);
  // 现在 B 做得了：它最久没轮到，排第一
  assert.deepEqual(q.order().map((x) => x.id), ['b1', 'a2']);
  assert.equal(q.take().id, 'b1');
  assert.equal(q.take().id, 'a2');
  assert.equal(q.take(), null);
});

test('MPQ5 轮流按类分开记账；纯函数不改入参', () => {
  const rotation = createRotation();
  rotation.served('look', 'A'); // A 刚在看画面那一类出过
  const items = [
    { id: 's-a', projectId: 'A', kind: 'stream', seq: 1 },
    { id: 's-b', projectId: 'B', kind: 'stream', seq: 2 },
    { id: 'l-a', projectId: 'A', kind: 'look', seq: 3 },
    { id: 'l-b', projectId: 'B', kind: 'look', seq: 4 },
  ];
  const copy = structuredClone(items);
  const order = orderByPolicy(items, rotation);
  console.log('[MPQ5] 出队次序', fmt(order));
  // 看画面：A 刚轮到过，B 先；产流：两边都没轮到过，按来的先后 A 先
  assert.deepEqual(order.map((x) => x.id), ['l-b', 'l-a', 's-a', 's-b']);
  assert.deepEqual(items, copy);
  rotation.forget('A');
  assert.deepEqual(orderByPolicy(items, rotation).map((x) => x.id), ['l-a', 'l-b', 's-a', 's-b'], '忘掉 A 的记账后按来的先后');
});
