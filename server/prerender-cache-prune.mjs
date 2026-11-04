/**
 * Stale cache detection and deletion for frame store (implementation of `scripts/prune-prerender-cache.mjs`,
 * placed under server/ because dependency direction can only be scripts/ → server/, and tests also need to
 * import it). See that script's file header for why stale caches exist, how staleness is determined,
 * and which directories are managed.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

/** Timestamp when M4 (environment fingerprint into result key) merged into main: main commit 178ca34 */
export const M4_KEYS_SINCE = Date.parse('2026-09-24T21:15:16+09:00');

const KEY = /^[0-9a-f]{64}$/;
const FAMILIES = ['controls-html', 'controls', 'streams', 'tracks'];

/** Latest mtime and total bytes in directory (including itself). Skips symlinks, recording `linked`. */
async function measure(dir) {
  let newest = 0, bytes = 0, linked = false;
  const walk = async (current) => {
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) { linked = true; return; }
    newest = Math.max(newest, stat.mtimeMs);
    if (!stat.isDirectory()) { bytes += stat.size; return; }
    for (const item of await fs.readdir(current)) await walk(path.join(current, item));
  };
  await walk(dir);
  return { newest, bytes, linked };
}

async function listDirs(dir) {
  try {
    return (await fs.readdir(dir, { withFileTypes: true })).filter(item => item.isDirectory()).map(item => item.name);
  } catch { return []; }
}

/**
 * Finds stale directories. Returns `{ stale: [{ family, dir, bytes, newest }], kept, skipped }`.
 * Read-only, does not delete. `family` is the name in the table above; whole scene caches are
 * recorded as `entry`.
 */
export async function findStale(root, before = M4_KEYS_SINCE) {
  const candidates = [];
  for (const family of FAMILIES) {
    for (const name of await listDirs(path.join(root, family))) {
      if (KEY.test(name)) candidates.push({ family, dir: path.join(root, family, name) });
    }
  }
  for (const outer of await listDirs(path.join(root, 'controls-local'))) {
    if (!KEY.test(outer)) continue;
    for (const name of await listDirs(path.join(root, 'controls-local', outer))) {
      if (KEY.test(name)) candidates.push({ family: 'controls-local', dir: path.join(root, 'controls-local', outer, name) });
    }
  }
  for (const name of await listDirs(root)) {
    if (KEY.test(name)) candidates.push({ family: 'entry', dir: path.join(root, name) });
  }
  const stale = [], skipped = [];
  let kept = 0;
  for (const candidate of candidates) {
    const { newest, bytes, linked } = await measure(candidate.dir);
    if (linked) { skipped.push({ ...candidate, reason: 'link' }); continue; }
    if (newest < before) stale.push({ ...candidate, bytes, newest });
    else kept++;
  }
  return { stale, kept, skipped };
}

/** Deletes dirs found by `findStale`; deletes `controls-local/<entry.key>/` if emptied. Returns deleted count. */
export async function removeStale(root, stale) {
  let removed = 0;
  const outers = new Set();
  for (const item of stale) {
    await fs.rm(item.dir, { recursive: true, force: true });
    removed++;
    if (item.family === 'controls-local') outers.add(path.dirname(item.dir));
  }
  for (const outer of outers) {
    try { if (!(await fs.readdir(outer)).length) await fs.rmdir(outer); } catch {}
  }
  return removed;
}

/** Looks like frame store: has at least one recognized subdir. Prevents mispointed `--root` deleting elsewhere. */
export async function looksLikeFrameLibrary(root) {
  const names = new Set(await listDirs(root));
  return ['controls-html', 'controls-local', 'controls', 'streams', 'tracks'].some(name => names.has(name));
}
