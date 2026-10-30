import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FramePipeline } from '../frame-pipeline.mjs';

const project = { width: 320, height: 180 };
const makeService = () => new FramePipeline({ root: '.', origin: () => '' });

test('healthy playback frames renew the watchdog even when the batch exceeds ten seconds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const service = makeService(), closed = [];
  const session = { dead: false, bakery: { close: async () => closed.push(true) } };
  let emit, finish;
  service.readFramesCore = async (_entry, _frames, _lane, _signal, own, onFrame) => {
    own(session); emit = onFrame;
    return new Promise(resolve => { finish = resolve; });
  };
  const work = service.readFrames({ project }, [0, 1, 2], 'playback');
  for (let n = 0; n < 3; n++) { t.mock.timers.tick(9000); await emit(n, { buf: Buffer.from('frame') }); }
  finish('stream complete');
  assert.equal(await work, 'stream complete');
  assert.deepEqual(closed, []);
});
test('a preview timeout kills only the Chrome owned by that request', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const service = makeService();
  const closed = [];
  const sessions = [0, 1].map(id => ({ busy: true, dead: false, bakery: { close: async () => closed.push(id) } }));
  service.userPool = [...sessions];
  service.prewarmUser = async () => {};
  const finish = [];
  service.readFramesCore = async (_entry, [id], _lane, _signal, onSession) => {
    onSession(sessions[id]);
    return new Promise(resolve => { finish[id] = resolve; });
  };
  const old = service.readFrames({ project }, [0], 'user');
  const oldCheck = assert.rejects(old, e => e.timedOut === true);
  t.mock.timers.tick(9000);
  const latest = service.readFrames({ project }, [1], 'user');
  t.mock.timers.tick(1000);
  await oldCheck;
  assert.deepEqual(closed, [0]);
  assert.equal(sessions[1].dead, false);
  assert.deepEqual(service.userPool, [sessions[1]]);
  finish[1]('latest frame');
  assert.equal(await latest, 'latest frame');
  finish[0]('late old frame');
});
test('a request superseded while Chrome warms does not take a slot afterward', async () => {
  const service = makeService();
  const controller = new AbortController();
  let finishWarm, resets = 0;
  service.prewarmUser = () => new Promise(resolve => { finishWarm = resolve; });
  const session = { busy: false, dead: false, bakery: { reset: async () => { resets++; } } };
  service.userPool = [session];
  const work = service.acquireUser(project, controller.signal);
  controller.abort(); finishWarm();
  await assert.rejects(work, e => e.cancelled === true);
  assert.equal(resets, 0);
  assert.equal(session.busy, false);
});
test('ownership is registered before a hung reset; cancellation releases a healthy Chrome', async () => {
  const service = makeService();
  const controller = new AbortController();
  let finishReset, owner;
  service.prewarmUser = async () => {};
  const session = { busy: false, dead: false, bakery: {
    reset: () => new Promise(resolve => { finishReset = resolve; }),
    page: { setViewport: async () => {} }, client: { send: async () => {} },
  } };
  service.userPool = [session];
  const work = service.acquireUser(project, controller.signal, s => { owner = s; });
  await Promise.resolve();
  assert.equal(owner, session);
  controller.abort(); finishReset();
  await assert.rejects(work, e => e.cancelled === true);
  assert.equal(session.busy, false);
  assert.equal(session.dead, false);
});
