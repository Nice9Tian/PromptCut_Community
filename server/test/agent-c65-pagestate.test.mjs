/**
 * c65-integ2:既读页面状态又写项目的 5 个工具(set_project_meta、switch_cut、add_cut、remove_cut、attach_clip_motion)
 * 改为写入在 Agent 服务端以 agent 身份执行,所需的页面状态向页面要一次(主会话裁定,D1 判据);
 * 以及同一批落实的:Agent 侧超过 256 KiB 的写走 project.upload、事件带 callId、远端改动后的页面状态(页面侧纯函数)。
 *
 * 用例 AP-1～AP-9。真的 src/mcp/handlers(vite ssrLoadModule)+ server/agent/agent-side.mjs(与 vite-plugin-ai 同一份组装)
 * + 真的文档服务(WebSocket);页面通道(SSE)由 callPage 假件代替,记下每次调用。
 * 跑:node --test server/test/agent-c65-pagestate.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer as createVite } from 'vite';
import { createSharedDocService } from '../docservice/shared-service.mjs';
import { createAgentSide, PAGE_STATE_TOOL } from '../agent/agent-side.mjs';
import { PAGE_STATE_TOOLS } from '../agent/agent-exec.mjs';
import { loadSsrHost } from '../agent/ssr-host.mjs';
import { tools, toolGroups } from '../mcp-tools.mjs';
import { wsClient, waitFor } from './fake-ws-kit.mjs';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');

async function startEnv(t) {
  const server = http.createServer((req, res) => { res.statusCode = 404; res.end(); });
  const built = createSharedDocService({ mode: 'lan', dataDir: null, store: null, server, path: '/docservice', isLoopback: () => true, localDevice: { deviceId: 'pc-test-device-0001', deviceName: 'test' }, log: () => {} });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${server.address().port}/docservice`;
  const vite = await createVite({ configFile: false, root: ROOT, logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  const sides = [];
  const clients = [];
  t.after(async () => {
    for (const s of sides) s.close();
    for (const c of clients) c.close();
    await vite.close();
    await built.service.close();
    await new Promise((resolve) => server.close(resolve));
  });
  const load = (id) => vite.ssrLoadModule(id);

  /** 页面:回环、什么都不带 = 本机页面身份;打开项目收广播 */
  async function page(projectId, session = 'page-1') {
    const c = wsClient(url);
    clients.push(c);
    await c.opened;
    let seq = 0;
    const api = {
      c,
      async open() {
        c.send({ type: 'project.open', projectId, reqId: `open-${++seq}` });
        return c.next((m) => m.type === 'project.state', 5000);
      },
      async commit(ops) {
        const opId = `${session}-op-${++seq}`;
        c.send({ type: 'project.op', projectId, opId, session, ops, reqId: opId });
        return c.next((m) => m.reqId === opId, 5000);
      },
      ops: () => c.all.filter((m) => m.type === 'project.ops'),
      events: () => c.all.filter((m) => m.type === 'events.event'),
    };
    return api;
  }

  /** 读文档服务当前的 { rev, project };大项目的 project.state 是分片发的(parts → part… → end),拼起来 */
  async function stateOf(projectId) {
    const p = await page(projectId, 'reader');
    const st = await p.open();
    if (st.project === undefined && Number.isSafeInteger(st.parts)) {
      await p.c.next((m) => m.type === 'project.state.end' && m.rev === st.rev, 5000);
      const parts = p.c.all.filter((m) => m.type === 'project.state.part' && m.rev === st.rev).sort((x, y) => x.index - y.index);
      st.project = JSON.parse(parts.map((m) => m.data).join(''));
    }
    p.c.close();
    return st;
  }

  /**
   * Agent 服务端:callPage 假件记下调用;`pageState` 是页面对 __page_state 的回答(函数或值),
   * `pageDown` 为真时页面通道不通(模拟编辑台没打开)。
   */
  function agent(projectId, { pageState = null, pageDown = false, pageResult, onPage = null } = {}) {
    const pageCalls = [];
    const side = createAgentSide({
      projectId,
      url,
      protocolsFor: (n) => ['promptcut.v1', `promptcut.role.agent.${n}`],
      tools,
      toolGroups,
      loadHost: () => loadSsrHost(load),
      pageResult: pageResult ?? 'plain',
      callPage: async (tool, args) => {
        pageCalls.push({ tool, args });
        if (pageDown) throw new Error('The editor is not open: no page is connected to /api/mcp/events');
        if (tool === PAGE_STATE_TOOL) {
          const v = typeof pageState === 'function' ? pageState(args) : pageState;
          return pageResult === 'wrapped' ? { result: v } : v;
        }
        if (onPage) return onPage(tool, args);
        return { ok: true, fromPage: tool };
      },
    });
    sides.push(side);
    const call = async (tool, args = {}, opts = {}) => {
      try {
        return { ok: true, value: await side.callTool(tool, args, { agent: 'conv-A', ...opts }) };
      } catch (err) {
        return { ok: false, error: err };
      }
    };
    return { side, call, pageCalls };
  }

  return { url, load, page, stateOf, agent };
}

/** 带剪辑的小项目:激活剪辑 k1 上有一张卡(0～12 s),另有两条停放的剪辑 k2(停放播放头 7)、k3 */
function cutsProject() {
  return {
    version: 1, id: 'p-ps', name: 'Cut', width: 1920, height: 1080, fps: 30, duration: 12, themeId: 'midnight', media: [],
    tracks: [{ id: 't1', name: 'Track 1', clips: [{ id: 'c1', cardId: 'title', start: 0, end: 12, params: {}, label: 'Card' }] }, { id: 't2', name: 'Track 2', clips: [] }],
    transitions: [],
    activeCutId: 'k1',
    cuts: [
      { id: 'k1', name: 'Cut 1' },
      { id: 'k2', name: 'Cut 2', tracks: [{ id: 't9', name: 'Track 1', clips: [] }], duration: 20, transitions: [], t: 7 },
      { id: 'k3', name: 'Cut 3', tracks: [{ id: 't8', name: 'Track 1', clips: [] }], duration: 30, transitions: [] },
    ],
  };
}

/** 带素材与卡的小项目(追踪绑定用):素材段 v1 0～10 s,卡 c1 在 2～4 s */
function motionProject() {
  return {
    version: 1, id: 'p-mo', name: 'Tracking', width: 1920, height: 1080, fps: 30, duration: 10, themeId: 'midnight',
    media: [{ id: 'm1', kind: 'video', name: 'Street scene', url: '/media/m1', width: 1280, height: 720, duration: 10 }],
    tracks: [
      { id: 't1', name: 'Track 1', clips: [{ id: 'c1', cardId: 'title', start: 2, end: 4, params: {}, label: 'Follow' }] },
      { id: 't2', name: 'Track 2', clips: [{ id: 'v1', mediaId: 'm1', start: 0, end: 10, mediaOffset: 0 }] },
    ],
  };
}

/** 100 帧轨迹:从 (100,100) 匀速走到 (298,199) */
function trackResult() {
  const xy = Array.from({ length: 100 }, (_, i) => [100 + i * 2, 100 + i]);
  return { engine: 'template', createdAt: '2026-09-26T00:00:00Z', width: 1280, height: 720, frames: 100, points: [{ xy, visible: xy.map(() => true) }] };
}

async function seeded(env, projectId, project) {
  const p = await env.page(projectId, 'seeder');
  await p.open();
  const r = await p.commit([{ op: 'set', path: '', value: project }]);
  assert.equal(r.type, 'project.op.ok', JSON.stringify(r));
  return p;
}

const pageStateCalls = (a) => a.pageCalls.filter((c) => c.tool === PAGE_STATE_TOOL);

// ------------------------------------------------------------------ 工具表

test('AP-1 tool table: all five tools are on the Agent server side (side agent); only the two cut-switching ones (playhead) and attach_clip_motion (trajectory) need page state', () => {
  const side = (n) => tools.find((t) => t.name === n)?.side;
  for (const n of ['set_project_meta', 'user_interface_switch_cut', 'add_cut', 'remove_cut', 'attach_clip_motion']) assert.equal(side(n), 'agent', n);
  // add_cut 2026-10-21 起只建不切,不再要播放头;切剪辑改名 user_interface_switch_cut
  assert.deepEqual(Object.fromEntries(Object.entries(PAGE_STATE_TOOLS).map(([k, v]) => [k, [...v]])), {
    user_interface_switch_cut: ['t'], remove_cut: ['t'], attach_clip_motion: ['track'],
  });
});

// ------------------------------------------------------------------ 切剪辑

test('AP-2 switch_cut: asks the page for the playhead once; the write goes into the document service as the agent; the cut being left parks the page\'s playhead; it is not executed through the page', async (t) => {
  const env = await startEnv(t);
  const watcher = await seeded(env, 'p-ps-2', cutsProject());
  const a = env.agent('p-ps-2', { pageState: { t: 4.5 } });
  const r = await a.call('user_interface_switch_cut', { cutId: 'k2' });
  assert.ok(r.ok, String(r.error?.message ?? ''));
  assert.equal(r.value.activeCutId, 'k2');
  assert.deepEqual(pageStateCalls(a), [{ tool: PAGE_STATE_TOOL, args: { tool: 'user_interface_switch_cut', args: { cutId: 'k2' }, keys: ['t'] } }], 'page state is requested only once, and only the playhead');
  assert.ok(!a.pageCalls.some((c) => c.tool === 'switch_cut' || c.tool === 'user_interface_switch_cut'), 'the write does not go through the page');
  // 旧名照常认(老对话的历史里还是旧名)
  const back = await a.call('switch_cut', { cutId: 'k1' });
  assert.ok(back.ok, String(back.error?.message ?? ''));
  assert.equal(back.value.activeCutId, 'k1');
  const again = await a.call('user_interface_switch_cut', { cutId: 'k2' });
  assert.ok(again.ok, String(again.error?.message ?? ''));
  const st = await env.stateOf('p-ps-2');
  assert.equal(st.project.activeCutId, 'k2');
  assert.equal(st.project.cuts.find((c) => c.id === 'k1').t, 4.5, 'the cut being left parks the playhead given by the page');
  assert.equal(st.project.cuts.find((c) => c.id === 'k2').t, undefined, 'the entry of the cut being switched to no longer keeps a parked playhead (the page takes it from the version before the switch)');
  await waitFor(() => watcher.ops().length >= 1, 3000, 'the page receives this commit');
  const op = watcher.ops().at(-1);
  assert.equal(op.actor.role, 'agent');
  assert.equal(op.actor.conversation, 1);
});

test('AP-3 add_cut only creates without switching (needs no page state); switching over and remove_cut (deleting the current cut) each ask the page for the playhead once; when the page channel is down, it falls back to the playhead the server remembers and the write still succeeds', async (t) => {
  const env = await startEnv(t);
  await seeded(env, 'p-ps-3', cutsProject());
  const a = env.agent('p-ps-3', { pageState: { t: 2.25 } });
  const added = await a.call('add_cut', { name: 'New cut' });
  assert.ok(added.ok, String(added.error?.message ?? ''));
  let st = await env.stateOf('p-ps-3');
  assert.equal(st.project.cuts.length, 4);
  assert.equal(st.project.activeCutId, 'k1', 'add_cut only creates without switching (user decision, 2026-10-21)');
  assert.equal(pageStateCalls(a).length, 0, 'add_cut needs no page state');
  const sw0 = await a.call('user_interface_switch_cut', { cutId: added.value.cut.id });
  assert.ok(sw0.ok, String(sw0.error?.message ?? ''));
  st = await env.stateOf('p-ps-3');
  assert.equal(st.project.activeCutId, added.value.cut.id);
  assert.equal(st.project.cuts.find((c) => c.id === 'k1').t, 2.25, 'the original cut parks the playhead given by the page');

  const removed = await a.call('remove_cut', { cutId: added.value.cut.id });
  assert.ok(removed.ok, String(removed.error?.message ?? ''));
  st = await env.stateOf('p-ps-3');
  assert.equal(st.project.cuts.length, 3);
  assert.ok(removed.value.switchedTo, 'the cut deleted is the current one, switched to the adjacent one');
  assert.equal(pageStateCalls(a).length, 2, 'each call asks once');

  const down = env.agent('p-ps-3', { pageDown: true });
  const sw = await down.call('user_interface_switch_cut', { cutId: 'k3' });
  assert.ok(sw.ok, `switching works even without the page: ${sw.error?.message ?? ''}`);
  assert.equal(pageStateCalls(down).length, 1, 'the page channel was tried once');
});

// ------------------------------------------------------------------ set_project_meta

test('AP-4 set_project_meta: does not read page state, executes directly on the server; if duration is shorter than the content end, the content is truncated and written into the project', async (t) => {
  const env = await startEnv(t);
  await seeded(env, 'p-ps-4', cutsProject());
  const a = env.agent('p-ps-4');
  const r = await a.call('set_project_meta', { name: 'renamed', duration: 5 });
  assert.ok(r.ok, String(r.error?.message ?? ''));
  assert.equal(r.value.duration, 5);
  assert.deepEqual(a.pageCalls, [], 'does not go through the page, nor ask the page for page state');
  const st = await env.stateOf('p-ps-4');
  assert.equal(st.project.name, 'renamed');
  assert.equal(st.project.duration, 5, 'truncated to 5 s (content end at 12 s)');
});

// ------------------------------------------------------------------ attach_clip_motion

test('AP-5 attach_clip_motion: asks the page once for the trajectory of that media; per-frame coordinates are computed on the server and written into the clip; if it was never tracked or the page is absent, returns an error and does not commit', async (t) => {
  const env = await startEnv(t);
  await seeded(env, 'p-ps-5', motionProject());
  const a = env.agent('p-ps-5', { pageState: (q) => ({ track: { mediaId: q.args.mediaId, result: trackResult(), running: false } }) });
  const r = await a.call('attach_clip_motion', { clipId: 'c1', mediaId: 'm1' });
  assert.ok(r.ok, String(r.error?.message ?? ''));
  assert.deepEqual(pageStateCalls(a).map((c) => c.args), [{ tool: 'attach_clip_motion', args: { clipId: 'c1', mediaId: 'm1' }, keys: ['track'] }]);
  const st = await env.stateOf('p-ps-5');
  const clip = st.project.tracks[0].clips[0];
  assert.ok(clip.motion && Array.isArray(clip.motion.offsets) && clip.motion.offsets.length > 1, `the clip has per-frame motion: ${JSON.stringify(clip.motion)?.slice(0, 200)}`);
  assert.equal(clip.motion.mediaId, 'm1');
  const rev = st.rev;

  const none = env.agent('p-ps-5', { pageState: { track: { mediaId: 'm1', result: null, running: false } } });
  const r2 = await none.call('attach_clip_motion', { clipId: 'c1', mediaId: 'm1' });
  assert.equal(r2.ok, false);
  assert.match(r2.error.message, /not tracked yet/);
  const running = env.agent('p-ps-5', { pageState: { track: { mediaId: 'm1', result: null, running: true } } });
  const r3 = await running.call('attach_clip_motion', { clipId: 'c1', mediaId: 'm1' });
  assert.equal(r3.ok, false);
  assert.match(r3.error.message, /not finished yet/);
  const down = env.agent('p-ps-5', { pageDown: true });
  const r4 = await down.call('attach_clip_motion', { clipId: 'c1', mediaId: 'm1' });
  assert.equal(r4.ok, false);
  assert.match(r4.error.message, /editor is not open/);
  assert.equal((await env.stateOf('p-ps-5')).rev, rev, 'none of the three failures committed');
});

// ------------------------------------------------------------------ 大的写入走 project.upload

test('AP-6 an Agent write over 256 KiB: switched to a root replacement uploaded in chunks via project.upload; the document service lands it, other pages receive resync; the replica matches the authoritative copy; the completion event still carries opId', async (t) => {
  const env = await startEnv(t);
  const watcher = await seeded(env, 'p-ps-6', cutsProject());
  const a = env.agent('p-ps-6');
  const big = '长'.repeat(120_000); // UTF-8 360 KB
  const r = await a.call('update_clip', { clipId: 'c1', label: big });
  assert.ok(r.ok, String(r.error?.message ?? ''));
  const st = await env.stateOf('p-ps-6');
  assert.equal(st.project.tracks[0].clips[0].label, big);
  assert.equal(a.side.describe().stats.uploads, 1, 'went through one chunked upload');
  await waitFor(() => watcher.ops().some((m) => m.resync === true), 3000, 'other pages receive resync');
  await waitFor(() => a.side.link.replica.rev === st.rev, 3000, 'the replica catches up');
  assert.equal(JSON.stringify(a.side.link.replica.project), JSON.stringify(st.project), 'the replica is byte-for-byte identical to the authoritative copy');
  await waitFor(() => watcher.events().some((e) => e.phase === 'complete' && e.tool === undefined && e.opId), 3000, 'the completion event carries opId');
});

// ------------------------------------------------------------------ callId

test('AP-7 events carry callId: the model-side id of this tool call goes unchanged into both the create and the complete event, and is also in events.list', async (t) => {
  const env = await startEnv(t);
  const watcher = await seeded(env, 'p-ps-7', cutsProject());
  const a = env.agent('p-ps-7');
  const r = await a.call('update_clip', { clipId: 'c1', label: 'With callId' }, { callId: 'toolu_01ABC' });
  assert.ok(r.ok, String(r.error?.message ?? ''));
  await waitFor(() => watcher.events().filter((e) => e.callId === 'toolu_01ABC').length === 2, 3000, 'both events carry callId');
  const [create, complete] = watcher.events().filter((e) => e.callId === 'toolu_01ABC');
  assert.equal(create.phase, 'create');
  assert.equal(complete.phase, 'complete');
  assert.ok(complete.opId, 'the project was written, and the completion event carries opId');
  watcher.c.send({ type: 'events.list', projectId: 'p-ps-7', reqId: 'l1' });
  const listing = await watcher.c.next((m) => m.type === 'events.listing', 3000);
  assert.ok(listing.items.some((it) => it.callId === 'toolu_01ABC' && it.opId === complete.opId));
});

// ------------------------------------------------------------------ 页面侧工具的 opIds

test('AP-8 tools that stay on the page: when the page\'s reply carries opIds (wrapped), the version this chat has read is advanced, and the write that follows is not blocked by the changes it had the page make itself', async (t) => {
  const env = await startEnv(t);
  const pg = await seeded(env, 'p-ps-8', cutsProject());
  // 页面替 Agent 执行一个留在页面的工具(import_media 之类),期间自己提交了一次;真实页面在 /api/mcp/result 里带 opIds
  const a = env.agent('p-ps-8', {
    pageResult: 'wrapped',
    onPage: async (tool) => {
      const r = await pg.commit([{ op: 'set', path: '/tracks/@t1/clips/@c1/label', value: `Written by the page for ${tool}` }]);
      return { result: { ok: true }, opIds: [r.opId] };
    },
  });
  await a.call('get_project');
  const viaPage = await a.call('import_media', { path: 'x.mp4' });
  assert.ok(viaPage.ok, String(viaPage.error?.message ?? ''));
  assert.deepEqual(viaPage.value, { ok: true }, 'wrapped: what is returned to the Agent is result');
  const w = await a.call('update_clip', { clipId: 'c1', opacity: 0.5 });
  assert.ok(w.ok, `changes the page made on behalf of this chat do not block that chat itself: ${w.error?.message ?? ''}`);
  const st = await env.stateOf('p-ps-8');
  assert.equal(st.project.tracks[0].clips[0].label, 'Written by the page for import_media');
  assert.equal(st.project.tracks[0].clips[0].opacity, 0.5);
});

// ------------------------------------------------------------------ 页面侧:远端改动后的页面状态(纯函数)

test('AP-9 page-side pageStateAfterRemote: someone else switched the cut → the playhead takes the parked value, playback stops, the selection is cleared, the manual duration is cleared; someone else truncated the total duration → record the manual value; clips deleted from the selection are removed', async () => {
  await import(pathToFileURL(path.join(ROOT, 'src/testing/registerTs.mjs')).href);
  const { pageStateAfterRemote } = await import(pathToFileURL(path.join(ROOT, 'src/store/remotePageState.ts')).href);
  const prev = cutsProject();
  const st = { t: 3, selection: ['c1'], durationManual: null, playToken: 5 };
  // 切剪辑:目标 k2 在切之前的版本里停放着播放头 7
  const switched = { ...prev, activeCutId: 'k2', tracks: prev.cuts[1].tracks, duration: 20 };
  assert.deepEqual(pageStateAfterRemote(prev, switched, st), { t: 7, playing: false, selection: [], playToken: 6, durationManual: null });
  // 截断:内容末尾 12,总时长改成 5 → 手动值 5
  assert.deepEqual(pageStateAfterRemote(prev, { ...prev, duration: 5 }, st), { durationManual: 5 });
  // 跟内容走:总时长改回内容末尾 → 手动值清掉
  assert.deepEqual(pageStateAfterRemote({ ...prev, duration: 5 }, prev, { ...st, durationManual: 5 }), { durationManual: null });
  // 选区里的片段被删了
  const removed = { ...prev, tracks: [{ ...prev.tracks[0], clips: [] }, prev.tracks[1]] };
  assert.deepEqual(pageStateAfterRemote(prev, removed, st), { selection: [] });
  // 无关改动不动页面状态
  assert.equal(pageStateAfterRemote(prev, { ...prev, name: 'Other' }, st), null);
});

// ------------------------------------------------------------------ 页面侧:这次调用期间本页面发出的提交

test('AP-10 page-side DocSync.opMark / opIdsSince: take the commits sent by this page after a given position (loads included)', async () => {
  await import(pathToFileURL(path.join(ROOT, 'src/testing/registerTs.mjs')).href);
  const { DocSync } = await import(pathToFileURL(path.join(ROOT, 'src/store/docsync.ts')).href);
  const { MemDocService } = await import(pathToFileURL(path.join(ROOT, 'src/testing/memDocService.mjs')).href);
  const p0 = cutsProject();
  const svc = new MemDocService({ project: structuredClone(p0), rev: 1 });
  let link;
  const ds = new DocSync(p0, { projectId: 'P-ops', session: 'page-ops', send: (m) => link.send(m) });
  link = svc.connect('page-ops', (m) => ds.receive(m));
  ds.connect();
  svc.drain();
  const mark0 = ds.opMark();
  ds.commit({ ...ds.project, name: 'One' });
  ds.commit({ ...ds.project, name: 'Two' });
  const mine = ds.opIdsSince(mark0);
  assert.equal(mine.length, 2);
  const mark1 = ds.opMark();
  assert.deepEqual(ds.opIdsSince(mark1), [], 'no new commits after the position');
  ds.load({ ...ds.project, name: 'Load' });
  assert.equal(ds.opIdsSince(mark1).length, 1, 'a load (root replacement) also counts as sent by this page');
  svc.drain();
});
