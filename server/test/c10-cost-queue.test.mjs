/**
 * 队列优先级的补充单测(C10 其余第 3 节只核对:c10a 已在 `19c2d19` 做了优先级档,单测 C10A-L17-Q1～Q6)。
 * 这里补 Q1～Q6 没覆盖的几条(编号 CQ-01～CQ-03):
 *
 *   CQ-01 已被认领的 backfill 任务遇到 normal 发布:优先级升为 normal(不重发 task.opened,不打断认领者);
 *         租约过期回到 open 时按 normal 重新开放,排在别的 backfill 前面
 *   CQ-02 已完成的 backfill 任务遇到 normal 发布:不另起任务,发布方收到 task.done
 *   CQ-03 normal 档内整数名次高的先认;字符串 'normal' 与缺省都算名次 0;backfill 永远在所有 normal 之后
 *
 * 跑:node --test server/test/c10-cost-queue.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderQueue, priorityBand } from '../render-queue/index.mjs';
import { rankCandidates } from '../render-node/pick.mjs';

const FP = '0123456789abcdef';
const CV = 'c0de5a';

function fineTask(resultKey, priority) {
  const t = {
    id: `snapshot:${resultKey}:0-59`, kind: 'snapshot', tier: 'shared', resultKey, range: { unit: 'localFrame', from: 0, to: 59 },
    source: { projectId: 'p1', projectRev: 1 }, input: { clipId: `clip-${resultKey}`, contentKey: `ck-${resultKey}` },
    weight: { class: 'heavy', estMs: null, frames: 60 }, requires: {},
  };
  if (priority !== undefined) t.priority = priority;
  return t;
}

function rig() {
  let now = 1_000;
  const inbox = new Map();
  const q = createRenderQueue({ now: () => now, send: (connId, msg) => { if (!inbox.has(connId)) inbox.set(connId, []); inbox.get(connId).push(msg); }, epoch: 'e1' });
  q.connect('pub', { userId: 'member' });
  q.handle('pub', { type: 'publisher.hello', publisherId: 'P' });
  q.connect('node', { userId: 'creator' });
  q.handle('node', { type: 'node.hello', nodeId: 'N', profile: 'pc', envFingerprint: FP, codeVersions: [CV] });
  q.handle('node', { type: 'queue.watch', projects: 'all' });
  const take = (connId) => { const list = inbox.get(connId) ?? []; inbox.set(connId, []); return list; };
  return {
    q, take,
    tick(ms) { now += ms; q.tick(); },
    publish(tasks) { q.handle('pub', { type: 'task.publish', tasks, reqId: `r${now}` }); return take('pub').find((m) => m.type === 'task.published'); },
  };
}

test('CQ-01 已被认领的 backfill 遇到 normal 发布升为 normal;租约过期回到 open 时按 normal 排在别的 backfill 前面', () => {
  const r = rig();
  r.publish([fineTask('b-old', 'backfill')]);
  r.tick(10);
  r.publish([fineTask('b1', 'backfill')]);
  const opened = r.take('node').filter((m) => m.type === 'task.opened').map((m) => m.task);
  const b1 = opened.find((t) => t.resultKey === 'b1');
  r.q.handle('node', { type: 'task.claim', id: b1.id, expectVersion: b1.version });
  assert.ok(r.take('node').some((m) => m.type === 'task.claimed' && m.id === b1.id));
  // 认领中的 backfill 被 normal 发布:不另起、升档,不给节点发 task.opened(它还被认领着)
  const up = r.publish([fineTask('b1', 'normal')]);
  assert.equal(up.results[0].created, false);
  assert.equal(r.take('node').filter((m) => m.type === 'task.opened').length, 0);
  // 租约过期(不续约):回到 open,重新开放时带 normal,排在 b-old 前面
  r.tick(31_000);
  const reopened = r.take('node').filter((m) => m.type === 'task.opened').map((m) => m.task);
  const again = reopened.find((t) => t.id === b1.id);
  assert.ok(again, `租约过期回到 open:${JSON.stringify(r.q.describe().tasks.map((t) => [t.id, t.state]))}`);
  assert.equal(priorityBand(again.priority), 'normal');
  const view = [opened.find((t) => t.resultKey === 'b-old'), again];
  assert.deepEqual(rankCandidates(view).map((t) => t.resultKey), ['b1', 'b-old']);
});

test('CQ-02 已完成的 backfill 遇到 normal 发布:不另起任务,发布方收到 task.done', () => {
  const r = rig();
  r.publish([fineTask('d1', 'backfill')]);
  const t = r.take('node').find((m) => m.type === 'task.opened').task;
  r.q.handle('node', { type: 'task.claim', id: t.id, expectVersion: t.version });
  const claimed = r.take('node').find((m) => m.type === 'task.claimed');
  r.q.handle('node', { type: 'task.complete', id: t.id, token: claimed.token, result: { frames: 60 } });
  const doneState = r.q.describe().tasks.find((x) => x.id === t.id)?.state;
  if (doneState !== 'done') {
    // complete 的字段名随队列契约;没完成就把回包打出来
    assert.fail(`没完成:${JSON.stringify(r.take('node'))}`);
  }
  r.take('pub');
  r.q.handle('pub', { type: 'task.publish', tasks: [fineTask('d1', 'normal')], reqId: 'again' });
  const msgs = r.take('pub');
  assert.equal(msgs.find((m) => m.type === 'task.published').results[0].created, false);
  assert.ok(msgs.some((m) => m.type === 'task.done' && m.id === t.id), '发布方收到 task.done');
  assert.equal(r.take('node').filter((m) => m.type === 'task.opened').length, 0, '没有重新开放');
  assert.equal(r.q.describe().tasks.filter((x) => x.id === t.id).length, 1);
});

test('CQ-03 normal 档内整数名次高的先认;normal 字符串与缺省算名次 0;backfill 在所有 normal 之后', () => {
  const r = rig();
  r.publish([fineTask('bf', 'backfill')]); r.tick(1);
  r.publish([fineTask('n0')]); r.tick(1);
  r.publish([fineTask('nstr', 'normal')]); r.tick(1);
  r.publish([fineTask('n50', 50)]); r.tick(1);
  r.publish([fineTask('n5', 5)]);
  const opened = r.take('node').filter((m) => m.type === 'task.opened').map((m) => m.task);
  assert.deepEqual(rankCandidates(opened).map((t) => t.resultKey), ['n50', 'n5', 'n0', 'nstr', 'bf']);
});
