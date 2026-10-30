/**
 * 帧库的使用索引、上限、淘汰与清理缓存(`server/frame-library-storage.mjs`,存储占用计划 B 部分)。
 * 全部在临时目录里造帧库,不碰用户的 Videos\PromptCut。
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

/** 造一个键目录:一个 `bytes` 字节的文件,整棵的修改时刻设成 `mtime` */
async function makeKey(root, rel, bytes, mtime, file = 'mov/frames/000000.png') {
  const dir = relDir(root, rel);
  const full = path.join(dir, file);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, Buffer.alloc(bytes, 1));
  const seconds = mtime / 1000;
  // 从叶子往上设,免得建子目录又把父目录的时刻刷新
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

test('键目录的形状:认得的六种,认不出的一律 null', () => {
  const k = key(1);
  assert.deepEqual(parseRel(k), { rel: k, family: 'entry', key: k, unit: `entry:${k}` });
  assert.equal(parseRel(`controls-local/${k}`).unit, `entry:${k}`, '本地档和整场景是一个淘汰单元');
  for (const family of ['controls-html', 'controls', 'streams', 'tracks']) assert.equal(parseRel(`${family}/${k}`).unit, `${family}/${k}`);
  for (const bad of ['', 'abc', `controls-lock/${k}`, `controls-html/${k}/x`, `controls-html/..`, `../${k}`, `controls/${k.toUpperCase()}`, `controls-local/${k}/${k}`, null]) {
    assert.equal(parseRel(bad), null, String(bad));
  }
  assert.equal(relDir('/lib', `streams/${k}`), path.join('/lib', 'streams', k));
  assert.throws(() => relDir('/lib', '../x'));
});

test('上限:缺省 50 GB,磁盘小于 500 GB 取 10%;用户值在 5 GB 到磁盘总容量之间,越界的收进范围', () => {
  assert.equal(DEFAULT_CAP_BYTES, 50 * GB);
  assert.equal(MIN_CAP_BYTES, 5 * GB);
  assert.equal(defaultCapBytes(2000 * GB), 50 * GB);
  assert.equal(defaultCapBytes(500 * GB), 50 * GB, '正好 500 GB 不算小盘');
  assert.equal(defaultCapBytes(256 * GB), Math.floor(256 * GB * 0.1));
  assert.equal(GB, 1024 ** 3, 'GB 按 1024³');
  assert.equal(DEFAULT_CAP_BYTES, 53687091200);
  assert.equal(defaultCapBytes(500e9), Math.floor(500e9 * 0.1), '标称 500 GB(十进制)的盘不到 500 × 1024³,算小盘');
  assert.equal(defaultCapBytes(null), 50 * GB, '量不到磁盘时用 50 GB');
  assert.deepEqual(capRange(1000 * GB), { min: 5 * GB, max: 1000 * GB });
  assert.equal(validCap(5 * GB, 1000 * GB), true);
  assert.equal(validCap(5 * GB - 1, 1000 * GB), false);
  assert.equal(validCap(1000 * GB, 1000 * GB), true);
  assert.equal(validCap(1000 * GB + 1, 1000 * GB), false);
  assert.equal(validCap(6.5, 1000 * GB), false, '要整数字节');
  assert.equal(validCap(NaN, 1000 * GB), false);
  assert.deepEqual(resolveCap({}, 1000 * GB), { capBytes: 50 * GB, capSource: 'default' });
  assert.deepEqual(resolveCap({ frameLibraryCapBytes: 80 * GB }, 1000 * GB), { capBytes: 80 * GB, capSource: 'user' });
  assert.deepEqual(resolveCap({ frameLibraryCapBytes: 1 }, 1000 * GB), { capBytes: 5 * GB, capSource: 'user' });
  assert.deepEqual(resolveCap({ frameLibraryCapBytes: 9e15 }, 1000 * GB), { capBytes: 1000 * GB, capSource: 'user' });
  assert.equal(storageDataDir('/repo', {}), path.join('/repo', 'out'));
  assert.equal(storageDataDir('/repo', { PROMPTCUT_DATA_DIR: '/d' }), '/d');
});

test('storage.json 读写:合并写、原子写;读不懂当空', async t => {
  const { data } = await tempRoot(t);
  assert.deepEqual(await readStorageSettings(data), {});
  await writeStorageSettings(data, { other: 1 });
  await writeStorageSettings(data, { frameLibraryCapBytes: 7 * GB });
  assert.deepEqual(await readStorageSettings(data), { other: 1, frameLibraryCapBytes: 7 * GB });
  await fs.writeFile(path.join(data, SETTINGS_FILE), '{坏');
  assert.deepEqual(await readStorageSettings(data), {});
});

test('setCap:越界拒(CAP_OUT_OF_RANGE),合法的写进 storage.json 并立即判一次', async t => {
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
  assert.equal(await exists(relDir(root, key('a'))), false, '改上限立刻生效:最旧的删了');
  assert.equal(await exists(relDir(root, key('b'))), true);
  await m.close();
});

test('索引:第一次运行按目录重扫,最近使用时刻取最新文件的修改时刻;丢了、坏了都重建', async t => {
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
  assert.ok(Math.abs(snap[k1].at - (clock - 3 * HOUR)) < 2000, '最近使用 = 最新文件的修改时刻');
  assert.ok(Math.abs(snap[`controls-html/${k2}`].at - (clock - HOUR)) < 2000);
  const summary = await m.summary();
  assert.equal(summary.bytes, 220);
  assert.equal(summary.owner, true);
  assert.ok(summary.scannedAt);
  await m.close();

  // 索引在:新实例直接读,不重扫(记下的使用时刻保留)
  const m2 = manager(root, data, { now: () => clock });
  await m2.check({ force: true });
  m2.touch([k1], clock);
  await m2.flush();
  await m2.close();
  const m3 = manager(root, data, { now: () => clock });
  await m3.check({ force: true });
  assert.equal(m3.snapshot()[k1].at, clock, '索引读回来,记过的使用还在');
  await m3.close();

  // 坏了:重建
  await fs.writeFile(path.join(root, INDEX_FILE), 'not json');
  const m4 = manager(root, data, { now: () => clock });
  await m4.check({ force: true });
  assert.equal(Object.keys(m4.snapshot()).length, 3);
  await m4.close();

  // 丢了:重建
  await fs.rm(path.join(root, INDEX_FILE));
  const m5 = manager(root, data, { now: () => clock });
  await m5.check({ force: true });
  assert.equal((await m5.summary()).bytes, 220);
  await m5.close();
});

test('增量:新出现的键量一次、消失的删掉、记过使用的重量;不全量重扫', async t => {
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
  assert.equal(summary.scannedAt, scannedAt, '没有全量重扫');
  assert.equal(m.snapshot()[k1].bytes, 160, '记过使用的键重量了');
  assert.equal(m.snapshot()[`streams/${k2}`].bytes, 40, '新出现的键量了');
  await fs.rm(relDir(root, `streams/${k2}`), { recursive: true });
  await m.check({ force: true });
  assert.equal(m.snapshot()[`streams/${k2}`], undefined, '消失的键删掉');
  await m.close();
});

test('淘汰:N 个项目最近使用各不同,从旧到新删,删到上限的 90% 就停', async t => {
  const { root, data } = await tempRoot(t);
  const clock = Date.now();
  const projects = [];
  for (let i = 0; i < 6; i++) {
    const entry = key(`p${i}`), card = key(`card${i}`);
    const at = clock - (10 - i) * HOUR;          // p0 最旧
    await makeKey(root, entry, 1000, at);
    await makeKey(root, `controls-local/${entry}`, 200, at, `${card}/0.html`);
    await makeKey(root, `controls-html/${card}`, 300, at, '0.html');
    projects.push({ entry, card, at });
  }
  // 总量 6 × 1500 = 9000;上限 6000 → 删到 5400 以下:p0、p1 两个项目(3000)之后还差 600,
  // 再删 p2 的整场景单元(整场景 1000 + 本地档 200)就到 4800,p2 的共享档留着
  await writeStorageSettings(data, { frameLibraryCapBytes: 6000 });
  const m = manager(root, data, { now: () => clock });
  const result = await m.check({ force: true });
  assert.ok(result.evicted, '超上限要淘汰');
  const order = result.evicted.removedUnits.map(u => u.unit);
  const expected = [];
  for (const p of projects.slice(0, 3)) expected.push(`entry:${p.entry}`, `controls-html/${p.card}`);
  // 按最近使用时刻从旧到新:p0 的两个单元、p1 的两个、p2 的一个
  assert.equal(order.length, 5);
  assert.deepEqual(new Set(order.slice(0, 2)), new Set(expected.slice(0, 2)), '先删最旧的 p0');
  assert.deepEqual(new Set(order.slice(2, 4)), new Set(expected.slice(2, 4)), '再删 p1');
  assert.ok(expected.slice(4).includes(order[4]), '最后删 p2 的一个单元');
  const ats = result.evicted.removedUnits.map(u => u.at);
  assert.deepEqual(ats, [...ats].sort((a, b) => a - b), '从旧到新');
  const after = await m.summary();
  assert.ok(after.bytes <= 5400, `删到 90% 以下:${after.bytes}`);
  assert.equal(after.bytes, 4800, '删到够了就停,不多删');
  for (const p of projects.slice(0, 2)) {
    assert.equal(await exists(relDir(root, p.entry)), false);
    assert.equal(await exists(relDir(root, `controls-local/${p.entry}`)), false, '整场景删了,它的本地档一起删');
  }
  for (const p of projects.slice(3)) assert.equal(await exists(relDir(root, p.entry)), true);
  assert.equal(after.lastEvict.removed, 5);
  assert.equal(after.lastEvict.freedBytes, 4200);
  const trash = await fs.readdir(path.join(root, '.storage', 'trash')).catch(() => []);
  assert.deepEqual(trash, [], '垃圾目录删干净了');
  await m.close();
});

test('淘汰:30 分钟内用过的不删,正在打开的项目不删', async t => {
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
  assert.equal(await exists(relDir(root, recent)), true, '20 分钟前用过的不删');
  assert.equal(await exists(relDir(root, open)), true, '打开着的项目不删(哪怕文件很旧)');
  const summary = await m.summary({ detail: true });
  assert.equal(summary.pinnedBytes, 2000);
  assert.ok(summary.bytes > summary.capBytes, '删不动了就停在上限之上');
  assert.equal(summary.units.find(u => u.unit === `entry:${open}`).pinned, true);
  assert.ok(PROTECT_MS === 30 * MIN);
  await m.close();
});

test('清理缓存:只留 10 分钟内用过的(和正在打开的)', async t => {
  const { root, data } = await tempRoot(t);
  const clock = Date.now();
  const keep = key('keep'), drop1 = key('drop1'), drop2 = key('drop2');
  await makeKey(root, keep, 100, clock - 5 * MIN);
  await makeKey(root, `tracks/${drop1}`, 100, clock - 15 * MIN, '000000.png');
  await makeKey(root, `controls/${drop2}`, 100, clock - 3 * HOUR);
  const m = manager(root, data, { now: () => clock });
  await m.check({ force: true });
  assert.equal((await m.summary()).bytes, 300, '缺省上限 50 GB,不淘汰');
  const result = await m.clearCache();
  assert.equal(result.removed, 2);
  assert.equal(result.skipped, 0);
  assert.equal(result.freedBytes, 200);
  assert.equal(await exists(relDir(root, keep)), true);
  assert.equal((await m.summary()).bytes, 100, '清理之后数字变小');
  assert.equal(CLEAR_KEEP_MS, 10 * MIN);
  await m.close();
});

test('被打开的文件:整个单元跳过(不删一半),下一轮关掉之后再删', async t => {
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
    assert.equal(first.skipped, 1, '打开着的跳过');
    assert.equal(first.removed, 1);
    assert.equal(await exists(path.join(busyDir, 'mov', 'frames', '000000.png')), true, '跳过的单元一个文件都没删');
    assert.equal(await exists(relDir(root, `controls-local/${busy}`)), true, '整场景跳过时它的本地档也留着');
    const detail = (await m.summary({ detail: true })).lastEvictDetail;
    assert.equal(detail.skippedUnits[0].reason, 'busy');
    const second = await m.clearCache();
    assert.equal(second.removed, 1, '关掉之后下一轮删掉');
  }
  assert.equal(await exists(busyDir), false);
  assert.equal(await exists(relDir(root, free)), false);
  await m.close();
});

test('链接与认不出的目录:一律不动', async t => {
  const { dir, root, data } = await tempRoot(t);
  const clock = Date.now();
  const outside = path.join(dir, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'precious.txt'), 'keep me');
  const linkKey = key('link'), innerKey = key('inner');
  await fs.mkdir(path.join(root, 'controls-html'), { recursive: true });
  await fs.symlink(outside, path.join(root, 'controls-html', linkKey), 'junction');
  // 键目录本身是真目录,里面有一处链接:整个跳过
  const inner = await makeKey(root, `controls/${innerKey}`, 100, clock - 5 * HOUR);
  await fs.symlink(outside, path.join(inner, 'escape'), 'junction');
  await fs.utimes(inner, (clock - 5 * HOUR) / 1000, (clock - 5 * HOUR) / 1000);
  // 认不出的:形状不对的名字、别的族、根下的文件
  await makeKey(root, key('ok'), 10, clock - 5 * HOUR);
  await fs.mkdir(path.join(root, 'controls-html', 'not-a-key'), { recursive: true });
  await fs.mkdir(path.join(root, 'controls-lock'), { recursive: true });
  await fs.writeFile(path.join(root, 'controls-lock', 'locks.json'), '{}');
  await fs.mkdir(path.join(root, 'something-else', key('x')), { recursive: true });
  await fs.writeFile(path.join(root, 'push-queue.json'), '[]');
  const m = manager(root, data, { now: () => clock });
  await m.check({ force: true });
  assert.equal(m.snapshot()[`controls-html/${linkKey}`], undefined, '链接形状的键目录不进索引');
  const result = await m.clearCache();
  assert.equal(result.removed, 1, '只删了那个正常的');
  assert.equal(result.skipped, 1, '里面有链接的键目录跳过');
  assert.equal(await fs.readFile(path.join(outside, 'precious.txt'), 'utf8'), 'keep me', '链接指向的地方完好');
  assert.equal(await exists(inner), true);
  for (const kept of [path.join(root, 'controls-html', 'not-a-key'), path.join(root, 'controls-lock', 'locks.json'), path.join(root, 'something-else', key('x')), path.join(root, 'push-queue.json')]) {
    assert.equal(await exists(kept), true, kept);
  }
  await m.close();
});

test('族目录本身是链接:整族不认', async t => {
  const { dir, root } = await tempRoot(t);
  const outside = path.join(dir, 'streams-elsewhere');
  await fs.mkdir(path.join(outside, key('s')), { recursive: true });
  await fs.symlink(outside, path.join(root, 'streams'), 'junction');
  assert.deepEqual(await listRels(root), []);
});

test('记使用:一个版本用到的键(整场景、本地档、共享档、独立卡、轨道前缀、轨道流)一起记', async t => {
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
  assert.equal(entryUsageRels(pipeline, entry), entryUsageRels(pipeline, entry), '同一个计划不重算');
  const m = manager(root, data, { now: () => clock }).attachPipeline(pipeline);
  await m.check({ force: true });
  m.touchEntry(entry, clock);
  const snap = m.snapshot();
  for (const rel of rels) assert.equal(snap[rel]?.at, clock, rel);
  await m.close();
});

test('多进程:只有一个主进程写索引;别的进程的使用经 touch 文件并进来,进程不在了文件删掉', async t => {
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
  assert.equal(b.owner, false, '第二个进程不是主进程');
  b.touch([k], clock - 1000);
  await b.flush();
  const touchFile = path.join(root, '.storage', 'touch', `${fakePid}.json`);
  assert.equal(await exists(touchFile), true);
  await assert.rejects(b.clearCache(), error => error.code === 'STORAGE_NOT_OWNER');
  const result = await a.clearCache();
  assert.deepEqual(result.removedUnits.map(u => u.unit), [`entry:${key('old')}`], '别的进程刚用过的不删');
  assert.equal(a.snapshot()[k].at, clock - 1000);
  // 那个进程不在了:并完删文件
  const a2 = manager(root, data, { now: () => clock, pid: process.pid, alive: pid => pid === process.pid });
  await a.close();
  await a2.check({ force: true });
  assert.equal(await exists(touchFile), false);
  await a2.close();
  await b.close();
});

test('主进程锁:心跳过期或进程不在了可以接管', async t => {
  const { root, data } = await tempRoot(t);
  const clock = Date.now();
  await fs.mkdir(path.join(root, '.storage'), { recursive: true });
  await fs.writeFile(path.join(root, '.storage', 'owner.json'), JSON.stringify({ pid: 424242, at: clock }));
  const m = manager(root, data, { now: () => clock, alive: pid => pid === process.pid });
  await m.check({ force: true });
  assert.equal(m.owner, true, '锁的主人不在了,接管');
  await m.close();
  assert.equal(await exists(path.join(root, '.storage', 'owner.json')), false, '关的时候放锁');
});

test('measureDir:遗留文件(死进程的 spill、中止的 tmp.mov、tmp.mp4)单独计', async t => {
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
  assert.equal(measured.leftover, 90, '只算死进程的');
  assert.equal(measured.linked, false);
  assert.equal((await measureDir(path.join(root, 'nope'))).missing, true);
});

test('导出汇总:总字节、份数、中间文件(成片、透明层、project.json 以外的);不含 export-vision-*', async t => {
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

test('合并:/api/storage 的导出一栏(createExportSummary)与 /api/exports 的列表同一套规则,数字对得上', async t => {
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
  // 名字对、但是个链接(junction):两边都不认
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

test('合并:导出列表删了一份、只删了中间文件,/api/storage 的导出一栏马上跟上(不等 60 秒缓存)', async t => {
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
  assert.deepEqual(await summary.get(), { bytes: 500, count: 2, intermediateBytes: 300 }, '只删中间文件之后');
  assert.equal((await deleteExport(exportsDir, 'export-20260929-121212')).ok, true);
  assert.deepEqual(await summary.get(), { bytes: 100, count: 1, intermediateBytes: 0 }, '删一份之后');
  clock += 1000;
  assert.deepEqual(await summary.get(), { bytes: 100, count: 1, intermediateBytes: 0 }, '没变就用缓存');
});

test('占用数字过期:refreshIfStale 在后台量一次(scanning 为 true,不等),量完数字是真的;60 秒内不再发起;只量不淘汰', async t => {
  const { root, data } = await tempRoot(t);
  let clock = Date.now();
  await makeKey(root, key('old'), 3000, clock - 5 * HOUR);
  await writeStorageSettings(data, { frameLibraryCapBytes: 1000 });   // 远低于总量:要是淘汰就会删
  const m = manager(root, data, { now: () => clock });
  await m.rescan('test');
  assert.equal((await m.summary()).bytes, 3000);
  // 预渲染刚写完一批:新目录,索引还不知道
  await makeKey(root, key('new'), 5000, clock);
  assert.equal((await m.summary()).bytes, 3000, '检查之前数字是旧的');
  assert.equal(m.refreshIfStale(), true, '从没检查过:发起');
  const during = await m.summary();
  assert.equal(during.scanning, true, '回包带 scanning: true');
  assert.equal(m.refreshIfStale(), true, '在量时再调不重复发起');
  await m.flush();   // 串行链:排在那一趟后面
  await new Promise(resolve => setImmediate(resolve));
  const after = await m.summary();
  assert.equal(after.scanning, false);
  assert.equal(after.bytes, 8000, '量完是真实值');
  assert.equal(after.lastEvict, null, '只量不淘汰');
  assert.equal(await exists(relDir(root, key('old'))), true, '超上限也不删(淘汰照自己的节拍)');
  clock += 30_000;
  assert.equal(m.refreshIfStale(), false, '60 秒内不再发起');
  clock += 31_000;
  assert.equal(m.refreshIfStale(), true, '过了 60 秒再发起');
  await m.close();
});

test('GET /api/storage 调 refreshIfStale,回包的 scanning 照实;POST 不调', async () => {
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
  assert.equal(calls, 1, 'POST 不发起');
});

test('relOfPath:帧库里的文件归到它的键目录', () => {
  const root = path.join(os.tmpdir(), 'x', 'frame-library');
  const k = key('r');
  assert.equal(relOfPath(root, path.join(root, k, 'mov', 'full-1.tmp.mov')), k);
  assert.equal(relOfPath(root, path.join(root, 'controls', k, 'mov', 'full-1.tmp.mov')), `controls/${k}`);
  assert.equal(relOfPath(root, path.join(root, 'tracks', k, 'preview-1.tmp.mp4')), `tracks/${k}`);
  assert.equal(relOfPath(root, path.join(root, '.storage', 'trash', 'a')), null);
  assert.equal(relOfPath(root, path.join(root, '..', 'elsewhere', k)), null);
});

/** 在一个键目录里造遗留文件与正常文件;回 { dir, leftoverBytes } */
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

test('合并:每次检查一并清遗留,leftovers.bytes 是清完之后的数;只停淘汰(PROMPTCUT_STORAGE_EVICT=0)时遗留照清', async t => {
  for (const evict of [true, false]) {
    const { root, data } = await tempRoot(t);
    const k = key(`lf-${evict}`);
    const { dir } = await seedLeftovers(root, k);
    const logs = [];
    const m = manager(root, data, { evict, log: (event, fields) => logs.push([event, fields]) });
    await m.rescan('test');
    assert.equal((await m.summary()).leftoverBytes, 600, '清之前计得到');
    await m.check({ force: true });
    const after = await m.summary();
    assert.equal(after.leftoverBytes, 0, `evict=${evict}:清完之后是 0`);
    assert.equal(after.bytes, 1050, '正常文件与活进程的临时文件留着');
    assert.equal(await exists(path.join(dir, 'mov', 'full-424242.tmp.mov')), false);
    assert.equal(await exists(path.join(dir, 'html-cache', 'live-424242-x')), false);
    assert.equal(await exists(path.join(dir, 'mov', 'full.mov')), true);
    assert.equal(await exists(path.join(dir, 'mov', `full-${process.pid}.tmp.mov`)), true);
    const line = logs.find(([event]) => event === 'storage.leftovers');
    assert.ok(line && line[1].removed === 3 && line[1].bytes === 600, `记一行日志:${JSON.stringify(logs.map(l => l[0]))}`);
    await m.close();
  }
});

test('合并:清理缓存前也清遗留;帧库根不叫 frame-library 时不清(与启动清理同一道保护);.storage 不被当成遗留', async t => {
  const { root, data } = await tempRoot(t);
  const k = key('cc');
  await seedLeftovers(root, k);
  const m = manager(root, data, { now: () => Date.now() });
  await m.rescan('test');
  await m.clearCache();
  // 刚写的目录在清理缓存的保护窗里,留着;遗留照删
  assert.equal(await exists(path.join(relDir(root, k), 'mov', 'full-424242.tmp.mov')), false);
  assert.equal((await m.summary()).leftoverBytes, 0);
  assert.equal(await exists(path.join(root, '.storage')), true, '.storage 还在');
  await m.close();

  const other = path.join(path.dirname(root), 'not-a-library');
  await fs.mkdir(other, { recursive: true });
  await seedLeftovers(other, k);
  const m2 = manager(other, data);
  await m2.check({ force: true });
  assert.equal(await exists(path.join(relDir(other, k), 'mov', 'full-424242.tmp.mov')), true, '不是帧库根不动');
  assert.equal((await m2.summary()).leftoverBytes, 600, '只计不删');
  await m2.close();
});

test('measureDir:遗留认法与启动清理一致(带 pid 的播放 MOV 看进程;旧版不带 pid 的一小时没动才算)', async t => {
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
  assert.equal(measured.leftover, 90, '死进程的 10 + 两小时没动的旧版 80');
});

test('就绪索引的 unstage:摘掉被删的键,本地档按前缀摘', () => {
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

test('没有 junction 权限问题时 fs.symlink junction 可用(本测试文件的前提)', async t => {
  const { dir } = await tempRoot(t);
  await fs.mkdir(path.join(dir, 'a'));
  await fs.symlink(path.join(dir, 'a'), path.join(dir, 'b'), 'junction');
  assert.equal(fsSync.lstatSync(path.join(dir, 'b')).isSymbolicLink(), true, 'lstat 把 junction 当链接');
});

test('路由:只认三条;回包形状照计划第 4 节;越界 400', async () => {
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
      if (bytes !== 7) throw Object.assign(new Error('越界'), { code: 'CAP_OUT_OF_RANGE', status: 400, min: 5, max: 9 });
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

test('启动:索引缺失马上重扫(只量不删),第一次判淘汰等宽限期过了才做', async t => {
  const { root, data } = await tempRoot(t);
  const clock = Date.now();
  await makeKey(root, key('s1'), 3000, clock - 5 * HOUR);
  await makeKey(root, key('s2'), 3000, clock - 4 * HOUR);
  await writeStorageSettings(data, { frameLibraryCapBytes: 4000 });
  const m = manager(root, data, { timers: true, startupGraceMs: 300, tickMs: 60 * MIN });
  await m.start();
  for (let i = 0; i < 50 && !(await m.summary()).scannedAt; i++) await new Promise(resolve => setTimeout(resolve, 20));
  const early = await m.summary();
  assert.ok(early.scannedAt, '重扫马上开始');
  assert.equal(early.bytes, 6000);
  assert.equal(await exists(relDir(root, key('s1'))), true, '宽限期内不删');
  for (let i = 0; i < 100 && !(await m.summary()).lastEvict; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(await exists(relDir(root, key('s1'))), false, '宽限期过了判一次,删最旧的');
  assert.equal(await exists(relDir(root, key('s2'))), true);
  await m.close();
});
