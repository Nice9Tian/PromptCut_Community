import { srcUrl } from '../testing/registerTs.mjs';
import { registerHooks } from 'node:module';
import { test, mock, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

// Vite supplies this compile-time macro. Exercise the actual runner in its
// desktop mode while replacing the browser RPC boundary with a held task.
const runnerUrl = srcUrl('editor/probeRunner.ts');
const hook = registerHooks({ load(url, context, next) {
  const loaded = next(url, context);
  const source = typeof loaded.source === 'string' ? loaded.source : Buffer.from(loaded.source ?? []).toString('utf8');
  return url === runnerUrl ? { ...loaded, source: source.replaceAll('import.meta.env.DEV', 'true') } : loaded;
} });
let identity = 'v1';
let held = null;
let jobs = 0;
let loads = 0;
let records = [];
let saved = [];
let rejectJobs = false;
let device = 'test-device';
let stageCaps = {};
const stage = { setTime: async () => ({ stepMs: 1, snapshot: { inlineMs: 1, rasterMs: 1, serializeMs: 1 } }) };
globalThis.document = {};
mock.module(srcUrl('editor/costIdentity.ts'), { exports: {
  resetClipIdentityCache() {},
  clipIdentityOf: () => ({ identityKeys: { clip: identity }, capabilities: new Map([['clip', { frameMode: 'direct' }]]) }),
} });
mock.module(srcUrl('render/costDevice.mjs'), { exports: {
  costDeviceString: () => device, readGpuRenderer: () => 'test-gpu', resolveGlRoute: () => 'test-route',
} });
mock.module(srcUrl('editor/planDispatch.ts'), { exports: { setPlanCosts() {}, mergePlanCosts() {} } });
mock.module(srcUrl('render/dataMirror.ts'), { exports: { mirrorKey: () => ({ session: 'test', localRev: 0 }) } });
mock.module(srcUrl('editor/stageBridge.ts'), { exports: {
  backStage: () => stage, onStageEvent: () => () => {}, pushProject: async () => {},
  stageCapabilities: () => stageCaps, whenStageReady: async () => stage,
} });
mock.module(srcUrl('editor/stageJobs.ts'), { exports: {
  MAX_PROJECT_RESENDS: 1, currentBackJob: () => null, renderAbortAction: () => 'error',
  runBackJob: async (_kind, fn) => { jobs++; const wait = held; held = null; if (wait) await wait; if (rejectJobs) throw new Error('Transient test RPC failure'); return fn({ stage, signal: { aborted: false } }); },
} });
mock.module(srcUrl('editor/measureGate.ts'), { exports: { measureGateOpen: () => true, whenMeasureGateOpen: async () => {} } });
const R = await import(runnerUrl);
const project = { id: 'project', fps: 30, tracks: [{ id: 'track', clips: [{ id: 'clip', cardId: 'card', start: 0, end: 1, params: {} }] }] };
async function until(check) {
  for (let i = 0; i < 300; i++) { if (check()) return; await new Promise(r => setTimeout(r, 5)); }
  assert.fail('Actual probe runner did not settle');
}
beforeEach(async () => {
  R.resetProbeRunner(); identity = 'v1'; held = null; jobs = 0; loads = 0; saved = [];
  rejectJobs = false; device = 'test-device'; stageCaps = {};
  records = [{ identityKey: 'v1', device: 'test-device', demoted: false }];
  R.setCostBackend({ forwardFrames: false,
    load: async () => { loads++; return { costs: records, tuning: { COST_SCALE: 1, STEP_PERCENTILE: 0.9, STEP_MIN_SAMPLES: 16 } }; },
    save: async next => { saved.push(...next); records.push(...next); return true; },
  });
  R.syncProbeRun(project);
  await until(() => R.probeSettledFor(project));
});
after(() => { R.setCostBackend(null); hook.deregister(); });

test('Repeated HMR notifications for one source identity keep the in-flight measurement', async () => {
  identity = 'v2';
  let release;
  held = new Promise(r => { release = r; });
  R.requeueProbeRun(project);
  await until(() => jobs === 1);
  R.requeueProbeRun(project);
  R.requeueProbeRun(project);
  release();
  await until(() => R.probeSettledFor(project));
  assert.equal(jobs, 1, 'Duplicate notices must not cancel and start the same measurement again');
  assert.deepEqual(saved.map(r => r.identityKey), ['v2']);
  assert.equal(R.probeRunDiag().probed.filter(p => p.identityKey === 'v2').length, 1);
});

test('A genuinely newer source interrupts the old measurement and saves only the newer identity', async () => {
  identity = 'v2';
  let release;
  held = new Promise(r => { release = r; });
  R.requeueProbeRun(project);
  await until(() => jobs === 1);
  identity = 'v3';
  R.requeueProbeRun(project);
  release();
  await until(() => R.probeSettledFor(project));
  assert.equal(jobs, 2);
  assert.deepEqual(saved.map(r => r.identityKey), ['v3'], 'The obsolete source must never publish a cost record');
});

test('Unchanged code leaves a settled project settled; ordinary project edits still run', async () => {
  const initialLoads = loads;
  R.requeueProbeRun(project);
  await new Promise(r => setTimeout(r, 20));
  assert.equal(loads, initialLoads);
  const edited = { ...project, duration: 2 };
  R.syncProbeRun(edited);
  await until(() => R.probeSettledFor(edited));
  assert.ok(loads > initialLoads);
});

test('Changing the cost backend still loads and measures the same source identity', async () => {
  R.setCostBackend({ forwardFrames: false,
    load: async () => { loads++; return { costs: [], tuning: { COST_SCALE: 1, STEP_PERCENTILE: 0.9, STEP_MIN_SAMPLES: 16 } }; },
    save: async next => { saved.push(...next); return true; },
  });
  R.requeueProbeRun(project);
  await until(() => R.probeSettledFor(project));
  assert.equal(jobs, 1);
  assert.deepEqual(saved.map(r => r.identityKey), ['v1']);
});

test('A changed stage device still measures the same source for its new device', async () => {
  device = 'new-device'; stageCaps = { compact: true, offscreenGl: true };
  R.requeueProbeRun(project);
  await until(() => R.probeSettledFor(project));
  assert.equal(jobs, 1);
  assert.deepEqual(saved.map(r => r.device), ['new-device']);
});

test('A failed RPC measurement can retry when an unchanged source becomes available', async () => {
  identity = 'v2'; rejectJobs = true;
  R.requeueProbeRun(project);
  await until(() => R.probeSettledFor(project));
  assert.deepEqual(R.probeProgress().failed, ['card']);
  assert.deepEqual(saved, []);
  rejectJobs = false;
  R.requeueProbeRun(project);
  await until(() => R.probeSettledFor(project));
  assert.deepEqual(saved.map(r => r.identityKey), ['v2']);
  assert.deepEqual(R.probeProgress().failed, []);
});

test('A newer project passed by a card notification preserves the FPS loading gate', async () => {
  const edited = { ...project, fps: 60 };
  R.requeueProbeRun(edited);
  await until(() => R.probeSettledFor(edited));
  assert.equal(R.probeProgress().blocking, true);
});
