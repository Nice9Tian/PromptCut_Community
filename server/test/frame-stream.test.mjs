/**
 * R8 pure-function unit tests for track stream server (`server/frame-stream.mjs`, scheduling in
 * `frame-playback.mjs`, stream keys in `card-identity.mjs`, CLI commands in `bakery/ffmpeg.mjs`).
 * The end-to-end half is in `scripts/probes/stream-produce-probe.mjs` / `stream-play-probe.mjs`.
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

/* ------------------------------------------------------------ fMP4 composition */

const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const box = (type, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([u32(8 + body.length), Buffer.from(type, 'latin1'), body]); };
const full = (version, flags) => u32(((version & 0xff) << 24) | (flags & 0xffffff));

/** Minimal init: ftyp + moov/trak/mdia/(mdhd, minf/stbl/stsd/avc1/avcC) */
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

/**
 * A segment: moof(tfhd with default-base-is-moof + default flags = non-sync samples; trun with
 * data_offset + first_sample_flags + per-sample sizes) + mdat
 */
function makeSegment(sizes = [10, 4, 4], { firstSync = true } = {}) {
  const tfhd = box('tfhd', full(0, 0x020020), u32(1), u32(0x01010000));
  const trunBody = (dataOffset) => Buffer.concat([full(0, 0x000205), u32(sizes.length), u32(dataOffset), u32(firstSync ? 0x02000000 : 0x01010000), ...sizes.map(u32)]);
  // moof size must be calculated first before writing data_offset: two passes
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
  // G5: level changes with content; string must be constructed from avcC, not hardcoded
  assert.equal(codecOfAvcC(Buffer.from([1, 0x64, 0, 0x33])), 'avc1.640033');
});

/* ------------------------------------------------------------ Rectangles */

test('evenRect rounds out to even width and height inside the limit (yuv420p)', () => {
  const view = { x: 0, y: 0, w: 1920, h: 1080 };
  assert.deepEqual(evenRect({ x: 10.4, y: 3.2, w: 101, h: 51 }, view), { x: 10, y: 3, w: 102, h: 52 });
  // If it hits the right / bottom edge, expand to the left / top
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
  // Full-screen card (no box): snap to top-left corner, upper bound is the entire main video
  const fullStage = localPlacement({}, stage);
  assert.deepEqual(fullStage.offset, { x: 0, y: 0 });
  assert.deepEqual(fullStage.bound, { x: 0, y: 0, w: 1920, h: 1080 });
});

/* ------------------------------------------------------------ Measured entity box */

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

/* ------------------------------------------------------------ Partitioning */

const CAPS = { compositing: 'independent', frameMode: 'stateful' };
// Contract E.4: planStreams produces no stream without an environment fingerprint (M4).
// Below, only this input is added across call sites; assertions remain unchanged.
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
    { clipId: 'm', order: 3, from: 0, to: 99 }, // Asset layer inserted between b and c
    { clipId: 'c', order: 4, from: 0, to: 99 },
  ];
  const streams = ['a', 'b', 'c'].map((id) => ({ clipIds: [id], order: layers.find(l => l.clipId === id).order, from: 0, to: 99 }));
  assert.equal(groupStreams(streams, layers, 6).length, 3, 'no merge when within budget');
  const merged = groupStreams(streams, layers, 2);
  assert.deepEqual(merged.map(s => s.clipIds), [['a', 'b'], ['c']], 'b and c are separated by a media layer, so only a+b can merge');
  // Stop when it can no longer merge (separated by other layers); do not loop infinitely
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
  // Segments count from this stream's own first frame: first frame is the clip's first frame (15);
  // segment 0 is frames 15-29; last frame 59 falls in segment 2
  assert.equal(a.originFrame, 15);
  assert.equal(a.firstSegment, 0);
  assert.equal(a.lastFrame, 59);
  assert.equal(a.lastSegment, Math.floor((59 - 15) / SEGMENT_FRAMES));
  const b = specs.find(s => s.clipIds[0] === 'b');
  assert.deepEqual([b.originFrame, b.firstSegment, b.lastSegment], [0, 0, 7]);
  assert.deepEqual(a.offset, { x: 640, y: 360 });
  assert.equal(a.mountFrame, 14, 'mount frame includes LEAD');
  // Cards outside the prerender set produce no stream (pinned render 9)
  assert.equal(planStreams(entry, { picked: id => id === 'b', envFingerprint: ENV_FP }).length, 1);
  // Over budget: merged into a single group stream, stage coordinates, with the topmost card at the end
  const grouped = planStreams(entry, { budget: 1, envFingerprint: ENV_FP });
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].kind, 'group');
  assert.equal(grouped[0].plane, 'stage');
  assert.deepEqual(grouped[0].clipIds, ['b', 'a'], 'painter\'s order: t2 is at the bottom, t1 is on top');
  assert.equal(grouped[0].topClipId, 'a');
  assert.deepEqual(grouped[0].bound, { x: 0, y: 0, w: 1920, h: 1080 });
  // The group stream's first frame is the earliest first frame among members (frame 0 of b);
  // the last frame is the latest among members (frame 119 of b)
  assert.deepEqual([grouped[0].originFrame, grouped[0].firstSegment, grouped[0].lastSegment], [0, 0, 7]);
});

test('planStreams: when a clip does not start on a frame that is a multiple of 15 and its duration is not a multiple of 15, segments still start from the clip\'s own first frame and the last segment is partial', () => {
  // Starts at frame 100 (100 / 30 seconds), 50 frames in total: frames 100-149. Segment 0 is
  // 100-114, segment 1 is 115-129, segment 2 is 130-144, segment 3 is 145-149 (5 frames)
  const start = 100 / 30, end = 150 / 30;
  const p = project([
    { id: 't1', clips: [{ id: 'a', cardId: 'x', start, end }] },
    { id: 't2', clips: [{ id: 'b', cardId: 'y', start: 40 / 30, end: 130 / 30 }] },
  ], { duration: 6 });
  const entry = { key: 'E', project: p, cardPlan: [control('a', start, end), control('b', 40 / 30, 130 / 30)] };
  const a = planStreams(entry, { envFingerprint: ENV_FP }).find(s => s.clipIds[0] === 'a');
  assert.deepEqual([a.firstFrame, a.lastFrame, a.originFrame, a.firstSegment, a.lastSegment], [100, 149, 100, 0, 3]);
  // The copy passed to the splitter carries the first frame
  assert.deepEqual([queueStreamOf(a).originFrame, queueStreamOf(a).firstSegment, queueStreamOf(a).lastSegment], [100, 0, 3]);
  // Group stream: covers 40-149, first frame is 40
  const g = planStreams(entry, { budget: 1, envFingerprint: ENV_FP })[0];
  assert.equal(g.kind, 'group');
  assert.deepEqual([g.firstFrame, g.lastFrame, g.originFrame, g.firstSegment, g.lastSegment], [40, 149, 40, 0, Math.floor((149 - 40) / SEGMENT_FRAMES)]);
});

test('stream keys: placement-free for single-card streams, with time placement; group keys use the appearance key', () => {
  const p = project([{ id: 't1', clips: [{ id: 'a', cardId: 'x', start: 0, end: 2 }] }]);
  const key = (ctl, budget = 6) => planStreams({ key: 'E', project: p, cardPlan: [ctl] }, { budget, envFingerprint: ENV_FP })[0]?.streamKey;
  const base = control('a', 0, 2);
  assert.equal(key(base), key({ ...base, key: 'K-moved-elsewhere' }), 'a single-card stream ignores the appearance-bearing cache key (moving the card does not invalidate the stream)');
  assert.notEqual(key(base), key({ ...base, snapshotKey: 'S-other-params' }), 'the stream key changes when the content changes');
  assert.notEqual(key(base), key({ ...base, sampling: { ...base.sampling, firstFrame: 1 } }), 'the stream key changes when the in point moves by one frame (the clip\'s position on the timeline is still part of the key; "streams stay valid after a move" is logged as a to-do and not done this time)');
  const a = cardStreamIdentity({ kind: 'card', fps: 30, stage: { width: 1920, height: 1080 }, members: [{ key: 'S', sampling: base.sampling, count: 60 }], codeVersion: '1' });
  assert.notEqual(a, cardStreamIdentity({ kind: 'card', fps: 30, stage: { width: 1920, height: 1080 }, members: [{ key: 'S', sampling: base.sampling, count: 60 }], codeVersion: '2' }), 'old streams are invalidated when the production code changes');
  assert.notEqual(a, cardStreamIdentity({ kind: 'card', fps: 25, stage: { width: 1920, height: 1080 }, members: [{ key: 'S', sampling: base.sampling, count: 60 }], codeVersion: '1' }), 'fps goes into the key');
});

test('no replay: a stream whose members are all remotion-style (direct) must not replay from the mount frame; a stream with one motion-style card, or with no style declared, replays as before; replay does not go into any key', () => {
  const DIRECT = { compositing: 'independent', frameMode: 'direct' };
  const direct = (clipId, start, end, extra = {}) => control(clipId, start, end, 30, { frameMode: 'direct', capabilities: DIRECT, ...extra });
  const stateful = (clipId, start, end, extra = {}) => control(clipId, start, end, 30, { frameMode: 'stateful', ...extra });
  assert.equal(streamNeedsReplay([direct('a', 0, 1)]), false);
  assert.equal(streamNeedsReplay([stateful('a', 0, 1)]), true);
  assert.equal(streamNeedsReplay([direct('a', 0, 1), stateful('b', 0, 1)]), true, 'replay needed when the group has a motion-style card');
  assert.equal(streamNeedsReplay([direct('a', 0, 1), direct('b', 0, 1)]), false);
  assert.equal(streamNeedsReplay([control('a', 0, 1)]), true, 'no top-level frameMode, stateful in capabilities: replay needed');
  assert.equal(streamNeedsReplay([{ ...control('a', 0, 1), capabilities: { compositing: 'independent' } }]), true, 'style not declared: be conservative, replay needed');
  assert.equal(streamNeedsReplay([direct('a', 0, 1, { capabilities: { ...DIRECT, need_prerendering: true } })]), true, 'need_prerendering declared: replay needed');
  assert.equal(streamNeedsReplay([direct('a', 0, 1, { needPrerendering: true })]), true);
  assert.equal(streamNeedsReplay([]), true);
  // Also accepts legacy input shapes where the syntax is only in capabilities
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
  // Group stream: a+c are both direct and adjacent (t1 and t3 have b on t2 in between → cannot
  // merge). When budget is reduced to 1, can only merge adjacent ones; check the resulting group
  const grouped = planStreams({ key: 'E', project: p, cardPlan: plan }, { budget: 1, envFingerprint: ENV_FP });
  for (const g of grouped) assert.equal(g.replay, g.members.some(m => m.frameMode !== 'direct'), `group ${g.clipIds}: replay needed only when a member is motion-style`);
  assert.ok(grouped.some(g => g.kind === 'group'));
  // Key unchanged: changing syntax to any value other than stateful in the same plan yields the same
  // stream key (replay is not included in the key)
  const flipped = plan.map(c => ({ ...c, frameMode: c.frameMode === 'direct' ? 'stateful' : 'direct' }));
  const keysOf = list => planStreams({ key: 'E', project: p, cardPlan: list }, { envFingerprint: ENV_FP }).map(s => `${s.clipIds}:${s.streamKey}`).sort();
  assert.deepEqual(keysOf(plan), keysOf(flipped), 'style does not go into the stream key (the content identity in the key already carries the card\'s declaration)');
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
  assert.equal(a.start, 0.5, 'Time is not shifted');
  assert.deepEqual(a.frame, { x: spec.offset.x, y: spec.offset.y, w: 640, h: 360, anchor: [0, 0] });
  for (const k of ['motion', 'opacity', 'fadeIn', 'fadeOut', 'emphasis']) assert.equal(a[k], undefined, `${k} is not in the single-card stream`);
  assert.ok(iso.tracks.some(t => t.hidden && t.sourceOnly && t.clips.some(c => c.id === 'sib')), 'sibling clips on the same track are kept as hidden sources');
  assert.ok(iso.tracks.some(t => t.hidden && t.sourceOnly && t.id === 't2'));
  assert.deepEqual(iso._cardRender, { mode: 'final', frames: {}, missing: {} });
  // Group stream preserves appearance
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

/* ------------------------------------------------------------ Manifest / read port */

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
  assert.equal(pub.segments[1].sig, undefined, 'signature is not exposed');
  assert.deepEqual(pub.inits.i1, { codec: 'avc1.64001f', width: 2, height: 20, rect: { x: 0, y: 0, w: 2, h: 2 } });
  assert.equal(pub.segmentFrames, 15);
  // The first frame recorded in the manifest is passed to the page as-is; manifests saved to disk
  // before changing segmentation rules lack this entry and return null
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
    // F5: scan disk and attach to the key
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
    // When the read port is not connected, attach nothing and send nothing (same as R7)
    assert.equal(await producer.rescan(), 0);
    producer.attachRoute();
    await producer.store.save({ streamKey: key, kind: 'group', plane: 'stage', clipIds: ['x', 'y'], fps: 30, originFrame: 40, bound: { x: 0, y: 0, w: 2, h: 2 }, tight: null, inits: {}, segments: { 2: { file: '2-0123456789abcdef.m4s', init: 'i', stride: 1, samples: 15 } } });
    producer.store.manifests.clear();
    assert.equal(await producer.rescan(), 1);
    assert.deepEqual(pipeline.ready.stagedKeys(), [{ kind: 'stream', key, ranges: [[2, 2]] }]);
    // Claim (after page preload sets session to E): look up clipId and send full layers
    const seen = [];
    pipeline.ready.subscribe('s', m => seen.push(m));
    pipeline.ready.adopt('s', 'E', 1);
    // The claimed item carries this stream's first frame (from this version of the stream plan);
    // emitted layers carry it as well
    pipeline.ready.claim('E', [{ clipId: 'y', kind: 'stream', key, originFrame: 40 }]);
    assert.deepEqual(seen.filter(m => m.type === 'layer').at(-1), { type: 'layer', clipId: 'y', kind: 'stream', key, ranges: [[2, 2]], originFrame: 40 });
    // Stream held by producer: republish carries groupClipIds and first frame, sent only to sessions
    // whose current version matches the entry this stream belongs to
    producer.streams.set(key, { spec: { streamKey: key, topClipId: 'y', clipIds: ['x', 'y'], kind: 'group', originFrame: 40 }, manifest: await producer.store.load(key), aliases: new Set(), entryKey: 'E' });
    producer.republish();
    assert.deepEqual(seen.at(-1), { type: 'layer', clipId: 'y', kind: 'stream', key, ranges: [[2, 2]], groupClipIds: ['x', 'y'], originFrame: 40 });
    assert.deepEqual(producer.claimLayers(), [{ clipId: 'y', kind: 'stream', key, originFrame: 40 }]);
    assert.deepEqual(producer.claimLayers('E'), [{ clipId: 'y', kind: 'stream', key, originFrame: 40 }]);
    assert.deepEqual(producer.claimLayers('OTHER'), [], 'other versions do not claim this stream');
    // Streams from other versions do not enter this session
    const before = seen.length;
    producer.streams.get(key).entryKey = 'OTHER';
    producer.republish();
    assert.equal(seen.length, before, 'stream belongs to another version: not sent');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('switches: streams default on, decoder budget 6, pool 1 (max 2) unless pinned', () => {
  assert.equal(streamsEnabled({}), true);
  assert.equal(streamsEnabled({ PROMPTCUT_STREAMS: '0' }), false);
  assert.equal(streamDecoderBudget({}), 32, 'hard limit on the count; the budget is measured in pixels (src/render/streamBudget.mjs)');
  assert.equal(streamDecoderBudget({ PROMPTCUT_STREAM_DECODERS: '2' }), 2);
  assert.deepEqual(streamPoolLimit({}), { fixed: null });
  assert.deepEqual(streamPoolLimit({ PROMPTCUT_STREAM_POOL: '2' }), { fixed: 2 });
  assert.deepEqual(streamPoolLimit({ PROMPTCUT_STREAM_POOL: '5' }), { fixed: null });
  const producer = new StreamProducer({ root: os.tmpdir(), ready: createReadyHub() }, { env: {} });
  assert.equal(producer.pool, 1);
  assert.equal(producer.routeAttached, false, 'no stream is produced before the segment read route is attached');
  assert.equal(new StreamProducer({ root: os.tmpdir(), ready: createReadyHub() }, { env: { PROMPTCUT_STREAMS: '0' } }).enabled, false);
});

/* ------------------------------------------------------------ Encoding command line */

test('segment encoder command line follows G3: premultiplied, out_range=tv, strict GOP, fMP4 to stdout', () => {
  const args = streamSegmentArgs({ encoder: 'libx264', fps: 30 });
  const joined = args.join(' ');
  assert.ok(args.includes('-reinit_filter') && args[args.indexOf('-reinit_filter') + 1] === '0');
  // Filter slice thread count is capped at 8 based on core count (does not change output, see
  // stream-encode-fast.test.mjs)
  assert.match(args[args.indexOf('-filter_complex_threads') + 1], /^\d+$/);
  // Alpha is split out before premultiplication; both halves are joined with gbrp (byte-for-byte
  // equivalent to the old syntax, see stream-encode-fast.test.mjs)
  assert.match(joined, /\[0:v\]format=gbrap,split=2\[p\]\[a\];\[p\]premultiply=inplace=1,format=gbrp,pad=iw:ih\+8:0:0:black\[rgb\]/);
  assert.match(joined, /\[a\]alphaextract,format=gbrp,pad=iw:ih\+8:0:0:black\[mask\]/);
  // Input side does not buffer packets: starts work as soon as a frame arrives (only changes timing,
  // does not change output)
  assert.match(joined, /-probesize 32 -analyzeduration 0 -threads 1 -f image2pipe -c:v png -framerate 30 -i pipe:0/);
  assert.match(joined, /scale=out_range=tv:out_color_matrix=bt709,format=yuv420p/);
  assert.match(joined, /-color_range tv/);
  assert.match(joined, /-c:v libx264 -preset veryfast -crf 16 -g 15 -keyint_min 15 -sc_threshold 0 -bf 0/);
  assert.match(joined, /-video_track_timescale 30/);
  assert.match(joined, /-movflags frag_keyframe\+empty_moov\+default_base_moof -an -f mp4 pipe:1$/);
  // h264_mf only accepts nv12 (G0-b (7))
  assert.match(streamFilter(STREAM_ENCODERS.h264_mf.pixFmt), /format=nv12$/);
  assert.deepEqual(STREAM_ENCODER_ORDER, ['h264_nvenc', 'h264_qsv', 'h264_amf', 'libx264', 'h264_mf']);
  // By default only tries libx264 (local hardware encoders are listed but cannot run); only auto
  // follows probe order
  assert.deepEqual(streamEncoderPreference({}), ['libx264', 'h264_mf']);
  assert.deepEqual(streamEncoderPreference({ PROMPTCUT_STREAM_ENCODER: 'auto' }), STREAM_ENCODER_ORDER);
  assert.throws(() => streamSegmentArgs({ encoder: 'nope', fps: 30 }));
});

/* ------------------------------------------------------------ Scheduling (G4) */

test('streamFirstMs: only a broken lease pays the reset + fixed cost + replay', () => {
  assert.equal(streamFirstMs({ leaseContinues: true, runStartFrame: 100 }), 0);
  assert.equal(streamFirstMs({ runStartFrame: 30, mountFrame: 10, resetMs: 400, fixedMs: 80, frameMs: 30 }), 400 + 80 + 20 * 30);
});

test('streamFeasibility: falls back to the sparse tier (one frame per segment) before giving up', () => {
  // 30 fps, one worker: budget for 15 frames is 500 ms; 68.9 ms per frame render (two encoders coexist)
  const f = streamFeasibility({ n: 4, firstMs: 480, frameMs: 68.9, fps: 30, workers: 1, stride: 1 });
  assert.equal(f.feasible, false);
  assert.equal(f.stride, 15, 'only one sparse tier: one frame per segment');
  assert.equal(streamFeasibility({ n: 4, frameMs: 20, fps: 30 }).feasible, true);
  assert.equal(streamFeasibility({ n: 1, firstMs: 100000, frameMs: 30, fps: 30 }).stride, null);
});

test('planStreamSegments: continue the lease first, then the nearest unready segment ahead of the playhead, then fill holes', () => {
  const ready = new Set([0, 1, 2]);
  const plan = (o) => planStreamSegments({ fps: 30, firstSegment: 0, lastSegment: 9, ready: n => ready.has(n), ...o });
  // Pause (rate 0): starts from the segment where the playhead is located
  assert.deepEqual(plan({ playheadFrame: 5 * 15, rate: 0 }), { segment: 5, leadSegments: 0, continues: false });
  // Continue if leases connect; do not break leases for distant segments
  assert.equal(plan({ playheadFrame: 8 * 15, rate: 0, leaseLastSegment: 3 }).segment, 4);
  assert.equal(plan({ playheadFrame: 8 * 15, rate: 0, leaseLastSegment: 3 }).continues, true);
  // Leave lead time during playback
  const playing = plan({ playheadFrame: 3 * 15, rate: 1, frameMs: 30, firstMs: 500 });
  assert.ok(playing.leadSegments >= 1 && playing.segment >= 3 + playing.leadSegments);
  // Backfill gaps once subsequent segments are all ready
  for (let n = 3; n <= 9; n++) ready.add(n);
  ready.delete(1);
  assert.equal(plan({ playheadFrame: 9 * 15, rate: 0 }).segment, 1);
  ready.add(1);
  assert.equal(plan({ playheadFrame: 0, rate: 0 }).segment, null);
  // Reserved items are no longer picked
  ready.delete(7);
  assert.equal(plan({ playheadFrame: 0, rate: 0, reserved: new Set([7]) }).segment, null);
});

test('planStreamSegments: the playhead\'s frame number is converted to a segment number relative to this stream\'s own first frame; before the playhead reaches this stream, it starts from the stream\'s segment 0', () => {
  const plan = (o) => planStreamSegments({ fps: 30, firstSegment: 0, lastSegment: 9, ready: () => false, rate: 0, ...o });
  // Stream starts at frame 100: playhead at frames 100-114 is segment 0; from frame 115 onward is segment 1
  assert.equal(plan({ playheadFrame: 100, originFrame: 100 }).segment, 0);
  assert.equal(plan({ playheadFrame: 114, originFrame: 100 }).segment, 0);
  assert.equal(plan({ playheadFrame: 115, originFrame: 100 }).segment, 1);
  assert.equal(plan({ playheadFrame: 100 + 4 * 15 + 7, originFrame: 100 }).segment, 4);
  // For the same playhead, a stream starting at frame 0 is segment 7 (previously all streams were
  // calculated this way)
  assert.equal(plan({ playheadFrame: 115, originFrame: 0 }).segment, 7);
  // Playhead before the stream: segment 0; playhead after the stream: look back if the last
  // segment has nothing unready
  assert.equal(plan({ playheadFrame: 3, originFrame: 100 }).segment, 0);
  assert.equal(plan({ playheadFrame: 100000, originFrame: 100 }).segment, 9);
});
