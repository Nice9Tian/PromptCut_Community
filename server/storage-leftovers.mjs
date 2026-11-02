/**
 * Leftover files in the frame store and export directory (part A of `docs/plan/storage-plan.md`).
 *
 * Two things:
 *
 * 1. **Startup cleanup** (`sweepFrameLibrary`, `sweepExportRoot`): when a process is forcibly killed
 *    (desktop shell closing window, taskkill /F, crash), it has no time to delete its temporary
 *    files. On the next startup, identify them by name, verify that the owner process is no longer
 *    running, and delete them. Only delete the forms listed below, leaving everything else untouched:
 *    - `<key>/mov/full-<pid>.tmp.mov`, `controls/<key>/mov/full-<pid>.tmp.mov`: half-written whole
 *      scene / standalone card MOVs;
 *    - `<key>/mov/playback-<pid>-<uuid>.mov`: sparse MOVs from legacy playback sessions;
 *      `playback-<uuid>.mov` left by older versions (without pid in the name) is checked by
 *      modification time: deleted if untouched for more than `legacyAgeMs`;
 *    - `<key>/html-cache/live-<pid>-*`: overflow directories for snapshot archives;
 *    - `tracks/<key>/preview-<pid>.tmp.mp4`, `<key>/preview-<pid>.tmp.mp4`: half-written track
 *      prefix previews;
 *    - `export-vision-<pid>-*` under the export directory: temporary exports from vision tools.
 *    `<key>` only matches 64-digit hex (content hash in frame store). Skip symlinks or junctions;
 *    if deletion fails (occupied by another process), skip and record an entry, retrying on the
 *    next startup.
 *
 * 2. **Intermediate files in export directory** (`pruneExportDir`): after export succeeds, retain
 *    only final video, transparent layer, and `project.json`; intermediate files are also deleted
 *    on cancellation or failure, keeping existing final videos / transparent layers (for list
 *    display).
 *
 * 3. **Export directory naming** (`claimExportDir`): two exports within the same second do not
 *    reuse the same directory.
 *
 * Startup cleanup of the frame store is initiated by `FramePipeline` when creating the frame
 * service for the first time in this process (`frame-pipeline.mjs`); cleanup of the export directory
 * is initiated by `vite-plugin-export.ts` when the dev server starts up.
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

/** How long legacy `playback-<uuid>.mov` must remain untouched to be considered leftover */
export const LEGACY_PLAYBACK_AGE_MS = 60 * 60 * 1000;

/*
 * Export directory rules are defined only once here: cleanup after export completes
 * (`pruneExportDir`, `vite-plugin-export.ts`), the export list and "delete intermediate files only"
 * (`exports-list.mjs`), and the export section of `/api/storage` (`frame-library-storage.mjs` via
 * `summarizeExports` of `exports-list.mjs`) all reference these.
 */

/**
 * Directory name for a single export: `export-YYYYMMDD-HHMMSS` (local time), with `-<n>` on collision
 * in the same second (`claimExportDir` starts from `-2`, up to `-999`; relaxed here to 1-4 digits).
 * `export-vision-*` from vision tools does not match.
 */
export const EXPORT_ID_RE = /^export-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:-(\d{1,4}))?$/;
/**
 * Whether the name looks like an export directory (name check only; callers determine whether
 * it is a real directory and under the export directory)
 */
export const isExportDirName = name => typeof name === 'string' && EXPORT_ID_RE.test(name);
/** Deliverables: final video, transparent layer containing only cards (lists are ordered by this sequence) */
export const EXPORT_DELIVERABLES = Object.freeze(['preview.mp4', 'overlay.mov']);
/**
 * Retained after successful export (deliverables plus `project.json`, used for displaying owning
 * project in lists); the rest are intermediate files
 */
export const EXPORT_KEEP = Object.freeze([...EXPORT_DELIVERABLES, 'project.json']);
/** Whether this name at the top level of the export directory should be retained */
export const isExportKeepName = name => EXPORT_KEEP.includes(name);

/*
 * Name rules for leftover files in the frame store (what startup cleanup `sweepFrameLibrary`
 * deletes and what `measureDir` in `frame-library-storage.mjs` counts into `leftovers.bytes` share
 * the same set).
 */

/**
 * Whether a file in the frame store counts as leftover by name: half-written MOV / preview,
 * playback MOV whose owner process is no longer running, or overage playback MOV from older
 * versions. `dead(pid)` determines whether the process is no longer running; `ageMs` is how long
 * the file has been untouched (only checked for older playback MOVs). Returns the kind of leftover,
 * or null if not.
 */
export function leftoverFileKind(name, { dead, ageMs = 0, legacyAgeMs = LEGACY_PLAYBACK_AGE_MS }) {
  let m;
  if ((m = FULL_TMP.exec(name)) && dead(Number(m[1]))) return 'full-tmp';
  if ((m = PREVIEW_TMP.exec(name)) && dead(Number(m[1]))) return 'preview-tmp';
  if ((m = PLAYBACK.exec(name)) && dead(Number(m[1]))) return 'playback';
  if (PLAYBACK_LEGACY.test(name) && ageMs > legacyAgeMs) return 'playback';
  return null;
}

/** Whether this subdirectory under `html-cache` is an overflow directory left by a dead process */
export function isDeadSpillDir(name, dead) {
  const m = LIVE_SPILL.exec(name);
  return !!m && dead(Number(m[1]));
}

/**
 * Whether the process is still running. `process.kill(pid, 0)` only performs an existence check on
 * both Windows and Linux:
 * ESRCH = not running; EPERM = running (just no permission to send signals); other errors are
 * uncertain, so treat as "running", preferring not to delete.
 * Own pid always counts as running.
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

/**
 * Byte count of the directory tree, and whether it contains links (symbolic links, junctions).
 * If there are links, skip the whole thing to avoid following links and deleting elsewhere.
 */
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
 * Delete an identified leftover (file or directory). Record the result in `report`:
 * `removed` / `skipped` (with reason).
 * Before deleting, confirm that it contains no links; when a file is locked on Windows,
 * retry `fs.rm` a few times, and skip if it still fails.
 */
export async function removeLeftover(target, report, { kind = 'leftover', log = null } = {}) {
  let bytes = 0;
  try {
    const found = await inspect(target);
    if (found.linked) {
      report.skipped.push({ path: target, kind, reason: 'link' });
      log?.(`[storage] Skipped (link): ${target}`);
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
    log?.(`[storage] Cannot delete, skipped: ${target} (${error?.code || error?.message || error})`);
    return false;
  }
}

const newReport = () => ({ removed: [], skipped: [], bytes: 0 });

/**
 * Startup cleanup of the frame store. `root` is the frame store root
 * (`<export directory>/frame-library`). Returns `{ removed, skipped, bytes }`.
 * `alive` and `now` are for testing.
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
        // Legacy versions without pid check inactivity duration; those with pid only check the process
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
    if (!item.isDirectory() || !KEY.test(item.name)) continue;   // A linked Dirent is not a directory, so naturally skipped
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
    log?.(`[storage] Frame store leftovers: deleted ${report.removed.length} (${(report.bytes / 1048576).toFixed(1)} MB), skipped ${report.skipped.length}`);
  }
  return report;
}

/** Startup cleanup of export directory: only recognizes `export-vision-<pid>-*` left by dead processes. */
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
    log?.(`[storage] Visual temporary export leftovers: deleted ${report.removed.length}, skipped ${report.skipped.length}`);
  }
  return report;
}

/**
 * Delete intermediate files of a single export: delete all top-level entries under `dir` except
 * `EXPORT_KEEP` (`frames`, `parts`, `glass`, `audio`, `media`, `dom`, filter scripts,
 * `preview-audio.mp4`, `trace.json`…). Skip links.
 * Returns `{ removed, skipped, bytes }`.
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
 * Directory for a single export `export-<YYYYMMDD-HHMMSS>` (local time). If a directory with the
 * same name already exists in the same second (clicked twice, two windows exporting simultaneously),
 * append suffixes like `-2`, `-3`… without reusing: reuse makes two exports write to the same place,
 * and cleanup of the latter would delete outputs of the former.
 * Use non-recursive mkdir as a placeholder, so if two requests arrive simultaneously, only one gets
 * the same name. Returns `{ id, outDir }`.
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
  throw new Error('Too many export directories within the same second');
}
