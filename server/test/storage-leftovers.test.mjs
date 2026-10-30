// 存储计划 A 部分（docs/plan/storage-plan.md）：遗留文件的启动清理、导出中间文件、中止写入即删、播放 MOV 用完即删。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  pidAlive, sweepFrameLibrary, sweepExportRoot, pruneExportDir, claimExportDir, EXPORT_KEEP, LEGACY_PLAYBACK_AGE_MS,
} from '../storage-leftovers.mjs';
import { MovFrameStore, PlaybackMovStore } from '../frame-mov.mjs';
import { FramePipeline } from '../frame-pipeline.mjs';

const DEAD = 424242;
const ALIVE = process.pid;
const alive = pid => pid !== DEAD;
const key = n => n.toString(16).padStart(64, '0');
const exists = p => fs.lstat(p).then(() => true, () => false);

async function put(root, rel, text = 'x', when = null) {
  const full = path.join(root, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, text);
  if (when) await fs.utimes(full, when, when);
  return full;
}
const tmpRoot = prefix => fs.mkdtemp(path.join(os.tmpdir(), prefix));

test('pidAlive: 本进程在,一个已退出的进程不在', () => {
  assert.equal(pidAlive(process.pid), true);
  const child = spawnSync(process.execPath, ['-e', '0']);
  assert.equal(child.status, 0);
  assert.equal(pidAlive(child.pid), false);
  assert.equal(pidAlive('abc'), true, '拿不准按「在」处理');
});

test('sweepFrameLibrary 只清死进程留下的几种形态,别的一律不动', async () => {
  const base = await tmpRoot('pc-sweep-lib-');
  const root = path.join(base, 'frame-library');
  const outside = path.join(base, 'outside');
  try {
    const k = key(1), c = key(2), t = key(3);
    const uuid = randomUUID();
    const old = new Date(Date.now() - LEGACY_PLAYBACK_AGE_MS - 60_000);
    const gone = [
      await put(root, `${k}/mov/full-${DEAD}.tmp.mov`),
      await put(root, `${k}/mov/playback-${DEAD}-${uuid}.mov`),
      await put(root, `${k}/mov/playback-${randomUUID()}.mov`, 'x', old),       // 旧版,没有 pid,早就没人动
      await put(root, `${k}/html-cache/live-${DEAD}-abc123/stage/000.json`),
      await put(root, `${k}/preview-${DEAD}.tmp.mp4`),
      await put(root, `tracks/${t}/preview-${DEAD}.tmp.mp4`),
      await put(root, `controls/${c}/mov/full-${DEAD}.tmp.mov`),
    ];
    const kept = [
      await put(root, `${k}/mov/full-${ALIVE}.tmp.mov`),
      await put(root, `${k}/mov/full.mov`),
      await put(root, `${k}/mov/frames/000000.png`),
      await put(root, `${k}/mov/frames.json`),
      await put(root, `${k}/mov/playback-${ALIVE}-${uuid}.mov`),
      await put(root, `${k}/mov/playback-${randomUUID()}.mov`),                  // 旧版但刚写过
      await put(root, `${k}/html-cache/live-${ALIVE}-def456/stage/000.json`),
      await put(root, `${k}/html-cache/frames.json`),
      await put(root, `${k}/preview.mp4`),
      await put(root, `tracks/${t}/preview.mp4`),
      await put(root, `tracks/${t}/000000.png`),
      await put(root, `controls/${c}/mov/full.mov`),
      await put(root, `not-a-key/mov/full-${DEAD}.tmp.mov`),                    // 不认得的目录
      await put(root, `${k}/mov/full-${DEAD}.tmp.mov.bak`),                    // 不认得的名字
    ];
    // 链接:死进程名字的 spill 指向帧库外(junction),以及 spill 目录里面藏着一个链接 —— 都跳过,外面的文件不动
    const target = await put(outside, 'keep.txt');
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    await fs.symlink(outside, path.join(root, k, 'html-cache', `live-${DEAD}-link`), linkType);
    await put(root, `${k}/html-cache/live-${DEAD}-nested/a.json`);
    await fs.symlink(outside, path.join(root, k, 'html-cache', `live-${DEAD}-nested`, 'inner'), linkType);

    const report = await sweepFrameLibrary(root, { alive });
    for (const f of gone) assert.equal(await exists(f), false, `应删:${path.relative(root, f)}`);
    for (const f of kept) assert.equal(await exists(f), true, `应留:${path.relative(root, f)}`);
    assert.equal(await exists(target), true, '链接指向的文件不动');
    assert.equal(await exists(path.join(root, k, 'html-cache', `live-${DEAD}-nested`, 'a.json')), true, '含链接的目录整个跳过');
    assert.equal(report.removed.length, gone.length, '每个遗留一条(spill 目录整个算一条)');
    assert.deepEqual(report.skipped.map(s => s.reason).sort(), ['link', 'link']);
    assert.ok(report.bytes > 0);
  } finally { await fs.rm(base, { recursive: true, force: true }); }
});

test('sweepExportRoot 只清死进程的 export-vision-*', async () => {
  const root = await tmpRoot('pc-sweep-out-');
  try {
    const dead = await put(root, `export-vision-${DEAD}-abc-0/frames/000000.png`);
    const live = await put(root, `export-vision-${ALIVE}-abc-1/project.json`);
    const user = await put(root, 'export-20260929-120000/preview.mp4');
    const media = await put(root, 'media/clip.mp4');
    await sweepExportRoot(root, { alive });
    assert.equal(await exists(path.dirname(path.dirname(dead))), false);
    for (const f of [live, user, media]) assert.equal(await exists(f), true);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

const INTERMEDIATE = ['frames/000000.png', 'parts/000/overlay.mov', 'parts/001/overlay.mov', 'glass/000000.png', 'audio/mix.wav',
  'media/clip.mp4', 'dom/000000.html', 'filter-0.cmd', 'filter-graph.txt', 'compose-filter.txt', 'preview-audio.mp4', 'trace.json',
  'overlay.mov.concat.txt'];

test('导出成功后产物目录只剩成片、透明层与 project.json', async () => {
  const dir = await tmpRoot('pc-prune-done-');
  try {
    for (const rel of [...INTERMEDIATE, ...EXPORT_KEEP]) await put(dir, rel, rel);
    const report = await pruneExportDir(dir);
    assert.deepEqual((await fs.readdir(dir)).sort(), [...EXPORT_KEEP].sort());
    for (const name of EXPORT_KEEP) assert.equal(await fs.readFile(path.join(dir, name), 'utf8'), name, '留下的文件内容不动');
    assert.equal(report.skipped.length, 0);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('取消、失败的导出:大块中间文件不在,已有的 project.json 与成片 / 透明层留下;链接跳过', async () => {
  const base = await tmpRoot('pc-prune-cancel-');
  const dir = path.join(base, 'export-20260929-120000');
  const outside = path.join(base, 'elsewhere');
  try {
    await put(dir, 'project.json');
    await put(dir, 'overlay.mov');                       // 渲完了、合成时失败
    await put(dir, 'parts/000/overlay.mov');
    await put(dir, 'frames/000001.png');
    const target = await put(outside, 'user.mp4');
    await fs.symlink(outside, path.join(dir, 'media'), process.platform === 'win32' ? 'junction' : 'dir');
    const report = await pruneExportDir(dir);
    assert.deepEqual((await fs.readdir(dir)).sort(), ['media', 'overlay.mov', 'project.json']);
    assert.equal(await exists(target), true);
    assert.deepEqual(report.skipped.map(s => s.reason), ['link']);
  } finally { await fs.rm(base, { recursive: true, force: true }); }
});

test('同一秒两次导出不复用目录', async () => {
  const base = await tmpRoot('pc-claim-');
  try {
    const at = new Date(2026, 8, 29, 12, 34, 56);
    const [a, b, c] = await Promise.all([claimExportDir(base, at), claimExportDir(base, at), claimExportDir(base, at)]);
    assert.deepEqual([a.id, b.id, c.id].sort(), ['20260929-123456', '20260929-123456-2', '20260929-123456-3']);
    assert.equal(new Set([a.outDir, b.outDir, c.outDir]).size, 3);
    for (const r of [a, b, c]) assert.equal(r.outDir, path.resolve(base, `export-${r.id}`));
  } finally { await fs.rm(base, { recursive: true, force: true }); }
});

test('合并:导出目录的规则只有一份 —— claimExportDir 起的名字导出列表都认得,只删中间文件与导出完成后的收拾留下同一组', async () => {
  const L = await import('../exports-list.mjs');
  const S = await import('../storage-leftovers.mjs');
  assert.equal(L.EXPORT_ID_RE, S.EXPORT_ID_RE, '同一个正则对象');
  assert.equal(L.KEEP_NAMES, S.EXPORT_KEEP, '留下的名字同一份');
  assert.equal(L.DELIVERABLE_NAMES, S.EXPORT_DELIVERABLES);
  assert.deepEqual([...S.EXPORT_KEEP], ['preview.mp4', 'overlay.mov', 'project.json']);
  const base = await tmpRoot('pc-claim-rule-');
  try {
    const at = new Date(2026, 8, 29, 8, 5, 9);
    const claimed = [];
    for (let i = 0; i < 12; i++) claimed.push(await claimExportDir(base, at));
    for (const { id, outDir } of claimed) {
      const name = path.basename(outDir);
      assert.equal(S.isExportDirName(name), true, name);
      const parsed = L.parseExportId(name);
      assert.ok(parsed, name);
      assert.equal(parsed.at.getTime(), at.getTime(), '列表里的时刻就是起名的时刻');
      assert.equal(name, `export-${id}`);
    }
    assert.deepEqual(claimed.map(c => L.parseExportId(path.basename(c.outDir)).seq), [0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], '后缀从 -2 起');
    // 两边收拾同一份目录,结果一样
    const one = path.join(base, 'a'), two = path.join(base, 'b');
    for (const dir of [one, two]) for (const rel of [...INTERMEDIATE, ...EXPORT_KEEP]) await put(dir, rel, rel);
    await pruneExportDir(one);
    await fs.rename(two, path.join(base, 'export-20260929-080510'));
    const pruned = await L.pruneExport(base, 'export-20260929-080510');
    assert.equal(pruned.ok, true);
    assert.deepEqual((await fs.readdir(one)).sort(), (await fs.readdir(path.join(base, 'export-20260929-080510'))).sort());
    const listed = (await L.listExports(base)).map(item => item.id);
    assert.equal(listed.length, 13, '12 个起的名字加一个改名的,全列出');
  } finally { await fs.rm(base, { recursive: true, force: true }); }
});

test('MovFrameStore.suspend 中止写入后临时 MOV 不在', async () => {
  const dir = await tmpRoot('pc-suspend-');
  try {
    const store = new MovFrameStore({ dir });
    // 写入器只建文件、abort 什么都不删:删文件必须是 suspend 自己做的
    const factory = (_ffmpeg, file) => {
      fsSync.mkdirSync(path.dirname(file), { recursive: true }); fsSync.writeFileSync(file, 'partial');
      return { write: async () => {}, finish: async () => {}, abort: async () => {} };
    };
    await store.start('ffmpeg', factory);
    assert.equal(await exists(store.tempMovie), true);
    await store.suspend();
    assert.equal(await exists(store.tempMovie), false);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('PlaybackMovStore:文件名带 pid,dispose 删文件', async () => {
  const dir = await tmpRoot('pc-playback-mov-');
  try {
    const movie = new PlaybackMovStore({ dir, width: 8, height: 8, fps: 30, count: 4 });
    await movie.ready;
    assert.match(movie.name, new RegExp(`^playback-${process.pid}-[0-9a-f-]{36}\\.mov$`));
    assert.equal(await exists(movie.movieFile), true);
    await movie.dispose();
    assert.equal(await exists(movie.movieFile), false);
    await movie.put(0, Buffer.from('late')).catch(() => {});   // 晚到的写入不会把文件建回来
    assert.equal(await exists(movie.movieFile), false);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('旧式播放会话:换版本、会话结束、关闭时播放 MOV 都删掉', async () => {
  const dir = await tmpRoot('pc-playback-life-');
  const pipeline = new FramePipeline({ root: dir, origin: () => '' });
  const project = n => ({ id: 'life', width: 16, height: 8, fps: 10, duration: n, tracks: [], media: [] });
  const movies = async () => {
    const found = [];
    for (const k of await fs.readdir(dir).catch(() => [])) {
      for (const f of await fs.readdir(path.join(dir, k, 'mov')).catch(() => [])) if (f.startsWith('playback-')) found.push(path.join(k, f));
    }
    return found.sort();
  };
  try {
    await pipeline.updatePlayback(project(1), { owner: 'a', sequence: 1, t: 0, playing: false });
    const first = await movies();
    assert.equal(first.length, 1);
    await pipeline.updatePlayback(project(2), { owner: 'a', sequence: 2, t: 0, playing: false });
    const second = await movies();
    assert.equal(second.length, 1, '换到另一版,上一版的播放 MOV 删掉');
    assert.notDeepEqual(second, first);
    await pipeline.updatePlayback(project(2), { owner: 'a', sequence: 3, close: true, t: 0, playing: false });
    assert.deepEqual(await movies(), [], '会话结束即删');
    await pipeline.updatePlayback(project(1), { owner: 'b', sequence: 1, t: 0, playing: false });
    assert.equal((await movies()).length, 1);
    await pipeline.close();
    assert.deepEqual(await movies(), [], '关闭时删');
  } finally { await pipeline.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('FramePipeline 只对真正的帧库根做启动清理', async () => {
  const base = await tmpRoot('pc-sweep-ctor-');
  try {
    // 用一个确实已退出的 pid,走真的 pidAlive
    const gonePid = spawnSync(process.execPath, ['-e', '0']).pid;
    const k = key(9);
    const lib = path.join(base, 'frame-library');
    const leftover = await put(lib, `${k}/mov/full-${gonePid}.tmp.mov`);
    const other = path.join(base, 'not-library');
    const untouched = await put(other, `${k}/mov/full-${gonePid}.tmp.mov`);
    const a = new FramePipeline({ root: lib, origin: () => '' });
    const b = new FramePipeline({ root: other, origin: () => '' });
    try {
      await a.leftoverSweep; await b.leftoverSweep;
      assert.equal(await exists(leftover), false);
      assert.equal(await exists(untouched), true);
    } finally { await a.close(); await b.close(); }
  } finally { await fs.rm(base, { recursive: true, force: true }); }
});
