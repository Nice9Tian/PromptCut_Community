/**
 * M6c 集成时的裁定(`docs/plan/m6c-contract.md`「集成时的裁定(2026-09-26)」)补的单测:
 *   MI-yield-queue  播放让路期间,`'queue'` lane 的任务照常借预渲染间、做完为止;只有后台那一趟让路
 *                   (语义 product/platforms.md「手里在做的那一批做完为止」)
 *   MI-no-isIdle    执行器不再有 `isIdle`(PC 节点改用 `queue-idle.mjs` 的门槛,独立渲染主机本来就不用)
 * 跑:node --test server/test/m6c-integ.test.mjs
 *
 * 不开 Chrome:`'queue'` / `'background'` lane 预先放一个假的预渲染间,`acquire` 走「复用上一个、重置」那条路。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FramePipeline } from '../frame-pipeline.mjs';
import { createPrerenderExecutor } from '../prerender-executor.mjs';

const project = { id: 'p1', width: 64, height: 36, fps: 30, duration: 1, tracks: [], media: [] };

function fakeBakery(name, log) {
  return {
    name,
    reset: async () => { log.push(`${name}.reset`); },
    page: { setViewport: async () => {} },
    client: { send: async () => {} },
    close: async () => { log.push(`${name}.close`); },
  };
}

test('MI-yield-queue:让路租约在期 / 正在让路时,queue lane 照常借到预渲染间、在跑的队列任务做完;background lane 照旧让路', async () => {
  const pipeline = new FramePipeline({ root: '.', origin: () => 'http://127.0.0.1:1' });
  const log = [];
  pipeline.lanes.set('queue', { bakery: fakeBakery('queue', log) });
  pipeline.lanes.set('background', { bakery: fakeBakery('background', log) });
  try {
    // 一个队列任务先开工,干到一半用户开始播放(让路),再借预渲染间干后半段
    let resumeWork;
    const midway = new Promise(resolve => { resumeWork = resolve; });
    const running = pipeline.runQueueTask(async (lease) => {
      const first = await lease(project);
      await midway;
      const second = await lease(project);
      return [first.name, second.name];
    });
    await pipeline.yieldBackground('page-play', 5000);
    assert.ok(pipeline.backgroundLeaseUntil > Date.now(), '让路租约在期');
    resumeWork();
    assert.deepEqual(await running, ['queue', 'queue'], '让路期间在跑的队列任务做完为止,不因让路被取消');
    assert.ok(!log.includes('queue.close'), '让路不关 queue lane 的预渲染间');
    assert.ok(log.includes('background.close'), '后台那一趟的预渲染间照旧关掉');

    // 让路期间新排进来的队列任务(认领在手的)也照常做
    const later = await pipeline.runQueueTask(async (lease) => (await lease(project)).name);
    assert.equal(later, 'queue');

    // 后台那一趟照旧让路
    pipeline.lanes.set('background', { bakery: fakeBakery('background2', log) });
    await assert.rejects(pipeline.acquire('background', project), (error) => error?.cancelled === true && /yielded/.test(error.message));
    await pipeline.resumeBackground('page-play');
    assert.equal(pipeline.backgroundLeaseUntil, 0);
  } finally { await pipeline.close(); }
});

test('MI-no-isIdle:执行器只有 plan / render / forget,不再有 isIdle', () => {
  const pipeline = new FramePipeline({ root: '.', origin: () => 'http://127.0.0.1:1' });
  try {
    const executor = createPrerenderExecutor({ pipeline, projects: { get: async () => null } });
    // M7 契约 D12 加了 afterSplit(切分完成后写层表 v 3);render-queue 契约 A.12〔裁〕加了 laneOf / laneBusy(主机闲时认领);isIdle 照旧没有
    assert.deepEqual(Object.keys(executor).sort(), ['afterSplit', 'forget', 'laneBusy', 'laneOf', 'plan', 'render']);
  } finally { void pipeline.close(); }
});
