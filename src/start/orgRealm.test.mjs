/**
 * Local groups and cloud groups (`src/start/vibeOrg.ts`). Run: npm test -- src/start/orgRealm.test.mjs
 *
 * (user decision, 2026-10-23): "Split into local groups (local Agent in desktop app) and cloud
 * groups. Cloud groups are stored in the cloud, local groups are stored locally. Local projects
 * cannot be placed into cloud groups (and vice versa for cloud into local)". Four things verified:
 *   ORGR-01/02 Local groups only accept local projects, cloud groups only accept cloud projects;
 *   ORGR-03/04 Cross-placing is blocked with an explanation (organization data left intact);
 *     groups of the other set are grayed out in context menu with an explanation;
 *   ORGR-05/06/07 Storage keys for both group sets do not overwrite each other; rejected if markers
 *     in content do not match; old keys before splitting sets are recognized once;
 *   ORGR-08 Guests have no cloud copy: cannot read or store without a realm;
 *   ORGR-09/10 Cloud group wording (connecting to cloud, old server changed phrasing) and cleanup.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLOUD_ORG_IN_CLOUD, LOCAL_ORG_SCOPE, addGroup, cloudOrgScope, emptyOrg, groupNoteText, groupsOf, loadOrg, mergeProjects, moveProject,
  moveRefusal, moveTargetsFor, orgKey, orgWhereText, parseOrg, pruneOrg, saveOrg, withGroups, withProjects,
} from './vibeOrg.ts';

/** A minimal localStorage: not in node, test cases set up their own, fresh copy per test */
function installStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
  return map;
}

const localDrafts = [
  { id: '20261023-aaaaaa', name: 'Local draft A', role: 'owned', realm: 'local' },
  { id: '20261023-bbbbbb', name: 'Local draft B', role: 'owned', realm: 'local' },
];
const cloudProjects = [
  { id: 'cloudproj01', name: 'Cloud project 1', role: 'owned', realm: 'cloud' },
  { id: 'cloudproj02', name: 'Cloud project 2', role: 'joined', realm: 'cloud' },
];
const mixed = [...localDrafts, ...cloudProjects];

test('ORGR-01 local groups only take local projects: cloud projects mixed into the manifest do not appear, and only local projects get placed into local groups', () => {
  const { org, id } = addGroup(emptyOrg('local'), 'media', () => 'l1');
  assert.equal(org.realm, 'local');
  const list = mergeProjects(org, mixed);
  assert.deepEqual(list.map((p) => p.id), ['20261023-aaaaaa', '20261023-bbbbbb']);
  assert.ok(list.every((p) => p.realm === 'local'));
  // Local project placed into local group: success
  const out = moveProject(org, list[0], id);
  assert.equal(out.refused, null);
  assert.equal(out.org.projects[0].groupId, id);
  // Even if someone forces a cloud project into writeback manifest, it cannot enter the local copy
  const cloudList = mergeProjects(addGroup(emptyOrg('cloud'), 'x').org, cloudProjects);
  const stuffed = withProjects(out.org, [...list, ...cloudList]);
  assert.deepEqual(stuffed.projects.map((p) => p.id).sort(), ['20261023-aaaaaa', '20261023-bbbbbb']);
});

test('ORGR-02 cloud groups only take cloud projects: local drafts mixed into the manifest do not appear, and only cloud projects get placed into cloud groups', () => {
  const { org, id } = addGroup(emptyOrg('cloud'), 'Client', () => 'c1');
  assert.equal(org.realm, 'cloud');
  const list = mergeProjects(org, mixed);
  assert.deepEqual(list.map((p) => p.id), ['cloudproj01', 'cloudproj02']);
  assert.ok(list.every((p) => p.realm === 'cloud'));
  const out = moveProject(org, list[1], id);
  assert.equal(out.refused, null);
  assert.equal(out.org.projects[0].groupId, id);
  // Groups from the local set will not be accepted by the cloud copy either
  assert.deepEqual(withGroups(org, [{ id: 'gx', name: 'From local', realm: 'local' }]).groups, []);
});

test('ORGR-03 cross-realm placement is blocked with an explanation: local projects do not go into cloud groups, cloud projects do not go into local groups; the organization data stays untouched', () => {
  const cloudOrg = addGroup(emptyOrg('cloud'), 'Client', () => 'c1');
  const localOrg = addGroup(emptyOrg('local'), 'media', () => 'l1');

  const a = moveProject(cloudOrg.org, { id: '20261023-aaaaaa', realm: 'local' }, cloudOrg.id);
  assert.equal(a.refused, 'A local project cannot be placed into a cloud group: local groups hold local projects, and cloud groups hold cloud projects.');
  assert.equal(a.org, cloudOrg.org, 'On refusal the same object is returned: nothing was changed');
  assert.deepEqual(a.org.projects, []);

  const b = moveProject(localOrg.org, { id: 'cloudproj01', realm: 'cloud' }, localOrg.id);
  assert.equal(b.refused, 'A cloud project cannot be placed into a local group: cloud groups hold cloud projects, and local groups hold local projects.');
  assert.equal(b.org, localOrg.org);

  // "Remove from group" (groupId = null) likewise cannot touch this copy for cross-realm projects
  assert.ok(moveProject(cloudOrg.org, { id: '20261023-aaaaaa', realm: 'local' }, null).refused);

  // That explanation sentence is determined solely by whether the two sets are the same
  assert.equal(moveRefusal('cloud', 'cloud'), null);
  assert.equal(moveRefusal('local', 'local'), null);
  assert.ok(moveRefusal('local', 'cloud') && moveRefusal('cloud', 'local'));
  assert.notEqual(moveRefusal('local', 'cloud'), moveRefusal('cloud', 'local'));
});

test('ORGR-04 right-click "Move to group": groups of the same realm are clickable, groups of the other realm are also listed, grayed out with an explanation; archived groups and the current group are not listed; a project already in a group gets an extra remove item', () => {
  const groups = [
    { id: 'gl', name: 'Local 1', realm: 'local' },
    { id: 'gc', name: 'Cloud 1', realm: 'cloud' },
    { id: 'gcc', name: 'Old cloud', realm: 'cloud', archived: true },
  ];
  const localProject = { realm: 'local', groupId: null };
  const t = moveTargetsFor(localProject, groups);
  assert.deepEqual(t.map((x) => x.id), ['gl', 'gc']);
  assert.equal(t[0].blocked, undefined);
  assert.equal(t[1].blocked, moveRefusal('local', 'cloud'));

  const cloudProject = { realm: 'cloud', groupId: 'gc' };
  const t2 = moveTargetsFor(cloudProject, groups);
  assert.deepEqual(t2.map((x) => x.id), ['gl', null]);
  assert.equal(t2[0].blocked, moveRefusal('cloud', 'local'));
  assert.equal(t2[1].blocked, undefined, 'Removing from a group is not restricted');
});

test('ORGR-05 storage keys of the two group realms never overwrite each other: the prefixes differ, so no scope name can collide with the other side; each writes its own and reads back its own', () => {
  const store = installStorage();
  // Keys: prefixes are separated, even if realm name is named after the other side
  assert.notEqual(orgKey('local', 'x'), orgKey('cloud', 'x'));
  assert.notEqual(orgKey('local', 'cloud.x'), orgKey('cloud', 'x'));
  assert.notEqual(orgKey('local', LOCAL_ORG_SCOPE), orgKey('cloud', LOCAL_ORG_SCOPE));
  assert.ok(orgKey('local', 'z').startsWith('pc.start.org.local.'));
  assert.ok(orgKey('cloud', 'z').startsWith('pc.start.org.cloud.'));

  // Store one copy each under the same realm name: neither overwrites the other
  const l = addGroup(emptyOrg('local'), 'Local group', () => 'l1').org;
  const c = addGroup(emptyOrg('cloud'), 'Cloud group', () => 'c1').org;
  saveOrg('same', l);
  saveOrg('same', c);
  assert.equal(store.size, 2);
  assert.deepEqual(loadOrg('local', 'same').groups.map((g) => g.name), ['Local group']);
  assert.deepEqual(loadOrg('cloud', 'same').groups.map((g) => g.name), ['Cloud group']);

  // The two real realms: desktop app has a fixed copy, cloud has one copy per account
  const a1 = cloudOrgScope('acc_000000000000000000000001');
  const a2 = cloudOrgScope('acc_000000000000000000000002');
  saveOrg(LOCAL_ORG_SCOPE, addGroup(emptyOrg('local'), 'D', () => 'd1').org);
  saveOrg(a1, addGroup(emptyOrg('cloud'), 'A1', () => 'a1').org);
  saveOrg(a2, addGroup(emptyOrg('cloud'), 'A2', () => 'a2').org);
  assert.deepEqual(loadOrg('local', LOCAL_ORG_SCOPE).groups.map((g) => g.name), ['D']);
  assert.deepEqual(loadOrg('cloud', a1).groups.map((g) => g.name), ['A1']);
  assert.deepEqual(loadOrg('cloud', a2).groups.map((g) => g.name), ['A2']);
  // Stored content carries which set it belongs to
  assert.equal(JSON.parse(store.get(orgKey('local', LOCAL_ORG_SCOPE))).realm, 'local');
  assert.equal(JSON.parse(store.get(orgKey('cloud', a1))).realm, 'cloud');
});

test('ORGR-06 a mismatched marker in the content is rejected: a key whose cloud copy was copied to local, or the reverse, reads back empty and never treats one realm as the other', () => {
  const cloudBlob = JSON.stringify(addGroup(emptyOrg('cloud'), 'Cloud group', () => 'c1').org);
  const localBlob = JSON.stringify(addGroup(emptyOrg('local'), 'Local group', () => 'l1').org);
  installStorage({
    [orgKey('local', LOCAL_ORG_SCOPE)]: cloudBlob, // Cloud content sitting in a local key
    [orgKey('cloud', 'acc:me')]: localBlob, // Local content sitting in a cloud key
  });
  assert.deepEqual(loadOrg('local', LOCAL_ORG_SCOPE), emptyOrg('local'));
  assert.deepEqual(loadOrg('cloud', 'acc:me'), emptyOrg('cloud'));
  assert.deepEqual(parseOrg(cloudBlob, 'local'), emptyOrg('local'));
  assert.deepEqual(parseOrg(localBlob, 'cloud'), emptyOrg('cloud'));
  assert.equal(parseOrg(cloudBlob, 'cloud').groups[0].name, 'Cloud group');
  // Group tags are assigned by the whole set: read groups all carry this set's realm
  assert.ok(groupsOf(parseOrg(localBlob, 'local')).every((g) => g.realm === 'local'));
});

test('ORGR-07 the old key written before the realm split (pc.start.org.<scope>, no realm marker) is recognized once: desktop app as local, cloud as account; afterwards only the new key is written', () => {
  const legacy = JSON.stringify({ v: 1, groups: [{ id: 'g-old', name: 'Old group' }], projects: [{ id: 'p', groupId: 'g-old' }], chats: [] });
  const store = installStorage({ 'pc.start.org.desktop': legacy, 'pc.start.org.acc:me': legacy });
  const l = loadOrg('local', LOCAL_ORG_SCOPE);
  const c = loadOrg('cloud', 'acc:me');
  assert.equal(l.realm, 'local');
  assert.equal(c.realm, 'cloud');
  assert.deepEqual(l.groups.map((g) => g.name), ['Old group']);
  assert.deepEqual(c.groups.map((g) => g.name), ['Old group']);
  saveOrg(LOCAL_ORG_SCOPE, l);
  assert.ok(store.has(orgKey('local', LOCAL_ORG_SCOPE)));
  assert.equal(store.get('pc.start.org.desktop'), legacy, 'Old key untouched');
  // Once the new key exists, follow the new key and no longer read back the old key
  saveOrg(LOCAL_ORG_SCOPE, addGroup(l, 'New one', () => 'n1').org);
  assert.deepEqual(loadOrg('local', LOCAL_ORG_SCOPE).groups.map((g) => g.name), ['Old group', 'New one']);
});

test('ORGR-08 a guest has no cloud copy: without a scope it can neither be read nor saved (a guest never writes organization data into any realm\'s key)', () => {
  const store = installStorage();
  assert.deepEqual(loadOrg('cloud', null), emptyOrg('cloud'));
  saveOrg(null, addGroup(emptyOrg('cloud'), 'Should not be saved', () => 'g1').org);
  assert.equal(store.size, 0);
});

test('ORGR-09 cloud group wording: when connected to the cloud it says "Stored in the cloud, visible on other devices too"; when an old server is detected it changes to saying it is only remembered in this browser; local groups are unaffected', () => {
  assert.equal(CLOUD_ORG_IN_CLOUD, true);
  assert.equal(orgWhereText('cloud'), 'Stored in the cloud, visible on other devices too');
  assert.equal(orgWhereText('cloud', false), 'Only remembered in this browser for now');
  assert.equal(orgWhereText('local'), 'Only remembered on this machine');
  assert.equal(orgWhereText('local', true), 'Only remembered on this machine');
  assert.equal(groupNoteText('cloud'), 'Cloud group: Stored in the cloud, visible on other devices too. Only cloud projects can go in it.');
  assert.equal(groupNoteText('cloud', false), 'Cloud group: Only remembered in this browser for now. Only cloud projects can go in it.');
  assert.equal(groupNoteText('local'), 'Local group: Only remembered on this machine. Only local projects can go in it.');
});

test('ORGR-10 cleanup: for projects no longer in the list, entries with no organization info are removed and their chats are removed with them; entries with organization info are kept; if the list was not fetched, nothing is cleaned', () => {
  const org = {
    ...emptyOrg('cloud'),
    groups: [{ id: 'g', name: 'Group' }],
    projects: [
      { id: 'live', groupId: null },
      { id: 'gone-plain', groupId: null },
      { id: 'gone-grouped', groupId: 'g' },
      { id: 'gone-pinned', groupId: null, pinned: true },
      { id: 'gone-archived', groupId: null, archived: true },
    ],
    chats: [{ id: 'c1', projectId: 'live' }, { id: 'c2', projectId: 'gone-plain' }, { id: 'c3', projectId: 'gone-pinned', pinned: true }],
  };
  const out = pruneOrg(org, new Set(['live']));
  assert.deepEqual(out.projects.map((p) => p.id), ['live', 'gone-grouped', 'gone-pinned', 'gone-archived']);
  assert.deepEqual(out.chats.map((c) => c.id), ['c1', 'c3']);
  assert.equal(pruneOrg(org, null), org, 'List not fetched: leave untouched');
  assert.equal(pruneOrg(out, new Set(['live'])), out, 'Nothing to clean: return the original object');
});
