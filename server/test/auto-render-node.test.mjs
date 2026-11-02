/**
 * Desktop app automatically becomes a render node for shared projects: state machine on the prerender
 * process side (`server/auto-render-node.mjs`) and relay on the editor process side
 * (`server/render-node-relay.mjs`). Report `docs/archive/agent-reports/AGENT-desktop-auto-node.md`.
 * Run: node --test server/test/auto-render-node.test.mjs
 *
 *   ARN-01 Switches and environment variables: connects by default; does not connect if
 *          PROMPTCUT_AUTO_RENDER_NODE=0 / headless / PUSH=0 / host tier / node already configured via
 *          environment variable
 *   ARN-02 Shared configuration validation (address, project id, asset base URL), error messages do
 *          not include tickets
 *   ARN-03 Handoff: start once; first session creation uses ticket handed over by page, does not ask
 *          page
 *   ARN-04 Ticket round-trip: only request when current one is stale; request only once when two
 *          connections request simultaneously; cache acquired ticket until near expiration
 *   ARN-05 Ticket unobtainable (page is gone): protocols throws, state "waiting for page"; when page
 *          returns (same project handoff with ticket), resume without recreating
 *   ARN-06 Repeated handoffs for the same project only change asset base URL and project doc id,
 *          without recreating; when switching projects, tear down old first then start new, old link
 *          invalidated
 *   ARN-07 Tear down: only tear down for the same project; state resets to empty after teardown; torn
 *          down during startup, tear down once startup finishes
 *   RLY-01 Relay: send { type: 'ticket', reqId, projectId } via HMR, fulfill once returned by page;
 *          returned error / unqualified → failure
 *   RLY-02 No page connected to HMR: fail immediately, do not send; page not returned in 10 s:
 *          timeout failure; unrecognized reqId is ignored
 *   RLY-03 Configuration retention: do not remember tickets; when tearing down with project id, only
 *          tear down for the same project
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { autoRenderNodeOffReason, createAutoRenderNode, normalizeBinding, TICKET_MIN_LEFT_MS } from '../auto-render-node.mjs';
import { createBindingMemory, createTicketRelay } from '../render-node-relay.mjs';

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
/** Well-shaped fake ticket (only checks expiration, does not verify signature) */
const fakeTicket = (exp, tag = 'x') => `v1.${b64({ k: 'conn', r: 'render', p: 'P1', u: 'u@d', exp, iat: exp - 120_000, tag })}.sig${tag}`;
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };

const BIND = { url: 'wss://site.example/hosted/', projectId: 'P1', assetBase: 'https://site.example/media/api/asset', contentId: 'doc-1' };

function harness({ requestTicket } = {}) {
  let t = 1_000_000;
  const now = () => t;
  const started = [];
  const stopped = [];
  const requests = [];
  const logs = [];
  let startGate = null;
  const ctl = createAutoRenderNode({
    now,
    start: async (link) => { started.push(link); if (startGate) await startGate; return { id: started.length, link }; },
    stop: async (handle, reason) => { stopped.push({ id: handle.id, reason }); },
    requestTicket: requestTicket ?? (async (projectId) => { requests.push(projectId); return fakeTicket(t + 120_000, `r${requests.length}`); }),
    log: (event, fields) => logs.push({ event, fields }),
  });
  return { ctl, started, stopped, requests, logs, advance: (ms) => { t += ms; }, now, gate: (p) => { startGate = p; } };
}

test('ARN-01 switch and environment variables', () => {
  assert.equal(autoRenderNodeOffReason({}), null);
  assert.equal(autoRenderNodeOffReason({ PROMPTCUT_AUTO_RENDER_NODE: '1' }), null);
  assert.equal(autoRenderNodeOffReason({ PROMPTCUT_AUTO_RENDER_NODE: '0' }), 'disabled');
  assert.equal(autoRenderNodeOffReason({ PROMPTCUT_PUSH: '0' }), 'push-disabled');
  assert.equal(autoRenderNodeOffReason({ PROMPTCUT_NODE_PROFILE: 'host' }), 'host-profile');
  assert.equal(autoRenderNodeOffReason({ PROMPTCUT_SHARED_CONFIG: 'x.json' }), 'env-configured');
  assert.equal(autoRenderNodeOffReason({ PROMPTCUT_QUEUE_NODE: '1' }), 'env-configured');
  assert.equal(autoRenderNodeOffReason({ PROMPTCUT_PUSH: '1' }), 'env-configured');
  // Switch takes precedence over others
  assert.equal(autoRenderNodeOffReason({ PROMPTCUT_AUTO_RENDER_NODE: '0', PROMPTCUT_QUEUE_NODE: '1' }), 'disabled');
});

test('ARN-02 validation of the shared config', () => {
  assert.deepEqual(normalizeBinding({ ...BIND, assetBase: 'https://site.example/media/api/asset/' }), BIND);
  assert.deepEqual(normalizeBinding({ url: 'ws://127.0.0.1:5190/docservice', projectId: 'a.b:c-1' }), { url: 'ws://127.0.0.1:5190/docservice', projectId: 'a.b:c-1', assetBase: null, contentId: null });
  assert.throws(() => normalizeBinding({ ...BIND, url: 'http://x/' }), /ws/);
  assert.throws(() => normalizeBinding({ ...BIND, url: 'nope' }), /url/);
  assert.throws(() => normalizeBinding({ ...BIND, projectId: 'bad id' }), /projectId/);
  assert.throws(() => normalizeBinding({ ...BIND, assetBase: 'ftp://x' }), /assetBase/);
  assert.throws(() => normalizeBinding(null), /object/);
  try { normalizeBinding({ ...BIND, projectId: '', ticket: 'v1.SECRET.sig' }); } catch (e) { assert.ok(!String(e.message).includes('SECRET')); }
});

test('ARN-03 handoff: start once, and the first session creation uses the ticket handed over by the page', async () => {
  const h = harness();
  const pageTicket = fakeTicket(h.now() + 120_000, 'page');
  const r = h.ctl.bind(BIND, { ticket: pageTicket });
  assert.equal(r.action, 'started');
  await h.ctl.settled();
  assert.equal(h.started.length, 1);
  const link = h.started[0];
  assert.equal(link.url, BIND.url);
  assert.equal(link.projectId, 'P1');
  assert.equal(link.contentId, 'doc-1');
  assert.equal(link.assetBase(), BIND.assetBase);
  assert.equal(link.alive(), true);
  assert.deepEqual(await link.protocols(), ['promptcut.v1', `promptcut.ticket.${pageTicket}`]);
  assert.equal(h.requests.length, 0, 'The ticket handed over by the page is still fresh: do not ask the page for one');
  const st = h.ctl.status();
  assert.equal(st.bound, true);
  assert.equal(st.started, true);
  assert.ok(!JSON.stringify(st).includes(pageTicket), 'The status carries no ticket');
  assert.ok(!JSON.stringify(h.logs).includes(pageTicket), 'The logs carry no ticket');
});

test('ARN-04 ticket round trip: ask only when it is no longer fresh, ask only once under concurrency, cache the one obtained', async () => {
  const h = harness();
  h.ctl.bind(BIND, { ticket: fakeTicket(h.now() + 120_000, 'page') });
  await h.ctl.settled();
  const link = h.started[0];
  h.advance(120_000 - TICKET_MIN_LEFT_MS + 1); // The one on the page has less than 30 s left
  const [a, b] = await Promise.all([link.protocols(), link.protocols()]);
  assert.equal(h.requests.length, 1, 'Two connections creating sessions at the same time ask the page only once');
  assert.deepEqual(a, b);
  assert.match(a[1], /^promptcut\.ticket\.v1\./);
  assert.ok(a[1].endsWith('sigr1'));
  h.advance(10_000);
  await link.protocols();
  assert.equal(h.requests.length, 1, 'The ticket obtained is still fresh: do not ask again');
  h.advance(100_000);
  const c = await link.protocols();
  assert.equal(h.requests.length, 2);
  assert.ok(c[1].endsWith('sigr2'));
});

test('ARN-05 cannot get a ticket: wait for the page; when the page comes back, resume without rebuilding', async () => {
  let fail = true;
  let n = 0;
  const h = harness({ requestTicket: async () => { n++; if (fail) throw Object.assign(new Error('No page is connected to the editor'), { code: 'no-page' }); return fakeTicket(Date.now() + 1e12, 'late'); } });
  h.ctl.bind(BIND, {});
  await h.ctl.settled();
  const link = h.started[0];
  await assert.rejects(link.protocols(), /No page/);
  await assert.rejects(link.protocols(), /No page/);
  assert.equal(n, 2);
  assert.equal(h.ctl.status().waitingPage, true);
  assert.equal(h.logs.filter((l) => l.event === 'render-node.waiting-page').length, 1, 'The log for waiting on the page does not flood the output');
  // Page returns: hand off the same project again (with ticket)
  const again = fakeTicket(h.now() + 120_000, 'back');
  assert.equal(h.ctl.bind(BIND, { ticket: again }).action, 'same');
  assert.equal(h.ctl.status().waitingPage, false);
  assert.deepEqual(await link.protocols(), ['promptcut.v1', `promptcut.ticket.${again}`]);
  assert.equal(n, 2, 'The ticket handed over by the page is fresh: do not ask again');
  assert.equal(h.started.length, 1, 'Not rebuilt');
  assert.equal(h.stopped.length, 0);
  fail = false;
});

test('ARN-06 same project: only swap the base URL and document id; for a different project, revoke first and then start', async () => {
  const h = harness();
  h.ctl.bind(BIND, { ticket: fakeTicket(h.now() + 120_000) });
  await h.ctl.settled();
  const first = h.started[0];
  assert.equal(h.ctl.bind({ ...BIND, assetBase: 'https://other.example/api/asset', contentId: 'doc-2' }).action, 'same');
  assert.equal(first.assetBase(), 'https://other.example/api/asset');
  // push-scope: contentId on link is fetched on demand (push and publish scope is determined by it;
  // id handed over late from page must be visible)
  assert.equal(first.contentId, 'doc-2', 'The contentId on the link changes with a handoff within the same project');
  assert.equal(h.ctl.status().contentId, 'doc-2');
  // Same project but no base URL provided: reuse the previous one
  h.ctl.bind({ url: BIND.url, projectId: 'P1' });
  assert.equal(first.assetBase(), 'https://other.example/api/asset');
  await h.ctl.settled();
  assert.equal(h.started.length, 1);
  // Switch project
  assert.equal(h.ctl.bind({ ...BIND, projectId: 'P2' }).action, 'rebind');
  assert.equal(first.alive(), false, 'The old link is invalidated on the spot');
  await h.ctl.settled();
  assert.deepEqual(h.stopped, [{ id: 1, reason: 'rebind' }]);
  assert.equal(h.started.length, 2);
  assert.equal(h.started[1].projectId, 'P2');
  await assert.rejects(first.protocols(), /revoked/);
  // Changing document service address also counts as switching projects
  h.ctl.bind({ ...BIND, projectId: 'P2', url: 'ws://192.168.1.5:5190/docservice' });
  await h.ctl.settled();
  assert.equal(h.started.length, 3);
});

test('ARN-07 revoke: only revoke the same project\'s; if revoked during startup, wind down as soon as startup finishes', async () => {
  const h = harness();
  h.ctl.bind(BIND, {});
  await h.ctl.settled();
  assert.equal((await h.ctl.unbind({ projectId: 'OTHER' })).action, 'other-project');
  assert.equal(h.stopped.length, 0);
  const r = await h.ctl.unbind({ projectId: 'P1', reason: 'page-left' });
  assert.equal(r.action, 'stopped');
  assert.deepEqual(h.stopped, [{ id: 1, reason: 'page-left' }]);
  assert.equal(h.ctl.status().bound, false);
  assert.equal(h.started[0].alive(), false);
  assert.equal((await h.ctl.unbind({})).action, 'none');

  // Tear down during startup
  let release;
  h.gate(new Promise((r) => { release = r; }));
  h.ctl.bind(BIND, {});
  await flush();
  assert.equal(h.started.length, 2);
  const link = h.started[1];
  const unbound = h.ctl.unbind({ projectId: 'P1' });
  assert.equal(link.alive(), false, 'The link is invalidated the moment it is revoked (the start in progress backs off accordingly)');
  release();
  await unbound;
  assert.deepEqual(h.stopped.at(-1), { id: 2, reason: 'unbind' });
  assert.equal(h.ctl.status().bound, false);
});

test('RLY-01 relay: send over HMR, fulfill when the page hands the ticket back; an error or an invalid reply fails', async () => {
  const sent = [];
  const relay = createTicketRelay({ send: (d) => sent.push(d) });
  const p = relay.request('P1');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'ticket');
  assert.equal(sent[0].projectId, 'P1');
  assert.equal(typeof sent[0].reqId, 'string');
  assert.equal(relay.answer({ reqId: sent[0].reqId, ticket: 'v1.a.b' }), true);
  assert.equal(await p, 'v1.a.b');
  assert.equal(relay.answer({ reqId: sent[0].reqId, ticket: 'v1.a.b' }), false, 'The same ticket is fulfilled only once');

  const q = relay.request('P1');
  relay.answer({ reqId: sent[1].reqId, error: 'This page is not connected to this shared project' });
  await assert.rejects(q, (e) => e.code === 'page-refused' && /Page failed to sign a ticket/.test(e.message));
  const r = relay.request('P1');
  relay.answer({ reqId: sent[2].reqId, ticket: 'has space' });
  await assert.rejects(r, (e) => e.code === 'page-refused');
  assert.equal(relay.pending(), 0);
});

test('RLY-02 fails immediately when there is no page; fails on timeout; unknown reqId', async () => {
  const sent = [];
  let page = false;
  const timers = [];
  const relay = createTicketRelay({ send: (d) => sent.push(d), hasPage: () => page, timeoutMs: 10_000,
    setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; }, clearTimer: (t) => { t.cleared = true; } });
  await assert.rejects(relay.request('P1'), (e) => e.code === 'no-page');
  assert.equal(sent.length, 0, 'Nothing is sent when there is no page');
  page = true;
  const p = relay.request('P1');
  assert.equal(timers[0].ms, 10_000);
  timers[0].fn();
  await assert.rejects(p, (e) => e.code === 'timeout');
  assert.equal(relay.answer({ reqId: sent[0].reqId, ticket: 'v1.a.b' }), false, 'A reply handed back after the timeout does not count');
  assert.equal(relay.answer({ reqId: 'nope', ticket: 'v1.a.b' }), false);
  assert.equal(relay.answer(null), false);
  assert.deepEqual(relay.stats(), { requests: 2, answered: 0, failed: 0, noPage: 1, timeouts: 1, pending: 0 });
});

test('RLY-03 config memory: does not remember tickets; revoke by project', () => {
  const m = createBindingMemory();
  assert.equal(m.get(), null);
  m.set({ ...BIND, ticket: 'v1.SECRET.sig' });
  assert.deepEqual(m.get(), BIND);
  assert.ok(!JSON.stringify(m.get()).includes('SECRET'));
  assert.equal(m.clear('OTHER'), false);
  assert.deepEqual(m.get(), BIND);
  assert.equal(m.clear('P1'), true);
  assert.equal(m.get(), null);
  m.set(BIND);
  assert.equal(m.clear(), true, 'Revoke everything when no project id is given');
  assert.equal(m.clear(), false);
});

test('ARN-08 the editor process log shows the auto render node\'s start and stop and its push target (other lines such as queue.started are not forwarded)', async () => {
  const { createSessionLineForwarder } = await import('../render-node/session-diag.mjs');
  const out = [];
  const fwd = createSessionLineForwarder((line) => out.push(line));
  fwd([
    '[queue-node] render-node.bind {"projectId":"P1","url":"wss://site.example/hosted/"}',
    '[artifact-push] push.asset-base {"source":"page","base":"https://site.example/media/api/asset","for":"push"}',
    '[artifact-push] push.started {"docservice":"page","asset":"https://site.example/media/api/asset"}',
    '[artifact-push] push.skip {"reason":"disabled"}',
    '[queue-node] render-node.teardown {"reason":"page-left","released":0}',
    '[queue-node] queue.skip {"reason":"no-environment"}',
    '[queue-node] queue.started {"nodeId":"x"}',
    '[artifact-push] push.retry {"id":"x"}',
    '',
  ].join('\n'));
  assert.deepEqual(out.map((l) => l.split(' ')[1]), ['render-node.bind', 'push.asset-base', 'push.started', 'push.skip', 'render-node.teardown', 'queue.skip']);
});
