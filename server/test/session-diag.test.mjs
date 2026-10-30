/**
 * 节点端点的会话诊断与会话日志节流（`server/render-node/session-diag.mjs`，报告 `docs/archive/agent-reports/AGENT-host-diag.md`）。
 * 跑：node --test server/test/session-diag.test.mjs
 *
 * 计数对着真的文档服务跑（前面挡 `session-gateway-kit.mjs` 的会话网关，断线用 `fake-ws-kit.mjs` 的 TCP 代理，
 * 与 `session-link.test.mjs` 同一套）：掐一次传输 → 接续 +1、脱开 +1、不重建；服务端结束会话 → 关闭码与原因、重建 +1；
 * 换了服务端 → 接续被拒 +1。另测节流、按行转发、主机状态行，以及诊断与日志里没有凭证与会话号。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocService } from '../docservice/service.mjs';
import { createDocEndpoint } from '../render-node/session-link.mjs';
import {
  createLogThrottle, sessionLogger, sessionCountersOf, sessionDiagOf, createSessionLineForwarder, sessionStatusOf, SESSION_FORWARD_EVENTS,
} from '../render-node/session-diag.mjs';
import { createTcpProxy, waitFor, randomToken } from './fake-ws-kit.mjs';
import { startSessionGateway } from './session-gateway-kit.mjs';

const BACKOFF = { baseMs: 20, factor: 2, maxMs: 100, jitter: 0 };

async function startDoc(t) {
  const service = createDocService({ log: () => {}, autoTick: false, modules: [], authenticate: () => ({ userId: 'u-sd', tenantId: 't-sd' }) });
  const { port } = await service.listen(0, '127.0.0.1');
  t.after(() => service.close());
  return { service, url: `ws://127.0.0.1:${port}/` };
}

/** 会话网关 + TCP 代理 + 端点；鉴权列表里带一个随机「凭证」，用来查它进没进诊断与日志 */
async function rig(t) {
  const doc = await startDoc(t);
  const gw = await startSessionGateway({ upstream: doc.url });
  t.after(() => gw.close());
  const proxy = await createTcpProxy({ target: gw.port });
  t.after(() => proxy.close());
  const secret = randomToken();
  const lines = [];
  const log = sessionLogger((event, fields) => lines.push({ event, ...fields }), { extra: { project: 0 } });
  const ep = createDocEndpoint({
    url: `http://127.0.0.1:${proxy.port}/?k=${secret}`,
    protocols: () => ['promptcut.v1', `promptcut.token.${secret}`],
    backoff: BACKOFF,
    transport: 'ws',
    log,
  });
  t.after(() => ep.close());
  let opens = 0;
  ep.onOpen(() => { opens += 1; });
  await waitFor(() => opens === 1, 10_000, '建会话');
  return { doc, gw, proxy, ep, lines, secret, opens: () => opens };
}

test('SD-cut 掐一次传输：接续 +1、脱开 +1、建立 1、不重建、不丢；lastDetach 是 1006；日志有 detach / resume 且不含凭证与会话号', async (t) => {
  const { gw, proxy, ep, lines, secret } = await rig(t);
  const before = sessionCountersOf(ep);
  assert.deepEqual(
    { opens: before.opens, resumes: before.resumes, detaches: before.detaches, renews: before.renews, lost: before.lost, closes: before.closes },
    { opens: 1, resumes: 0, detaches: 0, renews: 0, lost: 0, closes: 0 },
  );
  assert.equal(before.lastClose, null);
  proxy.cutAll();
  await waitFor(() => sessionCountersOf(ep).resumes === 1, 5000, '接续');
  const after = sessionCountersOf(ep);
  assert.equal(after.opens, 1);
  assert.equal(after.detaches, 1);
  assert.equal(after.renews, 0);
  assert.equal(after.lost, 0);
  assert.equal(after.closes, 0);
  assert.equal(after.detached, false);
  assert.equal(after.lastDetach.code, 1006);
  assert.ok(Number.isFinite(after.lastDetach.at));
  const diag = sessionDiagOf(ep);
  assert.equal(diag.transport, 'ws');
  assert.equal(diag.resumes, 1);
  assert.equal(diag.legacy, false);
  assert.deepEqual(diag.session, after);
  assert.ok(lines.some((l) => l.event === 'session.detach' && l.project === 0));
  assert.ok(lines.some((l) => l.event === 'session.resume' && Number.isFinite(l.gapMs)));
  const sid = [...gw.sessions.keys()][0];
  const text = JSON.stringify({ diag, lines });
  assert.ok(!text.includes(secret), '诊断与日志里没有凭证');
  assert.ok(!text.includes(sid), '诊断与日志里没有会话号');
});

test('SD-end 服务端以 4003 结束会话：closes +1、lastClose { 4003, kicked }，之后重建 +1', async (t) => {
  const { gw, ep, opens } = await rig(t);
  gw.endAll(4003, 'kicked');
  await waitFor(() => opens() === 2, 5000, '重建会话');
  const c = sessionCountersOf(ep);
  assert.equal(c.closes, 1);
  assert.equal(c.opens, 2);
  assert.equal(c.renews, 1);
  assert.equal(c.resumes, 0);
  assert.equal(c.lastClose.code, 4003);
  assert.equal(c.lastClose.reason, 'kicked');
});

test('SD-lost 换了一个服务端：接续被 4404 拒，lost +1、lastClose 4404，重建 +1', async (t) => {
  const { proxy, ep, opens } = await rig(t);
  const doc2 = await startDoc(t);
  const gw2 = await startSessionGateway({ upstream: doc2.url });
  t.after(() => gw2.close());
  proxy.retarget(gw2.port);
  proxy.cutAll();
  await waitFor(() => opens() === 2, 5000, '在新服务上重建会话');
  const c = sessionCountersOf(ep);
  assert.equal(c.lost, 1);
  assert.equal(c.detaches, 1);
  assert.equal(c.renews, 1);
  assert.equal(c.lastClose.code, 4404);
});

test('SD-no-stats 没有 stats() 的端点：计数 null、诊断空', () => {
  assert.equal(sessionCountersOf({}), null);
  assert.deepEqual(sessionDiagOf(null), {});
  // 旧端点（只有 HT-a 之前的几项）缺的计数给 0
  const c = sessionCountersOf({ stats: () => ({ resumes: 2, opens: 1 }) });
  assert.equal(c.resumes, 2);
  assert.equal(c.renews, 0);
  assert.equal(c.lastClose, null);
});

test('SD-throttle 节流：每个键一个窗口 burst 条，压下的随下一条带出，窗口过了重新计', () => {
  let t = 0;
  const th = createLogThrottle({ burst: 2, windowMs: 1000, now: () => t });
  assert.deepEqual(th.take('a'), { suppressed: 0 });
  assert.deepEqual(th.take('a'), { suppressed: 0 });
  assert.equal(th.take('a'), null);
  assert.equal(th.take('a'), null);
  assert.deepEqual(th.take('b'), { suppressed: 0 }, '别的键不受影响');
  assert.deepEqual(th.pending(), { a: 2 });
  t = 1000;
  assert.deepEqual(th.take('a'), { suppressed: 2 });
  assert.deepEqual(th.take('a'), { suppressed: 0 });
  assert.deepEqual(th.pending(), {});
});

test('SD-logger 会话日志：只放会话事件，按事件节流，带 extra 与 suppressed；断网时的退避不刷屏', () => {
  let t = 0;
  const out = [];
  const log = sessionLogger((event, fields) => out.push({ event, ...fields }), { extra: { project: 1 }, throttle: createLogThrottle({ burst: 3, windowMs: 60_000, now: () => t }) });
  log('session.retry', { attempt: 0 });
  log('conn.open', {});
  for (let i = 0; i < 100; i++) log('session.connect-failed', { code: 1006 });
  log('session.open', { transport: 'ws' });
  assert.equal(out.filter((l) => l.event === 'session.connect-failed').length, 3);
  assert.equal(out.length, 4);
  assert.ok(out.every((l) => l.project === 1));
  t = 60_000;
  log('session.connect-failed', { code: 1006 });
  assert.deepEqual(out.at(-1), { event: 'session.connect-failed', project: 1, code: 1006, suppressed: 97 });
  for (const e of ['session.open', 'session.close', 'session.detach', 'session.resume', 'session.lost']) assert.ok(SESSION_FORWARD_EVENTS.has(e), e);
});

test('SD-forward 编辑器进程按行转发：块在行中间断开也拼得上，只转会话事件行，按事件节流', () => {
  let t = 0;
  const out = [];
  const fwd = createSessionLineForwarder((line) => out.push(line), { throttle: createLogThrottle({ burst: 2, windowMs: 1000, now: () => t }) });
  fwd('[queue-node] docservice.session.detach {"code":1006}\r\n[queue-node] queue.claimed {"id":"x"}\n[queue-node] docservice.sess');
  fwd('ion.resume {"gapMs":500}\n[artifact-push] docservice.session.open {"transport":"ws"}\n');
  fwd('VITE ready\n');
  assert.deepEqual(out, [
    '[queue-node] docservice.session.detach {"code":1006}',
    '[queue-node] docservice.session.resume {"gapMs":500}',
    '[artifact-push] docservice.session.open {"transport":"ws"}',
  ]);
  for (let i = 0; i < 5; i++) fwd('[queue-node] docservice.session.connect-failed {"code":1006}\n');
  assert.equal(out.filter((l) => l.includes('connect-failed')).length, 2);
  t = 1000;
  fwd('[queue-node] docservice.session.connect-failed {"code":1006}\n');
  assert.equal(out.at(-1), '[queue-node] docservice.session.connect-failed {"code":1006} (suppressed 3)');
});

test('SD-status 主机状态行：只在计数变化时换 key；只带 projectId、nodeId、connected、transport、session', () => {
  const session = { opens: 1, resumes: 0, detaches: 0, renews: 0, lost: 0, expired: 0, connectFails: 0, closes: 0, dropped: 0, detached: false, lastClose: null, lastDetach: null };
  const summary = (s) => ({ profile: 'host', nodes: [{ projectId: 'p1', nodeId: 'host:x/p0', connected: true, transport: 'ws', claimed: 3, assetBase: 'http://a', session: s }] });
  const a = sessionStatusOf(summary(session));
  const b = sessionStatusOf({ ...summary(session), nodes: [{ ...summary(session).nodes[0], claimed: 9 }] });
  assert.equal(a.key, b.key, '认领数变化不算');
  const c = sessionStatusOf(summary({ ...session, resumes: 1, detaches: 1 }));
  assert.notEqual(a.key, c.key);
  assert.deepEqual(Object.keys(c.status.nodes[0]).sort(), ['connected', 'nodeId', 'projectId', 'session', 'transport']);
  assert.deepEqual(sessionStatusOf(null).status, { nodes: [] });
});
