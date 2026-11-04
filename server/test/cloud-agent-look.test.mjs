/**
 * Cloud Agent frame viewing wiring on the Agent service side (contract
 * `docs/plan/cloud-agent-contract.md` Section 9.8). Render service uses a mock, model uses a
 * simulated provider.
 *
 * CA-LOOK-02 Configured with frame viewing: `see_frames` passes this version of project replica and
 *            timestamp to render service, returned images enter model history, not event log;
 *            project is this instance's project (from auth), chats from another project get their
 *            own project's; results omit `visualId` that the page cannot retrieve; `get_layout`
 *            includes entity boxes; when render service says "View failed this time", verbatim
 *            passed to model, this round ends as usual; explicitly states media shot montage
 *            cannot be done.
 * CA-LOOK-03 Not configured: the four frame-viewing tools are not given to model, calls return a
 *            clear reason; system prompt writes "Cannot view frames"; `get_layout` still answers
 *            specified boxes.
 * CA-LOOK-04 Tool table: four tools grouped under "Execute on replica" and marked look; two sets
 *            of manifests for configured and unconfigured.
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
/** A 1×1 PNG (content does not matter, only verifies it entered model history as-is) */
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** Mock render service: records each request; `reply(req)` can be swapped */
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
  // Passed to render service: this instance's project, this version of replica (including
  // just-applied changes), requested timestamp
  const snap = look.calls.find((c) => c.path === '/api/vision/snapshot');
  assert.equal(snap.projectId, 'p-a');
  assert.equal(snap.body.t, 2);
  assert.deepEqual([snap.body.project.id, snap.body.project.tracks[0].clips[0].start, snap.body.project.tracks[0].clips[0].end], ['p-a', 1, 5], 'It is this version of the project');
  assert.deepEqual(snap.cards, {}, 'This project has no card source');
  assert.ok(snap.timeoutMs >= 60_000, 'The frame-viewing time limit is longer than for ordinary tools');
  // Frames entered model history (image chunk), event log contains no base64
  const images = imagesIn(historyOf(kit, alice, 'c-look'));
  assert.deepEqual(images.map((b) => [b.mime, b.data]), [['image/png', PNG_B64]]);
  assert.equal(JSON.stringify(ea).includes(PNG_B64), false, 'The event log does not include the image');
  assert.equal(/visualId/.test(results[1].summary), false, 'Does not include a visualId the page cannot get');
  assert.equal(look.calls.some((c) => c.path === '/api/ai/visual'), true, 'The executor queried the visual record the same way as the desktop app (the cloud client does not send this one, see CA-LOOK-01)');
  // get_layout includes entity boxes
  assert.match(results[2].summary, /"contentBox":\{"left":1,"top":2,"width":3,"height":4\}/);
  // Media shot montage: explicitly says unsupported, did not query render service
  assert.match(results[3].summary, /only view frames on the timeline/);
  assert.equal(look.calls.filter((c) => c.path === '/api/vision/snapshot').length, 1);

  // Chat from another project: gets its own project's (client bound strictly to instance's project)
  await kit.service.send(bob, 'c-look-b', { prompt: script([{ tool: 'see_frames', input: { source: 'timeline', t: 0 } }, { say: 'Party B looked' }]) });
  await kit.finished(bob, 'c-look-b');
  const mine = look.calls.filter((c) => c.path === '/api/vision/snapshot').at(-1);
  assert.deepEqual([mine.projectId, mine.body.project.id], ['p-b', 'p-b']);
  assert.equal(JSON.stringify(mine.body).includes('A'), false, 'Party B\'s request contains nothing of Party A\'s');

  // Render service says "View failed this time": verbatim passed to model, this round ends as usual
  // without hanging
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
  // Model does not have see_frames (mock model calls anyway, driver replies "Unknown tool");
  // get_layout still answers, entity box is null
  assert.equal(results[0].ok, false);
  assert.match(results[0].summary, /Unknown tool see_frames/);
  assert.equal(results[1].ok, true);
  assert.match(results[1].summary, /"contentBox":null/);
  // Checked again at main entry point: direct calls also return a clear reason
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
  // Prompt: when configured, writes "Use as usual but slow" and "Do not retry repeatedly if viewing
  // failed"; when unconfigured, writes "Cannot view frames"
  const on = cloudSystemNote({ look: true });
  const off = cloudSystemNote({ look: false });
  assert.match(on, /Viewing frames works as usual, but slower than on this machine/);
  assert.match(on, /Could not view this time/);
  assert.equal(/Frames cannot be viewed|not handed to you/.test(on), false);
  assert.match(off, /Frames cannot be viewed on this cloud node/);
  assert.match(off, /not handed to you/);
  assert.equal(off, CLOUD_SYSTEM_NOTE);
  for (const note of [on, off]) for (const must of ['initiator offline', 'import_media', 'create_card', 'the host\'s voiceover service']) assert.ok(note.includes(must), must);
  assert.equal(on.split('\n').length, off.split('\n').length, 'The only difference is the frame-viewing section');
  // Cloud results: omit visualId and GIF URLs that the page cannot retrieve; get_gif description
  // reflects reality
  assert.deepEqual(cloudLookResult('see_frames', { visualId: 'v-1', ok: true, t: 1, __image: { mime: 'image/png', base64: 'x' } }), { ok: true, t: 1, __image: { mime: 'image/png', base64: 'x' } });
  const gif = cloudLookResult('get_gif', { visualId: 'v-2', ok: true, clipId: 'c', times: [0], gif: '/api/ai/visual/gif/0123.gif', note: 'The user can open this step in the chat panel to see the GIF.' });
  assert.deepEqual(Object.keys(gif).sort(), ['clipId', 'note', 'ok', 'times']);
  assert.match(gif.note, /the user cannot see the animated image in the chat panel/);
  assert.deepEqual(cloudLookResult('see_frames', { ok: false, error: 'x' }), { ok: false, error: 'x' });
  assert.equal(lookUnavailable('see_frames').cloudUnavailable, true);
});

import {
  dispatchFrameSnapshot, selectEligibleLocalNodes, isQualifiedMemberNode, classifyNode, FRAME_SOURCE_LEVELS,
} from '../agent/service/frame-dispatcher.mjs';

test('RS18-local.1~10 Cloud Agent frame output four-level priority (desktop app > desktop browser > hosted render service > mobile browser) and late-result isolation/cancel', async () => {
  // RS18-local.1 Local success: desktop app qualifies and answers first
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

  // RS18-local.2 Authorization not met: desktop app not authorized, downgrade to desktop browser
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

  // RS18-local.3 Capability not met: desktop browser lacks frame output capability, fall back to
  // cloud render service
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

  // RS18-local.4 Availability not met: online but call timed out/failed, automatically switch to cloud
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

  // RS18-local.5 All offline: fallback to cloud single active project, still gets frames
  cloudCalled = false;
  const offlineDesktop = { ...desktopNode, online: false };
  const res5 = await dispatchFrameSnapshot({
    memberNodes: [offlineDesktop],
    cloudLook: async () => { cloudCalled = true; return { ok: true, cloud: true }; },
    request: { path: '/api/vision/snapshot', body: { t: 1 } },
  });
  assert.equal(res5.source, FRAME_SOURCE_LEVELS.HOSTED_RENDER);
  assert.equal(cloudCalled, true);

  // RS18-local.6 Disconnected during execution: local node disconnects halfway through fetching
  // frames -> switch to cloud, no loss
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

  // RS18-local.7 Cancellation: Agent round stopped, both local and cloud requests retracted
  const ac = new AbortController();
  ac.abort(new Error('run-fenced'));
  await assert.rejects(dispatchFrameSnapshot({
    memberNodes: [desktopNode],
    cloudLook: async () => ({ ok: true }),
    callLocal: async () => ({ ok: true }),
    request: { path: '/api/vision/snapshot', body: { t: 1 } },
    signal: ac.signal,
  }), /run-fenced/);

  // RS18-local.8 Version switch / late result: after project version changes, late local results from
  // old version are quarantined, discarded, and switched to cloud
  let rev = 1;
  cloudCalled = false;
  const res8 = await dispatchFrameSnapshot({
    memberNodes: [desktopNode],
    projectCodeVersion: 'v1',
    cloudLook: async () => { cloudCalled = true; return { ok: true, cloud: true }; },
    callLocal: async () => {
      rev = 2; // Version switches during frame fetching
      return { ok: true, stale: true };
    },
    getProjectRev: () => rev,
    request: { path: '/api/vision/snapshot', body: { t: 1 } },
  });
  assert.equal(res8.source, FRAME_SOURCE_LEVELS.HOSTED_RENDER, 'Late old result is discarded, switch to the cloud');
  assert.equal(cloudCalled, true);

  // RS18-local.9 Playhead unchanged: node is disqualified when keepPlayhead is false
  const movingPlayheadNode = { ...desktopNode, keepPlayhead: false };
  assert.equal(isQualifiedMemberNode(movingPlayheadNode), false, 'A device that moves the playhead is unqualified');

  // RS18-local.10 Cloud fallback and mobile browser secondary fallback
  const mobileNode = { id: 'node-mobile-1', isMobile: true, online: true, authorized: true, capabilities: { canSnapshot: true }, keepPlayhead: true };
  const res10 = await dispatchFrameSnapshot({
    memberNodes: [mobileNode],
    cloudLook: async () => { throw new Error('cloud-off'); },
    callLocal: async (node) => ({ ok: true, frame: 'mobile-snap' }),
    request: { path: '/api/vision/snapshot', body: { t: 1 } },
  });
  assert.equal(res10.source, FRAME_SOURCE_LEVELS.BROWSER_MOBILE, 'Mobile browser is the fallback when the cloud is also unavailable');
});
