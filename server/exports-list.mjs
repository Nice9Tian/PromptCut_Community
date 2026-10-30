/**
 * 导出产物的列表、删除、只删中间文件(存储占用计划 `docs/plan/storage-plan.md` 第 4 节的 `/api/exports*`;
 * 语义:`workflow/project.md`「开始」的「存储」、`product/platforms.md`「导出产物」、`mechanism/platforms.md`「帧库」的「导出产物」)。
 *
 * 只管文件系统,不管 HTTP;路由在 `vite-plugin-exports-list.ts`。单测:`server/test/exports-list.test.mjs`。
 *
 * - 导出目录 = `PROMPTCUT_EXPORT_DIR || <viteRoot>/out`(同 `vite-plugin-export.ts` 的 `outRoot`)。
 * - 只认导出目录**直接下面**、名字是 `export-YYYYMMDD-HHMMSS`(同秒重名时带 `-<序号>` 后缀)的**真目录**;
 *   `export-vision-*`(视觉工具的临时导出)、链接、junction 都不认。
 * - 一份导出里留下的是成片 `preview.mp4`、透明层 `overlay.mov`(列为 deliverables)和 `project.json`(显示所属项目用);
 *   其余一律算中间文件(`frames`、`parts`、`glass`、`audio`、`media`、滤镜脚本……)。
 * - 走目录、算字节、删文件都用 lstat,**不跟链接**:目录里的符号链接或 junction 既不算大小、也不删(跳过),
 *   免得顺着 junction 删到导出目录之外(`verification.md`「会造成真实损失的操作」)。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import { EXPORT_ID_RE, EXPORT_DELIVERABLES, EXPORT_KEEP, isExportKeepName } from './storage-leftovers.mjs';

/*
 * 目录名、交付物、留下的名字只在 `storage-leftovers.mjs` 定义一份(导出完成后的收拾 `pruneExportDir` 用的也是它们),
 * 这里照引。导出目录名:export-20260929-091817,同秒重名时 export-20260929-091817-2。
 */
export { EXPORT_ID_RE };
/** 列表里的交付物,按这个顺序列 */
export const DELIVERABLE_NAMES = EXPORT_DELIVERABLES;
/** 只删中间文件时留下的 */
export const KEEP_NAMES = EXPORT_KEEP;
/** 读 project.json 取项目名的上限;再大就不读(不显示项目名,不影响别的) */
const PROJECT_JSON_MAX = 64 * 1024 * 1024;
/** 有导出在跑时,最近这么久内还在写的未完成导出当作「进行中」,不让删 */
export const ACTIVE_WINDOW_MS = 10 * 60 * 1000;

export function exportsRoot(viteRoot) {
  return process.env.PROMPTCUT_EXPORT_DIR || path.resolve(viteRoot, 'out');
}

/** 目录名 → 导出时刻(本地时间,和 `vite-plugin-export.ts` 起名时一致);不认得回 null */
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
 * 一棵目录的字节数与最新修改时刻,不跟链接。拿不到 lstat 的(刚被删、没权限)当 0。
 * 每个目录的条目分批并发 lstat,几万张逐帧 PNG 的目录也不至于一张一张等。
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

/** 一份导出目录的明细。`dir` 已经校验过是导出目录下的真目录 */
export async function describeExport(dir, id, opts = {}) {
  const parsed = parseExportId(id);
  let names = [];
  try { names = await fs.readdir(dir); } catch { /* 读不了就当空的 */ }
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
    try { st = await fs.lstat(path.join(dir, name)); } catch { /* 刚没了 */ }
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
 * 列出导出目录下的历次导出,新的在前。
 * `opts.exportsRunning`:这个进程里有没有导出在跑(`render-pool-state.mjs` 的 `exportsRunning() > 0`)。
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

/** 给 `/api/storage` 的 `exports` 一栏用(storage-cap 那边要用可以直接引) */
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
 * 把请求里的 id 解析成导出目录下的真目录。不认得的名字、`..`、斜杠、链接、junction、
 * 实际落在别的目录的,一律拒。回 `{ ok: true, abs }` 或 `{ ok: false, status, error }`。
 */
export async function resolveExportDir(root, id) {
  if (typeof id !== 'string' || !parseExportId(id)) return { ok: false, status: 400, error: '不是导出目录的名字' };
  const base = path.resolve(root);
  const abs = path.join(base, id);
  if (!sameFsPath(path.dirname(abs), base)) return { ok: false, status: 400, error: '不是导出目录的名字' };
  let st;
  try { st = await fs.lstat(abs); } catch { return { ok: false, status: 404, error: '这份导出已经不在了' }; }
  if (isLink(st)) return { ok: false, status: 400, error: '这是一个链接，不是导出目录' };
  if (!st.isDirectory()) return { ok: false, status: 400, error: '不是目录' };
  try {
    const [realAbs, realBase] = await Promise.all([fs.realpath(abs), fs.realpath(base)]);
    if (!sameFsPath(path.dirname(realAbs), realBase)) return { ok: false, status: 400, error: '不在导出目录下' };
  } catch {
    return { ok: false, status: 404, error: '这份导出已经不在了' };
  }
  return { ok: true, abs };
}

/**
 * 删一棵树,不跟链接:链接记进 skipped 不动;删不掉的文件(被别的进程打开,Windows 上 EBUSY/EPERM)记进 busy。
 * 回这棵树是不是整个没了。
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
    parts.push(`有 ${report.busy.length} 项正被别的程序占用，没${what}（例如 ${report.busy[0].rel}）。关掉正在用它的程序后再试。`);
  }
  if (report.skipped.length) {
    parts.push(`有 ${report.skipped.length} 个链接没有动（例如 ${report.skipped[0]}），请在文件管理器里自己处理。`);
  }
  return parts.join('');
}

async function guardActive(abs, id, opts) {
  if (!opts.exportsRunning) return null;
  const d = await describeExport(abs, id, opts);
  return d.running ? { ok: false, status: 409, error: '这份导出还在进行，等它结束或取消后再删。' } : null;
}

/** 删整份导出 */
export async function deleteExport(root, id, opts = {}) {
  const r = await resolveExportDir(root, id);
  if (!r.ok) return r;
  const active = await guardActive(r.abs, id, opts);
  if (active) return active;
  const report = { freedBytes: 0, busy: [], skipped: [] };
  const gone = await removeTree(r.abs, report, id);
  if (gone) return { ok: true, freedBytes: report.freedBytes };
  return { ok: false, status: 409, error: failureMessage(report, '删掉'), freedBytes: report.freedBytes, busy: report.busy.length, skipped: report.skipped.length };
}

/** 只删中间文件:留下成片、透明层与 project.json */
export async function pruneExport(root, id, opts = {}) {
  const r = await resolveExportDir(root, id);
  if (!r.ok) return r;
  const active = await guardActive(r.abs, id, opts);
  if (active) return active;
  const report = { freedBytes: 0, busy: [], skipped: [] };
  let names = [];
  try { names = await fs.readdir(r.abs); } catch { /* 空 */ }
  for (const n of names) {
    if (isExportKeepName(n)) {
      // 留下的名字只留真文件;同名的链接照样跳过、不删
      continue;
    }
    await removeTree(path.join(r.abs, n), report, n);
  }
  if (!report.busy.length && !report.skipped.length) return { ok: true, freedBytes: report.freedBytes };
  return { ok: false, status: 409, error: failureMessage(report, '删掉'), freedBytes: report.freedBytes, busy: report.busy.length, skipped: report.skipped.length };
}
