/**
 * 工具调用事件模块（C6.5 设计稿 `docs/plan/c65-design.md` 第 7 节）与内容库写入身份（第 10 节）。用例 DS-E1～DS-E6。
 * 跑：node --test server/test/docservice-events.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { byType, wsClient } from './fake-ws-kit.mjs';
import { startStandalone, ask } from './fake-docservice-env.mjs';
import { startSharedService, createProject, join } from './fake-shared-env.mjs';
import { projectModule } from '../docservice/modules/project.mjs';
import { contentModule } from '../docservice/modules/content.mjs';
import { eventsModule, eventDetailKey } from '../docservice/modules/events.mjs';
import { createMemoryStore } from '../docservice/store/index.mjs';

const T0 = 1_700_000_000_000;

function authByQuery(req) {
  const q = new URL(req.url ?? '/', 'http://localhost').searchParams;
  const user = q.get('user') ?? 'u';
  const role = q.get('role');
  if (!role) return { userId: user, tenantId: 't-test' };
  const dev = q.get('dev') ?? 'dev-1';
  return { userId: `${user}@${dev}`, tenantId: 't-test', scope: 'member', deviceId: dev, role, conversation: q.get('conv') ? Number(q.get('conv')) : null };
}

async function start(t, { contentLimit } = {}) {
  const store = createMemoryStore();
  const clock = { t: T0 };
  const now = () => clock.t;
  const project = projectModule({ store, now });
  const content = contentModule({ store, now, ...(contentLimit ? { maxBodyBytes: contentLimit } : {}) });
  const events = eventsModule({ project, content, now });
  const env = await startStandalone({ modules: [project, content, events], now, authenticate: authByQuery });
  const clients = [];
  t.after(async () => {
    for (const c of clients) c.close();
    await env.cleanup();
  });
  const connect = async (query) => {
    const c = wsClient(`${env.url()}?${query}`);
    clients.push(c);
    await c.opened;
    return c;
  };
  return { ...env, store, clock, connect };
}

const open = (c, projectId = 'P') => ask(c, { type: 'project.open', projectId });

test('DS-E1 创建事件：ack 带 detailKey；项目频道的订阅者收 events.event（不带完整参数），发送方与别的项目收不到；完整参数在内容库 event-detail', async (t) => {
  const env = await start(t);
  const agent = await env.connect('user=zoe&role=agent&conv=3');
  const page = await env.connect('user=zoe&role=page');
  const other = await env.connect('user=amy&role=page');
  await open(agent);
  await open(page);
  await open(other, 'Q');
  const detail = { clipId: 'c1', patch: { start: 1.5, text: '标题' } };
  const ack = await ask(agent, {
    type: 'events.create', projectId: 'P', eventId: 'e-1', tool: 'set_clip', icon: 'edit', target: '/tracks/@t1/clips/@c1',
    args: 'start=1.5', detail, session: 'conv-3',
  });
  assert.deepEqual(ack, { type: 'events.ack', projectId: 'P', eventId: 'e-1', phase: 'create', detailKey: eventDetailKey('P', 'e-1'), reqId: ack.reqId });
  const ev = await page.next(byType('events.event'));
  assert.deepEqual(ev, {
    type: 'events.event', projectId: 'P', eventId: 'e-1', phase: 'create', tool: 'set_clip', icon: 'edit',
    target: '/tracks/@t1/clips/@c1', args: 'start=1.5', detailKey: 'P/e-1',
    actor: { userId: 'zoe@dev-1', deviceId: 'dev-1', role: 'agent', conversation: 3, session: 'conv-3' }, at: T0,
  });
  assert.deepEqual(await agent.quiet(byType('events.event'), 100), [], '发送方收不到自己的广播');
  assert.deepEqual(await other.quiet(byType('events.event'), 100), [], '别的项目收不到');
  const item = await ask(page, { type: 'content.get', kind: 'event-detail', key: 'P/e-1' });
  assert.deepEqual(item.body, detail);
});

test('DS-E2 完成事件与文字回复：广播 complete / text；events.list 按 eventId 合并', async (t) => {
  const env = await start(t);
  const agent = await env.connect('user=zoe&role=agent&conv=3');
  const page = await env.connect('user=zoe&role=page');
  await open(page);
  await ask(agent, { type: 'events.create', projectId: 'P', eventId: 'e-1', tool: 'add_clip' });
  await page.next(byType('events.event'));
  env.clock.t = T0 + 420;
  const ack = await ask(agent, { type: 'events.complete', projectId: 'P', eventId: 'e-1', status: 'ok', summary: '加了 1 张卡', durationMs: 420 });
  assert.equal(ack.phase, 'complete');
  const done = await page.next(byType('events.event'));
  assert.deepEqual(
    { phase: done.phase, status: done.status, summary: done.summary, durationMs: done.durationMs, at: done.at },
    { phase: 'complete', status: 'ok', summary: '加了 1 张卡', durationMs: 420, at: T0 + 420 },
  );
  await ask(agent, { type: 'events.text', projectId: 'P', eventId: 'm-1', text: '做完了。' });
  const txt = await page.next(byType('events.event'));
  assert.deepEqual({ phase: txt.phase, text: txt.text }, { phase: 'text', text: '做完了。' });
  const listing = await ask(page, { type: 'events.list', projectId: 'P' });
  assert.deepEqual(listing.items.map((i) => [i.eventId, i.tool, i.status, i.durationMs ?? null, i.text ?? null]), [
    ['e-1', 'add_clip', 'ok', 420, null],
    ['m-1', null, 'ok', null, '做完了。'],
  ]);
});

test('DS-E3 校验与拒绝：坏 status / 缺 tool / 坏 eventId 回 bad-message；详情超过内容库上限回 too-large 且不广播；渲染节点回 forbidden', async (t) => {
  const env = await start(t, { contentLimit: 1024 });
  const agent = await env.connect('user=zoe&role=agent&conv=3');
  const page = await env.connect('user=zoe&role=page');
  const node = await env.connect('user=n&role=render');
  await open(page);
  for (const m of [
    { type: 'events.complete', projectId: 'P', eventId: 'e', status: 'done' },
    { type: 'events.create', projectId: 'P', eventId: 'e' },
    { type: 'events.create', projectId: 'P', eventId: 'bad id', tool: 'x' },
    { type: 'events.text', projectId: 'P', eventId: 'e', text: 5 },
  ]) {
    const r = await ask(agent, m);
    assert.deepEqual({ type: r.type, reason: r.reason }, { type: 'error', reason: 'bad-message' }, JSON.stringify(m));
  }
  const big = await ask(agent, { type: 'events.create', projectId: 'P', eventId: 'e-big', tool: 'x', detail: 'y'.repeat(2048) });
  assert.deepEqual({ type: big.type, reason: big.reason }, { type: 'error', reason: 'too-large' });
  const f = await ask(node, { type: 'events.create', projectId: 'P', eventId: 'e-n', tool: 'x' });
  assert.deepEqual({ type: f.type, reason: f.reason }, { type: 'error', reason: 'forbidden' });
  assert.deepEqual(await page.quiet(byType('events.event'), 100), [], '被拒的都不广播');
  const item = await ask(page, { type: 'content.get', kind: 'event-detail', key: 'P/e-big' });
  assert.equal(item.missing, true);
});

test('DS-E4（第 10 节）内容库与项目日志的 actor 统一为 { userId, deviceId, role, conversation, session }，previousActor 同样带全；事件详情的写入身份是发事件的连接', async (t) => {
  const env = await start(t);
  const agent = await env.connect('user=zoe&dev=d1&role=agent&conv=9');
  const page = await env.connect('user=zoe&dev=d1&role=page');
  await ask(page, { type: 'content.watch', kinds: ['card-source', 'event-detail'] });
  await ask(agent, { type: 'content.put', kind: 'card-source', key: 'k', body: 1, session: 'conv-9' });
  const c1 = await page.next(byType('content.changed'));
  await ask(page, { type: 'content.put', kind: 'card-source', key: 'k', body: 2, session: 'tab-1' });
  const agentActor = { userId: 'zoe@d1', deviceId: 'd1', role: 'agent', conversation: 9, session: 'conv-9' };
  const pageActor = { userId: 'zoe@d1', deviceId: 'd1', role: 'page', conversation: null, session: 'tab-1' };
  assert.deepEqual(c1.actor, agentActor);
  const c2 = await agent.quiet(byType('content.changed'), 100);
  assert.deepEqual(c2, [], 'agent 没 watch');
  const rec = env.store.read('content/card-source');
  assert.deepEqual(rec.map((r) => r.actor), [agentActor, pageActor]);

  await ask(agent, { type: 'events.create', projectId: 'P', eventId: 'e-9', tool: 't', detail: { a: 1 }, session: 'conv-9' });
  const ch = await page.next((m) => m.type === 'content.changed' && m.kind === 'event-detail');
  assert.deepEqual({ key: ch.key, actor: ch.actor, previousActor: ch.previousActor }, { key: 'P/e-9', actor: agentActor, previousActor: null });
  await ask(page, { type: 'content.put', kind: 'event-detail', key: 'P/e-9', body: { a: 2 }, session: 'tab-1' });
  const ch2 = await page.next((m) => m.type === 'content.changed' && m.kind === 'event-detail');
  assert.deepEqual(ch2.previousActor, agentActor, 'previousActor 带全');
});

test('DS-E5 事件广播只借项目频道：没 open 项目的连接收不到；close 之后也收不到', async (t) => {
  const env = await start(t);
  const agent = await env.connect('user=zoe&role=agent&conv=1');
  const page = await env.connect('user=zoe&role=page');
  await ask(agent, { type: 'events.create', projectId: 'P', eventId: 'e-0', tool: 'x' });
  assert.deepEqual(await page.quiet(byType('events.event'), 100), []);
  await open(page);
  await ask(agent, { type: 'events.create', projectId: 'P', eventId: 'e-1', tool: 'x' });
  assert.equal((await page.next(byType('events.event'))).eventId, 'e-1');
  await ask(page, { type: 'project.close', projectId: 'P' });
  await ask(agent, { type: 'events.create', projectId: 'P', eventId: 'e-2', tool: 'x' });
  assert.deepEqual(await page.quiet(byType('events.event'), 100), []);
});

test('DS-E6 组装层按空间配组：共享项目空间里的项目提交与事件不串到 local 空间；/healthz 的 modules 含 events', async (t) => {
  const host = await startSharedService({ mode: 'hosted', isLoopback: (req) => !String(req?.headers?.['sec-websocket-protocol'] ?? '').includes('promptcut.auth.') });
  t.after(() => host.close());
  const P = await createProject(host.base);
  const bob = await join(host.base, { projectId: P.projectId, username: 'bob', password: 'project-pw', deviceId: 'dev-bob-0001-abcdefghij' });
  const amy = await join(host.base, { projectId: P.projectId, username: 'amy', password: 'project-pw', deviceId: 'dev-amy-0001-abcdefghij' });
  await bob.opened;
  await amy.opened;
  const local = wsClient(host.base);
  await local.opened;
  t.after(() => { bob.close(); amy.close(); local.close(); });

  const pid = 'proj-1';
  await ask(amy, { type: 'project.open', projectId: pid });
  await ask(local, { type: 'project.open', projectId: pid });
  const ok = await ask(bob, { type: 'project.op', projectId: pid, opId: 'o1', ops: [{ op: 'set', path: '', value: { a: 1 } }] });
  assert.deepEqual({ type: ok.type, rev: ok.rev }, { type: 'project.op.ok', rev: 1 });
  assert.equal((await amy.next(byType('project.ops'))).rev, 1);
  await ask(bob, { type: 'events.create', projectId: pid, eventId: 'e1', tool: 'x', detail: { q: 1 } });
  const ev = await amy.next(byType('events.event'));
  assert.ok(ev.actor.userId.startsWith('bob@'));
  assert.deepEqual(await local.quiet((m) => m.type === 'project.ops' || m.type === 'events.event', 150), [], 'local 空间收不到');
  const st = await ask(local, { type: 'project.open', projectId: pid });
  assert.deepEqual({ rev: st.rev, project: st.project }, { rev: 0, project: null }, 'local 空间里同名项目是另一份');
  const d = await ask(local, { type: 'content.get', kind: 'event-detail', key: `${pid}/e1` });
  assert.equal(d.missing, true);
  const h = await (await fetch(`http://127.0.0.1:${host.port}/healthz`)).json();
  assert.ok(h.modules.includes('events'), JSON.stringify(h.modules));
});
