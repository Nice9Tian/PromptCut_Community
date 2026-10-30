/**
 * C6.5 收尾:Agent 在服务端的写入让内容超出项目总时长时,总时长的连带更新随同一批 ops 提交(主会话裁定)。
 *
 * 以前:服务端只提交 handler 的改动,总时长由页面收到后按时间轴的规则补写一次 —— 那一次是页面身份的写入,
 * 这个 Agent 对话紧接着的下一次写入因版本不符(stale)被拒一次。
 * 现在:执行器在服务端副本上按 `src/kernel/duration.ts` 的同一条规则算好总时长(`settleDuration`),一起提交;
 * 页面收到后按自己的规则再算一遍,结果相同,不再补写。
 *
 * 用例 DUR-1～DUR-4:
 *   DUR-1 `settleDuration` 纯函数:跟内容走、截断保留、改了总时长按改后的推、只改名不碰、空项目、至少 1 s;
 *   DUR-2 端到端:Agent 加一张超出末尾的卡 → 同一次提交里总时长跟上;页面(真 DocSync + 页面的总时长规则)不补写;
 *         紧接着第二次写入不被拒;页面、文档服务、Agent 副本三份总时长一致;
 *   DUR-3 对照:同样的改动由不带总时长的写入方提交时,这个页面模拟确实会补写一次(证明 DUR-2 的「不补写」不是空断言);
 *   DUR-4 截断之后:Agent 先截断总时长,再加一张超出末尾的卡 → 总时长保持截断值;页面不补写,下一次写入不被拒。
 *
 * 页面一侧用真的 `src/store/docsync.ts`(DocSync)连真的文档服务,总时长照页面的两处代码算:
 * 收到远端改动时 `pageStateAfterRemote` 推手动值;时间轴 effect 按 `effectiveDuration` 算、`syncDuration`(至少 1 s)写。
 * 不 bindStore:服务端 store 在同一进程里被执行器用着。
 *
 * 跑:node --test server/test/agent-c65-duration.test.mjs
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer as createVite } from 'vite';
import { createSharedDocService } from '../docservice/shared-service.mjs';
import { createAgentLink } from '../agent/doc-link.mjs';
import { createAgentExecutor, settleDuration, StaleWriteError } from '../agent/agent-exec.mjs';
import { loadSsrHost } from '../agent/ssr-host.mjs';
import { tools, toolGroups } from '../mcp-tools.mjs';
import { waitFor, sleep } from './fake-ws-kit.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const toolDef = (name) => tools.find((t) => t.name === name);

/* ------------------------------------------------------------------ DUR-1 纯函数 */

const clip = (id, start, end) => ({ id, cardId: 'probe', params: {}, start, end });
const proj = (duration, clips, extra = {}) => ({ name: 'p', duration, tracks: [{ id: 't1', clips }], ...extra });

test('DUR-1 settleDuration:跟内容走、截断保留、改了总时长按改后的推、只改名不碰、空项目保留、至少 1 s', async () => {
  const rules = await import('../../src/kernel/duration.ts').catch(() => null)
    ?? (await createVite({ configFile: false, root: ROOT, logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } })
      .then(async (v) => { try { return await v.ssrLoadModule('/src/kernel/duration.ts'); } finally { await v.close(); } }));
  const base = proj(5, [clip('a', 0, 5)]);

  // 加一张超出末尾的卡:总时长跟到新的末尾
  const grown = proj(5, [clip('a', 0, 5), clip('b', 10, 14)]);
  assert.equal(settleDuration(base, grown, rules).duration, 14);
  // 内容缩短:跟着缩
  assert.equal(settleDuration(base, proj(5, [clip('a', 0, 3)]), rules).duration, 3);

  // 改前是截断的(总时长 3 < 末尾 5):加卡后仍保持截断值,原样回 after
  const cut = proj(3, [clip('a', 0, 5)]);
  const cutGrown = proj(3, [clip('a', 0, 5), clip('b', 10, 14)]);
  assert.equal(settleDuration(cut, cutGrown, rules), cutGrown);
  // 截断值比新末尾还长:夹到新末尾(与页面 effectiveDuration 的 min 相同)
  assert.equal(settleDuration(cut, proj(3, [clip('a', 0, 2)]), rules).duration, 2);

  // 这次写入自己改了总时长(set_project_meta 截断到 4):按改后的推,保持 4
  const metaCut = proj(4, [clip('a', 0, 5)]);
  assert.equal(settleDuration(base, metaCut, rules), metaCut);
  // 改成比末尾长的值:拉不长,回到末尾
  assert.equal(settleDuration(base, proj(9, [clip('a', 0, 5)]), rules).duration, 5);

  // 片段、总时长都没变(只改名):不碰
  const renamed = { ...base, name: '改名' };
  assert.equal(settleDuration(base, renamed, rules), renamed);
  // 页面也不会为这次写入跑时间轴的 effect,所以即使改前本来就不一致也不在这里顺手改
  const loose = proj(30, [clip('a', 0, 5)]);
  const looseRenamed = { ...loose, name: 'x' };
  assert.equal(settleDuration(loose, looseRenamed, rules), looseRenamed);

  // 空项目:保留原值
  const empty = proj(30, []);
  const emptyTouched = { ...empty, tracks: [{ id: 't1', clips: [] }, { id: 't2', clips: [] }] };
  assert.equal(settleDuration(empty, emptyTouched, rules), emptyTouched);
  // 从空项目加第一张卡:跟到它的末尾
  assert.equal(settleDuration(empty, proj(30, [clip('a', 2, 6)]), rules).duration, 6);

  // 至少 1 s(与 syncDuration 相同)
  assert.equal(settleDuration(base, proj(5, [clip('a', 0, 0.4)]), rules).duration, 1);
});

/* ------------------------------------------------------------------ 端到端的环境 */

async function startEnv(t) {
  const server = http.createServer((req, res) => { res.statusCode = 404; res.end(); });
  const built = createSharedDocService({ mode: 'lan', dataDir: null, store: null, server, path: '/docservice', isLoopback: () => true, localDevice: { deviceId: 'pc-test-device-0001', deviceName: 'test' }, log: () => {} });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${server.address().port}/docservice`;
  const vite = await createVite({ configFile: false, root: ROOT, logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  const closers = [];
  t.after(async () => {
    for (const c of closers.reverse()) { try { c(); } catch { /* 已关 */ } }
    await vite.close();
    await built.service.close();
    await new Promise((resolve) => server.close(resolve));
  });
  const load = (id) => vite.ssrLoadModule(id);
  const { createEmptyProject } = await load('/src/kernel/project.ts');
  const { DocSync } = await load('/src/store/docsync.ts');
  const { pageStateAfterRemote } = await load('/src/store/remotePageState.ts');
  const { contentEndOf, effectiveDuration } = await load('/src/kernel/duration.ts');

  /** 项目:t1 上一张 0～5 s 的卡,总时长 5(与内容末尾一致,页面打开时不会补写) */
  function project(projectId) {
    const p = createEmptyProject('duration-test');
    p.id = projectId;
    p.duration = 5;
    p.tracks = [
      { id: 't1', name: '画面', clips: [{ id: 'c1', cardId: 'probe', params: {}, start: 0, end: 5 }] },
      { id: 't2', name: '空', clips: [] },
    ];
    return p;
  }

  /** 一条裸连接(本机页面身份):发提交、读真身 */
  async function raw(session) {
    const ws = new WebSocket(url);
    closers.push(() => ws.close());
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
    const inbox = [];
    ws.addEventListener('message', (e) => inbox.push(JSON.parse(e.data)));
    let seq = 0;
    const next = (match, ms = 3000) => waitFor(() => { const i = inbox.findIndex(match); return i >= 0 ? inbox.splice(i, 1)[0] : null; }, ms);
    return {
      async open(projectId) {
        ws.send(JSON.stringify({ type: 'project.open', projectId, reqId: `open-${++seq}` }));
        return next((m) => m.type === 'project.state');
      },
      async commit(projectId, ops) {
        const opId = `${session}-op-${++seq}`;
        ws.send(JSON.stringify({ type: 'project.op', projectId, opId, session, ops, reqId: opId }));
        return next((m) => m.reqId === opId);
      },
    };
  }

  async function seeded(projectId) {
    const r = await raw('seed');
    await r.open(projectId);
    const reply = await r.commit(projectId, [{ op: 'set', path: '', value: project(projectId) }]);
    assert.equal(reply.type, 'project.op.ok', JSON.stringify(reply));
    return r;
  }

  /** 真页面的数据流(DocSync)+ 页面的总时长规则;回 { ds, commits(), duration(), manual() } */
  async function page(projectId, session = 'page-1') {
    const ws = new WebSocket(url);
    closers.push(() => ws.close());
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
    const sent = [];
    const ds = new DocSync(createEmptyProject('空'), {
      projectId, session,
      send: (m) => { if (m.type === 'project.op') sent.push(m); ws.send(JSON.stringify(m)); },
    });
    ws.addEventListener('message', (e) => ds.receive(JSON.parse(e.data)));
    // 页面状态里只有总时长手动值与这条规则相关
    const st = { t: 0, selection: [], durationManual: null, playToken: 0 };
    let prev = ds.project;
    ds.on('project', (next, cause) => {
      const before = prev;
      prev = next;
      if (cause === 'commit') return;
      // docsync.ts bindStore:别人的改动 → 页面状态跟着推(总时长手动值)
      if (cause === 'remote') {
        const patch = pageStateAfterRemote(before, next, st);
        if (patch && 'durationManual' in patch) st.durationManual = patch.durationManual;
      }
      // 时间轴 effect(src/editor/timeline/index.tsx)+ actions.syncDuration(至少 1 s、差不到 1e-6 不写)
      queueMicrotask(() => {
        const p = ds.project;
        const target = effectiveDuration(contentEndOf(p.tracks), p.duration, st.durationManual);
        if (Math.abs(target - p.duration) <= 1e-6) return;
        const val = Math.max(1, target);
        if (Math.abs(val - p.duration) < 1e-6) return;
        ds.commit({ ...p, duration: val }, { undoable: false });
      });
    });
    ds.connect();
    await waitFor(() => ds.status === 'online', 5000);
    return { ds, st, commits: () => sent.length, duration: () => ds.project.duration };
  }

  function agent(projectId) {
    const link = createAgentLink({ url, projectId, protocolsFor: (n) => ['promptcut.v1', `promptcut.role.agent.${n}`] });
    closers.push(() => link.close());
    const executor = createAgentExecutor({ link, loadHost: () => loadSsrHost(load), toolGroups });
    const call = (tool, args, key = 'conv-A') => executor.track(tool, args, key, (ctx) => executor.execute(tool, args, key, toolDef(tool), ctx));
    return { link, executor, call };
  }

  return { raw, seeded, page, agent };
}

/** 页面把收到的改动都处理完、该补写的(如果有)也发出去并确认 */
async function quiet(pg, ms = 300) {
  await sleep(ms);
  await waitFor(() => pg.ds.unconfirmed === 0, 3000);
}

/* ------------------------------------------------------------------ DUR-2 */

test('DUR-2 Agent 加一张超出末尾的卡:总时长随同一次提交跟上;页面不补写;紧接着第二次写入不被拒;三份总时长一致', async (t) => {
  const env = await startEnv(t);
  const probe = await env.seeded('proj-dur');
  const pg = await env.page('proj-dur');
  assert.equal(pg.ds.rev, 1);
  assert.equal(pg.duration(), 5);
  const ag = env.agent('proj-dur');

  assert.equal((await ag.call('get_project', {})).rev, 1);
  const added = await ag.call('add_clip', { cardId: 'probe', start: 10, duration: 4, trackId: 't2' });
  assert.equal(added.rev, 2, '加卡落地为 rev 2');

  // 页面收到 rev 2:按页面的规则算,总时长已经是 14,不补写
  await waitFor(() => pg.ds.rev >= 2, 3000);
  await quiet(pg);
  assert.equal(pg.commits(), 0, '页面没有补写总时长');
  assert.equal(pg.duration(), 14);

  const body2 = await probe.open('proj-dur');
  assert.equal(body2.rev, 2, '文档服务里只有加卡这一次提交');
  assert.equal(body2.project.duration, 14, '总时长随加卡那一次提交落地');

  // 紧接着的第二次写入:期望版本 = 2 = 当前版本,不被拒
  let second;
  try {
    second = await ag.call('update_clip', { clipId: 'c1', opacity: 0.5 });
  } catch (err) {
    assert.fail(`第二次写入被拒:${err instanceof StaleWriteError ? err.message : err}`);
  }
  assert.equal(second.rev, 3);
  assert.equal(ag.executor.describe().stats.stale, 0);

  await waitFor(() => pg.ds.rev >= 3, 3000);
  await quiet(pg);
  const body3 = await probe.open('proj-dur');
  assert.equal(body3.rev, 3);
  assert.equal(pg.commits(), 0);
  assert.deepEqual([pg.duration(), body3.project.duration, ag.link.replica.project.duration], [14, 14, 14], '页面、文档服务、Agent 副本的总时长一致');
  assert.equal(JSON.stringify(pg.ds.project), JSON.stringify(body3.project), '页面与真身逐项相同');
});

/* ------------------------------------------------------------------ DUR-3 对照 */

test('DUR-3 对照:同样的加卡由不带总时长的写入方提交时,页面按自己的规则补写一次总时长(以前 Agent 就是这样)', async (t) => {
  const env = await startEnv(t);
  const probe = await env.seeded('proj-ctl');
  const pg = await env.page('proj-ctl');
  const other = await env.raw('other');
  await other.open('proj-ctl');
  const reply = await other.commit('proj-ctl', [{ op: 'insert', path: '/tracks/@t2/clips', index: 0, value: { id: 'x1', cardId: 'probe', params: {}, start: 10, end: 14 } }]);
  assert.equal(reply.type, 'project.op.ok');
  await waitFor(() => pg.ds.rev >= 2, 3000);
  await quiet(pg);
  assert.equal(pg.commits(), 1, '页面补写了一次');
  const body = await probe.open('proj-ctl');
  assert.deepEqual([body.rev, body.project.duration], [3, 14], '补写是单独的一次提交(rev 3)');
});

/* ------------------------------------------------------------------ DUR-4 截断 */

test('DUR-4 截断之后:Agent 截断总时长、再加一张超出末尾的卡,总时长保持截断值;页面不补写,下一次写入不被拒', async (t) => {
  const env = await startEnv(t);
  const probe = await env.seeded('proj-cut');
  const pg = await env.page('proj-cut');
  const ag = env.agent('proj-cut');

  await ag.call('get_project', {});
  const cut = await ag.call('set_project_meta', { duration: 3 });
  assert.equal(cut.rev, 2);
  await waitFor(() => pg.ds.rev >= 2, 3000);
  await quiet(pg);
  assert.deepEqual([pg.duration(), pg.st.durationManual], [3, 3], '页面按远端改动记下手动值');

  const added = await ag.call('add_clip', { cardId: 'probe', start: 10, duration: 4, trackId: 't2' });
  assert.equal(added.rev, 3);
  await waitFor(() => pg.ds.rev >= 3, 3000);
  await quiet(pg);
  const again = await ag.call('update_clip', { clipId: 'c1', opacity: 0.4 });
  assert.equal(again.rev, 4, '下一次写入不被拒');
  await waitFor(() => pg.ds.rev >= 4, 3000);
  await quiet(pg);

  const body = await probe.open('proj-cut');
  assert.equal(body.rev, 4);
  assert.equal(pg.commits(), 0, '页面一次都没补写');
  assert.deepEqual([pg.duration(), body.project.duration, ag.link.replica.project.duration], [3, 3, 3], '总时长保持截断值,三份一致');
});
