/**
 * Session diagnostics and session log throttling for node endpoints
 * (`server/render-node/session-diag.mjs`, report `docs/archive/agent-reports/AGENT-host-diag.md`).
 * Run: node --test server/test/session-diag.test.mjs
 *
 * Counts run against real document service (fronted by session gateway in `session-gateway-kit.mjs`,
 * disconnection uses TCP proxy in `fake-ws-kit.mjs`, same suite as `session-link.test.mjs`):
 * sever transport once → resume +1, detach +1, no rebuild; server ends session → close code and
 * reason, rebuild +1; server changed → resume rejected +1. Also tests throttling, line-by-line
 * forwarding, host status lines, and that diagnostics and logs contain no credentials or session ids.
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

/**
 * Session gateway + TCP proxy + endpoint; auth list includes a random "credential" to check
 * whether it entered diagnostics and logs
 */
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
  await waitFor(() => opens === 1, 10_000, 'session created');
  return { doc, gw, proxy, ep, lines, secret, opens: () => opens };
}

test('SD-cut cut the transport once: resume +1, detach +1, 1 established, not rebuilt, nothing lost; lastDetach is 1006; the log has detach / resume and contains no credentials or session id', async (t) => {
  const { gw, proxy, ep, lines, secret } = await rig(t);
  const before = sessionCountersOf(ep);
  assert.deepEqual(
    { opens: before.opens, resumes: before.resumes, detaches: before.detaches, renews: before.renews, lost: before.lost, closes: before.closes },
    { opens: 1, resumes: 0, detaches: 0, renews: 0, lost: 0, closes: 0 },
  );
  assert.equal(before.lastClose, null);
  proxy.cutAll();
  await waitFor(() => sessionCountersOf(ep).resumes === 1, 5000, 'resumed');
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
  assert.ok(!text.includes(secret), 'No credentials in diagnostics or logs');
  assert.ok(!text.includes(sid), 'No session id in diagnostics or logs');
});

test('SD-end the server ends the session with 4003: closes +1, lastClose { 4003, kicked }, then rebuild +1', async (t) => {
  const { gw, ep, opens } = await rig(t);
  gw.endAll(4003, 'kicked');
  await waitFor(() => opens() === 2, 5000, 'session rebuilt');
  const c = sessionCountersOf(ep);
  assert.equal(c.closes, 1);
  assert.equal(c.opens, 2);
  assert.equal(c.renews, 1);
  assert.equal(c.resumes, 0);
  assert.equal(c.lastClose.code, 4003);
  assert.equal(c.lastClose.reason, 'kicked');
});

test('SD-lost swapped to a different server: resume rejected with 4404, lost +1, lastClose 4404, rebuild +1', async (t) => {
  const { proxy, ep, opens } = await rig(t);
  const doc2 = await startDoc(t);
  const gw2 = await startSessionGateway({ upstream: doc2.url });
  t.after(() => gw2.close());
  proxy.retarget(gw2.port);
  proxy.cutAll();
  await waitFor(() => opens() === 2, 5000, 'session rebuilt on the new service');
  const c = sessionCountersOf(ep);
  assert.equal(c.lost, 1);
  assert.equal(c.detaches, 1);
  assert.equal(c.renews, 1);
  assert.equal(c.lastClose.code, 4404);
});

test('SD-no-stats endpoint without stats(): counts are null, diagnostics empty', () => {
  assert.equal(sessionCountersOf({}), null);
  assert.deepEqual(sessionDiagOf(null), {});
  // Old endpoints (only items prior to HT-a) default missing counts to 0
  const c = sessionCountersOf({ stats: () => ({ resumes: 2, opens: 1 }) });
  assert.equal(c.resumes, 2);
  assert.equal(c.renews, 0);
  assert.equal(c.lastClose, null);
});

test('SD-throttle throttling: each key allows burst entries per window, suppressed ones are carried out with the next one, and counting restarts after the window passes', () => {
  let t = 0;
  const th = createLogThrottle({ burst: 2, windowMs: 1000, now: () => t });
  assert.deepEqual(th.take('a'), { suppressed: 0 });
  assert.deepEqual(th.take('a'), { suppressed: 0 });
  assert.equal(th.take('a'), null);
  assert.equal(th.take('a'), null);
  assert.deepEqual(th.take('b'), { suppressed: 0 }, 'Other keys are unaffected');
  assert.deepEqual(th.pending(), { a: 2 });
  t = 1000;
  assert.deepEqual(th.take('a'), { suppressed: 2 });
  assert.deepEqual(th.take('a'), { suppressed: 0 });
  assert.deepEqual(th.pending(), {});
});

test('SD-logger session log: only session events, throttled per event, with extra and suppressed; backoff while offline does not flood the log', () => {
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

test('SD-forward the editor process forwards line by line: chunks split mid-line are still reassembled, only session event lines are forwarded, throttled per event', () => {
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

test('SD-status host status line: key changes only when a count changes; carries only projectId, nodeId, connected, transport, session', () => {
  const session = { opens: 1, resumes: 0, detaches: 0, renews: 0, lost: 0, expired: 0, connectFails: 0, closes: 0, dropped: 0, detached: false, lastClose: null, lastDetach: null };
  const summary = (s) => ({ profile: 'host', nodes: [{ projectId: 'p1', nodeId: 'host:x/p0', connected: true, transport: 'ws', claimed: 3, assetBase: 'http://a', session: s }] });
  const a = sessionStatusOf(summary(session));
  const b = sessionStatusOf({ ...summary(session), nodes: [{ ...summary(session).nodes[0], claimed: 9 }] });
  assert.equal(a.key, b.key, 'Changes in the claim count do not count');
  const c = sessionStatusOf(summary({ ...session, resumes: 1, detaches: 1 }));
  assert.notEqual(a.key, c.key);
  assert.deepEqual(Object.keys(c.status.nodes[0]).sort(), ['connected', 'nodeId', 'projectId', 'session', 'transport']);
  assert.deepEqual(sessionStatusOf(null).status, { nodes: [] });
});
