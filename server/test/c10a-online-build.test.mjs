/**
 * C10a 在线构建与 `/api` 静态检查（`docs/plan/c10a-contract.md` 第 2 节，第 12 节「`/api` 守卫：在线构建里没有 `/api/` 请求」）。
 * 跑：node --test server/test/c10a-online-build.test.mjs
 *
 *   C10A-API-01 `src/online/mode.ts` 与契约第 2 节逐字节相同（两个实现分支各建一份，集成时不冲突）；
 *   C10A-API-02 `vite build --mode online` 成功：`base: '/editor/'`，index.html 只引 `/editor/assets/…`；
 *   C10A-API-03 产物里没有以 `/api/` 开头的地址字面量（守卫本身判前缀用的 `"/api/"` 不算：后面紧跟地址的才算请求）；
 *   C10A-API-04 桌面构建照旧（缺省 base `/`），不受在线模式影响；
 *   C10-MERGE-01 顶栏「⋯ → 合并 Skill 结果…」在线构建里置灰（C10 契约第 10 节〔裁〕，2026-09-28）：在线产物里这一项
 *                `disabled` 为真、悬停说明是「在线浏览器模式暂不支持合并 Skill 结果…」，桌面说明不在产物里；桌面产物照旧。
 *                这一项的开关是编译期常量（`TopBar.tsx` 的 `ONLINE_BUILD`），Node 里渲染不出在线态，所以就对产物核。
 *   C10-CATALOG-01/02 在线构建的 `catalog/` 与 `server/catalog/<kind>/index.json` 登记的 Lottie、粒子条目一一对应、逐字节相同；桌面构建不带。
 *   C10A-API-05 云端 Agent 服务（`docs/plan/cloud-agent-contract.md` 10.3 节）：在线产物里以 `/agent/` 开头的地址字面量只有 `/agent/v1` 一种，且确实有（AI 栏打它）；
 *   C10A-API-07 在线产物里没有桌面专用的标识：`/api/mcp/events`、`/api/ai/setup`、`/api/chats/`、`PROMPTCUT_AGENT`、`/api/ai/diagnostics`（03 已覆盖路径类，这一条补非路径的与点名的），且带云端对话的诊断报告；
 *   C10A-API-08 桌面产物里也带云端 AI 栏（桌面版项目放云端时多一项「云端」）：有 `/agent/v1` 以外的地址来自文档服务下发，产物里没有写死的云节点地址。
 * 运行期（真浏览器里的网络记录）见 `scripts/probes/c10a-online-probe.mjs`；守卫本身见 `src/online/c10a-api-guard.test.mjs`。
 *
 * 构建用 vite 的 JS 接口，产物写进临时目录，不碰 `dist/`、`dist-online/`。`src/online/mode.ts` 不在时整组 skip。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { exists, skipIf, repoPath, tempDir, ROOT, apiLiterals, apiPaths, ONLINE_API_RATCHET_FILE } from './c10a-kit.mjs';

const missing = !exists('src/online/mode.ts');
const skip = skipIf(missing, 'src/online/mode.ts and the online build');
const it = (name, opts, fn) => test(name, { skip, ...opts }, fn);

/** 契约第 2 节「判定模块」的原文（两行） */
const MODE_TS = [
  '/** Online browser mode: turned on by the online build (c10a-contract.md section 2). Desktop runtime environments (desktop app, local dev server) are always false. */',
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
 * 〔裁，主会话 2026-09-27〕原断言「0 处」改成棘轮：集成时产物里已有的 `/api/` 路径进清单（`c10a-kit.mjs` 的
 * `ONLINE_API_RATCHET_FILE`），这里断言产物里的路径 ⊆ 清单，新出现的判红。这些路径在运行时都被守卫拦下
 * （`c10a-api-guard.test.mjs`、探针的网络记录 0 条）；逐个置灰或换在线替代归 C10 其余，做掉一个就从清单删一个。
 * M8 遗留 L24（2026-09-28）起清单与产物须逐条一致：产物里已经没有的路径留在清单里同样判红，清单不会悄悄变宽。
 */
it('C10A-API-03 the /api/ paths in the online build bundle match the ratchet manifest entry by entry (new ones and surplus manifest entries both fail)', { timeout: 240_000 }, async () => {
  await buildOnline();
  const ratchet = JSON.parse(fs.readFileSync(repoPath(ONLINE_API_RATCHET_FILE), 'utf8'));
  const allowed = new Set(ratchet.paths);
  const found = apiPaths(onlineDir);
  const fresh = found.filter((p) => !allowed.has(p));
  const hits = apiLiterals(onlineDir).filter((h) => fresh.some((p) => h.context.includes(p)));
  assert.deepEqual(fresh, [], `${fresh.length} new /api/ paths appeared in the online build (not in manifest ${ONLINE_API_RATCHET_FILE}): ${JSON.stringify(hits.slice(0, 10), null, 1)}`);
  // /api/account/ 这一族只有闭源侧（cloud/src/account/client.ts、cloud/online/apiGuard.ts）会写进产物；
  // 社区版没有 cloud/，构建里本来就没有它们，不算「清单里多余」。新出现的路径（上面那条）两边都照样判红
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
 * C10-TITLEBAR-01 在线构建里整条标题栏不画（2026-10-22 用户定，原话「浏览器版不需要『显示顶部菜单栏』和『放大缩小关闭』
 * 三个无用的按钮」「桌面版要有」）。这一条取代了 C10 契约第 10 节 2026-09-28 那条〔裁〕「在线标题栏菜单同顶栏、桌面项置灰」：
 * 菜单在在线页面上已经不存在，置灰无从谈起。在线产物里菜单行、窗口按钮（− □ ×）、桌面壳命令都应剪掉；
 * 菜单里在线还用得上的七项不许丢——五项在顶栏原有按钮上（导出视频、首页、撤销、重做、皮肤…），
 * 「快捷键」「关于 PromptCut」挪进顶栏「⋯」菜单（`TopBar.tsx`，`data-pc` 为 more-shortcuts / more-about）。
 * 桌面构建照旧：菜单项都在、不置灰、没有在线的悬停说明、桌面壳命令与窗口按钮还在，且不重复「⋯」里那两项。
 * 开关是编译期常量，就对产物核。
 */
const TITLEBAR_DESKTOP_ONLY = ['new-project', 'open-project', 'save-project', 'open-export', 'open-data', 'quit', 'open-voice', 'open-pylibs', 'open-models', 'reset-pylibs', 'open-logs'];
const TITLEBAR_ALWAYS = ['export-video', 'go-home', 'undo', 'redo', 'open-skin', 'shortcuts', 'about'];

/** 产物里标题栏菜单项按钮的属性段（`titlebar-${…}` 那个元素，到它的 children 为止） */
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

/** 从标题栏菜单挪进顶栏「⋯」菜单的两项（只在在线构建里出现） */
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
 * C10-CATALOG-01 在线构建带上动效素材目录（`server/online-catalog.mjs`）：卡片参数里的 `/catalog/<kind>/<name>.json` 在桌面由开发服务器的
 * 中间件提供，在线由构建产出到 `dist-online/catalog/`、托管端 nginx 在 `/catalog/` 下提供。产物里的文件与 index.json 登记的条目一一对应
 * （不多不少、逐字节相同），登记的 url 就是产物里的路径；index.json 本身不产出（页面在构建时 import 它，运行时不读）。
 * 桌面构建照旧不带 catalog/（桌面由中间件按 index.json 放行）。
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
 * 云端 Agent 服务的通道（`docs/plan/cloud-agent-contract.md` 10.1～10.3 节）：在线页面的 AI 栏打同源的 `/agent/v1/*`，不是编辑器进程的 `/api/*`。
 * 守卫与棘轮清单一条不加（C10A-API-03 已守）；这里补「/agent/ 只有一种前缀」与「桌面专用的非路径标识不进在线产物」。
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
  // 云端对话的诊断报告在页面里生成、浏览器下载(用户 2026-10-07 定):诊断报告的窗口在在线产物里,走本机编辑器写盘的那条路被剪掉
  assert.ok(text.includes('Cloud chat diagnostic report'), 'the online bundle includes the cloud chat diagnostic report');
});

it('C10A-API-08 the desktop bundle has no hardcoded cloud node address: the Cloud Agent\'s address is issued by the document service', { timeout: 240_000 }, async () => {
  await buildDesktop();
  const text = bundleText(desktopDir);
  assert.ok(text.includes('Runs in the cloud and continues after you close it'), 'the desktop bundle includes the cloud AI panel');
  assert.equal(/https?:\/\/[^"'`\s]*\/agent\/v1/.test(text), false, 'the desktop bundle should not hardcode a cloud node\'s /agent/v1 address');
});
