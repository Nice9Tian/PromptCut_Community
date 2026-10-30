/**
 * 片段速度(`TrackClip.speed`,`src/kernel/clipTime.mjs`)横跨各处的口径:
 *   - 缺省 1(没有字段)时各处身份键逐字不变:下面的固定值是开工提交 5a8f375a 上同一份样例算出来的(`out/speed/golden.mjs`);
 *   - 变速段的画面各处按「素材时刻 = mediaOffset + (t − start) × speed」取;
 *   - 〔裁〕第一版变速段的原声不出(导出混音、预览声音层同一条 `speedMutesSource`);挂在上面的声画一体卡照常出声(2026-10-23 用户定「出声。」);
 *   - store 改速度保住入点、按新速度重算终点,改回 1 删掉字段。
 * 跑:npm test -- server/test/clip-speed.test.mjs
 */
import { srcUrl } from '../../src/testing/registerTs.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { frameIdentity, trackPrefixes } from '../frame-identity.mjs';
import { cardSnapshotInputKeys, cardNodeIdentities } from '../card-identity.mjs';
import { clipInputSig } from '../../src/render/layerInputSig.mjs';
import { projectHash } from '../../src/render/changedClips.mjs';
import { projectCardGraph } from '../../src/kernel/cardGraph.mjs';
import { audioPlanOf } from '../../src/kernel/audioPlan.mjs';
import { flatPlanProject } from '../../src/kernel/cutFlatten.mjs';
import { withMediaRates, ffmpegVarispeed } from '../../src/kernel/clipTime.mjs';
import { buildFfmpegArgs, playableAudioPlan } from '../bakery/mux-audio.mjs';
import { timelineMixParts } from '../audio-measure.mjs';
import { buildAudioPlan } from '../bakery/mux-audio.mjs';
import { mediaLayersAt } from '../vision-compose.mjs';
import { buildComposeArgs } from '../export-compose.mjs';

const fixture = () => ({
  id: 'p', width: 1280, height: 720, fps: 30, duration: 12, themeId: 'dark',
  media: [{ id: 'v1', kind: 'video', url: '/@media/v1.mp4', hash: 'h-v1', duration: 20 }, { id: 'a1', kind: 'audio', url: '/@media/a1.mp3', duration: 30 }],
  cardNodes: [{ id: 'n1', adapter: 'card', cardId: 'fx-tint', kind: 'filter', params: {}, inputs: { source: '@clip/v-fx/source' } }],
  tracks: [
    { id: 't1', name: '序列 1', clips: [{ id: 'c1', cardId: 'punch-pill', start: 0, end: 2, params: { text: 'a' } }] },
    { id: 't2', name: '序列 2', clips: [
      { id: 'v-plain', cardId: '', mediaId: 'v1', mediaOffset: 1.5, start: 0, end: 4, params: {} },
      { id: 'v-fx', cardId: '', mediaId: 'v1', mediaOffset: 0.2, start: 4, end: 8, params: {}, nodeId: 'n1' },
    ] },
    { id: 't3', name: '序列 3', clips: [{ id: 'a-1', cardId: '', mediaId: 'a1', mediaOffset: 3, start: 0, end: 10, params: {} }] },
  ],
});
const DEFS = { 'fx-tint': { id: 'fx-tint', kind: 'filter', defaults: {}, card() {} }, 'punch-pill': { id: 'punch-pill', defaults: { text: '' } } };
const withClip = (p, id, patch) => ({ ...p, tracks: p.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => (c.id === id ? { ...c, ...patch } : c)) })) });
// 出画面、出键的几处都是 projectCardGraph 之后接 withMediaRates(cardGraph.mjs 在有声卡的源码闭包里,不能改它)
const graphOf = (p) => withMediaRates(p, projectCardGraph(p, (id) => DEFS[id]));
const graphKeys = (p) => {
  const graph = graphOf(p);
  return { inputKeys: Object.fromEntries(cardSnapshotInputKeys(graph)), nodeIds: Object.fromEntries(cardNodeIdentities(graph)) };
};

/* ---------- 缺省 1:身份逐字不变 ---------- */

// 开工提交 5a8f375a(与像素基线提交 5f4523d0 相同)上算的固定值
const GOLDEN = {
  frameIdentity: 'aed6ffcff5fd4e233c5701c6033d2b74df9d06db110d05056106cfa632cb6163',
  trackPrefixes: [
    'd36693eb5c81c63e67a2980a9d1afa342337df3c61c7c0cf22fe039c429ff974',
    '1054781b6b5080c3db98fc2c3f4aefa2c1800cdd52b5ed12e22cc65e0a9f08f2',
    'aed6ffcff5fd4e233c5701c6033d2b74df9d06db110d05056106cfa632cb6163',
  ],
  projectHash: '18303b68ed969381',
  sigs: { c1: 'i1-d3f5f71cb7d2238e', 'v-plain': 'i1-e565d029c406bc63', 'v-fx': 'i1-a72af12d3494e2f9', 'a-1': 'i1-f6d1bc7e18872ea9' },
  fxInputKey: '3194e3a40b920851181c0125b3ad2de14f3703bb540815ed1138bfcb926b649b',
};

test('缺省 1:帧身份、轨道前缀、镜像哈希、输入签名、卡片图上游键与开工提交逐字相同', () => {
  const p = fixture();
  assert.equal(frameIdentity(p, 'code'), GOLDEN.frameIdentity);
  assert.deepEqual(trackPrefixes(p, 'code').map((x) => x.key), GOLDEN.trackPrefixes);
  assert.equal(projectHash(p), GOLDEN.projectHash);
  for (const [id, sig] of Object.entries(GOLDEN.sigs)) assert.equal(clipInputSig(p, id), sig, id);
  assert.equal(graphKeys(p).inputKeys.n1.source.key, GOLDEN.fxInputKey);
  // 素材节点上没有 rate 这一项(缺省 1 不进节点)
  const graph = graphOf(p);
  assert.equal('rate' in graph.nodes.find((n) => n.id === '@clip/v-fx/source'), false);
  const raw = projectCardGraph(p, (id) => DEFS[id]);
  assert.equal(withMediaRates(p, raw), raw, '没有变速段时回同一个对象');
});

test('变速:层表输入签名、卡片图素材节点、接它的素材效果卡上游键都跟着变;别的片段不变', () => {
  const p = fixture();
  const fast = withClip(p, 'v-fx', { speed: 2 });
  assert.notEqual(clipInputSig(fast, 'v-fx'), clipInputSig(p, 'v-fx'), '变速段自己的签名要变');
  assert.equal(clipInputSig(fast, 'v-plain'), clipInputSig(p, 'v-plain'), '别的片段不变');
  const node = graphOf(fast).nodes.find((n) => n.id === '@clip/v-fx/source');
  assert.equal(node.rate, 2, '素材节点带上倍率');
  assert.notEqual(graphKeys(fast).inputKeys.n1.source.key, GOLDEN.fxInputKey, '接变速素材的素材效果卡上游键要变(否则命中旧快照)');
  assert.notEqual(graphKeys(fast).nodeIds['@clip/v-fx/source'], graphKeys(p).nodeIds['@clip/v-fx/source']);
  // 整份序列进哈希的几处:多了一个键自然就变
  assert.notEqual(frameIdentity(fast, 'code'), GOLDEN.frameIdentity);
  assert.notEqual(projectHash(fast), GOLDEN.projectHash);
  // speed: 1 显式写着也按缺省算(签名口径不因多写一个 1 而变)
  assert.equal(clipInputSig(withClip(p, 'v-fx', { speed: 1 }), 'v-fx'), GOLDEN.sigs['v-fx']);
});

/* ---------- 画面取哪一帧 ---------- */

test('看画面(vision-compose):素材时刻按速度换算', () => {
  const p = withClip(fixture(), 'v-plain', { speed: 2 });
  const layer = mediaLayersAt(p, 1).find((l) => l.clip.id === 'v-plain');
  assert.equal(layer.mediaTime, 1.5 + 1 * 2);
  const slow = withClip(fixture(), 'v-plain', { speed: 0.5 });
  assert.equal(mediaLayersAt(slow, 3).find((l) => l.clip.id === 'v-plain').mediaTime, 1.5 + 3 * 0.5);
});

test('导出兼容旁路(export-compose):变速段按倍率把素材时间戳压到时间轴上,读的素材长度乘倍率', () => {
  const media = { id: 'v1', kind: 'video', name: 'a.mp4', url: '/@media/a.mp4' };
  const frame = { x: 0, y: 0, w: 1920, h: 1080, anchor: [0, 0], scale: 1, rotate: 0 };
  const build = (speed) => buildComposeArgs({ width: 1920, height: 1080, fps: 30, startFrame: 0, endFrame: 89, cardsPattern: 'f/%06d.png', out: 'o.mp4',
    layers: [{ clip: { id: 'c', mediaId: 'v1', mediaOffset: 10, start: 0, end: 3, frame, ...(speed ? { speed } : {}) }, media, src: '/m/a.mp4' }] });
  const one = build(undefined), two = build(2);
  const ssOf = (r) => r.args[r.args.indexOf('-ss') + 1], tOf = (r) => r.args[r.args.indexOf('-t') + 1];
  assert.equal(ssOf(one), '9.5');
  assert.equal(ssOf(two), '9.5', '入点不变');
  assert.equal(tOf(one), '4');
  assert.equal(tOf(two), '7', '素材要读 3 秒 × 2 + 两头余量');
  assert.match(one.graph, /setpts=PTS\+-0\.5\/TB,fps=30/, '缺省 1 的写法不变');
  assert.match(two.graph, /setpts=PTS\/2\+-0\.25\/TB,fps=30/, '时间戳除以倍率再平移:素材 m 秒落到 start + (m − off)/2');
});

test('素材效果卡的素材节点(withMediaRates):取帧时刻乘倍率,缺省不带倍率', () => {
  const p = withClip(fixture(), 'v-fx', { speed: 0.5 });
  const node = graphOf(p).nodes.find((n) => n.id === '@clip/v-fx/source');
  assert.deepEqual([node.offset, node.rate], [0.2, 0.5]);
});

/* ---------- 声音:变速段原声不出 ---------- */

test('导出混音清单(audioPlanOf):变速的视频段不出原声,别的段原样', () => {
  const base = audioPlanOf(fixture());
  const p = withClip(fixture(), 'v-plain', { speed: 2 });
  const plan = audioPlanOf(p);
  assert.equal(plan.some((e) => e.clipId === 'v-plain'), false, '变速段不在混音清单里');
  assert.deepEqual(plan, base.filter((e) => e.clipId !== 'v-plain'), '其余条目逐字相同');
  // ffmpeg 那条老路(mux-audio)用同一份清单
  const files = buildAudioPlan(p, 'out', () => true, (m) => `/x/${m.id}`);
  assert.equal(files.some((e) => e.clipId === 'v-plain'), false);
  assert.ok(files.some((e) => e.clipId === 'v-fx'));
});

/* ---------- 剪辑段里的变速段 ---------- */

test('剪辑段摊平(cutFlatten):截掉的那一截按倍率推进素材起点,速度带下去', () => {
  const p = {
    id: 'p', width: 1280, height: 720, fps: 30, duration: 20, media: [{ id: 'v1', kind: 'video', url: '/@media/v1.mp4' }],
    tracks: [{ id: 'ta', name: '序列 1', clips: [{ id: 'seg', cardId: '', cutId: 'B', cutOffset: 1, start: 2, end: 6, params: {} }] }],
    cuts: [{ id: 'A', name: '剪辑A' }, { id: 'B', name: '剪辑B', duration: 8, transitions: [], tracks: [{ id: 'tb', name: '序列 1', clips: [{ id: 'b1', cardId: '', mediaId: 'v1', mediaOffset: 3, speed: 2, start: 0, end: 8, params: {} }] }] }],
    activeCutId: 'A',
  };
  const v = flatPlanProject(p).tracks.flatMap((t) => t.clips).find((c) => c.id === 'seg~b1');
  assert.ok(v, '摊出来的虚拟片段');
  assert.equal(v.speed, 2);
  assert.equal(v.mediaOffset, 3 + 1 * 2, '截掉 1 秒时间轴 = 2 秒素材');
});

/* ---------- 实时播放的速率 ---------- */

test('预览同步(mediaSync.planSync):播放速率以片段速度为基准,纠偏在它上面浮动', async () => {
  const { planSync, MAX_RATE_SKEW } = await import(srcUrl('render/mediaSync.ts'));
  const base = { seeking: false, paused: false, playing: true, now: 10_000, lastSeekAt: 0 };
  assert.equal(planSync({ ...base, elTime: 5, target: 5 }).rate, 1, '缺省照旧是 1');
  assert.equal(planSync({ ...base, elTime: 5, target: 5, baseRate: 2 }).rate, 2, '对齐时按 2 倍放');
  const behind = planSync({ ...base, elTime: 5, target: 5.25, baseRate: 2 }).rate;
  assert.ok(behind > 2 && behind <= 2 * (1 + MAX_RATE_SKEW), `落后时在 2 倍上加速,实得 ${behind}`);
  assert.equal(planSync({ ...base, playing: false, paused: true, elTime: 5, target: 5, baseRate: 0.5 }).rate, 0.5, '暂停时停在基准速率');
});

/* ---------- 字幕、跟随轨迹 ---------- */

test('字幕铺放(captions):素材秒按速度换到时间轴,句长除以倍率', async () => {
  const { mapMediaTime, captionsFromTranscript } = await import(srcUrl('kernel/captions.ts'));
  const clips = [{ mediaId: 'v1', start: 10, end: 20, mediaOffset: 4, speed: 2 }];
  assert.equal(mapMediaTime(clips, 'v1', 8), 12, '素材第 8 秒 = 时间轴 10 + (8 − 4)/2');
  const plan = captionsFromTranscript(clips, 'v1', [{ start: 8, end: 10, text: '你好' }]);
  assert.deepEqual([plan.from, plan.to], [12, 13]);
});

test('跟随轨迹(motion):起点帧按速度换算,存的步长是时间轴上的秒', async () => {
  const { buildClipMotion } = await import(srcUrl('kernel/motion.ts'));
  const xy = Array.from({ length: 100 }, (_, i) => [i, 0]);
  const visible = xy.map(() => true);
  const common = { xy, visible, media: { id: 'v1', width: 1280, height: 720, duration: 10 }, stage: { width: 1280, height: 720 }, card: { start: 2, end: 3 }, pointIndex: 0, whenHidden: 'hold' };
  const one = buildClipMotion({ ...common, clipOfMedia: { start: 0, mediaOffset: 1 } });
  const two = buildClipMotion({ ...common, clipOfMedia: { start: 0, mediaOffset: 1, speed: 2 } });
  assert.equal(one.motion.frameStep, 0.1);
  assert.equal(two.motion.frameStep, 0.05, '素材 0.1 秒一点,2 倍速下时间轴 0.05 秒一点');
  assert.equal(two.motion.offsets.length, 21, '卡片 1 秒覆盖素材 2 秒 = 20 点 + 1');
  assert.equal(one.motion.offsets.length, 11);
});

/* ---------- store ---------- */

test('store.setClipSpeed:保住入点、按新速度重算终点,改回 1 删字段;切分的后半段按倍率推进素材起点', async () => {
  const { actions, getState } = await import(srcUrl('store/project.ts'));
  actions.loadProject({ version: 1, id: 'p-speed', name: 't', width: 1280, height: 720, fps: 30, duration: 20, themeId: 'midnight',
    media: [{ id: 'v1', kind: 'video', name: 'v.mp4', url: '/@media/v1.mp4', duration: 30 }, { id: 'i1', kind: 'image', name: 'i.png', url: '/@media/i.png' }],
    tracks: [{ id: 'ta', name: '序列 1', clips: [
      { id: 'v', cardId: '', mediaId: 'v1', mediaOffset: 2, start: 1, end: 5, params: {} },
      { id: 'img', cardId: '', mediaId: 'i1', start: 10, end: 12, params: {} },
    ] }] });
  const clip = (id) => getState().project.tracks.flatMap((t) => t.clips).find((c) => c.id === id);
  let r = actions.setClipSpeed('v', 2);
  assert.equal(r.ok, true);
  assert.deepEqual([clip('v').start, clip('v').end, clip('v').mediaOffset, clip('v').speed], [1, 3, 2, 2], '4 秒素材 2 倍速 = 2 秒');
  r = actions.setClipSpeed('v', 0.5);
  assert.deepEqual([clip('v').start, clip('v').end, clip('v').speed], [1, 9, 0.5], '同一截素材 0.5 倍 = 8 秒');
  r = actions.setClipSpeed('v', 0.5 * 4);
  r = actions.setClipSpeed('v', 1);
  assert.equal(r.ok, true);
  assert.equal('speed' in clip('v'), false, '改回 1 不留 speed 字段(身份键逐字回到原样)');
  assert.deepEqual([clip('v').start, clip('v').end], [1, 5]);
  // 变长碰到下一段:把后面的段推开(用户 2026-10-23 定),不截断
  r = actions.setClipSpeed('v', 0.25);
  assert.deepEqual(r, { ok: true, pushed: { clips: 1, by: 7 } });
  assert.equal(clip('v').end, 17, '0.25 倍要 16 秒,不截');
  assert.deepEqual([clip('img').start, clip('img').end], [17, 19], '后面的图片被推到 17');
  // 图片段不能变速
  assert.equal(actions.setClipSpeed('img', 2).ok, false);
  // 切分:后半段素材起点 = 2 + (5 − 1) × 0.25,带着速度
  const right = actions.splitClip('v', 5);
  assert.equal(right.speed, 0.25);
  assert.equal(right.mediaOffset, 2 + 4 * 0.25);
  // 变速段可以音画分离(用户 2026-10-23 定):分出来的声音段带着同样的速度;视频段自己的原声照旧不出(片段静音)
  const sep = actions.separateAudio('v');
  assert.equal(sep.ok, true);
  const sound = clip(sep.audioClipId);
  assert.equal(sound.speed, 0.25, '分出来的声音段带着速度');
  assert.equal(getState().project.media.find((m) => m.id === sound.mediaId).kind, 'audio');
  assert.equal(clip('v').audioMuted, true, '视频段静音(和分离前一样)');
  // 一次改速度(连带推开的段)= 一步撤销
  actions.undo(); actions.undo(); actions.undo();
  assert.equal(clip('v').speed, undefined);
  assert.deepEqual([clip('v').end, clip('img').start, clip('img').end], [5, 10, 12], '推开的段一起退回去');
});

test('store.setClipSpeed 推开:变短尾部留空;后面整体顺移(相对关系不变,先吃掉空档);转场组整组推;推不动整个拒绝、不截断', async () => {
  const { actions, getState } = await import(srcUrl('store/project.ts'));
  const load = (extra = {}) => actions.loadProject({ version: 1, id: 'p-push', name: 't', width: 1280, height: 720, fps: 30, duration: 40, themeId: 'midnight',
    media: [{ id: 'v1', kind: 'video', name: 'v.mp4', url: '/@media/v1.mp4', duration: 60 }],
    tracks: [
      { id: 'ta', name: '序列 1', clips: [
        { id: 'v', cardId: '', mediaId: 'v1', start: 0, end: 4, params: {} },
        { id: 'a', cardId: '', mediaId: 'v1', start: 5, end: 8, params: {} },
        { id: 'b', cardId: '', mediaId: 'v1', start: 10, end: 13, params: {} },
      ] },
      { id: 'tb', name: '序列 2', clips: [{ id: 'other', cardId: '', mediaId: 'v1', start: 6, end: 9, params: {} }], ...(extra.lockB ? { locked: true } : {}) },
    ], ...(extra.transitions ? { transitions: extra.transitions } : {}) });
  const clip = (id) => getState().project.tracks.flatMap((t) => t.clips).find((x) => x.id === id);
  const span = (id) => [clip(id).start, clip(id).end];

  load();
  let r = actions.setClipSpeed('v', 2);
  assert.deepEqual(r, { ok: true }, '变短不推');
  assert.deepEqual([span('v'), span('a'), span('b'), span('other')], [[0, 2], [5, 8], [10, 13], [6, 9]], '尾部留空,别的不动');

  load();
  r = actions.setClipSpeed('v', 0.5); // 4 → 8 秒,和 a(5 起)重合 3 秒
  assert.deepEqual(r, { ok: true, pushed: { clips: 2, by: 3 } });
  assert.deepEqual([span('v'), span('a'), span('b')], [[0, 8], [8, 11], [13, 16]], 'a、b 整体后移 3 秒,a 与 b 之间 2 秒的空档还在');
  assert.deepEqual(span('other'), [6, 9], '别的序列上的段不动');
  actions.undo();
  assert.deepEqual([span('v'), span('a'), span('b')], [[0, 4], [5, 8], [10, 13]], '一步撤销全退回');

  // 后面的 a 和别的序列上的 other 绑在交叉溶解里:整组一起推
  load({ transitions: [{ id: 'x', kind: 'crossfade', aId: 'other', bId: 'a', dur: 1 }] });
  r = actions.setClipSpeed('v', 0.5);
  assert.equal(r.ok, true);
  assert.deepEqual([span('a'), span('b'), span('other')], [[8, 11], [13, 16], [9, 12]], '转场组整组推,组内相对关系不变');
  actions.undo();
  assert.deepEqual([span('a'), span('other')], [[5, 8], [6, 9]]);

  // 组员在锁着的序列上:推不开,整个拒绝,什么都不改(不截断)
  load({ lockB: true, transitions: [{ id: 'x', kind: 'crossfade', aId: 'other', bId: 'a', dur: 1 }] });
  const before = getState().project;
  r = actions.setClipSpeed('v', 0.5);
  assert.equal(r.ok, false);
  assert.match(r.error, /锁着的序列/);
  assert.equal(getState().project, before, '拒绝时项目原样');
  assert.equal(clip('v').speed, undefined);
});

test('store.setClipSpeed 手动输入:0.25～4 之外拒绝并提示(不夹),小数取到百分之一', async () => {
  const { actions, getState } = await import(srcUrl('store/project.ts'));
  actions.loadProject({ version: 1, id: 'p-range', name: 't', width: 1280, height: 720, fps: 30, duration: 20, themeId: 'midnight',
    media: [{ id: 'v1', kind: 'video', name: 'v.mp4', url: '/@media/v1.mp4', duration: 60 }],
    tracks: [{ id: 'ta', name: '序列 1', clips: [{ id: 'v', cardId: '', mediaId: 'v1', start: 0, end: 4, params: {} }] }] });
  const clip = () => getState().project.tracks[0].clips[0];
  for (const bad of [0.2, 4.5, -1, 0]) {
    const r = actions.setClipSpeed('v', bad);
    assert.equal(r.ok, false, String(bad));
    assert.match(r.error, /0\.25～4/);
  }
  assert.equal(clip().speed, undefined, '拒绝时什么都不改');
  assert.equal(actions.setClipSpeed('v', 1.333).ok, true);
  assert.equal(clip().speed, 1.33);
  assert.equal(actions.setClipSpeed('v', 4).ok, true, '边界值可以');
});

test('store.setClipSpeed 挂着转场:淡化跟着两端走;交叉溶解前一段变速时后一段跟着挪、重叠不变;装不下转场拒绝', async () => {
  const { actions, getState } = await import(srcUrl('store/project.ts'));
  const load = () => actions.loadProject({ version: 1, id: 'p-tr', name: 't', width: 1280, height: 720, fps: 30, duration: 30, themeId: 'midnight',
    media: [{ id: 'v1', kind: 'video', name: 'v.mp4', url: '/@media/v1.mp4', duration: 60 }],
    tracks: [
      { id: 'ta', name: '序列 1', clips: [{ id: 'a', cardId: '', mediaId: 'v1', start: 0, end: 4, fadeIn: 0.5, fadeOut: 1, params: {} }, { id: 'c', cardId: '', mediaId: 'v1', start: 9, end: 12, params: {} }] },
      { id: 'tb', name: '序列 2', clips: [{ id: 'b', cardId: '', mediaId: 'v1', start: 3, end: 7, fadeIn: 1, params: {} }, { id: 'd', cardId: '', mediaId: 'v1', start: 8, end: 10, params: {} }] },
    ],
    transitions: [{ id: 'x', kind: 'crossfade', aId: 'a', bId: 'b', dur: 1 }, { id: 'f', kind: 'fadeIn', aId: 'a', dur: 0.5 }] });
  const clip = (id) => getState().project.tracks.flatMap((t) => t.clips).find((x) => x.id === id);
  const span = (id) => [clip(id).start, clip(id).end];

  // 前一段 a 变短(4 → 2 秒):b 跟着前移 2 秒,重叠还是 1 秒;别的不动(尾部留空)
  load();
  let r = actions.setClipSpeed('a', 2);
  assert.deepEqual(r, { ok: true, moved: ['b'] });
  assert.deepEqual([span('a'), span('b'), span('c'), span('d')], [[0, 2], [1, 5], [9, 12], [8, 10]]);
  assert.deepEqual([clip('a').fadeIn, clip('a').fadeOut, clip('b').fadeIn], [0.5, 1, 1], '转场时长不变');
  actions.undo();
  assert.deepEqual([span('a'), span('b')], [[0, 4], [3, 7]], '一步撤销');

  // 前一段 a 变长(4 → 8 秒):b 后移 4 秒到 7～11,撞上同序列的 d(8 起)→ d 推开;a 自己的序列上 c(9 起)和 a 新终点 8 不重合,不动
  load();
  r = actions.setClipSpeed('a', 0.5);
  assert.equal(r.ok, true);
  assert.deepEqual([span('a'), span('b'), span('d'), span('c')], [[0, 8], [7, 11], [11, 13], [9, 12]]);
  actions.undo();
  assert.deepEqual([span('a'), span('b'), span('d')], [[0, 4], [3, 7], [8, 10]], '一步撤销全退回');

  // 后一段 b 变速:起点不动,a 不动
  load();
  r = actions.setClipSpeed('b', 2);
  assert.deepEqual(r, { ok: true });
  assert.deepEqual([span('a'), span('b')], [[0, 4], [3, 5]]);

  // 装不下转场(用户 2026-10-23 定「气泡提示即可」):a 改 4 倍只剩 1 秒,1 秒的交叉溶解缩到 0.99 秒,结果里说清楚;b 跟着挪,重叠 = 0.99
  load();
  r = actions.setClipSpeed('a', 4);
  assert.equal(r.ok, true);
  assert.deepEqual(r.transitions, [{ kind: 'crossfade', from: 1, to: 0.99 }]);
  assert.deepEqual(span('a'), [0, 1]);
  const near = (x, y) => Math.abs(x - y) < 1e-9;
  assert.ok(near(clip('b').start, 0.01) && near(clip('b').end, 4.01), `b 挪到 0.01～4.01,实得 ${span('b')}`);
  assert.deepEqual([clip('a').fadeOut, clip('b').fadeIn, clip('a').fadeIn], [0.99, 0.99, 0.5], '两头淡化跟着改,0.5 秒的淡入装得下不动');
  assert.equal(getState().project.transitions.find((t) => t.id === 'x').dur, 0.99);
  const { speedChangeNotes } = await import('../../src/kernel/clipTime.mjs');
  assert.match(speedChangeNotes(r, 'a'), /交叉溶解跟着缩短：1\.00 秒 → 0\.99 秒/);
  actions.undo();
  assert.deepEqual([span('a'), span('b'), clip('a').fadeOut, getState().project.transitions.find((t) => t.id === 'x').dur], [[0, 4], [3, 7], 1, 1], '一步撤销,转场也回来');

  // 后一段 b 改 4 倍只剩 1 秒:溶解缩到 0.99,靠 b 整段往后挪 0.01 秒(入点内容不变)
  load();
  r = actions.setClipSpeed('b', 4);
  assert.equal(r.ok, true);
  assert.deepEqual(r.moved, ['b']);
  assert.ok(near(clip('b').start, 3.01) && near(clip('b').end, 4.01), `b 到 3.01～4.01,实得 ${span('b')}`);
  assert.equal(clip('a').end - clip('b').start < 0.99 + 1e-9 && clip('a').end - clip('b').start > 0.99 - 1e-9, true, '重叠 0.99');
});

test('声音段变速(音画分离出来的):照常出声,两条混音路和测响度都用同一份 ffmpegVarispeed', () => {
  const p = withClip({ ...fixture(), media: [...fixture().media, { id: 's1', kind: 'audio', url: '/@media/v1.mp4', soundOf: 'v1', duration: 20 }],
    tracks: [...fixture().tracks, { id: 't5', name: '声音', clips: [{ id: 's', cardId: '', mediaId: 's1', mediaOffset: 1, start: 0, end: 2, speed: 2, params: {} }] }] }, 'v-plain', { speed: 2 });
  const plan = audioPlanOf(p);
  const e = plan.find((x) => x.clipId === 's');
  assert.deepEqual([e.start, e.dur, e.offset, e.speed], [0, 2, 1, 2], '声音段在清单里,带速度');
  assert.equal(plan.some((x) => x.clipId === 'v-plain'), false, '视频段自己不出原声');
  assert.equal(plan.filter((x) => x.clipId !== 's').every((x) => !('speed' in x)), true, '别的条目不带 speed');
  assert.deepEqual(ffmpegVarispeed(2), ['aresample=48000', 'asetrate=96000', 'aresample=48000']);
  assert.deepEqual(ffmpegVarispeed(1), []);
  const files = buildAudioPlan(p, 'out', () => true, (m) => `/x/${m.id}`);
  const f = files.find((x) => x.clipId === 's');
  const args = buildFfmpegArgs('v.mp4', [f], 'o.mp4', 4);
  const i = args.indexOf('/x/s1');
  assert.deepEqual(args.slice(i - 5, i + 1), ['-ss', '1', '-t', '4', '-i', '/x/s1'], 'ffmpeg 那条路读 2 秒 × 2 倍素材');
  assert.match(args[args.indexOf('-filter_complex') + 1], /\[1:a\]aresample=48000,asetrate=96000,aresample=48000,adelay=0:all=1/);
  // 导出时两条混音路都从 playableAudioPlan 做好的那一份 wav 起(Chrome 那一路的裁段在 audio-mix.mjs,它进快照键的代码指纹,不改它)
  const rendered = [];
  const ready = playableAudioPlan(files, 'C:/ff/ffprobe.exe', () => true, (entry, ffmpegCmd) => { rendered.push([entry.clipId, entry.offset, entry.dur, entry.speed, ffmpegCmd]); return `/tmp/${entry.clipId}.wav`; });
  assert.deepEqual(rendered, [['s', 1, 2, 2, 'C:/ff/ffmpeg.exe']], '只有变速的声音段先做成 wav');
  const r2 = ready.find((x) => x.clipId === 's');
  assert.deepEqual([r2.file, r2.offset, r2.dur, 'speed' in r2, 'renderDir' in r2], ['/tmp/s.wav', 0, 2, false, false], '换成做好的 wav,从 0 读 dur 秒,不再带 speed');
  assert.deepEqual(ready.filter((x) => x.clipId !== 's'), files.filter((x) => x.clipId !== 's'), '别的条目原样');
  const m = timelineMixParts([{ ...f, file: '/x/s1' }], 4);
  assert.deepEqual(m.inputs, ['-ss', '1', '-t', '4', '-i', '/x/s1'], '测响度同一份');
  assert.match(m.filters[0], /aresample=48000,asetrate=96000,aresample=48000,adelay/);
});

/* ---------- 变速的视频段当音频素材效果卡的声音输入(2026-10-23 用户定「放开。」) ---------- */

test('变速的视频段上挂的音频素材效果卡:导出清单照收(原声仍不出);卡片声音的身份 1 倍逐字不变、变速时带上倍率', async () => {
  const withAudioCard = (speed) => {
    const p = fixture();
    p.cardNodes = [...p.cardNodes, { id: 'au', adapter: 'card', cardId: 'gain', kind: 'audio', params: {}, inputs: { source: { nodeId: '@clip/v-plain/source' } } }];
    return withClip(p, 'v-plain', { nodeId: 'au', ...(speed === 1 ? {} : { speed }) });
  };
  for (const speed of [1, 2]) {
    const plan = buildAudioPlan(withAudioCard(speed), 'out', () => true, () => '/media/v1.mp4');
    assert.equal(plan.filter((e) => e.clipId === 'v-plain' && !e.cardAudio).length, 0, '原声由卡接管(1 倍)/不出原声(变速),都不单独进清单');
    const card = plan.filter((e) => e.cardAudio && e.clipId === 'v-plain');
    assert.equal(card.length, 1, `${speed} 倍:音频素材效果卡那一条在清单里`);
    assert.equal(card[0].nodeId, 'au');
  }
  const { cardAudioIdentity } = await import('../../src/kernel/cardAudioRendition.mjs');
  // 另一张声画卡读变速段当输入:身份里输入素材那一项
  const hooks = { getCard: () => ({ defaults: {} }), sourceVersionOf: () => 'v1' };
  const owner = { id: 'own', cardId: 'av', nodeId: 'avn', start: 0, end: 1 };
  const projectWith = (speed) => {
    const p = withAudioCard(speed);
    p.cardNodes = [...p.cardNodes, { id: 'avn', adapter: 'card', cardId: 'av', inputs: { source: { nodeId: '@clip/v-plain/source' } } }];
    p.tracks = [...p.tracks, { id: 't4', clips: [owner] }];
    return p;
  };
  const plain = cardAudioIdentity(projectWith(1), owner, hooks).inputs.source;
  assert.deepEqual(plain, { media: 'h-v1', offset: 1.5, rate: 1 }, '1 倍:和以前逐字相同,没有 speed 一项');
  assert.deepEqual(cardAudioIdentity(projectWith(2), owner, hooks).inputs.source, { ...plain, speed: 2 });
});

/* ---------- 变速段上的声画一体卡照常出声(2026-10-23 用户定「出声。」,推翻〔裁〕V21-28) ---------- */

const AV_WAV = { id: 'wav', kind: 'audio', url: `/@media/${'c'.repeat(64)}`, hash: 'c'.repeat(64) };
const AV_HOOKS = { getCard: (id) => (id === 'av' ? { defaults: {} } : DEFS[id]), sourceVersionOf: () => 'v1' };
/** v-plain(mediaOffset 1.5,0～4 秒)上挂一张声画一体卡(节点 avn,读自己这段素材),带一份按当时源时钟生成、覆盖整段的声音 */
async function withAvCard(speed) {
  const { cardAudioIdentity, cardAudioSourceOffset } = await import('../../src/kernel/cardAudioRendition.mjs');
  const p0 = fixture();
  p0.media = [...p0.media, AV_WAV];
  p0.cardNodes = [...p0.cardNodes, { id: 'avn', adapter: 'card', cardId: 'av', kind: 'animation', embeddedAudio: true, params: {}, inputs: { source: { nodeId: '@clip/v-plain/source' } } }];
  const p = withClip(p0, 'v-plain', { cardId: 'av', nodeId: 'avn', embeddedAudio: true, ...(speed === 1 ? {} : { speed }) });
  const clip = p.tracks[1].clips[0];
  const cardAudio = { version: 1, cardId: 'av', mediaId: 'wav', sampleRate: 48000, frames: 4 * 48000, channels: 2,
    sourceOffset: cardAudioSourceOffset(p, clip), identity: cardAudioIdentity(p, clip, AV_HOOKS) };
  return withClip(p, 'v-plain', { cardAudio });
}

test('导出混音清单:变速段上的声画一体卡照常进清单(已生成的 WAV 照 1 倍摆位,不带 speed);普通变速视频段仍不出原声', async () => {
  const one = audioPlanOf(await withAvCard(1));
  const av1 = one.find((e) => e.clipId === 'v-plain');
  assert.deepEqual(av1, { clipId: 'v-plain', trackId: 't2', mediaId: 'wav', start: 0, dur: 4, offset: 0, volume: 1, fadeIn: 0, fadeOut: 0, fx: null }, '1 倍:和以前同一条');
  for (const speed of [2, 0.5]) {
    const plan = audioPlanOf(await withAvCard(speed));
    assert.deepEqual(plan.find((e) => e.clipId === 'v-plain'), av1, `${speed} 倍:同样一条(WAV 已是时间轴长度,不再变速)`);
    assert.deepEqual(plan.filter((e) => e.clipId !== 'v-plain'), one.filter((e) => e.clipId !== 'v-plain'), '别的条目不变');
    // ffmpeg 那条老路(mux-audio)用同一份清单
    assert.ok(buildAudioPlan(await withAvCard(speed), 'out', () => true, (m) => `/x/${m.id}`).some((e) => e.clipId === 'v-plain' && !e.speed));
  }
  // 没挂卡的变速视频段照旧不出原声(〔裁〕第一版)
  assert.equal(audioPlanOf(withClip(fixture(), 'v-plain', { speed: 2 })).some((e) => e.clipId === 'v-plain'), false);
});

test('声画一体卡的卡片时钟(cardClockOffset / withMediaRates / flattenOverlay):1 倍逐位不变;变速段 = mediaOffset ÷ 倍率,读素材的边补同样的差', async () => {
  const { cardClockOffset } = await import('../../src/kernel/clipTime.mjs');
  const { cardAudioSourceOffset } = await import('../../src/kernel/cardAudioRendition.mjs');
  const { flattenOverlay } = await import(srcUrl('kernel/project.ts'));
  assert.equal(cardClockOffset({ mediaOffset: 0.1 + 0.2 }), 0.1 + 0.2, '1 倍:原值');
  assert.equal(cardClockOffset({ mediaOffset: 3, speed: 2 }), 1.5);
  assert.equal(cardClockOffset({ speed: 2 }), undefined, 'mediaOffset 没写:交给调用方退到节点 timeOffset');
  const one = await withAvCard(1);
  const raw1 = projectCardGraph(one, (id) => AV_HOOKS.getCard(id));
  assert.equal(withMediaRates(one, raw1), raw1, '1 倍:同一个对象');
  assert.equal(flattenOverlay(one).clips.find((c) => c.id === 'v-plain').sourceOffset, 1.5);
  for (const speed of [2, 0.5]) {
    const p = await withAvCard(speed);
    const raw = projectCardGraph(p, (id) => AV_HOOKS.getCard(id));
    const before = raw.nodes.find((n) => n.id === 'avn'), after = withMediaRates(p, raw).nodes.find((n) => n.id === 'avn');
    assert.equal(before.timeOffset, 1.5, 'projectCardGraph 写的是 mediaOffset(素材秒)');
    assert.equal(after.timeOffset, 1.5 / speed, `${speed} 倍:卡片时钟 = mediaOffset ÷ 倍率`);
    // 读自己素材的位置不变:卡片时刻 + 边的偏移 一样
    assert.ok(Math.abs((after.timeOffset + after.inputs.source.offset) - (before.timeOffset + before.inputs.source.offset)) < 1e-12);
    const clip = p.tracks[1].clips[0];
    assert.equal(cardAudioSourceOffset(p, clip), 1.5 / speed, '已生成声音的源时钟同一个口径');
    assert.equal(flattenOverlay(p).clips.find((c) => c.id === 'v-plain').sourceOffset, 1.5 / speed, '舞台给卡片组件的 t 同一个口径');
  }
});

test('store.splitClip:变速段上的声画一体卡切开后,两半的卡片时钟接得上,已生成的声音两半都还覆盖、不判过期', async () => {
  const { actions, getState } = await import(srcUrl('store/project.ts'));
  const { flattenOverlay } = await import(srcUrl('kernel/project.ts'));
  const { resolveCardAudioRendition } = await import('../../src/kernel/cardAudioRendition.mjs');
  for (const speed of [2, 0.5]) {
    const p = await withAvCard(speed);
    actions.loadProject({ version: 1, name: 't', ...p });
    const right = actions.splitClip('v-plain', 1.5);
    assert.ok(right, `${speed} 倍:切得开`);
    const q = getState().project;
    const left = q.tracks[1].clips.find((c) => c.id === 'v-plain');
    assert.equal(right.mediaOffset, 1.5 + 1.5 * speed, '后半段的素材起点按倍率推进');
    const flat = flattenOverlay(q).clips;
    const clockAt = (c, local) => flat.find((x) => x.id === c.id).sourceOffset + local;
    assert.ok(Math.abs(clockAt(right, 0) - clockAt(left, 1.5)) < 1e-9, `${speed} 倍:切点两侧卡片时钟相同(以前后半段会跳 ${1.5 * (speed - 1)} 秒)`);
    const graph = withMediaRates(q, projectCardGraph(q, (id) => AV_HOOKS.getCard(id)));
    assert.ok(Math.abs(graph.nodes.find((n) => n.id === right.nodeId).timeOffset - clockAt(left, 1.5)) < 1e-9, '画面、声音拿的图同一个时钟');
    assert.equal(resolveCardAudioRendition(q, left, AV_HOOKS).offset, 0);
    assert.ok(Math.abs(resolveCardAudioRendition(q, right, AV_HOOKS).offset - 1.5) < 1e-9, '后半段从 WAV 第 1.5 秒放');
  }
});
