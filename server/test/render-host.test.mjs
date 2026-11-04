/**
 * Standalone render host (M6b, contract `docs/plan/render-host-contract.md` section 5 "Unit Tests").
 * Run: npm test (global setup occupies this machine's bad port; unit tests always use port 0).
 *
 *   RH1  Config parsing: single item, array, error on missing fields; maxConcurrent defaults to 1,
 *        max 4, env override; render-host arguments and child process env vars
 *   RH2  Multiple projects open multiple connections: two shared projects on real document service
 *        (hosted side, credential handshake), one render connection and one host node per item,
 *        node.hello profile / codeVersions / capabilities correct; each only sees and works on
 *        tasks for its own project
 *   RH3  plan skipping: host node does not send claim when seeing plan (pc node on the same queue
 *        claims normally); fine-grained tasks claimed normally
 *   RH4  Concurrency limit: 6 tasks across two projects; when maxConcurrent is 1 or 2, held +
 *        in-flight across all nodes never exceeds the limit at any tick, and reaches the limit
 *   RH5  Yield claim on exit: shutdown sends task.release for each held task, queue immediately
 *        releases back to open (without waiting for disconnect grace period), other nodes can claim
 *        immediately; execution is aborted
 *   RH6  Code version filtering as before: hosts with different codeVersion see tasks, claim 0 times
 *   RH-fallback-ticket  Asset fallback picks ticket by base URL (legacy fix during integration):
 *        two asset services recognize their own tickets, reading from either uses the ticket of its
 *        owning project
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { createRenderQueue } from '../render-queue/index.mjs';
import { createLocalNode } from '../render-node/local-node.mjs';
import { planTaskOf } from '../render-node/split.mjs';
import { checkClaimable } from '../render-node/filter.mjs';
import { createWsEndpoint } from '../render-node/ws-transport.mjs';
import { createRenderHost, loadHostConfig, parseHostConfig, fallbackTicketFor, hostMaxConcurrent, HOST_MAX_CONCURRENT, HOST_CAPABILITIES, renderHostArgs as parseArgs, renderHostEnv as hostEnv } from '../render-node/host.mjs';
import { normalizeEntry, sharedProtocols } from '../auth/shared-config.mjs';
import { createLoopback } from './fake-loopback-transport.mjs';
import { createTimerClock } from './fake-render-executor.mjs';
import { startSharedService, createProject, join, tempDir, deviceId, assetTicketKit } from './fake-shared-env.mjs';
import { createAssetHarness, ROOT } from './fake-asset-service.mjs';
import http from 'node:http';
import crypto from 'node:crypto';
import { byType } from './fake-ws-kit.mjs';

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const FP = 'fedcba9876543210';
const CV = 'c0de-rh';
const STEP_MS = 250;

/* ------------------------------------------------------------------ Fixtures */

function fineTask(projectId, label, { cv = CV, from = 0, to = 29 } = {}) {
  const contentKey = sha256(`ck:${projectId}:${label}`);
  const resultKey = sha256(`${contentKey}\n${FP}`);
  return {
    id: `snapshot:${resultKey}:${from}-${to}`, kind: 'snapshot', tier: 'shared', resultKey,
    range: { unit: 'localFrame', from, to },
    source: { projectId, projectRev: 1 },
    input: { clipId: `clip-${label}`, cardId: `card-${label}`, entryKey: null, contentKey },
    weight: { class: 'medium', estMs: null, frames: to - from + 1 },
    requires: { envFingerprint: FP, codeVersion: cv, cardSources: {}, transcode: false, userCards: false, graphCards: false, belowDependent: false },
    priority: 10,
  };
}

/**
 * Executor: when `hang` is true, render never returns (can only be aborted);
 * otherwise completes immediately. plan should not be called by host
 */
function fakeExecutor({ hang = false } = {}) {
  const calls = { render: [], plan: [], aborted: [] };
  return {
    calls,
    async plan(task) { calls.plan.push(task.id); return { entryKey: 'e', cardPlan: [] }; },
    render(task, { signal } = {}) {
      calls.render.push(task.id);
      signal?.addEventListener('abort', () => calls.aborted.push(task.id), { once: true });
      if (hang) return new Promise(() => {});
      return Promise.resolve({ fake: task.id });
    },
  };
}

function fakeSink() {
  const puts = [];
  return { puts, async has() { return false; }, async put(entry) { puts.push(entry.meta.taskId); return { complete: true, result: {} }; } };
}

/**
 * In-process topology: one queue per project (equivalent to a space on document service),
 * one loopback transport, one page publisher.
 * Host `connect(entry)` opens a connection on the corresponding project's loopback.
 */
function createSpaces(projectIds) {
  const clock = createTimerClock();
  const spaces = new Map();
  for (const projectId of projectIds) {
    const lb = createLoopback();
    const queue = createRenderQueue({ now: clock.now, send: lb.queueSend, epoch: `epoch-${projectId}` });
    lb.attach(queue);
    const page = lb.connect(`page-${projectId}`, { userId: 'alice@page-device-0001', tenantId: projectId });
    const inbox = [];
    page.onMessage((m) => inbox.push(m));
    page.send({ type: 'publisher.hello', publisherId: `page-${projectId}` });
    spaces.set(projectId, {
      lb, queue, inbox,
      publish: (tasks) => page.send({ type: 'task.publish', tasks }),
      doneCount: (id) => inbox.filter((m) => m.type === 'task.done' && m.id === id).length,
      sent: (connId) => lb.log().filter((e) => e.dir === 'in' && e.connId === connId).map((e) => e.message),
      task: (id) => queue.describe().tasks.find((t) => t.id === id),
    });
  }
  const all = [...spaces.values()];
  const settle = async () => {
    for (let round = 0; round < 1000; round++) {
      for (const s of all) s.lb.flush();
      for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
      if (all.every((s) => s.lb.pending() === 0)) return;
    }
    throw new Error('message round trips do not converge');
  };
  const hygiene = () => {
    for (const s of all) {
      assert.deepEqual(s.lb.errors().map((e) => String(e?.stack ?? e)), [], 'The endpoint handler / queue.handle threw an exception');
      assert.deepEqual(s.lb.nonJson(), [], 'some message cannot round-trip through JSON');
    }
  };
  return { clock, spaces, all, settle, hygiene };
}

function hostOn(env, { projectIds, cap = 1, cv = CV, executors = new Map(), sinks = new Map() } = {}) {
  const entries = projectIds.map((projectId) => ({ projectId, url: 'ws://unused.invalid/docservice' }));
  const host = createRenderHost({
    entries,
    connect: (entry, index) => ({
      endpoint: env.spaces.get(entry.projectId).lb.connect(`host-${index}`, { userId: 'renderbox@host-device-0001', tenantId: entry.projectId }),
      executor: executors.get(entry.projectId) ?? fakeExecutor(),
      sink: sinks.get(entry.projectId) ?? fakeSink(),
    }),
    nodeIdOf: (_entry, index) => `host:test/p${index}`,
    envFingerprint: FP,
    codeVersion: cv,
    maxConcurrent: cap,
    now: env.clock.now,
    random: () => 0,
  });
  return host;
}

async function drive(env, step, until, maxSteps = 300) {
  for (let i = 0; i < maxSteps; i++) {
    await env.settle();
    step();
    await env.settle();
    for (const s of env.all) s.queue.tick();
    await env.settle();
    if (until()) return i;
    env.clock.advance(STEP_MS);
  }
  assert.fail(`Condition still not met after ${maxSteps} steps`);
}

/* ================================================================== RH1 */

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function configFile(content) {
  const dir = tempDir('pc-rh1-');
  dirs.push(dir);
  const file = path.join(dir, 'host.json');
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
}

const ENTRY = Object.freeze({
  url: 'ws://127.0.0.1:5400/docservice', projectId: 'sp_aaaaaaaaaaaaaaaaaaaaaaaaaa', username: 'renderbox',
  deviceId: 'render-box-device-0001', deviceName: 'Render Box', as: 'member', password: 'secret-pw', role: 'render',
});

test('RH1 config parsing: single entry, array, missing fields throw an error; maxConcurrent defaults to 1, limit 4, environment variable override', () => {
  assert.equal(loadHostConfig({}), null, 'Returns null when the environment variable is not set');

  const single = loadHostConfig({ PROMPTCUT_SHARED_CONFIG: configFile(ENTRY) });
  assert.equal(single.entries.length, 1, 'Single entry');
  assert.equal(single.entries[0].projectId, ENTRY.projectId);
  assert.equal(single.entries[0].role, 'render');
  assert.equal(single.maxConcurrent, 1, 'Default 1');

  const second = { ...ENTRY, projectId: 'sp_bbbbbbbbbbbbbbbbbbbbbbbbbb', url: 'ws://127.0.0.1:8787', maxConcurrent: 3 };
  const array = loadHostConfig({ PROMPTCUT_SHARED_CONFIG: configFile([ENTRY, second]) });
  assert.deepEqual(array.entries.map((e) => e.projectId), [ENTRY.projectId, second.projectId], 'Array entries keep their order');
  assert.equal(array.maxConcurrent, 3, 'Takes the largest value given among the entries');

  // Integration ruling (contract section 6): maxConcurrent exceeding 4 is a configuration error,
  // not clamped; so are 0, negative numbers, decimals, and strings
  assert.equal(loadHostConfig({ PROMPTCUT_SHARED_CONFIG: configFile([{ ...ENTRY, maxConcurrent: HOST_MAX_CONCURRENT }]) }).maxConcurrent, HOST_MAX_CONCURRENT, '4 itself is accepted');
  assert.throws(() => loadHostConfig({ PROMPTCUT_SHARED_CONFIG: configFile([{ ...ENTRY, maxConcurrent: 9 }]) }), { code: 'bad-host-config' }, 'Over 4 throws an error');
  assert.equal(parseHostConfig([ENTRY, { ...second, maxConcurrent: 2 }, { ...ENTRY, maxConcurrent: 4 }]).maxConcurrent, 4, 'Set on any one entry, the largest value is taken');
  assert.equal(loadHostConfig({ PROMPTCUT_SHARED_CONFIG: configFile([ENTRY, second]), PROMPTCUT_HOST_MAX_CONCURRENT: '2' }).maxConcurrent, 2, 'Environment variable override');
  assert.throws(() => loadHostConfig({ PROMPTCUT_SHARED_CONFIG: configFile([ENTRY]), PROMPTCUT_HOST_MAX_CONCURRENT: '5' }), { code: 'bad-host-config' }, 'An environment variable over 4 throws an error');
  assert.equal(hostMaxConcurrent(undefined), 1, 'Defaults to 1 when not given');
  for (const bad of [0, -1, 2.7, '2', 'x', 5]) assert.throws(() => hostMaxConcurrent(bad), { code: 'bad-host-config' }, JSON.stringify(bad));
  assert.throws(() => parseHostConfig({ ...ENTRY, role: 'page' }), { code: 'bad-host-config' }, 'The host opens only render connections');

  for (const [label, bad] of [
    ['Missing username', { ...ENTRY, username: undefined }],
    ['Missing passphrase and key', { ...ENTRY, password: undefined }],
    ['Missing url', { ...ENTRY, url: undefined }],
    ['Missing projectId and name', { ...ENTRY, projectId: undefined }],
    ['Wrong role', { ...ENTRY, role: 'admin' }],
  ]) {
    assert.throws(() => loadHostConfig({ PROMPTCUT_SHARED_CONFIG: configFile([ENTRY, bad]) }), (error) => {
      assert.equal(error.code, 'bad-shared-config', label);
      assert.ok(!String(error.message).includes('secret-pw'), `${label}: the error message contains no passphrase`);
      return true;
    }, label);
  }
  assert.throws(() => loadHostConfig({ PROMPTCUT_SHARED_CONFIG: configFile('[]') }), { code: 'bad-shared-config' }, 'Empty array');
  assert.throws(() => loadHostConfig({ PROMPTCUT_SHARED_CONFIG: configFile('{oops') }), { code: 'bad-shared-config' }, 'Not JSON');
  assert.throws(() => loadHostConfig({ PROMPTCUT_SHARED_CONFIG: path.join(tempDir('pc-rh1-none-'), 'missing.json') }), { code: 'bad-shared-config' }, 'File does not exist');
});

test('RH1 render-host: argument parsing and child process environment variables (contract section 2)', () => {
  assert.deepEqual(parseArgs(['--config', 'h.json']), { port: 5400, config: 'h.json', data: null, maxConcurrent: null, streams: false, verbose: false, cwd: null }, 'Default port 5400; --cwd (an isolated worker process uses its own checkout copy) is not given by default');
  assert.equal(parseArgs(['--port', '5403', '--max-concurrent', '2', '--streams']).port, 5403);
  assert.throws(() => parseArgs(['--max-concurrent', '5']), /1 to 4/);
  assert.throws(() => parseArgs(['--nope']), /Unknown argument/);
  const env = hostEnv({ PATH: 'x', PROMPTCUT_CLUSTER_TOKEN: 'tok', PROMPTCUT_DOCSERVICE_URL: 'ws://x', PROMPTCUT_HEADLESS: '1', PROMPTCUT_PUSH: '0', PROMPTCUT_ROLE: 'prerender' },
    { config: 'cfg/host.json', data: path.resolve('d'), streams: false, maxConcurrent: 2 });
  assert.equal(env.PROMPTCUT_QUEUE_NODE, '1');
  assert.equal(env.PROMPTCUT_NODE_PROFILE, 'host');
  assert.equal(env.PROMPTCUT_SHARED_CONFIG, path.resolve('cfg/host.json'), 'The config file uses an absolute path');
  assert.equal(env.PROMPTCUT_STREAMS, '0');
  assert.equal(env.PROMPTCUT_HOST_MAX_CONCURRENT, '2');
  assert.equal(env.PROMPTCUT_EXPORT_DIR, path.resolve('d'));
  assert.equal(env.TEMP, path.join(path.resolve('d'), 'tmp'), 'The temp directory is under the data directory of the instance itself (does not write the shared port.json)');
  for (const key of ['PROMPTCUT_CLUSTER_TOKEN', 'PROMPTCUT_DOCSERVICE_URL', 'PROMPTCUT_HEADLESS', 'PROMPTCUT_PUSH', 'PROMPTCUT_ROLE']) assert.equal(env[key], undefined, `${key} is removed`);
  assert.equal(env.PATH, 'x');
  assert.equal(hostEnv({}, { config: 'a', data: 'd', streams: true }).PROMPTCUT_STREAMS, '1');
});

/* ================================================================== RH2 */

test('RH2 multiple projects open multiple connections: two shared projects get one render connection each and a host node, and each does only the tasks of its own project', async () => {
  const svc = await startSharedService({ mode: 'hosted' });   // isLoopback is always false: can only enter with proof
  const pages = [];
  let host = null;
  const endpoints = [];
  try {
    const a = await createProject(svc.base, { name: 'rh2-a', password: 'pw-a' });
    const b = await createProject(svc.base, { name: 'rh2-b', password: 'pw-b' });
    const device = deviceId('rhbox');
    const entries = [
      normalizeEntry({ url: svc.url, projectId: a.projectId, username: 'renderbox', deviceId: device, deviceName: 'Render Box', password: 'pw-a', role: 'render' }),
      normalizeEntry({ url: svc.url, projectId: b.projectId, username: 'renderbox', deviceId: device, deviceName: 'Render Box', password: 'pw-b', role: 'render' }),
    ];
    const executors = new Map(entries.map((e) => [e.projectId, fakeExecutor()]));
    const sinks = new Map(entries.map((e) => [e.projectId, fakeSink()]));
    host = createRenderHost({
      entries,
      connect: (entry) => {
        const endpoint = createWsEndpoint({ url: entry.url, protocols: sharedProtocols(entry, { role: 'render' }), backoff: { baseMs: 50, maxMs: 200 } });
        endpoints.push(endpoint);
        return { endpoint, executor: executors.get(entry.projectId), sink: sinks.get(entry.projectId) };
      },
      nodeIdOf: (_e, i) => `host:rh2/p${i}`,
      envFingerprint: FP, codeVersion: CV, maxConcurrent: 1, now: Date.now,
    });
    host.start();
    const deadline = Date.now() + 20_000;
    while (!host.nodes().every((n) => n.connected) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.equal(host.nodes().length, 2, 'Two config entries, two nodes');
    assert.ok(host.nodes().every((n) => n.connected), `Both connections are connected: ${JSON.stringify(host.nodes())}`);
    assert.deepEqual(host.nodes().map((n) => n.projectId), [a.projectId, b.projectId]);

    // One member page in each project publishes a fine-grained task
    const tasks = new Map();
    for (const [project, pw] of [[a, 'pw-a'], [b, 'pw-b']]) {
      const page = await join(svc.base, { projectId: project.projectId, username: 'alice', deviceId: deviceId('page'), password: pw, role: 'page' });
      pages.push(page);
      await page.opened;
      page.send({ type: 'publisher.hello', publisherId: `page-${project.projectId}` });
      await page.next(byType('publisher.welcome'));
      const task = fineTask(project.projectId, 'rh2');
      tasks.set(project.projectId, task);
      page.send({ type: 'task.publish', tasks: [task] });
      await page.next(byType('task.published'));
    }
    const until = Date.now() + 20_000;
    while (Date.now() < until && !(sinks.get(a.projectId).puts.length && sinks.get(b.projectId).puts.length)) {
      svc.service.tick();   // M6c X3: host discovers projects with work via scan-cycle project summaries; this service has autoTick off, manual tick here
      host.tick();
      await new Promise((r) => setTimeout(r, 30));
    }
    assert.deepEqual(sinks.get(a.projectId).puts, [tasks.get(a.projectId).id], 'The node of project A does only the tasks of A');
    assert.deepEqual(sinks.get(b.projectId).puts, [tasks.get(b.projectId).id], 'The node of project B does only the tasks of B');
    for (const n of host.nodes()) assert.equal(n.seen, 1, `Each node sees only 1 task of its own project: ${JSON.stringify(n)}`);
    assert.deepEqual(executors.get(a.projectId).calls.plan, [], 'Does not claim plan');

    // node.hello: records on document service side (role.node) and nodes in queues of each space
    const hellos = svc.logs.filter((l) => l.event === 'role.node');
    assert.equal(hellos.length, 2, `node.hello twice: ${JSON.stringify(hellos)}`);
    for (const h of hellos) {
      assert.equal(h.profile, 'host');
      assert.equal(h.userId, `renderbox@${device}`, 'Identity is "username@device"');
    }
  } finally {
    host?.shutdown();
    for (const ep of endpoints) ep.close();
    for (const p of pages) p.close?.();
    await svc.close();
  }
});

test('RH2 node.hello fields of a host node (profile / codeVersions / capabilities / maxConcurrent)', async () => {
  const env = createSpaces(['proj-a', 'proj-b']);
  const host = hostOn(env, { projectIds: ['proj-a', 'proj-b'], cap: 3 });
  host.start();
  await env.settle();
  for (const [index, projectId] of ['proj-a', 'proj-b'].entries()) {
    const hello = env.spaces.get(projectId).sent(`host-${index}`).find((m) => m.type === 'node.hello');
    assert.ok(hello, `${projectId} checked in`);
    assert.equal(hello.profile, 'host');
    assert.deepEqual(hello.codeVersions, [CV], 'One code version per instance');
    assert.deepEqual(hello.capabilities, { ...HOST_CAPABILITIES }, 'Capabilities are the same as PC');
    assert.deepEqual(hello.capabilities, { userCards: true, graphCards: false });
    assert.equal(hello.envFingerprint, FP);
    assert.equal(hello.maxConcurrent, 3);
    assert.equal(hello.nodeId, `host:test/p${index}`);
  }
  env.hygiene();
  host.shutdown();
});

/* ================================================================== RH3 */

test('RH3 plan skipping: when host sees a plan it sends no claim and claims only fine-grained tasks; a pc node on the same queue claims the plan as usual', async () => {
  assert.deepEqual(checkClaimable({ ...planTaskOf({ projectId: 'p', projectRev: 1, codeVersion: CV }), state: 'open', version: 1 },
    { profile: 'host', envFingerprint: FP, codeVersions: [CV], capabilities: HOST_CAPABILITIES }), { ok: false, rule: 6, reason: 'plan-on-host' });

  const env = createSpaces(['proj-a']);
  const space = env.spaces.get('proj-a');
  const executor = fakeExecutor();
  const host = hostOn(env, { projectIds: ['proj-a'], cap: 2, executors: new Map([['proj-a', executor]]) });
  host.start();
  const plan = planTaskOf({ projectId: 'proj-a', projectRev: 1, codeVersion: CV, envFingerprint: FP });
  plan.priority = 100;   // Placed first: if host does not skip, it will definitely claim it first
  const fine = fineTask('proj-a', 'rh3');
  space.publish([plan, fine]);
  await drive(env, () => host.tick(), () => space.doneCount(fine.id) === 1);
  for (let i = 0; i < 20; i++) { await env.settle(); host.tick(); env.clock.advance(STEP_MS); }
  await env.settle();
  const claims = space.sent('host-0').filter((m) => m.type === 'task.claim').map((m) => m.id);
  assert.deepEqual(claims, [fine.id], 'host claimed only fine-grained tasks');
  assert.deepEqual(executor.calls.plan, [], 'The executor plan was never called');
  assert.equal(space.task(plan.id).state, 'open', 'plan stays in the queue');
  assert.ok(host.nodes()[0].seen >= 2, 'plan is visible, it is just not claimed');

  // Control: pc node claims plan on the same queue
  const pcEndpoint = space.lb.connect('pc-0', { userId: 'alice@pc-device-000001', tenantId: 'proj-a' });
  const pc = createLocalNode({
    nodeId: 'pc-0', node: { profile: 'pc', envFingerprint: FP, codeVersions: [CV], capabilities: HOST_CAPABILITIES },
    endpoint: pcEndpoint, now: env.clock.now, random: () => 0, isIdle: () => true, maxConcurrent: 1, codeVersion: CV,
    executor: { plan: async () => ({ entryKey: 'e', cardPlan: [] }), render: async () => null }, sink: fakeSink(),
  });
  pc.start();
  await drive(env, () => { host.tick(); pc.tick(); }, () => space.doneCount(plan.id) === 1);
  assert.deepEqual(space.sent('pc-0').filter((m) => m.type === 'task.claim').map((m) => m.id), [plan.id], 'pc claimed plan');
  assert.deepEqual(space.sent('host-0').filter((m) => m.type === 'task.claim').map((m) => m.id), [fine.id], 'host never claimed plan');
  env.hygiene();
  host.shutdown();
  pc.stop();
});

/* ================================================================== RH4 */

for (const cap of [1, 2]) {
  test(`RH4 concurrency limit maxConcurrent=${cap}: two projects with 6 tasks in total, and held + in flight across all nodes never exceeds ${cap} on any tick and does reach ${cap}`, async () => {
    const projectIds = ['proj-a', 'proj-b'];
    const env = createSpaces(projectIds);
    const executors = new Map(projectIds.map((p) => [p, fakeExecutor({ hang: true })]));
    const host = hostOn(env, { projectIds, cap, executors });
    host.start();
    for (const p of projectIds) env.spaces.get(p).publish([fineTask(p, 'x'), fineTask(p, 'y'), fineTask(p, 'z')]);
    let peak = 0;
    let peakQueue = 0;
    for (let i = 0; i < 80; i++) {
      await env.settle();
      host.tick();
      assert.ok(host.busy() <= cap, `Tick ${i}: held + in flight ${host.busy()} exceeds ${cap}`);
      peak = Math.max(peak, host.busy());
      await env.settle();
      for (const s of env.all) s.queue.tick();
      const claimedInQueues = env.all.reduce((n, s) => n + s.queue.describe().tasks.filter((t) => t.state === 'claimed').length, 0);
      assert.ok(claimedInQueues <= cap, `Tick ${i}: ${claimedInQueues} claimed in the queue exceeds ${cap}`);
      peakQueue = Math.max(peakQueue, claimedInQueues);
      env.clock.advance(STEP_MS);
    }
    assert.equal(peak, cap, 'The limit is fully used');
    assert.equal(peakQueue, cap, 'On the queue side, the number claimed at the same time also reaches the limit');
    const rendering = [...executors.values()].reduce((n, e) => n + e.calls.render.length, 0);
    assert.equal(rendering, cap, `Only ${cap} are rendering at the same time (the executor is stuck and does not return)`);
    assert.equal(host.maxConcurrent, cap);
    env.hygiene();
    host.shutdown();
  });
}

test('RH4 the concurrency limit does not exceed 4: 9 is a config error (integration ruling, no truncation)', () => {
  const env = createSpaces(['proj-a']);
  assert.throws(() => hostOn(env, { projectIds: ['proj-a'], cap: 9 }), { code: 'bad-host-config' });
  assert.equal(hostOn(env, { projectIds: ['proj-a'], cap: 4 }).maxConcurrent, 4);
});

/* ================================================================== RH5 */

test('RH5 release claims on exit: each held claim sends task.release, the queue puts the task back to open immediately, other nodes can claim it right away; the execution is aborted', async () => {
  const projectIds = ['proj-a', 'proj-b'];
  const env = createSpaces(projectIds);
  const executors = new Map(projectIds.map((p) => [p, fakeExecutor({ hang: true })]));
  const host = hostOn(env, { projectIds, cap: 2, executors });
  host.start();
  const tasks = new Map(projectIds.map((p) => [p, fineTask(p, 'rh5')]));
  for (const p of projectIds) env.spaces.get(p).publish([tasks.get(p)]);
  await drive(env, () => host.tick(), () => projectIds.every((p) => env.spaces.get(p).task(tasks.get(p).id)?.state === 'claimed'));
  assert.equal(host.busy(), 2);

  const released = host.shutdown('shutdown');
  assert.equal(released, 2, 'Two claims released');
  await env.settle();
  for (const [index, p] of projectIds.entries()) {
    const releases = env.spaces.get(p).sent(`host-${index}`).filter((m) => m.type === 'task.release');
    assert.deepEqual(releases.map((m) => [m.id, m.reason]), [[tasks.get(p).id, 'shutdown']], `${p}: task.release sent`);
    assert.equal(env.spaces.get(p).task(tasks.get(p).id).state, 'open', `${p}: the queue puts it back to open immediately (no disconnect, no reliance on the grace period)`);
    assert.deepEqual(executors.get(p).calls.aborted, [tasks.get(p).id], `${p}: the running execution is aborted`);
  }
  await host.settled();   // Stuck executor can also settle after being aborted
  assert.equal(host.busy(), 0);

  // Yielded tasks can be immediately claimed by other nodes
  const space = env.spaces.get('proj-a');
  const other = createLocalNode({
    nodeId: 'other', node: { profile: 'host', envFingerprint: FP, codeVersions: [CV], capabilities: HOST_CAPABILITIES },
    endpoint: space.lb.connect('other', { userId: 'bob@other-device-000001', tenantId: 'proj-a' }), now: env.clock.now, random: () => 0,
    isIdle: () => true, maxConcurrent: 1, codeVersion: CV, executor: fakeExecutor(), sink: fakeSink(),
  });
  other.start();
  await drive(env, () => { host.tick(); other.tick(); }, () => space.doneCount(tasks.get('proj-a').id) === 1, 20);
  // Stopped host will not send any more claims afterwards
  const claimsAfterStop = space.sent('host-0').filter((m) => m.type === 'task.claim').length;
  assert.equal(claimsAfterStop, 1, 'host no longer claims after it stops');
  env.hygiene();
  other.stop();
});

/* ================================================================== RH6 */

test('RH6 code version filtering is unchanged: a host with a different codeVersion sees the task but claims it 0 times', async () => {
  const env = createSpaces(['proj-a']);
  const space = env.spaces.get('proj-a');
  const stale = hostOn(env, { projectIds: ['proj-a'], cv: 'other-code-version' });
  stale.start();
  const task = fineTask('proj-a', 'rh6');
  space.publish([task]);
  // M6c X3: host only knows which project has work via summaries sent by queue ticks;
  // here the queue is also ticked on every tick (previously only advanced clock)
  for (let i = 0; i < 20; i++) { await env.settle(); stale.tick(); for (const s of env.all) s.queue.tick(); env.clock.advance(STEP_MS); }
  await env.settle();
  assert.equal(stale.nodes()[0].seen, 1, 'Can see it');
  assert.equal(stale.nodes()[0].claimed, 0, '0 claims');
  assert.equal(space.sent('host-0').filter((m) => m.type === 'task.claim').length, 0, 'no claim was sent at all');
  assert.equal(space.task(task.id).state, 'open');
  env.hygiene();
  stale.shutdown();
});

/* ================================================================== RH-fallback-ticket */

test('RH-fallback-ticket asset fallback picks the ticket by base URL: each of the two asset services accepts only its own ticket, and reading from the second one uses the ticket of the second project (no longer 401)', async (t) => {
  const harness = createAssetHarness();
  t.after(() => harness.cleanup());
  const client = await import(harness.compileTs(path.join(ROOT, 'server', 'asset-client.ts')));
  // Two asset services, their respective ticket issuers (different projects, different keys),
  // both treat source as remote (requiring tickets)
  const kitA = await assetTicketKit();
  const kitB = await assetTicketKit();
  const svcA = await harness.serve({ chunkSize: 1024, isTrusted: () => false, tickets: kitA.tickets });
  const svcB = await harness.serve({ chunkSize: 1024, isTrusted: () => false, tickets: kitB.tickets });
  // Asset is only on B
  const buf = crypto.randomBytes(3000);
  const hash = crypto.createHash('sha256').update(buf).digest('hex');
  const rwB = kitB.issue('rw');
  for (let n = 0; n < 3; n++) {
    const r = await fetch(`${svcB.base}/media/${hash}/${n}`, { method: 'PUT', body: buf.subarray(n * 1024, (n + 1) * 1024), headers: { 'X-Media-Size': String(buf.length), Authorization: `Bearer ${rwB}` } });
    assert.equal(r.status, 200);
  }
  assert.equal((await fetch(`${svcB.base}/media/${hash}/complete`, { method: 'POST', headers: { Authorization: `Bearer ${rwB}` } })).status, 200);
  // Primary source always returns 404, falls back
  const primary = http.createServer((req, res) => { res.statusCode = 404; res.end('nope'); });
  await new Promise((resolve) => primary.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => primary.close(() => resolve())));
  let fn;
  client.assetProxyPlugin(`http://127.0.0.1:${primary.address().port}`).configureServer({ middlewares: { use(f) { fn = f; } } });
  const proxy = http.createServer((req, res) => fn(req, res, () => { res.statusCode = 418; res.end(); }));
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { proxy.closeAllConnections?.(); proxy.close(() => resolve()); }));
  const via = `http://127.0.0.1:${proxy.address().port}/@media/${hash}`;
  client.setMediaFallbackBases([svcA.base, `${svcB.base}/`]);
  t.after(() => { client.setMediaFallbackBases([]); client.setMediaFallbackTicket(null); });

  // Behavior before fix: always use first project's ticket → B rejects with 401 after A returns 404
  const asked = [];
  client.setMediaFallbackTicket(async () => kitA.issue('r'));
  assert.equal((await fetch(via)).status, 401, 'Control: with only the ticket of the first project, the second asset service returns 401');

  // Pick by base URL: A uses A's ticket (valid, does not have this asset → 404, try next),
  // B uses B's ticket
  const records = [
    { base: () => svcA.base, ticket: async () => { asked.push('A'); return kitA.issue('r'); } },
    { base: () => `${svcB.base}/`, ticket: async () => { asked.push('B'); return kitB.issue('r'); } },
  ];
  const pick = fallbackTicketFor(records);
  assert.equal(pick('http://127.0.0.1:1/api/asset'), null, 'A base URL that belongs to no project carries no ticket');
  client.setMediaFallbackTicket(pick);
  const got = await fetch(via, { headers: { Range: 'bytes=0-9' } });
  assert.equal(got.status, 206);
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), buf.subarray(0, 10));
  assert.deepEqual(asked, ['A', 'B'], 'A ticket is requested once per fallback base URL, and it is the ticket of the project that base URL belongs to');
});
