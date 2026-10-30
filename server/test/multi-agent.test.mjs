/**
 * 多 Agent 的服务端一侧(计划 docs/plan/agent-workflow-plan.md A3)。用例 MA-S1～MA-S14。
 *
 * - 纯逻辑:拉起子 Agent 的上限(深度 1、并发 4)、桌面 APP 会话没有页签可开、子 Agent 的等级不高于父对话、
 *   公告板的名单 / 投递(空闲立即、忙时攒着、下一次工具结果带上、连锁封顶)、写进别人声明的范围时双方提示;
 * - 端到端(真的文档服务 + 真的 src/mcp/handlers + createAgentSide + attachLink):父子并行写入各记各的身份、
 *   公告板由提交流喂(页面、两个 Agent 的写入都在)、被覆盖的一方下一次工具结果得知;
 * - 分工模式归档后没有残留入口(按标识符与路由的棘轮式检查)。
 *
 * 跑法:node --test server/test/multi-agent.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer as createVite } from 'vite';
import { createSharedDocService } from '../docservice/shared-service.mjs';
import { createAgentSide } from '../agent/agent-side.mjs';
import { loadSsrHost } from '../agent/ssr-host.mjs';
import { createAgentSessions } from '../agent/agent-sessions.mjs';
import { BOARD_DEFAULTS, annotateBoard, byOfActor, createAgentBoard, createAgentBoards } from '../agent/agent-board.mjs';
import { SPAWN_LIMITS, attachLink, createMultiAgent } from '../agent/multi-agent.mjs';
import { SPAWN_ROLE_IDS, loadRole } from '../agent/agent-roles.mjs';
import { tools, toolGroups } from '../mcp-tools.mjs';
import { wsClient, waitFor } from './fake-ws-kit.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** 一套拼装(与 vite-plugin-ai.ts 相同的接法):登记表、按项目的公告板、multiAgent;openTab 是假的页面 */
function rig({ projectLevel = 'high', openTab } = {}) {
  const sessions = createAgentSessions();
  const boards = createAgentBoards(() => ({ labelOf: (k) => sessions.get(k).vendor, infoOf: (k) => { const e = sessions.get(k); return { role: e.role, parent: e.parent }; } }));
  let projectKey = 'p';
  const board = () => boards.boardFor(projectKey);
  const opened = [];
  const ma = createMultiAgent({
    sessions,
    board,
    projectCreativity: () => projectLevel,
    openTab: openTab ?? (async (spec) => { opened.push(spec); board().setTabs([...board().listRaw('').filter((a) => a.id !== spec.conversationId).map((a) => ({ conversationId: a.id, title: a.title, busy: a.busy })), { conversationId: spec.conversationId, title: spec.roleName, busy: false }]); }),
  });
  return { sessions, boards, board, ma, opened, setProject: (k) => { projectKey = k; } };
}

/* ------------------------------------------------------------------ 纯逻辑 */

test('MA-S1 数字与角色:深度 1、并发 4、连锁 3 层;可拉起的角色都读得到提示词,工具表的 enum 与之一致;五个工具都在服务端答', () => {
  assert.equal(SPAWN_LIMITS.maxDepth, 1);
  assert.equal(SPAWN_LIMITS.maxChildren, 4);
  assert.equal(BOARD_DEFAULTS.MAX_AUTO_HOPS, 3);
  assert.equal(BOARD_DEFAULTS.idleMs, 30 * 60_000);
  for (const id of SPAWN_ROLE_IDS) {
    const r = loadRole(id);
    assert.ok(r && r.name && r.prompt.length > 10, id);
  }
  assert.equal(loadRole('manager'), null, '只做拆解调度的制片主管随分工模式归档');
  const spawn = tools.find((t) => t.name === 'spawn_agent');
  assert.deepEqual(spawn.inputSchema.properties.role.enum, [...SPAWN_ROLE_IDS]);
  for (const n of ['spawn_agent', 'declare_scope', 'list_agents', 'send_message', 'check_messages']) {
    assert.equal(tools.find((t) => t.name === n)?.side, 'server', n);
  }
});

test('MA-S2 spawn_agent:新身份登记(厂商 / 驱动沿用父对话、role、parent),页签开出,任务作为第一条消息进它的信箱', async () => {
  const r = rig();
  r.sessions.register('conv-main', { type: 'cli', vendor: 'claude', role: 'main' });
  const out = await r.ma.handle('spawn_agent', { role: 'director', task: '把素材排上剪辑1->序列1' }, 'conv-main');
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.match(out.conversationId, /^sub-[A-Za-z0-9_-]{12}$/);
  assert.equal(out.roleName, '剪辑导演');
  const child = r.sessions.get(out.conversationId);
  assert.deepEqual({ type: child.type, vendor: child.vendor, role: child.role, parent: child.parent }, { type: 'cli', vendor: 'claude', role: 'director', parent: 'conv-main' });
  assert.equal(r.opened.length, 1);
  assert.deepEqual({ ...r.opened[0], task: undefined }, { conversationId: out.conversationId, role: 'director', roleName: '剪辑导演', parent: 'conv-main', provider: 'claude', creativity: 'high', task: undefined });
  assert.equal(r.board().hasAutoDeliverable(out.conversationId), true, '页签空闲就由页面发出');
  const first = r.board().takeInbox(out.conversationId, true);
  assert.deepEqual(first.map((m) => [m.from, m.text, m.hops]), [['conv-main', '把素材排上剪辑1->序列1', 1]]);
  // AI 栏以后每条消息的登记(role 固定 main)不改掉子 Agent 的角色与父对话
  r.sessions.register(out.conversationId, { type: 'cli', vendor: 'claude', role: 'main', creativity: 'high' });
  assert.deepEqual([r.sessions.get(out.conversationId).role, r.sessions.get(out.conversationId).parent], ['director', 'conv-main']);
  // API 直连的父对话:子 Agent 的驱动是 api
  r.sessions.register('conv-api', { type: 'api', vendor: 'anthropic' });
  const api = await r.ma.handle('spawn_agent', { role: 'collector', task: 'x' }, 'conv-api');
  assert.equal(api.provider, 'api');
  // 参数不对
  assert.equal((await r.ma.handle('spawn_agent', { role: 'manager', task: 'x' }, 'conv-main')).code, 'bad-role');
  assert.equal((await r.ma.handle('spawn_agent', { role: 'director', task: '  ' }, 'conv-main')).code, 'bad-task');
});

test('MA-S3 深度上限:子 Agent 再拉起被拒,报错写明是谁拉起的它', async () => {
  const r = rig();
  r.sessions.register('conv-main', { type: 'cli', vendor: 'codex' });
  const c = await r.ma.handle('spawn_agent', { role: 'fx-assistant', task: '配字幕' }, 'conv-main');
  const again = await r.ma.handle('spawn_agent', { role: 'director', task: '再拉一个' }, c.conversationId);
  assert.equal(again.ok, false);
  assert.equal(again.code, 'depth');
  assert.match(again.error, /子 Agent\(由 conv-main 拉起\),不能再拉起/);
  assert.equal(r.opened.length, 1, '没开第二页');
});

test('MA-S4 并发上限:同一个主 Agent 开着的子 Agent 至多 4 个,第 5 个被拒;关掉一个页签就腾出名额;别的主 Agent 不受影响', async () => {
  const r = rig();
  r.sessions.register('conv-main', { type: 'cli', vendor: 'claude' });
  r.sessions.register('conv-other', { type: 'cli', vendor: 'claude' });
  const kids = [];
  for (let i = 0; i < 4; i += 1) {
    const o = await r.ma.handle('spawn_agent', { role: 'director', task: `活 ${i}` }, 'conv-main');
    assert.equal(o.ok, true, JSON.stringify(o));
    kids.push(o.conversationId);
  }
  const fifth = await r.ma.handle('spawn_agent', { role: 'director', task: '第五个' }, 'conv-main');
  assert.equal(fifth.ok, false);
  assert.equal(fifth.code, 'too-many');
  assert.deepEqual(fifth.children.sort(), [...kids].sort());
  assert.match(fifth.error, /已经有 4 个\(上限 4\)/);
  assert.equal((await r.ma.handle('spawn_agent', { role: 'director', task: '别人的' }, 'conv-other')).ok, true, '按主 Agent 分开算');
  // 用户关掉第一个子 Agent 的页签
  r.board().setTabs(r.board().listRaw('').filter((a) => a.id !== kids[0]).map((a) => ({ conversationId: a.id, title: a.title, busy: false })));
  assert.equal((await r.ma.handle('spawn_agent', { role: 'director', task: '补上' }, 'conv-main')).ok, true);
});

test('MA-S5 没有页签可开:桌面 APP 会话 / 没登记的对话、没带对话 ID、编辑台没打开,都回清楚的错误且不留登记', async () => {
  const r = rig({ openTab: async () => { throw new Error('编辑台没有打开,没有页签可开'); } });
  const desk = await r.ma.handle('spawn_agent', { role: 'director', task: 'x' }, 'desk-1');
  assert.equal(desk.code, 'no-tab');
  assert.match(desk.error, /桌面 APP 的会话/);
  assert.equal((await r.ma.handle('spawn_agent', { role: 'director', task: 'x' }, '')).code, 'no-parent');
  r.sessions.register('conv-main', { type: 'cli', vendor: 'claude' });
  const closed = await r.ma.handle('spawn_agent', { role: 'director', task: 'x' }, 'conv-main');
  assert.equal(closed.code, 'no-tab');
  assert.match(closed.error, /编辑台没有打开/);
  assert.deepEqual(r.sessions.childrenOf('conv-main'), [], '开不出页签就撤掉登记');
});

test('MA-S6 子 Agent 的创造力等级:取父对话此刻生效的等级;之后也不高于父对话(父降级跟着降,子调高只到父那一档)', async () => {
  const r = rig({ projectLevel: 'high' });
  r.sessions.register('conv-main', { type: 'cli', vendor: 'claude', creativity: 'medium' });
  const c = await r.ma.handle('spawn_agent', { role: 'director', task: 'x' }, 'conv-main');
  assert.equal(c.creativity, 'medium');
  assert.equal(r.sessions.creativityOf(c.conversationId, 'high').level, 'medium');
  // 用户在子页签里调到「高」:仍只到父对话的「中」
  r.sessions.register(c.conversationId, { type: 'cli', vendor: 'claude', creativity: 'high' });
  const up = r.sessions.creativityOf(c.conversationId, 'high');
  assert.equal(up.level, 'medium');
  assert.match(up.source, /不高于拉起它的对话 conv-main/);
  // 父对话降到「低」:子跟着降
  r.sessions.register('conv-main', { type: 'cli', vendor: 'claude', creativity: 'low' });
  assert.equal(r.sessions.creativityOf(c.conversationId, 'high').level, 'low');
  // 子自己往低调是可以的
  r.sessions.register('conv-main', { type: 'cli', vendor: 'claude', creativity: 'high' });
  r.sessions.register(c.conversationId, { type: 'cli', vendor: 'claude', creativity: 'low' });
  assert.equal(r.sessions.creativityOf(c.conversationId, 'high').level, 'low');
});

test('MA-S7 公告板的名单:页签、调过工具的会话、声明的范围;30 分钟没动静的不再列;写入身份的认法', () => {
  let t = 1_000_000;
  const b = createAgentBoard({ now: () => t, labelOf: (k) => (k === 'conv-a' ? 'claude' : null) });
  b.setTabs([{ conversationId: 'conv-a', title: 'Agent 1', busy: true }, { conversationId: 'bad id', title: 'x' }]);
  b.touch('desk-1');
  const d = b.declareScope('conv-a', { scope: '剪辑1->序列2', note: '配字幕' });
  assert.equal(d.ok, true);
  assert.deepEqual(b.listRaw('conv-a').map((a) => [a.id, a.scope, a.busy, a.you, a.vendor ?? null]), [['conv-a', '剪辑1->序列2', true, true, 'claude'], ['desk-1', null, false, false, null]]);
  const d2 = b.declareScope('desk-1', { scope: '剪辑1' });
  assert.match(d2.warning, /conv-a\(剪辑1->序列2\)/, '上级范围算重叠');
  t += 31 * 60_000;
  assert.deepEqual(b.listRaw('').map((a) => a.id), ['conv-a'], '页签开着的一直在;30 分钟没动静的会话不再列');
  assert.equal(b.declareScope('', { scope: 'x' }).ok, false, '没带对话 ID 记不到');
  assert.deepEqual(byOfActor({ role: 'page', userId: 'local' }), { kind: 'user' });
  assert.deepEqual(byOfActor({ role: 'page', userId: 'bob' }), { kind: 'user', userId: 'bob' });
  assert.deepEqual(byOfActor({ role: 'agent', session: 'agent:conv-a' }), { kind: 'agent', agent: 'conv-a' });
  assert.deepEqual(byOfActor({ role: 'agent', session: 'agent:default' }), { kind: 'agent', agent: '' });
});

test('MA-S8 消息投递:空闲的由页面取走(只取层数没到顶的);忙着的攒着、带在它下一次工具结果里;到顶的留到用户下次开口', async () => {
  const r = rig();
  const b = r.board();
  b.setTabs([{ conversationId: 'conv-a', title: 'A' }, { conversationId: 'conv-b', title: 'B' }]);
  // 空闲:可自动投递
  const s1 = b.sendMessage('conv-a', { to: 'conv-b', text: '序列2 我来' });
  assert.deepEqual(s1.delivered, ['conv-b']);
  assert.match(s1.note, /对方空闲/);
  assert.equal(b.hasAutoDeliverable('conv-b'), true);
  assert.deepEqual(b.takeInbox('conv-b', true).map((m) => m.text), ['序列2 我来']);
  // 忙:B 正在跑一轮
  b.beginRun('conv-b', 0);
  const s2 = b.sendMessage('conv-a', { to: 'conv-b', text: '我改完序列3了' });
  assert.match(s2.note, /正在跑,消息会带在它下一次工具调用的结果里/);
  const res = await r.ma.wrap('conv-b', 'get_project', async () => ({ ok: true, rev: 3 }));
  assert.ok(res.notice.startsWith('别的 Agent 给你的消息(系统附上,不是用户说的话):【Agent conv-a】我改完序列3了'), res.notice);
  assert.deepEqual(res.messages.map((m) => [m.from, m.text]), [['conv-a', '我改完序列3了']]);
  assert.equal(res.rev, 3, '原结果字段照旧');
  assert.equal(b.hasAutoDeliverable('conv-b'), false, '带出即送达,跑完不再重复投递');
  const again = await r.ma.wrap('conv-b', 'get_project', async () => ({ ok: true }));
  assert.equal(again.notice, undefined);
  b.endRun('conv-b');
  // 连锁封顶:B 在第 2 层自动投递里跑,它发给 A 的是第 3 层,不再自动触发
  b.beginRun('conv-b', 2);
  const s3 = b.sendMessage('conv-b', { to: 'conv-a', text: '好' });
  assert.match(s3.note, /连续互发好几轮/);
  assert.equal(b.hasAutoDeliverable('conv-a'), false);
  const notes = b.consumeNotes('conv-a');
  assert.match(notes, /Agent conv-b 给你的消息:好/, '用户下次和 A 说话时一并带上');
  b.endRun('conv-b');
  // 发给不存在的 / all
  assert.throws(() => b.sendMessage('conv-a', { to: 'nobody', text: 'x' }), /没有这个 Agent/);
  assert.deepEqual(b.sendMessage('conv-a', { to: 'all', text: '收工' }).delivered, ['conv-b']);
  // check_messages 不取走
  assert.equal(b.checkMessages('conv-b').messages.length, 1);
  assert.equal(b.checkMessages('conv-b').messages.length, 1);
});

test('MA-S9 写进别人声明的范围:写入方这一次结果里提示;声明方下一次结果里提示(只提示一次);用户写进来也提示', async () => {
  const r = rig();
  const b = r.board();
  b.setTabs([{ conversationId: 'conv-a', title: 'A' }, { conversationId: 'conv-b', title: 'B' }]);
  b.declareScope('conv-a', { scope: '剪辑1->序列2' });
  const p0 = { tracks: [{ id: 't2', name: '序列2', clips: [] }], cuts: [{ id: 'c1', name: '剪辑1' }], activeCutId: 'c1' };
  const p1 = { ...p0, tracks: [{ ...p0.tracks[0], clips: [{ id: 'x' }] }] };
  const w = await r.ma.wrap('conv-b', 'add_clip', async () => {
    b.noteCommit({ rev: 2, opId: 'op1', actor: { role: 'agent', session: 'agent:conv-b' }, before: p0, after: p1 });
    return { ok: true, id: 'x' };
  });
  assert.deepEqual(w.scopeClash, [{ agent: 'conv-a', who: 'Agent conv-a', scope: '剪辑1->序列2', written: ['剪辑1->序列2'] }]);
  assert.match(w.notice, /^这次写入落在别的 Agent 正在改的范围里:Agent conv-a 声明在改的「剪辑1->序列2」/);
  assert.equal(b._changes().at(-1).tool, 'add_clip', '提交流的记录带上工具名');
  const a1 = await r.ma.wrap('conv-a', 'get_clip', async () => ({ ok: true }));
  assert.equal(a1.scopeChanges.length, 1);
  assert.match(a1.notice, /^别人正在改你声明的范围:Agent conv-b 用 add_clip 改了 剪辑1->序列2/);
  const a2 = await r.ma.wrap('conv-a', 'get_clip', async () => ({ ok: true }));
  assert.equal(a2.scopeChanges, undefined, '同一条只提示一次');
  // 用户在页面上改了 A 的范围
  const p2 = { ...p1, tracks: [{ ...p1.tracks[0], clips: [] }] };
  b.noteCommit({ rev: 3, actor: { role: 'page', userId: 'local' }, before: p1, after: p2 });
  const a3 = await r.ma.wrap('conv-a', 'get_clip', async () => ({ ok: true }));
  assert.match(a3.notice, /别人正在改你声明的范围:用户 改了 剪辑1->序列2/);
  // 这些提示不重复出现在下一轮的「其他 Agent 的动态」里
  const notes = b.consumeNotes('conv-a');
  assert.equal(notes.includes('改了 剪辑1->序列2'), false, notes);
  // 多 Agent 工具本身不带提示
  b.deliver({ from: 'conv-b', to: 'conv-a', text: 'hi' });
  const chk = await r.ma.wrap('conv-a', 'check_messages', async () => b.checkMessages('conv-a'));
  assert.equal(chk.notice, undefined);
});

test('MA-S10 annotateBoard 的放法与 A2 一致:notice 在最前、原 notice 接在后面、字段保留;数组包一层;没东西原样返回', () => {
  const plain = { ok: true };
  assert.equal(annotateBoard(plain, {}), plain);
  const r = annotateBoard({ ok: true, notice: '用户正在编辑片段 c1(拖动中)。', rev: 2 }, { overwrittenBy: [{ entity: '/tracks/@t1/clips/@c1', who: 'Agent conv-a(claude)', by: 'agent', rev: 5 }] });
  assert.deepEqual(Object.keys(r).slice(0, 2), ['notice', 'overwrittenBy']);
  assert.equal(r.notice, '你写的 片段 c1(被 Agent conv-a(claude) 覆盖,rev 5)。先重读确认现在的内容,需要时和对方协调,不要直接改回去。\n用户正在编辑片段 c1(拖动中)。');
  assert.equal(r.rev, 2);
  const arr = annotateBoard([1], { messages: [{ from: 'x', text: 'y' }] });
  assert.deepEqual(arr.result, [1]);
});

/* ------------------------------------------------------------------ 端到端 */

async function startEnv(t) {
  const server = http.createServer((req, res) => { res.statusCode = 404; res.end(); });
  const built = createSharedDocService({ mode: 'lan', dataDir: null, store: null, server, path: '/docservice', isLoopback: () => true, localDevice: { deviceId: 'pc-test-device-0001', deviceName: 'test' }, log: () => {} });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${server.address().port}/docservice`;
  const vite = await createVite({ configFile: false, root: ROOT, logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  const closers = [];
  t.after(async () => {
    for (const c of closers) { try { c(); } catch { /* 已关 */ } }
    await vite.close();
    await built.service.close();
    await new Promise((resolve) => server.close(resolve));
  });
  const load = (id) => vite.ssrLoadModule(id);
  const { createEmptyProject } = await load('/src/kernel/project.ts');

  async function page(projectId, session = 'page-1') {
    const c = wsClient(url);
    closers.push(() => c.close());
    await c.opened;
    let seq = 0;
    return {
      async open() {
        c.send({ type: 'project.open', projectId, reqId: `open-${++seq}` });
        return c.next((m) => m.type === 'project.state');
      },
      async commit(ops) {
        const opId = `${session}-op-${++seq}`;
        c.send({ type: 'project.op', projectId, opId, session, ops, reqId: opId });
        return c.next((m) => m.reqId === opId);
      },
    };
  }

  async function seeded(projectId) {
    const pg = await page(projectId);
    await pg.open();
    const p = createEmptyProject('ma-test');
    p.id = projectId;
    p.cuts = [{ id: 'cut-1', name: '剪辑1' }];
    p.activeCutId = 'cut-1';
    p.tracks = [
      { id: 't1', name: '序列1', clips: [{ id: 'c1', cardId: 'title', params: { text: '一' }, start: 0, end: 3 }] },
      { id: 't2', name: '序列2', clips: [{ id: 'c2', cardId: 'title', params: { text: '二' }, start: 3, end: 6 }] },
    ];
    const reply = await pg.commit([{ op: 'set', path: '', value: p }]);
    assert.equal(reply.type, 'project.op.ok', JSON.stringify(reply));
    return pg;
  }

  /** 与 vite-plugin-ai.ts 同样的拼装:side 的 side:"server" 工具交给 multiAgent;每次调用包 wrap */
  function agentRig(projectId) {
    const r = rig();
    r.setProject(projectId);
    const s = createAgentSide({
      projectId,
      url,
      protocolsFor: (n) => ['promptcut.v1', `promptcut.role.agent.${n}`],
      loadHost: () => loadSsrHost(load),
      tools,
      toolGroups,
      callPage: async () => { throw new Error('这个测试里没有页面'); },
      callServer: (tool, args, ctx) => r.ma.handle(tool, args, ctx?.agent ?? ''),
      agentLabel: (k) => r.sessions.get(k).vendor,
      onPageWrites: (agent, ops) => r.board().attributeOps(agent, ops),
    });
    closers.push(() => s.close());
    const detach = attachLink(s.link, r.board);
    closers.push(detach);
    const call = (tool, args, agent) => r.ma.wrap(agent, tool, () => s.callTool(tool, args, { agent }));
    return { ...r, side: s, call };
  }

  return { seeded, agentRig };
}

test('MA-S11～S13 端到端:拉起的身份隔离、公告板由提交流喂、被覆盖方下一次结果得知', async (t) => {
  const env = await startEnv(t);

  await t.test('MA-S11 父子并行写入各记各的身份:各自读后写都落地、不互相被判过时;提交流里写入身份分别是父、子', async () => {
    const pid = 'proj-ma-identity';
    await env.seeded(pid);
    const g = env.agentRig(pid);
    g.sessions.register('conv-main', { type: 'cli', vendor: 'claude' });
    g.board().setTabs([{ conversationId: 'conv-main', title: 'Agent 1' }]);
    const sp = await g.call('spawn_agent', { role: 'fx-assistant', task: '给序列2配字幕' }, 'conv-main');
    assert.equal(sp.ok, true, JSON.stringify(sp));
    const kid = sp.conversationId;
    // 两边各读一次,交替写各自的片段;每次写之前读到的是对方刚落地的版本(读后写)
    await Promise.all([g.call('get_project', {}, 'conv-main'), g.call('get_project', {}, kid)]);
    const w1 = await g.call('update_clip', { clipId: 'c1', opacity: 0.5 }, 'conv-main');
    assert.equal(w1.ok, true, JSON.stringify(w1));
    await g.call('get_clip', { clipId: 'c2' }, kid);
    const w2 = await g.call('update_clip', { clipId: 'c2', opacity: 0.6 }, kid);
    assert.equal(w2.ok, true, JSON.stringify(w2));
    await g.call('get_clip', { clipId: 'c1' }, 'conv-main');
    const w3 = await g.call('update_clip', { clipId: 'c1', opacity: 0.7 }, 'conv-main');
    assert.equal(w3.ok, true, JSON.stringify(w3));
    // 各自的写入身份:对话号不同、session 是各自的对话 ID
    const hist = g.side.link.replica.history.filter((h) => h.rev >= w1.rev);
    assert.deepEqual(hist.map((h) => h.session), ['agent:conv-main', `agent:${kid}`, 'agent:conv-main']);
    assert.notEqual(g.side.conversationNumber('conv-main'), g.side.conversationNumber(kid));
    assert.deepEqual([g.side.executor.lastRead('conv-main'), g.side.executor.lastRead(kid)], [w3.rev, w2.rev], '各记各的读到的版本');
    // 公告板里的改动记录也各记各的
    const ch = g.board()._changes().filter((c) => c.kind === 'change');
    assert.deepEqual(ch.map((c) => [c.by.agent, c.tool, c.scopes.join()]), [['conv-main', 'update_clip', '剪辑1->序列1'], [kid, 'update_clip', '剪辑1->序列2'], ['conv-main', 'update_clip', '剪辑1->序列1']]);
    // 注意:没重读就写仍按文档服务的期望版本拒(product/document-service.md「Agent 的写操作带期望版本」)
    await assert.rejects(g.call('update_clip', { clipId: 'c2', opacity: 0.1 }, kid), /stale|过时|期间|重读/);
  });

  await t.test('MA-S12 公告板看得到页面、两个 Agent 的写入(文档服务的提交流),别的成员的写入按写入身份标名字', async () => {
    const pid = 'proj-ma-feed';
    const pg = await env.seeded(pid);
    const g = env.agentRig(pid);
    g.board().setTabs([{ conversationId: 'conv-a', title: 'A' }, { conversationId: 'conv-b', title: 'B' }]);
    await g.call('get_project', {}, 'conv-a');
    await g.call('update_clip', { clipId: 'c1', opacity: 0.4 }, 'conv-a');
    await g.call('get_project', {}, 'conv-b');
    await g.call('update_clip', { clipId: 'c2', opacity: 0.4 }, 'conv-b');
    const pr = await pg.commit([{ op: 'set', path: '/tracks/@t2/clips/@c2/label', value: '页面改的' }]);
    await waitFor(() => g.board()._changes().some((c) => c.rev === pr.rev), 3000, '页面的提交进公告板');
    const ch = g.board()._changes().filter((c) => c.kind === 'change');
    assert.deepEqual(ch.map((c) => [c.by.kind, c.by.agent ?? null, c.scopes.join()]), [
      ['agent', 'conv-a', '剪辑1->序列1'], ['agent', 'conv-b', '剪辑1->序列2'], ['user', null, '剪辑1->序列2'],
    ]);
    // 共享项目里别的成员:写入身份是 page + 他的 userId(这里直接喂一条,跨设备的端到端见 multi-agent-presence.test.mjs)
    const p = g.side.link.replica.project;
    g.board().noteCommit({ rev: 99, actor: { role: 'page', userId: 'bob' }, before: p, after: { ...p, tracks: [p.tracks[0], { ...p.tracks[1], clips: [] }] } });
    const notes = g.board().consumeNotes('conv-a');
    assert.match(notes, /Agent conv-b 用 update_clip 改了 剪辑1->序列2/);
    assert.match(notes, /用户 改了 剪辑1->序列2/);
    assert.match(notes, /用户 bob 改了 剪辑1->序列2/);
    assert.equal(notes.includes('conv-a 用'), false, '自己的不进自己的动态');
  });

  await t.test('MA-S13 被覆盖的一方下一次工具结果得知:conv-b 写的 c2 被 conv-a 覆盖,conv-b 下一次调用带「你写的 … 被 Agent conv-a(codex)覆盖」', async () => {
    const pid = 'proj-ma-overwritten';
    await env.seeded(pid);
    const g = env.agentRig(pid);
    g.sessions.register('conv-a', { type: 'cli', vendor: 'codex' });
    await g.call('get_project', {}, 'conv-a');
    await g.call('get_project', {}, 'conv-b');
    const b1 = await g.call('update_clip', { clipId: 'c2', opacity: 0.2 }, 'conv-b');
    assert.equal(b1.ok, true);
    await g.call('get_clip', { clipId: 'c2' }, 'conv-a');
    const a1 = await g.call('update_clip', { clipId: 'c2', opacity: 0.9 }, 'conv-a');
    assert.equal(a1.overwrote.length, 1, '覆盖方照旧(A2)');
    await new Promise((r) => setTimeout(r, 200));
    const b2 = await g.call('get_clip', { clipId: 'c1' }, 'conv-b');
    assert.equal(b2.overwrittenBy?.length, 1, JSON.stringify(b2));
    assert.deepEqual({ entity: b2.overwrittenBy[0].entity, who: b2.overwrittenBy[0].who, by: b2.overwrittenBy[0].by, rev: b2.overwrittenBy[0].rev }, { entity: '/tracks/@t2/clips/@c2', who: 'Agent conv-a(codex)', by: 'agent', rev: a1.rev });
    assert.match(b2.notice, /^你写的 片段 c2\(被 Agent conv-a\(codex\) 覆盖,rev \d+\)/);
    const b3 = await g.call('get_clip', { clipId: 'c1' }, 'conv-b');
    assert.equal(b3.overwrittenBy, undefined, '只告诉一次');
    // 页面(用户)覆盖了 Agent 写的
    const a2 = await g.call('update_clip', { clipId: 'c1', opacity: 0.3 }, 'conv-a');
    assert.equal(a2.ok, true);
  });
});

/* ------------------------------------------------------------------ 归档 */

test('MA-S14 分工模式归档后没有残留入口:标识符、路由、文件都不在(棘轮:只许减少)', () => {
  const gone = ['src/ai/teamMode.ts', 'src/ai/orchestrate.ts', 'src/ai/orchestrateGraph.ts', 'src/ai/triage.ts', 'src/ai/runRoleTask.ts', 'src/editor/right/OrchestrationBlock.tsx', 'src/editor/right/OrchestrationBlock.css', 'src/ai/roles/manager.md'];
  for (const f of gone) assert.equal(fs.existsSync(path.join(ROOT, f)), false, `${f} 应已删除`);
  const patterns = [/\bteamMode\b/i, /\bisTeamMode\b/, /\borchestrat/i, /\btriage\b/i, /\brunRoleTask\b/, /\bOrchestrationBlock\b/, /\/api\/ai\/plan\b/, /\/api\/ai\/triage\b/, /data-pc="ai-team-mode"/, /分工模式<\//];
  const hits = [];
  // 基线文件的说明里记着删了哪两条路由;它的 paths 在下面单独查
  const skip = new Set(['server/test/multi-agent.test.mjs', 'server/test/c10-api-ratchet-baseline.json']);
  const walk = (dir) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name);
      const rel = path.relative(ROOT, file).replaceAll('\\', '/');
      if (item.isDirectory()) { if (item.name !== 'node_modules') walk(file); continue; }
      if (!/\.(tsx?|mjs|js|cjs|css|json|html)$/.test(item.name) || skip.has(rel)) continue;
      const text = fs.readFileSync(file, 'utf8');
      for (const re of patterns) if (re.test(text)) hits.push(`${rel} :: ${re}`);
    }
  };
  for (const d of ['src', 'server', 'scripts']) walk(path.join(ROOT, d));
  assert.deepEqual(hits, [], `分工模式的入口还有残留:\n${hits.join('\n')}`);
  const baseline = JSON.parse(fs.readFileSync(path.join(ROOT, 'server/test/c10-api-ratchet-baseline.json'), 'utf8')).paths;
  assert.equal(baseline.includes('/api/ai/plan') || baseline.includes('/api/ai/triage'), false, '在线构建的 /api 棘轮基线按删掉的路由更新');
});
