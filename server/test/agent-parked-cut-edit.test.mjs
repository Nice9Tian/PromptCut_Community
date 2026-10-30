/**
 * 云端 Agent 不切换激活剪辑、就地改停放剪辑里的片段(线上 2026-10-21:每轮 switch_cut 过去、改、再切回来,
 * 一次必败的 update_clip + 两次多余的写入,activeCutId 是共享字段,所有成员的界面一起翻)。
 *
 * 真的文档服务 + 真的执行器(vite ssrLoadModule 载入页面那一套工具实现与 store),Agent 一侧经路由表跑 handler:
 *   PK-1 update_clip 改停放剪辑里的片段:只提交一次,activeCutId 与激活剪辑原样,
 *        回包标明在哪条剪辑;文档服务里的真身与 Agent 副本一致;
 *   PK-2 set_rect / get_clip / list_cuts({cutId}) 同样不切换;紧接着对激活剪辑里的片段写入不被拒(没有 stale);
 *   PK-3 删除停放剪辑里的片段:明确的原因(在哪条剪辑、要 switch_cut),什么都不提交;
 *   PK-4 模型只读 get_project(云端副本)里的 parkedCuts 就找到并改好停放剪辑里的片段,全程没有 switch_cut(线上 2026-10-21:
 *        新对话里模型因为只在 get_project 里看得到激活剪辑,两次都 switch_cut -> update_clip -> switch_cut);
 *   PK-5 list_cuts 不带参数也列出停放剪辑的片段;switch_cut 的回包说明切换会让所有成员的界面一起翻。
 *
 * 跑:node --test server/test/agent-parked-cut-edit.test.mjs
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer as createVite } from 'vite';
import { createSharedDocService } from '../docservice/shared-service.mjs';
import { createAgentLink } from '../agent/doc-link.mjs';
import { createAgentExecutor } from '../agent/agent-exec.mjs';
import { loadSsrHost } from '../agent/ssr-host.mjs';
import { tools, toolGroups } from '../mcp-tools.mjs';
import { waitFor } from './fake-ws-kit.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const toolDef = (name) => tools.find((t) => t.name === name);

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

  /** A 激活:t1 上一张 c1(0~5);B 停放:tb 上一张 cb1(0~4) */
  function project(projectId) {
    const p = createEmptyProject('parked-test');
    p.id = projectId;
    p.duration = 5;
    p.tracks = [{ id: 't1', name: '画面', clips: [{ id: 'c1', cardId: 'probe', params: {}, start: 0, end: 5 }] }];
    p.cuts = [
      { id: 'cutA', name: '剪辑1' },
      { id: 'cutB', name: '剪辑2', duration: 4, transitions: [], tracks: [{ id: 'tb', name: 'B序列', clips: [{ id: 'cb1', cardId: 'probe', label: '粒子背景', params: {}, start: 0, end: 4 }] }] },
    ];
    p.activeCutId = 'cutA';
    return p;
  }

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

  function agent(projectId) {
    const link = createAgentLink({ url, projectId, protocolsFor: (n) => ['promptcut.v1', `promptcut.role.agent.${n}`] });
    closers.push(() => link.close());
    const executor = createAgentExecutor({ link, loadHost: () => loadSsrHost(load), toolGroups });
    const call = (tool, args, key = 'conv-A') => executor.track(tool, args, key, (ctx) => executor.execute(tool, args, key, toolDef(tool), ctx));
    return { link, executor, call };
  }

  return { raw, seeded, agent };
}

const cutOf = (p, id) => p.cuts.find((c) => c.id === id);

test('PK-1 update_clip 改停放剪辑里的片段:一次提交,activeCutId 与激活剪辑原样,回包标明在哪条剪辑', async (t) => {
  const env = await startEnv(t);
  const probe = await env.seeded('proj-pk1');
  const ag = env.agent('proj-pk1');

  const before = (await ag.call('get_project', {}));
  const rev0 = before.rev;
  assert.equal(before.activeCutId, 'cutA');

  const r = await ag.call('update_clip', { clipId: 'cb1', opacity: 0.5, fadeIn: 0.3 });
  assert.equal(r.ok, true);
  assert.equal(r.rev, rev0 + 1, '只提交了一次(以前是 switch_cut、update_clip、switch_cut 三次)');
  assert.deepEqual(r.cut, { id: 'cutB', name: '剪辑2', active: false });
  assert.equal(r.look?.args?.cutId, 'cutB', 'look 带上 cutId:看它的画面用 see_frames 传 cutId,不用切换(2026-10-21)');
  assert.deepEqual(r.timeline.tracks.map((x) => x.trackId), ['tb'], 'timeline 是 B 的');

  const body = await probe.open('proj-pk1');
  assert.equal(body.rev, rev0 + 1);
  assert.equal(body.project.activeCutId, 'cutA', '没有切换');
  assert.deepEqual(body.project.tracks.map((x) => x.id), ['t1']);
  assert.equal(body.project.tracks[0].clips[0].opacity, undefined, '激活剪辑里的片段没动');
  const clip = cutOf(body.project, 'cutB').tracks[0].clips[0];
  assert.deepEqual([clip.opacity, clip.fadeIn], [0.5, 0.3]);
  assert.equal(JSON.stringify(ag.link.replica.project), JSON.stringify(body.project), 'Agent 副本与真身逐项相同');
});

test('PK-2 get_clip / set_rect / list_cuts({cutId}) 不切换;紧接着对激活剪辑里的片段写入不被拒', async (t) => {
  const env = await startEnv(t);
  const probe = await env.seeded('proj-pk2');
  const ag = env.agent('proj-pk2');
  await ag.call('get_project', {});

  const listed = await ag.call('list_cuts', { cutId: 'cutB' });
  assert.deepEqual(listed.timeline.tracks.map((x) => [x.trackId, x.clips.map((c) => c.id)]), [['tb', ['cb1']]]);
  assert.equal(listed.activeCutId, 'cutA');

  const env1 = await ag.call('get_clip', { clipId: 'cb1' });
  assert.equal(env1.cut.id, 'cutB');
  assert.equal(env1.time.end, 4);

  const placed = await ag.call('set_rect', { clipId: 'cb1', x1: 100, y1: 100, x2: 400, y2: 300 });
  assert.equal(placed.cut.id, 'cutB');
  assert.ok(placed.layout.local, '框写进去了');

  const second = await ag.call('update_clip', { clipId: 'c1', opacity: 0.4 });
  assert.equal(second.ok, true);
  assert.equal(ag.executor.describe().stats.stale, 0);

  const body = await probe.open('proj-pk2');
  assert.equal(body.project.activeCutId, 'cutA');
  assert.ok(cutOf(body.project, 'cutB').tracks[0].clips[0].frame, 'B 里的片段有框');
  assert.equal(body.project.tracks[0].clips[0].opacity, 0.4, 'A 里的片段改了');
  assert.equal(cutOf(body.project, 'cutB').tracks[0].clips[0].opacity, undefined);
});

test('PK-3 删除停放剪辑里的片段:说清在哪条剪辑、要 switch_cut,什么都不提交', async (t) => {
  const env = await startEnv(t);
  const probe = await env.seeded('proj-pk3');
  const ag = env.agent('proj-pk3');
  const rev0 = (await ag.call('get_project', {})).rev;
  await assert.rejects(() => ag.call('remove_clip', { clipId: 'cb1', force: true, reason: '测' }), /它在剪辑「剪辑2」\(cutB\)里.*switch_cut/);
  const body = await probe.open('proj-pk3');
  assert.equal(body.rev, rev0, '没有提交');
  assert.equal(cutOf(body.project, 'cutB').tracks[0].clips.length, 1);
});

test('PK-4 模型只读 get_project 的 parkedCuts 就找到并改好停放剪辑里的片段,全程没有 switch_cut', async (t) => {
  const env = await startEnv(t);
  const probe = await env.seeded('proj-pk4');
  const ag = env.agent('proj-pk4');
  /** 照着工具回包办事的「模型」:不认识 clipId,只能读 get_project 的回包找;找不到才会想到 switch_cut(线上的做法) */
  const called = [];
  const run = (tool, args) => { called.push(tool); return ag.call(tool, args); };

  const project = await run('get_project', {});
  assert.equal(Object.keys(project)[0], 'parkedCuts', '索引排在最前面');
  assert.deepEqual(project.parkedCuts.cuts.map((c) => c.cutId), ['cutB']);
  assert.deepEqual(project.parkedCuts.cuts[0].clips, [{ id: 'cb1', trackId: 'tb', cardId: 'probe', label: '粒子背景', start: 0, end: 4 }]);
  assert.match(project.parkedCuts.note, /不用 user_interface_switch_cut/);
  assert.deepEqual(project.tracks.map((x) => x.id), ['t1'], 'tracks 仍是激活剪辑的');

  const hit = project.parkedCuts.cuts.find((c) => c.name === '剪辑2')?.clips.find((c) => c.label === '粒子背景');
  assert.ok(hit, '在 parkedCuts 里找到了,不必为了看进剪辑2 而切换');
  const r = await run('update_clip', { clipId: hit.id, opacity: 0.25 });
  assert.equal(r.ok, true);
  assert.equal(r.rev, project.rev + 1, '只提交了一次');
  assert.deepEqual(called, ['get_project', 'update_clip'], '没有 switch_cut');

  const body = await probe.open('proj-pk4');
  assert.equal(body.project.activeCutId, 'cutA', 'activeCutId 没动(其他成员的界面不翻)');
  assert.equal(cutOf(body.project, 'cutB').tracks[0].clips[0].opacity, 0.25);
  assert.equal(body.project.tracks[0].clips[0].opacity, undefined);
});

test('PK-5 list_cuts 不带参数也列出停放剪辑的片段;switch_cut 的回包说明切换会让所有成员的界面一起翻', async (t) => {
  const env = await startEnv(t);
  const probe = await env.seeded('proj-pk5');
  const ag = env.agent('proj-pk5');
  await ag.call('get_project', {});

  const listed = await ag.call('list_cuts', {});
  assert.deepEqual(listed.parkedCuts.cuts.map((c) => [c.cutId, c.clips.map((x) => x.id)]), [['cutB', ['cb1']]]);
  assert.equal('timeline' in listed, false);

  const edited = await ag.call('update_clip', { clipId: 'c1', opacity: 0.4 });
  assert.deepEqual(edited.timeline.otherCuts.cuts, [{ cutId: 'cutB', name: '剪辑2', clipCount: 1 }], '激活剪辑的回包 timeline 提示别的剪辑里有片段');

  const sw = await ag.call('switch_cut', { cutId: 'cutB' });
  assert.equal(sw.activeCutId, 'cutB');
  assert.match(sw.note, /所有成员的界面一起翻/);
  assert.match(sw.note, /不需要它/);
  const body = await probe.open('proj-pk5');
  assert.equal(body.project.activeCutId, 'cutB', '用户明说要切时仍然能切');
});
