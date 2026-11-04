/** Project file read/write choke point: async open/publish/rollback all belong to lease, does not replace actual I/O completion with HTTP finish. */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const locks = new Map();
// Node directory handles on Windows do not provide the fsync needed here; do not masquerade file sync as directory durability.
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

/** Restart only reclaims intents with incomplete publishing in this project; paths are strictly limited to this directory, cannot touch other projects based on file contents. */
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
      syncDirectorySync(dir); // Durably restore target before allowing intent to disappear.
      fsSync.rmSync(record.temp, { force: true }); fsSync.rmSync(file); syncDirectorySync(dir);
    }
  };
  walk(base);
}

/** Serialized transactions on the same target: files failing commit re-verification carry durable intent and are unreadable; closes lease resources only after rollback finishes. */
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
      // Funnel together with newly created project/shard directory names; cannot only sync file names in deepest directories.
      for (let ancestor = dir; ; ancestor = path.dirname(ancestor)) { await syncDirectory(ancestor); if (path.dirname(ancestor) === ancestor) break; }
      const handle = await io.open(marker, 'wx');
      intent = true; // Reclaim created intent even if write/sync fails.
      try { await handle.writeFile(JSON.stringify({ v: 1, target, temp, backup })); await handle.sync(); } finally { await handle.close(); }
      await syncDirectory(dir); // durable intent must precede target rename.
      await assert();
      await io.rename(temp, target); changed = true;
      await syncDirectory(dir);
      afterStarted = true; await afterCommit();
      await assert(); // Authority accepts fence; open for reading only after removing intent, then wait for directory durability completion.
      await io.rm(marker); intent = false; accepted = true;
      await syncDirectory(dir);
      if (backup) { await io.rm(backup, { force: true }).catch(() => {}); await syncDirectory(dir); }
      return { had };
    } catch (error) {
      // Cannot roll back content opened for reading once intent is removed; reject complete ACK if durability fails.
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
