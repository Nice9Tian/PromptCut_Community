/**
 * 用户卡与改动层的端到端探针(报告 `docs/archive/agent-reports/AGENT-card-overlay.md`):一个带改动层的编辑器(装机版的样子),
 * 核对「有改动层时检出目录一个文件都不写」与「create_card 带 overwrite 不被改动层旧版盖住」在真 Vite 里成立。
 *
 * 用法(在仓库根或 worktree 根):
 *   node scripts/probes/card-overlay-probe.mjs [--port 5610] [--out <截图目录>] [--keep-temp]
 *
 * 做什么:
 *   1. 临时目录里建改动层(PROMPTCUT_CARD_OVERRIDES)与数据目录;改动层里先放一张检出里没有的用户卡 A(记号 a1),
 *      检出里放一张用户卡 B 的底版(b1)、改动层里放 B 的改过版(b1x);
 *   2. 在本检出根起一个编辑器(vite --port,舞台端口 +1、+2;卡片同步关掉);
 *   3. 页面里核对:注册表里有 A(源码 a1)与 B(源码 b1x);`/api/cards/source` 读得到 A;
 *   4. create_card 带 overwrite 把 B 改成 b2:注册表热更新到 b2,B 的底版仍是 b1(CO1);
 *   5. create_card 建一张新卡 C(c1):写进改动层,检出目录不多文件;注册表热更新出 C,主框架不整页刷新(CO2);
 *      归属表写进改动层,检出里的 `_scopes.json` 不变;
 *   6. 删掉改动层里的 A:注册表里 A 消失;
 *   7. 收尾:只结束自己起的进程树;删 B 的底版、它在 .pc-work/card-history 的旧版;还原检出里的 `_scopes.json`;临时目录缺省删掉。
 *
 * 输出:过程写 stderr;stdout 只有最后一行 JSON:{ ok, ..., fails: [] }。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR,产物不落进用户的 Videos\PromptCut
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};
const PORT = Number(arg('--port', '5610'));
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.resolve(arg('--out', path.join(ROOT, 'out', 'card-overlay-probe')));
fs.mkdirSync(OUT, { recursive: true });

const say = (step, fields = {}) => process.stderr.write(`${JSON.stringify({ step, t: Date.now(), ...fields })}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, what) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`等 ${what} 超时(${ms} ms)`);
    await sleep(100);
  }
}

const RUN = Date.now().toString(36);
const ID = { a: `ov-a-${RUN}`, b: `ov-b-${RUN}`, c: `ov-c-${RUN}` };
const MARK = (v) => `OV-PROBE-${RUN}-${v}`;
const USER = 'src/cards/user';
const cardSource = (id, v) => `import "../../kernel/remotionStyle";
import type { CardDef, CardProps } from "../../kernel/types";
interface Params { text: string }
function C({ params }: CardProps<Params>) {
  return <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 64, color: "#fff", background: "#243" }}>{"${MARK(v)}"} {params.text}</div>;
}
export const card: CardDef<Params> = {
  id: "${id}", name: "改动层探针", description: "card-overlay-probe", source: "user",
  frameMode: "direct",
  defaults: { text: "" },
  controls: [{ key: "text", label: "文字", type: "text" }],
  Component: C,
};
`;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-card-overlay-probe-'));
const OVERLAY = path.join(TMP, 'card-overrides');
const DATA = path.join(TMP, 'data');
fs.mkdirSync(DATA, { recursive: true });
const SCOPES = path.join(ROOT, USER, '_scopes.json');
const scopesBefore = fs.existsSync(SCOPES) ? fs.readFileSync(SCOPES) : null;
const B_BASE = path.join(ROOT, USER, `${ID.b}.tsx`);
const userDirList = () => fs.readdirSync(path.join(ROOT, USER)).sort();
const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

const procs = [];
const fails = [];
const navigations = [];
const res = { runId: RUN, ids: ID, port: PORT };

function viteBin() {
  const local = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  if (fs.existsSync(local)) return local;
  const main = createRequire(import.meta.url).resolve('vite');
  const at = main.lastIndexOf(`${path.sep}vite${path.sep}`);
  return path.join(main.slice(0, at + 6), 'bin', 'vite.js');
}

async function stopAll() {
  for (const p of procs.reverse()) {
    const c = p.child;
    if (!c.pid || c.exitCode !== null) continue;
    const exited = new Promise((r) => c.once('exit', r));
    // 编辑器还拉着预渲染进程和 Chrome:连进程树一起结束(只结束自己起的这一棵)
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else c.kill('SIGKILL');
    await Promise.race([exited, sleep(10_000)]);
    say('stopped', { name: p.name, pid: c.pid });
  }
}

const P = (page, fn, ...args) => page.evaluate(fn, ...args);
/** 页面里注册表的样子:这几张卡在不在、注册表里的源码带哪个记号 */
const registry = (page) => P(page, async (ids, marks) => {
  await import('/src/cards/index.ts');
  const R = await import('/src/kernel/registry.ts');
  const u = R.userCardSources();
  const out = {};
  for (const [k, id] of Object.entries(ids)) {
    const file = u.fileOf[id];
    const src = file ? u.files[file] ?? '' : '';
    out[k] = { card: !!R.getCard(id), mark: marks.find((m) => src.includes(m)) ?? null };
  }
  return out;
}, ID, ['a1', 'b1x', 'b1', 'b2', 'c1'].map(MARK).sort((x, y) => y.length - x.length));
const markOf = (m) => (m ? m.slice(`OV-PROBE-${RUN}-`.length) : null);

let browser = null;
try {
  // ---------- 1. 改动层与检出里的探针卡
  put(path.join(OVERLAY, USER, `${ID.a}.tsx`), cardSource(ID.a, 'a1'));
  put(B_BASE, cardSource(ID.b, 'b1'));
  put(path.join(OVERLAY, USER, `${ID.b}.tsx`), cardSource(ID.b, 'b1x'));
  const listBefore = userDirList();

  // ---------- 2. 编辑器
  const child = spawn(process.execPath, [viteBin(), '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    env: {
      ...process.env,
      PROMPTCUT_DATA_DIR: DATA,
      PROMPTCUT_CARD_OVERRIDES: OVERLAY,
      PROMPTCUT_CARD_SYNC: '0',
      PROMPTCUT_PUSH: '0',
      PROMPTCUT_LAN_HOST: '',
      PROMPTCUT_DEVICE_ID: `cardoverlay-${RUN}`.padEnd(16, '0'),
      PROMPTCUT_DEVICE_NAME: 'card-overlay-probe',
    },
  });
  const log = [];
  const keep = (c) => { log.push(c.toString()); if (log.length > 400) log.shift(); };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  procs.push({ name: 'editor', child });
  say('spawn', { pid: child.pid });
  const origin = `http://127.0.0.1:${PORT}`;
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`编辑器退出了:${log.join('').slice(-600)}`);
    return fetch(`${origin}/`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false);
  }, 180_000, '编辑器起来');

  browser = await puppeteer.launch({
    headless: true,
    defaultViewport: { width: 1440, height: 900 },
    args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1'],
  });
  const page = await browser.newPage();
  page.on('pageerror', (e) => say('pageerror', { message: String(e?.message ?? e).slice(0, 300) }));
  page.on('dialog', (d) => void d.dismiss());
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) navigations.push({ at: Date.now(), url: f.url() }); });
  await page.goto(`${origin}/?editor`, { waitUntil: 'domcontentloaded' });

  // ---------- 3. 起来时:改动层里的 A、改过的 B 都在注册表里
  const r0 = await waitFor(async () => { const r = await registry(page); return r.a.card && r.b.card ? r : null; }, 120_000, '注册表认出 A、B');
  res.start = { a: markOf(r0.a.mark), b: markOf(r0.b.mark) };
  if (markOf(r0.a.mark) !== 'a1') fails.push('start-a-not-a1');
  if (markOf(r0.b.mark) !== 'b1x') fails.push('start-b-not-overlay');
  const srcA = await fetch(`${origin}/api/cards/source?id=${ID.a}`).then((r) => r.json()).catch(() => null);
  res.sourceA = !!srcA?.ok && String(srcA.source ?? '').includes(MARK('a1'));
  if (!res.sourceA) fails.push('api-source-a');
  const navBase = navigations.length;
  await page.screenshot({ path: path.join(OUT, `${RUN}-0-start.png`) });

  const create = (id, source, overwrite) => P(page, async (body) => {
    const r = await fetch('/api/cards/create', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  }, { id, source, overwrite, projectId: `probe-${RUN}` });

  // ---------- 4. CO1:create_card 带 overwrite 改 B
  const t1 = Date.now();
  const cb = await create(ID.b, cardSource(ID.b, 'b2'), true);
  res.overwrite = { status: cb.status, overwritten: cb.body?.overwritten ?? null };
  if (cb.status !== 200) fails.push(`overwrite-status-${cb.status}:${cb.body?.error ?? ''}`);
  const r1 = await waitFor(async () => { const r = await registry(page); return markOf(r.b.mark) === 'b2' ? r : null; }, 15_000, '注册表里 B 变成 b2').catch(() => null);
  res.overwriteHmrMs = r1 ? Date.now() - t1 : null;
  if (!r1) fails.push('overwrite-not-effective');
  if (fs.readFileSync(B_BASE, 'utf8') !== cardSource(ID.b, 'b1')) fails.push('b-base-changed');
  const srcB = await fetch(`${origin}/api/cards/source?id=${ID.b}`).then((r) => r.json()).catch(() => null);
  if (!String(srcB?.source ?? '').includes(MARK('b2'))) fails.push('api-source-b-not-b2');

  await page.screenshot({ path: path.join(OUT, `${RUN}-1-after-overwrite.png`) });

  // ---------- 5. CO2:create_card 建新卡 C
  const t2 = Date.now();
  const cc = await create(ID.c, cardSource(ID.c, 'c1'), false);
  res.create = { status: cc.status };
  if (cc.status !== 200) fails.push(`create-status-${cc.status}:${cc.body?.error ?? ''}`);
  const r2 = await waitFor(async () => { const r = await registry(page); return r.c.card && markOf(r.c.mark) === 'c1' ? r : null; }, 15_000, '注册表认出 C').catch(() => null);
  res.createHmrMs = r2 ? Date.now() - t2 : null;
  if (!r2) fails.push('new-card-not-registered');
  res.overlayHasC = fs.existsSync(path.join(OVERLAY, USER, `${ID.c}.tsx`));
  if (!res.overlayHasC) fails.push('c-not-in-overlay');
  const listAfter = userDirList();
  res.checkoutUserDir = { before: listBefore.length, after: listAfter.length, added: listAfter.filter((f) => !listBefore.includes(f)) };
  if (res.checkoutUserDir.added.length) fails.push('checkout-user-dir-written');
  const scopesNow = fs.existsSync(SCOPES) ? fs.readFileSync(SCOPES) : null;
  res.checkoutScopesUnchanged = scopesBefore === null ? scopesNow === null : !!scopesNow && scopesNow.equals(scopesBefore);
  if (!res.checkoutScopesUnchanged) fails.push('checkout-scopes-written');
  const overlayScopes = path.join(OVERLAY, USER, '_scopes.json');
  res.overlayScopesHasC = fs.existsSync(overlayScopes) && !!JSON.parse(fs.readFileSync(overlayScopes, 'utf8'))[ID.c];
  if (!res.overlayScopesHasC) fails.push('overlay-scopes-missing-c');
  await page.screenshot({ path: path.join(OUT, `${RUN}-2-after-create.png`) });
  // 舞台(iframe,舞台端口)里画得出只在改动层里的 C
  const clipId = await P(page, async (id) => {
    const S = await import('/src/store/project.ts');
    const c = S.actions.addCardClip(id, 0, { duration: 5 });
    S.actions.seek(1);
    return c?.id ?? null;
  }, ID.c).catch(() => null);
  const stageHas = async (text) => {
    for (const f of page.frames()) {
      if (f === page.mainFrame()) continue;
      try { if (await f.evaluate((t) => document.body?.innerText?.includes(t) ?? false, text)) return f.url(); } catch { /* 跨源或正在导航 */ }
    }
    return null;
  };
  res.stageC = clipId ? await waitFor(() => stageHas(MARK('c1')), 60_000, '舞台画出 C').catch(() => null) : null;
  if (!res.stageC) fails.push('stage-c-not-drawn');
  await page.screenshot({ path: path.join(OUT, `${RUN}-3-stage.png`) });

  // ---------- 6. 删掉改动层里的 A
  fs.rmSync(path.join(OVERLAY, USER, `${ID.a}.tsx`));
  const r3 = await waitFor(async () => { const r = await registry(page); return !r.a.card ? r : null; }, 15_000, '注册表里 A 消失').catch(() => null);
  if (!r3) fails.push('a-not-removed');
  res.fullReloads = navigations.length - navBase;
  if (res.fullReloads !== 0) fails.push('page-full-reload');
  const errs = log.join('').split('\n').filter((l) => /error/i.test(l) && l.includes(RUN)).slice(0, 5);
  if (errs.length) res.serverErrors = errs;
} catch (e) {
  fails.push(`error:${e?.message ?? e}`);
} finally {
  try { await browser?.close(); } catch { /* 已关 */ }
  await stopAll();
  try { fs.rmSync(B_BASE, { force: true }); } catch { /* 没有就算了 */ }
  try {
    const hist = path.join(ROOT, '.pc-work', 'card-history');
    for (const f of fs.existsSync(hist) ? fs.readdirSync(hist) : []) if (f.includes(RUN)) fs.rmSync(path.join(hist, f), { force: true });
  } catch { /* 没有就算了 */ }
  try {
    if (scopesBefore === null) fs.rmSync(SCOPES, { force: true });
    else if (!fs.readFileSync(SCOPES).equals(scopesBefore)) fs.writeFileSync(SCOPES, scopesBefore);
  } catch { /* 还原不了记在输出里 */ }
  if (!argv.includes('--keep-temp')) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* Windows 上偶有句柄没放 */ } }
}
res.fails = fails;
res.ok = fails.length === 0;
process.stdout.write(`${JSON.stringify(res)}\n`);
process.exit(res.ok ? 0 : 1);
