/**
 * Input signature for track streams (`streamInputSig.mjs`): recorded per row in layer table
 * `streams` table; page computes the same from current project, streams that do not match are not
 * played.
 * Run: node --test src/render/streamInputSig.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { streamInputSig, streamInputs, streamSigStale, STREAM_INPUT_SIG_VERSION } from './streamInputSig.mjs';
import { clipInputSig } from './layerInputSig.mjs';

const project = () => ({
  id: 'p', width: 1920, height: 1080, fps: 30, duration: 10, themeId: 'dark', style: {}, media: [{ id: 'm1', kind: 'video', hash: 'h1' }], filters: [], pixelMaps: [], cardNodes: [],
  tracks: [
    { id: 't-top', clips: [{ id: 'a', cardId: 'punch-pill', start: 1, end: 3, params: { text: 'a' }, frame: { x: 10, y: 20, w: 640, h: 360 }, opacity: 1 }] },
    { id: 't-mid', clips: [{ id: 'b', cardId: 'particles', start: 0, end: 4, params: { seed: 3 } }] },
    { id: 't-low', clips: [{ id: 'v', mediaId: 'm1', start: 0, end: 10 }] },
  ],
});
const edit = (fn) => { const p = structuredClone(project()); fn(p); return p; };
const clipOf = (p, id) => p.tracks.flatMap((t) => t.clips).find((c) => c.id === id);
const card = { clipIds: ['a'], kind: 'card' };
const group = { clipIds: ['b', 'a'], kind: 'group' };

test('shape: carries a version prefix; the same input yields the same value on both sides; the same after a JSON round trip', () => {
  const p = project();
  const sig = streamInputSig(p, card);
  assert.match(sig, new RegExp(`^s${STREAM_INPUT_SIG_VERSION}-[0-9a-f]{16}$`));
  assert.equal(streamInputSig(JSON.parse(JSON.stringify(p)), card), sig);
  assert.equal(streamInputSig(p, { clipIds: ['a'] }), sig, 'a single member without kind is treated as a single-card stream');
  assert.notEqual(streamInputSig(p, group), sig);
});

test('member not in the project, or no members: returns null (no comparison)', () => {
  assert.equal(streamInputSig(project(), { clipIds: ['nope'], kind: 'card' }), null);
  assert.equal(streamInputSig(project(), { clipIds: [], kind: 'card' }), null);
  assert.equal(streamInputSig(project(), { clipIds: ['a', 'nope'], kind: 'group' }), null);
  assert.equal(streamInputSig(null, card), null);
});

test('single-card stream: changes to params, whole-frame shift of the clip, or duration count as a change; position, opacity, fade in/out do not', () => {
  const base = streamInputSig(project(), card);
  assert.notEqual(streamInputSig(edit((p) => { clipOf(p, 'a').params.text = 'b'; }), card), base, 'Parameters');
  // Snapshot layer signature ignores whole-frame translation (snapshots are fetched by local frame);
  // streams are segmented by global frame number, so every frame mismatches after translation
  const moved = edit((p) => { const c = clipOf(p, 'a'); c.start += 1; c.end += 1; });
  assert.equal(clipInputSig(moved, 'a'), clipInputSig(project(), 'a'), 'control: the snapshot layer signature is unchanged');
  assert.notEqual(streamInputSig(moved, card), base, 'whole-frame shift');
  assert.notEqual(streamInputSig(edit((p) => { clipOf(p, 'a').end = 3.5; }), card), base, 'Duration');
  // Single-card stream is drawn in wrapper layer's own coordinates; these are added by stage wrapper layer
  assert.equal(streamInputSig(edit((p) => { const c = clipOf(p, 'a'); c.frame.x = 500; c.frame.y = 9; c.opacity = 0.5; c.fadeIn = 0.3; }), card), base, 'position, opacity, fade in');
  assert.notEqual(streamInputSig(edit((p) => { clipOf(p, 'a').frame.w = 800; }), card), base, 'frame width and height');
  // Modifications to other clips are irrelevant
  assert.equal(streamInputSig(edit((p) => { clipOf(p, 'b').params.seed = 9; clipOf(p, 'b').start = 0.5; }), card), base);
});

test('project duration: only counts as a change when it truncates this stream', () => {
  const base = streamInputSig(project(), card);
  assert.equal(streamInputSig(edit((p) => { p.duration = 20; }), card), base, 'lengthened, stream not truncated');
  assert.notEqual(streamInputSig(edit((p) => { p.duration = 2; }), card), base, 'shortened into the middle of the clip, stream truncated');
});

test('group stream: member placement, stacking order, and another layer inserted in between all count as a change', () => {
  const base = streamInputSig(project(), group);
  assert.notEqual(streamInputSig(edit((p) => { clipOf(p, 'a').frame.x = 500; }), group), base, 'Position');
  assert.notEqual(streamInputSig(edit((p) => { clipOf(p, 'a').opacity = 0.5; }), group), base, 'Opacity');
  assert.notEqual(streamInputSig(edit((p) => { clipOf(p, 'b').fadeOut = 0.4; }), group), base, 'Fade out');
  assert.notEqual(streamInputSig(edit((p) => { clipOf(p, 'b').params.seed = 9; }), group), base, 'member params');
  assert.notEqual(streamInputSig(edit((p) => { p.tracks = [p.tracks[1], p.tracks[0], p.tracks[2]]; }), group), base, 'two members swapped top and bottom');
  // Inserting a track between two members (temporally overlapping): group stream z-order is invalidated
  const between = edit((p) => { p.tracks.splice(1, 0, { id: 't-new', clips: [{ id: 'x', cardId: 'odometer', start: 2, end: 2.5 }] }); });
  assert.notEqual(streamInputSig(between, group), base, 'a layer inserted in between');
  assert.deepEqual(streamInputs(between, group).between, ['x']);
  // Inserted outside, or intermediate layer does not temporally overlap, or is a hidden track: irrelevant
  assert.equal(streamInputSig(edit((p) => { p.tracks.unshift({ id: 't-new', clips: [{ id: 'x', cardId: 'odometer', start: 2, end: 2.5 }] }); }), group), base, 'inserted at the very top');
  assert.equal(streamInputSig(edit((p) => { p.tracks.splice(1, 0, { id: 't-new', clips: [{ id: 'x', cardId: 'odometer', start: 6, end: 7 }] }); }), group), base, 'the middle layer does not overlap in time');
  assert.equal(streamInputSig(edit((p) => { p.tracks.splice(1, 0, { id: 't-new', hidden: true, clips: [{ id: 'x', cardId: 'odometer', start: 2, end: 2.5 }] }); }), group), base, 'the middle one is a hidden track');
  assert.deepEqual(streamInputs(project(), group).paint, ['b', 'a'], 'painter\'s order: lower ones first');
});

test('stream depending on lower layers: the target card\'s appearance, and each lower layer\'s content, placement, time and stacking order all count; upper layers do not; the cross-check of server and page on the same change is in server/test/below-stream.test.mjs', () => {
  const below = { clipIds: ['a'], kind: 'below' };
  const base = streamInputSig(project(), below);
  assert.match(base, new RegExp(`^s${STREAM_INPUT_SIG_VERSION}-[0-9a-f]{16}$`));
  assert.notEqual(base, streamInputSig(project(), card), 'not the same signature as the single-card stream');
  assert.equal(streamInputSig(JSON.parse(JSON.stringify(project())), below), base);
  const inputs = streamInputs(project(), below);
  assert.equal(inputs.kind, 'below');
  assert.deepEqual(inputs.members.map((m) => m.id), ['a']);
  assert.deepEqual(inputs.below.map((m) => m.id), ['v', 'b'], 'painter\'s order: lower ones first');
  assert.equal(inputs.below[1].sig, clipInputSig(project(), 'b'));
  assert.deepEqual(inputs.members[0].window, { firstFrame: 30, count: 60, last: 89 });
  // Target card: this kind of stream is produced in stage coordinates, position and appearance
  // are baked into the stream (single-card streams ignore these)
  assert.notEqual(streamInputSig(edit((p) => { clipOf(p, 'a').frame.x = 500; }), below), base, 'target card position');
  assert.notEqual(streamInputSig(edit((p) => { clipOf(p, 'a').opacity = 0.5; }), below), base, 'target card opacity');
  assert.notEqual(streamInputSig(edit((p) => { clipOf(p, 'a').params.text = 'b'; }), below), base, 'target card params');
  // Lower layer
  assert.notEqual(streamInputSig(edit((p) => { clipOf(p, 'b').params.seed = 9; }), below), base, 'lower layer params');
  assert.notEqual(streamInputSig(edit((p) => { clipOf(p, 'b').frame = { x: 1, y: 2, w: 300, h: 200 }; }), below), base, 'lower layer position');
  assert.notEqual(streamInputSig(edit((p) => { clipOf(p, 'b').start = 0.5; }), below), base, 'lower layer time');
  assert.notEqual(streamInputSig(edit((p) => { clipOf(p, 'v').mediaOffset = 2; }), below), base, 'lower layer asset offset');
  assert.notEqual(streamInputSig(edit((p) => { p.tracks = [p.tracks[0], p.tracks[2], p.tracks[1]]; }), below), base, 'Two lower layers swap their stacking order');
  assert.notEqual(streamInputSig(edit((p) => { p.tracks.push({ id: 't-new', clips: [{ id: 'x', cardId: 'odometer', start: 2, end: 2.5 }] }); }), below), base, 'one more layer below');
  assert.notEqual(streamInputSig(edit((p) => { p.tracks.pop(); }), below), base, 'one layer fewer below');
  assert.notEqual(streamInputSig(edit((p) => { p.tracks[1].hidden = true; }), below), base, 'the track below is hidden');
  // Upper layers, or lower layers that do not temporally overlap: irrelevant
  assert.equal(streamInputSig(edit((p) => { p.tracks.unshift({ id: 't-new', clips: [{ id: 'x', cardId: 'odometer', start: 0, end: 9, params: { n: 1 } }] }); }), below), base, 'one layer added above');
  assert.equal(streamInputSig(edit((p) => { p.tracks.push({ id: 't-new', clips: [{ id: 'x', cardId: 'odometer', start: 6, end: 7 }] }); }), below), base, 'the layer below does not overlap in time');
  assert.equal(streamInputSig(edit((p) => { p.tracks.push({ id: 't-new', hidden: true, clips: [{ id: 'x', cardId: 'odometer', start: 0, end: 9 }] }); }), below), base, 'the track below is hidden');
  // Cannot compute: more than one member, target is not in project, track containing target is hidden
  assert.equal(streamInputSig(project(), { clipIds: ['a', 'b'], kind: 'below' }), null);
  assert.equal(streamInputSig(project(), { clipIds: ['nope'], kind: 'below' }), null);
  assert.equal(streamInputSig(edit((p) => { p.tracks[0].hidden = true; }), below), null);
  // Other kinds are unaffected: single members with omitted kind or kind "card" still use single-card stream signatures
  assert.equal(streamInputSig(project(), { clipIds: ['a'] }), streamInputSig(project(), card));
});

test('streamSigStale: stale only when both sides have a signature, same version, and they differ', () => {
  assert.equal(streamSigStale('s1-aaaa', 's1-bbbb'), true);
  assert.equal(streamSigStale('s1-aaaa', 's1-aaaa'), false);
  assert.equal(streamSigStale(undefined, 's1-aaaa'), false);
  assert.equal(streamSigStale('s1-aaaa', null), false);
  assert.equal(streamSigStale('s9-aaaa', 's1-aaaa'), false, 'different versions are not compared');
  assert.equal(streamSigStale('i1-aaaa', 's1-aaaa'), false, 'signatures that are not stream signatures are not compared');
});
