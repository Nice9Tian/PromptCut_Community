/**
 * Cloud group sync engine (`src/start/orgSync.ts`). Run: npm test -- src/start/orgSync.test.mjs
 * Network, storage, and timers are injected: uses an in-memory fake cloud (same semantics as
 * `cloud/docservice/modules/account-org.mjs`: version compare-and-swap, conflicts bring back current
 * cloud copy) and a manually dialed timer.
 *
 *   SYNC-01 First connection: nothing stored in cloud, local has content → upload in full
 *   SYNC-02 Cloud newer than local, local has no un-uploaded changes → adopt cloud directly
 *   SYNC-03 Changes debounced before upload; consecutive edits upload once; don't upload before timer
 *   SYNC-04 Another device wrote first: pull first, three-way merge then upload once, keeping both
 *   SYNC-04b Another device wrote between pull and upload (409): three-way merge returned copy,
 *     retransmit, keeping changes from both sides
 *   SYNC-05 Offline: mark pending sync, changes stay local, interval doubles; catch up when online
 *   SYNC-06 Legacy server (no route): no error, no retry, changes stay local; catch up on refresh
 *     once supported
 *   SYNC-07 New edits during upload: still mark pending sync after upload and upload once more
 *   SYNC-08 Cloud version older than local record (cloud reset): starting from cloud, re-upload
 *     local copy in full
 *   SYNC-10 Both devices grouped before storage attached, first cloud connection: take union,
 *     losing neither
 *   SYNC-11 Corrupted sync record read as never recorded; saved and read back consistently
 *   SYNC-12 Server rate limited (429 with Retry-After): mark pending sync, keep changes, retry no
 *     earlier than specified time, no error
 *   SYNC-09 After stop, schedule no more tasks, trigger no more callbacks
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { OrgUnsupportedError, createOrgSync, parseSyncMeta, syncMetaKey } from './orgSync.ts';
import { emptyOrg } from './vibeOrg.ts';

const org = (o = {}) => ({ v: 1, realm: 'cloud', groups: [], projects: [], chats: [], ...o });
const tick = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
const names = (o) => o.groups.map((g) => g.name);

/** In-memory fake cloud: same rules as the server */
function fakeServer() {
  const s = { version: 0, org: null, puts: 0, gets: 0, down: false, unsupported: false };
  const guard = () => {
    if (s.unsupported) throw new OrgUnsupportedError();
    if (s.down) throw new Error('network');
  };
  s.transport = {
    async get() { s.gets++; guard(); return { version: s.version, org: s.org }; },
    async put(baseVersion, o) {
      s.puts++; guard();
      if (baseVersion !== s.version) return { conflict: true, version: s.version, org: s.org };
      s.version += 1; s.org = structuredClone(o);
      return { conflict: false, version: s.version, org: s.org };
    },
  };
  return s;
}

function harness({ server = fakeServer(), local = emptyOrg('cloud'), meta = null, transport = null, ...rest } = {}) {
  const state = { org: local, meta, statuses: [], applied: 0 };
  const timers = [];
  const schedule = (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return () => { t.live = false; }; };
  const sync = createOrgSync({
    transport: transport ?? server.transport,
    getOrg: () => state.org,
    applyOrg: (o) => { state.org = o; state.applied++; },
    loadMeta: () => state.meta,
    saveMeta: (m) => { state.meta = m; },
    onStatus: (s) => state.statuses.push(s),
    schedule,
    ...rest,
  });
  /** Local change: update UI to new state, then notify engine (same as setOrg in useCloudOrg) */
  const edit = (next) => { state.org = next; sync.changed(); };
  const live = () => timers.filter((t) => t.live);
  const fire = async () => { const t = live()[0]; assert.ok(t, 'There should be one queued task'); t.live = false; t.fn(); await tick(); return t.ms; };
  return { server, state, sync, timers, live, fire, edit };
}

test('SYNC-01 first connection: the cloud has never stored anything, this machine already has content → upload the whole thing', async () => {
  const local = org({ groups: [{ id: 'g1', name: 'Made before cloud storage was connected' }] });
  const h = harness({ local });
  await h.sync.refresh();
  assert.equal(h.server.puts, 1);
  assert.deepEqual(h.server.org, local);
  assert.deepEqual([h.state.meta.version, h.state.meta.dirty], [1, false]);
  assert.equal(h.sync.status(), 'synced');
  // Nothing on local, nothing in cloud: upload nothing
  const h2 = harness();
  await h2.sync.refresh();
  assert.equal(h2.server.puts, 0);
  assert.equal(h2.sync.status(), 'synced');
});

test('SYNC-02 cloud is newer than this machine, this machine has no unsent changes → adopt the cloud version directly (visible on other devices)', async () => {
  const server = fakeServer();
  server.version = 3;
  server.org = org({ groups: [{ id: 'g-cloud', name: 'Created on another device' }] });
  const h = harness({ server });
  await h.sync.refresh();
  assert.deepEqual(names(h.state.org), ['Created on another device']);
  assert.equal(h.server.puts, 0, 'No changes, no upload');
  assert.deepEqual([h.state.meta.version, h.state.meta.dirty], [3, false]);
  assert.equal(h.sync.status(), 'synced');
  // Pull again, cloud unchanged: do not re-apply
  const applied = h.state.applied;
  await h.sync.refresh();
  assert.equal(h.state.applied, applied);
});

test('SYNC-03 changes are debounced before upload; several consecutive changes upload only once; no upload before the timer fires', async () => {
  const h = harness();
  await h.sync.refresh();
  h.edit(org({ groups: [{ id: 'a', name: 'One' }] }));
  h.edit(org({ groups: [{ id: 'a', name: 'One' }, { id: 'b', name: 'Two' }] }));
  h.edit(org({ groups: [{ id: 'a', name: 'One' }, { id: 'b', name: 'Two' }, { id: 'c', name: 'three' }] }));
  await tick();
  assert.equal(h.server.puts, 0, 'No upload during debounce');
  assert.equal(h.live().length, 1, 'Only one task queued');
  assert.equal(h.live()[0].ms, 1000);
  assert.equal(h.state.meta.dirty, true, 'As soon as a change happens, mark "has unsent changes" (stored locally, not lost when the page is closed)');
  assert.equal(h.sync.status(), 'pending');
  await h.fire();
  assert.equal(h.server.puts, 1);
  assert.deepEqual(names(h.server.org), ['One', 'Two', 'three']);
  assert.equal(h.sync.status(), 'synced');
  assert.equal(h.state.meta.dirty, false);
});

test('SYNC-04 conflict: another device wrote first → three-way merge, re-upload, changes from both sides are kept', async () => {
  const server = fakeServer();
  const base = org({ groups: [{ id: 'g1', name: 'Original' }], projects: [{ id: 'p1', groupId: null }] });
  server.version = 1; server.org = base;
  const h = harness({ server });
  await h.sync.refresh(); // Adopt base, version 1
  // Another device modified: add group gT, pin p1 → cloud version 2
  server.version = 2;
  server.org = org({ groups: [{ id: 'g1', name: 'Original' }, { id: 'gT', name: 'Added on the other device' }], projects: [{ id: 'p1', groupId: null, pinned: true }] });
  // When this device is unaware: add group gM, rename g1
  h.edit(org({ groups: [{ id: 'g1', name: 'Name I changed' }, { id: 'gM', name: 'Added on this device' }], projects: [{ id: 'p1', groupId: null }] }));
  await h.fire();
  assert.equal(h.server.puts, 1, 'Pulled the new cloud version before uploading, succeeded in one go after merging');
  assert.equal(h.server.version, 3);
  assert.deepEqual(h.server.org.groups.map((g) => g.id).sort(), ['g1', 'gM', 'gT']);
  assert.equal(h.server.org.groups.find((g) => g.id === 'g1').name, 'Name I changed');
  assert.equal(h.server.org.projects[0].pinned, true, 'The other side\'s pin is also kept');
  assert.deepEqual(h.state.org, h.server.org, 'What the interface shows is the merged result');
  assert.deepEqual([h.state.meta.version, h.state.meta.dirty], [3, false]);
  assert.equal(h.sync.status(), 'synced');
});

test('SYNC-04b another device wrote again between pull and upload (409): three-way merge the version brought back, re-upload, changes from both sides are kept', async () => {
  const server = fakeServer();
  const base = org({ groups: [{ id: 'g1', name: 'Original' }] });
  server.version = 1; server.org = base;
  let raced = false;
  const racing = {
    get: server.transport.get,
    async put(v, o) {
      if (!raced) { // After this device's get and before its put, another device wrote
        raced = true;
        server.version = 2;
        server.org = org({ groups: [{ id: 'g1', name: 'Original' }, { id: 'gT', name: 'Added on the other device' }] });
      }
      return server.transport.put(v, o);
    },
  };
  const h = harness({ server, transport: racing });
  await h.sync.refresh();
  h.edit(org({ groups: [{ id: 'g1', name: 'Original' }, { id: 'gM', name: 'Added on this device' }] }));
  await h.fire();
  assert.equal(server.puts, 2, 'First attempt 409, second attempt succeeded after merging');
  assert.deepEqual(server.org.groups.map((g) => g.id).sort(), ['g1', 'gM', 'gT']);
  assert.deepEqual(h.state.org, server.org);
  assert.equal(h.state.meta.version, 3);
  assert.equal(h.sync.status(), 'synced');
});

test('SYNC-05 offline: mark pending sync, changes stay on this machine, interval doubles each time; catch up once back online', async () => {
  const h = harness();
  await h.sync.refresh();
  h.server.down = true;
  h.edit(org({ groups: [{ id: 'a', name: 'Created while offline' }] }));
  await h.fire(); // Debounce fired, unable to send
  assert.equal(h.sync.status(), 'pending');
  assert.equal(h.state.meta.dirty, true);
  assert.deepEqual(names(h.state.org), ['Created while offline'], 'Changes on this machine are still there');
  assert.equal(h.live()[0].ms, 2000);
  await h.fire(); // Failed again
  assert.equal(h.live()[0].ms, 4000, 'Interval doubled');
  await h.fire();
  assert.equal(h.live()[0].ms, 8000);
  h.server.down = false;
  await h.fire();
  assert.equal(h.sync.status(), 'synced');
  assert.deepEqual(names(h.server.org), ['Created while offline']);
  assert.equal(h.state.meta.dirty, false);
  assert.equal(h.live().length, 0, 'No more tasks queued after catching up');
  // Restart (switch engine, read back local records): unsent changes remain, can still catch up after
  // connecting
  const server = fakeServer();
  const local = org({ groups: [{ id: 'z', name: 'Not uploaded before the page was closed' }] });
  const h2 = harness({ server, local, meta: { version: 0, base: null, dirty: true } });
  await h2.sync.refresh();
  assert.deepEqual(names(server.org), ['Not uploaded before the page was closed']);
});

test('SYNC-06 old server (without this route): no error, no retry, changes stay on this machine; once supported later, refresh catches up', async () => {
  const server = fakeServer();
  server.unsupported = true;
  const h = harness({ server });
  await h.sync.refresh();
  assert.equal(h.sync.status(), 'unsupported');
  assert.equal(h.live().length, 0, 'No retry');
  h.edit(org({ groups: [{ id: 'a', name: 'Local only' }] }));
  await tick();
  assert.equal(h.live().length, 0, 'Changes do not queue an upload either');
  assert.equal(h.state.meta.dirty, true);
  assert.deepEqual(names(h.state.org), ['Local only']);
  assert.equal(server.puts, 0);
  // Server upgraded: catches up next time the page is opened (refresh)
  server.unsupported = false;
  await h.sync.refresh();
  assert.equal(h.sync.status(), 'synced');
  assert.deepEqual(names(server.org), ['Local only']);
});

test('SYNC-07 new changes during an upload: after it finishes, still mark pending sync and upload once more', async () => {
  const server = fakeServer();
  let release;
  const gate = new Promise((r) => { release = r; });
  const slow = { get: server.transport.get, async put(v, o) { await gate; return server.transport.put(v, o); } };
  const h = harness({ server, transport: slow });
  await h.sync.refresh();
  h.edit(org({ groups: [{ id: 'a', name: 'First edit' }] }));
  const firing = h.fire(); // Debounce fired, put stuck on gate
  await tick();
  h.edit(org({ groups: [{ id: 'a', name: 'First edit' }, { id: 'b', name: 'Changed during upload' }] }));
  release();
  await firing;
  assert.equal(h.state.meta.dirty, true, 'Second edit has not been uploaded yet');
  assert.equal(h.live().length, 1);
  await h.fire();
  assert.deepEqual(names(server.org), ['First edit', 'Changed during upload']);
  assert.equal(h.state.meta.dirty, false);
  assert.equal(h.sync.status(), 'synced');
});

test('SYNC-08 cloud is older than the version this machine recorded (cloud was reset): start from the cloud, upload the whole local copy again', async () => {
  const server = fakeServer(); // Version 0
  const local = org({ groups: [{ id: 'g', name: 'Kept on this machine' }] });
  const h = harness({ server, local, meta: { version: 7, base: local, dirty: false } });
  await h.sync.refresh();
  assert.equal(server.version, 1);
  assert.deepEqual(names(server.org), ['Kept on this machine']);
  assert.equal(h.sync.status(), 'synced');
});

test('SYNC-09 after stop, no more tasks queued, no more callbacks', async () => {
  const h = harness();
  await h.sync.refresh();
  const seen = h.state.statuses.length;
  h.edit(org({ groups: [{ id: 'a', name: 'x' }] }));
  h.sync.stop();
  assert.equal(h.live().length, 0, 'Queued task was cancelled');
  h.edit(org({ groups: [{ id: 'a', name: 'y' }] }));
  assert.equal(h.live().length, 0);
  assert.ok(h.state.statuses.length <= seen + 1);
});

test('SYNC-10 two devices each made groups before storage was connected, first connection to the cloud: take the union, nobody\'s is lost', async () => {
  const server = fakeServer();
  const d1 = harness({ server, local: org({ groups: [{ id: 'g1', name: 'Device one\'s' }] }) });
  await d1.sync.refresh(); // Device 1 connects first: upload the whole copy
  const d2 = harness({ server, local: org({ groups: [{ id: 'g2', name: 'Device two\'s' }] }) }); // Device 2 connects for the first time, cloud already has Device 1's
  await d2.sync.refresh();
  assert.deepEqual(server.org.groups.map((g) => g.id).sort(), ['g1', 'g2']);
  assert.deepEqual(d2.state.org.groups.map((g) => g.id).sort(), ['g1', 'g2']);
  // Device 2 has nothing locally: directly adopt the cloud copy, no extra upload
  const puts = server.puts;
  const d3 = harness({ server });
  await d3.sync.refresh();
  assert.equal(server.puts, puts);
  assert.deepEqual(d3.state.org.groups.map((g) => g.id).sort(), ['g1', 'g2']);
});

test('SYNC-11 a corrupted sync record is read as if never recorded; what is stored reads back identical', () => {
  assert.equal(parseSyncMeta(null), null);
  assert.equal(parseSyncMeta('{not json'), null);
  assert.equal(parseSyncMeta(JSON.stringify({ version: -1, dirty: true })), null);
  assert.equal(parseSyncMeta(JSON.stringify({ version: 'x' })), null);
  const base = org({ groups: [{ id: 'g', name: 'x' }] });
  assert.deepEqual(parseSyncMeta(JSON.stringify({ version: 4, base, dirty: true })), { version: 4, base, dirty: true });
  assert.deepEqual(parseSyncMeta(JSON.stringify({ version: 2 })), { version: 2, base: null, dirty: false });
  // base marked with local is treated as unrecognized (will not mix local set into cloud sync
  // records)
  const local = parseSyncMeta(JSON.stringify({ version: 1, base: { v: 1, realm: 'local', groups: [{ id: 'g', name: 'x' }], projects: [], chats: [] }, dirty: false }));
  assert.deepEqual(local.base, emptyOrg('cloud'));
  assert.match(syncMetaKey('acc:x'), /^pc\.start\.orgsync\.cloud\./);
});

test('SYNC-12 server rate limiting (429 with Retry-After): mark pending sync, keep changes, retry no earlier than the time it states, no error', async () => {
  const server = fakeServer();
  const limited = Object.assign(new Error('org-rate-limited'), { status: 429, code: 'org-rate-limited', retryAfterSec: 30 });
  let limit = true;
  const transport = { get: server.transport.get, async put(v, o) { if (limit) throw limited; return server.transport.put(v, o); } };
  const h = harness({ server, transport });
  await h.sync.refresh();
  h.edit(org({ groups: [{ id: 'a', name: 'Changed while rate limited' }] }));
  await h.fire(); // Debounce fired, rate-limited
  assert.equal(h.sync.status(), 'pending');
  assert.equal(h.state.meta.dirty, true, 'Changes not lost');
  assert.deepEqual(names(h.state.org), ['Changed while rate limited']);
  assert.equal(h.live()[0].ms, 30_000, 'Retry after the time the server specified (longer than its own 2 s backoff)');
  limit = false;
  await h.fire();
  assert.equal(h.sync.status(), 'synced');
  assert.deepEqual(names(server.org), ['Changed while rate limited']);
});
