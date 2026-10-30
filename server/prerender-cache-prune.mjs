/**
 * 帧库旧缓存的判定与删除（`scripts/prune-prerender-cache.mjs` 的实现，放在 server/ 下是因为依赖方向只能
 * scripts/ → server/，测试也要引它）。为什么会有旧缓存、怎么判旧、管哪些目录，见那个脚本的文件头。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

/** M4（环境指纹进结果键）合并进 main 的时刻：main 的 178ca34 */
export const M4_KEYS_SINCE = Date.parse('2026-09-24T21:15:16+09:00');

const KEY = /^[0-9a-f]{64}$/;
const FAMILIES = ['controls-html', 'controls', 'streams', 'tracks'];

/** 目录（含自身）里最新的 mtime 与总字节数。碰到链接不进去，记 `linked`。 */
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
 * 找出旧目录。回 `{ stale: [{ family, dir, bytes, newest }], kept, skipped }`。只读，不删。
 * `family` 是上面那张表里的名字，整场景缓存记 `entry`。
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

/** 删掉 `findStale` 找出的目录；`controls-local/<entry.key>/` 删空了一并删。回删了几个。 */
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

/** 看起来像帧库吗：至少有一个认得的子目录。防止 `--root` 指错把别处当帧库删。 */
export async function looksLikeFrameLibrary(root) {
  const names = new Set(await listDirs(root));
  return ['controls-html', 'controls-local', 'controls', 'streams', 'tracks'].some(name => names.has(name));
}
