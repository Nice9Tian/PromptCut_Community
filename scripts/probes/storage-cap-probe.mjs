/**
 * 帧库上限与淘汰的端到端探针(存储占用计划 B 部分,`server/frame-library-storage.mjs`、`/api/storage*`)。
 *
 * 起编辑器进程 + 预渲染进程,帧库落在新建的临时目录(`PROMPTCUT_EXPORT_DIR`),先在里面造一批「项目」的键目录
 * (最近使用时刻各不同),然后经编辑器进程的 `/api/storage*`(它转给预渲染进程)逐条核:
 *
 *   1. 启动扫完后 `GET /api/storage` 的总字节 = 造的字节,缺省上限按磁盘总容量算(50 GB 或 10%);
 *   2. 打开一个真项目(推镜像、连 SSE、preload):它用到的键被记为使用、标为正在打开;
 *   3. `POST /api/storage/cap` 把上限设小:从最旧的删起,被打开的文件所在的单元跳过,删到上限的 90% 就停,
 *      30 分钟内用过的和正在打开的项目不删;越界的上限一律 400;
 *   4. `POST /api/storage/clear-cache`:只留 10 分钟内用过的(和正在打开的项目),数字变小;
 *   5. 链接(junction)和认不出的目录不动,链接指向的文件完好。
 *   3a.(三支合并后)跑着时放进去的死进程遗留(`full-<pid>.tmp.mov`、`html-cache/live-<pid>-*`)由下一次检查一并清掉,
 *      `leftovers.bytes` 归零。
 *
 *   node scripts/probes/storage-cap-probe.mjs [--port 5710] [--keep]
 *
 * 最后一行打印一行 JSON(`ok`、`fails` 与各步数字)。`PROMPTCUT_TEST_STORAGE_MIN_CAP` 把用户可设的下限调到 1 MB,
 * 只在这个探针起的 dev server 里生效。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const PORT = Number(args.includes('--port') ? args[args.indexOf('--port') + 1] : 5710);
const KEEP = args.includes('--keep');
const EDITOR = `http://127.0.0.1:${PORT}`;
const BASE_DIR = path.join(os.tmpdir(), `pc-storage-probe-${Date.now().toString(36)}`);
const EXPORT_DIR = path.join(BASE_DIR, 'exports');
const LIBRARY = path.join(EXPORT_DIR, 'frame-library');
const DATA_DIR = path.join(BASE_DIR, 'data');
const OUTSIDE = path.join(BASE_DIR, 'outside');
const MIN_CAP = 1_000_000;
const HOUR = 3600_000, MIN = 60_000;

const fails = [];
const out = { port: PORT, dir: BASE_DIR };
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); return cond; };
const key = seed => crypto.createHash('sha256').update(`storage-probe:${seed}`).digest('hex');
const exists = file => fs.access(file).then(() => true, () => false);

const json = async (url, init) => {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => null);
  return { status: res.status, ok: res.ok, body };
};
const postJson = (url, body) => json(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

async function until(label, fn, timeoutMs = 120000, everyMs = 300) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value;
    try { value = await fn(); } catch { value = null; }
    if (value) return value;
    if (Date.now() > deadline) { fails.push(`超时:${label}`); return null; }
    await delay(everyMs);
  }
}

/* ---------------- 造帧库 ---------------- */

async function makeKey(dir, bytes, mtime, file) {
  const full = path.join(dir, file);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, Buffer.alloc(bytes, 7));
  const seconds = mtime / 1000;
  let current = full;
  for (;;) {
    await fs.utimes(current, seconds, seconds);
    if (current === dir) break;
    current = path.dirname(current);
  }
}

const now0 = Date.now();
/** 每个假项目:整场景目录 + 本地档(同一单元)+ 一个共享档(另一单元),最近使用时刻各不同 */
const E = 15_000_000, C = 5_000_000, L = 1_000_000;
const fakes = [
  { name: 'busy', age: 8 * HOUR, entry: E, card: 0 },
  { name: 'p1', age: 7 * HOUR, entry: E, card: C },
  { name: 'p2', age: 6 * HOUR, entry: E, card: C },
  { name: 'p3', age: 5 * HOUR, entry: E, card: C },
  { name: 'p4', age: 4 * HOUR, entry: E, card: C },
  { name: 'p5', age: 3 * HOUR, entry: E, card: C },
  { name: 'recent', age: 20 * MIN, entry: E, card: C },
  { name: 'clear', age: 15 * MIN, entry: E, card: C },
].map(p => ({ ...p, entryKey: key(`${p.name}:entry`), cardKey: key(`${p.name}:card`), at: now0 - p.age }));
const fakeBytes = p => p.entry + L + p.card;

async function buildLibrary() {
  await fs.mkdir(LIBRARY, { recursive: true });
  await fs.mkdir(DATA_DIR, { recursive: true });
  for (const p of fakes) {
    await makeKey(path.join(LIBRARY, p.entryKey), p.entry, p.at, 'mov/frames/000000.png');
    await makeKey(path.join(LIBRARY, 'controls-local', p.entryKey), L, p.at, `${p.cardKey}/0.html`);
    if (p.card) await makeKey(path.join(LIBRARY, 'controls-html', p.cardKey), p.card, p.at, '0.html');
  }
  // 链接:共享档族里一个键形状的 junction,指向帧库外面
  await fs.mkdir(OUTSIDE, { recursive: true });
  await fs.writeFile(path.join(OUTSIDE, 'precious.txt'), 'keep me');
  await fs.symlink(OUTSIDE, path.join(LIBRARY, 'controls-html', key('link')), 'junction');
  // 认不出的
  await fs.mkdir(path.join(LIBRARY, 'controls-html', 'not-a-key'), { recursive: true });
  await fs.writeFile(path.join(LIBRARY, 'controls-html', 'not-a-key', 'x'), 'x');
  await fs.mkdir(path.join(LIBRARY, 'something-else', key('x')), { recursive: true });
  await fs.writeFile(path.join(LIBRARY, 'something-else', key('x'), 'y'), 'y');
  // 一个导出目录(`exports` 汇总)
  const exp = path.join(EXPORT_DIR, 'export-20260929-120000');
  await fs.mkdir(path.join(exp, 'frames'), { recursive: true });
  await fs.writeFile(path.join(exp, 'preview.mp4'), Buffer.alloc(1000));
  await fs.writeFile(path.join(exp, 'project.json'), '{}');
  await fs.writeFile(path.join(exp, 'frames', '000000.png'), Buffer.alloc(5000));
  await fs.mkdir(path.join(EXPORT_DIR, 'export-vision-zz'), { recursive: true });
  await fs.writeFile(path.join(EXPORT_DIR, 'export-vision-zz', 'x'), Buffer.alloc(777));
}

/* ---------------- dev server ---------------- */

function viteBin() {
  const local = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  if (fsSync.existsSync(local)) return local;
  const main = createRequire(import.meta.url).resolve('vite');
  const at = main.lastIndexOf(`${path.sep}vite${path.sep}`);
  return path.join(main.slice(0, at + 6), 'bin', 'vite.js');
}
let editor = null;
const editorLog = [];
async function startEditor() {
  editor = spawn(process.execPath, [viteBin(), '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    env: { ...process.env, PROMPTCUT_EXPORT_DIR: EXPORT_DIR, PROMPTCUT_DATA_DIR: DATA_DIR, PROMPTCUT_NO_PORT_FILE: '1',
      PROMPTCUT_TEST_STORAGE_MIN_CAP: String(MIN_CAP) } });
  const keep = c => { editorLog.push(c.toString()); if (editorLog.length > 400) editorLog.shift(); };
  editor.stdout.on('data', keep);
  editor.stderr.on('data', keep);
  return until('编辑器进程起来', async () => (await fetch(EDITOR + '/api/prerender/info').then(r => r.ok, () => false)) || null, 120000);
}
function stopEditor() {
  if (!editor || editor.exitCode !== null || !editor.pid) return;
  if (process.platform === 'win32') spawn('taskkill', ['/PID', String(editor.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else editor.kill('SIGKILL');
}
const prerenderUrl = async () => {
  const info = await json(EDITOR + '/api/prerender/info');
  return info.body?.ready && info.body.url ? info.body.url : null;
};

function openReady(base, session) {
  const controller = new AbortController();
  const messages = [];
  const done = (async () => {
    const res = await fetch(`${base}/api/frames/ready?session=${encodeURIComponent(session)}&localRev=1`, { signal: controller.signal });
    let buffer = '';
    for await (const chunk of res.body) {
      buffer += Buffer.from(chunk).toString('utf8');
      let cut;
      while ((cut = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, cut); buffer = buffer.slice(cut + 2);
        for (const line of block.split('\n')) if (line.startsWith('data:')) { try { messages.push(JSON.parse(line.slice(5).trim())); } catch {} }
      }
    }
  })().catch(() => {});
  return { messages, close: () => { controller.abort(); return done; } };
}

const storage = async (detail = true) => (await json(`${EDITOR}/api/storage${detail ? '?detail=1' : ''}`)).body;
const unitOf = (units, id) => units.find(u => u.unit === id);

let handle = null;
let ready = null;
try {
  await buildLibrary();
  const created = fakes.reduce((sum, p) => sum + fakeBytes(p), 0);
  out.createdBytes = created;
  // 被别的进程打开着:busy 的整场景目录里一个文件一直开着
  handle = await fs.open(path.join(LIBRARY, fakes[0].entryKey, 'mov', 'frames', '000000.png'), 'r');

  await startEditor();
  const base = await until('预渲染进程就绪', prerenderUrl, 180000);
  if (!base) throw new Error('预渲染进程没起来');
  out.prerender = base;

  /* ---- 1. 启动扫完 ---- */
  const first = await until('启动扫完', async () => { const s = await storage(); return s?.ok && s.frameLibrary.scannedAt && !s.frameLibrary.scanning ? s : null; }, 60000, 500);
  const lib0 = first?.frameLibrary ?? {};
  out.start = { bytes: lib0.bytes, capBytes: lib0.capBytes, capSource: lib0.capSource, diskBytes: lib0.diskBytes, owner: lib0.owner, exports: first?.exports, leftovers: first?.leftovers };
  check(lib0.bytes === created, '① 启动扫完的总字节 = 造的字节(链接、认不出的不计)', { bytes: lib0.bytes, created });
  const disk = lib0.diskBytes;
  const GIB = 1024 ** 3; // GB 按 1024³
  const expectedDefault = disk && disk < 500 * GIB ? Math.floor(disk * 0.1) : 50 * GIB;
  check(lib0.capSource === 'default' && lib0.capBytes === expectedDefault, '① 缺省上限:磁盘 ≥ 500 GB 取 50 GB,否则 10%', { capBytes: lib0.capBytes, disk });
  check(lib0.owner === true, '① 预渲染进程是帧库的主进程');
  check(first?.exports?.count === 1 && first?.exports?.bytes === 6002 && first?.exports?.intermediateBytes === 5000, '① 导出汇总:一份、不含 export-vision-*,中间文件 = 成片与 project.json 以外的', first?.exports);
  const fakeUnit = unitOf(lib0.units ?? [], `entry:${fakes[1].entryKey}`);
  check(fakeUnit && Math.abs(fakeUnit.at - fakes[1].at) < 3000, '① 没有索引时最近使用时刻取最新文件的修改时刻', fakeUnit);
  check(await exists(path.join(LIBRARY, 'usage.json')), '① 帧库根下写了 usage.json');

  /* ---- 2. 打开一个真项目 ---- */
  const SESSION = `storage-${Date.now().toString(36)}`;
  const PROJECT = {
    id: `storage-probe-${SESSION}`, name: '存储探针', width: 1280, height: 720, fps: 30, duration: 1,
    themeId: 'dark', camera3dFov: 50, media: [], filters: [], pixelMaps: [], audioFx: [], cardNodes: [], style: {},
    tracks: [{ id: 'tr-1', name: 'tr-1', hidden: false, clips: [{ id: 'clip-a', kind: 'card', cardId: 'r6-stateful', start: 0, end: 1, params: {} }] }],
  };
  const pushed = await postJson(EDITOR + '/api/data/project', { session: SESSION, localRev: 1, project: PROJECT });
  check(pushed.ok, '② 项目推进镜像', pushed.body);
  await until('预渲染进程手里有这一版项目', async () => (await json(`${base}/api/data/project?session=${SESSION}&localRev=1`)).ok || null, 30000);
  ready = openReady(base, SESSION);
  const openedAt = Date.now();
  const preload = await postJson(`${base}/api/frames/preload`, { session: SESSION, localRev: 1 });
  check(preload.ok && preload.body?.key, '② preload 开跑', preload.body);
  const entryKey = preload.body?.key;
  out.projectEntry = entryKey?.slice(0, 12);
  await until('预渲染这一版做完', async () => {
    const s = await postJson(`${base}/api/frames/status`, { session: SESSION, localRev: 1 });
    return ['ready', 'error'].includes(s.body?.status) ? s.body.status : null;
  }, 300000, 1000);
  const opened = await storage();
  const projectUnits = (opened.frameLibrary.units ?? []).filter(u => u.at >= openedAt - 1000);
  out.projectUnits = projectUnits.map(u => ({ unit: u.unit.slice(0, 26), bytes: u.bytes, pinned: u.pinned }));
  const projectEntryUnit = unitOf(projectUnits, `entry:${entryKey}`);
  check(!!projectEntryUnit, '② 打开的项目的整场景目录记为使用', out.projectUnits);
  check(projectEntryUnit?.pinned === true, '② 打开的项目标为正在打开', projectEntryUnit);
  check(projectUnits.length >= 2 && projectUnits.every(u => u.pinned), '② 这一版用到的别的键(轨道前缀、共享档……)一起记为使用、标为正在打开', out.projectUnits);
  check(projectUnits.some(u => u.unit.startsWith('controls-html/') || u.unit.startsWith('tracks/')), '② 记的键里有卡片或轨道的键', out.projectUnits);

  /* ---- 3. 上限设小:淘汰 ---- */
  // 先设一个大上限(合法、不淘汰)让它立即检查一次:打开的项目刚写的键在检查时才量(增量维护),
  // 量完的总字节才是下面算目标用的
  // (三支合并后)跑着的时候在一个留着的键目录里放死进程的遗留:下面这次检查要一并清掉(启动清理早就做过了,清它的只能是检查)
  const deadPid = spawnSync(process.execPath, ['-e', '0'], { windowsHide: true }).pid;
  const leftDir = path.join(LIBRARY, fakes[4].entryKey);
  const leftFiles = [path.join(leftDir, 'mov', `full-${deadPid}.tmp.mov`), path.join(leftDir, 'html-cache', `live-${deadPid}-probe`, 'blob')];
  for (const file of leftFiles) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, Buffer.alloc(250_000)); }
  const big = await postJson(`${EDITOR}/api/storage/cap`, { bytes: lib0.capBytes });
  check(big.ok, '③ 先设回缺省大小的上限(触发一次检查)', big.body);
  const swept = await until('检查一并清掉遗留', async () => {
    for (const file of leftFiles) if (await exists(file)) return null;
    return true;
  }, 30000, 300).catch(() => false);
  check(swept, '③a 每次检查一并清遗留:死进程的 tmp.mov 与 html-cache/live-* 没了');
  const afterSweep = await until('遗留字节归零', async () => { const s = await storage(); return s?.leftovers?.bytes === 0 ? s : null; }, 30000, 300).catch(() => null);
  out.leftoverSweep = { deadPid, swept, leftovers: afterSweep?.leftovers ?? null, last: afterSweep?.frameLibrary?.lastLeftoverSweep ?? null };
  check(afterSweep?.leftovers?.bytes === 0, '③a 清完之后 leftovers.bytes 为 0', out.leftoverSweep);
  check(out.leftoverSweep.last?.removed >= 2 && out.leftoverSweep.last?.bytes >= 500_000, '③a 删它们的是帧库管理器的检查(lastLeftoverSweep),不是启动清理', out.leftoverSweep);
  const measured = await until('打开的项目的键量完', async () => {
    const s = await storage();
    const unit = unitOf(s.frameLibrary.units ?? [], `entry:${entryKey}`);
    return unit?.bytes > 0 ? s : null;
  }, 30000, 300);
  await delay(1500);
  const T = (await storage()).frameLibrary.bytes;
  out.projectBytes = T - created;
  const P = p => fakeBytes(p);
  // 目标:busy 跳过(打开着),删掉 p1、p2、p3 就够(p3 的共享档删完才到,留一半共享档的余量给项目自己还在长的字节)
  const target = T - P(fakes[1]) - P(fakes[2]) - P(fakes[3]) + Math.floor(fakes[3].card / 2);
  const cap = Math.round(target / 0.9);
  out.evict = { total: T, cap, target: Math.floor(cap * 0.9), measured: !!measured };
  for (const [bad, label] of [[10, '低于下限'], ['x', '不是数'], [disk ? disk + 1 : Number.MAX_SAFE_INTEGER + 2, '超过磁盘总容量'], [1.5e6 + 0.5, '不是整数']]) {
    const r = await postJson(`${EDITOR}/api/storage/cap`, { bytes: bad });
    check(r.status === 400 && r.body?.code === 'CAP_OUT_OF_RANGE', `③ 越界的上限拒(${label})`, r);
  }
  const t0 = Date.now();
  const setCap = await postJson(`${EDITOR}/api/storage/cap`, { bytes: cap });
  check(setCap.ok && setCap.body?.capBytes === cap, '③ 设上限', setCap.body);
  const evicted = await until('改上限立刻判一次', async () => { const s = await storage(); return s.frameLibrary.lastEvict?.at >= t0 - 1000 ? s : null; }, 60000, 300);
  const detail = evicted?.frameLibrary.lastEvictDetail ?? {};
  const removedUnits = (detail.removedUnits ?? []).map(u => u.unit);
  const nameOf = unit => fakes.find(p => unit === `entry:${p.entryKey}` || unit === `controls-html/${p.cardKey}`)?.name ?? unit.slice(0, 20);
  out.evict.removed = removedUnits.map(nameOf);
  out.evict.skipped = (detail.skippedUnits ?? []).map(u => `${nameOf(u.unit)}:${u.reason}`);
  out.evict.after = evicted?.frameLibrary.bytes;
  out.evict.capSource = evicted?.frameLibrary.capSource;
  check(evicted?.frameLibrary.capSource === 'user' && evicted?.frameLibrary.capBytes === cap, '③ 上限来源变成 user', evicted?.frameLibrary);
  check(JSON.stringify(out.evict.removed) === JSON.stringify(['p1', 'p1', 'p2', 'p2', 'p3', 'p3']), '③ 从最旧的删起:p1、p2、p3,删到 90% 就停', out.evict.removed);
  const ats = (detail.removedUnits ?? []).map(u => u.at);
  check(ats.every((at, i) => i === 0 || at >= ats[i - 1]), '③ 删的顺序按最近使用时刻从旧到新', ats);
  if (process.platform === 'win32') check(JSON.stringify(out.evict.skipped) === JSON.stringify(['busy:busy']), '③ 被打开的文件所在的单元跳过', out.evict.skipped);
  check(evicted?.frameLibrary.bytes <= Math.floor(cap * 0.9), '③ 删到上限的 90% 以下', { after: evicted?.frameLibrary.bytes, target: Math.floor(cap * 0.9) });
  const lastRemoved = detail.removedUnits?.at(-1)?.bytes ?? 0;
  out.evict.detail = { before: detail.before, after: detail.after, targetBytes: detail.targetBytes, lastRemoved };
  check(detail.targetBytes === Math.floor(cap * 0.9) && detail.after <= detail.targetBytes && detail.after + lastRemoved > detail.targetBytes,
    '③ 删到 90% 就停:删最后一个之前还超,删完不超', out.evict.detail);
  for (const p of fakes.slice(1, 4)) check(!(await exists(path.join(LIBRARY, p.entryKey))) && !(await exists(path.join(LIBRARY, 'controls-local', p.entryKey))), `③ ${p.name} 的整场景与本地档删了`);
  for (const p of fakes.slice(4)) check(await exists(path.join(LIBRARY, p.entryKey)), `③ ${p.name} 留着`);
  check(await exists(path.join(LIBRARY, fakes[0].entryKey, 'mov', 'frames', '000000.png')), '③ 跳过的单元一个文件都没删');
  check(await exists(path.join(LIBRARY, entryKey)), '③ 打开的项目不删');

  /* ---- 4. 清理缓存 ---- */
  await handle.close(); handle = null;
  const before = (await storage()).frameLibrary.bytes;
  const cleared = await postJson(`${EDITOR}/api/storage/clear-cache`);
  const after = await storage();
  out.clear = { before, after: after.frameLibrary.bytes, ...cleared.body };
  check(cleared.ok && cleared.body?.removed >= 1 && cleared.body?.freedBytes > 0, '④ 清理缓存删了东西', cleared.body);
  check(after.frameLibrary.bytes < before, '④ 清理之后数字变小', out.clear);
  for (const p of fakes) check(!(await exists(path.join(LIBRARY, p.entryKey))), `④ ${p.name}(${Math.round(p.age / MIN)} 分钟前用过)清掉`);
  check(await exists(path.join(LIBRARY, entryKey)), '④ 正在打开的项目(10 分钟内用过)留着');
  const left = (after.frameLibrary.units ?? []).map(u => u.unit);
  check(projectUnits.every(u => left.includes(u.unit)), '④ 打开的项目用到的键都留着', { left: left.map(u => u.slice(0, 26)) });
  check(after.frameLibrary.bytes === projectUnits.reduce((sum, u) => sum + (unitOf(after.frameLibrary.units, u.unit)?.bytes ?? 0), 0), '④ 剩下的只有打开的项目');

  /* ---- 5. 链接与认不出的 ---- */
  check(await fs.readFile(path.join(OUTSIDE, 'precious.txt'), 'utf8').catch(() => null) === 'keep me', '⑤ junction 指向的文件完好');
  check(await exists(path.join(LIBRARY, 'controls-html', key('link'))), '⑤ junction 本身不动');
  check(await exists(path.join(LIBRARY, 'controls-html', 'not-a-key', 'x')), '⑤ 认不出的名字不动');
  check(await exists(path.join(LIBRARY, 'something-else', key('x'), 'y')), '⑤ 认不出的目录不动');
  check(!(await fs.readdir(path.join(LIBRARY, '.storage', 'trash')).catch(() => [])).length, '⑤ 垃圾目录删干净了');
} catch (error) {
  fails.push(`异常:${error?.stack || error}`);
} finally {
  await handle?.close().catch(() => {});
  await ready?.close();
  stopEditor();
  await delay(1500);
  if (!KEEP) await fs.rm(BASE_DIR, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
}
if (fails.length) out.log = editorLog.join('').split('\n').filter(line => /storage|error/i.test(line)).slice(-20);
console.log(JSON.stringify({ ok: fails.length === 0, fails, ...out }));
process.exit(fails.length ? 1 : 0);
