/**
 * 「用户正在编辑」本机版的服务端一侧(计划 docs/plan/agent-workflow-plan.md A2)。用例 UE-S1～UE-S10。
 *
 * - 服务端记着的编辑状态:整份替换、合并、过期(拖动 / 文字编辑 15 秒没续期、「刚动过」按页面报的剩余毫秒);
 * - 这次调用碰到哪些片段:参数点名的、实际写到的(ops 路径)、读整个项目的;
 * - 端到端(真的文档服务 + 真的 src/mcp/handlers + createAgentSide):读工具、写工具的结果带 userEditing;
 *   覆盖了页面刚写的实体标「用户刚改过」,覆盖了别的 Agent 刚写的标「Agent <身份> 刚改过」。
 *
 * 跑法:node --test server/test/user-editing.test.mjs
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer as createVite } from 'vite';
import { createSharedDocService } from '../docservice/shared-service.mjs';
import { createAgentSide } from '../agent/agent-side.mjs';
import { loadSsrHost } from '../agent/ssr-host.mjs';
import {
  USER_EDITING_DEFAULTS, createUserEditingBoard, clipIdsOfArgs, clipIdsOfOps, userEditingFor, userEditingNotice,
  overwroteView, writerOf, annotateResult, annotateError,
} from '../agent/user-editing.mjs';
import { tools, toolGroups } from '../mcp-tools.mjs';
import { wsClient } from './fake-ws-kit.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/* ------------------------------------------------------------------ 纯逻辑 */

test('UE-S1 数字:拖动 / 文字编辑 15 秒没续期过期;「刚动过」最长 30 秒', () => {
  assert.equal(USER_EDITING_DEFAULTS.ttlMs, 15_000);
  assert.equal(USER_EDITING_DEFAULTS.recentMaxMs, 30_000);
});

test('UE-S2 记下与过期:整份替换这个页面的状态;拖动 15 秒没续期清掉,续期就留;「刚动过」按剩余毫秒到期;格式不对的跳过', () => {
  let t = 1_000_000;
  const b = createUserEditingBoard({ now: () => t });
  assert.equal(b.report('page-1', [
    { clipId: 'c1', kind: 'drag' },
    { clipId: 'c2', kind: 'recent', remainingMs: 8_000 },
    { clipId: 'c3', kind: 'recent' }, // 没带剩余毫秒:跳过
    { clipId: 'c4', kind: 'hover' }, // 不认识的种类:跳过
    { clipId: '', kind: 'text' },
    'x',
  ]), 2);
  assert.deepEqual(b.current().map((e) => [e.clipId, e.kind]), [['c1', 'drag'], ['c2', 'recent']]);
  t += 8_000;
  assert.deepEqual(b.current().map((e) => e.clipId), ['c1'], '「刚动过」到期');
  t += 6_000;
  b.report('page-1', [{ clipId: 'c1', kind: 'drag' }]); // 心跳续期
  t += 14_000;
  const kept = b.current();
  assert.deepEqual(kept.map((e) => e.clipId), ['c1'], '续过期的还在');
  assert.equal(kept[0].forMs, 28_000, 'forMs 从第一次报算起,续期不重置');
  t += 1_000;
  assert.deepEqual(b.current(), [], '15 秒没续期,清掉(页面关了或卡住)');
  b.report('page-1', [{ clipId: 'c5', kind: 'text' }]);
  b.report('page-1', []);
  assert.deepEqual(b.current(), [], '报空的就是全撤');
  assert.throws(() => b.report('bad session!', []), /session/);
  assert.throws(() => b.report('page-1', {}), /数组/);
});

test('UE-S3 汇总:几个页面报同一片段取最强的那种(拖动 > 文字编辑 > 刚动过);「刚动过」报得再长也按 30 秒截', () => {
  let t = 0;
  const b = createUserEditingBoard({ now: () => t });
  b.report('p1', [{ clipId: 'c1', kind: 'recent', remainingMs: 999_999 }, { clipId: 'c2', kind: 'text' }]);
  b.report('p2', [{ clipId: 'c1', kind: 'drag' }, { clipId: 'c2', kind: 'recent', remainingMs: 5_000 }]);
  assert.deepEqual(b.current().map((e) => [e.clipId, e.kind]), [['c1', 'drag'], ['c2', 'text']]);
  b.clear('p2');
  t = 29_999;
  assert.deepEqual(b.current().map((e) => e.clipId), ['c1']);
  t = 30_000;
  assert.deepEqual(b.current(), []);
});

test('UE-S4 碰到了哪些片段:参数点名、写到的路径(含 insert 的新片段、转义)、读整个项目的算全部', () => {
  assert.deepEqual(clipIdsOfArgs({ clipId: 'a', otherClipId: 'b', trackId: 't' }), ['a', 'b']);
  assert.deepEqual(clipIdsOfOps([
    { op: 'set', path: '/tracks/@t1/clips/@c1/opacity', value: 1 },
    { op: 'remove', path: '/tracks/@t1/clips/@c2' },
    { op: 'insert', path: '/tracks/@t2/clips', value: { id: 'c3' } },
    { op: 'set', path: '/tracks/@t1/clips/@x~1y/label', value: '' },
    { op: 'set', path: '/name', value: 'n' },
    '/tracks/@t1/clips/@c1',
  ]), ['c1', 'c2', 'c3', 'x/y']);
  const editing = [{ clipId: 'c1', kind: 'drag' }, { clipId: 'c2', kind: 'recent' }];
  assert.deepEqual(userEditingFor({ tool: 'get_clip', args: { clipId: 'c1' }, editing }), [{ clipId: 'c1', kind: 'drag' }]);
  assert.deepEqual(userEditingFor({ tool: 'get_clip', args: { clipId: 'c9' }, editing }), []);
  assert.deepEqual(userEditingFor({ tool: 'set_project_meta', args: {}, written: ['c2'], editing }), [{ clipId: 'c2', kind: 'recent' }], '参数没点名、实际写到的也算');
  assert.equal(userEditingFor({ tool: 'get_project', args: {}, editing }).length, 2, '读整个项目');
  assert.equal(userEditingFor({ tool: 'get_layout', args: {}, editing }).length, 2);
  assert.equal(userEditingFor({ tool: 'get_layout', args: { clipId: 'c9' }, editing }).length, 0);
  assert.deepEqual(userEditingFor({ tool: 'get_project', args: {}, editing: [] }), []);
});

test('UE-S5 提示的写法与放法:对象结果 notice 在最前、字段保留;数组包一层;没东西原样返回;报错接一句', () => {
  const ue = [{ clipId: 'c1', kind: 'drag' }, { clipId: 'c2', kind: 'text' }, { clipId: 'c3', kind: 'recent' }];
  assert.equal(userEditingNotice(ue).startsWith('用户正在编辑片段 c1(拖动中)、片段 c2(文字编辑中)、片段 c3(刚动过)。这是提示不是禁止'), true);
  const r = annotateResult({ ok: true, id: 'c1', rev: 3 }, { userEditing: ue.slice(0, 1) });
  assert.deepEqual(Object.keys(r), ['notice', 'userEditing', 'ok', 'id', 'rev']);
  assert.ok(r.notice.startsWith('用户正在编辑片段 c1(拖动中)'), r.notice);
  const plain = { ok: true };
  assert.equal(annotateResult(plain, { userEditing: [] }), plain, '没东西原样返回(同一个对象)');
  const arr = annotateResult([1, 2], { userEditing: ue.slice(0, 1) });
  assert.deepEqual(arr.result, [1, 2]);
  assert.match(arr.notice, /用户正在编辑/);
  // 先有 overwrote(执行器放的)再补 userEditing(入口放的):两个字段都在,两句都在
  const ov = [{ entity: '/tracks/@t1/clips/@c1', clipId: 'c1', by: 'user', who: '用户', label: '用户刚改过', rev: 2, agoMs: 3000 }];
  const both = annotateResult(annotateResult({ ok: true }, { overwrote: ov }), { userEditing: ue.slice(0, 1) });
  assert.deepEqual(both.overwrote, ov);
  assert.deepEqual(both.userEditing, ue.slice(0, 1));
  assert.ok(both.notice.startsWith('用户正在编辑片段 c1'), both.notice);
  assert.ok(both.notice.includes('\n这次写入覆盖了别人刚写的内容:片段 c1(用户刚改过,rev 2,3 秒前)'), both.notice);
  const err = annotateError(new Error('被拒了'), ue.slice(0, 1));
  assert.match(err.message, /^被拒了\n用户正在编辑片段 c1/);
});

test('UE-S6 写入方的标法:本机页面 = 用户;共享项目别的成员带名字;Agent 带对话 id 和厂商', () => {
  assert.deepEqual(writerOf({ role: 'page', userId: 'local', session: 'p' }), { by: 'user', who: '用户' });
  assert.equal(writerOf({ role: 'page', userId: 'bob' }).who, '用户 bob');
  assert.equal(writerOf({ role: 'agent', conversation: 2, session: 'agent:conv-B' }).who, 'Agent conv-B');
  assert.equal(writerOf({ role: 'agent', conversation: 2, session: 'agent:conv-B' }, (k) => (k === 'conv-B' ? 'claude' : null)).who, 'Agent conv-B(claude)');
  assert.equal(writerOf({ role: 'agent', conversation: 5 }).who, 'Agent 对话 5');
  const v = overwroteView([{ entity: '/tracks/@t1/clips/@c1', by: { role: 'page', userId: 'local' }, rev: 4, at: 1000 }, { entity: '/meta/name', by: { role: 'agent', session: 'agent:x' }, rev: 5, at: 2000 }], { now: 5000 });
  assert.deepEqual(v, [
    { entity: '/tracks/@t1/clips/@c1', clipId: 'c1', by: 'user', who: '用户', label: '用户刚改过', rev: 4, agoMs: 4000 },
    { entity: '/meta/name', by: 'agent', who: 'Agent x', label: 'Agent x刚改过', rev: 5, agoMs: 3000 },
  ]);
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
    const p = createEmptyProject('ue-test');
    p.id = projectId;
    p.tracks = [{ id: 't1', name: '画面', clips: [
      { id: 'c1', cardId: 'title', params: { text: '一' }, start: 0, end: 3 },
      { id: 'c2', cardId: 'title', params: { text: '二' }, start: 3, end: 6 },
    ] }];
    const reply = await pg.commit([{ op: 'set', path: '', value: p }]);
    assert.equal(reply.type, 'project.op.ok', JSON.stringify(reply));
    return pg;
  }

  function side(projectId, board, agentLabel = null) {
    const s = createAgentSide({
      projectId,
      url,
      protocolsFor: (n) => ['promptcut.v1', `promptcut.role.agent.${n}`],
      loadHost: () => loadSsrHost(load),
      tools,
      toolGroups,
      callPage: async () => { throw new Error('这个测试里没有页面'); },
      userEditing: () => board.current(),
      agentLabel,
    });
    closers.push(() => s.close());
    return s;
  }

  return { seeded, side };
}

test('UE-S7～S10 端到端:读 / 写工具的 userEditing;覆盖了页面写的标「用户刚改过」、覆盖了别的 Agent 写的标「Agent <身份> 刚改过」', async (t) => {
  const env = await startEnv(t);

  await t.test('UE-S7 读工具:用户正在拖动 c1 时 Agent 读 c1,结果带 userEditing 和提示;读 c2 不带', async () => {
    const pid = 'proj-ue-read';
    await env.seeded(pid);
    const board = createUserEditingBoard();
    board.report('page-x', [{ clipId: 'c1', kind: 'drag' }]);
    const s = env.side(pid, board);
    const r1 = await s.callTool('get_clip', { clipId: 'c1' }, { agent: 'conv-A' });
    assert.deepEqual(r1.userEditing, [{ clipId: 'c1', kind: 'drag' }]);
    assert.ok(r1.notice.startsWith('用户正在编辑片段 c1(拖动中)。这是提示不是禁止'), r1.notice);
    assert.equal(r1.rev, 1, '原本的字段照旧');
    const r2 = await s.callTool('get_clip', { clipId: 'c2' }, { agent: 'conv-A' });
    assert.equal(r2.userEditing, undefined);
    assert.equal(r2.notice, undefined);
    const whole = await s.callTool('get_project', {}, { agent: 'conv-A' });
    assert.deepEqual(whole.userEditing, [{ clipId: 'c1', kind: 'drag' }], '读整个项目也提示');
    assert.ok(Array.isArray(whole.tracks));
  });

  await t.test('UE-S8 写工具:用户刚动过 c2(选中后 30 秒内),Agent 改 c2 照样落地(只提示不拦),结果带 userEditing', async () => {
    const pid = 'proj-ue-write';
    await env.seeded(pid);
    const board = createUserEditingBoard();
    board.report('page-x', [{ clipId: 'c2', kind: 'recent', remainingMs: 20_000 }]);
    const s = env.side(pid, board);
    await s.callTool('get_project', {}, { agent: 'conv-A' });
    const w = await s.callTool('update_clip', { clipId: 'c2', opacity: 0.5 }, { agent: 'conv-A' });
    assert.equal(w.ok, true, JSON.stringify(w));
    assert.equal(w.rev, 2, '写入落地了');
    assert.deepEqual(w.userEditing, [{ clipId: 'c2', kind: 'recent' }]);
    assert.ok(w.notice.startsWith('用户正在编辑片段 c2(刚动过)'), w.notice);
    assert.equal(w.notice.includes('这次写入覆盖了'), false, '种子是从空项目整份写入的,不算覆盖');
  });

  await t.test('UE-S9 overwrote(页面写入):页面刚改过 c1,Agent 再改 c1,结果带 overwrote「用户刚改过」', async () => {
    const pid = 'proj-ue-ow-page';
    const pg = await env.seeded(pid);
    const board = createUserEditingBoard();
    const s = env.side(pid, board);
    const pageReply = await pg.commit([{ op: 'set', path: '/tracks/@t1/clips/@c1/label', value: '页面改的' }]);
    assert.equal(pageReply.rev, 2);
    await s.callTool('get_project', {}, { agent: 'conv-A' });
    await s.link.replica.waitRev(2, 3000);
    await s.callTool('get_clip', { clipId: 'c1' }, { agent: 'conv-A' });
    const w = await s.callTool('update_clip', { clipId: 'c1', opacity: 0.3 }, { agent: 'conv-A' });
    assert.equal(w.rev, 3);
    assert.equal(w.overwrote.length, 1, JSON.stringify(w.overwrote));
    const o = w.overwrote[0];
    assert.deepEqual({ entity: o.entity, clipId: o.clipId, by: o.by, who: o.who, label: o.label, rev: o.rev },
      { entity: '/tracks/@t1/clips/@c1', clipId: 'c1', by: 'user', who: '用户', label: '用户刚改过', rev: 2 });
    assert.ok(o.agoMs >= 0 && o.agoMs < 60_000);
    assert.match(w.notice, /^这次写入覆盖了别人刚写的内容:片段 c1\(用户刚改过,rev 2,\d+ 秒前\)。用户刚改过的地方被你这次写入盖掉了/);
    // 同一个对话紧接着再写 c1:上一次写入者就是自己,不再提示
    const again = await s.callTool('update_clip', { clipId: 'c1', opacity: 0.4 }, { agent: 'conv-A' });
    assert.equal(again.overwrote, undefined);
  });

  await t.test('UE-S10 overwrote(别的 Agent 写入):conv-B 刚改过 c2,conv-A 再改 c2,结果标「Agent conv-B(claude)刚改过」', async () => {
    const pid = 'proj-ue-ow-agent';
    await env.seeded(pid);
    const board = createUserEditingBoard();
    const s = env.side(pid, board, (key) => (key === 'conv-B' ? 'claude' : null));
    await s.callTool('get_project', {}, { agent: 'conv-A' });
    await s.callTool('get_project', {}, { agent: 'conv-B' });
    const b = await s.callTool('update_clip', { clipId: 'c2', opacity: 0.2 }, { agent: 'conv-B' });
    assert.equal(b.rev, 2);
    // conv-A 读到的是 rev 1,先重读再写(否则是 stale)
    await s.callTool('get_clip', { clipId: 'c2' }, { agent: 'conv-A' });
    const a = await s.callTool('update_clip', { clipId: 'c2', opacity: 0.9 }, { agent: 'conv-A' });
    assert.equal(a.rev, 3);
    assert.equal(a.overwrote.length, 1);
    assert.deepEqual({ clipId: a.overwrote[0].clipId, by: a.overwrote[0].by, who: a.overwrote[0].who, label: a.overwrote[0].label, rev: a.overwrote[0].rev },
      { clipId: 'c2', by: 'agent', who: 'Agent conv-B(claude)', label: 'Agent conv-B(claude)刚改过', rev: 2 });
    assert.match(a.notice, /别的 Agent 刚改过的地方被你这次写入盖掉了/);
  });
});
