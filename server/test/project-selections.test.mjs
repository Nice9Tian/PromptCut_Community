import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDocService } from '../docservice/service.mjs';
import { mountSelection } from '../docservice/modules/selection.mjs';
import { wsClient, waitFor } from './fake-ws-kit.mjs';

test('018 project selection provider over real WS: all pages, authority, revoke, offline snapshot', async t => {
  const active = new Set(['alice', 'bob', 'carol']);
  let failHead = false;
  const project = {
    revOf: id => id === 'p1' ? 7 : null,
    bodyOf: id => id === 'p1' ? { tracks: [{ id: 't1', clips: [{ id: 'c1', name: 'One' }, { id: 'c2', name: 'Two' }] }] } : null,
  };
  const selection = mountSelection({ project,
    checkAccess: async ({ principal, projectId }) => {
      if (failHead) throw Object.assign(new Error('head unavailable'), { status: 503 });
      return active.has(principal.accountId) && projectId === 'p1'
        ? { allowed: true, accountId: principal.accountId, projectId, accountName: `${principal.accountId}-trusted` } : false;
    },
    authorizeQuery: async ({ projectId, runGrantId }) => runGrantId === 'run1' && projectId === 'p1'
      ? { projectId, runGrantId, fenceRevision: 1, initiatorAccountId: 'alice', initiatorName: 'alice-trusted',
          selectionSnapshot: { source: 'sent-snapshot', projectId, accountId: 'alice', pageId: 'sent-page',
            selection: { clipIds: ['c2'] }, sentAt: 1000 } } : null,
    now: () => 2000,
  });
  const authenticate = req => {
    const q = new URL(req.url, 'http://localhost').searchParams;
    const accountId = q.get('account');
    const service = q.get('service');
    return { userId: accountId ?? service ?? 'stranger', tenantId: q.get('project') ?? 'p1',
      ...(service ? { service } : { role: 'page', accountId, accountName: 'AUTH-INITIAL', loginId: q.get('login') ?? 'L1' }) };
  };
  const doc = createDocService({ modules: [selection], authenticate, autoTick: false, log: () => {} });
  const { port } = await doc.listen(0, '127.0.0.1');
  const clients = [];
  t.after(async () => {
    for (const c of clients) c.close();
    await doc.close();
  });
  let seq = 0;
  async function client(params) {
    const c = wsClient(`ws://127.0.0.1:${port}/?${new URLSearchParams(params)}`, ['promptcut.v1']);
    clients.push(c); await c.opened;
    return { c, ask: async msg => {
      const reqId = `sel${++seq}`;
      c.send({ ...msg, reqId });
      return c.next(reply => reply.reqId === reqId);
    } };
  }
  const a1 = await client({ account: 'alice' });
  const a2 = await client({ account: 'alice', login: 'L2' });
  const bob = await client({ account: 'bob' });
  const carol = await client({ account: 'carol' });
  const agent = await client({ service: 'agent' });
  const page = await client({ account: 'stranger' });
  const askQuery = () => agent.ask({ type: 'selection.query', projectId: 'p1', runGrantId: 'run1' });

  assert.equal((await a1.ask({ type: 'selection.set', projectId: 'p1', pageId: 'a1', revision: 1,
    username: 'forged', accountId: 'bob', selection: { clipIds: ['c1', 'gone'] } })).type, 'selection.ok');
  assert.equal((await a2.ask({ type: 'selection.set', projectId: 'p1', pageId: 'a2', revision: 1,
    selection: { clipIds: ['c2'] } })).type, 'selection.ok');
  assert.equal((await bob.ask({ type: 'selection.set', projectId: 'p1', pageId: 'b1', revision: 1,
    selection: { clipIds: ['c1'] } })).type, 'selection.ok');
  let state = await askQuery();
  assert.equal(state.type, 'selection.state');
  assert.equal(state.projectRev, 7);
  assert.deepEqual(state.members.map(m => m.accountId), ['alice', 'bob', 'carol']);
  assert.equal(state.members[0].displayName, 'alice-trusted（当前用户）');
  assert.deepEqual(state.members[0].pages.map(p => p.pageId), ['a1', 'a2']);
  assert.deepEqual(state.members[0].pages[0].items.map(i => [i.id, !!i.missing]), [['c1', false], ['gone', true]]);
  assert.deepEqual(state.members[2].pages[0].selection.clipIds, [], 'empty online page remains');
  assert.equal(state.members.some(m => m.username === 'forged'), false);

  assert.deepEqual([(await page.ask({ type: 'selection.query', projectId: 'p1', runGrantId: 'run1' })).reason,
    (await agent.ask({ type: 'selection.query', projectId: 'p2', runGrantId: 'run1' })).reason,
    (await agent.ask({ type: 'selection.query', projectId: 'p1', runGrantId: 'unknown' })).reason],
    ['forbidden', 'forbidden', 'run-grant-invalid']);
  assert.equal((await agent.ask({ type: 'selection.query', projectId: 'p1', runGrantId: 'run1',
    selectionSnapshot: { selection: { clipIds: ['c1'] } } })).reason, 'invalid-authority-claim');
  assert.equal((await bob.ask({ type: 'selection.set', projectId: 'p2', pageId: 'b1', revision: 2,
    selection: { clipIds: ['c1'] } })).reason, 'forbidden');

  assert.equal((await bob.ask({ type: 'selection.clear', projectId: 'p1', pageId: 'b1', revision: 2 })).type, 'selection.ok');
  assert.equal((await bob.ask({ type: 'selection.set', projectId: 'p1', pageId: 'b1', revision: 1,
    selection: { clipIds: ['c2'] } })).reason, 'stale-revision', 'lower same-page revision cannot overwrite clear');
  assert.equal((await bob.ask({ type: 'selection.set', projectId: 'p1', pageId: 'old-page', revision: 9,
    selection: { clipIds: ['c2'] } })).reason, 'page-mismatch', 'old page cannot replace bound page');
  state = await askQuery();
  assert.deepEqual(state.members[1].pages[0].selection.clipIds, []);
  selection.revoke({ projectId: 'p1', accountId: 'alice', loginId: 'L2' });
  state = await askQuery();
  assert.deepEqual(state.members[0].pages.map(p => p.pageId), ['a1']);
  assert.equal((await a2.ask({ type: 'selection.set', projectId: 'p1', pageId: 'a2', revision: 2,
    selection: { clipIds: ['c1'] } })).reason, 'connection-closed', 'revoked connection cannot reinsert even before upstream head moves');
  active.delete('alice');
  selection.revoke({ projectId: 'p1', accountId: 'alice' });
  assert.equal((await a1.ask({ type: 'selection.set', projectId: 'p1', pageId: 'a1', revision: 2,
    selection: { clipIds: ['c1'] } })).reason, 'forbidden');
  state = await askQuery();
  assert.deepEqual(state.members[0].pages.map(p => [p.pageId, p.live, p.note]),
    [['sent-page', false, '发消息时的选区，非实时']]);
  failHead = true;
  assert.equal((await askQuery()).reason, 'authority-unavailable', 'unreachable head fails closed');
  failHead = false;
  active.delete('carol');
  state = await askQuery();
  assert.equal(state.members.some(m => m.accountId === 'carol'), false, 'query evicts revoked page even before explicit revoke callback');
  bob.c.close();
  await waitFor(() => selection.describe().pages === 0, 3000, 'disconnect cleanup');
  state = await askQuery();
  assert.equal(state.members.some(m => m.accountId === 'bob'), false);
});

test('018 read-only selection and strict authority/grant fences', async () => {
  const projectId = 'p1';
  const page = { role: 'page', tenantId: projectId, accountId: 'alice', accountName: 'Alice', access: 'r' };
  const agent = { service: 'agent', tenantId: projectId };
  const project = { bodyOf: () => ({ tracks: [{ id: 't', clips: [{ id: 'c1' }] }] }), revOf: () => 7 };
  const grant = { projectId, runGrantId: 'run1', fenceRevision: 1, initiatorAccountId: 'alice',
    selectionSnapshot: { source: 'sent-snapshot', projectId, accountId: 'alice', pageId: 'sent',
      selection: { clipIds: [] }, sentAt: 10 } };
  const ctx = { send(_connId, reply) { this.reply = reply; } };
  const falseObject = mountSelection({ project,
    checkAccess: async () => ({ allowed: false, accountId: 'alice', projectId }),
    authorizeQuery: async () => grant });
  falseObject.connect(ctx, 'false-conn', page);
  await falseObject.handle(ctx, 'false-conn', { type: 'selection.set', projectId, pageId: 'page1',
    revision: 1, selection: { clipIds: ['c1'] } });
  assert.equal(ctx.reply.reason, 'forbidden', 'explicit allowed:false never grants');
  assert.deepEqual((await falseObject.querySelections({ principal: agent, projectId, runGrantId: 'run1' }))
    .members[0].pages.map(p => p.live), [false]);
  const missingAllowed = mountSelection({ project,
    checkAccess: async () => ({ accountId: 'alice', projectId }), authorizeQuery: async () => grant });
  missingAllowed.connect(ctx, 'missing-conn', page);
  await missingAllowed.handle(ctx, 'missing-conn', { type: 'selection.set', projectId,
    pageId: 'page1', revision: 1, selection: { clipIds: ['c1'] } });
  assert.equal(ctx.reply.reason, 'forbidden', 'missing allowed cannot be truthy access');

  let seenAction;
  const readonly = mountSelection({ project,
    checkAccess: async ({ action }) => { seenAction = action; return action === 'read'; },
    authorizeQuery: async () => grant });
  readonly.connect(ctx, 'read-conn', page);
  await readonly.handle(ctx, 'read-conn', { type: 'selection.set', projectId,
    pageId: 'readonly-page', revision: 1, selection: { clipIds: ['c1'] } });
  assert.equal(ctx.reply.type, 'selection.ok');
  assert.equal(seenAction, 'read');
  assert.deepEqual((await readonly.querySelections({ principal: agent, projectId,
    runGrantId: 'run1' })).members[0].pages[0].selection.clipIds, ['c1']);
  await readonly.handle(ctx, 'read-conn', { type: 'selection.clear', projectId,
    pageId: 'readonly-page', revision: 2 });
  assert.equal(ctx.reply.type, 'selection.ok');
  assert.deepEqual((await readonly.querySelections({ principal: agent, projectId,
    runGrantId: 'run1' })).members[0].pages[0].selection.clipIds, []);

  let grantActive = true;
  let grantCalls = 0;
  const revokedDuringRead = mountSelection({ project,
    checkAccess: async () => { grantActive = false; return true; },
    authorizeQuery: async () => { grantCalls++; return grantActive ? grant : null; } });
  revokedDuringRead.connect(ctx, 'late-conn', page);
  await assert.rejects(revokedDuringRead.querySelections({ principal: agent, projectId,
    runGrantId: 'run1' }), err => err.code === 'run-grant-invalid');
  assert.equal(grantCalls, 2, 'grant is rechecked after member authorization');

  let fence = 1;
  const changedFence = mountSelection({ project,
    checkAccess: async () => { fence = 2; return true; },
    authorizeQuery: async () => ({ ...grant, fenceRevision: fence }) });
  changedFence.connect(ctx, 'fence-conn', page);
  await assert.rejects(changedFence.querySelections({ principal: agent, projectId,
    runGrantId: 'run1' }), err => err.code === 'run-grant-changed');

  const noFence = mountSelection({ project, checkAccess: async () => true,
    authorizeQuery: async () => ({ ...grant, fenceRevision: undefined }) });
  await assert.rejects(noFence.querySelections({ principal: agent, projectId,
    runGrantId: 'run1' }), err => err.code === 'run-fence-unavailable');
});

test('一位成员的登录过期或被撤销:这一位不算,别的成员的选区照常读到;权威不可用仍然整次失败', async () => {
  const projectId = 'p1';
  const pageOf = accountId => ({ role: 'page', tenantId: projectId, accountId, accountName: accountId, loginId: `L-${accountId}` });
  const agent = { service: 'agent', tenantId: projectId };
  const project = { bodyOf: () => ({ tracks: [{ id: 't', clips: [{ id: 'c1' }, { id: 'c2' }] }] }), revOf: () => 7 };
  const grant = { projectId, runGrantId: 'run1', fenceRevision: 1, initiatorAccountId: 'alice', initiatorName: 'alice',
    selectionSnapshot: { source: 'sent-snapshot', projectId, accountId: 'alice', pageId: 'sent', selection: { clipIds: ['c2'] }, sentAt: 10 } };
  /** 每位成员此刻问权威会得到什么:`true` 放行,函数就照它抛或回 */
  const answers = new Map();
  const fail = (status, code) => () => { throw Object.assign(new Error(code), status === undefined ? {} : { status, code }); };
  const selection = mountSelection({ project,
    checkAccess: async ({ principal }) => { const a = answers.get(principal.accountId); return typeof a === 'function' ? a(principal) : a; },
    authorizeQuery: async () => grant, now: () => 2000 });
  const ctx = { replies: new Map(), send(connId, reply) { this.replies.set(connId, reply); } };
  const members = ['alice', 'bob', 'carol', 'dave', 'erin'];
  for (const id of members) {
    answers.set(id, true);
    selection.connect(ctx, `conn-${id}`, pageOf(id));
    await selection.handle(ctx, `conn-${id}`, { type: 'selection.set', projectId, pageId: `page-${id}`, revision: 1, selection: { clipIds: ['c1'] } });
    assert.equal(ctx.replies.get(`conn-${id}`).type, 'selection.ok');
  }
  const query = () => selection.querySelections({ principal: agent, projectId, runGrantId: 'run1' });
  const liveOf = state => state.members.filter(m => m.pages.some(p => p.live)).map(m => m.accountId);
  assert.deepEqual(liveOf(await query()), members);

  // bob 登录过期、carol 被撤销、dave 凭证对不上:三位都是 401。改之前这里整次查询抛 authority-unavailable,云端 Agent 看到的是「发起方不在线」
  answers.set('bob', fail(401, 'authorization-expired'));
  answers.set('carol', fail(401, 'credential-revoked'));
  answers.set('dave', fail(401, 'principal-mismatch'));
  let state = await query();
  assert.deepEqual(liveOf(state), ['alice', 'erin'], '过期、被撤销的三位不算,发起方和另一位照常');
  assert.equal(state.members.find(m => m.accountId === 'alice').isInitiator, true);
  assert.deepEqual(state.members.find(m => m.accountId === 'alice').pages.map(p => [p.pageId, p.live, p.selection.clipIds]), [['page-alice', true, ['c1']]],
    '发起方读到的是它页面上实时的选区,不是发消息时的那一份');
  assert.equal(/page-(bob|carol|dave)/.test(JSON.stringify(state)), false, '不算的成员的选区一个字都不在结果里');
  assert.equal(selection.describe().pages, 2, '不算的那三条连接的在场记录撤掉了');

  // 权限没有放松:那条连接凭过期的登录再发选区照旧被拒,进不了表
  await selection.handle(ctx, 'conn-bob', { type: 'selection.set', projectId, pageId: 'page-bob', revision: 2, selection: { clipIds: ['c2'] } });
  assert.deepEqual([ctx.replies.get('conn-bob').type, ctx.replies.get('conn-bob').reason], ['error', 'authorization-expired']);
  assert.deepEqual(liveOf(await query()), ['alice', 'erin']);
  // 换一条连接重新登录(页面续登录就是这样):重新发选区之后回到表里
  answers.set('bob', true);
  selection.disconnect(ctx, 'conn-bob');
  selection.connect(ctx, 'conn-bob-2', pageOf('bob'));
  await selection.handle(ctx, 'conn-bob-2', { type: 'selection.set', projectId, pageId: 'page-bob-2', revision: 1, selection: { clipIds: ['c2'] } });
  assert.deepEqual(liveOf(await query()), ['alice', 'bob', 'erin']);

  // 发起方自己的登录过期:它不算在线成员,结果里给的是文档服务自己存的发消息时的那一份(不是实时的),别的成员照常
  answers.set('alice', fail(401, 'authorization-expired'));
  state = await query();
  assert.deepEqual(liveOf(state), ['bob', 'erin']);
  assert.deepEqual(state.members.find(m => m.accountId === 'alice').pages.map(p => [p.pageId, p.live, p.source, p.selection.clipIds]), [['sent', false, 'sent-snapshot', ['c2']]]);

  // 没权限(403)照旧是这一位不算;答非所问(权威回的不是放行、或回的是别人的账号)也是
  answers.set('erin', fail(403, 'not-listed'));
  assert.deepEqual(liveOf(await query()), ['bob']);
  selection.connect(ctx, 'conn-frank', pageOf('frank'));
  answers.set('frank', () => ({ allowed: true, accountId: 'bob', projectId }));
  selection.connect(ctx, 'conn-gina', pageOf('gina'));
  answers.set('gina', () => 'yes');
  state = await query();
  assert.deepEqual(liveOf(state), ['bob'], '答非所问的两位不算');
  assert.equal(state.members.find(m => m.accountId === 'bob').pages.length, 1, '也没有被算成别人的页面');
  assert.equal(selection.describe().pages, 1);

  // 查询途中断线的那一位不算,别的照常
  selection.connect(ctx, 'conn-hank', pageOf('hank'));
  answers.set('hank', () => { selection.disconnect(ctx, 'conn-hank'); return true; });
  assert.deepEqual(liveOf(await query()), ['bob']);

  // 不是哪一位成员的事:权威不可用(5xx)、超时或连不上(没有状态码)、项目没了(404)、正在搬迁(409)、请求写错(400) —— 整次失败,不给缺人的表
  for (const [status, code] of [[503, 'account-event-gap'], [500, 'internal'], [undefined, 'timeout'], [404, 'no-project'], [409, 'relocating'], [400, 'invalid-action'], [429, 'busy']]) {
    answers.set('bob', fail(status, code));
    await assert.rejects(query(), err => err.status === 503 && err.code === 'authority-unavailable', `${status ?? '没有状态码'} ${code} 应该整次失败`);
    assert.equal(selection.describe().pages, 1, '整次失败时不撤任何人的记录');
  }
  answers.set('bob', true);
  assert.deepEqual(liveOf(await query()), ['bob'], '权威恢复后照常');
});
