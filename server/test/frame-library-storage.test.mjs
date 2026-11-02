/**
 * Usage index, limits, eviction, and cache cleanup for frame store
 * (`server/frame-library-storage.mjs`, storage footprint plan part B).
 * All frame stores are created in temp directories, not touching the user's Videos\PromptCut.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  GB, DEFAULT_CAP_BYTES, MIN_CAP_BYTES, PROTECT_MS, CLEAR_KEEP_MS, INDEX_FILE, SETTINGS_FILE,
  parseRel, relDir, defaultCapBytes, capRange, validCap, resolveCap, readStorageSettings, writeStorageSettings,
  measureDir, listRels, entryUsageRels, createFrameLibraryStorage, storageDataDir, createExportSummary, relOfPath,
} from '../frame-library-storage.mjs';
import { summarizeExports, listExports } from '../exports-list.mjs';
import { isExportDirName } from '../storage-leftovers.mjs';
import { createReadyHub } from '../ready-index.mjs';

const key = seed => crypto.createHash('sha256').update(String(seed)).digest('hex');
const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;

async function tempRoot(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-storage-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 3 }));
  const root = path.join(dir, 'frame-library');
  const data = path.join(dir, 'data');
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(data, { recursive: true });
  return { dir, root, data };
}

/**
 * Creates a key directory: a file of `bytes` bytes, with modification time of the entire tree
 * set to `mtime`
 */
async function makeKey(root, rel, bytes, mtime, file = 'mov/frames/000000.png') {
  const dir = relDir(root, rel);
  const full = path.join(dir, file);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, Buffer.alloc(bytes, 1));
  const seconds = mtime / 1000;
  // Set from leaves upward to avoid creating subdirectories that refresh parent directory
  // timestamps
  let current = full;
  while (current.length >= dir.length) {
    await fs.utimes(current, seconds, seconds);
    if (current === dir) break;
    current = path.dirname(current);
  }
  return dir;
}

const exists = file => fs.access(file).then(() => true, () => false);

function manager(root, data, options = {}) {
  return createFrameLibraryStorage({ root, dataDir: data, timers: false, minCapBytes: 1000, alive: pid => pid === process.pid, ...options });
}

test('key directory shapes: the six recognized kinds; anything unrecognized is null', () => {
  const k = key(1);
  assert.deepEqual(parseRel(k), { rel: k, family: 'entry', key: k, unit: `entry:${k}` });
  assert.equal(parseRel(`controls-local/${k}`).unit, `entry:${k}`, 'the local tier and the whole scene form one eviction unit');
  for (const family of ['controls-html', 'controls', 'streams', 'tracks']) assert.equal(parseRel(`${family}/${k}`).unit, `${family}/${k}`);
  for (const bad of ['', 'abc', `controls-lock/${k}`, `controls-html/${k}/x`, `controls-html/..`, `../${k}`, `controls/${k.toUpperCase()}`, `controls-local/${k}/${k}`, null]) {
    assert.equal(parseRel(bad), null, String(bad));
  }
  assert.equal(relDir('/lib', `streams/${k}`), path.join('/lib', 'streams', k));
  assert.throws(() => relDir('/lib', '../x'));
});

test('cap: default 50 GB; for a disk smaller than 500 GB, use 10%; a user value must be between 5 GB and the total disk capacity, and out-of-range values are clamped into range', () => {
  assert.equal(DEFAULT_CAP_BYTES, 50 * GB);
  assert.equal(MIN_CAP_BYTES, 5 * GB);
  assert.equal(defaultCapBytes(2000 * GB), 50 * GB);
  assert.equal(defaultCapBytes(500 * GB), 50 * GB, 'exactly 500 GB does not count as a small disk');
  assert.equal(defaultCapBytes(256 * GB), Math.floor(256 * GB * 0.1));
  assert.equal(GB, 1024 ** 3, 'GB is counted as 1024³');
  assert.equal(DEFAULT_CAP_BYTES, 53687091200);
  assert.equal(defaultCapBytes(500e9), Math.floor(500e9 * 0.1), 'a disk nominally 500 GB (decimal) is less than 500 × 1024³, so it counts as a small disk');
  assert.equal(defaultCapBytes(null), 50 * GB, 'use 50 GB when the disk cannot be measured');
  assert.deepEqual(capRange(1000 * GB), { min: 5 * GB, max: 1000 * GB });
  assert.equal(validCap(5 * GB, 1000 * GB), true);
  assert.equal(validCap(5 * GB - 1, 1000 * GB), false);
  assert.equal(validCap(1000 * GB, 1000 * GB), true);
  assert.equal(validCap(1000 * GB + 1, 1000 * GB), false);
  assert.equal(validCap(6.5, 1000 * GB), false, 'must be an integer number of bytes');
  assert.equal(validCap(NaN, 1000 * GB), false);
  assert.deepEqual(resolveCap({}, 1000 * GB), { capBytes: 50 * GB, capSource: 'default' });
  assert.deepEqual(resolveCap({ frameLibraryCapBytes: 80 * GB }, 1000 * GB), { capBytes: 80 * GB, capSource: 'user' });
  assert.deepEqual(resolveCap({ frameLibraryCapBytes: 1 }, 1000 * GB), { capBytes: 5 * GB, capSource: 'user' });
  assert.deepEqual(resolveCap({ frameLibraryCapBytes: 9e15 }, 1000 * GB), { capBytes: 1000 * GB, capSource: 'user' });
  assert.equal(storageDataDir('/repo', {}), path.join('/repo', 'out'));
  assert.equal(storageDataDir('/repo', { PROMPTCUT_DATA_DIR: '/d' }), '/d');
});

test('storage.json read/write: merge writes, atomic writes; unreadable content is treated as empty', async t => {
  const { data } = await tempRoot(t);
  assert.deepEqual(await readStorageSettings(data), {});
  await writeStorageSettings(data, { other: 1 });
  await writeStorageSettings(data, { frameLibraryCapBytes: 7 * GB });
  assert.deepEqual(await readStorageSettings(data), { other: 1, frameLibraryCapBytes: 7 * GB });
  await fs.writeFile(path.join(data, SETTINGS_FILE), '{bad');
  assert.deepEqual(await readStorageSettings(data), {});
});

test('setCap: out-of-range values are rejected (CAP_OUT_OF_RANGE); valid ones are written to storage.json and checked once immediately', async t => {
  const { root, data } = await tempRoot(t);
  const clock = Date.now();
  await makeKey(root, key('a'), 3000, clock - 5 * HOUR);
  await makeKey(root, key('b'), 3000, clock - 4 * HOUR);
  const m = manager(root, data, { now: () => clock });
  await assert.rejects(m.setCap(999), error => error.code === 'CAP_OUT_OF_RANGE' && error.min === 1000);
  await assert.rejects(m.setCap(Number.NaN), error => error.code === 'CAP_OUT_OF_RANGE');
  const { capBytes, pending } = await m.setCap(4000);
  assert.equal(capBytes, 4000);
  await pending;
  assert.equal((await readStorageSettings(data)).frameLibraryCapBytes, 4000);
  const summary = await m.summary();
  assert.equal(summary.capSource, 'user');
  assert.equal(summary.capBytes, 4000);
  assert.equal(await exists(relDir(root, key('a'))), false, 'changing the cap takes effect immediately: the oldest one is deleted');
  assert.equal(await exists(relDir(root, key('b'))), true);
  await m.close();
});

test('index: the first run rescans by directory, the last-used time takes the modification time of the newest file; a lost or corrupted index is rebuilt', async t => {
  const { root, data } = await tempRoot(t);
  const clock = Date.now();
  const k1 = key('e1'), k2 = key('c2');
  await makeKey(root, k1, 100, clock - 3 * HOUR);
  await makeKey(root, `controls-local/${k1}`, 50, clock - 2 * HOUR, `${key('x')}/0.html`);
  await makeKey(root, `controls-html/${k2}`, 70, clock - 1 * HOUR, '0.html');
  const m = manager(root, data, { now: () => clock });
  await m.check({ force: true });
  const doc = JSON.parse(await fs.readFile(path.join(root, INDEX_FILE), 'utf8'));
  assert.equal(doc.version, 1);
  assert.deepEqual(Object.keys(doc.keys).sort(), [k1, `controls-html/${k2}`, `controls-local/${k1}`].sort());
  const snap = m.snapshot();
  assert.equal(snap[k1].bytes, 100);
  assert.ok(Math.abs(snap[k1].at - (clock - 3 * HOUR)) < 2000, 'last used = modification time of the newest file');
  assert.ok(Math.abs(snap[`controls-html/${k2}`].at - (clock - HOUR)) < 2000);
  const summary = await m.summary();
  assert.equal(summary.bytes, 220);
  assert.equal(summary.owner, true);
  assert.ok(summary.scannedAt);
  await m.close();

  // Index present: new instance reads directly without rescanning (recorded usage timestamps
  // preserved)
  const m2 = manager(root, data, { now: () => clock });
  await m2.check({ force: true });
  m2.touch([k1], clock);
  await m2.flush();
  await m2.close();
  const m3 = manager(root, data, { now: () => clock });
  await m3.check({ force: true });
  assert.equal(m3.snapshot()[k1].at, clock, 'after the index is read back, the recorded usage is still there');
  await m3.close();

  // Corrupted: rebuild
  await fs.writeFile(path.join(root, INDEX_FILE), 'not json');
  const m4 = manager(root, data, { now: () => clock });
  await m4.check({ force: true });
  assert.equal(Object.keys(m4.snapshot()).length, 3);
  await m4.close();

  // Missing: rebuild
  await fs.rm(path.join(root, INDEX_FILE));
  const m5 = manager(root, data, { now: () => clock });
  await m5.check({ force: true });
  assert.equal((await m5.summary()).bytes, 220);
  await m5.close();
});

test('incremental: newly appeared keys are measured once, vanished ones are removed, keys with recorded usage are re-measured; no full rescan', async t => {
  const { root, data } = await tempRoot(t);
  let clock = Date.now();
  const k1 = key('i1'), k2 = key('i2');
  await makeKey(root, k1, 100, clock - HOUR);
  const m = manager(root, data, { now: () => clock });
  await m.check({ force: true });
  const scannedAt = (await m.summary()).scannedAt;
  clock += 10 * MIN;
  await makeKey(root, `streams/${k2}`, 40, clock, 'init-a.mp4');
  await fs.writeFile(path.join(relDir(root, k1), 'more.bin'), Buffer.alloc(60));
  m.touch([k1], clock);
  await m.check({ force: true });
  const summary = await m.summary();
  assert.equal(summary.scannedAt, scannedAt, 'no full rescan');
  assert.equal(m.snapshot()[k1].bytes, 160, 'keys with recorded usage were re-measured');
  assert.equal(m.snapshot()[`streams/${k2}`].bytes, 40, 'newly appeared keys were measured');
  await fs.rm(relDir(root, `streams/${k2}`), { recursive: true });
  await m.check({ force: true });
  assert.equal(m.snapshot()[`streams/${k2}`], undefined, 'vanished keys are removed');
  await m.close();
});

test('eviction: N projects with different last-used times are deleted from oldest to newest, stopping once usage is down to 90% of the cap', async t => {
  const { root, data } = await tempRoot(t);
  const clock = Date.now();
  const projects = [];
  for (let i = 0; i < 6; i++) {
    const entry = key(`p${i}`), card = key(`card${i}`);
    const at = clock - (10 - i) * HOUR;          // p0 is oldest
    await makeKey(root, entry, 1000, at);
    await makeKey(root, `controls-local/${entry}`, 200, at, `${card}/0.html`);
    await makeKey(root, `controls-html/${card}`, 300, at, '0.html');
    projects.push({ entry, card, at });
  }
  // Total 6 × 1500 = 9000; limit 6000 → delete below 5400: after two projects p0 and p1 (3000), 600 left,
  // delete p2's whole scene unit (whole scene 1000 + local tier 200) to reach 4800; p2's shared tier remains
  await writeStorageSettings(data, { frameLibraryCapBytes: 6000 });
  const m = manager(root, data, { now: () => clock });
  const result = await m.check({ force: true });
  assert.ok(result.evicted, 'exceeding the cap must trigger eviction');
  const order = result.evicted.removedUnits.map(u => u.unit);
  const expected = [];
  for (const p of projects.slice(0, 3)) expected.push(`entry:${p.entry}`, `controls-html/${p.card}`);
  // From oldest to newest by last used time: p0's two units, p1's two, p2's one
  assert.equal(order.length, 5);
  assert.deepEqual(new Set(order.slice(0, 2)), new Set(expected.slice(0, 2)), 'delete the oldest p0 first');
  assert.deepEqual(new Set(order.slice(2, 4)), new Set(expected.slice(2, 4)), 'then delete p1');
  assert.ok(expected.slice(4).includes(order[4]), 'finally delete one unit of p2');
  const ats = result.evicted.removedUnits.map(u => u.at);
  assert.deepEqual(ats, [...ats].sort((a, b) => a - b), 'from oldest to newest');
  const after = await m.summary();
  assert.ok(after.bytes <= 5400, `deleted down to below 90%: ${after.bytes}`);
  assert.equal(after.bytes, 4800, 'stop once enough has been deleted, and do not delete more');
  for (const p of projects.slice(0, 2)) {
    assert.equal(await exists(relDir(root, p.entry)), false);
    assert.equal(await exists(relDir(root, `controls-local/${p.entry}`)), false, 'when the whole scene is deleted, its local tier is deleted with it');
  }
  for (const p of projects.slice(3)) assert.equal(await exists(relDir(root, p.entry)), true);
  assert.equal(after.lastEvict.removed, 5);
  assert.equal(after.lastEvict.freedBytes, 4200);
  const trash = await fs.readdir(path.join(root, '.storage', 'trash')).catch(() => []);
  assert.deepEqual(trash, [], 'the trash directory was emptied');
  await m.close();
});

test('eviction: anything used within 30 minutes is not deleted, and neither is a project that is currently open', async t => {
  const { root, data } = await tempRoot(t);
  const clock = Date.now();
  const old = key('old'), recent = key('recent'), open = key('open');
  await makeKey(root, old, 1000, clock - 5 * HOUR);
  await makeKey(root, recent, 1000, clock - 20 * MIN);
  await makeKey(root, open, 1000, clock - 9 * HOUR);
  await writeStorageSettings(data, { frameLibraryCapBytes: 1000 });
  const ready = createReadyHub({ now: () => clock });
  ready.adopt('page', open, 1, ready.request('page'));
  const pipeline = { ready, generations: new Map(), entries: new Map() };
  const m = manager(root, data, { now: () => clock }).attachPipeline(pipeline);
  assert.equal(pipeline.usage, m);
  const result = await m.check({ force: true });
  assert.deepEqual(result.evicted.removedUnits.map(u => u.unit), [`entry:${old}`]);
  assert.equal(await exists(relDir(root, recent)), true, 'used 20 minutes ago: not deleted');
  assert.equal(await exists(relDir(root, open)), true, 'an open project is not deleted (even if its files are old)');
  const summary = await m.summary({ detail: true });
  assert.equal(summary.pinnedBytes, 2000);
  assert.ok(summary.bytes > summary.capBytes, 'when nothing more can be deleted, it stops above the cap');
  assert.equal(summary.units.find(u => u.unit === `entry:${open}`).pinned, true);
  assert.ok(PROTECT_MS === 30 * MIN);
  await m.close();
});

test('clear cache: keep only what was used within 10 minutes (and what is open)', async t => {
  const { root, data } = await tempRoot(t);
  const clock = Date.now();
  const keep = key('keep'), drop1 = key('drop1'), drop2 = key('drop2');
  await makeKey(root, keep, 100, clock - 5 * MIN);
  await makeKey(root, `tracks/${drop1}`, 100, clock - 15 * MIN, '000000.png');
  await makeKey(root, `controls/${drop2}`, 100, clock - 3 * HOUR);
  const m = manager(root, data, { now: () => clock });
  await m.check({ force: true });
  assert.equal((await m.summary()).bytes, 300, 'default cap of 50 GB, no eviction');
  const result = await m.clearCache();
  assert.equal(result.removed, 2);
  assert.equal(result.skipped, 0);
  assert.equal(result.freedBytes, 200);
  assert.equal(await exists(relDir(root, keep)), true);
  assert.equal((await m.summary()).bytes, 100, 'the number gets smaller after cleanup');
  assert.equal(CLEAR_KEEP_MS, 10 * MIN);
  await m.close();
});

test('open files: the whole unit is skipped (not half deleted), and deleted in the next round once closed', async t => {
  const { root, data } = await tempRoot(t);
  const clock = Date.now();
  const busy = key('busy'), free = key('free');
  const busyDir = await makeKey(root, busy, 500, clock - 5 * HOUR);
  await makeKey(root, `controls-local/${busy}`, 100, clock - 5 * HOUR, `${key('z')}/0.html`);
  await makeKey(root, free, 500, clock - 4 * HOUR);
  const handle = await fs.open(path.join(busyDir, 'mov', 'frames', '000000.png'), 'r');
  const m = manager(root, data, { now: () => clock });
  await m.check({ force: true });
  const first = await m.clearCache();
  await handle.close();
  if (process.platform === 'win32') {
    assert.equal(first.skipped, 1, 'open ones are skipped');
    assert.equal(first.removed, 1);
    assert.equal(await exists(path.join(busyDir, 'mov', 'frames', '000000.png')), true, 'not a single file was deleted from the skipped unit');
    assert.equal(await exists(relDir(root, `controls-local/${busy}`)), true, 'when the whole scene is skipped, its local tier is kept too');
    const detail = (await m.summary({ detail: true })).lastEvictDetail;
    assert.equal(detail.skippedUnits[0].reason, 'busy');
    const second = await m.clearCache();
    assert.equal(second.removed, 1, 'deleted in the next round after it is closed');
  }
  assert.equal(await exists(busyDir), false);
  assert.equal(await exists(relDir(root, free)), false);
  await m.close();
});

test('links and unrecognized directories: always left alone', async t => {
  const { dir, root, data } = await tempRoot(t);
  const clock = Date.now();
  const outside = path.join(dir, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'precious.txt'), 'keep me');
  const linkKey = key('link'), innerKey = key('inner');
  await fs.mkdir(path.join(root, 'controls-html'), { recursive: true });
  await fs.symlink(outside, path.join(root, 'controls-html', linkKey), 'junction');
  // Key directory itself is a real directory with a link inside: skip entirely
  const inner = await makeKey(root, `controls/${innerKey}`, 100, clock - 5 * HOUR);
  await fs.symlink(outside, path.join(inner, 'escape'), 'junction');
  await fs.utimes(inner, (clock - 5 * HOUR) / 1000, (clock - 5 * HOUR) / 1000);
  // Unrecognized: malformed names, other families, files under root
  await makeKey(root, key('ok'), 10, clock - 5 * HOUR);
  await fs.mkdir(path.join(root, 'controls-html', 'not-a-key'), { recursive: true });
  await fs.mkdir(path.join(root, 'controls-lock'), { recursive: true });
  await fs.writeFile(path.join(root, 'controls-lock', 'locks.json'), '{}');
  await fs.mkdir(path.join(root, 'something-else', key('x')), { recursive: true });
  await fs.writeFile(path.join(root, 'push-queue.json'), '[]');
  const m = manager(root, data, { now: () => clock });
  await m.check({ force: true });
  assert.equal(m.snapshot()[`controls-html/${linkKey}`], undefined, 'a key directory that is a link is not added to the index');
  const result = await m.clearCache();
  assert.equal(result.removed, 1, 'only the normal one was deleted');
  assert.equal(result.skipped, 1, 'a key directory containing a link is skipped');
  assert.equal(await fs.readFile(path.join(outside, 'precious.txt'), 'utf8'), 'keep me', 'the place the link points to is intact');
  assert.equal(await exists(inner), true);
  for (const kept of [path.join(root, 'controls-html', 'not-a-key'), path.join(root, 'controls-lock', 'locks.json'), path.join(root, 'something-else', key('x')), path.join(root, 'push-queue.json')]) {
    assert.equal(await exists(kept), true, kept);
  }
  await m.close();
});

test('a family directory that is itself a link: the whole family is not recognized', async t => {
  const { dir, root } = await tempRoot(t);
  const outside = path.join(dir, 'streams-elsewhere');
  await fs.mkdir(path.join(outside, key('s')), { recursive: true });
  await fs.symlink(outside, path.join(root, 'streams'), 'junction');
  assert.deepEqual(await listRels(root), []);
});

test('record usage: the keys used by one version (whole scene, local tier, shared tier, standalone card, track prefix, track stream) are recorded together', async t => {
  const { root, data } = await tempRoot(t);
  const clock = Date.now();
  const entryKey = key('entry'), shared = key('shared'), local = key('local'), png = key('png'), prefix = key('prefix'), stream = key('stream');
  const entry = { key: entryKey, cardPlan: [
    { clipId: 'a', key: png, snapshotKey: shared, tier: 'shared' },
    { clipId: 'b', snapshotKey: local, tier: 'local' },
  ] };
  const pipeline = { prefixes: () => [{ key: prefix }], _streams: { streams: new Map([[stream, { entryKey, spec: { streamKey: stream } }], [key('other'), { entryKey: key('else'), spec: { streamKey: key('other') } }]]) } };
  const rels = entryUsageRels(pipeline, entry).sort();
  assert.deepEqual(rels, [entryKey, `controls-local/${entryKey}`, `controls-html/${shared}`, `controls/${png}`, `tracks/${prefix}`, `streams/${stream}`].sort());
  assert.equal(entryUsageRels(pipeline, entry), entryUsageRels(pipeline, entry), 'the same plan is not recomputed');
  const m = manager(root, data, { now: () => clock }).attachPipeline(pipeline);
  await m.check({ force: true });
  m.touchEntry(entry, clock);
  const snap = m.snapshot();
  for (const rel of rels) assert.equal(snap[rel]?.at, clock, rel);
  await m.close();
});

test('multiple processes: only one main process writes the index; other processes\' usage is merged in through touch files, and a touch file is deleted when its process is gone', async t => {
  const { root, data } = await tempRoot(t);
  const clock = Date.now();
  const k = key('shared-use');
  await makeKey(root, k, 100, clock - 5 * HOUR);
  await makeKey(root, key('old'), 100, clock - 6 * HOUR);
  const a = manager(root, data, { now: () => clock, pid: process.pid });
  await a.check({ force: true });
  assert.equal(a.owner, true);
  const fakePid = 999999;
  const b = manager(root, data, { now: () => clock, pid: fakePid, alive: pid => pid === process.pid || pid === fakePid });
  await b.check({ force: true });
  assert.equal(b.owner, false, 'the second process is not the main process');
  b.touch([k], clock - 1000);
  await b.flush();
  const touchFile = path.join(root, '.storage', 'touch', `${fakePid}.json`);
  assert.equal(await exists(touchFile), true);
  await assert.rejects(b.clearCache(), error => error.code === 'STORAGE_NOT_OWNER');
  const result = await a.clearCache();
  assert.deepEqual(result.removedUnits.map(u => u.unit), [`entry:${key('old')}`], 'what another process just used is not deleted');
  assert.equal(a.snapshot()[k].at, clock - 1000);
  // That process is gone: delete files after merging
  const a2 = manager(root, data, { now: () => clock, pid: process.pid, alive: pid => pid === process.pid });
  await a.close();
  await a2.check({ force: true });
  assert.equal(await exists(touchFile), false);
  await a2.close();
  await b.close();
});

test('main process lock: can be taken over when the heartbeat has expired or the process is gone', async t => {
  const { root, data } = await tempRoot(t);
  const clock = Date.now();
  await fs.mkdir(path.join(root, '.storage'), { recursive: true });
  await fs.writeFile(path.join(root, '.storage', 'owner.json'), JSON.stringify({ pid: 424242, at: clock }));
  const m = manager(root, data, { now: () => clock, alive: pid => pid === process.pid });
  await m.check({ force: true });
  assert.equal(m.owner, true, 'the lock owner is gone, take over');
  await m.close();
  assert.equal(await exists(path.join(root, '.storage', 'owner.json')), false, 'release the lock on close');
});

test('measureDir: leftover files (spill of dead processes, aborted tmp.mov, tmp.mp4) are counted separately', async t => {
  const { root } = await tempRoot(t);
  const dir = path.join(root, key('m'));
  await fs.mkdir(path.join(dir, 'html-cache', 'live-424242-abc'), { recursive: true });
  await fs.mkdir(path.join(dir, 'html-cache', `live-${process.pid}-abc`), { recursive: true });
  await fs.mkdir(path.join(dir, 'mov'), { recursive: true });
  await fs.writeFile(path.join(dir, 'html-cache', 'live-424242-abc', 'b1'), Buffer.alloc(10));
  await fs.writeFile(path.join(dir, 'html-cache', `live-${process.pid}-abc`, 'b1'), Buffer.alloc(20));
  await fs.writeFile(path.join(dir, 'mov', 'full-424242.tmp.mov'), Buffer.alloc(30));
  await fs.writeFile(path.join(dir, 'mov', `full-${process.pid}.tmp.mov`), Buffer.alloc(40));
  await fs.writeFile(path.join(dir, 'preview-424242.tmp.mp4'), Buffer.alloc(50));
  await fs.writeFile(path.join(dir, 'mov', 'full.mov'), Buffer.alloc(60));
  const measured = await measureDir(dir, { alive: pid => pid === process.pid });
  assert.equal(measured.bytes, 210);
  assert.equal(measured.leftover, 90, 'only the dead processes\' are counted');
  assert.equal(measured.linked, false);
  assert.equal((await measureDir(path.join(root, 'nope'))).missing, true);
});

test('export summary: total bytes, count, intermediate files (everything other than the final video, transparent layer and project.json); excludes export-vision-*', async t => {
  const { dir } = await tempRoot(t);
  const exportsDir = path.join(dir, 'exports');
  const one = path.join(exportsDir, 'export-20260929-101010');
  await fs.mkdir(path.join(one, 'frames'), { recursive: true });
  await fs.writeFile(path.join(one, 'preview.mp4'), Buffer.alloc(100));
  await fs.writeFile(path.join(one, 'overlay.mov'), Buffer.alloc(200));
  await fs.writeFile(path.join(one, 'project.json'), Buffer.alloc(5));
  await fs.writeFile(path.join(one, 'frames', '000000.png'), Buffer.alloc(1000));
  const two = path.join(exportsDir, 'export-20260929-101010-2');
  await fs.mkdir(path.join(two, 'parts'), { recursive: true });
  await fs.writeFile(path.join(two, 'parts', 'a.mov'), Buffer.alloc(300));
  await fs.mkdir(path.join(exportsDir, 'export-vision-abc'), { recursive: true });
  await fs.writeFile(path.join(exportsDir, 'export-vision-abc', 'x'), Buffer.alloc(999));
  await fs.mkdir(path.join(exportsDir, 'frame-library'), { recursive: true });
  const summary = await summarizeExports(exportsDir);
  assert.deepEqual(summary, { bytes: 1605, count: 2, intermediateBytes: 1300 });
  assert.equal(isExportDirName('export-vision-1'), false);
  assert.equal(isExportDirName('export-20260101-000000'), true);
  assert.equal(isExportDirName('export-20260101-000000-12'), true);
  for (const bad of ['export-foo', 'export-20260101-000000-x', 'export-2026-01-01', 'export-20260101-000000/..', 'xexport-20260101-000000']) assert.equal(isExportDirName(bad), false, bad);
  assert.deepEqual(await summarizeExports(path.join(dir, 'none')), { bytes: 0, count: 0, intermediateBytes: 0 });
});

test('merge: the exports entry of /api/storage (createExportSummary) follows the same rules as the list of /api/exports, so the numbers match', async t => {
  const { dir } = await tempRoot(t);
  const exportsDir = path.join(dir, 'exports');
  const mk = async (id, files) => {
    for (const [rel, bytes] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(exportsDir, id, rel)), { recursive: true });
      await fs.writeFile(path.join(exportsDir, id, rel), Buffer.alloc(bytes));
    }
  };
  await mk('export-20260929-101010', { 'preview.mp4': 100, 'overlay.mov': 200, 'project.json': 5, 'frames/000000.png': 1000 });
  await mk('export-20260929-101010-2', { 'parts/a.mov': 300 });
  await mk('export-20260929-101010-13', { 'preview.mp4': 7 });
  await mk('export-vision-123-abc', { x: 999 });
  // Name matches but is a link (junction): neither side recognizes it
  await fs.mkdir(path.join(dir, 'elsewhere'), { recursive: true });
  await fs.writeFile(path.join(dir, 'elsewhere', 'big.bin'), Buffer.alloc(5000));
  await fs.symlink(path.join(dir, 'elsewhere'), path.join(exportsDir, 'export-20260929-111111'), 'junction');
  const items = await listExports(exportsDir);
  const summary = await createExportSummary(exportsDir).get();
  assert.deepEqual(summary, {
    bytes: items.reduce((s, it) => s + it.bytes, 0),
    count: items.length,
    intermediateBytes: items.reduce((s, it) => s + it.intermediateBytes, 0),
  });
  assert.deepEqual(summary, { bytes: 1612, count: 3, intermediateBytes: 1300 });
});

test('merge: after the export list deletes one export or only the intermediate files, the exports entry of /api/storage follows immediately (without waiting for the 60-second cache)', async t => {
  const { dir } = await tempRoot(t);
  const exportsDir = path.join(dir, 'exports');
  const { deleteExport, pruneExport } = await import('../exports-list.mjs');
  for (const [id, extra] of [['export-20260929-101010', 1000], ['export-20260929-121212', 300]]) {
    await fs.mkdir(path.join(exportsDir, id, 'frames'), { recursive: true });
    await fs.writeFile(path.join(exportsDir, id, 'preview.mp4'), Buffer.alloc(100));
    await fs.writeFile(path.join(exportsDir, id, 'frames', '0.png'), Buffer.alloc(extra));
  }
  let clock = Date.now();
  const summary = createExportSummary(exportsDir, { now: () => clock });
  assert.deepEqual(await summary.get(), { bytes: 1500, count: 2, intermediateBytes: 1300 });
  assert.equal((await pruneExport(exportsDir, 'export-20260929-101010')).ok, true);
  assert.deepEqual(await summary.get(), { bytes: 500, count: 2, intermediateBytes: 300 }, 'after deleting only intermediate files');
  assert.equal((await deleteExport(exportsDir, 'export-20260929-121212')).ok, true);
  assert.deepEqual(await summary.get(), { bytes: 100, count: 1, intermediateBytes: 0 }, 'after deleting one export');
  clock += 1000;
  assert.deepEqual(await summary.get(), { bytes: 100, count: 1, intermediateBytes: 0 }, 'use the cache if nothing changed');
});

test('stale usage number: refreshIfStale measures once in the background (scanning is true, no waiting), and the number is real once measured; no new measurement starts within 60 seconds; measure only, no eviction', async t => {
  const { root, data } = await tempRoot(t);
  let clock = Date.now();
  await makeKey(root, key('old'), 3000, clock - 5 * HOUR);
  await writeStorageSettings(data, { frameLibraryCapBytes: 1000 });   // Well below total: would be deleted if evicted
  const m = manager(root, data, { now: () => clock });
  await m.rescan('test');
  assert.equal((await m.summary()).bytes, 3000);
  // Prerender just finished writing a batch: new directory, index unaware yet
  await makeKey(root, key('new'), 5000, clock);
  assert.equal((await m.summary()).bytes, 3000, 'the number is stale before the check');
  assert.equal(m.refreshIfStale(), true, 'never checked: start one');
  const during = await m.summary();
  assert.equal(during.scanning, true, 'the response carries scanning: true');
  assert.equal(m.refreshIfStale(), true, 'calling again while measuring does not start another');
  await m.flush();   // Serial chain: queued behind that pass
  await new Promise(resolve => setImmediate(resolve));
  const after = await m.summary();
  assert.equal(after.scanning, false);
  assert.equal(after.bytes, 8000, 'the real value once measuring is done');
  assert.equal(after.lastEvict, null, 'measure only, no eviction');
  assert.equal(await exists(relDir(root, key('old'))), true, 'not deleted even when over the cap (eviction follows its own cadence)');
  clock += 30_000;
  assert.equal(m.refreshIfStale(), false, 'no new one within 60 seconds');
  clock += 31_000;
  assert.equal(m.refreshIfStale(), true, 'starts again after 60 seconds');
  await m.close();
});

test('GET /api/storage calls refreshIfStale, and scanning in the response reflects reality; POST does not call it', async () => {
  const { createStorageHandler } = await import('../storage-routes.mjs');
  let calls = 0, scanningNow = false;
  const fake = {
    refreshIfStale() { calls++; scanningNow = true; return true; },
    async summary() { return { bytes: 1, capBytes: 2, capSource: 'default', diskBytes: 3, pinnedBytes: 0, scannedAt: 4, lastEvict: null, scanning: scanningNow, leftoverBytes: 0 }; },
    async clearCache() { return { freedBytes: 0, removed: 0, skipped: 0 }; },
  };
  const handler = createStorageHandler({ storage: () => fake, exports: { get: async () => ({ bytes: 0, count: 0, intermediateBytes: 0 }) } });
  const { Readable } = await import('node:stream');
  const call = (method, url) => new Promise(resolve => {
    const req = Readable.from([]);
    Object.assign(req, { method, url });
    const res = { statusCode: 0, setHeader() {}, end(text) { resolve({ status: this.statusCode, body: JSON.parse(text) }); } };
    handler(req, res, () => resolve({ next: true }));
  });
  const got = await call('GET', '/');
  assert.equal(calls, 1);
  assert.equal(got.body.frameLibrary.scanning, true);
  await call('POST', '/clear-cache');
  assert.equal(calls, 1, 'POST does not start one');
});

test('relOfPath: a file in the frame store maps to its key directory', () => {
  const root = path.join(os.tmpdir(), 'x', 'frame-library');
  const k = key('r');
  assert.equal(relOfPath(root, path.join(root, k, 'mov', 'full-1.tmp.mov')), k);
  assert.equal(relOfPath(root, path.join(root, 'controls', k, 'mov', 'full-1.tmp.mov')), `controls/${k}`);
  assert.equal(relOfPath(root, path.join(root, 'tracks', k, 'preview-1.tmp.mp4')), `tracks/${k}`);
  assert.equal(relOfPath(root, path.join(root, '.storage', 'trash', 'a')), null);
  assert.equal(relOfPath(root, path.join(root, '..', 'elsewhere', k)), null);
});

/** Creates leftover and normal files in a key directory; returns { dir, leftoverBytes } */
async function seedLeftovers(root, rel, dead = 424242) {
  const dir = relDir(root, rel);
  await fs.mkdir(path.join(dir, 'mov'), { recursive: true });
  await fs.mkdir(path.join(dir, 'html-cache', `live-${dead}-x`), { recursive: true });
  await fs.writeFile(path.join(dir, 'mov', `full-${dead}.tmp.mov`), Buffer.alloc(300));
  await fs.writeFile(path.join(dir, 'mov', `playback-${dead}-${crypto.randomUUID()}.mov`), Buffer.alloc(200));
  await fs.writeFile(path.join(dir, 'html-cache', `live-${dead}-x`, 'blob'), Buffer.alloc(100));
  await fs.writeFile(path.join(dir, 'mov', 'full.mov'), Buffer.alloc(1000));
  await fs.writeFile(path.join(dir, 'mov', `full-${process.pid}.tmp.mov`), Buffer.alloc(50));
  return { dir, leftoverBytes: 600 };
}

test('merge: each check also cleans up leftovers, and leftovers.bytes is the number after cleaning; when only eviction is stopped (PROMPTCUT_STORAGE_EVICT=0), leftovers are still cleaned', async t => {
  for (const evict of [true, false]) {
    const { root, data } = await tempRoot(t);
    const k = key(`lf-${evict}`);
    const { dir } = await seedLeftovers(root, k);
    const logs = [];
    const m = manager(root, data, { evict, log: (event, fields) => logs.push([event, fields]) });
    await m.rescan('test');
    assert.equal((await m.summary()).leftoverBytes, 600, 'counted before cleaning');
    await m.check({ force: true });
    const after = await m.summary();
    assert.equal(after.leftoverBytes, 0, `evict=${evict}: 0 after cleaning`);
    assert.equal(after.bytes, 1050, 'normal files and temp files of live processes are kept');
    assert.equal(await exists(path.join(dir, 'mov', 'full-424242.tmp.mov')), false);
    assert.equal(await exists(path.join(dir, 'html-cache', 'live-424242-x')), false);
    assert.equal(await exists(path.join(dir, 'mov', 'full.mov')), true);
    assert.equal(await exists(path.join(dir, 'mov', `full-${process.pid}.tmp.mov`)), true);
    const line = logs.find(([event]) => event === 'storage.leftovers');
    assert.ok(line && line[1].removed === 3 && line[1].bytes === 600, `logs one line: ${JSON.stringify(logs.map(l => l[0]))}`);
    await m.close();
  }
});

test('merge: leftovers are also cleaned before clearing the cache; nothing is cleaned when the frame store root is not named frame-library (the same guard as the startup cleanup); .storage is not treated as a leftover', async t => {
  const { root, data } = await tempRoot(t);
  const k = key('cc');
  await seedLeftovers(root, k);
  const m = manager(root, data, { now: () => Date.now() });
  await m.rescan('test');
  await m.clearCache();
  // Newly written directory is in cache cleanup protection window, keep it; delete leftovers as usual
  assert.equal(await exists(path.join(relDir(root, k), 'mov', 'full-424242.tmp.mov')), false);
  assert.equal((await m.summary()).leftoverBytes, 0);
  assert.equal(await exists(path.join(root, '.storage')), true, '.storage is still there');
  await m.close();

  const other = path.join(path.dirname(root), 'not-a-library');
  await fs.mkdir(other, { recursive: true });
  await seedLeftovers(other, k);
  const m2 = manager(other, data);
  await m2.check({ force: true });
  assert.equal(await exists(path.join(relDir(other, k), 'mov', 'full-424242.tmp.mov')), true, 'left alone when it is not a frame store root');
  assert.equal((await m2.summary()).leftoverBytes, 600, 'count only, no deletion');
  await m2.close();
});

test('measureDir: leftover detection is consistent with startup cleanup (a playback MOV with a pid is judged by its process; an old-format one without a pid counts only after an hour of inactivity)', async t => {
  const { root } = await tempRoot(t);
  const dir = path.join(root, key('pb'));
  await fs.mkdir(path.join(dir, 'mov'), { recursive: true });
  await fs.writeFile(path.join(dir, 'mov', `playback-424242-${crypto.randomUUID()}.mov`), Buffer.alloc(10));
  await fs.writeFile(path.join(dir, 'mov', `playback-${process.pid}-${crypto.randomUUID()}.mov`), Buffer.alloc(20));
  const fresh = path.join(dir, 'mov', `playback-${crypto.randomUUID()}.mov`);
  const old = path.join(dir, 'mov', `playback-${crypto.randomUUID()}.mov`);
  await fs.writeFile(fresh, Buffer.alloc(40));
  await fs.writeFile(old, Buffer.alloc(80));
  const now = Date.now();
  await fs.utimes(fresh, (now - 30 * MIN) / 1000, (now - 30 * MIN) / 1000);
  await fs.utimes(old, (now - 2 * HOUR) / 1000, (now - 2 * HOUR) / 1000);
  const measured = await measureDir(dir, { now, alive: pid => pid === process.pid });
  assert.equal(measured.leftover, 90, '10 from dead processes + 80 from old-format files untouched for two hours');
});

test('unstage of the ready index: remove deleted keys, and remove the local tier by prefix', () => {
  const hub = createReadyHub();
  const e = key('e'), s = key('s');
  hub.stageByKey({ kind: 'html', key: s, ranges: [[0, 3]] });
  hub.stageByKey({ kind: 'local', key: `${e}/${s}`, ranges: [[0, 3]] });
  hub.stageByKey({ kind: 'stream', key: s, ranges: [[0, 0]] });
  assert.equal(hub.unstage({ kind: 'local', prefix: `${e}/` }), 1);
  assert.equal(hub.unstage({ kind: 'html', key: s }), 1);
  assert.equal(hub.unstage({ kind: 'bogus', key: s }), 0);
  assert.deepEqual(hub.stagedKeys().map(item => item.kind), ['stream']);
});

test('fs.symlink junction is available when there are no junction permission issues (a precondition of this test file)', async t => {
  const { dir } = await tempRoot(t);
  await fs.mkdir(path.join(dir, 'a'));
  await fs.symlink(path.join(dir, 'a'), path.join(dir, 'b'), 'junction');
  assert.equal(fsSync.lstatSync(path.join(dir, 'b')).isSymbolicLink(), true, 'lstat treats a junction as a link');
});

test('routes: only three are recognized; response shape follows section 4 of the plan; out of range gives 400', async () => {
  const { storageRouteOf, createStorageHandler } = await import('../storage-routes.mjs');
  assert.equal(storageRouteOf({ method: 'GET', url: '/' }), '/');
  assert.equal(storageRouteOf({ method: 'GET', url: '/?detail=1' }), '/');
  assert.equal(storageRouteOf({ method: 'POST', url: '/cap' }), '/cap');
  assert.equal(storageRouteOf({ method: 'POST', url: '/clear-cache' }), '/clear-cache');
  for (const [method, url] of [['POST', '/'], ['GET', '/cap'], ['GET', '/clear-cache'], ['POST', '/../x'], ['GET', '/other']]) {
    assert.equal(storageRouteOf({ method, url }), null, `${method} ${url}`);
  }
  const calls = [];
  const fake = {
    async summary() { return { bytes: 1, capBytes: 2, capSource: 'default', diskBytes: 3, pinnedBytes: 0, scannedAt: 4, lastEvict: null, leftoverBytes: 5 }; },
    async setCap(bytes) {
      calls.push(bytes);
      if (bytes !== 7) throw Object.assign(new Error('out of range'), { code: 'CAP_OUT_OF_RANGE', status: 400, min: 5, max: 9 });
      return { capBytes: 7, pending: Promise.resolve() };
    },
    async clearCache() { return { freedBytes: 10, removed: 2, skipped: 1, removedUnits: [] }; },
  };
  const handler = createStorageHandler({ storage: () => fake, exports: { get: async () => ({ bytes: 6, count: 1, intermediateBytes: 2 }) } });
  const { Readable } = await import('node:stream');
  const call = (method, url, body) => new Promise(resolve => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    Object.assign(req, { method, url });
    const res = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(text) { resolve({ status: this.statusCode, body: JSON.parse(text) }); } };
    handler(req, res, () => resolve({ next: true }));
  });
  assert.deepEqual(await call('GET', '/'), { status: 200, body: { ok: true,
    frameLibrary: { bytes: 1, capBytes: 2, capSource: 'default', diskBytes: 3, pinnedBytes: 0, scannedAt: 4, lastEvict: null },
    exports: { bytes: 6, count: 1, intermediateBytes: 2 }, leftovers: { bytes: 5 } } });
  assert.deepEqual(await call('POST', '/cap', { bytes: 7 }), { status: 200, body: { ok: true, capBytes: 7 } });
  const bad = await call('POST', '/cap', { bytes: 1 });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'CAP_OUT_OF_RANGE');
  assert.equal(bad.body.min, 5);
  assert.deepEqual(await call('POST', '/clear-cache'), { status: 200, body: { ok: true, freedBytes: 10, removed: 2, skipped: 1 } });
  assert.deepEqual(await call('GET', '/nope'), { next: true });
});

test('startup: a missing index triggers an immediate rescan (measure only, no deletion); the first eviction decision waits until the grace period has passed', async t => {
  const { root, data } = await tempRoot(t);
  const clock = Date.now();
  await makeKey(root, key('s1'), 3000, clock - 5 * HOUR);
  await makeKey(root, key('s2'), 3000, clock - 4 * HOUR);
  await writeStorageSettings(data, { frameLibraryCapBytes: 4000 });
  const m = manager(root, data, { timers: true, startupGraceMs: 300, tickMs: 60 * MIN });
  await m.start();
  for (let i = 0; i < 50 && !(await m.summary()).scannedAt; i++) await new Promise(resolve => setTimeout(resolve, 20));
  const early = await m.summary();
  assert.ok(early.scannedAt, 'rescan starts immediately');
  assert.equal(early.bytes, 6000);
  assert.equal(await exists(relDir(root, key('s1'))), true, 'nothing is deleted within the grace period');
  for (let i = 0; i < 100 && !(await m.summary()).lastEvict; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(await exists(relDir(root, key('s1'))), false, 'after the grace period, decide once and delete the oldest');
  assert.equal(await exists(relDir(root, key('s2'))), true);
  await m.close();
});
