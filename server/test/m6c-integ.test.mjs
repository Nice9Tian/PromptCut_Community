/**
 * Unit tests added for M6c integration rulings (`docs/plan/m6c-contract.md` "integration rulings
 * (2026-09-26)"):
 *   MI-yield-queue  During playback yield, tasks in `'queue'` lane borrow prerender room as usual
 *                   until finished; only background pass yields (semantics product/platforms.md
 *                   "finish the batch currently in hand until done")
 *   MI-no-isIdle    Executor no longer has `isIdle` (PC node switches to gate in `queue-idle.mjs`,
 *                   standalone render host never used it anyway)
 * Run: node --test server/test/m6c-integ.test.mjs
 *
 * No Chrome started: pre-place a fake prerender room for `'queue'` / `'background'` lane;
 * `acquire` takes the "reuse previous, reset" path.
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

test('MI-yield-queue: while the yield lease is valid / yielding is in progress, the queue lane still borrows the prerender room and its running queue tasks finish; the background lane still yields', async () => {
  const pipeline = new FramePipeline({ root: '.', origin: () => 'http://127.0.0.1:1' });
  const log = [];
  pipeline.lanes.set('queue', { bakery: fakeBakery('queue', log) });
  pipeline.lanes.set('background', { bakery: fakeBakery('background', log) });
  try {
    // A queue task starts first; halfway through, user starts playback (yields), then borrows prerender room for second half
    let resumeWork;
    const midway = new Promise(resolve => { resumeWork = resolve; });
    const running = pipeline.runQueueTask(async (lease) => {
      const first = await lease(project);
      await midway;
      const second = await lease(project);
      return [first.name, second.name];
    });
    await pipeline.yieldBackground('page-play', 5000);
    assert.ok(pipeline.backgroundLeaseUntil > Date.now(), 'The yield lease is valid');
    resumeWork();
    assert.deepEqual(await running, ['queue', 'queue'], 'Queue tasks running during the yield run to completion and are not cancelled because of the yield');
    assert.ok(!log.includes('queue.close'), 'Yielding does not close the queue lane\'s prerender room');
    assert.ok(log.includes('background.close'), 'The prerender room of the background run is still closed');

    // Queue tasks newly queued during yield (claimed in hand) are also processed as normal
    const later = await pipeline.runQueueTask(async (lease) => (await lease(project)).name);
    assert.equal(later, 'queue');

    // Background pass yields as usual
    pipeline.lanes.set('background', { bakery: fakeBakery('background2', log) });
    await assert.rejects(pipeline.acquire('background', project), (error) => error?.cancelled === true && /yielded/.test(error.message));
    await pipeline.resumeBackground('page-play');
    assert.equal(pipeline.backgroundLeaseUntil, 0);
  } finally { await pipeline.close(); }
});

test('MI-no-isIdle: the executor has only plan / render / forget, no more isIdle', () => {
  const pipeline = new FramePipeline({ root: '.', origin: () => 'http://127.0.0.1:1' });
  try {
    const executor = createPrerenderExecutor({ pipeline, projects: { get: async () => null } });
    // M7 contract D12 added afterSplit (write layer table v 3 after split completes); render-queue
    // contract A.12 [ruling] added laneOf / laneBusy (host claims when idle); isIdle is still absent
    assert.deepEqual(Object.keys(executor).sort(), ['afterSplit', 'forget', 'laneBusy', 'laneOf', 'plan', 'render']);
  } finally { void pipeline.close(); }
});
