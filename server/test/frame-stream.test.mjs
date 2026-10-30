/**
 * R8 轨道流服务端的纯函数单测(`server/frame-stream.mjs`、`frame-playback.mjs` 的排程、
 * `card-identity.mjs` 的流键、`bakery/ffmpeg.mjs` 的命令行)。端到端那一半在
 * `scripts/probes/stream-produce-probe.mjs` / `stream-play-probe.mjs`。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import {
  splitFmp4, segmentInfo, initInfo, codecOfAvcC, topLevelBoxes, evenRect, intersectRect, unionRect, padRect,
  groupStreams, peakConcurrency, paintLayers, planStreams, queueStreamOf, streamNeedsReplay, isolatedStreamProject, localPlacement, streamEligible,
  pngAlphaBox, segmentSignature, readySegmentRanges, publicManifest, StreamStore, handleStreamRequest,
  streamsEnabled, streamDecoderBudget, streamPoolLimit, SEGMENT_FRAMES, StreamProducer,
} from '../frame-stream.mjs';
import { planStreamSegments, streamFeasibility, streamFirstMs } from '../frame-playback.mjs';
import { cardStreamIdentity } from '../card-identity.mjs';
import { streamSegmentArgs, streamFilter, STREAM_ENCODERS, STREAM_ENCODER_ORDER, streamEncoderPreference } from '../bakery/ffmpeg.mjs';
import { createReadyHub } from '../ready-index.mjs';

/* ------------------------------------------------------------ fMP4 合成件 */

const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const box = (type, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([u32(8 + body.length), Buffer.from(type, 'latin1'), body]); };
const full = (version, flags) => u32(((version & 0xff) << 24) | (flags & 0xffffff));

/** 一份最小的 init:ftyp + moov/trak/mdia/(mdhd, minf/stbl/stsd/avc1/avcC) */
function makeInit({ width = 640, height = 736, level = 0x32 } = {}) {
  const avcC = box('avcC', Buffer.from([1, 0x64, 0x00, level, 0xff, 0xe1, 0x00, 0x00, 0x01, 0x00, 0x00]));
  const entry = Buffer.alloc(78);
  entry.writeUInt16BE(1, 6);            // data_reference_index
  entry.writeUInt16BE(width, 24);
  entry.writeUInt16BE(height, 26);
  const avc1 = box('avc1', entry, avcC);
  const stsd = box('stsd', full(0, 0), u32(1), avc1);
  const mdhd = box('mdhd', full(0, 0), u32(0), u32(0), u32(30), u32(0), u32(0));
  const moov = box('moov', box('trak', box('mdia', mdhd, box('minf', box('stbl', stsd)))));
  return Buffer.concat([box('ftyp', Buffer.from('isom'), u32(512)), moov]);
}

/** 一个分段:moof(tfhd 带 default-base-is-moof + 缺省 flags = 非同步样本;trun 带 data_offset + first_sample_flags + 逐样本大小)+ mdat */
function makeSegment(sizes = [10, 4, 4], { firstSync = true } = {}) {
  const tfhd = box('tfhd', full(0, 0x020020), u32(1), u32(0x01010000));
  const trunBody = (dataOffset) => Buffer.concat([full(0, 0x000205), u32(sizes.length), u32(dataOffset), u32(firstSync ? 0x02000000 : 0x01010000), ...sizes.map(u32)]);
  // moof 的尺寸要先算出来才能写 data_offset:两遍
  const probe = box('moof', box('traf', tfhd, box('trun', trunBody(0))));
  const moof = box('moof', box('traf', tfhd, box('trun', trunBody(probe.length + 8))));
  const mdat = box('mdat', Buffer.concat(sizes.map((n, i) => Buffer.alloc(n, i + 1))));
  return Buffer.concat([moof, mdat]);
}

test('splitFmp4: ftyp+moov is the init, each moof+mdat a segment, mfra is dropped', () => {
  const init = makeInit();
  const seg = makeSegment();
  const out = splitFmp4(Buffer.concat([init, seg, box('mfra', Buffer.alloc(8))]));
  assert.deepEqual(out.init, init);
  assert.equal(out.segments.length, 1);
  assert.deepEqual(out.segments[0], seg);
  assert.deepEqual(out.dropped, ['mfra']);
  assert.deepEqual(topLevelBoxes(out.segments[0]).map(b => b.type), ['moof', 'mdat']);
});

test('segmentInfo / initInfo read the sample count, the first-sample sync flag and the codec from avcC', () => {
  const info = segmentInfo(makeSegment([5, 5, 5, 5]));
  assert.deepEqual(info, { moofs: 1, sampleCount: 4, firstSampleIsSync: true });
  assert.equal(segmentInfo(makeSegment([5], { firstSync: false })).firstSampleIsSync, false);
  const meta = initInfo(makeInit({ width: 560, height: 764, level: 0x1f }));
  assert.deepEqual(meta, { codec: 'avc1.64001f', width: 560, height: 764, timescale: 30 });
  // G5:level 随内容变 —— 串一定从 avcC 拼,不写死
  assert.equal(codecOfAvcC(Buffer.from([1, 0x64, 0, 0x33])), 'avc1.640033');
});

/* ------------------------------------------------------------ 矩形 */

test('evenRect rounds out to even width and height inside the limit (yuv420p)', () => {
  const view = { x: 0, y: 0, w: 1920, h: 1080 };
  assert.deepEqual(evenRect({ x: 10.4, y: 3.2, w: 101, h: 51 }, view), { x: 10, y: 3, w: 102, h: 52 });
  // 碰到右 / 下边就往左 / 上扩
  assert.deepEqual(evenRect({ x: 1919, y: 1079, w: 1, h: 1 }, view), { x: 1918, y: 1078, w: 2, h: 2 });
  const r = evenRect({ x: -5, y: -5, w: 3000, h: 3000 }, view);
  assert.deepEqual(r, view);
  for (const v of [r.w, r.h]) assert.equal(v % 2, 0);
});

test('rect helpers', () => {
  assert.deepEqual(intersectRect({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 }), { x: 5, y: 5, w: 5, h: 5 });
  assert.deepEqual(unionRect(null, { x: 1, y: 2, w: 3, h: 4 }), { x: 1, y: 2, w: 3, h: 4 });
  assert.deepEqual(unionRect({ x: 0, y: 0, w: 2, h: 2 }, { x: 5, y: 5, w: 1, h: 1 }), { x: 0, y: 0, w: 6, h: 6 });
  assert.deepEqual(padRect({ x: 10, y: 10, w: 4, h: 4 }, 2), { x: 8, y: 8, w: 8, h: 8 });
});

test('localPlacement: a small frame is centred in the capture page, the bound leaves room for overflow and is even', () => {
  const stage = { width: 1920, height: 1080 };
  const p = localPlacement({ frame: { x: 0, y: 0, w: 641, h: 361 } }, stage);
  assert.deepEqual(p.box, { w: 641, h: 361 });
  assert.deepEqual(p.offset, { x: 639, y: 359 });
  assert.equal(p.bound.w % 2, 0);
  assert.equal(p.bound.h % 2, 0);
  assert.ok(p.bound.x <= -32 + 1 && p.bound.y <= -32 + 1);
  // 全屏卡(没有框):贴左上角,上界就是整个画面
  const fullStage = localPlacement({}, stage);
  assert.deepEqual(fullStage.offset, { x: 0, y: 0 });
  assert.deepEqual(fullStage.bound, { x: 0, y: 0, w: 1920, h: 1080 });
});

/* ------------------------------------------------------------ 实测实体框 */

function pngOf(width, height, paint) {
  const png = new PNG({ width, height });
  png.data.fill(0);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const a = paint(x, y);
    if (a) { const i = (y * width + x) * 4; png.data[i] = 255; png.data[i + 3] = a; }
  }
  return PNG.sync.write(png, { filterType: -1 });
}

test('pngAlphaBox finds the box of alpha > 0 (faint glow included), null for a fully transparent frame', () => {
  const buf = pngOf(64, 40, (x, y) => (x >= 10 && x < 20 && y >= 5 && y < 8 ? 255 : x === 50 && y === 30 ? 1 : 0));
  assert.deepEqual(pngAlphaBox(buf), { x: 10, y: 5, w: 41, h: 26 });
  assert.equal(pngAlphaBox(pngOf(16, 16, () => 0)), null);
  assert.deepEqual(pngAlphaBox(Buffer.from('not a png')), { full: true });
});

/* ------------------------------------------------------------ 划分 */

const CAPS = { compositing: 'independent', frameMode: 'stateful' };
// 契约 E.4:planStreams 没有环境指纹就不产流(M4)。下面各处只补这一项输入,断言不变。
const ENV_FP = '0123456789abcdef';
const control = (clipId, start, end, fps = 30, extra = {}) => ({
  clipId, key: `K-${clipId}`, snapshotKey: `S-${clipId}`, capabilities: CAPS, compositing: 'independent',
  start, end, count: Math.ceil((end - start) * fps), sampling: { firstFrame: Math.ceil(start * fps), fps: { numerator: String(fps), denominator: '1' }, phase: { numerator: '0', denominator: '1' } },
  ...extra,
});

test('streamEligible: only independent cards on visible tracks without a 3-D frame', () => {
  const track = { hidden: false };
  const clip = { id: 'a', cardId: 'x' };
  assert.equal(streamEligible(control('a', 0, 1), clip, track), true);
  assert.equal(streamEligible({ ...control('a', 0, 1), capabilities: { compositing: 'belowDependent' } }, clip, track), false);
  assert.equal(streamEligible({ ...control('a', 0, 1), capabilities: { compositing: 'unknown' } }, clip, track), false);
  assert.equal(streamEligible({ ...control('a', 0, 1), capabilities: { compositing: 'sourceDependent' } }, clip, track), false);
  assert.equal(streamEligible(control('a', 0, 1), clip, { hidden: true }), false);
  assert.equal(streamEligible(control('a', 0, 1), { ...clip, frame: { x: 0, y: 0, rotateY: 20 } }, track), false);
  assert.equal(streamEligible(control('a', 0, 1), { id: 'a', mediaId: 'm' }, track), false);
});

test('peakConcurrency / groupStreams merge only z-adjacent streams, and only while over budget', () => {
  assert.deepEqual(peakConcurrency([{ from: 0, to: 9 }, { from: 5, to: 20 }, { from: 21, to: 30 }]), { peak: 2, at: 5 });
  const layers = [
    { clipId: 'a', order: 1, from: 0, to: 99 },
    { clipId: 'b', order: 2, from: 0, to: 99 },
    { clipId: 'm', order: 3, from: 0, to: 99 }, // 素材层插在 b 和 c 中间
    { clipId: 'c', order: 4, from: 0, to: 99 },
  ];
  const streams = ['a', 'b', 'c'].map((id) => ({ clipIds: [id], order: layers.find(l => l.clipId === id).order, from: 0, to: 99 }));
  assert.equal(groupStreams(streams, layers, 6).length, 3, '没超预算不合并');
  const merged = groupStreams(streams, layers, 2);
  assert.deepEqual(merged.map(s => s.clipIds), [['a', 'b'], ['c']], 'b 和 c 之间隔着素材层,只能合 a+b');
  // 已经合不动(隔着别的层)就停,不死循环
  assert.equal(groupStreams(streams, layers, 1).length, 2);
});

function project(tracks, extra = {}) {
  return { width: 1920, height: 1080, fps: 30, duration: 4, media: [], tracks, ...extra };
}

test('planStreams: one stream per eligible card, segments counted from the stream\'s own first frame, local plane with offset; group when over budget', () => {
  const p = project([
    { id: 't1', clips: [{ id: 'a', cardId: 'x', start: 0.5, end: 2, frame: { x: 0, y: 0, w: 640, h: 360 } }] },
    { id: 't2', clips: [{ id: 'b', cardId: 'y', start: 0, end: 4 }] },
  ]);
  const entry = { key: 'E', project: p, cardPlan: [control('a', 0.5, 2), control('b', 0, 4)] };
  const specs = planStreams(entry, { envFingerprint: ENV_FP });
  assert.equal(specs.length, 2);
  const a = specs.find(s => s.clipIds[0] === 'a');
  assert.equal(a.kind, 'card');
  assert.equal(a.plane, 'local');
  assert.equal(a.firstFrame, 15);
  // 分段从这条流自己的第一帧起数:第一帧是片段的第一帧(15),第 0 段是第 15～29 帧;最后一帧 59 落在第 2 段
  assert.equal(a.originFrame, 15);
  assert.equal(a.firstSegment, 0);
  assert.equal(a.lastFrame, 59);
  assert.equal(a.lastSegment, Math.floor((59 - 15) / SEGMENT_FRAMES));
  const b = specs.find(s => s.clipIds[0] === 'b');
  assert.deepEqual([b.originFrame, b.firstSegment, b.lastSegment], [0, 0, 7]);
  assert.deepEqual(a.offset, { x: 640, y: 360 });
  assert.equal(a.mountFrame, 14, '挂载帧含 LEAD');
  // 预渲染集合之外的卡不产流(pinned 渲染 9)
  assert.equal(planStreams(entry, { picked: id => id === 'b', envFingerprint: ENV_FP }).length, 1);
  // 超预算:合成一条组流,舞台坐标,最上面那张在最后
  const grouped = planStreams(entry, { budget: 1, envFingerprint: ENV_FP });
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].kind, 'group');
  assert.equal(grouped[0].plane, 'stage');
  assert.deepEqual(grouped[0].clipIds, ['b', 'a'], '画家顺序:t2 在下面,t1 在最上面');
  assert.equal(grouped[0].topClipId, 'a');
  assert.deepEqual(grouped[0].bound, { x: 0, y: 0, w: 1920, h: 1080 });
  // 组流的第一帧是成员里最早的那个第一帧(b 的第 0 帧),最后一帧是成员里最晚的(b 的第 119 帧)
  assert.deepEqual([grouped[0].originFrame, grouped[0].firstSegment, grouped[0].lastSegment], [0, 0, 7]);
});

test('planStreams: 片段不从 15 的倍数帧开始、时长不是 15 的倍数 —— 分段照样从它自己的第一帧起,末段不满', () => {
  // 第 100 帧开始(100 / 30 秒),共 50 帧:第 100～149 帧。第 0 段 100～114、第 1 段 115～129、第 2 段 130～144、第 3 段 145～149(5 帧)
  const start = 100 / 30, end = 150 / 30;
  const p = project([
    { id: 't1', clips: [{ id: 'a', cardId: 'x', start, end }] },
    { id: 't2', clips: [{ id: 'b', cardId: 'y', start: 40 / 30, end: 130 / 30 }] },
  ], { duration: 6 });
  const entry = { key: 'E', project: p, cardPlan: [control('a', start, end), control('b', 40 / 30, 130 / 30)] };
  const a = planStreams(entry, { envFingerprint: ENV_FP }).find(s => s.clipIds[0] === 'a');
  assert.deepEqual([a.firstFrame, a.lastFrame, a.originFrame, a.firstSegment, a.lastSegment], [100, 149, 100, 0, 3]);
  // 交给切分的那一份带着第一帧
  assert.deepEqual([queueStreamOf(a).originFrame, queueStreamOf(a).firstSegment, queueStreamOf(a).lastSegment], [100, 0, 3]);
  // 组流:盖住 40～149,第一帧是 40
  const g = planStreams(entry, { budget: 1, envFingerprint: ENV_FP })[0];
  assert.equal(g.kind, 'group');
  assert.deepEqual([g.firstFrame, g.lastFrame, g.originFrame, g.firstSegment, g.lastSegment], [40, 149, 40, 0, Math.floor((149 - 40) / SEGMENT_FRAMES)]);
});

test('stream keys: placement-free for single-card streams, with time placement; group keys use the appearance key', () => {
  const p = project([{ id: 't1', clips: [{ id: 'a', cardId: 'x', start: 0, end: 2 }] }]);
  const key = (ctl, budget = 6) => planStreams({ key: 'E', project: p, cardPlan: [ctl] }, { budget, envFingerprint: ENV_FP })[0]?.streamKey;
  const base = control('a', 0, 2);
  assert.equal(key(base), key({ ...base, key: 'K-moved-elsewhere' }), '单卡流不看带外观的缓存键(挪位置不作废流)');
  assert.notEqual(key(base), key({ ...base, snapshotKey: 'S-other-params' }), '内容变了就换流键');
  assert.notEqual(key(base), key({ ...base, sampling: { ...base.sampling, firstFrame: 1 } }), '入点挪了一帧就换流键(片段在时间轴上的位置仍在键里;「挪动以后流不失效」记了待办,这次不做)');
  const a = cardStreamIdentity({ kind: 'card', fps: 30, stage: { width: 1920, height: 1080 }, members: [{ key: 'S', sampling: base.sampling, count: 60 }], codeVersion: '1' });
  assert.notEqual(a, cardStreamIdentity({ kind: 'card', fps: 30, stage: { width: 1920, height: 1080 }, members: [{ key: 'S', sampling: base.sampling, count: 60 }], codeVersion: '2' }), '生产代码换了旧流作废');
  assert.notEqual(a, cardStreamIdentity({ kind: 'card', fps: 25, stage: { width: 1920, height: 1080 }, members: [{ key: 'S', sampling: base.sampling, count: 60 }], codeVersion: '1' }), 'fps 进键');
});

test('不回放:全部成员都是 remotion 式(direct)的流不要从挂载帧回放;有一张 motion 式、或写法没带的流照旧回放;replay 不进任何键', () => {
  const DIRECT = { compositing: 'independent', frameMode: 'direct' };
  const direct = (clipId, start, end, extra = {}) => control(clipId, start, end, 30, { frameMode: 'direct', capabilities: DIRECT, ...extra });
  const stateful = (clipId, start, end, extra = {}) => control(clipId, start, end, 30, { frameMode: 'stateful', ...extra });
  assert.equal(streamNeedsReplay([direct('a', 0, 1)]), false);
  assert.equal(streamNeedsReplay([stateful('a', 0, 1)]), true);
  assert.equal(streamNeedsReplay([direct('a', 0, 1), stateful('b', 0, 1)]), true, '组里有一张 motion 式的就要');
  assert.equal(streamNeedsReplay([direct('a', 0, 1), direct('b', 0, 1)]), false);
  assert.equal(streamNeedsReplay([control('a', 0, 1)]), true, '顶层没有 frameMode、capabilities 里是 stateful:要');
  assert.equal(streamNeedsReplay([{ ...control('a', 0, 1), capabilities: { compositing: 'independent' } }]), true, '写法没带:保守,要');
  assert.equal(streamNeedsReplay([direct('a', 0, 1, { capabilities: { ...DIRECT, need_prerendering: true } })]), true, '声明了 need_prerendering:要');
  assert.equal(streamNeedsReplay([direct('a', 0, 1, { needPrerendering: true })]), true);
  assert.equal(streamNeedsReplay([]), true);
  // capabilities 里才有写法(旧形状的输入)也认
  assert.equal(streamNeedsReplay([{ ...control('a', 0, 1), capabilities: DIRECT }]), false);

  const p = project([
    { id: 't1', clips: [{ id: 'a', cardId: 'x', start: 0.5, end: 2 }] },
    { id: 't2', clips: [{ id: 'b', cardId: 'y', start: 0, end: 4 }] },
    { id: 't3', clips: [{ id: 'c', cardId: 'z', start: 1, end: 3 }] },
  ]);
  const plan = [direct('a', 0.5, 2), stateful('b', 0, 4), direct('c', 1, 3)];
  const specs = planStreams({ key: 'E', project: p, cardPlan: plan }, { envFingerprint: ENV_FP });
  const by = id => specs.find(s => s.clipIds[0] === id);
  assert.equal(by('a').replay, false);
  assert.equal(by('b').replay, true);
  assert.equal(by('c').replay, false);
  // 组流:a+c 都是 direct、紧挨着(t1、t3 中间隔着 t2 的 b → 不能合并)。预算压到 1 时只能合相邻的;看合出来的组
  const grouped = planStreams({ key: 'E', project: p, cardPlan: plan }, { budget: 1, envFingerprint: ENV_FP });
  for (const g of grouped) assert.equal(g.replay, g.members.some(m => m.frameMode !== 'direct'), `组 ${g.clipIds}:成员里有 motion 式的才要回放`);
  assert.ok(grouped.some(g => g.kind === 'group'));
  // 键不变:同一份计划把写法改成 stateful 以外的任何值,流键相同(replay 不进键)
  const flipped = plan.map(c => ({ ...c, frameMode: c.frameMode === 'direct' ? 'stateful' : 'direct' }));
  const keysOf = list => planStreams({ key: 'E', project: p, cardPlan: list }, { envFingerprint: ENV_FP }).map(s => `${s.clipIds}:${s.streamKey}`).sort();
  assert.deepEqual(keysOf(plan), keysOf(flipped), '写法不进流键(键里的内容身份已经带着卡的声明)');
});

test('isolatedStreamProject: only the stream cards paint, other clips stay as hidden sources, time is not shifted; local plane strips the wrapper appearance', () => {
  const p = project([
    { id: 't1', clips: [
      { id: 'a', cardId: 'x', start: 0.5, end: 2, frame: { x: 960, y: 540, w: 640, h: 360, anchor: [0.5, 0.5], scale: 2, rotate: 30 }, motion: { target: 'q' }, opacity: 0.5, fadeIn: 0.2, emphasis: { shadow: 1 } },
      { id: 'sib', cardId: 'z', start: 0, end: 1 },
    ] },
    { id: 't2', clips: [{ id: 'b', cardId: 'y', start: 0, end: 4 }] },
  ]);
  const spec = planStreams({ key: 'E', project: p, cardPlan: [control('a', 0.5, 2)] }, { envFingerprint: ENV_FP })[0];
  const iso = isolatedStreamProject(p, spec);
  const visible = iso.tracks.filter(t => !t.hidden);
  assert.equal(visible.length, 1);
  assert.deepEqual(visible[0].clips.map(c => c.id), ['a']);
  const a = visible[0].clips[0];
  assert.equal(a.start, 0.5, '时间不平移');
  assert.deepEqual(a.frame, { x: spec.offset.x, y: spec.offset.y, w: 640, h: 360, anchor: [0, 0] });
  for (const k of ['motion', 'opacity', 'fadeIn', 'fadeOut', 'emphasis']) assert.equal(a[k], undefined, `${k} 不在单卡流里`);
  assert.ok(iso.tracks.some(t => t.hidden && t.sourceOnly && t.clips.some(c => c.id === 'sib')), '同一条序列上的兄弟片段留作隐藏的源');
  assert.ok(iso.tracks.some(t => t.hidden && t.sourceOnly && t.id === 't2'));
  assert.deepEqual(iso._cardRender, { mode: 'final', frames: {}, missing: {} });
  // 组流保留外观
  const group = planStreams({ key: 'E', project: p, cardPlan: [control('a', 0.5, 2), control('b', 0, 4)] }, { budget: 1, envFingerprint: ENV_FP })[0];
  const gIso = isolatedStreamProject(p, group);
  assert.equal(gIso.tracks.filter(t => !t.hidden).flatMap(t => t.clips).find(c => c.id === 'a').opacity, 0.5);
});

test('paintLayers orders like FrameScene: the first track is on top', () => {
  const p = project([
    { id: 'top', clips: [{ id: 'a', cardId: 'x', start: 0, end: 1 }] },
    { id: 'mid', clips: [{ id: 'm', mediaId: 'v', start: 0, end: 1 }] },
    { id: 'bottom', clips: [{ id: 'b', cardId: 'y', start: 0, end: 1 }] },
  ], { media: [{ id: 'v', kind: 'video' }] });
  assert.deepEqual(paintLayers(p, 30).map(l => l.clipId), ['b', 'm', 'a']);
});

/* ------------------------------------------------------------ 清单 / 读口 */

test('segmentSignature covers stride, encoder, parameters and rect', () => {
  const base = { streamKey: 'K', segment: 3, stride: 1, encoder: 'libx264', rect: { x: 0, y: 0, w: 2, h: 2 } };
  const sig = segmentSignature(base);
  assert.equal(sig, segmentSignature({ ...base }));
  for (const change of [{ stride: 15 }, { encoder: 'h264_mf' }, { segment: 4 }, { rect: { x: 0, y: 0, w: 4, h: 2 } }]) {
    assert.notEqual(sig, segmentSignature({ ...base, ...change }), JSON.stringify(change));
  }
});

test('readySegmentRanges / publicManifest', () => {
  const manifest = { streamKey: 'K', kind: 'card', plane: 'local', clipIds: ['a'], fps: 30, bound: { x: 0, y: 0, w: 2, h: 2 }, tight: null,
    inits: { i1: { codec: 'avc1.64001f', width: 2, height: 20, rect: { x: 0, y: 0, w: 2, h: 2 }, encoder: 'libx264', bytes: 9 } },
    segments: { 0: { file: '0-a.m4s', init: 'i1', stride: 1, samples: 15, sig: 'x', bytes: 1 }, 1: { file: '1-b.m4s', init: 'i1', stride: 15, samples: 15, sig: 'y', bytes: 1 }, 5: { file: '5-c.m4s', init: 'i1', stride: 1, samples: 15, sig: 'z', bytes: 1 } } };
  assert.deepEqual(readySegmentRanges(manifest), [[0, 1], [5, 5]]);
  const pub = publicManifest(manifest);
  assert.equal(pub.segments[1].sig, undefined, '签名不外露');
  assert.deepEqual(pub.inits.i1, { codec: 'avc1.64001f', width: 2, height: 20, rect: { x: 0, y: 0, w: 2, h: 2 } });
  assert.equal(pub.segmentFrames, 15);
  // 清单里记的第一帧原样交给页面;改分段规则之前落盘的清单没有这一项,回 null
  assert.equal(pub.originFrame, null);
  assert.equal(publicManifest({ ...manifest, originFrame: 100 }).originFrame, 100);
});

test('handleStreamRequest serves the manifest (no-store) and content-addressed files (immutable), rejects anything else', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-stream-test-'));
  try {
    const key = 'a'.repeat(64);
    const store = new StreamStore(root);
    await store.save({ streamKey: key, kind: 'card', plane: 'local', clipIds: ['c'], fps: 30, bound: { x: 0, y: 0, w: 2, h: 2 }, tight: null, inits: {}, segments: { 0: { file: '0-0123456789abcdef.m4s', init: '0123456789abcdef', stride: 1, samples: 15 } } });
    await fs.writeFile(store.initFile(key, '0123456789abcdef'), 'INIT');
    await fs.writeFile(store.segFile(key, '0-0123456789abcdef.m4s'), 'SEG');
    const call = (url) => new Promise((resolve) => {
      const res = { headers: {}, statusCode: 200, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(body) { resolve({ status: this.statusCode, headers: this.headers, body: String(body ?? '') }); } };
      const handled = handleStreamRequest(store, { method: 'GET' }, res, url);
      if (!handled) resolve(null);
    });
    const manifest = await call(`/stream/${key}/manifest`);
    assert.equal(manifest.status, 200);
    assert.equal(manifest.headers['cache-control'], 'no-store');
    assert.equal(JSON.parse(manifest.body).segments[0].file, '0-0123456789abcdef.m4s');
    const init = await call(`/stream/${key}/init/0123456789abcdef`);
    assert.equal(init.body, 'INIT');
    assert.match(init.headers['cache-control'], /immutable/);
    assert.equal((await call(`/stream/${key}/seg/0-0123456789abcdef.m4s`)).body, 'SEG');
    assert.equal((await call(`/stream/${key}/seg/0-ffffffffffffffff.m4s`)).status, 404);
    assert.equal(await call(`/stream/${key}/seg/../../x`), null);
    assert.equal(await call(`/stream/nothex/manifest`), null);
    // F5:扫盘挂到键上
    const found = await store.scan();
    assert.deepEqual(found.map(f => [f.key, f.ranges]), [[key, [[0, 0]]]]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('StreamProducer.handle serves snapshot stream requests and leaves unrelated routes unhandled', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-stream-producer-handle-'));
  try {
    const key = 'c'.repeat(64);
    const producer = new StreamProducer({ root }, { env: {} });
    await producer.store.save({
      streamKey: key, kind: 'card', plane: 'local', clipIds: ['snapshot-card'], fps: 30,
      bound: { x: 0, y: 0, w: 2, h: 2 }, tight: null,
      inits: { '0123456789abcdef': { codec: 'avc1.64001f', width: 2, height: 2, rect: { x: 0, y: 0, w: 2, h: 2 } } },
      segments: { 0: { file: '0-0123456789abcdef.m4s', init: '0123456789abcdef', stride: 1, samples: 15 } },
    });
    await fs.writeFile(producer.store.initFile(key, '0123456789abcdef'), 'INIT-BYTES');
    await fs.writeFile(producer.store.segFile(key, '0-0123456789abcdef.m4s'), 'SEGMENT-BYTES');

    const call = (pathname, method = 'GET') => {
      let finish;
      const responsePromise = new Promise((resolve) => { finish = resolve; });
      const res = {
        headers: {}, statusCode: 200,
        setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
        end(body) { finish({ handled: true, status: this.statusCode, headers: this.headers, body: body ?? '' }); },
      };
      const handled = producer.handle({ method }, res, pathname);
      if (!handled) return Promise.resolve({ handled: false });
      return responsePromise;
    };

    const manifestPath = `/stream/${key}/manifest`;
    const manifest = await call(manifestPath);
    assert.equal(manifest.status, 200);
    assert.equal(manifest.headers['cache-control'], 'no-store');
    assert.equal(JSON.parse(String(manifest.body)).segments[0].file, '0-0123456789abcdef.m4s');

    const init = await call(`/stream/${key}/init/0123456789abcdef`);
    assert.equal(init.status, 200);
    assert.equal(init.headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.equal(String(init.body), 'INIT-BYTES');

    const segmentPath = `/stream/${key}/seg/0-0123456789abcdef.m4s`;
    const segment = await call(segmentPath);
    assert.equal(segment.status, 200);
    assert.equal(segment.headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.equal(String(segment.body), 'SEGMENT-BYTES');
    const head = await call(segmentPath, 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(head.headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.equal(String(head.body), '');

    assert.deepEqual(await call('/not-a-stream'), { handled: false });
    assert.deepEqual(await call(manifestPath, 'POST'), { handled: false });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('StreamProducer.rescan stages stream keys on the ready index (F5); republish sends the stream layer with groupClipIds', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-stream-test-'));
  try {
    const key = 'b'.repeat(64);
    const pipeline = { root, ready: createReadyHub(), prerenderPicked: () => true, captureCode: () => 'C' };
    const producer = new StreamProducer(pipeline, { env: {} });
    // 读口没接上时什么都不挂、不发(和 R7 一样)
    assert.equal(await producer.rescan(), 0);
    producer.attachRoute();
    await producer.store.save({ streamKey: key, kind: 'group', plane: 'stage', clipIds: ['x', 'y'], fps: 30, originFrame: 40, bound: { x: 0, y: 0, w: 2, h: 2 }, tight: null, inits: {}, segments: { 2: { file: '2-0123456789abcdef.m4s', init: 'i', stride: 1, samples: 15 } } });
    producer.store.manifests.clear();
    assert.equal(await producer.rescan(), 1);
    assert.deepEqual(pipeline.ready.stagedKeys(), [{ kind: 'stream', key, ranges: [[2, 2]] }]);
    // 认领(页面的 preload 把会话设到 E 之后):clipId 反查出来,发全量 layer
    const seen = [];
    pipeline.ready.subscribe('s', m => seen.push(m));
    pipeline.ready.adopt('s', 'E', 1);
    // 认领的那一项带着这条流的第一帧(来自这一版的流计划),发出去的层也带
    pipeline.ready.claim('E', [{ clipId: 'y', kind: 'stream', key, originFrame: 40 }]);
    assert.deepEqual(seen.filter(m => m.type === 'layer').at(-1), { type: 'layer', clipId: 'y', kind: 'stream', key, ranges: [[2, 2]], originFrame: 40 });
    // 生产者手里的流:republish 带 groupClipIds 和第一帧,只发给当前版本是这条流所属 entry 的会话
    producer.streams.set(key, { spec: { streamKey: key, topClipId: 'y', clipIds: ['x', 'y'], kind: 'group', originFrame: 40 }, manifest: await producer.store.load(key), aliases: new Set(), entryKey: 'E' });
    producer.republish();
    assert.deepEqual(seen.at(-1), { type: 'layer', clipId: 'y', kind: 'stream', key, ranges: [[2, 2]], groupClipIds: ['x', 'y'], originFrame: 40 });
    assert.deepEqual(producer.claimLayers(), [{ clipId: 'y', kind: 'stream', key, originFrame: 40 }]);
    assert.deepEqual(producer.claimLayers('E'), [{ clipId: 'y', kind: 'stream', key, originFrame: 40 }]);
    assert.deepEqual(producer.claimLayers('OTHER'), [], '别的版本不认领这条流');
    // 别的版本的流不进这个会话
    const before = seen.length;
    producer.streams.get(key).entryKey = 'OTHER';
    producer.republish();
    assert.equal(seen.length, before, '流属于别的版本:不发');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('switches: streams default on, decoder budget 6, pool 1 (max 2) unless pinned', () => {
  assert.equal(streamsEnabled({}), true);
  assert.equal(streamsEnabled({ PROMPTCUT_STREAMS: '0' }), false);
  assert.equal(streamDecoderBudget({}), 32, '条数的硬上限;预算的口径是数像素(src/render/streamBudget.mjs)');
  assert.equal(streamDecoderBudget({ PROMPTCUT_STREAM_DECODERS: '2' }), 2);
  assert.deepEqual(streamPoolLimit({}), { fixed: null });
  assert.deepEqual(streamPoolLimit({ PROMPTCUT_STREAM_POOL: '2' }), { fixed: 2 });
  assert.deepEqual(streamPoolLimit({ PROMPTCUT_STREAM_POOL: '5' }), { fixed: null });
  const producer = new StreamProducer({ root: os.tmpdir(), ready: createReadyHub() }, { env: {} });
  assert.equal(producer.pool, 1);
  assert.equal(producer.routeAttached, false, '分段读口没接上之前不产流');
  assert.equal(new StreamProducer({ root: os.tmpdir(), ready: createReadyHub() }, { env: { PROMPTCUT_STREAMS: '0' } }).enabled, false);
});

/* ------------------------------------------------------------ 编码命令行 */

test('segment encoder command line follows G3: premultiplied, out_range=tv, strict GOP, fMP4 to stdout', () => {
  const args = streamSegmentArgs({ encoder: 'libx264', fps: 30 });
  const joined = args.join(' ');
  assert.ok(args.includes('-reinit_filter') && args[args.indexOf('-reinit_filter') + 1] === '0');
  // 滤镜切片线程数按核数封顶 8(不改产出,见 stream-encode-fast.test.mjs)
  assert.match(args[args.indexOf('-filter_complex_threads') + 1], /^\d+$/);
  // alpha 在预乘之前分出去、两半用 gbrp 拼(和旧写法逐字节等价,见 stream-encode-fast.test.mjs)
  assert.match(joined, /\[0:v\]format=gbrap,split=2\[p\]\[a\];\[p\]premultiply=inplace=1,format=gbrp,pad=iw:ih\+8:0:0:black\[rgb\]/);
  assert.match(joined, /\[a\]alphaextract,format=gbrp,pad=iw:ih\+8:0:0:black\[mask\]/);
  // 输入端不攒包:帧一到就开工(只改时机、不改产出)
  assert.match(joined, /-probesize 32 -analyzeduration 0 -threads 1 -f image2pipe -c:v png -framerate 30 -i pipe:0/);
  assert.match(joined, /scale=out_range=tv:out_color_matrix=bt709,format=yuv420p/);
  assert.match(joined, /-color_range tv/);
  assert.match(joined, /-c:v libx264 -preset veryfast -crf 16 -g 15 -keyint_min 15 -sc_threshold 0 -bf 0/);
  assert.match(joined, /-video_track_timescale 30/);
  assert.match(joined, /-movflags frag_keyframe\+empty_moov\+default_base_moof -an -f mp4 pipe:1$/);
  // h264_mf 只收 nv12(G0-b (7))
  assert.match(streamFilter(STREAM_ENCODERS.h264_mf.pixFmt), /format=nv12$/);
  assert.deepEqual(STREAM_ENCODER_ORDER, ['h264_nvenc', 'h264_qsv', 'h264_amf', 'libx264', 'h264_mf']);
  // 缺省只试 libx264(本机硬件编码器都列着跑不了),auto 才按探测顺序
  assert.deepEqual(streamEncoderPreference({}), ['libx264', 'h264_mf']);
  assert.deepEqual(streamEncoderPreference({ PROMPTCUT_STREAM_ENCODER: 'auto' }), STREAM_ENCODER_ORDER);
  assert.throws(() => streamSegmentArgs({ encoder: 'nope', fps: 30 }));
});

/* ------------------------------------------------------------ 排程(G4) */

test('streamFirstMs: only a broken lease pays the reset + fixed cost + replay', () => {
  assert.equal(streamFirstMs({ leaseContinues: true, runStartFrame: 100 }), 0);
  assert.equal(streamFirstMs({ runStartFrame: 30, mountFrame: 10, resetMs: 400, fixedMs: 80, frameMs: 30 }), 400 + 80 + 20 * 30);
});

test('streamFeasibility: falls back to the sparse tier (one frame per segment) before giving up', () => {
  // 30 fps、一个 worker:15 帧的预算是 500 ms;每帧出图 68.9 ms(两个编码器并存)
  const f = streamFeasibility({ n: 4, firstMs: 480, frameMs: 68.9, fps: 30, workers: 1, stride: 1 });
  assert.equal(f.feasible, false);
  assert.equal(f.stride, 15, '只有一档稀疏:每个分段一张');
  assert.equal(streamFeasibility({ n: 4, frameMs: 20, fps: 30 }).feasible, true);
  assert.equal(streamFeasibility({ n: 1, firstMs: 100000, frameMs: 30, fps: 30 }).stride, null);
});

test('planStreamSegments: continue the lease first, then the nearest unready segment ahead of the playhead, then fill holes', () => {
  const ready = new Set([0, 1, 2]);
  const plan = (o) => planStreamSegments({ fps: 30, firstSegment: 0, lastSegment: 9, ready: n => ready.has(n), ...o });
  // 暂停(rate 0):从播放头所在分段起
  assert.deepEqual(plan({ playheadFrame: 5 * 15, rate: 0 }), { segment: 5, leadSegments: 0, continues: false });
  // 租约接得上就接着做,不为远处断租约
  assert.equal(plan({ playheadFrame: 8 * 15, rate: 0, leaseLastSegment: 3 }).segment, 4);
  assert.equal(plan({ playheadFrame: 8 * 15, rate: 0, leaseLastSegment: 3 }).continues, true);
  // 播放中留提前量
  const playing = plan({ playheadFrame: 3 * 15, rate: 1, frameMs: 30, firstMs: 500 });
  assert.ok(playing.leadSegments >= 1 && playing.segment >= 3 + playing.leadSegments);
  // 后面都齐了回头补洞
  for (let n = 3; n <= 9; n++) ready.add(n);
  ready.delete(1);
  assert.equal(plan({ playheadFrame: 9 * 15, rate: 0 }).segment, 1);
  ready.add(1);
  assert.equal(plan({ playheadFrame: 0, rate: 0 }).segment, null);
  // 预留的不再挑
  ready.delete(7);
  assert.equal(plan({ playheadFrame: 0, rate: 0, reserved: new Set([7]) }).segment, null);
});

test('planStreamSegments: 播放头的帧号按这条流自己的第一帧换成分段号;还没到这条流时从它的第 0 段起', () => {
  const plan = (o) => planStreamSegments({ fps: 30, firstSegment: 0, lastSegment: 9, ready: () => false, rate: 0, ...o });
  // 流从第 100 帧开始:播放头在第 100～114 帧是第 0 段,第 115 帧起是第 1 段
  assert.equal(plan({ playheadFrame: 100, originFrame: 100 }).segment, 0);
  assert.equal(plan({ playheadFrame: 114, originFrame: 100 }).segment, 0);
  assert.equal(plan({ playheadFrame: 115, originFrame: 100 }).segment, 1);
  assert.equal(plan({ playheadFrame: 100 + 4 * 15 + 7, originFrame: 100 }).segment, 4);
  // 同一个播放头,从第 0 帧开始的流是第 7 段(原来所有流都按这个算)
  assert.equal(plan({ playheadFrame: 115, originFrame: 0 }).segment, 7);
  // 播放头在流的前面:第 0 段;在流的后面:末段已经没有未就绪的就回头找
  assert.equal(plan({ playheadFrame: 3, originFrame: 100 }).segment, 0);
  assert.equal(plan({ playheadFrame: 100000, originFrame: 100 }).segment, 9);
});
