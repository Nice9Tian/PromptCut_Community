/**
 * Expansion in multi-project mode (`server/render-node/expand.mjs`; mechanism
 * `mechanism/rendering.md` "Multi-project mode approach" item 1).
 * Run: npm test -- server/test/multi-project-expand.test.mjs (pure logic)
 *
 *   MPE1  Keep only clips mounted across these frames (including mount lead time); do not delete a
 *         single track, keep preserved clips unmodified; project-level settings intact
 *   MPE2  Dependencies: media effect cards include nodes and their input clips; transitions include
 *         both clips before and after; cut segments include clips at same time in referenced cut
 *   MPE3  Assets and effects library: keep only used ones; assets referenced in parameters by id,
 *         hash, or URL all count
 *   MPE4  "A segment of a card": keep all clips mounted throughout segment (including lower layer);
 *         specifically named cards must be kept
 *   MPE5  Frame viewing requests: frames requested by endpoints, named cards; unrecognized ones
 *         are not expanded
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { expandProject, lookNeed, expandLookBody, CARD_MOUNT_LEAD } from '../render-node/expand.mjs';
import { CARD_MOUNT_LEAD as STAGE_MOUNT_LEAD } from '../../src/render/frameWindow.mjs';

const H1 = '1'.repeat(64), H2 = '2'.repeat(64), H3 = '3'.repeat(64), H4 = '4'.repeat(64);
function demo() {
  return {
    id: 'p', name: 'demo', width: 640, height: 360, fps: 30, duration: 20, themeId: 'dark', style: { font: 'x' }, camera3dFov: 40,
    media: [
      { id: 'v1', kind: 'video', hash: H1, url: `/@media/${H1}` },
      { id: 'v2', kind: 'video', hash: H2, url: `/@media/${H2}` },
      { id: 'img', kind: 'image', hash: H3, url: `/@media/${H3}` },
      { id: 'unused', kind: 'image', hash: H4, url: `/@media/${H4}` },
    ],
    filters: [{ id: 'f1', kind: 'blur' }, { id: 'f-unused', kind: 'sepia' }],
    pixelMaps: [{ id: 'pm-unused', source: { mediaId: 'unused' } }],
    cardNodes: [
      { id: 'n-fx', adapter: 'card', cardId: 'user-fx', inputs: { source: { nodeId: '@clip/src/source' } } },
      { id: 'n-orphan', adapter: 'card', cardId: 'orphan-card', inputs: {} },
    ],
    transitions: [{ id: 'tr', kind: 'dissolve', aId: 'va', bId: 'vb', dur: 1 }],
    tracks: [
      { id: 'video', clips: [
        { id: 'va', mediaId: 'v1', cardId: '', start: 0, end: 5, params: {}, filter: { id: 'f1', params: {} } },
        { id: 'vb', mediaId: 'v2', cardId: '', start: 4, end: 9, params: {} },
      ] },
      { id: 'src-track', hidden: true, clips: [{ id: 'src', mediaId: 'img', cardId: '', start: 12, end: 14, params: {} }] },
      { id: 'cards', clips: [
        { id: 'c-early', cardId: 'title', start: 0, end: 2, params: { text: 'a' } },
        { id: 'c-mid', cardId: 'user-card', start: 2.5, end: 3.5, params: { image: `/@media/${H3}` } },
        { id: 'c-late', cardId: 'title', start: 10, end: 11, params: {} },
        { id: 'fx', cardId: 'user-fx', nodeId: 'n-fx', start: 6, end: 8, params: {} },
      ] },
      { id: 'seg-track', clips: [{ id: 'seg', cutId: 'cut-b', cardId: '', start: 15, end: 19, cutOffset: 1, params: {} }] },
    ],
    cuts: [
      { id: 'cut-a', name: 'A' },
      { id: 'cut-b', name: 'B', duration: 10, tracks: [{ id: 'b1', clips: [
        { id: 'b-early', cardId: 'title', start: 0, end: 1.5, params: {} },
        { id: 'b-hit', cardId: 'inner-card', start: 2, end: 4, params: {} },
        { id: 'b-late', cardId: 'title', start: 8, end: 9, params: {} },
      ] }] },
      { id: 'cut-c', name: 'C', duration: 3, tracks: [{ id: 'c1', clips: [{ id: 'c-only', cardId: 'title', start: 0, end: 3, params: {} }] }] },
    ],
    activeCutId: 'cut-a',
  };
}
const ids = (project) => project.tracks.flatMap((t) => t.clips.map((c) => c.id));

test('MPE1 keeps only the clips mounted on these frames; tracks are not deleted, clips are unchanged, project-level settings are unchanged', () => {
  const p = demo();
  const before = structuredClone(p);
  const r = expandProject(p, { times: [1] });
  console.log('[MPE1] t=1 kept', r.clipIds.join(','), '| cards', r.cardIds.join(','), '| media', r.mediaIds.join(','));
  assert.deepEqual(p, before, 'The input argument is not modified');
  assert.deepEqual(ids(r.project), ['va', 'vb', 'c-early'], 'vb is not present at this moment, but it has a transition with va, so it is kept too');
  assert.deepEqual(r.project.tracks.map((t) => t.id), ['video', 'src-track', 'cards', 'seg-track'], 'no track is deleted, order unchanged');
  assert.strictEqual(r.project.tracks[0].clips[0], p.tracks[0].clips[0], 'the kept clip is the original object, not a single character changed');
  for (const k of ['id', 'name', 'width', 'height', 'fps', 'duration', 'themeId', 'style', 'camera3dFov', 'activeCutId']) assert.deepEqual(r.project[k], p[k], `project-level setting ${k} unchanged`);
  // Mount lead time: cards starting at 2.5 are already mounted at 2.45; include one extra frame (superset)
  assert.ok(expandProject(p, { times: [2.46] }).clipIds.includes('c-mid'), 'within the lead time counts as mounted');
  assert.ok(!expandProject(p, { times: [2.3] }).clipIds.includes('c-mid'), 'anything more than the lead time plus one frame away from the start is not kept');
  assert.equal(CARD_MOUNT_LEAD, STAGE_MOUNT_LEAD, 'the mount lead time is the same number as the stage\'s');
  // Frame number is equivalent to timestamp
  assert.deepEqual(expandProject(p, { frames: [30] }).clipIds, expandProject(p, { times: [1] }).clipIds);
});

test('MPE2 dependencies: the inputs of a media effect card, both sides of a transition, and the clips at the same moment within a cut segment', () => {
  const p = demo();
  // At 6.5s: media effect card fx is mounted, its input is src at 12s on a hidden track (not at this moment)
  const fx = expandProject(p, { times: [6.5] });
  console.log('[MPE2] t=6.5 kept', fx.clipIds.join(','), '| nodes', fx.nodeIds.join(','));
  assert.ok(fx.clipIds.includes('fx') && fx.clipIds.includes('src'), 'the input clips are kept too');
  assert.deepEqual(fx.nodeIds, ['n-fx'], 'only reachable nodes are kept, unused nodes are dropped');
  assert.ok(fx.cardIds.includes('user-fx') && !fx.cardIds.includes('orphan-card'));
  // vb is mounted at 6.5 and has a transition with va: va is also kept, transition record is kept too
  assert.ok(fx.clipIds.includes('va') && fx.clipIds.includes('vb'));
  assert.deepEqual(fx.project.transitions.map((t) => t.id), ['tr']);
  // Only requested 1s (va is present, vb is not): transition brings vb along
  assert.ok(expandProject(p, { times: [1] }).project.transitions.length === 1);
  assert.deepEqual(expandProject(p, { times: [10.5] }).project.transitions, [], 'a transition with neither side present is not kept');
  // Cut segment: parent time 16 → 16 - 15 + 1 = 2s in segment, mounting b-hit
  const seg = expandProject(p, { times: [16] });
  console.log('[MPE2] t=16 kept', seg.clipIds.join(','), '| cuts', seg.cutIds.join(','));
  assert.ok(seg.clipIds.includes('seg') && seg.clipIds.includes('b-hit'));
  assert.ok(!seg.clipIds.includes('b-early') && !seg.clipIds.includes('b-late'));
  const b = seg.project.cuts.find((c) => c.id === 'cut-b');
  assert.deepEqual(b.tracks[0].clips.map((c) => c.id), ['b-hit']);
  assert.deepEqual(seg.project.cuts.find((c) => c.id === 'cut-c').tracks[0].clips, [], 'clips in an unreferenced cut are not kept (the entry stays)');
  assert.deepEqual(seg.cutIds, ['cut-b']);
});

test('MPE3 media and the effects library keep only what is used; media referenced by address in parameters counts too', () => {
  const p = demo();
  const r = expandProject(p, { times: [3] }); // va (filter f1, asset v1), c-mid (references img URL in parameters)
  console.log('[MPE3] t=3 media', r.mediaIds.join(','), '| filters', r.project.filters.map((f) => f.id).join(','));
  assert.deepEqual(r.mediaIds, ['v1', 'v2', 'img'], 'v2 is the media of vb, pulled in by the transition');
  assert.deepEqual(r.project.filters.map((f) => f.id), ['f1']);
  assert.deepEqual(r.project.pixelMaps, []);
  assert.ok(!r.mediaIds.includes('unused'));
});

test('MPE4 one segment of a card: everything mounted during the whole segment is kept (including lower layers); explicitly named ones are always kept', () => {
  const p = demo();
  const r = expandProject(p, { spans: [[2.5, 3.5]], clipIds: ['c-mid'] });
  assert.deepEqual(r.clipIds.sort(), ['c-mid', 'va', 'vb'].sort(), 'the lower layer (va) mounted during this segment is kept too, and va\'s transition brings in vb');
  // Specifically named clips are kept even if not within the requested time
  assert.ok(expandProject(p, { times: [0.5], clipIds: ['c-late'] }).clipIds.includes('c-late'));
  // Specifically named cut segment: takes the entire exposed window (segment 15-19, starting from 1s
  // in referenced cut → 1-5s in segment; b-late starting at 8s is not exposed)
  const seg = expandProject(p, { times: [0], clipIds: ['seg'] });
  assert.ok(seg.clipIds.includes('b-early') && seg.clipIds.includes('b-hit'));
  assert.ok(!seg.clipIds.includes('b-late'));
});

test('MPE5 frame-view request: the requested frames and the named cards; unrecognized ones are not expanded', () => {
  const p = demo();
  assert.deepEqual(lookNeed('/api/vision/snapshot', { project: p, t: 1 }).need.clipIds, []);
  // times: clamped within duration; both original timestamp and actually rendered frame count
  const many = lookNeed('/api/vision/snapshot', { project: p, times: [1, 99] }).need.times;
  assert.ok(many.includes(1) && many.some((x) => Math.abs(x - (20 * 30 - 1) / 30) < 1e-9), 'times beyond the duration use the last frame');
  // Specifically named clip without timestamp: takes the midpoint of this clip (consistent with worker
  // process)
  assert.deepEqual(lookNeed('/api/vision/snapshot', { project: p, clipId: 'c-mid' }).need, { times: [3, 3], clipIds: ['c-mid'] });
  assert.equal(lookNeed('/api/vision/snapshot', { project: p, clipId: 'nope' }), null, 'no such clip: forwarded as is, letting the worker process answer');
  assert.deepEqual(lookNeed('/api/vision/bake', { project: p, clipId: 'c-mid' }).need, { spans: [[2.5, 3.5]], clipIds: ['c-mid'] });
  assert.equal(lookNeed('/api/ai/visual', { tool: 'get_gif', clipId: 'c-mid', after: p }).key, 'after');
  assert.equal(lookNeed('/api/ai/visual', { tool: 'see_frames', images: [] }), null);
  assert.equal(lookNeed('/api/ai/visual/render', { key: 'abc' }), null);
  const { body, expanded } = expandLookBody('/api/cards/layout', { project: p, t: 1, clipIds: ['c-late'] });
  assert.deepEqual(ids(body.project).sort(), ['c-early', 'c-late', 'va', 'vb'].sort());
  assert.equal(expanded.clipIds.length, 4);
  const same = { project: p, nothing: true };
  assert.strictEqual(expandLookBody('/api/whatever', same).body, same);
});
