/**
 * 开始页「存储」一块与标题栏「存储…」的界面探针(存储占用计划 `docs/plan/storage-plan.md` 第 6 节「界面」)。
 * 在 worktree 根目录跑:
 *
 *   node scripts/probes/storage-ui-probe.mjs [--port 5720] [--out <截图目录>]
 *
 * 起的东西(都由本探针起、跑完关掉):一台编辑器 dev server(`--port`,另占 +1、+2 当舞台端口;它自己再起一个预渲染进程),
 * 无头 Chrome。导出目录、数据目录都在系统临时目录里,里面预先造 3 份导出(一份完整、一份同秒重名且没有 project.json、
 * 一份未完成)和一份 `export-vision-*`;不碰桌面版的 `Videos\PromptCut`,不写公共的 port.json。
 *
 * 断言:
 *   U1 「存储」一块在;导出列表 3 条(`export-vision-*` 不列),新的在前;`/api/storage` 还没有(storage-cap 未合入)时缓存那一行是「暂时取不到」,页面没有报错;
 *   U2 「只删中间文件」后那一份的大小变小、中间文件那一栏没了,磁盘上只剩成片、透明层与 project.json;
 *   U3 「删除」(确认框)后少一份,磁盘上那个目录没了;
 *   U4 开始页上点标题栏「文件 → 存储…」滚到「存储」;从编辑器(`?editor`)点也回到开始页并滚到「存储」;
 *   U5 用拦截模拟 `/api/storage*`:显示占用与上限,「清理缓存」后显示腾出多少、数字变小,改上限发出的请求与回显对;
 *   U6 接口的路径校验:`..`、`export-vision-*` 回 400(不点真的「打开所在目录」,那会在桌面上弹资源管理器)。
 *   U7 (三支合并后)不拦截:真的 `/api/storage` 与 `/api/exports` 都 ok,导出一栏 = 列表合计(删一份、只删中间文件之后马上跟上);
 *      页面上真的「清理缓存」与改上限落到服务端(帧库、`storage.json` 都在临时目录)。U1 此时要求缓存那一行显示数字。
 *   U8 (最先跑,约多花 60 秒)往帧库里写一批帧,过 60 秒再打开开始页:先显示旧数,服务端后台量(`scanning: true`),
 *      页面自己隔几秒再取,十几秒内显示成真实值。大小一律按 1024(GB = 1024³)。
 * 结果最后一行是一行 JSON(`ok`、`fails`),截图在 --out。
 */
import '../lib/no-user-dirs.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { createTimings } from './probe-timings.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const PORT = Number(arg('--port', 5720));
const OUT = path.resolve(arg('--out', path.join(os.tmpdir(), 'storage-ui-shots')));
const ORIGIN = `http://127.0.0.1:${PORT}`;
fs.mkdirSync(OUT, { recursive: true });

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-storage-ui-'));
const EXPORTS = path.join(TMP, 'exports');
const DATA = path.join(TMP, 'data');
fs.mkdirSync(DATA, { recursive: true });

const fails = [];
/** 耗时只记录(docs/semantics/guide_files/verification.md「耗时只记录,不当闸门」):开始页的占用数字自动变成真实值用了多久只写进 TIMINGS 行,不决定过不过 */
const timingLog = createTimings('storage-ui-probe');
const out = { ok: false, out: OUT, tmp: TMP };
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 400))); return !!cond; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = 20_000, every = 150) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`等不到:${what}`);
    await sleep(every);
  }
}

function put(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(bytes, 7));
}
const MB = 1024 * 1024;
function makeExport(id, { preview = 0, overlay = 0, frames = 0, parts = 0, project = null }) {
  const dir = path.join(EXPORTS, id);
  fs.mkdirSync(dir, { recursive: true });
  if (preview) put(path.join(dir, 'preview.mp4'), preview);
  if (overlay) put(path.join(dir, 'overlay.mov'), overlay);
  for (let i = 0; i < frames; i++) put(path.join(dir, 'frames', `${String(i).padStart(5, '0')}.png`), MB);
  if (parts) put(path.join(dir, 'parts', 'part-0.mov'), parts);
  if (project) fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(project));
  return dir;
}
// 完整的一份(有中间文件)、同秒重名且没有 project.json 的一份、未完成的一份(取消或失败留下的)、视觉工具的临时目录
const FULL = 'export-20260920-101500';
const DUP = 'export-20260920-101500-2';
const HALF = 'export-20260921-080000';
makeExport(FULL, { preview: 3 * MB, overlay: 20 * MB, frames: 12, parts: 8 * MB, project: { name: '探针项目甲', id: 'p-probe-a' } });
makeExport(DUP, { preview: 2 * MB, overlay: 5 * MB, frames: 3 });
makeExport(HALF, { frames: 6, parts: 4 * MB, project: { name: '探针项目乙', id: 'p-probe-b' } });
makeExport('export-vision-probe-1', { preview: MB, project: { name: '不该出现' } });

async function portFree(p) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(p, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

let vite = null;
async function stopTree(child) {
  if (!child?.pid || child.exitCode !== null) return;
  await new Promise((resolve) => {
    const k = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    k.once('error', resolve);
    k.once('exit', resolve);
  });
}

let browser = null;
try {
  for (const p of [PORT, PORT + 1, PORT + 2]) if (!(await portFree(p))) throw new Error(`端口 ${p} 被占`);
  // vite 的 exports 不导出 bin/,按包目录找(同 server/vite-plugin-prerender.ts 的 viteBin);依赖向上解析到主仓库
  const viteBin = path.join(path.dirname(createRequire(path.join(ROOT, 'package.json')).resolve('vite/package.json')), 'bin', 'vite.js');
  const log = [];
  vite = spawn(process.execPath, [viteBin, '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
    cwd: ROOT,
    env: { ...process.env, PROMPTCUT_NO_PORT_FILE: '1', PROMPTCUT_EXPORT_DIR: EXPORTS, PROMPTCUT_DATA_DIR: DATA },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  vite.stdout.on('data', (b) => { log.push(String(b)); if (log.length > 40) log.shift(); });
  vite.stderr.on('data', (b) => { log.push(String(b)); if (log.length > 40) log.shift(); });
  await until('dev server 回 200', async () => {
    if (vite.exitCode !== null) throw new Error(log.join(''));
    const r = await fetch(ORIGIN + '/', { signal: AbortSignal.timeout(2000) });
    await r.body?.cancel();
    return r.status === 200;
  }, 120_000, 300);

  // 合并后 `/api/storage*` 是真的(编辑器进程转给预渲染进程):等预渲染进程起来、答得上再开页面
  const storageJson = async (p, init) => {
    const r = await fetch(ORIGIN + p, { ...init, signal: AbortSignal.timeout(30_000) });
    const body = await r.json().catch(() => null);
    return { status: r.status, body };
  };
  await until('真的 /api/storage 答 ok', async () => (await storageJson('/api/storage')).body?.ok === true, 180_000, 500);
  const exportsSum = async () => {
    const r = await storageJson('/api/exports');
    const items = r.body?.items ?? [];
    return { ok: r.body?.ok === true, bytes: items.reduce((s, it) => s + it.bytes, 0), count: items.length, intermediateBytes: items.reduce((s, it) => s + it.intermediateBytes, 0) };
  };

  browser = await puppeteer.launch({ headless: true, args: [...PROBE_CHROME_ARGS, '--no-sandbox'] });
  const pageErrors = [];
  const newPage = async () => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 860 });
    page.on('pageerror', (e) => pageErrors.push(String(e?.message || e)));
    page.on('dialog', (d) => { void d.accept(); });
    return page;
  };
  const rows = (page) => page.$$eval('[data-pc="storage-export"]', (els) => els.map((el) => ({
    id: el.getAttribute('data-export-id'),
    text: el.textContent,
    bytes: el.querySelector('[data-pc="storage-export-bytes"]')?.textContent ?? '',
    mid: el.querySelector('[data-pc="storage-export-mid"]')?.textContent ?? '',
    prune: !!el.querySelector('[data-pc="storage-export-prune"]'),
  })));
  const inView = (page) => page.$eval('[data-pc="start-storage"]', (el) => {
    // 滚到了:标题贴到视野上半,或者「存储」是最后一块、容器已经滚到底(再也滚不上去)
    const r = el.getBoundingClientRect();
    const main = el.closest('.sp-main');
    const atBottom = !!main && main.scrollTop > 0 && main.scrollTop + main.clientHeight >= main.scrollHeight - 2;
    return r.top >= 0 && r.top < window.innerHeight && (r.top < window.innerHeight * 0.5 || atBottom);
  });

  // ── U8 刚写完一批帧后打开开始页:数字在十几秒内变成真实值 ──
  // 上面等就绪的那次 GET 已经让服务端量过一次;之后往帧库里写一批帧(就像预渲染刚写完),
  // 等过 60 秒(`SUMMARY_STALE_MS`)再打开开始页:第一次回包是旧数、带 scanning: true,页面隔几秒自己再取,
  // 直到显示真实值。这期间不发任何 /api/storage 请求。
  {
    const readyAt = Date.now();
    const batchKey = [...Array(64)].map((_, i) => '0123456789abcdef'[(i * 7 + 3) % 16]).join('');
    for (let i = 0; i < 5; i++) put(path.join(EXPORTS, 'frame-library', batchKey, 'mov', 'frames', `${String(i).padStart(6, '0')}.png`), MB);
    await sleep(Math.max(0, readyAt + 62_000 - Date.now()));
    const p8 = await newPage();
    const texts = [];
    const t0 = Date.now();
    await p8.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded' });
    const first = await until('缓存那一行', () => p8.$eval('[data-pc="storage-cache-bytes"]', (el) => el.textContent).catch(() => null), 20_000);
    texts.push(first);
    const settled = await until('数字变成真实值', async () => {
      const t = await p8.$eval('[data-pc="storage-cache-bytes"]', (el) => el.textContent);
      if (texts.at(-1) !== t) texts.push(t);
      return t.startsWith('5.0M') ? t : null;
    }, 120_000, 250).catch(() => null); // 等待时限只为防卡死(原 20 秒)
    const elapsedMs = Date.now() - t0;
    const server = (await storageJson('/api/storage')).body?.frameLibrary;
    out.U8 = { first, settled, elapsedMs, texts, serverBytes: server?.bytes, scanning: server?.scanning };
    await p8.$eval('[data-pc="start-storage"]', (el) => el.scrollIntoView());
    await p8.screenshot({ path: path.join(OUT, 'u8-fresh-bytes.png') });
    await p8.close();
    check(!first.startsWith('5.0M'), 'U8 刚打开时是旧数(证明后面是自动重取,不是碰巧已经量过)', out.U8);
    timingLog.record('U8 打开开始页到占用数字变成真实值', settled ? elapsedMs : null, { formerLimit: '< 20 秒' });
    check(!!settled, 'U8 自动变成真实值 5.0M(用时只记录)', out.U8);
    check(server?.bytes === 5 * MB && server?.scanning === false, 'U8 服务端量完:5 MB、scanning false', out.U8);
  }

  // ── U1 ──
  const page = await newPage();
  await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded' });
  await until('「存储」一块', () => page.$('[data-pc="start-storage"]'));
  await until('导出列表', async () => (await rows(page)).length > 0);
  await until('缓存那一行', () => page.$('[data-pc="storage-cache-unavailable"], [data-pc="storage-cache-bytes"]'));
  const r1 = await rows(page);
  out.U1 = { rows: r1.map((r) => r.id) };
  check(JSON.stringify(r1.map((r) => r.id)) === JSON.stringify([HALF, DUP, FULL]), 'U1 列表 3 条、新的在前、vision 不列', r1.map((r) => r.id));
  check(!r1.some((r) => r.text.includes('不该出现')), 'U1 vision 不列');
  check(r1[0].text.includes('未完成') && r1[0].text.includes('探针项目乙'), 'U1 未完成的那份标「未完成」', r1[0].text);
  check(r1[1].text.includes('未知项目'), 'U1 没有 project.json 的列为未知项目', r1[1].text);
  check(r1[2].text.includes('成片') && r1[2].text.includes('透明层') && r1[2].text.includes('中间文件'), 'U1 完整的那份列出成片、透明层、中间文件', r1[2].text);
  const unavailable = await page.$('[data-pc="storage-cache-unavailable"]');
  out.U1.storageApi = unavailable ? 'unavailable' : 'present';
  check(!unavailable, 'U1 合并后 /api/storage 是真的,缓存那一行显示数字');
  if (unavailable) {
    check(await page.$eval('[data-pc="storage-clear-cache"]', (b) => b.disabled), 'U1 取不到时「清理缓存」置灰');
  }
  // U7a 真的 /api/storage 与 /api/exports:都 ok,导出一栏与列表同一套规则(vision 不算),数字对得上
  {
    const s = await storageJson('/api/storage');
    const e = await exportsSum();
    const f = s.body?.frameLibrary;
    out.U7 = { storage: s.body, exportsList: e, cacheText: await page.$eval('[data-pc="storage-cache-bytes"]', (el) => el.textContent).catch(() => null) };
    check(s.status === 200 && s.body?.ok === true, 'U7 GET /api/storage ok', s);
    check(e.ok, 'U7 GET /api/exports ok');
    check(f && Number.isFinite(f.bytes) && Number.isFinite(f.capBytes) && Number.isFinite(f.diskBytes) && ['default', 'user'].includes(f.capSource), 'U7 frameLibrary 字段齐', f);
    check(Number.isFinite(s.body?.leftovers?.bytes), 'U7 leftovers.bytes 是数', s.body?.leftovers);
    check(JSON.stringify(s.body?.exports) === JSON.stringify({ bytes: e.bytes, count: e.count, intermediateBytes: e.intermediateBytes }) && e.count === 3,
      'U7 /api/storage 的导出一栏 = /api/exports 列表的合计(3 份,vision 不算)', { storage: s.body?.exports, list: e });
  }
  check(!(await page.$('[data-pc="storage-error"]')), 'U1 页面上没有报错条');
  await page.$eval('[data-pc="start-storage"]', (el) => el.scrollIntoView());
  await page.screenshot({ path: path.join(OUT, 'u1-storage.png') });

  // ── U2 只删中间文件 ──
  const beforeFull = r1.find((r) => r.id === FULL);
  await page.click(`[data-export-id="${FULL}"] [data-pc="storage-export-prune"]`);
  await until('只删中间文件的提示', () => page.$eval('[data-pc="storage-notice"]', (el) => el.textContent.includes('已删中间文件')));
  const r2 = await rows(page);
  const afterFull = r2.find((r) => r.id === FULL);
  out.U2 = { before: beforeFull.bytes, after: afterFull?.bytes, notice: await page.$eval('[data-pc="storage-notice"]', (el) => el.textContent) };
  check(afterFull && afterFull.bytes !== beforeFull.bytes && afterFull.mid === '' && !afterFull.prune, 'U2 大小变小、中间文件那栏没了', out.U2);
  check(JSON.stringify(fs.readdirSync(path.join(EXPORTS, FULL)).sort()) === JSON.stringify(['overlay.mov', 'preview.mp4', 'project.json']), 'U2 磁盘上只剩成片、透明层、project.json', fs.readdirSync(path.join(EXPORTS, FULL)));
  await page.screenshot({ path: path.join(OUT, 'u2-pruned.png') });

  // ── U3 删除 ──
  await page.click(`[data-export-id="${HALF}"] [data-pc="storage-export-delete"]`);
  await until('删除后少一份', async () => (await rows(page)).length === 2);
  out.U3 = { rows: (await rows(page)).map((r) => r.id) };
  check(!fs.existsSync(path.join(EXPORTS, HALF)), 'U3 磁盘上那一份没了');
  check(fs.existsSync(path.join(EXPORTS, 'export-vision-probe-1')), 'U3 vision 目录不动');
  await page.screenshot({ path: path.join(OUT, 'u3-deleted.png') });
  // U7b 删了一份、只删了中间文件之后,/api/storage 的导出一栏马上跟上(不回 60 秒前的缓存)
  {
    const s = await storageJson('/api/storage');
    const e = await exportsSum();
    out.U7.afterDelete = { storage: s.body?.exports, list: e };
    check(s.body?.ok === true && JSON.stringify(s.body?.exports) === JSON.stringify({ bytes: e.bytes, count: e.count, intermediateBytes: e.intermediateBytes }) && e.count === 2,
      'U7 删除与只删中间文件之后导出一栏与列表一致', out.U7.afterDelete);
  }
  // U7c 真的「清理缓存」与改上限(帧库、数据目录都在临时目录里)
  {
    const sent = [];
    const onReq = (req) => { if (req.url().includes('/api/storage/')) sent.push({ path: new URL(req.url()).pathname, body: req.postData() ?? null }); };
    page.on('request', onReq);
    await page.$eval('[data-pc="start-storage"]', (el) => el.scrollIntoView());
    await page.click('[data-pc="storage-clear-cache"]');
    await until('真的清理缓存的提示', () => page.$eval('[data-pc="storage-notice"]', (el) => el.textContent.includes('腾出')), 60_000);
    out.U7.clearNotice = await page.$eval('[data-pc="storage-notice"]', (el) => el.textContent);
    out.U7.lastEvictText = await until('上次清理那一行', () => page.$eval('[data-pc="start-storage"]', (el) => (el.textContent.match(/上次[^，]*/) || [null])[0]), 10_000).catch(() => null);
    check(out.U7.lastEvictText?.startsWith('上次清理缓存'), 'U7 用户点的清理缓存不标成「自动清理」', out.U7.lastEvictText);
    await page.screenshot({ path: path.join(OUT, 'u7-real-cleared.png') });
    await page.$eval('[data-pc="storage-cap-input"]', (el) => { el.select(); });
    await page.type('[data-pc="storage-cap-input"]', '20');
    await page.click('[data-pc="storage-cap-save"]');
    await until('真的改上限的提示', () => page.$eval('[data-pc="storage-notice"]', (el) => el.textContent.includes('上限已改')), 30_000);
    page.off('request', onReq);
    const capReq = sent.find((x) => x.path === '/api/storage/cap');
    const sentBytes = capReq ? JSON.parse(capReq.body || '{}').bytes : null;
    const after = await storageJson('/api/storage');
    out.U7.cap = { sentBytes, capBytes: after.body?.frameLibrary?.capBytes, capSource: after.body?.frameLibrary?.capSource, text: await page.$eval('[data-pc="storage-cache-bytes"]', (el) => el.textContent) };
    check(sent.some((x) => x.path === '/api/storage/clear-cache'), 'U7 点「清理缓存」发出真的请求');
    check(sentBytes === 20 * 1024 ** 3 && after.body?.frameLibrary?.capBytes === sentBytes && after.body?.frameLibrary?.capSource === 'user', 'U7 改上限落到服务端(填 20 = 20 × 1024³ 字节,与服务端的 GB 一致)', out.U7.cap);
    check(/上限 20\.0G/.test(out.U7.cap.text), 'U7 回显「上限 20.0G」', out.U7.cap.text);
    check(/上限 50\.0G（缺省）/.test(out.U7.cacheText ?? ''), 'U7 缺省上限显示成 50.0G(不是 46.6G)', out.U7.cacheText);
    check(fs.existsSync(path.join(DATA, 'storage.json')), 'U7 上限写在临时数据目录的 storage.json');
    await page.screenshot({ path: path.join(OUT, 'u7-real-cap.png') });
  }

  // ── U4 标题栏「存储…」──
  await page.$eval('.sp-main', (el) => { el.scrollTop = 0; });
  await sleep(100);
  check(!(await inView(page)), 'U4 前提:滚回顶上后「存储」不在视野上半');
  const openStorageFromMenu = async (p) => {
    await p.click('.pc-titlebar-menu-button');
    await until('菜单项「存储…」', () => p.$('[data-pc="titlebar-open-storage"]'));
    await p.click('[data-pc="titlebar-open-storage"]');
  };
  await openStorageFromMenu(page);
  out.U4 = { fromStart: await until('开始页上滚到「存储」', () => inView(page), 5000).catch(() => false) };
  check(out.U4.fromStart, 'U4 开始页上点「存储…」滚到「存储」');
  await page.screenshot({ path: path.join(OUT, 'u4-menu-from-start.png') });

  const ed = await newPage();
  await ed.goto(ORIGIN + '/?editor', { waitUntil: 'domcontentloaded' });
  await until('编辑器', () => ed.$('.pc-bar--main'), 60_000);
  await sleep(1500);
  await openStorageFromMenu(ed);
  await until('回到开始页', () => ed.$('[data-pc="start-storage"]'), 15_000);
  out.U4.fromEditor = await until('从编辑器回来滚到「存储」', () => inView(ed), 8000).catch(() => false);
  check(out.U4.fromEditor, 'U4 从编辑器点「存储…」回到开始页并滚到「存储」');
  await sleep(1700); // 跟滚的 1.5 s 过去之后还在
  out.U4.fromEditorSettled = await inView(ed);
  check(out.U4.fromEditorSettled, 'U4 上面几块读完之后「存储」仍在视野里');
  await ed.screenshot({ path: path.join(OUT, 'u4-menu-from-editor.png') });
  await ed.close();

  // ── U5 模拟 /api/storage* ──
  // 「存储」一块与服务端一样 GB = 1024³:缺省 50 GB 显示成 50.0G,填 20 发 20 × 1024³
  const GB = 1024 ** 3;
  const mock = { bytes: 12 * GB, capBytes: 50 * GB, capSource: 'default', diskBytes: 931 * GB };
  const sent = [];
  const mp = await newPage();
  await mp.setRequestInterception(true);
  mp.on('request', (req) => {
    const u = new URL(req.url());
    const json = (body) => req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (u.pathname === '/api/storage' && req.method() === 'GET') {
      return json({ ok: true, frameLibrary: { ...mock, pinnedBytes: GB, scannedAt: Date.now(), lastEvict: { at: Date.now() - 3600_000, freedBytes: 2 * GB, removed: 3, skipped: 0 } }, exports: { bytes: 0, count: 0, intermediateBytes: 0 }, leftovers: { bytes: 0 } });
    }
    if (u.pathname === '/api/storage/clear-cache' && req.method() === 'POST') {
      sent.push({ path: u.pathname });
      const freed = 9 * GB;
      mock.bytes -= freed;
      return json({ ok: true, freedBytes: freed, removed: 40, skipped: 0 });
    }
    if (u.pathname === '/api/storage/cap' && req.method() === 'POST') {
      const body = JSON.parse(req.postData() || '{}');
      sent.push({ path: u.pathname, body, type: req.headers()['content-type'] });
      mock.capBytes = body.bytes;
      mock.capSource = 'user';
      return json({ ok: true, capBytes: body.bytes });
    }
    return req.continue();
  });
  await mp.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded' });
  await until('缓存占用', () => mp.$('[data-pc="storage-cache-bytes"]'));
  const fig0 = await mp.$eval('[data-pc="storage-cache-bytes"]', (el) => el.textContent);
  await mp.$eval('[data-pc="start-storage"]', (el) => el.scrollIntoView());
  await mp.screenshot({ path: path.join(OUT, 'u5-storage-mocked.png') });
  await mp.click('[data-pc="storage-clear-cache"]');
  await until('清理缓存的提示', () => mp.$eval('[data-pc="storage-notice"]', (el) => el.textContent.includes('腾出')));
  const notice = await mp.$eval('[data-pc="storage-notice"]', (el) => el.textContent);
  const fig1 = await until('数字变小', async () => {
    const t = await mp.$eval('[data-pc="storage-cache-bytes"]', (el) => el.textContent);
    return t !== fig0 ? t : null;
  });
  await mp.screenshot({ path: path.join(OUT, 'u5-cleared.png') });
  await mp.$eval('[data-pc="storage-cap-input"]', (el) => { el.select(); });
  await mp.type('[data-pc="storage-cap-input"]', '20');
  await mp.click('[data-pc="storage-cap-save"]');
  await until('改上限的提示', () => mp.$eval('[data-pc="storage-notice"]', (el) => el.textContent.includes('上限已改')));
  const fig2 = await mp.$eval('[data-pc="storage-cache-bytes"]', (el) => el.textContent);
  // 低于 5 GB 的不发
  await mp.$eval('[data-pc="storage-cap-input"]', (el) => { el.select(); });
  await mp.type('[data-pc="storage-cap-input"]', '2');
  await mp.click('[data-pc="storage-cap-save"]');
  await until('范围提示', () => mp.$eval('[data-pc="storage-error"]', (el) => el.textContent.includes('5 GB')));
  out.U5 = { fig0, notice, fig1, fig2, sent };
  check(fig0.includes('12.0G') && fig0.includes('50.0G') && fig0.includes('缺省'), 'U5 显示占用与上限', fig0);
  check(notice.includes('9.0G'), 'U5 清理后显示腾出多少', notice);
  check(fig1.includes('3.0G'), 'U5 清理后数字变小', fig1);
  check(fig2.includes('20.0G') && !fig2.includes('缺省'), 'U5 改上限后回显', fig2);
  const capReqs = sent.filter((s) => s.path === '/api/storage/cap');
  check(capReqs.length === 1 && capReqs[0].body.bytes === 20 * GB && /application\/json/.test(capReqs[0].type || ''), 'U5 改上限只发一次、字节数与类型对', capReqs);
  await mp.screenshot({ path: path.join(OUT, 'u5-cap.png') });
  await mp.close();

  // ── U6 接口路径校验 ──
  const post = (p) => page.evaluate(async (u) => { const r = await fetch(u, { method: 'POST' }); return r.status; }, p);
  out.U6 = {
    dotdot: await post('/api/exports/..%2F..%2Fdata/delete'),
    vision: await post('/api/exports/export-vision-probe-1/delete'),
    visionReveal: await post('/api/exports/export-vision-probe-1/reveal'),
    missing: await post('/api/exports/export-20200101-000000/prune'),
  };
  check(out.U6.dotdot === 400 && out.U6.vision === 400 && out.U6.visionReveal === 400 && out.U6.missing === 404, 'U6 路径校验', out.U6);
  check(fs.existsSync(path.join(EXPORTS, 'export-vision-probe-1')), 'U6 vision 目录不动');

  out.pageErrors = pageErrors;
  check(pageErrors.length === 0, '页面没有未捕获的错误', pageErrors);
} catch (e) {
  fails.push(`探针自己出错:${e?.stack || e}`);
} finally {
  await browser?.close().catch(() => {});
  await stopTree(vite);
  await sleep(500);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 留着也在临时目录里 */ }
}
out.fails = fails;
out.ok = fails.length === 0;
timingLog.print();
console.log(JSON.stringify(out));
process.exit(out.ok ? 0 : 1);
