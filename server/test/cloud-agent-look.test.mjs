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

const alice = { projectId: 'p-a', userId: 'alice@dev-a', username: 'alice', deviceName: 'A\'s computer' };
const bob = { projectId: 'p-b', userId: 'bob@dev-b', username: 'bob', deviceName: 'B\'s computer' };
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
        if (pathname === '/api/vision/snapshot') return { ok: true, t: body.t ?? 0, clipId: body.clipId ?? null, width: 768, height: 432, rects: null, note: 'Visual', __image: { mime: 'image/png', base64: PNG_B64 } };
        if (pathname === '/api/cards/layout') return { ok: true, clips: Object.fromEntries((body.clipIds ?? []).map((id) => [id, { contentBox: { left: 1, top: 2, width: 3, height: 4 } }])) };
        return { ok: false, error: 'The stub does not have this one' };
      };
    },
    describe: () => ({ url: 'fake', requests: calls.length }),
  };
}
const historyOf = (kit, identity, conversationId) => JSON.parse(fs.readFileSync(path.join(kit.dataDir, 'tenants', identity.projectId, 'owners', ownerKeyOf(identity), 'conversations', conversationId, 'history.json'), 'utf8'));
const imagesIn = (messages) => messages.flatMap((m) => (Array.isArray(m.content) ? m.content.filter((b) => b?.type === 'image') : []));
const eventsOf = (kit, identity, conversationId) => { const all = []; kit.service.subscribe(identity, conversationId, 0, (ev) => all.push(ev))?.(); return all; };

test('CA-LOOK-02 with the frame-viewing hook configured: the frames go into the model\'s history; the project comes from authentication; the "could not view it this time" message is handed to the model verbatim; the result carries nothing the page cannot get', { timeout: 180_000 }, async (t) => {
  const look = fakeLook();
  const kit = await startKit(t, { extra: { look } });
  await kit.doc.seed(project('p-a', 'A'));
  await kit.doc.seed(project('p-b', 'B'));
  assert.equal(kit.service.look, true);

  await kit.service.send(alice, 'c-look', { prompt: script([
    { tool: 'update_clip', input: { clipId: 'c1', start: 1, end: 5 } },
    { tool: 'see_frames', input: { source: 'timeline', t: 2 } },
    { tool: 'get_layout', input: { clipId: 'c1' } },
    { tool: 'see_frames', input: { source: 'media', mediaId: 'm1' } },
    { say: 'Looked' },
  ]) });
  const ea = await kit.finished(alice, 'c-look');
  assert.equal(ea.at(-1).state, 'idle');
  const results = ea.filter((e) => e.type === 'tool_result');
  assert.deepEqual(results.map((e) => [e.name, e.ok]), [['update_clip', true], ['see_frames', true], ['get_layout', true], ['see_frames', false]]);
  // 交给渲染服务的:这个实例的项目、这一版副本(含刚落地的改动)、要的时刻
  const snap = look.calls.find((c) => c.path === '/api/vision/snapshot');
  assert.equal(snap.projectId, 'p-a');
  assert.equal(snap.body.t, 2);
  assert.deepEqual([snap.body.project.id, snap.body.project.tracks[0].clips[0].start, snap.body.project.tracks[0].clips[0].end], ['p-a', 1, 5], 'It is this version of the project');
  assert.deepEqual(snap.cards, {}, 'This project has no card source');
  assert.ok(snap.timeoutMs >= 60_000, 'The frame-viewing time limit is longer than for ordinary tools');
  // 画面进了模型的历史(图片块),事件记录里没有 base64
  const images = imagesIn(historyOf(kit, alice, 'c-look'));
  assert.deepEqual(images.map((b) => [b.mime, b.data]), [['image/png', PNG_B64]]);
  assert.equal(JSON.stringify(ea).includes(PNG_B64), false, 'The event log does not include the image');
  assert.equal(/visualId/.test(results[1].summary), false, 'Does not include a visualId the page cannot get');
  assert.equal(look.calls.some((c) => c.path === '/api/ai/visual'), true, 'The executor queried the visual record the same way as the desktop app (the cloud client does not send this one, see CA-LOOK-01)');
  // get_layout 带实体框
  assert.match(results[2].summary, /"contentBox":\{"left":1,"top":2,"width":3,"height":4\}/);
  // 素材的镜头拼图:明说做不了,没有去问渲染服务
  assert.match(results[3].summary, /only view frames on the timeline/);
  assert.equal(look.calls.filter((c) => c.path === '/api/vision/snapshot').length, 1);

  // 另一个项目的对话:拿到的是它自己项目的(客户端按实例的项目绑死)
  await kit.service.send(bob, 'c-look-b', { prompt: script([{ tool: 'see_frames', input: { source: 'timeline', t: 0 } }, { say: 'Party B looked' }]) });
  await kit.finished(bob, 'c-look-b');
  const mine = look.calls.filter((c) => c.path === '/api/vision/snapshot').at(-1);
  assert.deepEqual([mine.projectId, mine.body.project.id], ['p-b', 'p-b']);
  assert.equal(JSON.stringify(mine.body).includes('A'), false, 'Party B\'s request contains nothing of Party A\'s');

  // 渲染服务说「这次没看成」:原话交给模型,这一轮照常结束,不挂着
  look.state.reply = () => { throw new Error('Could not view it this time: the render service is rendering custom cards of another project, and projects with custom cards have to queue. Look again in a moment, and carry on from the project content for now.'); };
  const t0 = Date.now();
  await kit.service.send(alice, 'c-look-2', { prompt: script([{ tool: 'see_frames', input: { source: 'timeline', t: 1 } }, { tool: 'bake_card', input: { clipId: 'c1' } }, { say: 'Done even though viewing failed' }]) });
  const e2 = await kit.finished(alice, 'c-look-2');
  assert.equal(e2.at(-1).state, 'idle');
  const r2 = e2.filter((e) => e.type === 'tool_result');
  assert.deepEqual(r2.map((e) => [e.name, e.ok]), [['see_frames', false], ['bake_card', false]]);
  assert.match(r2[0].summary, /Could not view it this time: the render service is rendering custom cards of another project/);
  assert.ok(Date.now() - t0 < 20_000);
  assert.equal(imagesIn(historyOf(kit, alice, 'c-look-2')).length, 0);
  assert.equal(kit.service.describe().look.url, 'fake');
});

test('CA-LOOK-03 without the frame-viewing hook configured: the four tools are not handed to the model, calls return a clear reason; get_layout still answers with the prescribed boxes', { timeout: 120_000 }, async (t) => {
  const kit = await startKit(t);
  await kit.doc.seed(project('p-a', 'A'));
  assert.equal(kit.service.look, false);
  await kit.service.send(alice, 'c-nolook', { prompt: script([{ tool: 'see_frames', input: { source: 'timeline', t: 1 } }, { tool: 'get_layout', input: { clipId: 'c1' } }, { say: 'Done' }]) });
  const ev = await kit.finished(alice, 'c-nolook');
  const results = ev.filter((e) => e.type === 'tool_result');
  // 模型手里没有 see_frames(模拟模型硬调,驱动答「未知工具」);get_layout 照答,实体框是 null
  assert.equal(results[0].ok, false);
  assert.match(results[0].summary, /Unknown tool see_frames/);
  assert.equal(results[1].ok, true);
  assert.match(results[1].summary, /"contentBox":null/);
  // 总入口再判一次:直接调也回明确的原因
  const inst = kit.service._instance(alice);
  for (const name of CLOUD_LOOK_TOOLS) {
    const r = await inst.callTool(name, { source: 'timeline', clipId: 'c1' }, 'c-nolook');
    assert.deepEqual([r.ok, r.cloudUnavailable], [false, true], name);
    assert.match(r.error, /cannot view frames/);
    assert.ok(r.error.includes(name));
  }
  await waitFor(() => kit.service.conversations(alice).find((c) => c.id === 'c-nolook')?.state === 'idle', 5000, 'wrap-up');
});

test('CA-LOOK-04 tool table: the four frame-viewing tools fall under "run on the copy" and are marked look; two tool lists and two prompts, with and without it configured', async () => {
  assert.deepEqual([...CLOUD_LOOK_TOOLS].sort(), ['bake_card', 'get_gif', 'inspect_card_dom', 'see_frames']);
  for (const name of CLOUD_LOOK_TOOLS) {
    assert.deepEqual(CLOUD_TOOL_PLAN[name], { mode: 'route', look: true });
    assert.deepEqual(checkCloudTool(name), { ok: true, mode: 'route' });
    assert.equal(CLOUD_OPEN_TOOLS.has(name), true);
    assert.equal(CLOUD_OPEN_TOOLS_NO_LOOK.has(name), false);
  }
  assert.equal(CLOUD_OPEN_TOOLS_NO_LOOK.size, CLOUD_OPEN_TOOLS.size - 6, 'Minus the four frame-viewing tools and the two card-sound tools (all need the render service on the same machine)');
  assert.equal(CLOUD_OPEN_TOOLS_NO_LOOK.has('get_layout'), true, 'get_layout can still answer the specified box without a picture');
  const offered = (await buildTools({ callTool: async () => [], workspaceDir: null, only: CLOUD_OPEN_TOOLS_NO_LOOK, localTools: false })).map((x) => x.name);
  assert.deepEqual(offered.filter((n) => CLOUD_LOOK_TOOLS.has(n)), []);
  // 提示词:配了写「照常用但慢」与「没看成不要反复重试」;没配写「看不了画面」
  const on = cloudSystemNote({ look: true });
  const off = cloudSystemNote({ look: false });
  assert.match(on, /viewing frames works as usual, but is slower than on this machine/);
  assert.match(on, /Look failed this time/);
  assert.equal(/cannot view frames|not handed to you/.test(on), false);
  assert.match(off, /This cloud node cannot view frames/);
  assert.match(off, /not handed to you/);
  assert.equal(off, CLOUD_SYSTEM_NOTE);
  for (const note of [on, off]) for (const must of ['the initiator is offline', 'import_media', 'create_card', 'the host\'s voiceover service']) assert.ok(note.includes(must), must);
  assert.equal(on.split('\n').length, off.split('\n').length, 'The only difference is the frame-viewing section');
  // 云端的结果:不带页面取不到的 visualId 与动图地址;get_gif 的说明照实
  assert.deepEqual(cloudLookResult('see_frames', { visualId: 'v-1', ok: true, t: 1, __image: { mime: 'image/png', base64: 'x' } }), { ok: true, t: 1, __image: { mime: 'image/png', base64: 'x' } });
  const gif = cloudLookResult('get_gif', { visualId: 'v-2', ok: true, clipId: 'c', times: [0], gif: '/api/ai/visual/gif/0123.gif', note: 'The user can open this step in the chat panel to see the GIF.' });
  assert.deepEqual(Object.keys(gif).sort(), ['clipId', 'note', 'ok', 'times']);
  assert.match(gif.note, /the user cannot see the GIF in the chat panel/);
  assert.deepEqual(cloudLookResult('see_frames', { ok: false, error: 'x' }), { ok: false, error: 'x' });
  assert.equal(lookUnavailable('see_frames').cloudUnavailable, true);
});

import {
  dispatchFrameSnapshot, selectEligibleLocalNodes, isQualifiedMemberNode, classifyNode, FRAME_SOURCE_LEVELS,
} from '../agent/service/frame-dispatcher.mjs';

test('RS18-local.1~10 Cloud Agent frame output four-level priority (desktop app > desktop browser > hosted render service > mobile browser) and late-result isolation/cancel', async () => {
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
  assert.deepEqual(localCalls, ['node-pc-1'], 'Prefer the desktop app for frame output');

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
  assert.deepEqual(localCalls, [], 'No request is sent to unqualified nodes');

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
  assert.equal(res8.source, FRAME_SOURCE_LEVELS.HOSTED_RENDER, 'Late old result is discarded, switch to the cloud');
  assert.equal(cloudCalled, true);

  // RS18-local.9 界面播放头不变：节点 keepPlayhead 为 false 时不合格
  const movingPlayheadNode = { ...desktopNode, keepPlayhead: false };
  assert.equal(isQualifiedMemberNode(movingPlayheadNode), false, 'A device that moves the playhead is unqualified');

  // RS18-local.10 云端兜底且手机浏览器次级兜底
  const mobileNode = { id: 'node-mobile-1', isMobile: true, online: true, authorized: true, capabilities: { canSnapshot: true }, keepPlayhead: true };
  const res10 = await dispatchFrameSnapshot({
    memberNodes: [mobileNode],
    cloudLook: async () => { throw new Error('cloud-off'); },
    callLocal: async (node) => ({ ok: true, frame: 'mobile-snap' }),
    request: { path: '/api/vision/snapshot', body: { t: 1 } },
  });
  assert.equal(res10.source, FRAME_SOURCE_LEVELS.BROWSER_MOBILE, 'Mobile browser is the fallback when the cloud is also unavailable');
});
