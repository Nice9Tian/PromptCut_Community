/**
 * see_frames 的 cutId 探针(用户 2026-10-21 定:看画面能指定剪辑,不用切换;`docs/semantics/product/agent.md`「工具」、
 * `product/project-model.md`「剪辑」;报告 `docs/archive/agent-reports/AGENT-cut-look-ui.md`)。
 *
 *   node scripts/probes/cut-look-probe.mjs [--port 5970] --out <出图目录> [--keep]
 *
 * 起一台本机编辑器进程(+ 它自己起的预渲染进程,真 Chrome),项目有两条剪辑:剪辑1(激活)整屏纯红、剪辑2(停放)整屏纯蓝。
 * 纯色卡是探针临时写进 `src/cards/user/cut-look-solid.tsx` 的(跑完删掉),源码取自 `fixtures/cloud-look/look-solid.tsx`。
 * 工具一律经本机 MCP 那条入口 `POST /api/mcp/call`(桌面 CLI 经 MCP 调工具走的就是它)。两条出图路各跑一遍:
 *
 *   A 镜像那条路(没绑项目副本:页面只把项目推进数据镜像,`instance.mjs` 的 runMirroredTool):
 *     A1 激活剪辑1,see_frames 带剪辑2 的 cutId → 画面中心是蓝的;回包 cut = 剪辑2
 *     A2 前后数据镜像的版本号与项目都没变(activeCutId 仍是剪辑1,没有写入)
 *     A3 不带 cutId → 画面中心是红的;回包 cut = 剪辑1
 *     A4 cutId 不存在 → 明确报错「找不到剪辑」,列出现有的
 *   B 编辑器页面 + 项目副本那条路(真的打开编辑台,页面把项目写进本机文档服务并绑定;Agent 服务端在副本上执行,`agent-exec.mjs`
 *     的 seeFrames —— 云端托管档与账号模式出图前走的也是这一份):
 *     B1 带剪辑2 的 cutId → 蓝;回包 cut = 剪辑2
 *     B2 页面 store 里的项目还是同一个对象、activeCutId 仍是剪辑1、播放头没动;文档服务里的版本号没变(没有写入)
 *     B3 不带 cutId → 红
 *     B4 旧名 `switch_cut` 不在工具清单里;`user_interface_switch_cut` 在(MCP 的工具清单 `tools/list` 同源)
 *
 * 出的图存在 --out 目录:A1-cut2.png、A3-cut1.png、B1-cut2.png、B3-cut1.png(主会话要亲自看图)。
 * 每条断言一行 PASS/FAIL,最后一行打一行 JSON;有失败退出码 1。端口 --port 与 +1、+2 三个连号都要空着(不碰 5190～5192)。
 * 带 PROMPTCUT_NO_PORT_FILE=1 起服务,产物落临时目录(`PROMPTCUT_EXPORT_DIR` / `PROMPTCUT_DATA_DIR`),跑完删掉;`--keep` 不关、不删。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { PNG } from 'pngjs';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const PORT = Number(arg('--port', 5970));
const KEEP = argv.includes('--keep');
const OUT = path.resolve(arg('--out', path.join(ROOT, 'out', 'cut-look-probe')));
const EDITOR = `http://127.0.0.1:${PORT}`;
const EXPORT_DIR = path.join(os.tmpdir(), `pc-cut-look-probe-${Date.now().toString(36)}`);
const DATA_DIR = path.join(EXPORT_DIR, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
setTimeout(() => { console.error('SCRIPT_TIMEOUT'); cleanup(); process.exit(124); }, 15 * 60_000).unref();

const results = {};
const fails = [];
const check = (key, cond, note, extra) => {
  results[key] = { ok: !!cond, note, ...(extra !== undefined ? { extra } : {}) };
  if (!cond) fails.push(`${key}: ${note}${extra !== undefined ? ' :: ' + JSON.stringify(extra).slice(0, 400) : ''}`);
  console.log(`${cond ? 'PASS' : 'FAIL'} ${key} ${note}${extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 300) : ''}`);
};

/* ---------- 临时纯色卡 ---------- */
const CARD_ID = 'cut-look-solid';
const CARD_FILE = path.join(ROOT, 'src', 'cards', 'user', `${CARD_ID}.tsx`);
const fixture = fs.readFileSync(path.join(ROOT, 'scripts', 'probes', 'fixtures', 'cloud-look', 'look-solid.tsx'), 'utf8');
const cardSource = fixture
  .replace('id: "look-solid"', `id: "${CARD_ID}"`)
  .replace('export const lookSolid', 'export const cutLookSolid')
  .replace('function LookSolid', 'function CutLookSolid')
  .replace('Component: LookSolid', 'Component: CutLookSolid');
if (fs.existsSync(CARD_FILE)) throw new Error(`${CARD_FILE} 已经存在,不覆盖`);
fs.writeFileSync(CARD_FILE, cardSource);

/* ---------- 项目:剪辑1 红(激活)、剪辑2 蓝(停放,上次停在 1 秒) ---------- */
const solid = (id, color) => ({ id, cardId: CARD_ID, start: 0, end: 4, params: { color } });
const project = (id) => ({
  version: 1, id, name: '看别的剪辑的画面', width: 640, height: 360, fps: 30, duration: 4, themeId: 'midnight',
  media: [], filters: [], pixelMaps: [], audioFx: [], cardNodes: [],
  tracks: [{ id: 'tr-1', name: '序列 1', clips: [solid('red', '#ff0000')] }],
  cuts: [
    { id: 'cut-1', name: '剪辑1' },
    { id: 'cut-2', name: '剪辑2', t: 1, duration: 4, transitions: [], tracks: [{ id: 'tr-2', name: '序列 1', clips: [solid('blue', '#0000ff')] }] },
  ],
  activeCutId: 'cut-1',
});

/* ---------- 工具 ---------- */
const json = async (url, init) => {
  const res = await fetch(url, init);
  return { status: res.status, ok: res.ok, body: await res.json().catch(() => null) };
};
const postJson = (url, body) => json(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
async function until(label, fn, timeoutMs = 120000, everyMs = 300) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let v;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() > deadline) { fails.push(`超时:${label}`); console.log(`FAIL 超时:${label}`); return null; }
    await delay(everyMs);
  }
}
function viteBin() {
  const local = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  if (fs.existsSync(local)) return local;
  const main = createRequire(import.meta.url).resolve('vite');
  const at = main.lastIndexOf(`${path.sep}vite${path.sep}`);
  return path.join(main.slice(0, at + 6), 'bin', 'vite.js');
}
/** 经本机 MCP 入口调一个工具(和 server/mcp-server.mjs 转过来的同一条路) */
const callTool = (tool, args) => postJson(`${EDITOR}/api/mcp/call`, { tool, args });
/** 画面中心那个像素 + 存图 */
function centerOf(result, file) {
  const b64 = result?.__image?.base64;
  if (!b64) return null;
  const buf = Buffer.from(b64, 'base64');
  fs.writeFileSync(path.join(OUT, file), buf);
  const png = PNG.sync.read(buf);
  const i = ((png.height >> 1) * png.width + (png.width >> 1)) * 4;
  return { r: png.data[i], g: png.data[i + 1], b: png.data[i + 2], a: png.data[i + 3], w: png.width, h: png.height, file: path.join(OUT, file) };
}
const isBlue = (p) => !!p && p.b > 200 && p.r < 60 && p.g < 60;
const isRed = (p) => !!p && p.r > 200 && p.g < 60 && p.b < 60;

let editor = null;
const editorLog = [];
let browser = null;
function cleanup() {
  try { if (fs.existsSync(CARD_FILE)) fs.unlinkSync(CARD_FILE); } catch { /* 尽力 */ }
  if (KEEP) return;
  if (editor && editor.exitCode === null && editor.pid) {
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(editor.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else editor.kill('SIGKILL');
  }
}

const out = { port: PORT, out: OUT };
try {
  editor = spawn(process.execPath, [viteBin(), '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      env: { ...process.env, PROMPTCUT_EXPORT_DIR: EXPORT_DIR, PROMPTCUT_DATA_DIR: DATA_DIR, PROMPTCUT_NO_PORT_FILE: '1' } });
  const keep = (c) => { editorLog.push(c.toString()); if (editorLog.length > 400) editorLog.shift(); };
  editor.stdout.on('data', keep);
  editor.stderr.on('data', keep);
  await until('编辑器进程起来', async () => (await fetch(`${EDITOR}/api/prerender/info`).then((r) => r.ok, () => false)) || null, 180000);
  const prerender = await until('预渲染进程就绪', async () => { const i = await json(`${EDITOR}/api/prerender/info`); return i.body?.ready && i.body.url ? i.body.url : null; }, 240000);
  if (!prerender) throw new Error('预渲染进程没起来');

  /* ================= A 镜像那条路 ================= */
  const PA = project('cut-look-A');
  const pushed = await postJson(`${EDITOR}/api/data/project`, { session: 'cut-look-A', localRev: 1, project: PA });
  await postJson(`${EDITOR}/api/data/playhead`, { session: 'cut-look-A', t: 2, playing: false });
  check('A0', pushed.ok && pushed.body?.ok, '项目推进数据镜像', pushed.body);
  const before = await json(`${EDITOR}/api/data/project`);

  const a1 = await callTool('see_frames', { source: 'timeline', cutId: 'cut-2' });
  const a1px = centerOf(a1.body?.result, 'A1-cut2.png');
  check('A1', a1.body?.ok && isBlue(a1px) && a1.body.result?.cut?.id === 'cut-2' && a1.body.result.cut.name === '剪辑2',
    '镜像那条路:激活剪辑1,see_frames 带剪辑2 的 cutId,出的是剪辑2(蓝);回包写明剪辑2', { px: a1px, cut: a1.body?.result?.cut, t: a1.body?.result?.t, error: a1.body?.error });
  const afterA = await json(`${EDITOR}/api/data/project`);
  check('A2', afterA.body?.localRev === before.body?.localRev && afterA.body?.project?.activeCutId === 'cut-1' && JSON.stringify(afterA.body?.project) === JSON.stringify(before.body?.project),
    '镜像那条路:数据镜像的版本号与项目都没变,activeCutId 仍是剪辑1', { before: before.body?.localRev, after: afterA.body?.localRev, active: afterA.body?.project?.activeCutId });
  const a3 = await callTool('see_frames', { source: 'timeline', t: 1 });
  const a3px = centerOf(a3.body?.result, 'A3-cut1.png');
  check('A3', a3.body?.ok && isRed(a3px) && a3.body.result?.cut?.id === 'cut-1', '镜像那条路:不带 cutId,出的是剪辑1(红)', { px: a3px, cut: a3.body?.result?.cut, error: a3.body?.error });
  const a4 = await callTool('see_frames', { source: 'timeline', cutId: 'cut-9' });
  check('A4', a4.body?.ok === false && /找不到剪辑 "cut-9"/.test(a4.body?.error ?? '') && /剪辑2\(cut-2\)/.test(a4.body?.error ?? ''), 'cutId 不存在:明确报错并列出现有的剪辑', { error: a4.body?.error });

  /* ================= B 编辑器页面 + 项目副本那条路 ================= */
  browser = await puppeteer.launch({ headless: true, args: [...PROBE_CHROME_ARGS, '--no-first-run', '--force-device-scale-factor=1'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('dialog', (d) => { void d.dismiss(); });
  await page.goto(`${EDITOR}/?editor&nosetup=1`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
  await page.waitForFunction(() => !!window.__pcStore, { timeout: 120_000 });
  await delay(3000);
  const PB = project(`cut-look-B-${Date.now().toString(36)}`);
  await page.evaluate((p) => { window.__pcStore.actions.loadProject(p); window.__pcStore.actions.seek(0.5); }, PB);
  const bound = await until('页面绑上项目副本', async () => {
    const s = await json(`${EDITOR}/api/agent/status`);
    return s.body?.bound && s.body.projectId === PB.id && s.body.link?.replica?.hasBody === true ? s.body : null;
  }, 90_000, 500);
  out.bound = bound ? { mode: bound.mode, projectId: bound.projectId, rev: bound.link?.replica?.rev ?? null } : null;
  check('B0', !!bound, '编辑台把项目写进本机文档服务并绑定了项目副本(Agent 服务端在副本上执行)', out.bound);
  await page.evaluate(() => { window.__probeProjectRef = window.__pcStore.getState().project; });
  // 副本的版本号与 Agent 一侧提交过几次(`agent-exec.mjs` 的 describe):看画面前后都不该变
  const revOf = async () => { const s = await json(`${EDITOR}/api/agent/status`); return { rev: s.body?.link?.replica?.rev ?? null, committed: s.body?.stats?.committed ?? null }; };
  const rev0 = await revOf();

  const b1 = await callTool('see_frames', { source: 'timeline', cutId: 'cut-2' });
  const b1px = centerOf(b1.body?.result, 'B1-cut2.png');
  check('B1', b1.body?.ok && isBlue(b1px) && b1.body.result?.cut?.id === 'cut-2', '副本那条路:带剪辑2 的 cutId,出的是剪辑2(蓝)', { px: b1px, cut: b1.body?.result?.cut, rev: b1.body?.result?.rev, error: b1.body?.error });
  const pageState = await page.evaluate(() => {
    const s = window.__pcStore.getState();
    return { same: s.project === window.__probeProjectRef, active: s.project.activeCutId, t: s.t };
  });
  const rev1 = await revOf();
  check('B2', pageState.same && pageState.active === 'cut-1' && Math.abs(pageState.t - 0.5) < 1e-6 && Number.isInteger(rev0.rev) && rev1.rev === rev0.rev && rev1.committed === rev0.committed && b1.body?.result?.rev === rev0.rev,
    '副本那条路:页面 store 里的项目是同一个对象、激活剪辑仍是剪辑1、播放头没动;文档服务版本号没变(没有写入)', { ...pageState, rev0, rev1 });
  const b3 = await callTool('see_frames', { source: 'timeline', t: 1 });
  const b3px = centerOf(b3.body?.result, 'B3-cut1.png');
  check('B3', b3.body?.ok && isRed(b3px) && b3.body.result?.cut?.id === 'cut-1', '副本那条路:不带 cutId,出的是剪辑1(红)', { px: b3px, cut: b3.body?.result?.cut, error: b3.body?.error });

  const { tools } = await import('../../server/mcp-tools.mjs');
  const names = new Set(tools.map((t) => t.name));
  check('B4', !names.has('switch_cut') && names.has('user_interface_switch_cut') && !!tools.find((t) => t.name === 'see_frames')?.inputSchema?.properties?.cutId,
    '工具清单:没有旧名 switch_cut,有 user_interface_switch_cut;see_frames 收 cutId');
  out.pageErrors = pageErrors.slice(0, 5);
} catch (e) {
  fails.push(`异常:${e?.stack ?? e}`);
  console.log('FAIL 异常', e?.stack ?? e);
  out.editorLogTail = editorLog.slice(-30).join('').slice(-3000);
} finally {
  try { await browser?.close(); } catch { /* 已关 */ }
  cleanup();
  if (!KEEP) { try { fs.rmSync(EXPORT_DIR, { recursive: true, force: true }); } catch { /* 子进程可能还占着 */ } }
}
console.log(JSON.stringify({ ok: fails.length === 0, fails, out, results }));
process.exit(fails.length ? 1 : 0);
