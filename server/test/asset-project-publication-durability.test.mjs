import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { publishProjectFile, publicationMarker, projectFileAccepted, recoverProjectPublications, syncProjectDirectory, projectDirectoryDurability } from '../asset-store/project-io.mjs';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-publication-durability-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'owned.json'), temp = path.join(dir, '.pending');
  await fs.writeFile(temp, 'new'); return { dir, target, temp, marker: publicationMarker(target) };
}

test('发布耐久顺序：真实file sync/rename配合目录seam，意图先耐久、目标再耐久、最后清意图', async t => {
  const f = await fixture(t), events = [];
  const io = { ...fs, open: async (file, flags) => {
    const handle = await fs.open(file, flags), sync = handle.sync.bind(handle);
    handle.sync = async () => { events.push(`file-sync:${file === f.temp ? 'temp' : file === f.marker ? 'marker' : 'backup'}`); await sync(); }; return handle;
  }, rename: async (...args) => { events.push('rename'); return fs.rename(...args); }, rm: async (file, opts) => { if (file === f.marker) events.push('unlink-marker'); return fs.rm(file, opts); } };
  const syncDirectory = async dir => { if (dir === f.dir) events.push('dir-sync'); };
  await publishProjectFile({ ...f, io, syncDirectory, assert: async () => { events.push('fence'); } });
  const markerSync = events.indexOf('file-sync:marker'), rename = events.indexOf('rename'), unlink = events.indexOf('unlink-marker');
  assert.ok(events.indexOf('file-sync:temp') < markerSync);
  assert.deepEqual(events.slice(markerSync, rename), ['file-sync:marker', 'dir-sync', 'fence']);
  assert.deepEqual(events.slice(rename, unlink), ['rename', 'dir-sync', 'fence']);
  assert.equal(events[unlink + 1], 'dir-sync'); assert.equal(await fs.readFile(f.target, 'utf8'), 'new');
});

test('intent目录sync故障发生在rename前：拒发布、回退完成，旧内容保留', async t => {
  const f = await fixture(t); await fs.writeFile(f.target, 'old'); let renamed = false, faulted = false;
  const io = { ...fs, rename: async (...args) => { renamed = true; return fs.rename(...args); } };
  const syncDirectory = async () => { if (!faulted && !await projectFileAccepted(f.target)) { faulted = true; throw new Error('intent-dirsync-failed'); } };
  await assert.rejects(publishProjectFile({ ...f, io, syncDirectory, replace: true, assert: async () => {} }), /intent-dirsync-failed/);
  assert.equal(renamed, false); assert.equal(await fs.readFile(f.target, 'utf8'), 'old'); assert.equal(await projectFileAccepted(f.target), true);
});

test('开放读口后的目录sync故障：保留接受目标并failClose，不允许完成ACK', async t => {
  const f = await fixture(t); let renameDone = false, failed;
  const io = { ...fs, rename: async (...args) => { await fs.rename(...args); renameDone = true; } };
  const lease = { run: task => task(), failClose: error => { failed = error; } };
  const syncDirectory = async () => { if (renameDone && await projectFileAccepted(f.target)) throw new Error('accepted-dirsync-failed'); };
  await assert.rejects(publishProjectFile({ ...f, io, syncDirectory, lease, assert: async () => {} }), /accepted-dirsync-failed/);
  assert.match(failed.message, /accepted-dirsync-failed/); assert.equal(await fs.readFile(f.target, 'utf8'), 'new');
});

test('恢复缺backup准确failclosed：保留marker，不能把未接受目标开放', async t => {
  const f = await fixture(t); await fs.writeFile(f.target, 'unaccepted');
  await fs.writeFile(f.marker, JSON.stringify({ v: 1, target: f.target, temp: f.temp, backup: path.join(f.dir, '.missing-backup') }));
  assert.throws(() => recoverProjectPublications(f.dir), { code: 'ENOENT' }); assert.equal(await projectFileAccepted(f.target), false);
});

test('本平台目录sync能力与正常恢复真实syscall；不等价于物理掉电测试', async t => {
  const f = await fixture(t);
  assert.equal(await syncProjectDirectory(f.dir), projectDirectoryDurability === 'fsync');
  await fs.writeFile(f.target, 'unaccepted'); await fs.writeFile(f.marker, JSON.stringify({ v: 1, target: f.target, temp: f.temp, backup: null }));
  recoverProjectPublications(f.dir); await assert.rejects(fs.stat(f.target), { code: 'ENOENT' }); assert.equal(await projectFileAccepted(f.target), true);
});

test('恢复遍历遇symlink明确拒绝，不跟随到其它目录', { skip: process.platform === 'win32' ? 'Windows本轮不请求symlink权限，Linux包装运行实际验证' : false }, async t => {
  const f = await fixture(t), other = path.join(f.dir, 'other'); await fs.mkdir(other); await fs.writeFile(path.join(other, 'keep'), 'owned');
  await fs.symlink(other, path.join(f.dir, 'link'), 'dir');
  assert.throws(() => recoverProjectPublications(f.dir), /project-publication-symlink/); assert.equal(await fs.readFile(path.join(other, 'keep'), 'utf8'), 'owned');
});
