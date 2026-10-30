/**
 * 冲突合并窗口里「卡片源码」那一行的界面验收(分支 claude/conflict-merge)。
 *
 *   node scripts/probes/card-conflict-probe.mjs [--port 5890] [--doc-port 5896] [--out out/conflict-merge]
 *
 * 1. 真的卡片源码同步(`server/card-sync.mjs`,两份「编辑器进程」各有临时项目根,文件操作用 `vite-plugin-cards.ts` 的真实装卡与备份)
 *    对着进程内的文档服务(内容库):A 断开期间改了一张用户卡、B 在线改了同一张 → A 连回时同步发出 `conflict`(带两份源码);
 * 2. 起一个隔离的编辑器(本分支,数据目录在临时目录),把这条提示交给页面 —— 和编辑器进程经 HMR 送来的是同一个入口
 *    (`cardSync.ts` 的 `receiveCardSyncNotice`;开发模式经 `__pcSyncTest.cardNotice`);
 * 3. 看「冲突合并」窗口里那张卡的一行与「源码」二级,截图;再「删除选中」(保留云端现状),列表清空、截图。
 * 不点「合并」:那会让这台编辑器把卡写进本仓库的 `src/cards/user/`。「合并」的规则由 `server/test/card-sync.test.mjs` T8-8 对着真文档服务覆盖。
 * 结果最后一行是一行 JSON。
 */
import '../lib/no-user-dirs.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { reopenEditorEnv } from './reopen-editor-env.mjs';
import { createDocService } from '../../server/docservice/service.mjs';
import { contentModule } from '../../server/docservice/modules/content.mjs';
import { createMemoryStore } from '../../server/docservice/store/index.mjs';
import { createWsEndpoint } from '../../server/render-node/ws-transport.mjs';
import { createCardSync } from '../../server/card-sync.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = Number(arg('--port', 5890));
const DOC_PORT = Number(arg('--doc-port', 5896));
const OUT = path.resolve(arg('--out', path.join(ROOT, 'out', 'conflict-merge')));
fs.mkdirSync(OUT, { recursive: true });
const cards = await import('../../server/vite-plugin-cards.ts');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
const out = { ok: false, steps: {} };
const check = (c, label, extra) => { if (!c) fails.push(label + (extra === undefined ? '' : ` :: ${JSON.stringify(extra).slice(0, 300)}`)); return !!c; };
async function until(what, fn, ms = 20_000) {
  const t0 = Date.now();
  for (;;) { let v = null; try { v = await fn(); } catch { v = null; } if (v) return v; if (Date.now() - t0 > ms) { fails.push(`等不到:${what}`); return null; } await sleep(100); }
}

const KEY = 'src/cards/user/price-tag.tsx';
const cardSource = (text) => `import { motion } from "motion/react";
import type { CardDef, CardProps } from "../../kernel/types";
interface Params { text: string }
function C({ params }: CardProps<Params>) {
  return <motion.div animate={{ opacity: 1 }}>{params.text}</motion.div>;
}
export const priceTag: CardDef<Params> = {
  id: "price-tag", name: "价格", description: "d", source: "user",
  frameMode: "stateful",
  defaults: { text: "${text}" },
  controls: [{ key: "text", label: "文字", type: "text" }],
  Component: C,
};
`;

const temps = [];
let editor = null, browser = null, service = null;
const syncs = [];
try {
  /* ---------------- 1. 真的卡片源码同步产生一条 conflict ---------------- */
  service = createDocService({
    log: () => {},
    authenticate: (req) => { const q = new URL(req.url ?? '/', 'http://localhost').searchParams; return { userId: q.get('user') ?? 'u', deviceId: `dev-${q.get('user')}`, role: 'page', tenantId: 't-card' }; },
    modules: [contentModule({ store: createMemoryStore() })],
  });
  await service.listen(DOC_PORT, '127.0.0.1');
  const url = (u) => `ws://127.0.0.1:${DOC_PORT}/?user=${u}`;
  const ed = (name) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `pc-card-conflict-${name}-`));
    temps.push(root);
    fs.mkdirSync(path.join(root, 'src', 'cards', 'user'), { recursive: true });
    const notices = [];
    const sync = createCardSync({
      stateDir: path.join(root, '.pc-work', 'card-sync'),
      files: {
        read: (rel) => { try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return null; } },
        changed: (rel) => fs.existsSync(path.join(root, rel)),
        backup: (rel, content) => cards.backupBeforeEdit(root, rel, content),
        install: (rel, source) => { const r = cards.installSyncedFile({ root, historyDir: path.join(root, '.pc-work', 'card-history'), rel, source, existingIds: [] }); return { ok: r.ok, error: r.error }; },
      },
      connect: ({ url: u, protocols }) => createWsEndpoint({ url: u, protocols, backoff: { baseMs: 50, maxMs: 200 } }),
      notify: (e) => notices.push(e),
    });
    syncs.push(sync);
    const write = (c) => fs.writeFileSync(path.join(root, KEY), c);
    return { root, sync, notices, write, bind: () => sync.bind({ projectId: 'p-card', url: url(name), local: false, keys: [KEY], protocols: () => ['promptcut.v1'] }) };
  };
  const A = ed('alice'), B = ed('bob');
  A.write(cardSource('原来的价格')); A.bind();
  await until('A 连上', () => A.sync.status().connected); await A.sync.idle();
  B.bind();
  await until('B 同步到', () => fs.existsSync(path.join(B.root, KEY))); await B.sync.idle();
  A.sync.unbind('offline');
  A.write(cardSource('甲断网时改的价格\n// 甲加的一行注释\n'));
  B.write(cardSource('乙在线改的价格')); B.sync.saved(KEY); await B.sync.idle();
  A.bind();
  const notice = await until('A 收到 conflict', () => A.notices.find((n) => n.type === 'conflict'));
  out.steps.notice = notice && { type: notice.type, key: notice.key, rev: notice.rev, mineHas: /甲断网时改的价格/.test(notice.mine), cloudHas: /乙在线改的价格/.test(notice.cloud), backup: notice.backup };
  check(notice && out.steps.notice.mineHas && out.steps.notice.cloudHas, '真实卡片同步发出 conflict(带两份源码)', out.steps.notice);

  /* ---------------- 2. 隔离的编辑器 ---------------- */
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-card-conflict-editor-'));
  temps.push(dataDir);
  const require = createRequire(import.meta.url);
  const vite = path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js');
  editor = spawn(process.execPath, [vite, '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: reopenEditorEnv(dataDir, { PROMPTCUT_PUSH: '0', PROMPTCUT_LAN_HOST: '0', PROMPTCUT_AUTO_RENDER_NODE: '0', PROMPTCUT_QUEUE_NODE: '0' }) });
  editor.stdout.resume(); editor.stderr.resume();
  await until('编辑器起来', () => fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false), 180_000);
  browser = await puppeteer.launch({ headless: true, defaultViewport: { width: 1600, height: 900 }, args: [...PROBE_CHROME_ARGS, '--no-first-run', '--window-position=-32000,-32000'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e?.message ?? e)));
  await page.goto(`http://127.0.0.1:${PORT}/?editor`, { waitUntil: 'domcontentloaded' });
  await until('页面同步接上', () => page.evaluate(() => window.__pcSyncTest?.view().status === 'online'), 120_000);
  await until('编辑器界面出来、测量遮罩退下', () => page.evaluate(() => !!document.querySelector('[data-pc="editor"]') && !document.querySelector('[data-pc="probe-gate"]')), 240_000);
  await sleep(1500);
  // 第一次打开的「选择 AI 助手」对话框会晚一点冒出来、盖住窗口:等它出来(最多 8 秒)就关掉
  const closeAi = () => page.evaluate(() => { let n = 0; for (const b of document.querySelectorAll('.ais-dialog .ais-btn')) if (b.textContent?.trim() === '关闭') { b.click(); n++; } return n; });
  for (let i = 0; i < 16 && !(await closeAi()); i++) await sleep(500);
  // 等时间轴排出来(截图里能看到窗口背后的编辑器)
  await until('时间轴片段排出来', () => page.evaluate(() => [...document.querySelectorAll('[data-clip-id]')].some((e) => e.getBoundingClientRect().width > 0)), 120_000);
  await sleep(1000);

  /* ---------------- 3. 窗口里那张卡 ---------------- */
  await page.evaluate((n) => window.__pcSyncTest.cardNotice(n), notice);
  const win = await until('冲突合并窗口打开', () => page.$('[data-pc="conflict-merge"]'));
  await sleep(500);
  await page.evaluate(() => { for (const b of document.querySelectorAll('.pc-merge-expand')) if (b.getAttribute('aria-expanded') === 'false') b.click(); });
  await sleep(300);
  const row = await page.evaluate(() => {
    const li = document.querySelector('[data-pc="merge-thing"][data-key="offline:card:src/cards/user/price-tag.tsx"]');
    return li ? { head: li.querySelector('.pc-merge-thing-head')?.innerText.replace(/\s+/g, ' '), props: [...li.querySelectorAll('[data-pc="merge-prop"]')].map((p) => p.innerText.replace(/\s+/g, ' ').trim()) } : null;
  });
  out.steps.row = row;
  check(win && row && /卡片源码「cards\/user\/price-tag\.tsx」/.test(row.head) && /有冲突/.test(row.head), '窗口里一张卡一条、有冲突', row);
  check(row && row.props.length === 1 && /^源码：我这边的版本比云端现在的多 \d+ 行、少 \d+ 行（云端现在是别人改过的版本）/.test(row.props[0]), '二级是「源码」', row);
  out.steps.navButton = await page.evaluate(() => document.querySelector('[data-pc="conflict-merge-open"]')?.innerText ?? null);
  await closeAi(); await sleep(300);
  out.steps.aiDialogLeft = await page.evaluate(() => !!document.querySelector('.ais-dialog'));
  await page.screenshot({ path: path.join(OUT, 'desktop-7-card-conflict.png') });
  // 「选中无冲突项」不勾它;勾上一级 →「删除选中」:保留云端现状(本机已经是云端的版本),列表清空
  await page.evaluate(() => document.querySelector('[data-pc="merge-select-clean"]')?.click());
  out.steps.afterSelectClean = await page.evaluate(() => document.querySelectorAll('[data-pc="merge-prop"] input:checked').length);
  check(out.steps.afterSelectClean === 0, '「选中无冲突项」不勾卡片冲突');
  await page.evaluate(() => document.querySelector('[data-pc="merge-thing"][data-key="offline:card:src/cards/user/price-tag.tsx"] [data-pc="merge-thing-check"]')?.click());
  await sleep(200);
  await page.evaluate(() => document.querySelector('[data-pc="merge-delete"]')?.click());
  const done = await until('列表清空', () => page.evaluate(() => document.querySelector('[data-pc="merge-close"]')?.textContent?.trim() === '完成'));
  check(!!done, '删除选中后关闭按钮变「完成」');
  await closeAi(); await sleep(200);
  await page.screenshot({ path: path.join(OUT, 'desktop-8-card-conflict-cleared.png') });
  out.steps.pageErrors = errors;
  check(errors.length === 0, '页面没有报错', errors);
} catch (e) {
  fails.push(`异常:${e?.stack ?? e}`);
} finally {
  await browser?.close().catch(() => {});
  for (const s of syncs) { try { s.close(); } catch {} }
  await service?.close().catch(() => {});
  if (editor?.pid) spawnSync('taskkill', ['/PID', String(editor.pid), '/T', '/F'], { windowsHide: true });
  for (const t of temps) { try { fs.rmSync(t, { recursive: true, force: true }); } catch {} }
}
out.ok = fails.length === 0;
out.fails = fails;
out.shots = [path.join(OUT, 'desktop-7-card-conflict.png'), path.join(OUT, 'desktop-8-card-conflict-cleared.png')];
console.log(JSON.stringify(out));
process.exit(out.ok ? 0 : 1);
