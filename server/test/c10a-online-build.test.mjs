/**
 * C10a online build and `/api` static check (`docs/plan/c10a-contract.md` Section 2, Section 12
 * "`/api` guard: no `/api/` requests in online build").
 * Run: node --test server/test/c10a-online-build.test.mjs
 *
 *   C10A-API-01 `src/online/mode.ts` is byte-for-byte identical to contract Section 2 (one copy
 *                created in each of two implementation branches, no conflict during integration);
 *   C10A-API-02 `vite build --mode online` succeeds: `base: '/editor/'`, index.html only references
 *                `/editor/assets/…`;
 *   C10A-API-03 No address literals starting with `/api/` in artifacts (`"/api/"` used by guard to
 *                check prefixes does not count: only immediately followed by address counts as request);
 *   C10A-API-04 Desktop build as before (default base `/`), unaffected by online mode;
 *   C10-MERGE-01 Top bar "⋯ → Merge Skill results…" grayed out in online build (C10 contract
 *                Section 10 [ruling], 2026-09-28): in online artifacts this item has `disabled`
 *                true, hover description is "Online browser mode does not yet support merging Skill
 *                results…", desktop description not in artifacts; desktop artifacts as before.
 *                The toggle for this item is a compile-time constant (`ONLINE_BUILD` in `TopBar.tsx`);
 *                Node cannot render online state, so check against artifacts directly.
 *   C10-CATALOG-01/02 Online build `catalog/` corresponds one-to-one and byte-for-byte with Lottie
 *                and particle entries registered in `server/catalog/<kind>/index.json`; desktop
 *                build does not include them.
 *   C10A-API-05 Cloud Agent service (`docs/plan/cloud-agent-contract.md` Section 10.3): address
 *                literals in online artifacts starting with `/agent/` have only `/agent/v1`, and it
 *                definitely exists (AI panel hits it);
 *   C10A-API-07 Online artifacts contain no desktop-only identifiers: `/api/mcp/events`,
 *                `/api/ai/setup`, `/api/chats/`, `PROMPTCUT_AGENT`, `/api/ai/diagnostics` (03 already
 *                covered path types, this adds non-path and named ones), and include diagnostic report
 *                for cloud chat;
 *   C10A-API-08 Desktop artifacts also include cloud AI panel (desktop app adds "Cloud" option when
 *                project is moved to the cloud): addresses other than `/agent/v1` come dispatched
 *                from document service; no hardcoded cloud node addresses in artifacts.
 * Runtime (network logs in real browser) see `scripts/probes/c10a-online-probe.mjs`; guard itself
 * see `src/online/c10a-api-guard.test.mjs`.
 *
 * Build uses vite JS API, writes artifacts to temporary directory, without touching `dist/` or
 * `dist-online/`. Skip entire suite when `src/online/mode.ts` is missing.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { exists, skipIf, repoPath, tempDir, ROOT, apiLiterals, apiPaths, ONLINE_API_RATCHET_FILE } from './c10a-kit.mjs';

const missing = !exists('src/online/mode.ts');
const skip = skipIf(missing, 'src/online/mode.ts and the online build');
const it = (name, opts, fn) => test(name, { skip, ...opts }, fn);

/** Original text (two lines) of "Decision module" in Section 2 of the contract */
const MODE_TS = [
  '/** 在线浏览器模式：由在线构建打开（c10a-contract.md 第 2 节）。桌面运行环境（桌面版、本机 dev server）恒为 false。 */', // i18n-allow
  'export const ONLINE: boolean = import.meta.env.VITE_PC_ONLINE === "1";',
];

const OUT = tempDir('pc-c10a-build-');
after(() => fs.rmSync(OUT, { recursive: true, force: true }));

async function viteBuild(mode, outDir) {
  const { build } = await import('vite');
  const prevCwd = process.cwd();
  process.chdir(ROOT);
  try {
    await build({ root: ROOT, mode, logLevel: 'error', build: { outDir, emptyOutDir: true, reportCompressedSize: false } });
  } finally {
    process.chdir(prevCwd);
  }
}

it('C10A-API-01 src/online/mode.ts is byte-for-byte identical to contract section 2 (line breaks not counted)', {}, () => {
  const text = fs.readFileSync(repoPath('src/online/mode.ts'), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(text.replace(/\n+$/, ''), MODE_TS.join('\n'));
});

const onlineDir = path.join(OUT, 'dist-online');
let built = null;
const buildOnline = () => (built ??= viteBuild('online', onlineDir));

it('C10A-API-02 vite build --mode online succeeds: base is /editor/, and index.html only references /editor/assets/', { timeout: 240_000 }, async () => {
  await buildOnline();
  const html = fs.readFileSync(path.join(onlineDir, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]).filter((u) => !/^(https?:|data:|#)/.test(u));
  assert.ok(refs.length > 0, 'index.html does not reference any resources');
  for (const u of refs) assert.ok(u.startsWith('/editor/'), `index.html references an address outside /editor/: ${u}`);
  assert.ok(refs.some((u) => u.startsWith('/editor/assets/') && u.endsWith('.js')), `the entry script is under /editor/assets/: ${refs.join(', ')}`);
  assert.ok(fs.existsSync(path.join(onlineDir, 'assets')), 'the bundle has assets/');
});

/*
 * [ruling, lead session 2026-09-27] Original assertion "0 occurrences" changed to ratchet: `/api/`
 * paths already in artifacts during integration enter manifest (`ONLINE_API_RATCHET_FILE` in
 * `c10a-kit.mjs`); here asserts paths in artifacts ⊆ manifest, flagging new ones red. These paths
 * are all intercepted by the guard at runtime (`c10a-api-guard.test.mjs`, probe network log has
 * 0 entries); graying out or replacing with online alternatives one by one belongs to the rest of
 * C10; delete from manifest once resolved.
 * From M8 legacy L24 (2026-09-28) onward, manifest and artifacts must match item by item: paths no
 * longer in artifacts remaining in manifest are also flagged red, so manifest cannot silently widen.
 */
it('C10A-API-03 the /api/ paths in the online build bundle match the ratchet manifest entry by entry (new ones and surplus manifest entries both fail)', { timeout: 240_000 }, async () => {
  await buildOnline();
  const ratchet = JSON.parse(fs.readFileSync(repoPath(ONLINE_API_RATCHET_FILE), 'utf8'));
  const allowed = new Set(ratchet.paths);
  const found = apiPaths(onlineDir);
  const fresh = found.filter((p) => !allowed.has(p));
  const hits = apiLiterals(onlineDir).filter((h) => fresh.some((p) => h.context.includes(p)));
  assert.deepEqual(fresh, [], `${fresh.length} new /api/ paths appeared in the online build (not in manifest ${ONLINE_API_RATCHET_FILE}): ${JSON.stringify(hits.slice(0, 10), null, 1)}`);
  // The /api/account/ family is only written into artifacts by the closed-source side
  // (cloud/src/account/client.ts, cloud/online/apiGuard.ts);
  // community edition has no cloud/, so builds inherently lack them, not counted as
  // "redundant in manifest". Newly appearing paths (rule above) are still flagged red on both sides.
  const hasCloud = fs.existsSync(path.join(ROOT, 'cloud'));
  const gone = ratchet.paths.filter((p) => !found.includes(p) && (hasCloud || !p.startsWith('/api/account/')));
  assert.deepEqual(gone, [], `the manifest has ${gone.length} paths that are no longer in the bundle, remove them from ${ONLINE_API_RATCHET_FILE}: ${gone.join(', ')}`);
});

const desktopDir = path.join(OUT, 'dist-desktop');
let builtDesktop = null;
const buildDesktop = () => (builtDesktop ??= viteBuild('production', desktopDir));

it('C10A-API-04 the desktop build is unchanged: base is /, unaffected by online mode', { timeout: 240_000 }, async () => {
  const dir = desktopDir;
  await buildDesktop();
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  assert.match(html, /(?:src|href)="\/assets\/[^"]+\.js"/, 'the desktop build\'s entry script is under /assets/');
  assert.equal(html.includes('/editor/'), false);
});

/** The translation table chunk holds every interface string, including ones this build prunes */
const isTranslationTable = (f) => /^i18n-[\w-]+\.js$/.test(f);
const walkBundle = (dir) => fs.readdirSync(path.join(dir, 'assets')).filter((f) => f.endsWith('.js') && !isTranslationTable(f)).map((f) => path.join(dir, 'assets', f));

it('C10-MERGE-01 "Merge Skill results…" is archived along with the SKILL three-way merge (plan agent-workflow-plan.md A4): neither the online nor the desktop bundle has this item', { timeout: 240_000 }, async () => {
  await buildOnline();
  await buildDesktop();
  for (const dir of [onlineDir, desktopDir]) {
    const hit = walkBundle(dir).find((f) => /menu-merge-skill|Merge Skill results/.test(fs.readFileSync(f, 'utf8')));
    assert.equal(hit, undefined, `the bundle in ${dir} still contains "Merge Skill results": ${hit}`);
  }
});

/*
 * C10-TITLEBAR-01 Entire title bar is not rendered in online build (user decision, 2026-10-22,
 * exact words: "browser edition does not need the three useless buttons 'show top menu bar' and
 * 'maximize minimize close'", "desktop app must have them"). This supersedes the 2026-09-28 [ruling]
 * in Section 10 of C10 contract "online title bar menu matches top bar, desktop items grayed out":
 * the menu no longer exists on the online page, so graying out is moot. In online artifacts, the
 * menu row, window buttons (− □ ×), and desktop shell commands should all be trimmed; the seven menu
 * items still needed online must not be lost: five are on existing top bar buttons ("Export video",
 * "Home", "Undo", "Redo", "Skin"…), and "Shortcuts" and "About PromptCut" are moved into top bar "⋯"
 * menu (`TopBar.tsx`, `data-pc` is more-shortcuts / more-about).
 * Desktop build as before: menu items all present, not grayed out, no online hover descriptions,
 * desktop shell commands and window buttons still present, and does not duplicate those two items in "⋯".
 * The toggle is a compile-time constant, so check against artifacts directly.
 */
const TITLEBAR_DESKTOP_ONLY = ['new-project', 'open-project', 'save-project', 'open-export', 'open-data', 'quit', 'open-voice', 'open-pylibs', 'open-models', 'reset-pylibs', 'open-logs'];
const TITLEBAR_ALWAYS = ['export-video', 'go-home', 'undo', 'redo', 'open-skin', 'shortcuts', 'about'];

/** Attribute section of title bar menu item button in artifacts (that `titlebar-${…}` element, up to its children) */
function titlebarItemProps(dir) {
  for (const file of walkBundle(dir)) {
    const text = fs.readFileSync(file, 'utf8');
    const at = text.indexOf('titlebar-${');
    if (at < 0) continue;
    return { text, props: text.slice(Math.max(0, text.lastIndexOf('{', at)), text.indexOf('children', at)) };
  }
  return null;
}
const menuEntry = (text, cmd) => text.match(new RegExp(`command:[\`"']${cmd}[\`"'][^}]*}`))?.[0] ?? null;
const bundleText = (dir) => walkBundle(dir).map((f) => fs.readFileSync(f, 'utf8')).join('\n');

/** Two items moved from title bar menu into top bar "⋯" menu (only appear in online build) */
const TITLEBAR_MOVED = ['more-shortcuts', 'more-about'];

it('C10-TITLEBAR-01 the online build removes both the title bar menu row and the window buttons without losing any of the seven functions; the desktop build is unchanged', { timeout: 240_000 }, async () => {
  await buildOnline();
  const onText = bundleText(onlineDir);
  assert.equal(titlebarItemProps(onlineDir), null, 'the online bundle should not contain title bar menu items (titlebar-${…})');
  assert.equal(/pc-titlebar-menu-button/.test(onText), false, 'the online bundle should not contain the title bar menu row');
  assert.equal(/pc-titlebar-window-controls|toggleMaximize/.test(onText), false, 'the online bundle should not contain window buttons (− □ ×)');
  assert.equal(onText.includes('desktop_titlebar_command'), false, 'the online bundle should not contain desktop shell commands');
  for (const mark of TITLEBAR_MOVED) assert.ok(onText.includes(mark), `the online bundle does not contain ${mark}, which was moved into the "⋯" menu`);

  await buildDesktop();
  const desk = titlebarItemProps(desktopDir);
  assert.ok(desk, 'the desktop bundle does not contain the title bar menu items');
  const d = desk.props.match(/disabled:([A-Za-z_$][\w$]*|!0|!1|true|false)(?=[,}])/);
  assert.ok(d, `in the desktop bundle, disabled should be a constant false: ${desk.props}`);
  const falsy = d[1] === '!1' || d[1] === 'false' || new RegExp(`(^|[^\\w$])${d[1].replace(/\$/g, '\\$')}=(!1|false)(?![\\w$])`).test(desk.text);
  assert.ok(falsy, `title bar menu items in the desktop bundle should not be grayed out: ${d[1]}`);
  assert.equal(desk.props.includes('onlineUnsupported'), false, `the desktop bundle should not contain the online hover tooltip: ${desk.props}`);
  const deskText = bundleText(desktopDir);
  for (const cmd of [...TITLEBAR_DESKTOP_ONLY, ...TITLEBAR_ALWAYS]) assert.ok(menuEntry(deskText, cmd), `the desktop bundle does not contain title bar menu item ${cmd}`);
  assert.ok(deskText.includes('desktop_titlebar_command'), 'desktop shell commands in the desktop bundle are unchanged');
  assert.ok(/pc-titlebar-window-controls/.test(deskText), 'window buttons in the desktop bundle are unchanged');
  for (const mark of TITLEBAR_MOVED) assert.equal(deskText.includes(mark), false, `the desktop "⋯" menu should not duplicate ${mark}`);
});

/*
 * C10-CATALOG-01 Online build includes motion graphics asset catalog (`server/online-catalog.mjs`):
 * `/catalog/<kind>/<name>.json` in card parameters is served on desktop by dev server middleware,
 * and online is output by build to `dist-online/catalog/`, served under `/catalog/` by hosted side nginx.
 * Files in artifacts correspond one-to-one with entries registered in index.json (neither more nor
 * less, byte-for-byte identical), registered url is path in artifacts; index.json itself is not output
 * (page imports it at build time and does not read it at runtime).
 * Desktop build does not include catalog/ as before (desktop allowed through by middleware according
 * to index.json).
 */
const CATALOG_KINDS = ['lottie', 'particles'];
const catalogIndex = (kind) => JSON.parse(fs.readFileSync(repoPath(`server/catalog/${kind}/index.json`), 'utf8'));
const listFiles = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).map((d) => path.relative(dir, path.join(d.parentPath ?? d.path, d.name)).split(path.sep).join('/')).sort() : []);

it('C10-CATALOG-01 catalog/ in the online build matches the Lottie and particle entries registered in index.json one to one, byte for byte', { timeout: 240_000 }, async () => {
  await buildOnline();
  const want = [];
  for (const kind of CATALOG_KINDS) {
    const items = catalogIndex(kind).items;
    assert.ok(items.length > 0, `${kind}/index.json has no entries`);
    for (const it of items) {
      assert.equal(it.url, `/catalog/${kind}/${it.name}.json`, `the url registered for ${kind}/${it.name} does not match the bundle path`);
      want.push(`${kind}/${it.name}.json`);
    }
  }
  const got = listFiles(path.join(onlineDir, 'catalog'));
  assert.deepEqual(got, [...want].sort(), 'the files in dist-online/catalog/ should match the entries registered in index.json one to one');
  for (const rel of want) {
    const a = fs.readFileSync(path.join(onlineDir, 'catalog', rel));
    const b = fs.readFileSync(repoPath(`server/catalog/${rel}`));
    assert.ok(a.equals(b), `catalog/${rel} and server/catalog/${rel} are not byte-for-byte identical`);
  }
});

it('C10-CATALOG-02 the desktop build still ships without catalog/ (the desktop gets it from the dev server\'s /catalog middleware)', { timeout: 240_000 }, async () => {
  await buildDesktop();
  assert.equal(fs.existsSync(path.join(desktopDir, 'catalog')), false);
});

/*
 * Cloud Agent service channel (`docs/plan/cloud-agent-contract.md` Sections 10.1-10.3): AI panel on
 * online pages hits same-origin `/agent/v1/*`, not editor process `/api/*`.
 * Not a single entry added to guard and ratchet manifest (already guarded by C10A-API-03);
 * here complements "/agent/ has only one prefix" and "desktop-only non-path identifiers do not enter
 * online artifacts".
 */
const agentLiterals = (text) => [...new Set([...text.matchAll(/["'`](\/agent\/[^"'`\s]*)["'`]/g)].map((m) => m[1]))];

it('C10A-API-05 the only address literal starting with /agent/ in the online bundle is /agent/v1', { timeout: 240_000 }, async () => {
  await buildOnline();
  const lits = agentLiterals(bundleText(onlineDir));
  assert.deepEqual(lits, ['/agent/v1'], `addresses starting with /agent/ in the online bundle: ${lits.join(', ')}`);
});

it('C10A-API-07 the online bundle contains no desktop-only identifiers', { timeout: 240_000 }, async () => {
  await buildOnline();
  const text = bundleText(onlineDir);
  for (const id of ['/api/mcp/events', '/api/ai/setup', '/api/chats/', 'PROMPTCUT_AGENT', '/api/ai/diagnostics']) assert.equal(text.includes(id), false, `the online bundle should not contain ${id}`);
  // Cloud chat diagnostic reports are generated in the page and downloaded by the browser
  // (user decision, 2026-10-07): the diagnostic report window is in the online build artifacts,
  // and the path writing to disk via the local editor was cut
  assert.ok(text.includes('Cloud chat diagnostic report'), 'the online bundle includes the cloud chat diagnostic report');
});

it('C10A-API-08 the desktop bundle has no hardcoded cloud node address: the Cloud Agent\'s address is issued by the document service', { timeout: 240_000 }, async () => {
  await buildDesktop();
  const text = bundleText(desktopDir);
  assert.ok(text.includes('Runs in the cloud and continues after you close it'), 'the desktop bundle includes the cloud AI panel');
  assert.equal(/https?:\/\/[^"'`\s]*\/agent\/v1/.test(text), false, 'the desktop bundle should not hardcode a cloud node\'s /agent/v1 address');
});
