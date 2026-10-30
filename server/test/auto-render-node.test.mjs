/**
 * 桌面应用自动成为共享项目的渲染节点:预渲染进程一侧的状态机(`server/auto-render-node.mjs`)与编辑器进程一侧的中转
 * (`server/render-node-relay.mjs`)。报告 `docs/archive/agent-reports/AGENT-desktop-auto-node.md`。
 * 跑:node --test server/test/auto-render-node.test.mjs
 *
 *   ARN-01 开关与环境变量:缺省接;PROMPTCUT_AUTO_RENDER_NODE=0 / 无头 / PUSH=0 / host 档 / 环境变量已配节点 不接
 *   ARN-02 共享配置的校验(地址、项目 id、素材基址),错误信息里不带票据
 *   ARN-03 交接:起一次;第一次建会话用页面交来的票据,不向页面要
 *   ARN-04 票据往返:手里的不新鲜了才要;两条连接同时要只要一次;要到的票据缓存到快过期
 *   ARN-05 要不到票据(页面没了):protocols 抛错、状态「等页面」;页面回来(同项目再交接带票据)就续上,不重建
 *   ARN-06 同一个项目重复交接只换素材基址与项目文档 id,不重建;换了项目先撤旧的再起新的,旧链接失效
 *   ARN-07 撤掉:只撤同一个项目的;撤完状态回空;起步期间撤掉,起完就收
 *   RLY-01 中转:经 HMR 发 { type: 'ticket', reqId, projectId },页面交回就兑现;交回错误 / 不合格 → 失败
 *   RLY-02 没有页面连着 HMR:立即失败,不发;页面 10 秒没交回:超时失败;不认识的 reqId 不算
 *   RLY-03 配置记忆:不记票据;撤的时候给了项目 id 只撤同一个项目的
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { autoRenderNodeOffReason, createAutoRenderNode, normalizeBinding, TICKET_MIN_LEFT_MS } from '../auto-render-node.mjs';
import { createBindingMemory, createTicketRelay } from '../render-node-relay.mjs';

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
/** 形状对的假票据(只看有效期,不验签) */
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

test('ARN-01 开关与环境变量', () => {
  assert.equal(autoRenderNodeOffReason({}), null);
  assert.equal(autoRenderNodeOffReason({ PROMPTCUT_AUTO_RENDER_NODE: '1' }), null);
  assert.equal(autoRenderNodeOffReason({ PROMPTCUT_AUTO_RENDER_NODE: '0' }), 'disabled');
  assert.equal(autoRenderNodeOffReason({ PROMPTCUT_PUSH: '0' }), 'push-disabled');
  assert.equal(autoRenderNodeOffReason({ PROMPTCUT_NODE_PROFILE: 'host' }), 'host-profile');
  assert.equal(autoRenderNodeOffReason({ PROMPTCUT_SHARED_CONFIG: 'x.json' }), 'env-configured');
  assert.equal(autoRenderNodeOffReason({ PROMPTCUT_QUEUE_NODE: '1' }), 'env-configured');
  assert.equal(autoRenderNodeOffReason({ PROMPTCUT_PUSH: '1' }), 'env-configured');
  // 开关优先于其它
  assert.equal(autoRenderNodeOffReason({ PROMPTCUT_AUTO_RENDER_NODE: '0', PROMPTCUT_QUEUE_NODE: '1' }), 'disabled');
});

test('ARN-02 共享配置的校验', () => {
  assert.deepEqual(normalizeBinding({ ...BIND, assetBase: 'https://site.example/media/api/asset/' }), BIND);
  assert.deepEqual(normalizeBinding({ url: 'ws://127.0.0.1:5190/docservice', projectId: 'a.b:c-1' }), { url: 'ws://127.0.0.1:5190/docservice', projectId: 'a.b:c-1', assetBase: null, contentId: null });
  assert.throws(() => normalizeBinding({ ...BIND, url: 'http://x/' }), /ws/);
  assert.throws(() => normalizeBinding({ ...BIND, url: 'nope' }), /url/);
  assert.throws(() => normalizeBinding({ ...BIND, projectId: 'bad id' }), /projectId/);
  assert.throws(() => normalizeBinding({ ...BIND, assetBase: 'ftp://x' }), /assetBase/);
  assert.throws(() => normalizeBinding(null), /对象/);
  try { normalizeBinding({ ...BIND, projectId: '', ticket: 'v1.SECRET.sig' }); } catch (e) { assert.ok(!String(e.message).includes('SECRET')); }
});

test('ARN-03 交接:起一次,第一次建会话用页面交来的票据', async () => {
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
  assert.equal(h.requests.length, 0, '页面交来的票据还新鲜:不向页面要');
  const st = h.ctl.status();
  assert.equal(st.bound, true);
  assert.equal(st.started, true);
  assert.ok(!JSON.stringify(st).includes(pageTicket), '状态里不带票据');
  assert.ok(!JSON.stringify(h.logs).includes(pageTicket), '日志里不带票据');
});

test('ARN-04 票据往返:不新鲜了才要,并发只要一次,要到的缓存', async () => {
  const h = harness();
  h.ctl.bind(BIND, { ticket: fakeTicket(h.now() + 120_000, 'page') });
  await h.ctl.settled();
  const link = h.started[0];
  h.advance(120_000 - TICKET_MIN_LEFT_MS + 1); // 页面那张只剩不到 30 s
  const [a, b] = await Promise.all([link.protocols(), link.protocols()]);
  assert.equal(h.requests.length, 1, '两条连接同时建会话只向页面要一次');
  assert.deepEqual(a, b);
  assert.match(a[1], /^promptcut\.ticket\.v1\./);
  assert.ok(a[1].endsWith('sigr1'));
  h.advance(10_000);
  await link.protocols();
  assert.equal(h.requests.length, 1, '要到的那张还新鲜:不再要');
  h.advance(100_000);
  const c = await link.protocols();
  assert.equal(h.requests.length, 2);
  assert.ok(c[1].endsWith('sigr2'));
});

test('ARN-05 要不到票据:等页面;页面回来续上,不重建', async () => {
  let fail = true;
  let n = 0;
  const h = harness({ requestTicket: async () => { n++; if (fail) throw Object.assign(new Error('没有页面连着编辑器'), { code: 'no-page' }); return fakeTicket(Date.now() + 1e12, 'late'); } });
  h.ctl.bind(BIND, {});
  await h.ctl.settled();
  const link = h.started[0];
  await assert.rejects(link.protocols(), /没有页面/);
  await assert.rejects(link.protocols(), /没有页面/);
  assert.equal(n, 2);
  assert.equal(h.ctl.status().waitingPage, true);
  assert.equal(h.logs.filter((l) => l.event === 'render-node.waiting-page').length, 1, '等页面的日志不刷屏');
  // 页面回来:同一个项目再交接一次(带票据)
  const again = fakeTicket(h.now() + 120_000, 'back');
  assert.equal(h.ctl.bind(BIND, { ticket: again }).action, 'same');
  assert.equal(h.ctl.status().waitingPage, false);
  assert.deepEqual(await link.protocols(), ['promptcut.v1', `promptcut.ticket.${again}`]);
  assert.equal(n, 2, '页面交来的票据新鲜:不再要');
  assert.equal(h.started.length, 1, '没有重建');
  assert.equal(h.stopped.length, 0);
  fail = false;
});

test('ARN-06 同项目只换基址与文档 id;换项目先撤再起', async () => {
  const h = harness();
  h.ctl.bind(BIND, { ticket: fakeTicket(h.now() + 120_000) });
  await h.ctl.settled();
  const first = h.started[0];
  assert.equal(h.ctl.bind({ ...BIND, assetBase: 'https://other.example/api/asset', contentId: 'doc-2' }).action, 'same');
  assert.equal(first.assetBase(), 'https://other.example/api/asset');
  // push-scope:link 上的 contentId 现取(推送与发布的范围按它判,页面晚交来的 id 要看得到)
  assert.equal(first.contentId, 'doc-2', 'link 上的 contentId 跟着同项目的交接换');
  assert.equal(h.ctl.status().contentId, 'doc-2');
  // 同项目但没给基址:沿用原来的
  h.ctl.bind({ url: BIND.url, projectId: 'P1' });
  assert.equal(first.assetBase(), 'https://other.example/api/asset');
  await h.ctl.settled();
  assert.equal(h.started.length, 1);
  // 换项目
  assert.equal(h.ctl.bind({ ...BIND, projectId: 'P2' }).action, 'rebind');
  assert.equal(first.alive(), false, '旧链接当场失效');
  await h.ctl.settled();
  assert.deepEqual(h.stopped, [{ id: 1, reason: 'rebind' }]);
  assert.equal(h.started.length, 2);
  assert.equal(h.started[1].projectId, 'P2');
  await assert.rejects(first.protocols(), /撤掉/);
  // 换文档服务地址也算换项目
  h.ctl.bind({ ...BIND, projectId: 'P2', url: 'ws://192.168.1.5:5190/docservice' });
  await h.ctl.settled();
  assert.equal(h.started.length, 3);
});

test('ARN-07 撤掉:只撤同一个项目的;起步期间撤掉,起完就收', async () => {
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

  // 起步期间撤掉
  let release;
  h.gate(new Promise((r) => { release = r; }));
  h.ctl.bind(BIND, {});
  await flush();
  assert.equal(h.started.length, 2);
  const link = h.started[1];
  const unbound = h.ctl.unbind({ projectId: 'P1' });
  assert.equal(link.alive(), false, '撤的那一刻链接就失效(起步里的 start 据此收手)');
  release();
  await unbound;
  assert.deepEqual(h.stopped.at(-1), { id: 2, reason: 'unbind' });
  assert.equal(h.ctl.status().bound, false);
});

test('RLY-01 中转:发 HMR、页面交回兑现;交回错误或不合格即失败', async () => {
  const sent = [];
  const relay = createTicketRelay({ send: (d) => sent.push(d) });
  const p = relay.request('P1');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'ticket');
  assert.equal(sent[0].projectId, 'P1');
  assert.equal(typeof sent[0].reqId, 'string');
  assert.equal(relay.answer({ reqId: sent[0].reqId, ticket: 'v1.a.b' }), true);
  assert.equal(await p, 'v1.a.b');
  assert.equal(relay.answer({ reqId: sent[0].reqId, ticket: 'v1.a.b' }), false, '同一张只兑现一次');

  const q = relay.request('P1');
  relay.answer({ reqId: sent[1].reqId, error: '本页面没有连着这个共享项目' });
  await assert.rejects(q, (e) => e.code === 'page-refused' && /没签出/.test(e.message));
  const r = relay.request('P1');
  relay.answer({ reqId: sent[2].reqId, ticket: 'has space' });
  await assert.rejects(r, (e) => e.code === 'page-refused');
  assert.equal(relay.pending(), 0);
});

test('RLY-02 没有页面立即失败;超时失败;不认识的 reqId', async () => {
  const sent = [];
  let page = false;
  const timers = [];
  const relay = createTicketRelay({ send: (d) => sent.push(d), hasPage: () => page, timeoutMs: 10_000,
    setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; }, clearTimer: (t) => { t.cleared = true; } });
  await assert.rejects(relay.request('P1'), (e) => e.code === 'no-page');
  assert.equal(sent.length, 0, '没有页面时不发');
  page = true;
  const p = relay.request('P1');
  assert.equal(timers[0].ms, 10_000);
  timers[0].fn();
  await assert.rejects(p, (e) => e.code === 'timeout');
  assert.equal(relay.answer({ reqId: sent[0].reqId, ticket: 'v1.a.b' }), false, '超时之后交回的不算');
  assert.equal(relay.answer({ reqId: 'nope', ticket: 'v1.a.b' }), false);
  assert.equal(relay.answer(null), false);
  assert.deepEqual(relay.stats(), { requests: 2, answered: 0, failed: 0, noPage: 1, timeouts: 1, pending: 0 });
});

test('RLY-03 配置记忆:不记票据;按项目撤', () => {
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
  assert.equal(m.clear(), true, '不给项目 id 一律撤');
  assert.equal(m.clear(), false);
});

test('ARN-08 编辑器进程的日志里看得到自动渲染节点的起停与推送目标(不转 queue.started 这类别的行)', async () => {
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
