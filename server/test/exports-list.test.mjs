// 导出产物的列表、删除、只删中间文件(存储占用计划 docs/plan/storage-plan.md 第 4 节的 /api/exports*)。
// 跑法:node --test server/test/exports-list.test.mjs
//
// 模块本身(server/exports-list.mjs)与路由(server/vite-plugin-exports-list.ts,转译后按中间件调)各测一遍。
// 全在系统临时目录里造导出目录,不碰真实的导出目录。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import {
  listExports, summarizeExports, deleteExport, pruneExport, resolveExportDir, parseExportId, treeStats,
} from '../exports-list.mjs';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-exports-list-test-'));
let seq = 0;
const freshRoot = () => { const d = path.join(TMP, `root-${++seq}`); fs.mkdirSync(d, { recursive: true }); return d; };

function put(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(bytes, 1));
}

/** 造一份导出:成片、透明层、project.json、逐帧与分片 */
function makeExport(root, id, { preview = 100, overlay = 1000, frames = [500, 500], parts = 300, project = { name: '片子', id: 'p-1' } } = {}) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  if (preview) put(path.join(dir, 'preview.mp4'), preview);
  if (overlay) put(path.join(dir, 'overlay.mov'), overlay);
  frames.forEach((b, i) => put(path.join(dir, 'frames', `f${i}.png`), b));
  if (parts) put(path.join(dir, 'parts', 'part-0.mov'), parts);
  if (project) fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(project));
  return dir;
}
const projBytes = (p = { name: '片子', id: 'p-1' }) => Buffer.byteLength(JSON.stringify(p));

/** Windows 上建 junction 不要管理员;别的平台用目录符号链接 */
function link(target, at) {
  fs.symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir');
}

test('parseExportId 认同秒后缀、不认 vision 与别的名字', () => {
  assert.ok(parseExportId('export-20260929-091817'));
  assert.equal(parseExportId('export-20260929-091817-2').seq, 2);
  for (const bad of ['export-vision-mtw6axg0-4826', 'export-2026-09-29', 'export-20261399-091817', '..', 'export-20260929-091817/..', 'export-20260929-091817-x', 'Export-20260929-091817']) {
    assert.equal(parseExportId(bad), null, bad);
  }
});

test('列表:认得的、同秒后缀、排除 export-vision-*、没有 project.json 的也列出,新的在前', async () => {
  const root = freshRoot();
  makeExport(root, 'export-20260901-100000');
  makeExport(root, 'export-20260902-100000', { project: null });
  makeExport(root, 'export-20260902-100000-2', { preview: 0, overlay: 0 });
  makeExport(root, 'export-vision-abc-1');
  fs.mkdirSync(path.join(root, 'frame-library'));
  fs.mkdirSync(path.join(root, '.export-staging'));
  put(path.join(root, 'export-20260903-100000'), 10); // 同名的文件不是目录,不认

  const items = await listExports(root);
  assert.deepEqual(items.map((i) => i.id), ['export-20260902-100000-2', 'export-20260902-100000', 'export-20260901-100000']);

  const full = items[2];
  assert.equal(full.projectName, '片子');
  assert.equal(full.projectId, 'p-1');
  assert.equal(full.finished, true);
  assert.equal(full.running, false);
  assert.equal(full.at, new Date(2026, 8, 1, 10, 0, 0).toISOString());
  assert.deepEqual(full.deliverables, [{ name: 'preview.mp4', bytes: 100 }, { name: 'overlay.mov', bytes: 1000 }]);
  assert.equal(full.bytes, 100 + 1000 + 1000 + 300 + projBytes());
  assert.equal(full.intermediateBytes, 1000 + 300, '中间文件 = 总量 - 成片 - 透明层 - project.json');

  const noProj = items[1];
  assert.equal(noProj.projectName, null);
  assert.equal(noProj.projectId, null);
  assert.equal(noProj.intermediateBytes, 1300);

  const unfinished = items[0];
  assert.equal(unfinished.finished, false);
  assert.deepEqual(unfinished.deliverables, []);
  assert.equal(unfinished.intermediateBytes, 1300);

  const sum = await summarizeExports(root);
  assert.deepEqual(sum, { count: 3, bytes: items.reduce((s, i) => s + i.bytes, 0), intermediateBytes: 3 * 1300 });
});

test('列表:导出目录不存在时是空的', async () => {
  assert.deepEqual(await listExports(path.join(TMP, 'nope')), []);
});

test('链接:导出目录本身是链接的不列、不删;目录里的链接不算大小、删时跳过且不碰目标', async () => {
  const root = freshRoot();
  const outside = path.join(TMP, `outside-${seq}`);
  put(path.join(outside, 'precious.bin'), 777);
  link(outside, path.join(root, 'export-20260905-100000'));
  const dir = makeExport(root, 'export-20260906-100000');
  link(outside, path.join(dir, 'frames', 'linked'));

  const items = await listExports(root);
  assert.deepEqual(items.map((i) => i.id), ['export-20260906-100000']);
  assert.equal(items[0].intermediateBytes, 1300, '链接那头的 777 字节不算');
  assert.equal((await treeStats(dir)).links, 1);

  const r1 = await resolveExportDir(root, 'export-20260905-100000');
  assert.equal(r1.ok, false);
  assert.equal(r1.status, 400);
  const d1 = await deleteExport(root, 'export-20260905-100000');
  assert.equal(d1.ok, false);

  const p = await pruneExport(root, 'export-20260906-100000');
  assert.equal(p.ok, false, '跳过了链接要说出来');
  assert.match(p.error, /链接/);
  assert.equal(p.freedBytes, 1300);
  assert.ok(fs.existsSync(path.join(outside, 'precious.bin')), '链接的目标不能被删');

  const d = await deleteExport(root, 'export-20260906-100000');
  assert.equal(d.ok, false);
  assert.ok(fs.existsSync(path.join(outside, 'precious.bin')), '链接的目标不能被删');
});

test('路径校验:..、斜杠、vision、别的目录、不存在的一律拒', async () => {
  const root = freshRoot();
  makeExport(root, 'export-vision-abc-1');
  fs.mkdirSync(path.join(root, 'frame-library'));
  for (const id of ['..', '../x', 'export-20260929-091817/../../x', 'export-20260929-091817\\..\\x', 'frame-library', 'export-vision-abc-1', '', null]) {
    const r = await resolveExportDir(root, id);
    assert.equal(r.ok, false, String(id));
    assert.equal(r.status, 400, String(id));
  }
  const missing = await deleteExport(root, 'export-20260929-091817');
  assert.equal(missing.ok, false);
  assert.equal(missing.status, 404);
  assert.ok(fs.existsSync(path.join(root, 'export-vision-abc-1', 'preview.mp4')));
});

test('只删中间文件:留下成片、透明层、project.json,回腾出的字节', async () => {
  const root = freshRoot();
  const dir = makeExport(root, 'export-20260907-100000');
  put(path.join(dir, 'audio', 'mix.wav'), 50);
  put(path.join(dir, 'filter.txt'), 7);
  const r = await pruneExport(root, 'export-20260907-100000');
  assert.deepEqual(r, { ok: true, freedBytes: 1000 + 300 + 50 + 7 });
  assert.deepEqual(fs.readdirSync(dir).sort(), ['overlay.mov', 'preview.mp4', 'project.json']);
  const [it] = await listExports(root);
  assert.equal(it.intermediateBytes, 0);
  assert.deepEqual(await pruneExport(root, 'export-20260907-100000'), { ok: true, freedBytes: 0 }, '再来一次什么也不删');
});

test('删整份:目录没了,回腾出的字节', async () => {
  const root = freshRoot();
  makeExport(root, 'export-20260908-100000');
  makeExport(root, 'export-20260908-100001');
  const r = await deleteExport(root, 'export-20260908-100000');
  assert.deepEqual(r, { ok: true, freedBytes: 100 + 1000 + 1300 + projBytes() });
  assert.deepEqual((await listExports(root)).map((i) => i.id), ['export-20260908-100001']);
});

test('进行中:有导出在跑、没有成片、最近还在写的不让删也不让只删中间文件', async () => {
  const root = freshRoot();
  makeExport(root, 'export-20260909-100000', { preview: 0 });
  const [it] = await listExports(root, { exportsRunning: true });
  assert.equal(it.running, true);
  const d = await deleteExport(root, 'export-20260909-100000', { exportsRunning: true });
  assert.equal(d.status, 409);
  assert.match(d.error, /还在进行/);
  const p = await pruneExport(root, 'export-20260909-100000', { exportsRunning: true });
  assert.equal(p.status, 409);
  // 没有导出在跑,或者早就不写了:可以删
  assert.equal((await listExports(root, { exportsRunning: true, now: Date.now() + 3600_000 }))[0].running, false);
  assert.equal((await deleteExport(root, 'export-20260909-100000')).ok, true);
});

test('被占用删不掉:回明确的错误(Windows 上独占打开一个文件)', { skip: process.platform !== 'win32' && '只在 Windows 上会因为文件被打开而删不掉' }, async () => {
  const root = freshRoot();
  const dir = makeExport(root, 'export-20260910-100000');
  // 共享模式 0 独占打开:Node 的 fs.open 在 Windows 上默认允许删除共享,这里用 PowerShell 握住文件
  const { spawn } = await import('node:child_process');
  const locked = path.join(dir, 'parts', 'part-0.mov');
  const ps = spawn('powershell.exe', ['-NoProfile', '-Command',
    `$f=[System.IO.File]::Open('${locked}','Open','Read','None'); Write-Output locked; Start-Sleep -Seconds 20; $f.Close()`], { stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('PowerShell 没握住文件')), 15_000);
      ps.stdout.on('data', (b) => { if (String(b).includes('locked')) { clearTimeout(t); resolve(); } });
    });
    const r = await pruneExport(root, 'export-20260910-100000');
    assert.equal(r.ok, false);
    assert.equal(r.status, 409);
    assert.match(r.error, /占用/);
    assert.equal(r.freedBytes, 1000, '别的中间文件照删');
    assert.ok(fs.existsSync(locked));
    const d = await deleteExport(root, 'export-20260910-100000');
    assert.equal(d.ok, false);
    assert.match(d.error, /占用/);
  } finally {
    ps.kill();
  }
});

// ── 路由 ──────────────────────────────────────────────────────────────

const require_ = createRequire(import.meta.url);
const ts = require_('typescript');
async function loadPlugin() {
  const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-exports-plugin-'));
  const src = fs.readFileSync(path.join(ROOT, 'server', 'vite-plugin-exports-list.ts'), 'utf8')
    .split('from "./render-pool-state.mjs"').join(`from "${pathToFileURL(path.join(ROOT, 'server', 'render-pool-state.mjs')).href}"`)
    .split('from "./exports-list.mjs"').join(`from "${pathToFileURL(path.join(ROOT, 'server', 'exports-list.mjs')).href}"`);
  const js = ts.transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
  const file = path.join(OUT, 'plugin.mjs');
  fs.writeFileSync(file, js);
  return (await import(pathToFileURL(file).href)).exportsListPlugin;
}

function call(fn, method, url) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200, headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      end(body) { resolve({ status: this.statusCode, body: JSON.parse(String(body)) }); },
    };
    fn({ method, url, headers: {} }, res, () => resolve('next'));
  });
}

test('路由:回包形状、方法、路径校验,别的地址放给下一个', async () => {
  const exportsListPlugin = await loadPlugin();
  const root = freshRoot();
  const prev = process.env.PROMPTCUT_EXPORT_DIR;
  process.env.PROMPTCUT_EXPORT_DIR = root;
  try {
    makeExport(root, 'export-20260911-100000');
    makeExport(root, 'export-20260911-100000-2', { overlay: 0 });
    makeExport(root, 'export-vision-zzz-1');
    let fn;
    exportsListPlugin().configureServer({ config: { root: TMP }, middlewares: { use(f) { fn = f; } } });

    assert.equal(await call(fn, 'GET', '/api/export/status/x'), 'next');
    assert.equal(await call(fn, 'GET', '/api/exportsX'), 'next');

    const list = await call(fn, 'GET', '/api/exports?t=1');
    assert.equal(list.status, 200);
    assert.equal(list.body.ok, true);
    assert.deepEqual(list.body.items.map((i) => i.id), ['export-20260911-100000-2', 'export-20260911-100000']);
    assert.deepEqual(Object.keys(list.body.items[1]).sort(),
      ['at', 'bytes', 'deliverables', 'finished', 'id', 'intermediateBytes', 'projectId', 'projectName', 'running'].sort());

    assert.equal((await call(fn, 'POST', '/api/exports')).status, 405);
    assert.equal((await call(fn, 'GET', '/api/exports/export-20260911-100000/delete')).status, 405);
    assert.equal((await call(fn, 'POST', '/api/exports/export-20260911-100000/nuke')).status, 404);
    assert.equal((await call(fn, 'POST', '/api/exports/..%2F..%2Fx/delete')).status, 400);
    assert.equal((await call(fn, 'POST', '/api/exports/export-vision-zzz-1/delete')).status, 400);
    assert.equal((await call(fn, 'POST', '/api/exports/%E0%A4%A/delete')).status, 400);
    assert.equal((await call(fn, 'POST', '/api/exports/export-20260101-000000/reveal')).status, 404);

    const pr = await call(fn, 'POST', '/api/exports/export-20260911-100000/prune');
    assert.deepEqual(pr, { status: 200, body: { ok: true, freedBytes: 1300 } });
    const del = await call(fn, 'POST', '/api/exports/export-20260911-100000-2/delete');
    assert.equal(del.status, 200);
    assert.equal(del.body.ok, true);
    assert.equal(typeof del.body.freedBytes, 'number');
    const after = await call(fn, 'GET', '/api/exports');
    assert.deepEqual(after.body.items.map((i) => [i.id, i.intermediateBytes]), [['export-20260911-100000', 0]]);
    assert.ok(fs.existsSync(path.join(root, 'export-vision-zzz-1')));
  } finally {
    if (prev === undefined) delete process.env.PROMPTCUT_EXPORT_DIR; else process.env.PROMPTCUT_EXPORT_DIR = prev;
  }
});

test.after(async () => { await fsp.rm(TMP, { recursive: true, force: true }).catch(() => {}); });
