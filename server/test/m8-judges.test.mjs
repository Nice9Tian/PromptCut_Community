// M8 探针判法的两处弱点（REPORT-render-queue-m8.md 第 13.5 节）改成的纯函数：
//   - cloud-untouched 按本轮查（本轮项目名在云端 shared/lookup 查不到），不再数云端的总连接数；
//   - e1 真实细任务数的检查名按门槛写（real:tasks>=<门槛>），门槛按条数 × 每条段数缩放、封顶 50。
// 第三处（--assert-no-lan 只数已建立的连接）在 m8-no-lan.test.mjs。不连阿里云、不碰局域网。
import test from 'node:test';
import assert from 'node:assert/strict';
import { judgeCloudUntouched, realTasksThreshold } from '../../scripts/probes/m8/lib.mjs';

const MINE = { name: 'm8e-e1-r123', projectId: 'sp_aaaaaaaaaaaaaaaaaaaaaaaaaa' };

test('cloud-untouched:本轮项目在云端查不到(404)就过,不管云端总连接数怎么变', () => {
  const r = judgeCloudUntouched({ status: 404, body: { error: 'not-found' } }, MINE, { before: 3, after: 7 });
  assert.equal(r.ok, true);
  assert.equal(r.via, 'lookup');
  assert.deepEqual(r.connections, { before: 3, after: 7 }, '总连接数只记录');
  // 以前的判法(前后总数相等)在这里会误判:别人在这期间连上了 4 条
  assert.notEqual(r.connections.before, r.connections.after);
});

test('cloud-untouched:本轮项目出现在云端就不过;同名但 projectId 不同(不是本轮的)照过并写明', () => {
  const hit = judgeCloudUntouched({ status: 200, body: { projectId: MINE.projectId, name: MINE.name, mode: 'free' } }, MINE, { before: 5, after: 5 });
  assert.equal(hit.ok, false, '总连接数不变也不过:本轮的项目进过云端');
  assert.match(hit.why, /本轮的项目出现在云端/);
  const other = judgeCloudUntouched({ status: 200, body: { projectId: 'sp_zzzzzzzzzzzzzzzzzzzzzzzzzz' } }, MINE);
  assert.equal(other.ok, true);
  assert.match(other.why, /同名/);
  const noId = judgeCloudUntouched({ status: 200, body: {} }, MINE);
  assert.equal(noId.ok, false, '回了 200 却没有 projectId,当作本轮的');
});

test('cloud-untouched:云端连不上或回别的状态记 unreachable 放过(同以前读不到就不判);没有项目名不过', () => {
  assert.deepEqual(judgeCloudUntouched(null, MINE).via, 'unreachable');
  assert.equal(judgeCloudUntouched(null, MINE).ok, true);
  const five = judgeCloudUntouched({ status: 502 }, MINE);
  assert.equal(five.ok, true);
  assert.equal(five.via, 'unreachable');
  assert.equal(five.status, 502);
  assert.equal(judgeCloudUntouched({ status: 404 }, { projectId: MINE.projectId }).ok, false);
});

test('real:tasks 门槛:按条数 × 每条段数缩放、封顶 50,检查名写实际门槛', () => {
  assert.deepEqual(realTasksThreshold({ clips: 10, seconds: 10 }), { need: 50, label: 'real:tasks>=50', expected: 50 });
  assert.deepEqual(realTasksThreshold({ clips: 4, seconds: 10 }), { need: 20, label: 'real:tasks>=20', expected: 20 });
  assert.deepEqual(realTasksThreshold({ clips: 20, seconds: 10 }), { need: 50, label: 'real:tasks>=50', expected: 100 });
  // 不整除时向上取整,和以前 `tasks >= 7.5` 对整数任务数的判法相同
  const odd = realTasksThreshold({ clips: 3, seconds: 5 });
  assert.equal(odd.need, 8);
  assert.equal(odd.label, 'real:tasks>=8');
  assert.equal(realTasksThreshold({ clips: 2, seconds: 4, fps: 60 }).need, 8);
});
