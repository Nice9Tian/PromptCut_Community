/*
 * T1a review #12: Agent lane has only one enqueue entry point (`FramePipeline.runAgentTask`).
 *
 * When the agent batch of `see_frames`, `layout`, `entityRects`, and `/api/cards/dom` (work via
 * runAgentTask) arrive interleaved, they must be **serialized**: at any moment, at most one task
 * holds the agent lane's bakery. Previously, `/api/cards/dom` had a separate `domChain` and its own
 * Chrome, which could drive the page simultaneously with in-flight see_frames.
 *
 * All browsers replaced: `acquire` records "check out", `release` records "return", acquiring
 * again during check out is an overlap.
 * Run: `node --experimental-test-module-mocks --test server/test/agent-lane.test.mjs`
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

mock.module(new URL('../bakery/index.mjs', import.meta.url).href, {
  exports: {
    openBakery: async () => { throw new Error('openBakery is not used here'); },
    findFfmpeg: async () => 'ffmpeg',
    bakeFrames: async (_bakery, opts) => {
      await sleep(15);
      for (const frame of opts.snapshotFrames || []) await opts.onSnapshot?.(frame, `<div data-pc-scene="" data-frame="${frame}"></div>`, []);
    },
  },
});
mock.module(new URL('../bakery/capture-snapshot.mjs', import.meta.url).href, {
  exports: {
    captureSnapshot: async (_bakery, _html, _screenshot, options = {}) => {
      await sleep(5);
      return options.afterFonts ? await options.afterFonts({ evaluate: async () => [] }) : Buffer.alloc(0);
    },
  },
});

const { FramePipeline } = await import('../frame-pipeline.mjs');

const project = {
  width: 320, height: 180, fps: 30, duration: 4,
  tracks: [{ id: 't1', clips: [{ id: 'card-a', cardId: 'odometer', start: 0, end: 4 }] }],
  media: [],
};

/** Only intercept disk and browser; queuing for runAgentTask / layout / entityRects / see_frames itself runs for real */
function harness() {
  const service = new FramePipeline({ root: '.', origin: () => '' });
  const entry = { key: 'k', project, dir: '.', html: new Map(), controls: new Map(), recordVersion: 0 };
  const log = [];
  let out = 0, max = 0, acquires = 0, releases = 0;
  const bakery = { page: { evaluate: async () => [] } };
  service.entry = async () => entry;
  service.save = async () => {};
  // Here each task checks out only once, so a "checked out but not returned" count > 1 means two tasks overlap
  service.acquire = async lane => {
    assert.equal(lane, 'agent');
    acquires++; out++; max = Math.max(max, out);
    await sleep(2);
    return bakery;
  };
  service.release = lane => { assert.equal(lane, 'agent'); releases++; out--; };
  // agent batch of see_frames: frame-reading core replaced with "borrow briefly, do work for a while",
  // check if it enters holding the lease given by runAgentTask
  service.readFramesCore = async (_entry, frames, lane, _signal, _onSession, _onFrame, lease) => {
    assert.equal(lane, 'agent');
    assert.equal(typeof lease, 'function', 'an agent batch must get its lease via runAgentTask and must not acquire by itself');
    await lease(project);
    log.push('see:start'); await sleep(20); log.push('see:end');
    return new Map(frames.map(n => [n, { buf: Buffer.alloc(0), source: 'mov' }]));
  };
  return { service, log, stats: () => ({ max, acquires, releases }) };
}

test('when see_frames / layout / entityRects / DOM queries arrive interleaved they run serially, and only one task holds the bakery at any moment', async () => {
  const { service, log, stats } = harness();
  const dom = label => service.runAgentTask(async lease => {
    await lease(project, { asIs: true });
    log.push(`${label}:start`); await sleep(10); log.push(`${label}:end`);
    return label;
  });
  // Interleaved: DOM arrives first; see_frames (12 ms batching), layout, entityRects,
  // and second DOM follow immediately
  const results = await Promise.all([
    dom('dom1'),
    service.see_frames(project, [0.5, 1]),
    service.layout(project, { t: 1, clipIds: ['card-a'] }),
    service.entityRects(project, [2]),
    dom('dom2'),
    service.see_frames(project, [3]),
  ]);
  assert.equal(results[0], 'dom1');
  assert.equal(results[4], 'dom2');
  assert.equal(stats().max, 1);
  // Every task checked out and returned. Two see_frames arrived in the same 12 ms window,
  // merged into one batch (one task):
  // dom1, see batch, layout, entityRects, dom2 = 5 tasks
  assert.equal(stats().acquires, 5);
  assert.equal(stats().releases, 5);
  assert.equal(log.filter(x => x === 'see:start').length, 1);
  // The three logged tasks: start and end are pairwise adjacent, with no other task interleaved in between
  for (let i = 0; i < log.length; i += 2) {
    assert.match(log[i], /:start$/);
    assert.equal(log[i + 1], log[i].replace(':start', ':end'));
  }
});

test('the editor process (interactive: false) has no Agent lane: all four routes return 503 NO_AGENT_LANE and do not borrow the bakery', async () => {
  const service = new FramePipeline({ root: '.', origin: () => '', interactive: false });
  service.entry = async () => ({ key: 'k', project, dir: '.', html: new Map(), controls: new Map() });
  service.acquire = async () => { throw new Error('the editor process must not open Chrome'); };
  for (const run of [
    () => service.runAgentTask(async () => 'x'),
    () => service.layout(project, { t: 0, clipIds: ['card-a'] }),
    () => service.entityRects(project, [0]),
    () => service.see_frames(project, [0], { lane: 'agent' }),
  ]) {
    await assert.rejects(run(), error => error.status === 503 && error.code === 'NO_AGENT_LANE');
  }
});

test('a failing task does not block the tasks behind it; the failing task still returns the bakery', async () => {
  const { service, stats } = harness();
  const failed = service.runAgentTask(async lease => { await lease(project); throw new Error('boom'); });
  const next = service.runAgentTask(async lease => { await lease(project); return 'ok'; });
  await assert.rejects(failed, /boom/);
  assert.equal(await next, 'ok');
  assert.equal(stats().releases, 2);
});

test('a task that never borrowed the bakery does not return it (asking only for the layout of a media clip does not open a browser)', async () => {
  const { service, stats } = harness();
  const mediaOnly = { ...project, tracks: [{ id: 't1', clips: [{ id: 'm1', start: 0, end: 4 }] }] };
  const out = await service.layout(mediaOnly, { t: 0, clipIds: ['m1'] });
  assert.equal(out.baked, false);
  assert.equal(stats().acquires, 0);
  assert.equal(stats().releases, 0);
});

test('release(agent) starts a 10-minute idle timer, which is cleared on the next borrow; when it expires, the lane is closed and removed from lanes', async () => {
  const service = new FramePipeline({ root: '.', origin: () => '' });
  let closed = 0;
  const session = { bakery: { close: async () => { closed++; } } };
  service.lanes.set('agent', session);
  const timers = [];
  const realSet = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms) => { const t = realSet(() => {}, 0); timers.push({ fn, ms }); return t; };
  try { service.release('agent'); service.release('agent'); }
  finally { globalThis.setTimeout = realSet; }
  assert.deepEqual(timers.map(t => t.ms), [10 * 60 * 1000, 10 * 60 * 1000]);
  timers.at(-1).fn();
  await sleep(0);
  assert.equal(closed, 1);
  assert.equal(service.lanes.has('agent'), false);
});
