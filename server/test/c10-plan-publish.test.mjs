/**
 * C10 在线页面发布 `plan` 任务（`docs/plan/c10-contract.md` 第 7 节；`distributed-prerender-queue.md` 第 2 节）。
 * 跑：node --test server/test/c10-plan-publish.test.mjs
 *
 *   C10-PP-01 测量落定之前不发（改动再多也不发）；
 *   C10-PP-02 测量落定后发一个 `task.publish`：渲染任务队列认得（`parseInbound`），`tasks[0]` 是 `plan`，
 *             `resultKey` = `<projectId>@<projectRev>`；不是当场发，而是防抖之后；
 *   C10-PP-03 防抖：连续几次改动只发一次，带最后那一版；
 *   C10-PP-04 发过之后再改：重发；
 *   C10-PP-05 没人认领不报错：回包 `task.published` 但一直没有 `task.done`、回包是 `error`、连接断着（`send` 回 false）、
 *             回包一直不来——都不抛、没有未处理的拒绝，之后的改动照常重发；
 *   C10-PP-06 `dispose()` 之后不再发。
 *
 * 时间用 `mock.timers` 推（不看墙钟，忙机上不误报）。假设见 `c10-kit.mjs` 的 K6。实现不在时整组 skip。
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

/** 假连接：记下发出的消息；`reply(msg)` 按策略回包 */
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
      queueMicrotask(() => ep.emit({ type: 'error', reqId, reason: 'no-node', detail: '没有节点' }));
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
  assert.ok(pub && typeof pub === 'object', `假设 K6：${gate.name}() 应回对象`);
  const m = {};
  for (const [k, names] of Object.entries(PLAN_METHODS)) {
    m[k] = pickMethod(pub, names);
    assert.ok(m[k], `假设 K6：发布器上找不到 ${k}（候选 ${names.join(' / ')}）；有的：${Object.keys(pub).join(', ')}`);
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
  assert.ok(parsed.ok, `渲染任务队列不认这条消息：${parsed.detail}；${JSON.stringify(msg)}`);
  assert.equal(parsed.type, 'task.publish');
  const task = parsed.body.tasks?.[0] ?? msg.tasks[0];
  assert.equal(msg.tasks[0].kind, 'plan');
  assert.equal(planKeyBase(msg.tasks[0].resultKey), `${P}@${n}`);
  assert.equal(task.source?.projectRev ?? msg.tasks[0].source.projectRev, n);
}

it('C10-PP-01 测量落定之前不发', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const ep = fakeEndpoint();
  const pub = await makePublisher(ep);
  pub.changed(rev(1));
  pub.changed(rev(2));
  await flush();
  assert.equal(ep.publishes().length, 0);
  pub.dispose();
});

it('C10-PP-02 测量落定后防抖发一个 plan，队列认得', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const ep = fakeEndpoint();
  const pub = await makePublisher(ep);
  pub.measured(rev(5));
  await Promise.resolve();
  assert.equal(ep.publishes().length, 0, '不是当场发（防抖）');
  await flush();
  assert.equal(ep.publishes().length, 1);
  assertPlan(ep.publishes()[0], 5);
  pub.dispose();
});

it('C10-PP-03 防抖：连续几次改动只发一次，带最后那一版', async () => {
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
  assert.equal(ep.publishes().length, 2, `一次测量落定 + 一次防抖后的改动，实际 ${ep.publishes().length}`);
  assertPlan(ep.publishes()[1], 8);
  pub.dispose();
});

it('C10-PP-04 发过之后再改：重发', async () => {
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

it('C10-PP-05 没人认领不报错：不抛、没有未处理的拒绝，之后照常重发', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const before = unhandled.length;
  for (const opts of [{ reply: 'published' }, { reply: 'error' }, { reply: 'silent' }, { connected: false }]) {
    const ep = fakeEndpoint(opts);
    const pub = await makePublisher(ep);
    assert.doesNotThrow(() => pub.measured(rev(1)));
    await flush(600_000); // 十分钟：没人认领、回包不来也不该出事
    ep.connected = true;
    assert.doesNotThrow(() => pub.changed(rev(2)));
    await flush(600_000);
    assert.ok(ep.publishes().some((m) => planKeyBase(m.tasks[0].resultKey) === `${P}@2`), `${JSON.stringify(opts)}：之后的改动照常发`);
    pub.dispose();
  }
  mock.timers.reset();
  await new Promise((r) => setImmediate(r));
  assert.equal(unhandled.length, before, `出现了未处理的拒绝：${unhandled.slice(before).map(String).join('; ')}`);
});

it('C10-PP-06 dispose() 之后不再发', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const ep = fakeEndpoint();
  const pub = await makePublisher(ep);
  pub.measured(rev(1));
  pub.dispose();
  await flush();
  assert.equal(ep.publishes().length, 0);
});
