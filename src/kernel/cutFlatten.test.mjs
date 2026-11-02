// Flattened view of cut segments (`cutFlatten.mjs`): cards in cut segments enter the plan side one
// by one. Run: node --test src/kernel/cutFlatten.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FLAT_SEP, flatPlanProject, flatInfoOf, isFlatClipId, isolatedFlatProject, withFlatNodes } from './cutFlatten.mjs';

const card = (id, start, end, extra = {}) => ({ id, cardId: 'punch-pill', params: { text: id }, start, end, ...extra });

/**
 * On active cut A: top-level card T, cut segment S (2~6s, offset 1) references B; inside B,
 * heavy card H (0~10), light card L (3~4), cut segment S2 references C; inside C, card X
 */
function fixture() {
  return {
    id: 'p', width: 1920, height: 1080, fps: 30, duration: 10, activeCutId: 'A',
    media: [], cardNodes: [],
    tracks: [
      { id: 't1', clips: [card('T', 0, 10)] },
      { id: 't2', clips: [{ id: 'S', cardId: '', cutId: 'B', cutOffset: 1, start: 2, end: 6, frame: { x: 100, y: 50, w: 960, h: 540 } }] },
    ],
    cuts: [
      { id: 'A', name: 'Cut 1' },
      { id: 'B', name: 'Cut 2', duration: 8, tracks: [
        { id: 'b1', clips: [card('H', 0, 10, { frame: { x: 0, y: 0, w: 800, h: 400 } }), card('L', 3, 4)] },
        { id: 'b2', clips: [{ id: 'S2', cardId: '', cutId: 'C', cutOffset: 0, start: 4, end: 5 }] },
        { id: 'b3', hidden: true, clips: [card('Z', 0, 8)] },
      ] },
      { id: 'C', name: 'Cut 3', duration: 5, tracks: [{ id: 'c1', clips: [card('X', 0, 5)] }] },
    ],
  };
}

test('A project with no cut segments returns the same object unchanged', () => {
  const p = { tracks: [{ id: 't', clips: [card('a', 0, 1)] }], cuts: [{ id: 'A' }], activeCutId: 'A' };
  assert.equal(flatPlanProject(p), p);
  assert.equal(withFlatNodes(p, { nodes: [{ id: '@clip/a/source' }], outputs: [] }).nodes[0].flat, undefined);
});

test('A cut segment is replaced by the cards inside it: shifted, cropped to the exposed window, any depth, with lead and chains', () => {
  const p = fixture();
  const flat = flatPlanProject(p);
  assert.equal(flatPlanProject(p), flat, 'The same project is memoized');
  assert.equal(flatPlanProject(flat), flat, 'Flattening the flattened view again gives back itself');
  const clips = new Map(flat.tracks.flatMap((t) => t.clips.map((c) => [c.id, { c, t }])));
  assert.ok(!clips.has('S'), 'The segment itself is not in the flattened view');
  assert.ok(clips.has('T'));
  // shift = 2 − 1 = 1: H in parent time [1, 11), visible window [2, 6)
  const H = clips.get(`S${FLAT_SEP}H`).c;
  assert.deepEqual([H.start, H.end], [2, 6]);
  assert.equal(flatInfoOf(H).lead, 1);
  assert.equal(flatInfoOf(H).mount, 1);
  assert.deepEqual(H.frame, { x: 0, y: 0, w: 800, h: 400 }, 'The frame is copied from the inner clip unchanged');
  assert.deepEqual(flatInfoOf(H).chain.map((s) => s.id), ['S']);
  const L = clips.get(`S${FLAT_SEP}L`).c;
  assert.deepEqual([L.start, L.end, flatInfoOf(L).lead], [4, 5, 0]);
  // S2 in parent time [5, 6), C's X is visible there [5, 6)
  const X = clips.get(`S${FLAT_SEP}S2${FLAT_SEP}X`).c;
  assert.deepEqual([X.start, X.end, flatInfoOf(X).lead], [5, 6, 0]);
  assert.deepEqual(flatInfoOf(X).chain.map((s) => s.id), ['S', 'S2']);
  assert.ok(isFlatClipId(X.id) && !isFlatClipId('T'));
  assert.ok(!clips.has(`S${FLAT_SEP}Z`), 'Hidden tracks are not flattened');
  // Painter's order: virtual track inserted at segment track's position (below t1, above remaining
  // clips of t2)
  const order = flat.tracks.map((t) => t.id);
  assert.equal(order[0], 't1');
  assert.equal(order[order.length - 1], 't2');
});

test('A referenced cut gets shorter: the part beyond the total duration is not exposed', () => {
  const p = fixture();
  p.cuts[1].duration = 3; // shift 1: cut time 3 → parent time 4
  const H = flatPlanProject(p).tracks.flatMap((t) => t.clips).find((c) => c.id === `S${FLAT_SEP}H`);
  assert.deepEqual([H.start, H.end], [2, 4]);
});

test('Dangling or cyclic segments are not flattened, and do not throw', () => {
  const p = fixture();
  p.tracks[1].clips[0].cutId = 'NOPE';
  assert.ok(!flatPlanProject(p).tracks.flatMap((t) => t.clips).some((c) => isFlatClipId(c.id)));
  const q = fixture();
  q.cuts[2].tracks[0].clips.push({ id: 'BACK', cardId: '', cutId: 'B', start: 0, end: 1 });
  const ids = flatPlanProject(q).tracks.flatMap((t) => t.clips).map((c) => c.id);
  assert.ok(!ids.some((id) => id.includes('BACK')));
});

test('Changing only one card in the referenced cut: only that card\'s virtual clip changes', () => {
  const a = flatPlanProject(fixture());
  const p = fixture();
  p.cuts[1].tracks[0].clips[1] = { ...p.cuts[1].tracks[0].clips[1], params: { text: 'changed' } };
  const b = flatPlanProject(p);
  const of = (flat, id) => JSON.stringify(flat.tracks.flatMap((t) => t.clips).find((c) => c.id === id));
  assert.equal(of(a, `S${FLAT_SEP}H`), of(b, `S${FLAT_SEP}H`));
  assert.notEqual(of(a, `S${FLAT_SEP}L`), of(b, `S${FLAT_SEP}L`));
});

test('The same referenced cut is referenced twice: each instance gets its own id and its own exposed window', () => {
  const p = fixture();
  p.tracks.push({ id: 't3', clips: [{ id: 'S3', cardId: '', cutId: 'B', cutOffset: 0, start: 7, end: 9 }] });
  const ids = flatPlanProject(p).tracks.flatMap((t) => t.clips).map((c) => c.id);
  assert.ok(ids.includes(`S${FLAT_SEP}H`) && ids.includes(`S3${FLAT_SEP}H`));
});

test('withFlatNodes adds flat to the base node of a virtual clip; an isolated project keeps only the segments on the chain and the target card', () => {
  const p = fixture();
  const flat = flatPlanProject(p);
  const id = `S${FLAT_SEP}S2${FLAT_SEP}X`;
  const graph = withFlatNodes(flat, { nodes: [{ id: `@clip/${id}/source`, clipId: id }, { id: '@clip/T/source', clipId: 'T' }], outputs: [] });
  assert.equal(graph.nodes[0].flat.lead, 0);
  assert.deepEqual(graph.nodes[0].flat.chain.map((s) => s.id), ['S', 'S2']);
  assert.equal(graph.nodes[1].flat, undefined);
  const iso = isolatedFlatProject(p, id, (c) => ({ ...c, frame: { x: 10, y: 20, w: 1, h: 1 } }));
  const visible = (tracks) => tracks.filter((t) => !t.hidden).flatMap((t) => t.clips.map((c) => c.id));
  assert.deepEqual(visible(iso.tracks), ['S']);
  const S = iso.tracks.find((t) => !t.hidden).clips[0];
  assert.equal(S.frame, undefined, 'The segment drops its frame, nested scene 1:1');
  assert.equal(S.cutOffset, 1);
  assert.deepEqual(visible(iso.cuts.find((c) => c.id === 'B').tracks), ['S2']);
  assert.deepEqual(visible(iso.cuts.find((c) => c.id === 'C').tracks), ['X']);
  assert.deepEqual(iso.cuts.find((c) => c.id === 'C').tracks.find((t) => !t.hidden).clips[0].frame, { x: 10, y: 20, w: 1, h: 1 });
  assert.equal(p.tracks[1].clips[0].frame.w, 960, 'The original project is not modified');
  assert.equal(isolatedFlatProject(p, 'T'), null);
});
