/**
 * 帧库与导出目录里的遗留文件（`docs/plan/storage-plan.md` 的 A 部分）。
 *
 * 两件事：
 *
 * 1. **启动清理**（`sweepFrameLibrary`、`sweepExportRoot`）：进程被强杀（桌面壳关窗、taskkill /F、崩溃）时
 *    来不及删自己的临时文件。下一次启动时按名字认出来、判定属主进程已不在，再删。只删下面列的几种形态，
 *    别的一律不碰：
 *    - `<键>/mov/full-<pid>.tmp.mov`、`controls/<键>/mov/full-<pid>.tmp.mov`：写到一半的整场景 / 独立卡 MOV；
 *    - `<键>/mov/playback-<pid>-<uuid>.mov`：旧式播放会话的稀疏 MOV；
 *      旧版本留下的 `playback-<uuid>.mov`（名字里没有 pid）按修改时刻判：超过 `legacyAgeMs` 没动就删；
 *    - `<键>/html-cache/live-<pid>-*`：快照归档的溢出目录；
 *    - `tracks/<键>/preview-<pid>.tmp.mp4`、`<键>/preview-<pid>.tmp.mp4`：写到一半的轨道前缀预览；
 *    - 导出目录下的 `export-vision-<pid>-*`：视觉工具的临时导出。
 *    `<键>` 只认 64 位十六进制（帧库的内容哈希）。遇到符号链接或 junction 跳过；删不掉（被别的进程占着）
 *    跳过并记一笔，下次启动再试。
 *
 * 2. **导出目录的中间文件**（`pruneExportDir`）：导出成功后只留成片、透明层与 `project.json`；
 *    取消或失败时也删中间文件，已有的成片 / 透明层照留（列表显示用）。
 *
 * 3. **导出目录命名**（`claimExportDir`）：同一秒两次导出不复用同一个目录。
 *
 * 帧库的启动清理由 `FramePipeline` 在本进程第一次建帧服务时发起（`frame-pipeline.mjs`），
 * 导出目录的由 `vite-plugin-export.ts` 在 dev server 起来时发起。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const KEY = /^[0-9a-f]{64}$/;
const FULL_TMP = /^full-(\d+)\.tmp\.mov$/;
const PLAYBACK = /^playback-(\d+)-[0-9a-f-]{36}\.mov$/;
const PLAYBACK_LEGACY = /^playback-[0-9a-f-]{36}\.mov$/;
const LIVE_SPILL = /^live-(\d+)-/;
const PREVIEW_TMP = /^preview-(\d+)\.tmp\.mp4$/;
const VISION = /^export-vision-(\d+)-/;

/** 旧版 `playback-<uuid>.mov` 多久没动算遗留 */
export const LEGACY_PLAYBACK_AGE_MS = 60 * 60 * 1000;

/*
 * 导出目录的规则只在这里定义一份：导出完成后的收拾（`pruneExportDir`，`vite-plugin-export.ts`）、
 * 导出列表与「只删中间文件」（`exports-list.mjs`）、`/api/storage` 的导出一栏（`frame-library-storage.mjs` 经
 * `exports-list.mjs` 的 `summarizeExports`）都引这几个。
 */

/**
 * 一次导出的目录名：`export-YYYYMMDD-HHMMSS`（本地时间），同一秒重名时带 `-<n>`（`claimExportDir` 从 `-2` 起，
 * 最多到 `-999`；这里放宽到 1～4 位）。视觉工具的 `export-vision-*` 不匹配。
 */
export const EXPORT_ID_RE = /^export-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:-(\d{1,4}))?$/;
/** 名字像不像一次导出的目录（只看名字；是不是真目录、在不在导出目录下由调用方判） */
export const isExportDirName = name => typeof name === 'string' && EXPORT_ID_RE.test(name);
/** 交付物：成片、只含卡片的透明层（列表按这个顺序列） */
export const EXPORT_DELIVERABLES = Object.freeze(['preview.mp4', 'overlay.mov']);
/** 导出成功后留下的（交付物加 `project.json`，列表显示所属项目用）；其余都是中间文件 */
export const EXPORT_KEEP = Object.freeze([...EXPORT_DELIVERABLES, 'project.json']);
/** 导出目录顶层的这个名字是不是要留下的 */
export const isExportKeepName = name => EXPORT_KEEP.includes(name);

/*
 * 帧库遗留文件的名字规则（启动清理 `sweepFrameLibrary` 删的、`frame-library-storage.mjs` 的 `measureDir` 计进
 * `leftovers.bytes` 的，是同一套）。
 */

/**
 * 一个帧库里的文件按名字算不算遗留：写到一半的 MOV / 预览、属主进程已不在的播放 MOV、旧版超龄的播放 MOV。
 * `dead(pid)` 判进程已不在；`ageMs` 是文件多久没动（只有旧版播放 MOV 要看）。回遗留的种类，不是回 null。
 */
export function leftoverFileKind(name, { dead, ageMs = 0, legacyAgeMs = LEGACY_PLAYBACK_AGE_MS }) {
  let m;
  if ((m = FULL_TMP.exec(name)) && dead(Number(m[1]))) return 'full-tmp';
  if ((m = PREVIEW_TMP.exec(name)) && dead(Number(m[1]))) return 'preview-tmp';
  if ((m = PLAYBACK.exec(name)) && dead(Number(m[1]))) return 'playback';
  if (PLAYBACK_LEGACY.test(name) && ageMs > legacyAgeMs) return 'playback';
  return null;
}

/** `html-cache` 下的这个子目录是不是死进程留下的溢出目录 */
export function isDeadSpillDir(name, dead) {
  const m = LIVE_SPILL.exec(name);
  return !!m && dead(Number(m[1]));
}

/**
 * 进程还在吗。`process.kill(pid, 0)` 在 Windows 与 Linux 上都只做存在性检查：
 * ESRCH = 不在；EPERM = 在（只是没权限发信号）；别的错误拿不准，按「在」处理，宁可不删。
 * 自己的 pid 一律算在。
 */
export function pidAlive(pid) {
  pid = Number(pid);
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code !== 'ESRCH'; }
}

async function entries(dir) {
  try { return await fs.readdir(dir, { withFileTypes: true }); }
  catch { return []; }
}

/** 目录树的字节数，以及里面有没有链接（符号链接、junction）。有链接就整个跳过，不顺着链接删到别处去。 */
async function inspect(target) {
  const stat = await fs.lstat(target);
  if (stat.isSymbolicLink()) return { linked: true, bytes: 0 };
  if (!stat.isDirectory()) return { linked: false, bytes: stat.size };
  let bytes = 0;
  for (const item of await fs.readdir(target)) {
    const inner = await inspect(path.join(target, item));
    if (inner.linked) return { linked: true, bytes: 0 };
    bytes += inner.bytes;
  }
  return { linked: false, bytes };
}

/**
 * 删一个认出来的遗留（文件或目录）。结果记进 `report`：`removed` / `skipped`（带原因）。
 * 删前先确认里面没有链接；Windows 上文件被占用时 `fs.rm` 重试几次，还不行就跳过。
 */
export async function removeLeftover(target, report, { kind = 'leftover', log = null } = {}) {
  let bytes = 0;
  try {
    const found = await inspect(target);
    if (found.linked) {
      report.skipped.push({ path: target, kind, reason: 'link' });
      log?.(`[storage] 跳过（链接）：${target}`);
      return false;
    }
    bytes = found.bytes;
    await fs.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    report.removed.push({ path: target, kind, bytes });
    report.bytes += bytes;
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    report.skipped.push({ path: target, kind, reason: error?.code || String(error?.message || error) });
    log?.(`[storage] 删不掉，跳过：${target}（${error?.code || error?.message || error}）`);
    return false;
  }
}

const newReport = () => ({ removed: [], skipped: [], bytes: 0 });

/**
 * 启动清理帧库。`root` 是帧库根（`<导出目录>/frame-library`）。回 `{ removed, skipped, bytes }`。
 * `alive`、`now` 给测试用。
 */
export async function sweepFrameLibrary(root, { alive = pidAlive, now = Date.now(), legacyAgeMs = LEGACY_PLAYBACK_AGE_MS, log = null } = {}) {
  const report = newReport();
  if (typeof root !== 'string' || !root) return report;
  const dead = pid => !alive(Number(pid));
  const sweepMov = async (movDir, { playback }) => {
    for (const item of await entries(movDir)) {
      if (!item.isFile()) continue;
      const full = path.join(movDir, item.name);
      if (FULL_TMP.test(item.name)) {
        if (leftoverFileKind(item.name, { dead })) await removeLeftover(full, report, { kind: 'full-tmp', log });
      } else if (playback && (PLAYBACK.test(item.name) || PLAYBACK_LEGACY.test(item.name))) {
        // 旧版不带 pid 的要看多久没动;带 pid 的只看进程
        let ageMs = 0;
        if (PLAYBACK_LEGACY.test(item.name)) {
          const stat = await fs.lstat(full).catch(() => null);
          if (!stat) continue;
          ageMs = now - stat.mtimeMs;
        }
        if (leftoverFileKind(item.name, { dead, ageMs, legacyAgeMs })) await removeLeftover(full, report, { kind: 'playback', log });
      }
    }
  };
  const sweepPreview = async (dir) => {
    for (const item of await entries(dir)) {
      if (item.isFile() && PREVIEW_TMP.test(item.name) && leftoverFileKind(item.name, { dead })) {
        await removeLeftover(path.join(dir, item.name), report, { kind: 'preview-tmp', log });
      }
    }
  };
  for (const item of await entries(root)) {
    if (!item.isDirectory() || !KEY.test(item.name)) continue;   // 链接的 Dirent 不是目录，自然跳过
    const dir = path.join(root, item.name);
    await sweepMov(path.join(dir, 'mov'), { playback: true });
    await sweepPreview(dir);
    const cache = path.join(dir, 'html-cache');
    for (const spill of await entries(cache)) {
      if (!isDeadSpillDir(spill.name, dead)) continue;
      if (!spill.isDirectory()) { if (spill.isSymbolicLink()) report.skipped.push({ path: path.join(cache, spill.name), kind: 'html-cache', reason: 'link' }); continue; }
      await removeLeftover(path.join(cache, spill.name), report, { kind: 'html-cache', log });
    }
  }
  for (const item of await entries(path.join(root, 'controls'))) {
    if (item.isDirectory() && KEY.test(item.name)) await sweepMov(path.join(root, 'controls', item.name, 'mov'), { playback: false });
  }
  for (const item of await entries(path.join(root, 'tracks'))) {
    if (item.isDirectory() && KEY.test(item.name)) await sweepPreview(path.join(root, 'tracks', item.name));
  }
  if (report.removed.length || report.skipped.length) {
    log?.(`[storage] 帧库遗留：删 ${report.removed.length} 个（${(report.bytes / 1048576).toFixed(1)} MB），跳过 ${report.skipped.length} 个`);
  }
  return report;
}

/** 启动清理导出目录：只认死进程留下的 `export-vision-<pid>-*`。 */
export async function sweepExportRoot(outRoot, { alive = pidAlive, log = null } = {}) {
  const report = newReport();
  if (typeof outRoot !== 'string' || !outRoot) return report;
  for (const item of await entries(outRoot)) {
    const m = VISION.exec(item.name);
    if (!m || alive(Number(m[1]))) continue;
    if (!item.isDirectory()) { if (item.isSymbolicLink()) report.skipped.push({ path: path.join(outRoot, item.name), kind: 'export-vision', reason: 'link' }); continue; }
    await removeLeftover(path.join(outRoot, item.name), report, { kind: 'export-vision', log });
  }
  if (report.removed.length || report.skipped.length) {
    log?.(`[storage] 视觉临时导出遗留：删 ${report.removed.length} 个，跳过 ${report.skipped.length} 个`);
  }
  return report;
}

/**
 * 删一次导出的中间文件：`dir` 下除 `EXPORT_KEEP` 以外的顶层条目全删（`frames`、`parts`、`glass`、`audio`、
 * `media`、`dom`、滤镜脚本、`preview-audio.mp4`、`trace.json`……）。链接跳过。
 * 回 `{ removed, skipped, bytes }`。
 */
export async function pruneExportDir(dir, { keep = EXPORT_KEEP, log = null } = {}) {
  const report = newReport();
  const kept = new Set(keep);
  for (const item of await entries(dir)) {
    if (kept.has(item.name)) continue;
    const full = path.join(dir, item.name);
    if (item.isSymbolicLink()) { report.skipped.push({ path: full, kind: 'export', reason: 'link' }); continue; }
    await removeLeftover(full, report, { kind: 'export', log });
  }
  return report;
}

/**
 * 一次导出的目录 `export-<YYYYMMDD-HHMMSS>`（本地时间）。同一秒已有同名目录（连点两次、两个窗口同时导）
 * 就加 `-2`、`-3`…… 后缀，不复用：复用会让两次导出往同一处写，后一次的清理还会删掉前一次的产物。
 * 用不带 recursive 的 mkdir 占位，两个请求同时来也只有一个拿得到同一个名字。回 `{ id, outDir }`。
 */
export async function claimExportDir(base, now = new Date()) {
  const two = n => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
  await fs.mkdir(base, { recursive: true });
  for (let n = 1; n < 1000; n++) {
    const id = n === 1 ? stamp : `${stamp}-${n}`;
    const outDir = path.resolve(base, `export-${id}`);
    try {
      await fs.mkdir(outDir);
      return { id, outDir };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  throw new Error('同一秒内的导出目录太多');
}
