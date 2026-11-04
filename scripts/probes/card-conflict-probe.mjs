/**
 * UI acceptance check for the "Card source" row in the conflict merge window (branch
 * claude/conflict-merge).
 *
 *   node scripts/probes/card-conflict-probe.mjs [--port 5890] [--doc-port 5896] [--out out/conflict-merge]
 *
 * 1. Real card source sync (`server/card-sync.mjs`, two "editor process" instances each having a
 *    temporary project root, file operations use real card installation and backup from
 *    `vite-plugin-cards.ts`) against in-process document service (content store): while A is
 *    disconnected it edits a user card, B edits the same card online → when A reconnects,
 *    sync emits `conflict` (with both copies of source code);
 * 2. Start an isolated editor (this branch, data directory in temporary directory), pass this
 *    notice to the page: this is the same entry point as delivered via HMR from the editor process
 *    (`receiveCardSyncNotice` in `cardSync.ts`; in dev mode via `__pcSyncTest.cardNotice`);
 * 3. Inspect the row for that card and the secondary "Source" view in the "Conflict merge" window,
 *    take a screenshot; then click "Delete selected" (keep cloud state), list is cleared, take a
 *    screenshot.
 * Do not click "Merge": that would make this editor write the card into `src/cards/user/` of this
 * repository. Rules for "Merge" are covered against real document service by T8-8 in
 * `server/test/card-sync.test.mjs`.
 * The last line of the result is a line of JSON.
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
  for (;;) { let v = null; try { v = await fn(); } catch { v = null; } if (v) return v; if (Date.now() - t0 > ms) { fails.push(`Timed out waiting for: ${what}`); return null; } await sleep(100); }
}

const KEY = 'src/cards/user/price-tag.tsx';
const cardSource = (text) => `import { motion } from "motion/react";
import type { CardDef, CardProps } from "../../kernel/types";
interface Params { text: string }
function C({ params }: CardProps<Params>) {
  return <motion.div animate={{ opacity: 1 }}>{params.text}</motion.div>;
}
export const priceTag: CardDef<Params> = {
  id: "price-tag", name: "Price", description: "d", source: "user",
  frameMode: "stateful",
  defaults: { text: "${text}" },
  controls: [{ key: "text", label: "Text", type: "text" }],
  Component: C,
};
`;

const temps = [];
let editor = null, browser = null, service = null;
const syncs = [];
try {
  /* ---------------- 1. Real card source sync generates a conflict ---------------- */
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
  A.write(cardSource('Original price')); A.bind();
  await until('A connected', () => A.sync.status().connected); await A.sync.idle();
  B.bind();
  await until('B synced', () => fs.existsSync(path.join(B.root, KEY))); await B.sync.idle();
  A.sync.unbind('offline');
  A.write(cardSource('Price edited by A while offline\n// Comment line added by A\n'));
  B.write(cardSource('Price edited by B while online')); B.sync.saved(KEY); await B.sync.idle();
  A.bind();
  const notice = await until('A received conflict', () => A.notices.find((n) => n.type === 'conflict'));
  out.steps.notice = notice && { type: notice.type, key: notice.key, rev: notice.rev, mineHas: /Price edited by A while offline/.test(notice.mine), cloudHas: /Price edited by B while online/.test(notice.cloud), backup: notice.backup };
  check(notice && out.steps.notice.mineHas && out.steps.notice.cloudHas, 'Real card sync emits conflict (with both source versions)', out.steps.notice);

  /* ---------------- 2. Isolated editor ---------------- */
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-card-conflict-editor-'));
  temps.push(dataDir);
  const require = createRequire(import.meta.url);
  const vite = path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js');
  editor = spawn(process.execPath, [vite, '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: reopenEditorEnv(dataDir, { PROMPTCUT_PUSH: '0', PROMPTCUT_LAN_HOST: '0', PROMPTCUT_AUTO_RENDER_NODE: '0', PROMPTCUT_QUEUE_NODE: '0' }) });
  editor.stdout.resume(); editor.stderr.resume();
  await until('editor started', () => fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false), 180_000);
  browser = await puppeteer.launch({ headless: true, defaultViewport: { width: 1600, height: 900 }, args: [...PROBE_CHROME_ARGS, '--no-first-run', '--window-position=-32000,-32000'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e?.message ?? e)));
  await page.goto(`http://127.0.0.1:${PORT}/?editor`, { waitUntil: 'domcontentloaded' });
  await until('page sync connected', () => page.evaluate(() => window.__pcSyncTest?.view().status === 'online'), 120_000);
  await until('Editor appears, measurement overlay dismissed', () => page.evaluate(() => !!document.querySelector('[data-pc="editor"]') && !document.querySelector('[data-pc="probe-gate"]')), 240_000);
  await sleep(1500);
  // The "Select AI assistant" dialog on first open pops up a bit later and covers the window:
  // wait for it to appear (up to 8 seconds) and close it
  const closeAi = () => page.evaluate(() => { let n = 0; for (const b of document.querySelectorAll('.ais-dialog .ais-btn')) if (b.textContent?.trim() === 'Close') { b.click(); n++; } return n; });
  for (let i = 0; i < 16 && !(await closeAi()); i++) await sleep(500);
  // Wait for timeline to lay out (so the editor behind the window is visible in screenshot)
  await until('Timeline clips laid out', () => page.evaluate(() => [...document.querySelectorAll('[data-clip-id]')].some((e) => e.getBoundingClientRect().width > 0)), 120_000);
  await sleep(1000);

  /* ---------------- 3. That card in the window ---------------- */
  await page.evaluate((n) => window.__pcSyncTest.cardNotice(n), notice);
  const win = await until('Conflict merge window opened', () => page.$('[data-pc="conflict-merge"]'));
  await sleep(500);
  await page.evaluate(() => { for (const b of document.querySelectorAll('.pc-merge-expand')) if (b.getAttribute('aria-expanded') === 'false') b.click(); });
  await sleep(300);
  const row = await page.evaluate(() => {
    const li = document.querySelector('[data-pc="merge-thing"][data-key="offline:card:src/cards/user/price-tag.tsx"]');
    return li ? { head: li.querySelector('.pc-merge-thing-head')?.innerText.replace(/\s+/g, ' '), props: [...li.querySelectorAll('[data-pc="merge-prop"]')].map((p) => p.innerText.replace(/\s+/g, ' ').trim()) } : null;
  });
  out.steps.row = row;
  check(win && row && /Card source "cards\/user\/price-tag\.tsx"/.test(row.head) && /Has conflicts/.test(row.head), 'One row per card in the window, with conflicts', row);
  check(row && row.props.length === 1 && /^Source: my version has \d+ more lines and \d+ fewer lines than the current cloud version \(the cloud version is now one that someone else edited\)/.test(row.props[0]), 'Second level is "Source"', row);
  out.steps.navButton = await page.evaluate(() => document.querySelector('[data-pc="conflict-merge-open"]')?.innerText ?? null);
  await closeAi(); await sleep(300);
  out.steps.aiDialogLeft = await page.evaluate(() => !!document.querySelector('.ais-dialog'));
  await page.screenshot({ path: path.join(OUT, 'desktop-7-card-conflict.png') });
  // Do not check "Select non-conflicting items"; check the parent level → "Delete selected":
  // keep cloud state (local is already the cloud version), list is cleared
  await page.evaluate(() => document.querySelector('[data-pc="merge-select-clean"]')?.click());
  out.steps.afterSelectClean = await page.evaluate(() => document.querySelectorAll('[data-pc="merge-prop"] input:checked').length);
  check(out.steps.afterSelectClean === 0, '"Select items without conflicts" does not tick card conflicts');
  await page.evaluate(() => document.querySelector('[data-pc="merge-thing"][data-key="offline:card:src/cards/user/price-tag.tsx"] [data-pc="merge-thing-check"]')?.click());
  await sleep(200);
  await page.evaluate(() => document.querySelector('[data-pc="merge-delete"]')?.click());
  const done = await until('list cleared', () => page.evaluate(() => document.querySelector('[data-pc="merge-close"]')?.textContent?.trim() === 'Done'));
  check(!!done, 'After deleting the selection the close button becomes "Done"');
  await closeAi(); await sleep(200);
  await page.screenshot({ path: path.join(OUT, 'desktop-8-card-conflict-cleared.png') });
  out.steps.pageErrors = errors;
  check(errors.length === 0, 'No errors on the page', errors);
} catch (e) {
  fails.push(`Exception: ${e?.stack ?? e}`);
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
