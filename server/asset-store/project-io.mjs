/** 项目文件读写收口：异步open/发布/回退都属于lease，不以HTTP finish替代实际I/O完成。 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const locks = new Map();
// Windows 的 Node 目录句柄不提供这里需要的 fsync；不把文件 sync 冒称目录耐久。
export const projectDirectoryDurability = process.platform === 'win32' ? 'unsupported' : 'fsync';
export async function syncProjectDirectory(dir, io = fs) {
  if (projectDirectoryDurability === 'unsupported') return false;
  const handle = await io.open(dir, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
  return true;
}
function syncDirectorySync(dir) {
  if (projectDirectoryDurability === 'unsupported') return;
  const fd = fsSync.openSync(dir, 'r');
  try { fsSync.fsyncSync(fd); } finally { fsSync.closeSync(fd); }
}
async function syncFile(file, io) {
  const handle = await io.open(file, 'r+');
  try { await handle.sync(); } finally { await handle.close(); }
}
export const publicationMarker = target => `${target}.project-publication.json`;
export async function projectFileAccepted(target) { try { await fs.stat(publicationMarker(target)); return false; } catch (error) { if (error.code !== 'ENOENT') throw error; return true; } }

/** 重启仅回收本项目未完成发布的意图；路径严格限制在本目录，不能据文件内容碰其它项目。 */
export function recoverProjectPublications(root) {
  const base = path.resolve(root);
  const walk = dir => {
    let entries; try { entries = fsSync.readdirSync(dir, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new Error('project-publication-symlink');
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(file); continue; }
      if (!entry.name.endsWith('.project-publication.json')) continue;
      const record = JSON.parse(fsSync.readFileSync(file, 'utf8'));
      for (const value of [record.target, record.temp, record.backup].filter(Boolean)) if (!path.resolve(value).startsWith(base + path.sep) || path.dirname(path.resolve(value)) !== dir) throw new Error('invalid-project-publication-path');
      if (record.v !== 1 || publicationMarker(record.target) !== file) throw new Error('invalid-project-publication');
      if (record.backup) fsSync.renameSync(record.backup, record.target);
      else fsSync.rmSync(record.target, { force: true });
      syncDirectorySync(dir); // 先耐久恢复目标，再允许意图消失。
      fsSync.rmSync(record.temp, { force: true }); fsSync.rmSync(file); syncDirectorySync(dir);
    }
  };
  walk(base);
}

/** 同目标串行事务：未通过commit重核的文件带持久intent且不可读；回退完成才关闭lease资源。 */
export function publishProjectFile({ temp, target, assert, lease, io = fs, syncDirectory = dir => syncProjectDirectory(dir, io), replace = false, afterCommit = async () => {}, rollback = async () => {} }) {
  const work = async () => {
    let had = false, backup = null, intent = false, changed = false, afterStarted = false, accepted = false;
    const marker = publicationMarker(target), dir = path.dirname(target);
    try {
      await assert();
      if (!await projectFileAccepted(target)) throw new Error('project-publication-pending');
      try { await io.stat(target); had = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (had && !replace) { await io.rm(temp, { force: true }); afterStarted = true; await afterCommit(); await assert(); return { had }; }
      await syncFile(temp, io);
      if (had) { backup = `${target}.${crypto.randomUUID()}.backup`; await io.copyFile(target, backup); await syncFile(backup, io); }
      // 连同新建的项目/分片目录名称收口，不能仅同步最深目录的文件名。
      for (let ancestor = dir; ; ancestor = path.dirname(ancestor)) { await syncDirectory(ancestor); if (path.dirname(ancestor) === ancestor) break; }
      const handle = await io.open(marker, 'wx');
      intent = true; // 即使 write/sync 失败也要回收已创建的意图。
      try { await handle.writeFile(JSON.stringify({ v: 1, target, temp, backup })); await handle.sync(); } finally { await handle.close(); }
      await syncDirectory(dir); // durable intent 必须先于目标 rename。
      await assert();
      await io.rename(temp, target); changed = true;
      await syncDirectory(dir);
      afterStarted = true; await afterCommit();
      await assert(); // 权限接受 fence；移除意图才开放读口，随后等目录耐久完成。
      await io.rm(marker); intent = false; accepted = true;
      await syncDirectory(dir);
      if (backup) { await io.rm(backup, { force: true }).catch(() => {}); await syncDirectory(dir); }
      return { had };
    } catch (error) {
      // 意图已移除后不能回滚已开放读口的内容；耐久失败拒 complete ACK。
      if (accepted) { lease?.failClose(error); throw error; }
      try {
        if (changed) { if (backup) await io.rename(backup, target); else await io.rm(target, { force: true }); }
        await syncDirectory(dir);
        if (afterStarted) await rollback();
        if (intent) { await io.rm(marker, { force: true }); intent = false; }
        if (backup) await io.rm(backup, { force: true });
        await syncDirectory(dir);
      } catch (cleanupError) { lease?.failClose(cleanupError); throw new AggregateError([error, cleanupError], 'project-publication-cleanup-failed'); }
      throw error;
    } finally { await io.rm(temp, { force: true }); }
  };
  const previous = locks.get(target) ?? Promise.resolve();
  const execute = () => previous.catch(() => {}).then(work);
  const result = lease ? lease.run(execute) : execute();
  locks.set(target, result);
  void result.finally(() => { if (locks.get(target) === result) locks.delete(target); }).catch(() => {});
  return result;
}

export function readProjectFile(file, lease, io = fs) {
  if (!lease) return io.readFile(file);
  return lease.run(async () => {
    let handle;
    try {
      if (!await projectFileAccepted(file)) throw new Error('project-publication-pending');
      await lease.assert();
      handle = await io.open(file, 'r');
      lease.trackHandle(handle);
      const bytes = await handle.readFile({ signal: lease.signal });
      await lease.assert();
      return bytes;
    } finally { await handle?.close(); }
  });
}
