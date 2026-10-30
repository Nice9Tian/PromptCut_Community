/**
 * Item 4 方案 A:编辑器进程的会话版本登记,和预渲染进程重启后的 preload 重放。
 * 跑:node --test server/test/ready-session-registry.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadySessionRegistry, replayReadySessions, READY_REGISTRY_MAX } from '../ready-session-registry.mjs';

test('登记:同一会话只留最大的 localRev(上报乱序到达不倒退);缺省会话和没有 localRev 的不登记', () => {
  const registry = createReadySessionRegistry();
  assert.equal(registry.record('s', 3), true);
  assert.equal(registry.record('s', 2), false, '晚到的旧版本不倒退');
  assert.equal(registry.record('s', 5), true);
  assert.equal(registry.record('', 9), false, '缺省会话没有镜像,重放不出来');
  assert.equal(registry.record('t', undefined), false);
  assert.equal(registry.record('t', 'x'), false);
  assert.deepEqual(registry.list().map(({ session, localRev }) => [session, localRev]), [['s', 5]]);
});

test('登记:最近上报的排前面;超过上限丢最久没动的', () => {
  let now = 0;
  const registry = createReadySessionRegistry({ max: 3, now: () => ++now });
  for (const id of ['a', 'b', 'c']) registry.record(id, 1);
  registry.record('a', 2);                                   // a 刚活跃过
  registry.record('d', 1);                                   // 超上限:丢最久没动的 b
  assert.deepEqual(registry.list().map(item => item.session), ['d', 'a', 'c']);
  assert.equal(READY_REGISTRY_MAX, 64);
});

test('重放:串行,一次只飞一个 preload;最近活跃的先;镜像里没有的跳过,滑出窗口的退到最新一版', async () => {
  const registry = createReadySessionRegistry();
  registry.record('old', 4);
  registry.record('gone', 1);
  registry.record('fresh', 7);
  const mirror = { fresh: [5, 6, 7], old: [9, 10] };          // old 记的 4 已经滑出窗口
  let flying = 0, peak = 0;
  const sent = [];
  const results = await replayReadySessions({
    sessions: registry.list(),
    resolve: (session, localRev) => {
      const revs = mirror[session];
      if (!revs) return null;
      return revs.includes(localRev) ? localRev : revs.at(-1);
    },
    preload: async ({ session, localRev }) => {
      flying++; peak = Math.max(peak, flying);
      await new Promise(resolve => setTimeout(resolve, 5));
      sent.push([session, localRev]);
      flying--;
      return { ok: true, status: 'queued' };
    },
  });
  assert.equal(peak, 1, '不并发:刚起来的预渲染进程不会被一齐打上来');
  assert.deepEqual(sent, [['fresh', 7], ['old', 10]]);
  assert.deepEqual(results.map(r => r.skipped ?? r.ok), [true, 'no-mirror', true]);
});

test('重放:一个会话失败不影响后面的;预渲染进程又重启了就停', async () => {
  const sessions = [{ session: 'a', localRev: 1 }, { session: 'b', localRev: 1 }, { session: 'c', localRev: 1 }];
  let current = true;
  const sent = [];
  const results = await replayReadySessions({
    sessions,
    resolve: (_s, localRev) => localRev,
    preload: async ({ session }) => {
      sent.push(session);
      if (session === 'a') throw new Error('409');
      current = false;                                         // 发完 b 之后它又崩了
      return { ok: true };
    },
    isCurrent: () => current,
  });
  assert.deepEqual(sent, ['a', 'b']);
  assert.deepEqual(results.map(r => r.skipped ?? r.ok), [false, true, 'superseded']);
});

test('重放封顶:只重放最近活跃的那几个会话(早已关掉的标签页不白排后台活)', async () => {
  const { READY_REPLAY_MAX } = await import('../ready-session-registry.mjs');
  let now = 0;
  const registry = createReadySessionRegistry({ now: () => ++now });
  for (let i = 0; i < READY_REPLAY_MAX + 3; i++) registry.record(`s${i}`, 1);
  const sent = [];
  await replayReadySessions({ sessions: registry.list(), resolve: (_s, r) => r, preload: async ({ session }) => { sent.push(session); return { ok: true }; } });
  assert.equal(sent.length, READY_REPLAY_MAX);
  assert.equal(sent[0], `s${READY_REPLAY_MAX + 2}`, '最近活跃的先');
});
