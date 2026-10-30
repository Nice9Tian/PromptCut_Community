/*
 * T1a 审查 #12:Agent lane 只有一个入队口(`FramePipeline.runAgentTask`)。
 *
 * `see_frames` 的 agent 批、`layout`、`entityRects`、`/api/cards/dom`(经 runAgentTask 的 work)
 * 交错着进来时必须**串行**:同一时刻至多一个任务拿着 agent lane 的 bakery。以前 `/api/cards/dom`
 * 另有一条 `domChain` 和自己的 Chrome,和在飞的 see_frames 能同时驱动页面。
 *
 * 浏览器全部替掉:`acquire` 记「借出」,`release` 记「还回」,借出期间再借一次就是重叠。
 * 跑法:`node --experimental-test-module-mocks --test server/test/agent-lane.test.mjs`
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

/** 只挡住磁盘和浏览器;runAgentTask / layout / entityRects / see_frames 的排队本身跑真的 */
function harness() {
  const service = new FramePipeline({ root: '.', origin: () => '' });
  const entry = { key: 'k', project, dir: '.', html: new Map(), controls: new Map(), recordVersion: 0 };
  const log = [];
  let out = 0, max = 0, acquires = 0, releases = 0;
  const bakery = { page: { evaluate: async () => [] } };
  service.entry = async () => entry;
  service.save = async () => {};
  // 这里每个任务只借一次,所以「借出未还」的计数 > 1 就是两个任务重叠
  service.acquire = async lane => {
    assert.equal(lane, 'agent');
    acquires++; out++; max = Math.max(max, out);
    await sleep(2);
    return bakery;
  };
  service.release = lane => { assert.equal(lane, 'agent'); releases++; out--; };
  // see_frames 的 agent 批:读帧核心换成「借一下、干一会儿」,看它是不是拿着 runAgentTask 给的 lease 进来
  service.readFramesCore = async (_entry, frames, lane, _signal, _onSession, _onFrame, lease) => {
    assert.equal(lane, 'agent');
    assert.equal(typeof lease, 'function', 'agent 批必须经 runAgentTask 拿 lease,不能自己 acquire');
    await lease(project);
    log.push('see:start'); await sleep(20); log.push('see:end');
    return new Map(frames.map(n => [n, { buf: Buffer.alloc(0), source: 'mov' }]));
  };
  return { service, log, stats: () => ({ max, acquires, releases }) };
}

test('see_frames / layout / entityRects / DOM 查询交错到达时串行执行,同一时刻只有一个任务拿着 bakery', async () => {
  const { service, log, stats } = harness();
  const dom = label => service.runAgentTask(async lease => {
    await lease(project, { asIs: true });
    log.push(`${label}:start`); await sleep(10); log.push(`${label}:end`);
    return label;
  });
  // 交错:DOM 先到,see_frames(12 ms 攒批)、layout、entityRects、第二个 DOM 紧跟着进来
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
  // 每个任务都借过、也都还了。两个 see_frames 在同一个 12 ms 窗口里到达,合成一批(一个任务):
  // dom1、see 批、layout、entityRects、dom2 = 5 个任务
  assert.equal(stats().acquires, 5);
  assert.equal(stats().releases, 5);
  assert.equal(log.filter(x => x === 'see:start').length, 1);
  // 记了日志的三个任务:开始和结束两两相邻,中间没有别人插进来
  for (let i = 0; i < log.length; i += 2) {
    assert.match(log[i], /:start$/);
    assert.equal(log[i + 1], log[i].replace(':start', ':end'));
  }
});

test('编辑器进程(interactive: false)没有 Agent lane:四条路都回 503 NO_AGENT_LANE,不借 bakery', async () => {
  const service = new FramePipeline({ root: '.', origin: () => '', interactive: false });
  service.entry = async () => ({ key: 'k', project, dir: '.', html: new Map(), controls: new Map() });
  service.acquire = async () => { throw new Error('编辑器进程不该开 Chrome'); };
  for (const run of [
    () => service.runAgentTask(async () => 'x'),
    () => service.layout(project, { t: 0, clipIds: ['card-a'] }),
    () => service.entityRects(project, [0]),
    () => service.see_frames(project, [0], { lane: 'agent' }),
  ]) {
    await assert.rejects(run(), error => error.status === 503 && error.code === 'NO_AGENT_LANE');
  }
});

test('一个任务出错不堵后面的任务;出错的任务照样还 bakery', async () => {
  const { service, stats } = harness();
  const failed = service.runAgentTask(async lease => { await lease(project); throw new Error('boom'); });
  const next = service.runAgentTask(async lease => { await lease(project); return 'ok'; });
  await assert.rejects(failed, /boom/);
  assert.equal(await next, 'ok');
  assert.equal(stats().releases, 2);
});

test('没借过 bakery 的任务不还(只问素材段的 layout 不开浏览器)', async () => {
  const { service, stats } = harness();
  const mediaOnly = { ...project, tracks: [{ id: 't1', clips: [{ id: 'm1', start: 0, end: 4 }] }] };
  const out = await service.layout(mediaOnly, { t: 0, clipIds: ['m1'] });
  assert.equal(out.baked, false);
  assert.equal(stats().acquires, 0);
  assert.equal(stats().releases, 0);
});

test('release(agent) 起 10 分钟空闲计时器,再借就清掉;到点关掉并从 lanes 里删', async () => {
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
