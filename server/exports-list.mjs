/**
 * Listing, deletion, and intermediate-file-only deletion of export deliverables (storage footprint
 * plan `docs/plan/storage-plan.md`, Section 4 `/api/exports*`; semantics: `workflow/project.md`
 * "Start" -> "Storage", `product/platforms.md` "Export deliverables", `mechanism/platforms.md`
 * "Frame store" -> "Export deliverables").
 *
 * Handles only the filesystem, not HTTP; routing is in `vite-plugin-exports-list.ts`. Unit tests:
 * `server/test/exports-list.test.mjs`.
 *
 * - Export directory = `PROMPTCUT_EXPORT_DIR || <viteRoot>/out` (same as `outRoot` in
 *   `vite-plugin-export.ts`).
 * - Recognizes only **real directories** directly under the export directory named
 *   `export-YYYYMMDD-HHMMSS` (with a `-<seq>` suffix when duplicate names occur within the same
 *   second); ignores `export-vision-*` (temporary exports from vision tools), symlinks, and junctions.
 * - An export retains the final video `preview.mp4`, transparent layer `overlay.mov` (listed as
 *   deliverables), and `project.json` (used to display the owning project); all others are treated as
 *   intermediate files (`frames`, `parts`, `glass`, `audio`, `media`, filter scripts...).
 * - Walking directories, calculating bytes, and deleting files all use lstat and **do not follow
 *   symlinks**: symbolic links or junctions in the directory are neither counted in size nor deleted
 *   (skipped), to avoid deleting outside the export directory by following junctions
 *   (`verification.md` "Operations causing real loss").
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import { EXPORT_ID_RE, EXPORT_DELIVERABLES, EXPORT_KEEP, isExportKeepName } from './storage-leftovers.mjs';
import { tr } from './i18n.mjs';

/*
 * Directory names, deliverables, and preserved names are defined once in `storage-leftovers.mjs`
 * (cleanup `pruneExportDir` after export completion also uses them), referenced directly here.
 * Export directory name: export-20260929-091817, or export-20260929-091817-2 when duplicate names
 * occur within the same second.
 */
export { EXPORT_ID_RE };
/** Deliverables in the list, listed in this order */
export const DELIVERABLE_NAMES = EXPORT_DELIVERABLES;
/** Preserved when deleting intermediate files only */
export const KEEP_NAMES = EXPORT_KEEP;
/** Upper limit for reading project.json to get project name; skips reading if larger (project name omitted, does not affect anything else) */
const PROJECT_JSON_MAX = 64 * 1024 * 1024;
/** When exports are running, incomplete exports written to within this recent duration are treated as "in progress" and cannot be deleted */
export const ACTIVE_WINDOW_MS = 10 * 60 * 1000;

export function exportsRoot(viteRoot) {
  return process.env.PROMPTCUT_EXPORT_DIR || path.resolve(viteRoot, 'out');
}

/** Directory name → export timestamp (local time, consistent with naming in `vite-plugin-export.ts`); returns null if unrecognized */
export function parseExportId(id) {
  const m = typeof id === 'string' ? EXPORT_ID_RE.exec(id) : null;
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
  const date = new Date(y, mo - 1, d, h, mi, s);
  if (Number.isNaN(date.getTime()) || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return { at: date, seq: m[7] ? Number(m[7]) : 0 };
}

const isLink = (st) => st.isSymbolicLink();

/**
 * Byte count and latest modification timestamp of a directory tree, without following symlinks.
 * Entries where lstat cannot be obtained (just deleted, no permission) are treated as 0.
 * Concurrently lstats entries in each directory in batches, so directories with tens of thousands
 * of frame-by-frame PNGs do not have to wait one by one.
 */
export async function treeStats(p) {
  let st;
  try { st = await fs.lstat(p); } catch { return { bytes: 0, mtimeMs: 0, links: 0 }; }
  if (isLink(st)) return { bytes: 0, mtimeMs: 0, links: 1 };
  if (!st.isDirectory()) return { bytes: st.size, mtimeMs: st.mtimeMs, links: 0 };
  let names;
  try { names = await fs.readdir(p); } catch { return { bytes: 0, mtimeMs: st.mtimeMs, links: 0 }; }
  const acc = { bytes: 0, mtimeMs: st.mtimeMs, links: 0 };
  for (let i = 0; i < names.length; i += 256) {
    const part = await Promise.all(names.slice(i, i + 256).map((n) => treeStats(path.join(p, n))));
    for (const s of part) {
      acc.bytes += s.bytes;
      acc.links += s.links;
      if (s.mtimeMs > acc.mtimeMs) acc.mtimeMs = s.mtimeMs;
    }
  }
  return acc;
}

async function readProjectMeta(dir) {
  const file = path.join(dir, 'project.json');
  try {
    const st = await fs.lstat(file);
    if (!st.isFile() || st.size > PROJECT_JSON_MAX) return { projectName: null, projectId: null };
    const doc = JSON.parse(await fs.readFile(file, 'utf8'));
    return {
      projectName: typeof doc?.name === 'string' ? doc.name : null,
      projectId: typeof doc?.id === 'string' ? doc.id : null,
    };
  } catch {
    return { projectName: null, projectId: null };
  }
}

/** Details of an export directory. `dir` has already been validated as a real directory under the export directory */
export async function describeExport(dir, id, opts = {}) {
  const parsed = parseExportId(id);
  let names = [];
  try { names = await fs.readdir(dir); } catch { /* Treat as empty if unreadable */ }
  const deliverables = [];
  let bytes = 0;
  let keepBytes = 0;
  let mtimeMs = 0;
  for (const name of names) {
    const s = await treeStats(path.join(dir, name));
    bytes += s.bytes;
    if (s.mtimeMs > mtimeMs) mtimeMs = s.mtimeMs;
    if (!isExportKeepName(name)) continue;
    let st = null;
    try { st = await fs.lstat(path.join(dir, name)); } catch { /* Just gone */ }
    if (!st || !st.isFile()) continue;
    keepBytes += st.size;
    if (DELIVERABLE_NAMES.includes(name)) deliverables.push({ name, bytes: st.size });
  }
  deliverables.sort((a, b) => DELIVERABLE_NAMES.indexOf(a.name) - DELIVERABLE_NAMES.indexOf(b.name));
  const finished = deliverables.some((d) => d.name === 'preview.mp4');
  const now = opts.now ?? Date.now();
  const running = !finished && !!opts.exportsRunning && now - mtimeMs < ACTIVE_WINDOW_MS;
  return {
    id,
    ...(await readProjectMeta(dir)),
    at: parsed ? parsed.at.toISOString() : null,
    finished,
    running,
    bytes,
    deliverables,
    intermediateBytes: Math.max(0, bytes - keepBytes),
  };
}

/**
 * Lists past exports under the export directory, newest first.
 * `opts.exportsRunning`: whether exports are running in this process (`exportsRunning() > 0` in
 * `render-pool-state.mjs`).
 */
export async function listExports(root, opts = {}) {
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { return []; }
  const items = [];
  for (const e of entries) {
    if (!parseExportId(e.name)) continue;
    const abs = path.join(root, e.name);
    let st;
    try { st = await fs.lstat(abs); } catch { continue; }
    if (isLink(st) || !st.isDirectory()) continue;
    items.push(await describeExport(abs, e.name, opts));
  }
  const key = (it) => {
    const p = parseExportId(it.id);
    return p.at.getTime() * 10000 + p.seq;
  };
  items.sort((a, b) => key(b) - key(a));
  return items;
}

/** Used by the `exports` section of `/api/storage` (can be directly imported if storage-cap needs it) */
export async function summarizeExports(root, opts = {}) {
  const items = await listExports(root, opts);
  return {
    bytes: items.reduce((s, it) => s + it.bytes, 0),
    count: items.length,
    intermediateBytes: items.reduce((s, it) => s + it.intermediateBytes, 0),
  };
}

const sameFsPath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

/**
 * Resolves the id in the request into a real directory under the export directory. Unrecognized
 * names, `..`, slashes, symlinks, junctions, or paths actually resolving to another directory are
 * all rejected. Returns `{ ok: true, abs }` or `{ ok: false, status, error }`.
 */
export async function resolveExportDir(root, id) {
  if (typeof id !== 'string' || !parseExportId(id)) return { ok: false, status: 400, error: tr("Not an export directory name") };
  const base = path.resolve(root);
  const abs = path.join(base, id);
  if (!sameFsPath(path.dirname(abs), base)) return { ok: false, status: 400, error: tr("Not an export directory name") };
  let st;
  try { st = await fs.lstat(abs); } catch { return { ok: false, status: 404, error: tr("This export no longer exists") }; }
  if (isLink(st)) return { ok: false, status: 400, error: tr("This is a link, not an export directory") };
  if (!st.isDirectory()) return { ok: false, status: 400, error: tr("Not a directory") };
  try {
    const [realAbs, realBase] = await Promise.all([fs.realpath(abs), fs.realpath(base)]);
    if (!sameFsPath(path.dirname(realAbs), realBase)) return { ok: false, status: 400, error: tr("Not under the export directory") };
  } catch {
    return { ok: false, status: 404, error: tr("This export no longer exists") };
  }
  return { ok: true, abs };
}

/**
 * Deletes a tree without following symlinks: symlinks are recorded in skipped and left untouched;
 * undeletable files (opened by other processes, EBUSY/EPERM on Windows) are recorded in busy.
 * Returns whether this tree was completely removed.
 */
async function removeTree(p, report, rel) {
  let st;
  try { st = await fs.lstat(p); } catch (e) { return e?.code === 'ENOENT'; }
  if (isLink(st)) { report.skipped.push(rel); return false; }
  if (st.isDirectory()) {
    let names = [];
    try { names = await fs.readdir(p); } catch (e) { report.busy.push({ rel, code: e?.code }); return false; }
    let all = true;
    for (const n of names) {
      if (!(await removeTree(path.join(p, n), report, `${rel}/${n}`))) all = false;
    }
    if (!all) return false;
    try { await fs.rmdir(p); return true; } catch (e) {
      if (e?.code === 'ENOENT') return true;
      report.busy.push({ rel, code: e?.code });
      return false;
    }
  }
  try {
    await fs.unlink(p);
    report.freedBytes += st.size;
    return true;
  } catch (e) {
    if (e?.code === 'ENOENT') return true;
    report.busy.push({ rel, code: e?.code });
    return false;
  }
}

function failureMessage(report, what) {
  const parts = [];
  if (report.busy.length) {
    parts.push(tr("{0} items are in use by another program and were not {1} (for example {2}). Close the program using them and try again.", report.busy.length, what, report.busy[0].rel));
  }
  if (report.skipped.length) {
    parts.push(tr("{0} links were left untouched (for example {1}). Please handle them yourself in the file manager.", report.skipped.length, report.skipped[0]));
  }
  return parts.join('');
}

async function guardActive(abs, id, opts) {
  if (!opts.exportsRunning) return null;
  const d = await describeExport(abs, id, opts);
  return d.running ? { ok: false, status: 409, error: tr("This export is still in progress. Wait for it to finish or cancel it, then delete.") } : null;
}

/** Deletes an entire export */
export async function deleteExport(root, id, opts = {}) {
  const r = await resolveExportDir(root, id);
  if (!r.ok) return r;
  const active = await guardActive(r.abs, id, opts);
  if (active) return active;
  const report = { freedBytes: 0, busy: [], skipped: [] };
  const gone = await removeTree(r.abs, report, id);
  if (gone) return { ok: true, freedBytes: report.freedBytes };
  return { ok: false, status: 409, error: failureMessage(report, tr("deleted")), freedBytes: report.freedBytes, busy: report.busy.length, skipped: report.skipped.length };
}

/** Deletes intermediate files only: retains the final video, transparent layer, and project.json */
export async function pruneExport(root, id, opts = {}) {
  const r = await resolveExportDir(root, id);
  if (!r.ok) return r;
  const active = await guardActive(r.abs, id, opts);
  if (active) return active;
  const report = { freedBytes: 0, busy: [], skipped: [] };
  let names = [];
  try { names = await fs.readdir(r.abs); } catch { /* Empty */ }
  for (const n of names) {
    if (isExportKeepName(n)) {
      // Preserved names only keep real files; symlinks with the same name are still skipped and not deleted
      continue;
    }
    await removeTree(path.join(r.abs, n), report, n);
  }
  if (!report.busy.length && !report.skipped.length) return { ok: true, freedBytes: report.freedBytes };
  return { ok: false, status: 409, error: failureMessage(report, tr("deleted")), freedBytes: report.freedBytes, busy: report.busy.length, skipped: report.skipped.length };
}
