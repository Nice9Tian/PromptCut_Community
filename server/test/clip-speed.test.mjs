/**
 * Clip speed (`TrackClip.speed`, `src/kernel/clipTime.mjs`) conventions across the codebase:
 *   - When defaulting to 1 (field omitted), identity keys everywhere remain verbatim unchanged:
 *     the fixed values below are calculated from the same sample on initial commit 5a8f375a
 *     (`out/speed/golden.mjs`);
 *   - Video frames of speed-changed clips are sampled everywhere via "media time = mediaOffset +
 *     (t − start) × speed";
 *   - [ruling] In v1, original audio of speed-changed clips is omitted (export mix and preview sound
 *     layer share `speedMutesSource`); integrated audio-visual cards attached on top emit sound as
 *     usual (user decision, 2026-10-23: "Emit sound.");
 *   - Store speed edits preserve in points and recompute end points by new speed; reverting to 1
 *     deletes the field.
 * Run: npm test -- server/test/clip-speed.test.mjs
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
// Places outputting frames and keys all chain withMediaRates after projectCardGraph
// (cardGraph.mjs is inside the source closure of cards with audio and cannot be changed)
const graphOf = (p) => withMediaRates(p, projectCardGraph(p, (id) => DEFS[id]));
const graphKeys = (p) => {
  const graph = graphOf(p);
  return { inputKeys: Object.fromEntries(cardSnapshotInputKeys(graph)), nodeIds: Object.fromEntries(cardNodeIdentities(graph)) };
};

/* ---------- Default 1: identity verbatim unchanged ---------- */

// Fixed value calculated on initial commit 5a8f375a (same as pixel baseline commit 5f4523d0)
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

test('Default 1: frame identity, track prefix, mirror hash, input signature, card graph upstream keys and the start-of-work commit are verbatim identical', () => {
  const p = fixture();
  assert.equal(frameIdentity(p, 'code'), GOLDEN.frameIdentity);
  assert.deepEqual(trackPrefixes(p, 'code').map((x) => x.key), GOLDEN.trackPrefixes);
  assert.equal(projectHash(p), GOLDEN.projectHash);
  for (const [id, sig] of Object.entries(GOLDEN.sigs)) assert.equal(clipInputSig(p, id), sig, id);
  assert.equal(graphKeys(p).inputKeys.n1.source.key, GOLDEN.fxInputKey);
  // No rate entry on asset nodes (default 1 does not enter the node)
  const graph = graphOf(p);
  assert.equal('rate' in graph.nodes.find((n) => n.id === '@clip/v-fx/source'), false);
  const raw = projectCardGraph(p, (id) => DEFS[id]);
  assert.equal(withMediaRates(p, raw), raw, 'Returns the same object when there are no speed-changed clips');
});

test('Speed change: the layer table input signature, the card graph\'s media node, and the upstream key of the media effect card attached to it all change; other clips do not', () => {
  const p = fixture();
  const fast = withClip(p, 'v-fx', { speed: 2 });
  assert.notEqual(clipInputSig(fast, 'v-fx'), clipInputSig(p, 'v-fx'), 'The speed-changed clip\'s own signature must change');
  assert.equal(clipInputSig(fast, 'v-plain'), clipInputSig(p, 'v-plain'), 'Other clips are unchanged');
  const node = graphOf(fast).nodes.find((n) => n.id === '@clip/v-fx/source');
  assert.equal(node.rate, 2, 'The media node carries the rate');
  assert.notEqual(graphKeys(fast).inputKeys.n1.source.key, GOLDEN.fxInputKey, 'The upstream key of a media effect card attached to speed-changed media must change (otherwise it hits the old snapshot)');
  assert.notEqual(graphKeys(fast).nodeIds['@clip/v-fx/source'], graphKeys(p).nodeIds['@clip/v-fx/source']);
  // The places hashing the entire track: naturally changes with an extra key
  assert.notEqual(frameIdentity(fast, 'code'), GOLDEN.frameIdentity);
  assert.notEqual(projectHash(fast), GOLDEN.projectHash);
  // Explicit speed: 1 is also treated as default (signature format does not change from writing 1)
  assert.equal(clipInputSig(withClip(p, 'v-fx', { speed: 1 }), 'v-fx'), GOLDEN.sigs['v-fx']);
});

/* ---------- Which frame is sampled for video ---------- */

test('Frame viewing (vision-compose): media time is converted by speed', () => {
  const p = withClip(fixture(), 'v-plain', { speed: 2 });
  const layer = mediaLayersAt(p, 1).find((l) => l.clip.id === 'v-plain');
  assert.equal(layer.mediaTime, 1.5 + 1 * 2);
  const slow = withClip(fixture(), 'v-plain', { speed: 0.5 });
  assert.equal(mediaLayersAt(slow, 3).find((l) => l.clip.id === 'v-plain').mediaTime, 1.5 + 3 * 0.5);
});

test('Export compatibility bypass (export-compose): a speed-changed clip squeezes media timestamps onto the timeline by the rate, and the media length read is multiplied by the rate', () => {
  const media = { id: 'v1', kind: 'video', name: 'a.mp4', url: '/@media/a.mp4' };
  const frame = { x: 0, y: 0, w: 1920, h: 1080, anchor: [0, 0], scale: 1, rotate: 0 };
  const build = (speed) => buildComposeArgs({ width: 1920, height: 1080, fps: 30, startFrame: 0, endFrame: 89, cardsPattern: 'f/%06d.png', out: 'o.mp4',
    layers: [{ clip: { id: 'c', mediaId: 'v1', mediaOffset: 10, start: 0, end: 3, frame, ...(speed ? { speed } : {}) }, media, src: '/m/a.mp4' }] });
  const one = build(undefined), two = build(2);
  const ssOf = (r) => r.args[r.args.indexOf('-ss') + 1], tOf = (r) => r.args[r.args.indexOf('-t') + 1];
  assert.equal(ssOf(one), '9.5');
  assert.equal(ssOf(two), '9.5', 'In point unchanged');
  assert.equal(tOf(one), '4');
  assert.equal(tOf(two), '7', 'The media must read 3 seconds × 2 + margin at both ends');
  assert.match(one.graph, /setpts=PTS\+-0\.5\/TB,fps=30/, 'The form for default 1 is unchanged');
  assert.match(two.graph, /setpts=PTS\/2\+-0\.25\/TB,fps=30/, 'Timestamps are divided by the rate and then shifted: media second m lands at start + (m − off)/2');
});

test('Media node of a media effect card (withMediaRates): the frame-fetch time is multiplied by the rate, no rate by default', () => {
  const p = withClip(fixture(), 'v-fx', { speed: 0.5 });
  const node = graphOf(p).nodes.find((n) => n.id === '@clip/v-fx/source');
  assert.deepEqual([node.offset, node.rate], [0.2, 0.5]);
});

/* ---------- Audio: original audio omitted for speed-changed clips ---------- */

test('Export mix manifest (audioPlanOf): a speed-changed video clip produces no original audio, other clips are as before', () => {
  const base = audioPlanOf(fixture());
  const p = withClip(fixture(), 'v-plain', { speed: 2 });
  const plan = audioPlanOf(p);
  assert.equal(plan.some((e) => e.clipId === 'v-plain'), false, 'The speed-changed clip is not in the mix manifest');
  assert.deepEqual(plan, base.filter((e) => e.clipId !== 'v-plain'), 'The remaining entries are verbatim identical');
  // The legacy ffmpeg path (mux-audio) uses the same manifest
  const files = buildAudioPlan(p, 'out', () => true, (m) => `/x/${m.id}`);
  assert.equal(files.some((e) => e.clipId === 'v-plain'), false);
  assert.ok(files.some((e) => e.clipId === 'v-fx'));
});

/* ---------- Speed-changed clips inside cut segments ---------- */

test('Cut segment flattening (cutFlatten): the trimmed-off portion advances the media start by the rate, and the speed is carried down', () => {
  const p = {
    id: 'p', width: 1280, height: 720, fps: 30, duration: 20, media: [{ id: 'v1', kind: 'video', url: '/@media/v1.mp4' }],
    tracks: [{ id: 'ta', name: '序列 1', clips: [{ id: 'seg', cardId: '', cutId: 'B', cutOffset: 1, start: 2, end: 6, params: {} }] }],
    cuts: [{ id: 'A', name: 'Cut A' }, { id: 'B', name: 'Cut B', duration: 8, transitions: [], tracks: [{ id: 'tb', name: '序列 1', clips: [{ id: 'b1', cardId: '', mediaId: 'v1', mediaOffset: 3, speed: 2, start: 0, end: 8, params: {} }] }] }],
    activeCutId: 'A',
  };
  const v = flatPlanProject(p).tracks.flatMap((t) => t.clips).find((c) => c.id === 'seg~b1');
  assert.ok(v, 'The virtual clip produced by flattening');
  assert.equal(v.speed, 2);
  assert.equal(v.mediaOffset, 3 + 1 * 2, 'Trimming 1 second of timeline = 2 seconds of media');
});

/* ---------- Real-time playback rate ---------- */

test('Preview sync (mediaSync.planSync): the playback rate is based on the clip speed, and drift correction floats around it', async () => {
  const { planSync, MAX_RATE_SKEW } = await import(srcUrl('render/mediaSync.ts'));
  const base = { seeking: false, paused: false, playing: true, now: 10_000, lastSeekAt: 0 };
  assert.equal(planSync({ ...base, elTime: 5, target: 5 }).rate, 1, 'The default is still 1');
  assert.equal(planSync({ ...base, elTime: 5, target: 5, baseRate: 2 }).rate, 2, 'Plays at 2x when aligned');
  const behind = planSync({ ...base, elTime: 5, target: 5.25, baseRate: 2 }).rate;
  assert.ok(behind > 2 && behind <= 2 * (1 + MAX_RATE_SKEW), `When behind, speeds up above 2x, got ${behind}`);
  assert.equal(planSync({ ...base, playing: false, paused: true, elTime: 5, target: 5, baseRate: 0.5 }).rate, 0.5, 'Stays at the base rate when paused');
});

/* ---------- Captions, tracking trajectory ---------- */

test('Caption placement (captions): media seconds are converted to the timeline by speed, sentence length is divided by the rate', async () => {
  const { mapMediaTime, captionsFromTranscript } = await import(srcUrl('kernel/captions.ts'));
  const clips = [{ mediaId: 'v1', start: 10, end: 20, mediaOffset: 4, speed: 2 }];
  assert.equal(mapMediaTime(clips, 'v1', 8), 12, 'Media second 8 = timeline 10 + (8 − 4)/2');
  const plan = captionsFromTranscript(clips, 'v1', [{ start: 8, end: 10, text: 'Hello' }]);
  assert.deepEqual([plan.from, plan.to], [12, 13]);
});

test('Following the trajectory (motion): the start frame is converted by speed, and the stored step is in timeline seconds', async () => {
  const { buildClipMotion } = await import(srcUrl('kernel/motion.ts'));
  const xy = Array.from({ length: 100 }, (_, i) => [i, 0]);
  const visible = xy.map(() => true);
  const common = { xy, visible, media: { id: 'v1', width: 1280, height: 720, duration: 10 }, stage: { width: 1280, height: 720 }, card: { start: 2, end: 3 }, pointIndex: 0, whenHidden: 'hold' };
  const one = buildClipMotion({ ...common, clipOfMedia: { start: 0, mediaOffset: 1 } });
  const two = buildClipMotion({ ...common, clipOfMedia: { start: 0, mediaOffset: 1, speed: 2 } });
  assert.equal(one.motion.frameStep, 0.1);
  assert.equal(two.motion.frameStep, 0.05, 'Media has one point per 0.1 seconds, at 2x speed the timeline has one point per 0.05 seconds');
  assert.equal(two.motion.offsets.length, 21, 'A card\'s 1 second covers 2 seconds of media = 20 points + 1');
  assert.equal(one.motion.offsets.length, 11);
});

/* ---------- store ---------- */

test('store.setClipSpeed: keeps the in point, recomputes the end point from the new speed, changing back to 1 deletes the field; the second half of a split advances the media start by the rate', async () => {
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
  assert.deepEqual([clip('v').start, clip('v').end, clip('v').mediaOffset, clip('v').speed], [1, 3, 2, 2], '4 seconds of media at 2x speed = 2 seconds');
  r = actions.setClipSpeed('v', 0.5);
  assert.deepEqual([clip('v').start, clip('v').end, clip('v').speed], [1, 9, 0.5], 'The same portion of media at 0.5x = 8 seconds');
  r = actions.setClipSpeed('v', 0.5 * 4);
  r = actions.setClipSpeed('v', 1);
  assert.equal(r.ok, true);
  assert.equal('speed' in clip('v'), false, 'Changing back to 1 leaves no speed field (identity keys return verbatim to the original)');
  assert.deepEqual([clip('v').start, clip('v').end], [1, 5]);
  // Extending and hitting the next clip: pushes subsequent clips away (user decision, 2026-10-23),
  // without truncating
  r = actions.setClipSpeed('v', 0.25);
  assert.deepEqual(r, { ok: true, pushed: { clips: 1, by: 7 } });
  assert.equal(clip('v').end, 17, '0.25x needs 16 seconds, no trimming');
  assert.deepEqual([clip('img').start, clip('img').end], [17, 19], 'The image after it is pushed to 17');
  // Image clips cannot change speed
  assert.equal(actions.setClipSpeed('img', 2).ok, false);
  // Split: second-half asset start = 2 + (5 − 1) × 0.25, retaining speed
  const right = actions.splitClip('v', 5);
  assert.equal(right.speed, 0.25);
  assert.equal(right.mediaOffset, 2 + 4 * 0.25);
  // Speed-changed clips support audio-visual separation (user decision, 2026-10-23): the separated
  // audio clip carries the same speed; the video clip's original audio remains omitted (clip muted)
  const sep = actions.separateAudio('v');
  assert.equal(sep.ok, true);
  const sound = clip(sep.audioClipId);
  assert.equal(sound.speed, 0.25, 'The separated sound clip carries the speed');
  assert.equal(getState().project.media.find((m) => m.id === sound.mediaId).kind, 'audio');
  assert.equal(clip('v').audioMuted, true, 'The video clip is muted (same as before the separation)');
  // A single speed change (along with pushed clips) = one undo step
  actions.undo(); actions.undo(); actions.undo();
  assert.equal(clip('v').speed, undefined);
  assert.deepEqual([clip('v').end, clip('img').start, clip('img').end], [5, 10, 12], 'The clips that were pushed aside move back together');
});

test('store.setClipSpeed push-aside: shortening leaves a gap at the tail; later clips shift as a whole (relative positions unchanged, gaps are absorbed first); a transition group is pushed as a whole; if it cannot be pushed, the whole change is rejected, with no truncation', async () => {
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
  assert.deepEqual(r, { ok: true }, 'Shortening does not push');
  assert.deepEqual([span('v'), span('a'), span('b'), span('other')], [[0, 2], [5, 8], [10, 13], [6, 9]], 'The tail is left empty, nothing else moves');

  load();
  r = actions.setClipSpeed('v', 0.5); // 4 → 8 s, overlaps 3 s with a (starts at 5)
  assert.deepEqual(r, { ok: true, pushed: { clips: 2, by: 3 } });
  assert.deepEqual([span('v'), span('a'), span('b')], [[0, 8], [8, 11], [13, 16]], 'a and b shift later as a whole by 3 seconds, the 2-second gap between a and b is still there');
  assert.deepEqual(span('other'), [6, 9], 'Clips on other tracks do not move');
  actions.undo();
  assert.deepEqual([span('v'), span('a'), span('b')], [[0, 4], [5, 8], [10, 13]], 'One undo step reverts everything');

  // Subsequent a and other on another track are bound in a crossfade: pushed together as a whole group
  load({ transitions: [{ id: 'x', kind: 'crossfade', aId: 'other', bId: 'a', dur: 1 }] });
  r = actions.setClipSpeed('v', 0.5);
  assert.equal(r.ok, true);
  assert.deepEqual([span('a'), span('b'), span('other')], [[8, 11], [13, 16], [9, 12]], 'A transition group is pushed as a whole, relative positions within the group unchanged');
  actions.undo();
  assert.deepEqual([span('a'), span('other')], [[5, 8], [6, 9]]);

  // A group member is on a locked track: cannot push, completely rejected with nothing modified
  // (no truncation)
  load({ lockB: true, transitions: [{ id: 'x', kind: 'crossfade', aId: 'other', bId: 'a', dur: 1 }] });
  const before = getState().project;
  r = actions.setClipSpeed('v', 0.5);
  assert.equal(r.ok, false);
  assert.match(r.error, /locked track/);
  assert.equal(getState().project, before, 'The project is unchanged on rejection');
  assert.equal(clip('v').speed, undefined);
});

test('store.setClipSpeed manual input: values outside 0.25-4 are rejected with a message (no clamping), decimals are rounded to hundredths', async () => {
  const { actions, getState } = await import(srcUrl('store/project.ts'));
  actions.loadProject({ version: 1, id: 'p-range', name: 't', width: 1280, height: 720, fps: 30, duration: 20, themeId: 'midnight',
    media: [{ id: 'v1', kind: 'video', name: 'v.mp4', url: '/@media/v1.mp4', duration: 60 }],
    tracks: [{ id: 'ta', name: '序列 1', clips: [{ id: 'v', cardId: '', mediaId: 'v1', start: 0, end: 4, params: {} }] }] });
  const clip = () => getState().project.tracks[0].clips[0];
  for (const bad of [0.2, 4.5, -1, 0]) {
    const r = actions.setClipSpeed('v', bad);
    assert.equal(r.ok, false, String(bad));
    assert.match(r.error, /between 0\.25 and 4x/);
  }
  assert.equal(clip().speed, undefined, 'Nothing is changed on rejection');
  assert.equal(actions.setClipSpeed('v', 1.333).ok, true);
  assert.equal(clip().speed, 1.33);
  assert.equal(actions.setClipSpeed('v', 4).ok, true, 'Boundary values are allowed');
});

test('store.setClipSpeed with a transition attached: the fade follows the two ends; when the clip before a crossfade changes speed, the next clip moves along and the overlap stays the same; reject if the transition does not fit', async () => {
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

  // Preceding clip a shortens (4 → 2 s): b shifts forward 2 s with it, overlap remains 1 s;
  // others stay untouched (gap left at tail)
  load();
  let r = actions.setClipSpeed('a', 2);
  assert.deepEqual(r, { ok: true, moved: ['b'] });
  assert.deepEqual([span('a'), span('b'), span('c'), span('d')], [[0, 2], [1, 5], [9, 12], [8, 10]]);
  assert.deepEqual([clip('a').fadeIn, clip('a').fadeOut, clip('b').fadeIn], [0.5, 1, 1], 'The transition duration is unchanged');
  actions.undo();
  assert.deepEqual([span('a'), span('b')], [[0, 4], [3, 7]], 'One undo step');

  // Preceding clip a lengthens (4 → 8 s): b shifts back 4 s to 7-11, colliding with d (starts at 8)
  // on the same track → d is pushed away; on a's own track, c (starts at 9) does not overlap with
  // a's new end point 8, so it stays untouched
  load();
  r = actions.setClipSpeed('a', 0.5);
  assert.equal(r.ok, true);
  assert.deepEqual([span('a'), span('b'), span('d'), span('c')], [[0, 8], [7, 11], [11, 13], [9, 12]]);
  actions.undo();
  assert.deepEqual([span('a'), span('b'), span('d')], [[0, 4], [3, 7], [8, 10]], 'One undo step reverts everything');

  // Subsequent clip b changes speed: start point stays fixed, a stays untouched
  load();
  r = actions.setClipSpeed('b', 2);
  assert.deepEqual(r, { ok: true });
  assert.deepEqual([span('a'), span('b')], [[0, 4], [3, 5]]);

  // Cannot fit transition (user decision, 2026-10-23: "Bubble notice is sufficient"): changing a to 4x
  // leaves only 1 s, shrinking the 1 s crossfade to 0.99 s, stated clearly in result; b moves
  // accordingly, overlap = 0.99
  load();
  r = actions.setClipSpeed('a', 4);
  assert.equal(r.ok, true);
  assert.deepEqual(r.transitions, [{ kind: 'crossfade', from: 1, to: 0.99 }]);
  assert.deepEqual(span('a'), [0, 1]);
  const near = (x, y) => Math.abs(x - y) < 1e-9;
  assert.ok(near(clip('b').start, 0.01) && near(clip('b').end, 4.01), `b moves to 0.01-4.01, got ${span('b')}`);
  assert.deepEqual([clip('a').fadeOut, clip('b').fadeIn, clip('a').fadeIn], [0.99, 0.99, 0.5], 'Fades at both ends change along, the 0.5-second fade-in fits and stays');
  assert.equal(getState().project.transitions.find((t) => t.id === 'x').dur, 0.99);
  const { speedChangeNotes } = await import('../../src/kernel/clipTime.mjs');
  assert.match(speedChangeNotes(r, 'a'), /Crossfade shortened accordingly: 1\.00 s → 0\.99 s/);
  actions.undo();
  assert.deepEqual([span('a'), span('b'), clip('a').fadeOut, getState().project.transitions.find((t) => t.id === 'x').dur], [[0, 4], [3, 7], 1, 1], 'One undo step, the transition comes back too');

  // Subsequent clip b changed to 4x leaves only 1 s: crossfade shrinks to 0.99 by shifting the entire
  // clip b backward 0.01 s (in point content unchanged)
  load();
  r = actions.setClipSpeed('b', 4);
  assert.equal(r.ok, true);
  assert.deepEqual(r.moved, ['b']);
  assert.ok(near(clip('b').start, 3.01) && near(clip('b').end, 4.01), `b is at 3.01-4.01, got ${span('b')}`);
  assert.equal(clip('a').end - clip('b').start < 0.99 + 1e-9 && clip('a').end - clip('b').start > 0.99 - 1e-9, true, 'Overlap 0.99');
});

test('Speed change of a sound clip (produced by audio-visual separation): it still sounds as usual, and both mixing paths and loudness measurement use the same ffmpegVarispeed', () => {
  const p = withClip({ ...fixture(), media: [...fixture().media, { id: 's1', kind: 'audio', url: '/@media/v1.mp4', soundOf: 'v1', duration: 20 }],
    tracks: [...fixture().tracks, { id: 't5', name: 'Sound', clips: [{ id: 's', cardId: '', mediaId: 's1', mediaOffset: 1, start: 0, end: 2, speed: 2, params: {} }] }] }, 'v-plain', { speed: 2 });
  const plan = audioPlanOf(p);
  const e = plan.find((x) => x.clipId === 's');
  assert.deepEqual([e.start, e.dur, e.offset, e.speed], [0, 2, 1, 2], 'The sound clip is in the manifest, with its speed');
  assert.equal(plan.some((x) => x.clipId === 'v-plain'), false, 'The video clip itself produces no original audio');
  assert.equal(plan.filter((x) => x.clipId !== 's').every((x) => !('speed' in x)), true, 'Other entries carry no speed');
  assert.deepEqual(ffmpegVarispeed(2), ['aresample=48000', 'asetrate=96000', 'aresample=48000']);
  assert.deepEqual(ffmpegVarispeed(1), []);
  const files = buildAudioPlan(p, 'out', () => true, (m) => `/x/${m.id}`);
  const f = files.find((x) => x.clipId === 's');
  const args = buildFfmpegArgs('v.mp4', [f], 'o.mp4', 4);
  const i = args.indexOf('/x/s1');
  assert.deepEqual(args.slice(i - 5, i + 1), ['-ss', '1', '-t', '4', '-i', '/x/s1'], 'The ffmpeg path reads 2 seconds × 2x media');
  assert.match(args[args.indexOf('-filter_complex') + 1], /\[1:a\]aresample=48000,asetrate=96000,aresample=48000,adelay=0:all=1/);
  // During export, both mix paths start from the wav prepared by playableAudioPlan (the Chrome
  // path's clip slicing is in audio-mix.mjs, which enters the snapshot key code fingerprint; do not
  // modify it)
  const rendered = [];
  const ready = playableAudioPlan(files, 'C:/ff/ffprobe.exe', () => true, (entry, ffmpegCmd) => { rendered.push([entry.clipId, entry.offset, entry.dur, entry.speed, ffmpegCmd]); return `/tmp/${entry.clipId}.wav`; });
  assert.deepEqual(rendered, [['s', 1, 2, 2, 'C:/ff/ffmpeg.exe']], 'Only speed-changed sound clips are rendered to wav first');
  const r2 = ready.find((x) => x.clipId === 's');
  assert.deepEqual([r2.file, r2.offset, r2.dur, 'speed' in r2, 'renderDir' in r2], ['/tmp/s.wav', 0, 2, false, false], 'Replaced by the rendered wav, read dur seconds from 0, no longer carries speed');
  assert.deepEqual(ready.filter((x) => x.clipId !== 's'), files.filter((x) => x.clipId !== 's'), 'Other entries unchanged');
  const m = timelineMixParts([{ ...f, file: '/x/s1' }], 4);
  assert.deepEqual(m.inputs, ['-ss', '1', '-t', '4', '-i', '/x/s1'], 'Loudness measurement uses the same one');
  assert.match(m.filters[0], /aresample=48000,asetrate=96000,aresample=48000,adelay/);
});

/* ---------- Speed-changed video clip as audio input for audio media effect card (user decision, 2026-10-23: "Allow.") ---------- */

test('Audio media effect card attached to a speed-changed video clip: the export manifest still accepts it (original audio still not output); the identity of the card sound is verbatim unchanged at 1x, and carries the rate when the speed changes', async () => {
  const withAudioCard = (speed) => {
    const p = fixture();
    p.cardNodes = [...p.cardNodes, { id: 'au', adapter: 'card', cardId: 'gain', kind: 'audio', params: {}, inputs: { source: { nodeId: '@clip/v-plain/source' } } }];
    return withClip(p, 'v-plain', { nodeId: 'au', ...(speed === 1 ? {} : { speed }) });
  };
  for (const speed of [1, 2]) {
    const plan = buildAudioPlan(withAudioCard(speed), 'out', () => true, () => '/media/v1.mp4');
    assert.equal(plan.filter((e) => e.clipId === 'v-plain' && !e.cardAudio).length, 0, 'Original audio taken over by the card (1x) / no original audio (speed-changed), neither goes into the manifest on its own');
    const card = plan.filter((e) => e.cardAudio && e.clipId === 'v-plain');
    assert.equal(card.length, 1, `${speed}x: the audio media effect card's entry is in the manifest`);
    assert.equal(card[0].nodeId, 'au');
  }
  const { cardAudioIdentity } = await import('../../src/kernel/cardAudioRendition.mjs');
  // Another audio-visual card reads a speed-changed clip as input: the input asset entry in identity
  const hooks = { getCard: () => ({ defaults: {} }), sourceVersionOf: () => 'v1' };
  const owner = { id: 'own', cardId: 'av', nodeId: 'avn', start: 0, end: 1 };
  const projectWith = (speed) => {
    const p = withAudioCard(speed);
    p.cardNodes = [...p.cardNodes, { id: 'avn', adapter: 'card', cardId: 'av', inputs: { source: { nodeId: '@clip/v-plain/source' } } }];
    p.tracks = [...p.tracks, { id: 't4', clips: [owner] }];
    return p;
  };
  const plain = cardAudioIdentity(projectWith(1), owner, hooks).inputs.source;
  assert.deepEqual(plain, { media: 'h-v1', offset: 1.5, rate: 1 }, '1x: verbatim identical to before, no speed item');
  assert.deepEqual(cardAudioIdentity(projectWith(2), owner, hooks).inputs.source, { ...plain, speed: 2 });
});

/* ---------- Integrated audio-visual card on a speed-changed clip produces sound as usual
   ((user decision, 2026-10-23) "Produce sound.", overturning [ruling] V21-28) ---------- */

const AV_WAV = { id: 'wav', kind: 'audio', url: `/@media/${'c'.repeat(64)}`, hash: 'c'.repeat(64) };
const AV_HOOKS = { getCard: (id) => (id === 'av' ? { defaults: {} } : DEFS[id]), sourceVersionOf: () => 'v1' };
/**
 * v-plain(mediaOffset 1.5, 0-4 s) has an attached integrated audio-visual card (node avn, reads
 * its own asset), with audio generated from the source clock at the time covering the entire clip
 */
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

test('Export mix manifest: an audio-visual card on a speed-changed clip enters the manifest as usual (the generated WAV is placed at 1x, without speed); a plain speed-changed video clip still produces no original audio', async () => {
  const one = audioPlanOf(await withAvCard(1));
  const av1 = one.find((e) => e.clipId === 'v-plain');
  assert.deepEqual(av1, { clipId: 'v-plain', trackId: 't2', mediaId: 'wav', start: 0, dur: 4, offset: 0, volume: 1, fadeIn: 0, fadeOut: 0, fx: null }, '1x: the same entry as before');
  for (const speed of [2, 0.5]) {
    const plan = audioPlanOf(await withAvCard(speed));
    assert.deepEqual(plan.find((e) => e.clipId === 'v-plain'), av1, `${speed}x: the same entry (the WAV is already timeline length, no further speed change)`);
    assert.deepEqual(plan.filter((e) => e.clipId !== 'v-plain'), one.filter((e) => e.clipId !== 'v-plain'), 'Other entries are unchanged');
    // The legacy ffmpeg path (mux-audio) uses the same manifest
    assert.ok(buildAudioPlan(await withAvCard(speed), 'out', () => true, (m) => `/x/${m.id}`).some((e) => e.clipId === 'v-plain' && !e.speed));
  }
  // Speed-changed video clips without an attached card still produce no original audio ([ruling] first edition)
  assert.equal(audioPlanOf(withClip(fixture(), 'v-plain', { speed: 2 })).some((e) => e.clipId === 'v-plain'), false);
});

test('Card clock of audio-visual cards (cardClockOffset / withMediaRates / flattenOverlay): bit-for-bit unchanged at 1x; speed-changed clip = mediaOffset ÷ rate, and the media-reading side makes up the same difference', async () => {
  const { cardClockOffset } = await import('../../src/kernel/clipTime.mjs');
  const { cardAudioSourceOffset } = await import('../../src/kernel/cardAudioRendition.mjs');
  const { flattenOverlay } = await import(srcUrl('kernel/project.ts'));
  assert.equal(cardClockOffset({ mediaOffset: 0.1 + 0.2 }), 0.1 + 0.2, '1x: the original value');
  assert.equal(cardClockOffset({ mediaOffset: 3, speed: 2 }), 1.5);
  assert.equal(cardClockOffset({ speed: 2 }), undefined, 'mediaOffset not written: left to the caller to fall back to the node\'s timeOffset');
  const one = await withAvCard(1);
  const raw1 = projectCardGraph(one, (id) => AV_HOOKS.getCard(id));
  assert.equal(withMediaRates(one, raw1), raw1, '1x: the same object');
  assert.equal(flattenOverlay(one).clips.find((c) => c.id === 'v-plain').sourceOffset, 1.5);
  for (const speed of [2, 0.5]) {
    const p = await withAvCard(speed);
    const raw = projectCardGraph(p, (id) => AV_HOOKS.getCard(id));
    const before = raw.nodes.find((n) => n.id === 'avn'), after = withMediaRates(p, raw).nodes.find((n) => n.id === 'avn');
    assert.equal(before.timeOffset, 1.5, 'projectCardGraph writes mediaOffset (media seconds)');
    assert.equal(after.timeOffset, 1.5 / speed, `${speed}x: card clock = mediaOffset ÷ rate`);
    // The position for reading its own asset does not change: card time + edge offset are the same
    assert.ok(Math.abs((after.timeOffset + after.inputs.source.offset) - (before.timeOffset + before.inputs.source.offset)) < 1e-12);
    const clip = p.tracks[1].clips[0];
    assert.equal(cardAudioSourceOffset(p, clip), 1.5 / speed, 'The source clock of the generated sound uses the same basis');
    assert.equal(flattenOverlay(p).clips.find((c) => c.id === 'v-plain').sourceOffset, 1.5 / speed, 'The t the stage gives the card component uses the same basis');
  }
});

test('store.splitClip: after splitting an audio-visual card on a speed-changed clip, the card clocks of the two halves line up, and the generated sound still covers both halves and is not judged stale', async () => {
  const { actions, getState } = await import(srcUrl('store/project.ts'));
  const { flattenOverlay } = await import(srcUrl('kernel/project.ts'));
  const { resolveCardAudioRendition } = await import('../../src/kernel/cardAudioRendition.mjs');
  for (const speed of [2, 0.5]) {
    const p = await withAvCard(speed);
    actions.loadProject({ version: 1, name: 't', ...p });
    const right = actions.splitClip('v-plain', 1.5);
    assert.ok(right, `${speed}x: it can be split`);
    const q = getState().project;
    const left = q.tracks[1].clips.find((c) => c.id === 'v-plain');
    assert.equal(right.mediaOffset, 1.5 + 1.5 * speed, 'The second half\'s media start advances by the rate');
    const flat = flattenOverlay(q).clips;
    const clockAt = (c, local) => flat.find((x) => x.id === c.id).sourceOffset + local;
    assert.ok(Math.abs(clockAt(right, 0) - clockAt(left, 1.5)) < 1e-9, `${speed}x: the card clocks on both sides of the cut point are the same (previously the second half would jump ${1.5 * (speed - 1)} seconds)`);
    const graph = withMediaRates(q, projectCardGraph(q, (id) => AV_HOOKS.getCard(id)));
    assert.ok(Math.abs(graph.nodes.find((n) => n.id === right.nodeId).timeOffset - clockAt(left, 1.5)) < 1e-9, 'The graph that picture and sound use has the same clock');
    assert.equal(resolveCardAudioRendition(q, left, AV_HOOKS).offset, 0);
    assert.ok(Math.abs(resolveCardAudioRendition(q, right, AV_HOOKS).offset - 1.5) < 1e-9, 'The second half plays from second 1.5 of the WAV');
  }
});
