/**
 * C10 online page publishes `plan` task (`docs/plan/c10-contract.md` Section 7;
 * `distributed-prerender-queue.md` Section 2).
 * Run: node --test server/test/c10-plan-publish.test.mjs
 *
 *   C10-PP-01 Does not publish before measurement settles (no matter how many changes);
 *   C10-PP-02 Publishes one `task.publish` after measurement settles: render queue recognizes it
 *             (`parseInbound`), `tasks[0]` is `plan`, `resultKey` = `<projectId>@<projectRev>`; not
 *             published immediately, but after debounce;
 *   C10-PP-03 Debounce: multiple consecutive changes only publish once, carrying the latest version;
 *   C10-PP-04 Changes after publishing: republish;
 *   C10-PP-05 No error if unclaimed: response `task.published` but never `task.done`, response is
 *             `error`, connection disconnected (`send` returns false), response never arrives: none
 *             throw, no unhandled rejections, subsequent changes republish as usual;
 *   C10-PP-06 No longer publishes after `dispose()`.
 *
 * Advance time with `mock.timers` (does not check wall clock, avoids false positives on busy
 * machines). Assumptions see K6 in `c10-kit.mjs`. Skip entire group when implementation is absent.
 */
import test, { mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { planGate, importRepo, pickMethod, PLAN_METHODS, planFactoryDeps, planKeyBase } from './c10-kit.mjs';
import { parseInbound } from '../render-queue/messages.mjs';

const gate = planGate();
const it = (name, fn) => test(name, { skip: gate.ok ? false : gate.reason }, fn);

const unhandled = [];
const onUnhandled = (err) => unhandled.push(err);
process.on('unhandledRejection', onUnhandled);
afterEach(() => { mock.timers.reset(); });

/** Mock connection: records outgoing messages; `reply(msg)` replies per policy */
function fakeEndpoint({ connected = true, reply = 'published' } = {}) {
  const ep = { sent: [], handlers: [], connected };
  ep.send = (msg) => {
    if (!ep.connected) return false;
    ep.sent.push(msg);
    const reqId = msg?.reqId;
    const task = msg?.tasks?.[0];
    if (reply === 'published') {
      queueMicrotask(() => ep.emit({ type: 'task.published', reqId, results: [{ id: task?.id, state: 'open', created: true }] }));
    } else if (reply === 'error') {
      queueMicrotask(() => ep.emit({ type: 'error', reqId, reason: 'no-node', detail: 'No node' }));
    }
    return true;
  };
  ep.onMessage = (h) => { ep.handlers.push(h); return () => {}; };
  ep.emit = (m) => { for (const h of ep.handlers) h(m); };
  ep.publishes = () => ep.sent.filter((m) => m?.type === 'task.publish');
  return ep;
}

async function makePublisher(endpoint) {
  const mod = await importRepo(gate.file);
  const pub = mod[gate.name](planFactoryDeps({ endpoint }));
  assert.ok(pub && typeof pub === 'object', `Assumption K6: ${gate.name}() should return an object`);
  const m = {};
  for (const [k, names] of Object.entries(PLAN_METHODS)) {
    m[k] = pickMethod(pub, names);
    assert.ok(m[k], `Assumption K6: ${k} not found on the publisher (candidates ${names.join(' / ')}); available: ${Object.keys(pub).join(', ')}`);
  }
  return {
    measured: (v) => pub[m.measured](v),
    changed: (v) => pub[m.changed](v),
    dispose: () => pub[m.dispose](),
  };
}

const flush = async (ms = 60_000) => {
  mock.timers.tick(ms);
  for (let i = 0; i < 5; i++) await Promise.resolve();
};
const P = 'proj-c10';
const rev = (n) => ({ projectId: P, projectRev: n });

function assertPlan(msg, n) {
  const parsed = parseInbound(msg);
  assert.ok(parsed.ok, `The render queue does not accept this message: ${parsed.detail}; ${JSON.stringify(msg)}`);
  assert.equal(parsed.type, 'task.publish');
  const task = parsed.body.tasks?.[0] ?? msg.tasks[0];
  assert.equal(msg.tasks[0].kind, 'plan');
  assert.equal(planKeyBase(msg.tasks[0].resultKey), `${P}@${n}`);
  assert.equal(task.source?.projectRev ?? msg.tasks[0].source.projectRev, n);
}

it('C10-PP-01 nothing is published before the measurement settles', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const ep = fakeEndpoint();
  const pub = await makePublisher(ep);
  pub.changed(rev(1));
  pub.changed(rev(2));
  await flush();
  assert.equal(ep.publishes().length, 0);
  pub.dispose();
});

it('C10-PP-02 after the measurement settles, one plan is published with debounce, and the queue recognizes it', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const ep = fakeEndpoint();
  const pub = await makePublisher(ep);
  pub.measured(rev(5));
  await Promise.resolve();
  assert.equal(ep.publishes().length, 0, 'Not published immediately (debounced)');
  await flush();
  assert.equal(ep.publishes().length, 1);
  assertPlan(ep.publishes()[0], 5);
  pub.dispose();
});

it('C10-PP-03 debounce: several consecutive changes publish only once, carrying the last version', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const ep = fakeEndpoint();
  const pub = await makePublisher(ep);
  pub.measured(rev(5));
  await flush();
  for (const n of [6, 7, 8]) {
    pub.changed(rev(n));
    mock.timers.tick(1);
  }
  await flush();
  assert.equal(ep.publishes().length, 2, `One publish for the measurement settling + one for the change after the debounce, got ${ep.publishes().length}`);
  assertPlan(ep.publishes()[1], 8);
  pub.dispose();
});

it('C10-PP-04 a change after a publish: republish', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const ep = fakeEndpoint();
  const pub = await makePublisher(ep);
  pub.measured(rev(1));
  await flush();
  pub.changed(rev(2));
  await flush();
  pub.changed(rev(3));
  await flush();
  assert.deepEqual(ep.publishes().map((m) => planKeyBase(m.tasks[0].resultKey)), [`${P}@1`, `${P}@2`, `${P}@3`]);
  pub.dispose();
});

it('C10-PP-05 no claimer is not an error: no throw, no unhandled rejection, and republishing continues as usual afterwards', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const before = unhandled.length;
  for (const opts of [{ reply: 'published' }, { reply: 'error' }, { reply: 'silent' }, { connected: false }]) {
    const ep = fakeEndpoint(opts);
    const pub = await makePublisher(ep);
    assert.doesNotThrow(() => pub.measured(rev(1)));
    await flush(600_000); // Ten minutes: no claims, no responses, nothing should go wrong
    ep.connected = true;
    assert.doesNotThrow(() => pub.changed(rev(2)));
    await flush(600_000);
    assert.ok(ep.publishes().some((m) => planKeyBase(m.tasks[0].resultKey) === `${P}@2`), `${JSON.stringify(opts)}: later changes are published as usual`);
    pub.dispose();
  }
  mock.timers.reset();
  await new Promise((r) => setImmediate(r));
  assert.equal(unhandled.length, before, `Unhandled rejection occurred: ${unhandled.slice(before).map(String).join('; ')}`);
});

it('C10-PP-06 nothing is published after dispose()', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const ep = fakeEndpoint();
  const pub = await makePublisher(ep);
  pub.measured(rev(1));
  pub.dispose();
  await flush();
  assert.equal(ep.publishes().length, 0);
});
