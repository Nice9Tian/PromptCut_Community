/**
 * 用户 2026-10-21 定的三件事(`docs/plan/user-decisions-2026-10-21.md` 第 2.2 节、第 3 节;报告 `docs/reports/AGENT-cut-look-ui.md`):
 *
 *   CL-1  `cutLookView`:不给 cutId 原样返回(当前激活);给停放剪辑的 id 换成「那条当激活」的视图,原项目不动;id 不存在明确报错
 *   CL-2  Agent 服务端执行器(`agent-exec.mjs` 的 see_frames,本机绑了项目副本 / 云端托管档都走它):带 cutId 时交给渲染的是那条剪辑的视图、
 *         不给 t 取那条剪辑上次停下的播放头、`cutLook` 记号带给出图那一侧;不带 cutId 照旧;id 不存在报错;全程不提交、副本不变
 *   CL-3  没绑副本时的镜像那条路(`instance.mjs` 的 runMirroredTool):同上
 *   CL-4  账号模式出图(`account-runner.mjs` 的 prerenderPost):`cutLook` 时不问成员设备,直接交给托管渲染服务(请求体就是视图)
 *   CL-5  工具改名:模型清单里只有新名、旧名不在;入口新旧都认;发给页面的 SSE `call` 里是旧的内部操作名;
 *         路由表与页面执行器认新名;反向通道的提供方认新名、发给页面的 `tool` 仍是旧名
 *   CL-6  add_cut 只建不切;set_cut_segment 不再收 cutId(工具说明);PAGE_STATE_TOOLS / CLOUD_PLAYHEAD_TOOLS 跟着改
 *
 * 跑:npm test -- server/test/cut-look-ui.test.mjs
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { cutLookView } from '../../src/kernel/agentScopes.mjs';
import { createAgentExecutor, PAGE_STATE_TOOLS, seeFramesView } from '../agent/agent-exec.mjs';
import { tools } from '../mcp-tools.mjs';
import { UI_TOOL_RENAMES, modelToolName, pageToolName, isUserInterfaceTool } from '../tools/ui-names.mjs';
import { TOOL_ROUTES, SPECIAL_TOOLS } from '../../src/mcp/routes.mjs';
import { CLOUD_TOOL_PLAN, CLOUD_OPEN_TOOLS, CLOUD_PLAYHEAD_TOOLS, CLOUD_PAGE_TOOLS, checkCloudTool } from '../agent/service/cloud-tools.mjs';
import { PAGE_BRIDGE_TOOLS, PAGE_CONTROL_TOOL_NAMES, createPageControlTools } from '../agent/service/page-bridge.mjs';
import { HANDOFF_TOOL_NAMES } from '../agent/service/hosted-handoff.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** 剪辑1(激活,红卡)+ 剪辑2(停放,蓝卡,上次停在 1.5 秒) */
function project() {
  return {
    version: 1, id: 'p-look', name: 'look', width: 640, height: 360, fps: 30, duration: 4, themeId: 'midnight', media: [],
    tracks: [{ id: 't1', name: '序列 1', clips: [{ id: 'red', cardId: 'solid', params: { color: '#ff0000' }, start: 0, end: 4 }] }],
    cuts: [
      { id: 'cut-1', name: '剪辑1' },
      { id: 'cut-2', name: '剪辑2', t: 1.5, duration: 6, transitions: [], tracks: [{ id: 't2', name: '序列 1', clips: [{ id: 'blue', cardId: 'solid', params: { color: '#0000ff' }, start: 0, end: 6 }] }] },
    ],
    activeCutId: 'cut-1',
  };
}
const deepFreeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); } return o; };

test('CL-1 cutLookView:不给 cutId 原样;给停放剪辑换视图且原项目不动;不存在明确报错', () => {
  const p = deepFreeze(project());
  const same = cutLookView(p, undefined);
  assert.equal(same.project, p);
  assert.deepEqual([same.active, same.cut, same.parkedT], [true, { id: 'cut-1', name: '剪辑1' }, null]);
  assert.equal(cutLookView(p, 'cut-1').project, p, '传当前激活的 id 也原样');
  assert.equal(cutLookView(p, '').project, p, '空串当没传');
  const v = cutLookView(p, 'cut-2');
  assert.equal(v.active, false);
  assert.deepEqual(v.cut, { id: 'cut-2', name: '剪辑2' });
  assert.equal(v.parkedT, 1.5);
  assert.equal(v.project.activeCutId, 'cut-2');
  assert.equal(v.project.tracks, p.cuts[1].tracks, '视图的 tracks 就是剪辑2 的');
  assert.equal(v.project.duration, 6);
  const entry1 = v.project.cuts.find((c) => c.id === 'cut-1');
  assert.equal(entry1.tracks, p.tracks, '剪辑1 退回条目、带着自己的内容(剪辑段引用照常解析)');
  const entry2 = v.project.cuts.find((c) => c.id === 'cut-2');
  assert.equal('tracks' in entry2 || 't' in entry2, false, '激活那条的条目不带内容');
  assert.equal(p.activeCutId, 'cut-1', '原项目没被改');
  assert.throws(() => cutLookView(p, 'cut-9'), (e) => e.code === 'cut-not-found' && /找不到剪辑 "cut-9"/.test(e.message) && /剪辑2\(cut-2\)/.test(e.message));
  assert.throws(() => seeFramesView(p, 3), /cutId 要是字符串/);
  // 老项目(没有 cuts):只有剪辑1
  const old = { ...project(), cuts: undefined, activeCutId: undefined };
  assert.deepEqual(cutLookView(old).cut, { id: 'cut-1', name: '剪辑1' });
  assert.throws(() => cutLookView(old, 'cut-2'), /找不到剪辑/);
});

/** 执行器要的最小项目副本(只读工具用到的那几样) */
function fakeLink(p, rev = 7) {
  const replica = { hasBody: true, project: p, rev, waitRev: async () => true, offer() { throw new Error('读工具不该提交'); } };
  return {
    projectId: 'p-look', replica,
    ready: async () => {},
    conversation: () => ({ request: async () => { throw new Error('读工具不该向文档服务发请求'); } }),
  };
}

test('CL-2 执行器 see_frames:带 cutId 渲那条剪辑的视图、不提交;不带照旧;id 不存在报错', async () => {
  const p = deepFreeze(project());
  const posts = [];
  const exec = createAgentExecutor({
    link: fakeLink(p), loadHost: async () => { throw new Error('see_frames 不该进 host'); }, playhead: () => 3,
    prerenderPost: async (path, body, opts) => {
      posts.push({ path, body, opts });
      if (path === '/api/vision/snapshot') return { ok: true, t: body.t ?? null, __image: { mime: 'image/png', base64: 'AAAA' } };
      return { ok: true, visualId: 'v1' };
    },
  });
  const def = tools.find((t) => t.name === 'see_frames');
  assert.ok(def.inputSchema.properties.cutId, 'see_frames 的说明里有 cutId');

  const r2 = await exec.execute('see_frames', { source: 'timeline', cutId: 'cut-2' }, 'a1', def);
  const snap2 = posts.find((x) => x.path === '/api/vision/snapshot');
  assert.equal(snap2.body.project.activeCutId, 'cut-2', '交给渲染的是剪辑2 当激活的视图');
  assert.equal(snap2.body.project.tracks[0].clips[0].id, 'blue');
  assert.equal(snap2.body.t, 1.5, '不给 t 取剪辑2 上次停下的位置,不是页面播放头');
  assert.equal('cutId' in snap2.body, false, '请求体里不带 cutId:旧版渲染进程只认 project,一样出得对');
  assert.equal(snap2.opts.cutLook, true, '出图那一侧知道这是看别的剪辑(账号模式据此不问成员设备)');
  assert.deepEqual(r2.cut, { id: 'cut-2', name: '剪辑2' }, '回包写明看的是哪条剪辑');
  assert.equal(r2.rev, 7);
  assert.equal(p.activeCutId, 'cut-1');

  posts.length = 0;
  const r2t = await exec.execute('see_frames', { source: 'timeline', cutId: 'cut-2', times: [0.5, 2] }, 'a1', def);
  assert.deepEqual(posts[0].body.times, [0.5, 2]);
  assert.equal(posts[0].body.project.activeCutId, 'cut-2');
  assert.deepEqual(r2t.cut, { id: 'cut-2', name: '剪辑2' });

  posts.length = 0;
  const r1 = await exec.execute('see_frames', { source: 'timeline' }, 'a1', def);
  const snap1 = posts.find((x) => x.path === '/api/vision/snapshot');
  assert.equal(snap1.body.project, p, '不带 cutId:原项目原样交过去');
  assert.equal(snap1.body.t, 3, '不带 cutId:页面播放头');
  assert.equal(snap1.opts.cutLook, undefined);
  assert.deepEqual(r1.cut, { id: 'cut-1', name: '剪辑1' });

  posts.length = 0;
  await assert.rejects(() => exec.execute('see_frames', { source: 'timeline', cutId: 'nope' }, 'a1', def), /找不到剪辑 "nope"/);
  assert.equal(posts.length, 0, 'id 不存在时不去渲');
});

/** instance.mjs 的最小宿主:登记的路由收进 map,不开 HTTP */
async function makeInstance(env = {}) {
  const { createAgentInstance } = await import('../agent/service/instance.mjs');
  const routes = new Map();
  const inst = createAgentInstance({
    server: { httpServer: null, ssrLoadModule: async () => { throw new Error('这条用例不载入前端代码'); }, config: { root: ROOT }, middlewares: { use: (route, handler) => routes.set(route, handler) } },
    prerenderPost: async () => null, latestMirror: () => null, latestPlayhead: () => null,
    ...env,
  });
  return { inst, routes };
}

test('CL-3 镜像那条路(没绑副本):带 cutId 渲那条剪辑的视图;不带照旧', async (t) => {
  const p = deepFreeze(project());
  const posts = [];
  const { inst } = await makeInstance({
    latestMirror: () => ({ project: p }), latestPlayhead: () => ({ t: 2.25 }),
    prerenderPost: async (path, body) => { posts.push({ path, body }); return path === '/api/vision/snapshot' ? { ok: true, t: body.t } : { ok: false }; },
  });
  t.after(() => inst.close?.());
  const r = await inst.callTool('see_frames', { source: 'timeline', cutId: 'cut-2' }, 'a1');
  assert.equal(posts[0].body.project.activeCutId, 'cut-2');
  assert.equal(posts[0].body.t, 1.5);
  assert.deepEqual(r.cut, { id: 'cut-2', name: '剪辑2' });
  const r1 = await inst.callTool('see_frames', { source: 'timeline', t: 1 }, 'a1');
  assert.equal(posts[1].body.project, p);
  assert.equal(posts[1].body.t, 1);
  assert.deepEqual(r1.cut, { id: 'cut-1', name: '剪辑1' });
  await assert.rejects(() => inst.callTool('see_frames', { source: 'timeline', cutId: 'zz' }, 'a1'), /找不到剪辑/);
});

// 读的是闭源侧的 cloud/agent/account-runner.mjs；社区版没有 cloud/，这条跳过
test('CL-4 账号模式出图:cutLook 时不问成员设备,直接交给托管渲染服务', { skip: (await import('node:fs')).existsSync(new URL('../../cloud', import.meta.url)) ? false : '当前工作区无 cloud/ 目录（社区版）' }, async () => {
  const fs = await import('node:fs');
  const text = fs.readFileSync(new URL('../../cloud/agent/account-runner.mjs', import.meta.url), 'utf8');
  assert.match(text, /opts\?\.cutLook !== true && typeof toolset\?\.pageBridge\?\.call === 'function'/, 'cutLook 时 memberNodes 留空');
  // 调度本身:没有成员节点时交给托管渲染,请求体原样(就是视图)
  const { dispatchFrameSnapshot } = await import('../agent/service/frame-dispatcher.mjs');
  const view = cutLookView(project(), 'cut-2').project;
  let got = null;
  const out = await dispatchFrameSnapshot({
    memberNodes: [], cloudLook: async () => { got = view; return { ok: true }; },
    callLocal: async () => { throw new Error('不该问成员设备'); },
    request: { path: '/api/vision/snapshot', body: { project: view, t: 1.5 } },
  });
  assert.equal(out.source, 'hosted-render');
  assert.equal(got.activeCutId, 'cut-2');
});

test('CL-5 工具改名:清单只有新名;入口新旧都认;页面收到旧的内部操作名;路由表与提供方认新名', async (t) => {
  const names = new Set(tools.map((x) => x.name));
  for (const [oldName, newName] of Object.entries(UI_TOOL_RENAMES)) {
    assert.ok(names.has(newName), `${newName} 在清单里`);
    assert.equal(names.has(oldName), false, `旧名 ${oldName} 不在交给模型的清单里`);
    assert.match(newName, /^[a-zA-Z0-9_-]{1,64}$/, '模型侧的名字只能是字母数字下划线连字符');
    assert.equal(modelToolName(oldName), newName);
    assert.equal(pageToolName(newName), oldName);
    assert.ok(isUserInterfaceTool(oldName) && isUserInterfaceTool(newName));
  }
  assert.equal(modelToolName('add_clip'), 'add_clip');
  assert.equal(pageToolName('add_clip'), 'add_clip');
  // 不会动界面的工具名字里不带前缀
  for (const n of names) if (n.startsWith('user_interface_')) assert.ok(isUserInterfaceTool(n), `${n} 登记在 ui-names.mjs 里`);
  // 路由表 / 特殊分支认新名
  for (const n of ['user_interface_switch_cut', 'user_interface_seek', 'user_interface_play', 'user_interface_pause', 'user_interface_collect_login']) assert.ok(TOOL_ROUTES[n], n);
  assert.ok(SPECIAL_TOOLS.includes('user_interface_web_handoff'));
  for (const n of ['switch_cut', 'seek', 'play', 'pause', 'collect_login']) assert.equal(Object.hasOwn(TOOL_ROUTES, n), false);
  // 云端工具表认新名;反向通道发给页面的仍是旧名
  for (const n of Object.values(UI_TOOL_RENAMES)) assert.ok(CLOUD_TOOL_PLAN[n], `云端工具表里有 ${n}`);
  for (const n of Object.keys(UI_TOOL_RENAMES)) assert.equal(Object.hasOwn(CLOUD_TOOL_PLAN, n), false, `云端工具表里没有旧名 ${n}`);
  assert.ok(CLOUD_OPEN_TOOLS.has('user_interface_switch_cut'));
  assert.deepEqual([...CLOUD_PAGE_TOOLS].sort(), ['get_selection', 'user_interface_pause', 'user_interface_play', 'user_interface_seek']);
  assert.deepEqual([...PAGE_BRIDGE_TOOLS], ['seek', 'play', 'pause', 'web_handoff'], '发给页面的内部操作名没动(0.7.18 的页面认这几个)');
  assert.deepEqual([...PAGE_CONTROL_TOOL_NAMES], ['user_interface_seek', 'user_interface_play', 'user_interface_pause']);
  assert.deepEqual([...HANDOFF_TOOL_NAMES], ['user_interface_web_handoff']);
  assert.equal(checkCloudTool('user_interface_seek').ok, true);

  // 反向通道的提供方:认新名(也认旧名),发给页面的 tool 是旧名
  const sent = [];
  const control = createPageControlTools({
    bridge: { limits: { pageMs: 15_000 }, initiator: async () => ({ initiatorAccountId: 'acc', pageId: 'pg-1' }),
      requestPage: async (req) => { sent.push(req); return { delivered: true, answer: { ok: true, result: { ok: true } } }; } },
    newRequestId: () => 'req-0000000001',
  });
  await control.call('user_interface_seek', { t: 2 }, { projectId: 'p' });
  await control.call('pause', {}, { projectId: 'p' });
  assert.deepEqual(sent.map((r) => [r.tool, r.args]), [['seek', { t: 2 }], ['pause', {}]]);
  const bad = await control.call('user_interface_seek', {}, { projectId: 'p' });
  assert.match(bad.error, /user_interface_seek 要给 t/);

  // 本机:SSE 发给页面的 call 里是旧名;入口新旧名都认
  const { inst, routes } = await makeInstance();
  t.after(() => inst.close?.());
  const writes = [];
  const req = new EventEmitter();
  req.method = 'GET';
  const res = { writeHead() {}, flushHeaders() {}, end() {}, write: (chunk) => { writes.push(String(chunk)); return true; } };
  routes.get('/api/mcp/events')(req, res);
  const answer = async () => {
    for (let i = 0; i < 50; i++) {
      const call = writes.map((w) => { try { return JSON.parse(w.replace(/^data: /, '')); } catch { return null; } }).find((m) => m?.type === 'call' && !m.answered);
      if (call) {
        call.answered = true;
        writes.length = 0;
        const rq = new EventEmitter();
        rq.method = 'POST';
        const rs = { statusCode: 0, setHeader() {}, writeHead() {}, end() {} };
        routes.get('/api/mcp/result')(rq, rs);
        rq.emit('data', JSON.stringify({ id: call.id, ok: true, result: { ok: true, echoed: call.tool } }));
        rq.emit('end');
        return call;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('页面没收到 call');
  };
  for (const [asked, wire] of [['user_interface_seek', 'seek'], ['seek', 'seek'], ['user_interface_play', 'play'], ['user_interface_web_handoff', 'web_handoff']]) {
    const pending = inst.callTool(asked, asked.endsWith('seek') ? { t: 1 } : {}, 'a1');
    const call = await answer();
    const out = await pending;
    assert.equal(call.tool, wire, `${asked} 发给页面的是旧的内部操作名 ${wire}`);
    assert.equal(out.echoed, wire);
  }
});

test('CL-6 add_cut 只建不切;set_cut_segment 不收 cutId;切剪辑要播放头的表跟着改', () => {
  const addCut = tools.find((t) => t.name === 'add_cut');
  assert.equal('switch' in addCut.inputSchema.properties, false, 'add_cut 去掉 switch 参数');
  assert.match(addCut.description, /只建不切/);
  const setSeg = tools.find((t) => t.name === 'set_cut_segment');
  assert.deepEqual(Object.keys(setSeg.inputSchema.properties).sort(), ['clipId', 'cutOffset']);
  assert.match(setSeg.description, /引用哪条剪辑不能改/);
  assert.deepEqual(Object.keys(PAGE_STATE_TOOLS).sort(), ['attach_clip_motion', 'remove_cut', 'user_interface_switch_cut']);
  assert.deepEqual([...CLOUD_PLAYHEAD_TOOLS].sort(), ['remove_cut', 'user_interface_switch_cut']);
  const switchCut = tools.find((t) => t.name === 'user_interface_switch_cut');
  assert.match(switchCut.description, /会动用户的界面/);
  assert.match(switchCut.description, /see_frames 传 cutId/);
});
