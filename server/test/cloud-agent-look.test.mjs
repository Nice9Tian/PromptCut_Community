/**
 * 云端 Agent 看画面在 Agent 服务一侧的接线(契约 `docs/plan/cloud-agent-contract.md` 第 9.8 节)。渲染服务用替身,模型用模拟提供方。
 *
 * CA-LOOK-02 配了看画面的口子:`see_frames` 把这一版项目副本与时刻交给渲染服务,拿回的图片进了模型的历史、不进事件记录;
 *            项目是这个实例的项目(来自鉴权),另一个项目的对话拿到的是它自己项目的;结果不带页面取不到的 `visualId`;
 *            `get_layout` 带实体框;渲染服务说「这次没看成」时原话交给模型,这一轮照常结束;素材镜头拼图明说做不了。
 * CA-LOOK-03 没配:看画面的四个工具不交给模型,调用回明确的原因;系统提示词写「看不了画面」;`get_layout` 照答规定的框。
 * CA-LOOK-04 工具表:四个工具归到「在副本上执行」并标了 look;配与没配两套清单。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ownerKeyOf } from '../agent/service/create-agent-service.mjs';
import {
  CLOUD_TOOL_PLAN, CLOUD_OPEN_TOOLS, CLOUD_OPEN_TOOLS_NO_LOOK, CLOUD_LOOK_TOOLS, CLOUD_SYSTEM_NOTE, cloudSystemNote, cloudLookResult, lookUnavailable, checkCloudTool,
} from '../agent/service/cloud-tools.mjs';
import { buildTools } from '../harness/tools/index.mjs';
import { waitFor } from './fake-ws-kit.mjs';
import { project, script, startKit } from './cloud-agent-kit.mjs';

const alice = { projectId: 'p-a', userId: 'alice@dev-a', username: 'alice', deviceName: 'A 的电脑' };
const bob = { projectId: 'p-b', userId: 'bob@dev-b', username: 'bob', deviceName: 'B 的电脑' };
/** 一张 1×1 的 PNG(内容不重要,只认它原样进了模型的历史) */
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** 渲染服务的替身:记下每次请求;`reply(req)` 可换 */
function fakeLook() {
  const calls = [];
  const state = { reply: null };
  return {
    calls, state,
    forProject(projectId, { cards } = {}) {
      return async (pathname, body, opts) => {
        const call = { projectId, path: pathname, body, cards: cards ? cards() : null, timeoutMs: opts?.timeoutMs ?? null };
        calls.push(call);
        if (state.reply) return state.reply(call);
        if (pathname === '/api/vision/snapshot') return { ok: true, t: body.t ?? 0, clipId: body.clipId ?? null, width: 768, height: 432, rects: null, note: '画面', __image: { mime: 'image/png', base64: PNG_B64 } };
        if (pathname === '/api/cards/layout') return { ok: true, clips: Object.fromEntries((body.clipIds ?? []).map((id) => [id, { contentBox: { left: 1, top: 2, width: 3, height: 4 } }])) };
        return { ok: false, error: '替身没有这一条' };
      };
    },
    describe: () => ({ url: 'fake', requests: calls.length }),
  };
}
const historyOf = (kit, identity, conversationId) => JSON.parse(fs.readFileSync(path.join(kit.dataDir, 'tenants', identity.projectId, 'owners', ownerKeyOf(identity), 'conversations', conversationId, 'history.json'), 'utf8'));
const imagesIn = (messages) => messages.flatMap((m) => (Array.isArray(m.content) ? m.content.filter((b) => b?.type === 'image') : []));
const eventsOf = (kit, identity, conversationId) => { const all = []; kit.service.subscribe(identity, conversationId, 0, (ev) => all.push(ev))?.(); return all; };

test('CA-LOOK-02 配了看画面的口子:画面进模型的历史;项目来自鉴权;「这次没看成」原话交给模型;结果不带页面取不到的东西', { timeout: 180_000 }, async (t) => {
  const look = fakeLook();
  const kit = await startKit(t, { extra: { look } });
  await kit.doc.seed(project('p-a', '甲'));
  await kit.doc.seed(project('p-b', '乙'));
  assert.equal(kit.service.look, true);

  await kit.service.send(alice, 'c-look', { prompt: script([
    { tool: 'update_clip', input: { clipId: 'c1', start: 1, end: 5 } },
    { tool: 'see_frames', input: { source: 'timeline', t: 2 } },
    { tool: 'get_layout', input: { clipId: 'c1' } },
    { tool: 'see_frames', input: { source: 'media', mediaId: 'm1' } },
    { say: '看过了' },
  ]) });
  const ea = await kit.finished(alice, 'c-look');
  assert.equal(ea.at(-1).state, 'idle');
  const results = ea.filter((e) => e.type === 'tool_result');
  assert.deepEqual(results.map((e) => [e.name, e.ok]), [['update_clip', true], ['see_frames', true], ['get_layout', true], ['see_frames', false]]);
  // 交给渲染服务的:这个实例的项目、这一版副本(含刚落地的改动)、要的时刻
  const snap = look.calls.find((c) => c.path === '/api/vision/snapshot');
  assert.equal(snap.projectId, 'p-a');
  assert.equal(snap.body.t, 2);
  assert.deepEqual([snap.body.project.id, snap.body.project.tracks[0].clips[0].start, snap.body.project.tracks[0].clips[0].end], ['p-a', 1, 5], '是这一版项目');
  assert.deepEqual(snap.cards, {}, '这个项目没有卡片源码');
  assert.ok(snap.timeoutMs >= 60_000, '看画面的时限比一般工具长');
  // 画面进了模型的历史(图片块),事件记录里没有 base64
  const images = imagesIn(historyOf(kit, alice, 'c-look'));
  assert.deepEqual(images.map((b) => [b.mime, b.data]), [['image/png', PNG_B64]]);
  assert.equal(JSON.stringify(ea).includes(PNG_B64), false, '事件记录里不带图片');
  assert.equal(/visualId/.test(results[1].summary), false, '不带页面取不到的 visualId');
  assert.equal(look.calls.some((c) => c.path === '/api/ai/visual'), true, '执行器照桌面版的办法问过可视化记录(云端的客户端不发这一条,见 CA-LOOK-01)');
  // get_layout 带实体框
  assert.match(results[2].summary, /"contentBox":\{"left":1,"top":2,"width":3,"height":4\}/);
  // 素材的镜头拼图:明说做不了,没有去问渲染服务
  assert.match(results[3].summary, /只能看时间轴上的画面/);
  assert.equal(look.calls.filter((c) => c.path === '/api/vision/snapshot').length, 1);

  // 另一个项目的对话:拿到的是它自己项目的(客户端按实例的项目绑死)
  await kit.service.send(bob, 'c-look-b', { prompt: script([{ tool: 'see_frames', input: { source: 'timeline', t: 0 } }, { say: '乙看过了' }]) });
  await kit.finished(bob, 'c-look-b');
  const mine = look.calls.filter((c) => c.path === '/api/vision/snapshot').at(-1);
  assert.deepEqual([mine.projectId, mine.body.project.id], ['p-b', 'p-b']);
  assert.equal(JSON.stringify(mine.body).includes('甲'), false, '乙的请求里没有甲的内容');

  // 渲染服务说「这次没看成」:原话交给模型,这一轮照常结束,不挂着
  look.state.reply = () => { throw new Error('这次没看成：渲染服务正在渲别的项目的自定义卡片，带自定义卡片的项目要排队。过一会儿再看，先按项目内容继续。'); };
  const t0 = Date.now();
  await kit.service.send(alice, 'c-look-2', { prompt: script([{ tool: 'see_frames', input: { source: 'timeline', t: 1 } }, { tool: 'bake_card', input: { clipId: 'c1' } }, { say: '没看成也做完了' }]) });
  const e2 = await kit.finished(alice, 'c-look-2');
  assert.equal(e2.at(-1).state, 'idle');
  const r2 = e2.filter((e) => e.type === 'tool_result');
  assert.deepEqual(r2.map((e) => [e.name, e.ok]), [['see_frames', false], ['bake_card', false]]);
  assert.match(r2[0].summary, /这次没看成：渲染服务正在渲别的项目的自定义卡片/);
  assert.ok(Date.now() - t0 < 20_000);
  assert.equal(imagesIn(historyOf(kit, alice, 'c-look-2')).length, 0);
  assert.equal(kit.service.describe().look.url, 'fake');
});

test('CA-LOOK-03 没配看画面的口子:四个工具不交给模型,调用回明确的原因;get_layout 照答规定的框', { timeout: 120_000 }, async (t) => {
  const kit = await startKit(t);
  await kit.doc.seed(project('p-a', '甲'));
  assert.equal(kit.service.look, false);
  await kit.service.send(alice, 'c-nolook', { prompt: script([{ tool: 'see_frames', input: { source: 'timeline', t: 1 } }, { tool: 'get_layout', input: { clipId: 'c1' } }, { say: '完' }]) });
  const ev = await kit.finished(alice, 'c-nolook');
  const results = ev.filter((e) => e.type === 'tool_result');
  // 模型手里没有 see_frames(模拟模型硬调,驱动答「未知工具」);get_layout 照答,实体框是 null
  assert.equal(results[0].ok, false);
  assert.match(results[0].summary, /未知工具 see_frames/);
  assert.equal(results[1].ok, true);
  assert.match(results[1].summary, /"contentBox":null/);
  // 总入口再判一次:直接调也回明确的原因
  const inst = kit.service._instance(alice);
  for (const name of CLOUD_LOOK_TOOLS) {
    const r = await inst.callTool(name, { source: 'timeline', clipId: 'c1' }, 'c-nolook');
    assert.deepEqual([r.ok, r.cloudUnavailable], [false, true], name);
    assert.match(r.error, /看不了画面/);
    assert.ok(r.error.includes(name));
  }
  await waitFor(() => kit.service.conversations(alice).find((c) => c.id === 'c-nolook')?.state === 'idle', 5000, '收尾');
});

test('CA-LOOK-04 工具表:看画面的四个归到「在副本上执行」并标了 look;配与没配两套清单与两段提示词', async () => {
  assert.deepEqual([...CLOUD_LOOK_TOOLS].sort(), ['bake_card', 'get_gif', 'inspect_card_dom', 'see_frames']);
  for (const name of CLOUD_LOOK_TOOLS) {
    assert.deepEqual(CLOUD_TOOL_PLAN[name], { mode: 'route', look: true });
    assert.deepEqual(checkCloudTool(name), { ok: true, mode: 'route' });
    assert.equal(CLOUD_OPEN_TOOLS.has(name), true);
    assert.equal(CLOUD_OPEN_TOOLS_NO_LOOK.has(name), false);
  }
  assert.equal(CLOUD_OPEN_TOOLS_NO_LOOK.size, CLOUD_OPEN_TOOLS.size - 6, '少掉看画面的四个与卡片声音的两个(都要同机的渲染服务)');
  assert.equal(CLOUD_OPEN_TOOLS_NO_LOOK.has('get_layout'), true, 'get_layout 没有画面也答得了规定的框');
  const offered = (await buildTools({ callTool: async () => [], workspaceDir: null, only: CLOUD_OPEN_TOOLS_NO_LOOK, localTools: false })).map((x) => x.name);
  assert.deepEqual(offered.filter((n) => CLOUD_LOOK_TOOLS.has(n)), []);
  // 提示词:配了写「照常用但慢」与「没看成不要反复重试」;没配写「看不了画面」
  const on = cloudSystemNote({ look: true });
  const off = cloudSystemNote({ look: false });
  assert.match(on, /看画面照常用,但比本机慢/);
  assert.match(on, /这次没看成/);
  assert.equal(/看不了画面|没有交给你/.test(on), false);
  assert.match(off, /这台云节点上看不了画面/);
  assert.match(off, /没有交给你/);
  assert.equal(off, CLOUD_SYSTEM_NOTE);
  for (const note of [on, off]) for (const must of ['发起方不在线', 'import_media', 'create_card', '托管方的配音服务']) assert.ok(note.includes(must), must);
  assert.equal(on.split('\n').length, off.split('\n').length, '只差看画面的那一段');
  // 云端的结果:不带页面取不到的 visualId 与动图地址;get_gif 的说明照实
  assert.deepEqual(cloudLookResult('see_frames', { visualId: 'v-1', ok: true, t: 1, __image: { mime: 'image/png', base64: 'x' } }), { ok: true, t: 1, __image: { mime: 'image/png', base64: 'x' } });
  const gif = cloudLookResult('get_gif', { visualId: 'v-2', ok: true, clipId: 'c', times: [0], gif: '/api/ai/visual/gif/0123.gif', note: '用户在聊天栏点开这一步能看到动图。' });
  assert.deepEqual(Object.keys(gif).sort(), ['clipId', 'note', 'ok', 'times']);
  assert.match(gif.note, /用户在聊天栏里看不到动图/);
  assert.deepEqual(cloudLookResult('see_frames', { ok: false, error: 'x' }), { ok: false, error: 'x' });
  assert.equal(lookUnavailable('see_frames').cloudUnavailable, true);
});

import {
  dispatchFrameSnapshot, selectEligibleLocalNodes, isQualifiedMemberNode, classifyNode, FRAME_SOURCE_LEVELS,
} from '../agent/service/frame-dispatcher.mjs';

test('RS18-local.1～10 云端 Agent 看画面出图四级先后（桌面版 > 电脑浏览器 > 托管渲染服务 > 手机浏览器）与迟到隔离/取消', async () => {
  // RS18-local.1 本地成功：桌面版满足资格先答
  const desktopNode = { id: 'node-pc-1', kind: 'desktop', online: true, authorized: true, codeVersion: 'v1', capabilities: { canSnapshot: true }, keepPlayhead: true };
  const browserNode = { id: 'node-web-1', kind: 'browser', platform: 'browser', online: true, authorized: true, codeVersion: 'v1', capabilities: { canSnapshot: true }, keepPlayhead: true };
  let localCalls = [];
  const res1 = await dispatchFrameSnapshot({
    memberNodes: [browserNode, desktopNode],
    projectCodeVersion: 'v1',
    cloudLook: async () => ({ ok: true, cloud: true }),
    callLocal: async (node, req) => { localCalls.push(node.id); return { ok: true, frame: 'snap-' + node.id }; },
    request: { path: '/api/vision/snapshot', body: { t: 1 } },
  });
  assert.equal(res1.source, FRAME_SOURCE_LEVELS.DESKTOP);
  assert.deepEqual(localCalls, ['node-pc-1'], '优先从桌面版出图');

  // RS18-local.2 授权不满足：桌面版没授权，降级到电脑浏览器
  localCalls = [];
  const unauthDesktop = { ...desktopNode, authorized: false };
  const res2 = await dispatchFrameSnapshot({
    memberNodes: [unauthDesktop, browserNode],
    projectCodeVersion: 'v1',
    cloudLook: async () => ({ ok: true, cloud: true }),
    callLocal: async (node) => { localCalls.push(node.id); return { ok: true, frame: 'snap-' + node.id }; },
    request: { path: '/api/vision/snapshot', body: { t: 1 } },
  });
  assert.equal(res2.source, FRAME_SOURCE_LEVELS.BROWSER_PC);
  assert.deepEqual(localCalls, ['node-web-1']);

  // RS18-local.3 能力不满足：电脑浏览器没有出图能力，退回云端渲染服务
  localCalls = [];
  const incapableBrowser = { ...browserNode, capabilities: { canSnapshot: false } };
  let cloudCalled = false;
  const res3 = await dispatchFrameSnapshot({
    memberNodes: [incapableBrowser],
    projectCodeVersion: 'v1',
    cloudLook: async () => { cloudCalled = true; return { ok: true, cloud: true }; },
    callLocal: async (node) => { localCalls.push(node.id); return { ok: true }; },
    request: { path: '/api/vision/snapshot', body: { t: 1 } },
  });
  assert.equal(res3.source, FRAME_SOURCE_LEVELS.HOSTED_RENDER);
  assert.equal(cloudCalled, true);
  assert.deepEqual(localCalls, [], '不合格节点不发起请求');

  // RS18-local.4 可用性不满足：在线但调用超时/失败，自动转云端
  localCalls = [];
  cloudCalled = false;
  const res4 = await dispatchFrameSnapshot({
    memberNodes: [desktopNode],
    projectCodeVersion: 'v1',
    cloudLook: async () => { cloudCalled = true; return { ok: true, cloud: true }; },
    callLocal: async () => { throw new Error('timeout'); },
    request: { path: '/api/vision/snapshot', body: { t: 1 } },
  });
  assert.equal(res4.source, FRAME_SOURCE_LEVELS.HOSTED_RENDER);
  assert.equal(cloudCalled, true);

  // RS18-local.5 全部离线：云端单活跃项目兜底，仍得到帧
  cloudCalled = false;
  const offlineDesktop = { ...desktopNode, online: false };
  const res5 = await dispatchFrameSnapshot({
    memberNodes: [offlineDesktop],
    cloudLook: async () => { cloudCalled = true; return { ok: true, cloud: true }; },
    request: { path: '/api/vision/snapshot', body: { t: 1 } },
  });
  assert.equal(res5.source, FRAME_SOURCE_LEVELS.HOSTED_RENDER);
  assert.equal(cloudCalled, true);

  // RS18-local.6 执行中掉线：本地节点取帧到一半断开 -> 转云端，不丢
  cloudCalled = false;
  const res6 = await dispatchFrameSnapshot({
    memberNodes: [desktopNode],
    projectCodeVersion: 'v1',
    cloudLook: async () => { cloudCalled = true; return { ok: true, cloud: true }; },
    callLocal: async () => { throw new Error('socket closed'); },
    request: { path: '/api/vision/snapshot', body: { t: 1 } },
  });
  assert.equal(res6.source, FRAME_SOURCE_LEVELS.HOSTED_RENDER);
  assert.equal(cloudCalled, true);

  // RS18-local.7 取消：Agent 这一轮被停，本地与云端请求都撤回
  const ac = new AbortController();
  ac.abort(new Error('run-fenced'));
  await assert.rejects(dispatchFrameSnapshot({
    memberNodes: [desktopNode],
    cloudLook: async () => ({ ok: true }),
    callLocal: async () => ({ ok: true }),
    request: { path: '/api/vision/snapshot', body: { t: 1 } },
    signal: ac.signal,
  }), /run-fenced/);

  // RS18-local.8 版本切换/迟到结果：项目改了版本后，旧版本的本地结果迟到被隔离丢弃并转云端
  let rev = 1;
  cloudCalled = false;
  const res8 = await dispatchFrameSnapshot({
    memberNodes: [desktopNode],
    projectCodeVersion: 'v1',
    cloudLook: async () => { cloudCalled = true; return { ok: true, cloud: true }; },
    callLocal: async () => {
      rev = 2; // 版本在取帧过程中切换
      return { ok: true, stale: true };
    },
    getProjectRev: () => rev,
    request: { path: '/api/vision/snapshot', body: { t: 1 } },
  });
  assert.equal(res8.source, FRAME_SOURCE_LEVELS.HOSTED_RENDER, '迟到旧结果被丢弃，转云端');
  assert.equal(cloudCalled, true);

  // RS18-local.9 界面播放头不变：节点 keepPlayhead 为 false 时不合格
  const movingPlayheadNode = { ...desktopNode, keepPlayhead: false };
  assert.equal(isQualifiedMemberNode(movingPlayheadNode), false, '动播放头的设备不合格');

  // RS18-local.10 云端兜底且手机浏览器次级兜底
  const mobileNode = { id: 'node-mobile-1', isMobile: true, online: true, authorized: true, capabilities: { canSnapshot: true }, keepPlayhead: true };
  const res10 = await dispatchFrameSnapshot({
    memberNodes: [mobileNode],
    cloudLook: async () => { throw new Error('cloud-off'); },
    callLocal: async (node) => ({ ok: true, frame: 'mobile-snap' }),
    request: { path: '/api/vision/snapshot', body: { t: 1 } },
  });
  assert.equal(res10.source, FRAME_SOURCE_LEVELS.BROWSER_MOBILE, '云端也不可用时手机浏览器兜底');
});
