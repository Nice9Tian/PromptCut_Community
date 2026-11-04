/**
 * Three-way merge for cloud groups (`src/start/orgMerge.ts`, ruling V22-08).
 * Run: npm test -- src/start/orgMerge.test.mjs
 *
 *   ORGM-01 Both sides each add a group: keep both
 *   ORGM-02 Both sides modify the same project's ownership: my side wins; modified different
 *     fields: keep both
 *   ORGM-03 One side deletes while other modifies: keep modified; unmodified counts as deleted;
 *     deleting a group moves projects back to ungrouped
 *   ORGM-04 Order: use mine if I modified it, use other's if not; additions from the other side
 *     are inserted after their previous neighbor
 *   ORGM-05 No base (first time, cache lost): take union of both sides
 *   ORGM-06 Chat entries align by "project + chat", merging pin and archive as usual
 *   ORGM-07 Response lost, retransmitted as is: cloud copy is what I just wrote, merge result
 *     unchanged (idempotent); inputs not mutated in place
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeList, mergeOrg } from './orgMerge.ts';

const org = (o = {}) => ({ v: 1, realm: 'cloud', groups: [], projects: [], chats: [], ...o });
const deepFreeze = (x) => { if (x && typeof x === 'object') { Object.values(x).forEach(deepFreeze); Object.freeze(x); } return x; };
const ids = (list) => list.map((x) => x.id);
const byId = (list, id) => list.find((x) => x.id === id);

test('ORGM-01 each side adds a group: both are kept, the original is still there', () => {
  const base = org({ groups: [{ id: 'g1', name: 'Original' }] });
  const mine = org({ groups: [{ id: 'g1', name: 'Original' }, { id: 'gM', name: 'Added by me' }] });
  const theirs = org({ groups: [{ id: 'g1', name: 'Original' }, { id: 'gT', name: 'Added by them' }] });
  const out = mergeOrg(base, mine, theirs);
  assert.deepEqual(ids(out.groups).sort(), ['g1', 'gM', 'gT']);
  assert.equal(ids(out.groups)[0], 'g1');
  assert.equal(out.realm, 'cloud');
  // Both sides each added the same id: the whole entry follows mine
  const clash = mergeOrg(base, org({ groups: [{ id: 'g1', name: 'Original' }, { id: 'gX', name: 'My name' }] }), org({ groups: [{ id: 'g1', name: 'Original' }, { id: 'gX', name: 'Their name' }] }));
  assert.equal(byId(clash.groups, 'gX').name, 'My name');
});

test('ORGM-02 both sides change the same project\'s assignment: mine wins; changes to different fields are both kept; flags not written as false do not appear out of nowhere', () => {
  const groups = [{ id: 'gA', name: 'A' }, { id: 'gB', name: 'B' }];
  const base = org({ groups, projects: [{ id: 'p1', groupId: null }, { id: 'p2', groupId: null }] });
  const mine = org({ groups, projects: [{ id: 'p1', groupId: 'gA' }, { id: 'p2', groupId: null, pinned: true }] });
  const theirs = org({ groups, projects: [{ id: 'p1', groupId: 'gB' }, { id: 'p2', groupId: null, archived: true }] });
  const out = mergeOrg(base, mine, theirs);
  assert.equal(byId(out.projects, 'p1').groupId, 'gA', 'Same field changed on both sides: mine wins');
  assert.deepEqual(byId(out.projects, 'p2'), { id: 'p2', groupId: null, pinned: true, archived: true }, 'Different fields: both kept');
  // Only the other side changed ownership, I did not: follow the other side
  const only = mergeOrg(base, base, org({ groups, projects: [{ id: 'p1', groupId: 'gB' }, { id: 'p2', groupId: null }] }));
  assert.equal(byId(only.projects, 'p1').groupId, 'gB');
  assert.deepEqual(byId(only.projects, 'p2'), { id: 'p2', groupId: null });
  // I unpinned, the other side did not: unpin takes effect, leaving no pinned: false
  const unpin = mergeOrg(org({ projects: [{ id: 'p', groupId: null, pinned: true }] }), org({ projects: [{ id: 'p', groupId: null }] }), org({ projects: [{ id: 'p', groupId: null, pinned: true }] }));
  assert.deepEqual(unpin.projects, [{ id: 'p', groupId: null }]);
});

test('ORGM-03 one side deletes, the other edits: the edited one stays; only unedited ones count as deleted; deleting a group puts its projects back to ungrouped', () => {
  const base = org({ groups: [{ id: 'g1', name: 'Old name' }, { id: 'g2', name: 'Another one' }, { id: 'g3', name: 'Third one' }], projects: [{ id: 'p1', groupId: 'g1' }, { id: 'p2', groupId: 'g2' }] });
  // I deleted g1, the other side renamed it afterwards → keep it, with the other side's new name
  let out = mergeOrg(base, org({ groups: base.groups.filter((g) => g.id !== 'g1'), projects: base.projects }), org({ groups: [{ id: 'g1', name: 'Name changed by them' }, base.groups[1], base.groups[2]], projects: base.projects }));
  assert.equal(byId(out.groups, 'g1').name, 'Name changed by them');
  assert.equal(byId(out.projects, 'p1').groupId, 'g1');
  // I deleted g2, the other side did not change it → truly deleted; projects inside return to
  // ungrouped
  out = mergeOrg(base, org({ groups: base.groups.filter((g) => g.id !== 'g2'), projects: base.projects }), base);
  assert.deepEqual(ids(out.groups), ['g1', 'g3']);
  assert.equal(byId(out.projects, 'p2').groupId, null);
  // The other side deleted g3, I pinned it afterwards → keep it, with my pin
  out = mergeOrg(base, org({ groups: [base.groups[0], base.groups[1], { id: 'g3', name: 'Third one', pinned: true }], projects: base.projects }), org({ groups: base.groups.slice(0, 2), projects: base.projects }));
  assert.deepEqual(byId(out.groups, 'g3'), { id: 'g3', name: 'Third one', pinned: true });
  // The other side deleted the project, I did not modify → truly deleted; what I modified
  // (archived) is kept
  const withP = org({ projects: [{ id: 'a', groupId: null }, { id: 'b', groupId: null }] });
  out = mergeOrg(withP, org({ projects: [{ id: 'a', groupId: null }, { id: 'b', groupId: null, archived: true }] }), org({ projects: [] }));
  assert.deepEqual(out.projects, [{ id: 'b', groupId: null, archived: true }]);
  // Both sides deleted: gone
  assert.deepEqual(mergeOrg(withP, org(), org()).projects, []);
  // The other side deleted the group, my side happened to put a project into it (I did not modify
  // the group itself): group is truly deleted, project returns to ungrouped
  out = mergeOrg(base, org({ groups: base.groups, projects: [{ id: 'p1', groupId: 'g3' }, base.projects[1]] }), org({ groups: base.groups.slice(0, 2), projects: base.projects }));
  assert.equal(byId(out.projects, 'p1').groupId, null);
});

test('ORGM-04 order: if I moved it, use mine; if I did not, use theirs; items added on the other side are inserted after their original previous neighbor', () => {
  const a = { id: 'a' }, b = { id: 'b' }, c = { id: 'c' }, d = { id: 'd' };
  const spec = { key: (x) => x.id, fields: [] };
  // I moved c to the front; the other side added d (after b)
  assert.deepEqual(ids(mergeList([a, b, c], [c, a, b], [a, b, d, c], spec)), ['c', 'a', 'b', 'd']);
  // I did not change order; the other side moved c to the front: follow the other side
  assert.deepEqual(ids(mergeList([a, b, c], [a, b, c], [c, a, b], spec)), ['c', 'a', 'b']);
  // I did not change order, but added d (at the end); the other side changed order: use the other
  // side's, my d is inserted after c (on my side it was after c)
  assert.deepEqual(ids(mergeList([a, b, c], [a, b, c, d], [c, b, a], spec)), ['c', 'd', 'b', 'a']);
  // Convention of placing newly added items at the front (projects) preserved: new project on my side
  // is at the front, the other side did not change order → still at the front
  assert.deepEqual(ids(mergeList([a, b], [d, a, b], [a, b], spec)), ['d', 'a', 'b']);
  // Group convention of "newly created at the end" preserved
  assert.deepEqual(ids(mergeList([a, b], [a, b, d], [a, b], spec)), ['a', 'b', 'd']);
});

test('ORGM-05 no base (first time, cache lost): contents from both sides are unioned, and mine wins for the same id', () => {
  const mine = org({ groups: [{ id: 'g1', name: 'Mine' }], projects: [{ id: 'p1', groupId: 'g1', pinned: true }] });
  const theirs = org({ groups: [{ id: 'g1', name: 'Theirs' }, { id: 'g2', name: 'Their extra' }], projects: [{ id: 'p1', groupId: null }, { id: 'p2', groupId: 'g2' }] });
  const out = mergeOrg(null, mine, theirs);
  assert.deepEqual(ids(out.groups).sort(), ['g1', 'g2']);
  assert.equal(byId(out.groups, 'g1').name, 'Mine');
  assert.deepEqual(ids(out.projects).sort(), ['p1', 'p2']);
  assert.deepEqual(byId(out.projects, 'p1'), { id: 'p1', groupId: 'g1', pinned: true });
});

test('ORGM-06 chat entries are matched by "project + chat": the same chat id in two projects does not interfere', () => {
  const base = org({ chats: [{ id: 'c', projectId: 'p1' }, { id: 'c', projectId: 'p2' }] });
  const mine = org({ chats: [{ id: 'c', projectId: 'p1', pinned: true }, { id: 'c', projectId: 'p2' }] });
  const theirs = org({ chats: [{ id: 'c', projectId: 'p1' }, { id: 'c', projectId: 'p2', archived: true }] });
  const out = mergeOrg(base, mine, theirs);
  assert.deepEqual(out.chats.find((x) => x.projectId === 'p1'), { id: 'c', projectId: 'p1', pinned: true });
  assert.deepEqual(out.chats.find((x) => x.projectId === 'p2'), { id: 'c', projectId: 'p2', archived: true });
});

test('ORGM-07 reply lost, resent as is: the cloud copy is exactly what I just wrote, so the merge result is unchanged; the input is not modified in place', () => {
  const base = org({ groups: [{ id: 'g1', name: 'Original' }] });
  const mine = org({ groups: [{ id: 'g1', name: 'changed' }, { id: 'g2', name: 'New one' }], projects: [{ id: 'p', groupId: 'g2', pinned: true }], chats: [{ id: 'c', projectId: 'p', archived: true }] });
  deepFreeze(base); deepFreeze(mine);
  const out = mergeOrg(base, mine, mine);
  assert.deepEqual(out, mine);
  // No changes at all: merged result is identical to the other side's
  const theirs = deepFreeze(org({ groups: [{ id: 'g9', name: 'Someone else\'s' }] }));
  assert.deepEqual(mergeOrg(theirs, theirs, theirs), theirs);
});
