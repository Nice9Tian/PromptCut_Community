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

test('publication durability order: real file sync/rename with the directory seam; the intent becomes durable first, then the target, and the intent is cleared last', async t => {
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

test('intent directory sync failure occurring before rename: publication rejected, rollback completed, old content kept', async t => {
  const f = await fixture(t); await fs.writeFile(f.target, 'old'); let renamed = false, faulted = false;
  const io = { ...fs, rename: async (...args) => { renamed = true; return fs.rename(...args); } };
  const syncDirectory = async () => { if (!faulted && !await projectFileAccepted(f.target)) { faulted = true; throw new Error('intent-dirsync-failed'); } };
  await assert.rejects(publishProjectFile({ ...f, io, syncDirectory, replace: true, assert: async () => {} }), /intent-dirsync-failed/);
  assert.equal(renamed, false); assert.equal(await fs.readFile(f.target, 'utf8'), 'old'); assert.equal(await projectFileAccepted(f.target), true);
});

test('directory sync failure after the read endpoint is opened: keep the accepted target and failClose, do not allow the completion ACK', async t => {
  const f = await fixture(t); let renameDone = false, failed;
  const io = { ...fs, rename: async (...args) => { await fs.rename(...args); renameDone = true; } };
  const lease = { run: task => task(), failClose: error => { failed = error; } };
  const syncDirectory = async () => { if (renameDone && await projectFileAccepted(f.target)) throw new Error('accepted-dirsync-failed'); };
  await assert.rejects(publishProjectFile({ ...f, io, syncDirectory, lease, assert: async () => {} }), /accepted-dirsync-failed/);
  assert.match(failed.message, /accepted-dirsync-failed/); assert.equal(await fs.readFile(f.target, 'utf8'), 'new');
});

test('recovery with a missing backup fails closed exactly: keep the marker, and do not open an unaccepted target', async t => {
  const f = await fixture(t); await fs.writeFile(f.target, 'unaccepted');
  await fs.writeFile(f.marker, JSON.stringify({ v: 1, target: f.target, temp: f.temp, backup: path.join(f.dir, '.missing-backup') }));
  assert.throws(() => recoverProjectPublications(f.dir), { code: 'ENOENT' }); assert.equal(await projectFileAccepted(f.target), false);
});

test('this platform\'s directory sync capability and normal recovery use real syscalls; not equivalent to a physical power-loss test', async t => {
  const f = await fixture(t);
  assert.equal(await syncProjectDirectory(f.dir), projectDirectoryDurability === 'fsync');
  await fs.writeFile(f.target, 'unaccepted'); await fs.writeFile(f.marker, JSON.stringify({ v: 1, target: f.target, temp: f.temp, backup: null }));
  recoverProjectPublications(f.dir); await assert.rejects(fs.stat(f.target), { code: 'ENOENT' }); assert.equal(await projectFileAccepted(f.target), true);
});

test('recovery traversal explicitly rejects a symlink and does not follow it into other directories', { skip: process.platform === 'win32' ? 'Windows does not request symlink permission this round; the Linux wrapper run verifies it' : false }, async t => {
  const f = await fixture(t), other = path.join(f.dir, 'other'); await fs.mkdir(other); await fs.writeFile(path.join(other, 'keep'), 'owned');
  await fs.symlink(other, path.join(f.dir, 'link'), 'dir');
  assert.throws(() => recoverProjectPublications(f.dir), /project-publication-symlink/); assert.equal(await fs.readFile(path.join(other, 'keep'), 'utf8'), 'owned');
});
