/**
 * 游客进别人的项目（只读权限）时编辑界面的只读呈现探针（2026-10-23 用户定：游客一律只读，界面要一眼看出改不了）。
 * 真 Chrome（puppeteer），编辑台 `?editor&aimock=1&nosetup=1`。「只读权限」用 `io/viewOnly.ts` 的 `setProjectAccess('r')` 拨，
 * 再借同步管理的一次状态通知让界面重渲（真实路径是 syncManager 进项目时拨，见 `src/editor/readOnly.ts`）。
 *
 * 用法：
 *   node scripts/probes/guest-readonly-ui-probe.mjs [--port 5243] [--out out/guest-readonly-ui-probe] [--origin http://127.0.0.1:N] [--keep]
 * 端口分到 5240～5249；缺省自己起一台编辑器（舞台占 +1、+2），跑完收掉。`--origin` 改用外面现成的。
 *
 * 验收（每项一行 JSON，最后一行 summary，有失败退出码 1）：
 *   R0 读写（没进共享项目）：撤销可点、「序列」可点、素材导入可点、时间轴片段有拖把手、行头按钮可点、预览三个工具都可点、
 *      输入区能发（编辑框与发送可用）、参数面板（选中片段后）控件可点——一切照旧，没有只读标记。
 *   R1 切成只读：<html> 带 data-pc-readonly=member，顶栏徽标「只能查看」且悬停是 viewOnlyText()。
 *   R2 时间轴：行头静音 / 隐藏 / 锁定、「+ 序列」、「新建剪辑」置灰且悬停是那一句；片段没有拖把手；实际拖一个片段、按 Delete、
 *      点右键：项目内容不变（右键只有一行灰字说明）；点一下仍能选中。
 *   R3 参数面板：选中片段后「编辑」分区里开始 / 结束、换卡下拉、参数控件全部禁用；代码页文本框只读、能选中。
 *   R4 素材库与动画：导入按钮置灰；卡片格不可拖（draggable=false）、点一下不会往时间轴加片段、悬停是那一句。
 *   R5 预览：移动、文字工具置灰（选择可用）；播放 / 暂停照常；导出照常可点。
 *   R6 右栏 Agent：编辑框、发送、预设按钮禁用，占位文字是那一句；没有引导动画。
 *   R7 顶栏：撤销 / 重做置灰；改名点不开；「项目」菜单里保存、打包保存置灰、「项目设置…」能打开但设置项禁用、「确定」置灰。
 *   R8 ?observe=1 那条老路没变：徽标仍是「只读查看」，保存置灰，而新加的这些锁都没有（「+ 序列」、输入区、参数控件照常可用）。
 *   R9 切回读写：上面各项恢复可点，<html> 标记撤掉。
 *   M1～M3 手机版（`--mobile`：另起一台在线模式的开发服务，`?layout=mobile`）：顶栏下有一条说明（手机上没有悬停）、子导航栏整排置灰、撤销置灰、播放与导出照常；
 *      Agent 输入区换成说明；时间轴分页里点选后拖动卡片段不动（读写下会动，作对照）、对齐按钮置灰。
 * 截图写进 --out：ro-full.png、ro-timeline.png、ro-params.png、ro-agent.png、ro-library.png、ro-project-menu.png、ro-settings.png、
 *   rw-full.png、observe-full.png、ro-mobile.png、ro-mobile-agent.png。
 */
import '../lib/no-user-dirs.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { flagArg } from './probe-connect.mjs';
import { startDevServer, viteBin, waitHttp, killTree, REPO } from '../lib/dev-server.mjs';

const PORT = Number(flagArg('port', 5243));
if (PORT < 5240 || PORT > 5249) throw new Error(`端口 ${PORT} 不在分给本探针的 5240～5249 里`);
const MOBILE_PORT = Number(flagArg('mobile-port', 5246));
if (MOBILE_PORT < 5240 || MOBILE_PORT > 5247) throw new Error(`端口 ${MOBILE_PORT} 不在分给本探针的 5240～5249 里（要占连号三个）`);
const OUT = path.resolve(REPO, flagArg('out', 'out/guest-readonly-ui-probe'));
const KEEP = process.argv.includes('--keep');
const WITH_MOBILE = process.argv.includes('--mobile');
const GIVEN_ORIGIN = flagArg('origin', null);
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, ok, extra = {}) => {
  const r = { check: name, ok: !!ok, ...extra };
  results.push(r);
  console.log(JSON.stringify(r));
  return !!ok;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, what) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`等 ${what} 超时`);
    await sleep(150);
  }
}

let server = null;
let mobileServer = null;
let tmp = null;
let browser = null;
const serverEnv = () => ({
  PROMPTCUT_NO_PORT_FILE: '1',
  PROMPTCUT_PUSH: '0',
  PROMPTCUT_CHATS_DIR: path.join(tmp, 'chats'),
  PROMPTCUT_WORK_DIR: path.join(tmp, 'work'),
  PROMPTCUT_DATA_DIR: path.join(tmp, 'data'),
  PROMPTCUT_AI_CONFIG: path.join(tmp, 'ai.json'),
});
try {
  let origin = GIVEN_ORIGIN;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-guest-ro-'));
  if (!origin) {
    server = await startDevServer({ port: PORT, logFile: path.join(tmp, 'vite.log'), env: serverEnv() });
    origin = server.origin;
  }

  browser = await puppeteer.launch({
    headless: true,
    defaultViewport: { width: 1600, height: 1000 },
    args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--force-device-scale-factor=1'],
  });

  const openEditor = async (base, query, size = { width: 1600, height: 1000 }) => {
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.log('PAGEERROR', String(e?.message ?? e)));
    page.on('dialog', (d) => { void d.accept().catch(() => {}); });
    await page.setViewport(size);
    await page.goto(`${base}/${query}`, { waitUntil: 'domcontentloaded' });
    await waitFor(() => page.evaluate(() => !!window.__pcStore), 120_000, 'window.__pcStore');
    // 整页「正在测量卡片」遮罩在载入后约 2 秒才出现、约 3 秒后撤掉,撤掉之后每一刻重卡片还有沙漏:连续 7 秒没有遮罩才算稳(遮罩盖着时点击都落在遮罩上)
    let calm = 0;
    const t0 = Date.now();
    while (calm < 7000 && Date.now() - t0 < 120_000) {
      const measuring = await page.evaluate(() => document.body.innerText.includes('正在测量卡片')).catch(() => true);
      calm = measuring ? 0 : calm + 500;
      await sleep(500);
    }
    return page;
  };
  const shot = (page, name) => page.screenshot({ path: path.join(OUT, name) });

  /** 在页面里查一个元素的状态（取第一个看得见的） */
  const stateOf = (page, sel) => page.evaluate((sel) => {
    const el = [...document.querySelectorAll(sel)].find((n) => n.getClientRects().length > 0) ?? document.querySelector(sel);
    if (!el) return { found: false };
    const off = el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true' || !!el.closest('fieldset:disabled');
    return {
      found: true,
      off,
      disabled: el.matches(':disabled'),
      inDisabledFieldset: !!el.closest('fieldset:disabled'),
      aria: el.getAttribute('aria-disabled'),
      title: el.getAttribute('title') ?? '',
      readOnly: el.readOnly === true,
      draggable: el.draggable === true,
      placeholder: el.getAttribute('placeholder') ?? '',
      text: (el.textContent ?? '').trim().slice(0, 40),
    };
  }, sel);
  const countOf = (page, sel) => page.evaluate((sel) => document.querySelectorAll(sel).length, sel);
  const projectJson = (page) => page.evaluate(() => JSON.stringify(window.__pcStore.getState().project));
  const clipIds = (page) => page.evaluate(() => window.__pcStore.getState().project.tracks.flatMap((t) => t.clips.map((c) => c.id)));
  const clickVisible = async (page, sel) => {
    const ok = await page.evaluate((sel) => {
      const el = [...document.querySelectorAll(sel)].find((n) => n.getClientRects().length > 0);
      if (!el) return false;
      el.click();
      return true;
    }, sel);
    if (!ok) throw new Error(`点不到 ${sel}`);
  };
  // prefix:在线模式的开发服务把页面放在 /editor/ 下(vite.config.ts 的 base),模块路径跟着带上
  const setAccess = async (page, access, prefix = '') => {
    await page.evaluate(async (access, prefix) => {
      const vo = await import(`${prefix}/src/editor/io/viewOnly.ts`);
      vo.setProjectAccess(access);
      // 借同步管理的一次状态通知让界面重渲(真实路径是 syncManager 进 / 退项目时拨)
      const sm = await import(`${prefix}/src/editor/sync/syncManager.ts`);
      sm.pushToast('probe', 'info', 1);
    }, access, prefix);
    await sleep(500);
  };
  const WHY = (page, prefix = '') => page.evaluate(async (prefix) => (await import(`${prefix}/src/editor/io/viewOnly.ts`)).viewOnlyText(), prefix);
  /** 往时间轴第一条序列上扔一张卡(合成的 HTML5 拖放事件;真拖放 puppeteer 做不到):回「落点接了没有」和「多了几个片段」 */
  const tryDrop = (page) => page.evaluate(() => {
    const st = window.__pcStore.getState();
    const cardId = st.project.tracks.flatMap((t) => t.clips).find((c) => c.cardId)?.cardId;
    const row = document.querySelector('[data-track-id]');
    const rect = row.getBoundingClientRect();
    const count = () => window.__pcStore.getState().project.tracks.reduce((n, t) => n + t.clips.length, 0);
    const dt = new DataTransfer();
    dt.setData('application/x-promptcut-card', cardId);
    const mk = (type) => new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: rect.left + 2600, clientY: rect.top + 20 });
    const over = mk('dragover');
    row.dispatchEvent(over);
    const before = count();
    row.dispatchEvent(mk('drop'));
    return { cardId, accepted: over.defaultPrevented, added: count() - before, newTrackZone: document.querySelectorAll('[data-pc="new-track-zone"]').length };
  });

  /* ── R0 读写 ── */
  const page = await openEditor(origin, '?editor&aimock=1&nosetup=1');
  const ids = await clipIds(page);
  check('R0.has-clips', ids.length >= 3, { n: ids.length });
  // 做一笔编辑,撤销才有得点
  await page.evaluate((id) => window.__pcStore.actions.setClipParams(id, { probe: 1 }, { merge: true }), ids[0]);
  await sleep(300);
  const rw = {
    undo: await stateOf(page, '[data-pc="undo-btn"] button'),
    addTrack: await stateOf(page, '[data-pc="add-track"]'),
    media: await stateOf(page, '[data-pc-add="media"]'),
    rowBtn: await stateOf(page, '[data-pc-track-header] .pc-tl-row-acts button'),
    cutAdd: await stateOf(page, '[data-pc="cut-add"]'),
    composer: await stateOf(page, '[data-pc="ai-input"]'),
    tools: await page.evaluate(() => [...document.querySelectorAll('.pc-pv-tool')].map((b) => b.disabled)),
    rename: await stateOf(page, '.pc-projname--btn'),
  };
  const trimRw = await countOf(page, '.pc-clip-trim');
  check('R0.topbar-and-timeline-enabled', !rw.undo.off && !rw.addTrack.off && !rw.rowBtn.off && !rw.cutAdd.off && !rw.rename.off && rw.rename.aria === null && trimRw > 0, { rw, trimRw });
  check('R0.library-and-agent-enabled', !rw.media.off && !rw.composer.off && rw.tools.every((d) => d === false), { rw });
  check('R0.no-readonly-marker', (await page.evaluate(() => document.documentElement.dataset.pcReadonly ?? null)) === null && (await countOf(page, '[data-pc="viewonly-badge"]')) === 0);
  await page.evaluate((id) => window.__pcStore.actions.select([id]), ids[0]);
  await clickVisible(page, '[data-pc-rail="edit"]');
  await sleep(700);
  const rwParams = { start: await stateOf(page, '[data-pc="clip-start"]'), sw: await stateOf(page, '[data-pc="switch-card"]') };
  check('R0.params-enabled', rwParams.start.found && !rwParams.start.off && rwParams.sw.found && !rwParams.sw.off, { rwParams });
  await shot(page, 'rw-full.png');

  /* ── R1 切成只读 ── */
  await setAccess(page, 'r');
  const why = await WHY(page);
  await waitFor(() => page.evaluate(() => document.documentElement.dataset.pcReadonly === 'member'), 5000, 'html 只读标记');
  const badge = await stateOf(page, '[data-pc="viewonly-badge"]');
  check('R1.html-marker', (await page.evaluate(() => document.documentElement.dataset.pcReadonlyWhy)) === why && why.length > 5, { why });
  check('R1.badge', badge.found && badge.text === '只能查看' && badge.title === why, { badge });

  /* ── R2 时间轴 ── */
  const before = await projectJson(page);
  const hdr = await page.evaluate(() => [...document.querySelectorAll('[data-pc-track-header] .pc-tl-row-acts button')].map((b) => ({ d: b.disabled, t: b.title })));
  const addTrack = await stateOf(page, '[data-pc="add-track"]');
  const cutAdd = await stateOf(page, '[data-pc="cut-add"]');
  const trimRo = await countOf(page, '.pc-clip-trim');
  check('R2.row-buttons-off', hdr.length >= 6 && hdr.every((b) => b.d && b.t === why), { hdr: hdr.slice(0, 3) });
  check('R2.add-track-and-cut-off', addTrack.off && addTrack.title === why && cutAdd.off && cutAdd.title === why, { addTrack, cutAdd });
  check('R2.no-trim-handles', trimRo === 0, { trimRo });
  // 实际拖一个片段 / 按 Delete / 右键
  const box = await page.evaluate((id) => {
    const r = document.querySelector(`[data-clip-id="${id}"]`).getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, ids[1]);
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  await page.mouse.move(box.x + 120, box.y + 8, { steps: 8 });
  await page.mouse.up();
  await sleep(300);
  check('R2.drag-does-not-change-project', (await projectJson(page)) === before);
  const selected = await page.evaluate(() => window.__pcStore.getState().selection);
  check('R2.click-still-selects', selected.includes(ids[1]), { selected });
  await page.keyboard.press('Delete');
  await sleep(200);
  check('R2.delete-key-blocked', (await projectJson(page)) === before && (await clipIds(page)).length === ids.length);
  await page.mouse.click(box.x, box.y, { button: 'right' });
  await sleep(300);
  const menu = await page.evaluate(() => [...document.querySelectorAll('[data-pc="tl-ctxmenu"] .pc-tl-ctxmenu-item')].map((n) => ({ text: n.textContent.trim(), off: n.getAttribute('aria-disabled') === 'true' })));
  check('R2.context-menu-only-explains', menu.length >= 1 && menu.every((m) => m.off || m.text.startsWith('查看字幕')) && menu.some((m) => m.text === why), { menu });
  await shot(page, 'ro-timeline.png');
  await page.keyboard.press('Escape');
  await page.mouse.click(5, 5);
  // 往时间轴扔一张卡:落点不接、不加片段;「新建序列」落区也不画
  const dropRo = await tryDrop(page);
  check('R2.drop-refused', dropRo.cardId && dropRo.accepted === false && dropRo.added === 0 && dropRo.newTrackZone === 0, { dropRo });
  // 导入素材的函数本身也拦(拖放文件之类没盖到的路)
  const importErr = await page.evaluate(async () => {
    const { importMediaFiles } = await import('/src/editor/left/importAssets.ts');
    try { await importMediaFiles([new File(['x'], 'a.mp4', { type: 'video/mp4' })]); return null; } catch (e) { return String(e.message); }
  });
  check('R2.import-function-refuses', importErr === why, { importErr });

  /* ── R3 参数面板 ── */
  await page.evaluate((id) => window.__pcStore.actions.select([id]), ids[0]);
  await sleep(500);
  const p = {
    start: await stateOf(page, '[data-pc="clip-start"]'),
    end: await stateOf(page, '[data-pc="clip-end"]'),
    sw: await stateOf(page, '[data-pc="switch-card"]'),
  };
  const formControls = await page.evaluate(() => {
    const pane = document.querySelector('[data-pc="inspector"]');
    const els = [...pane.querySelectorAll('input, select, textarea, button')].filter((e) => e.getClientRects().length > 0 && !e.closest('[role="tablist"]') && !e.closest('.pc-lib-chips') && !e.matches('.pc-left-collapse'));
    return { total: els.length, off: els.filter((e) => e.disabled || e.closest('fieldset:disabled') || e.readOnly).length, enabled: els.filter((e) => !(e.disabled || e.closest('fieldset:disabled') || e.readOnly)).map((e) => e.outerHTML.slice(0, 90)) };
  });
  check('R3.header-fields-off', p.start.off && p.end.off && p.sw.off, { p });
  check('R3.all-form-controls-off', formControls.total > 3 && formControls.enabled.length === 0, formControls);
  await shot(page, 'ro-params.png');
  await page.evaluate(() => document.querySelector('[data-pc-tab="code"]').click());
  await sleep(400);
  const code = await stateOf(page, '[data-pc="code-editor"]');
  check('R3.code-readonly-but-selectable', code.found && code.readOnly && !code.disabled, { code });
  await page.evaluate(() => document.querySelector('[data-pc-tab="form"]').click());

  /* ── R4 素材库与动画 ── */
  await clickVisible(page, '[data-pc-rail="library"]');
  await sleep(500);
  const media = await stateOf(page, '[data-pc-add="media"]');
  check('R4.import-off', media.off && media.title === why, { media });
  await shot(page, 'ro-library.png');
  await clickVisible(page, '[data-pc-rail="animations"]');
  await sleep(800);
  // 卡片格在组里,打开第一个有卡片的组
  let cell = { found: false };
  for (let i = 0; i < 6 && !cell.found; i++) {
    await page.evaluate((i) => { const els = [...document.querySelectorAll('[data-pc-group]')]; els[i]?.click(); }, i);
    await sleep(700);
    cell = await stateOf(page, '[data-pc-card]');
  }
  const clipsBefore = (await clipIds(page)).length;
  if (cell.found) await clickVisible(page, '[data-pc-card]');
  await sleep(300);
  check('R4.card-cell-inert', cell.found && cell.aria === 'true' && !cell.draggable && cell.title.endsWith(why) && (await clipIds(page)).length === clipsBefore, { cell, clipsBefore });

  /* ── R5 预览 ── */
  const tools = await page.evaluate(() => [...document.querySelectorAll('.pc-pv-tool')].map((b) => ({ d: b.disabled, t: b.title })));
  check('R5.tools', tools.length === 3 && !tools[0].d && tools[1].d && tools[2].d && tools[1].t.endsWith(why) && tools[2].t.endsWith(why), { tools });
  await page.evaluate(() => window.__pcStore.actions.togglePlay());
  await sleep(400);
  const playing = await page.evaluate(() => window.__pcStore.getState().playing);
  await page.evaluate(() => window.__pcStore.actions.pause());
  check('R5.playback-still-works', playing === true);
  const exportBtn = await page.evaluate(() => { const b = [...document.querySelectorAll('.pc-btn--primary')].find((x) => x.textContent.includes('导出视频')); return b ? { off: b.disabled } : null; });
  check('R5.export-still-enabled', exportBtn && exportBtn.off === false, { exportBtn });

  /* ── R6 右栏 Agent ── */
  const ai = {
    input: await stateOf(page, '[data-pc="ai-input"]'),
    send: await stateOf(page, '[data-pc="ai-send"]'),
    preset: await stateOf(page, '[data-pc="ai-start-preset"]'),
    animated: await page.evaluate(() => document.querySelector('[data-pc="ai-start"]')?.getAttribute('data-pc-start-animated') ?? null),
    guide: await page.evaluate(() => document.querySelector('[data-pc="ai-composer"]')?.getAttribute('data-pc-guide') ?? null),
  };
  check('R6.composer-off', ai.input.disabled && ai.input.placeholder === why && ai.send.disabled && ai.send.title === why, { ai });
  check('R6.start-page-no-invite', ai.preset.disabled && ai.preset.title === why && ai.animated === '0' && ai.guide === null, { ai });
  await shot(page, 'ro-agent.png');

  /* ── R7 顶栏 ── */
  const undo = await stateOf(page, '[data-pc="undo-btn"] button');
  const undoTip = await page.evaluate(() => document.querySelector('[data-pc="undo-btn"]').title);
  const rename = await stateOf(page, '.pc-projname--btn');
  check('R7.undo-redo-off', undo.disabled && undo.title === why && undoTip === why, { undo, undoTip });
  check('R7.rename-off', rename.aria === 'true' && rename.title === why, { rename });
  await page.evaluate(() => document.querySelector('.pc-projname--btn').click());
  await sleep(200);
  check('R7.rename-does-not-open', (await countOf(page, '.pc-projname--editing')) === 0);
  await clickVisible(page, '.pc-proj-btn');
  await sleep(300);
  const menuItems = await page.evaluate(() => [...document.querySelectorAll('.pc-proj-item')].map((b) => ({ t: b.querySelector('b')?.textContent, d: b.disabled, title: b.title })));
  const byName = (n) => menuItems.find((m) => m.t === n);
  check('R7.save-items-off', byName('保存项目')?.d && byName('保存项目').title === why && byName('打包保存…')?.d && byName('打包保存…').title === why, { menuItems });
  check('R7.settings-openable', byName('项目设置…') && !byName('项目设置…').d, { menuItems });
  await shot(page, 'ro-project-menu.png');
  await page.evaluate(() => [...document.querySelectorAll('.pc-proj-item')].find((b) => b.querySelector('b')?.textContent === '项目设置…').click());
  await sleep(500);
  const dlg = await page.evaluate(() => {
    const d = document.querySelector('.pc-dialog');
    const fields = [...d.querySelectorAll('#pc-proj-name, #pc-proj-fps, #pc-proj-duration, #pc-proj-creativity, .pc-dialog-opt')];
    const confirmBtn = d.querySelector('.pc-btn--primary');
    return { note: d.querySelector('[data-pc="settings-readonly-note"]')?.textContent ?? null, fields: fields.length, off: fields.filter((e) => e.disabled || e.closest('fieldset:disabled')).length, confirmDisabled: confirmBtn.disabled, confirmTitle: confirmBtn.title, cancel: [...d.querySelectorAll('.pc-dialog-foot .pc-btn')][0].textContent };
  });
  check('R7.settings-dialog-readonly', dlg.note === why && dlg.fields >= 5 && dlg.off === dlg.fields && dlg.confirmDisabled && dlg.confirmTitle === why && dlg.cancel === '关闭', { dlg });
  await shot(page, 'ro-settings.png');
  await page.keyboard.press('Escape');
  await sleep(300);
  // 桌面版标题栏菜单(这个构建里也画出来):编辑 → 撤销 / 重做、文件 → 保存项目 置灰,说明是那一句
  const titlebar = {};
  for (const [menu, cmds] of [['编辑', ['undo', 'redo']], ['文件', ['save-project', 'export-video']]]) {
    await page.evaluate((menu) => [...document.querySelectorAll('.pc-titlebar-menu-button')].find((b) => b.textContent.trim() === menu).click(), menu);
    await sleep(250);
    for (const c of cmds) titlebar[c] = await page.evaluate((c) => { const b = document.querySelector(`[data-pc="titlebar-${c}"]`); return b ? { d: b.getAttribute('aria-disabled') === 'true', t: b.title } : null; }, c);
    await page.keyboard.press('Escape');
    await sleep(150);
  }
  check('R7.titlebar-menu', titlebar.undo?.d && titlebar.undo.t === why && titlebar.redo?.d && titlebar['save-project']?.d && titlebar['save-project'].t === why && titlebar['export-video'] && !titlebar['export-video'].d, { titlebar });
  await shot(page, 'ro-full.png');

  /* ── R9 切回读写 ── */
  await setAccess(page, 'rw');
  await sleep(300);
  const back = {
    marker: await page.evaluate(() => document.documentElement.dataset.pcReadonly ?? null),
    addTrack: await stateOf(page, '[data-pc="add-track"]'),
    composer: await stateOf(page, '[data-pc="ai-input"]'),
    trim: await countOf(page, '.pc-clip-trim'),
    tools: await page.evaluate(() => [...document.querySelectorAll('.pc-pv-tool')].map((b) => b.disabled)),
    badge: await countOf(page, '[data-pc="viewonly-badge"]'),
    fences: await countOf(page, 'fieldset.pc-ro-fence[disabled]'),
  };
  const dropRw = await tryDrop(page);
  check('R9.drop-accepted-again', dropRw.accepted === true && dropRw.added === 1 && dropRw.newTrackZone === 1, { dropRw });
  check('R9.back-to-readwrite', back.marker === null && !back.addTrack.off && !back.composer.off && back.trim > 0 && back.tools.every((d) => !d) && back.badge === 0 && back.fences === 0, { back });
  await page.close();

  /* ── R8 ?observe=1 老路 ── */
  const ob = await openEditor(origin, '?editor&aimock=1&nosetup=1&observe=1');
  const obState = {
    badge: await stateOf(ob, '[data-pc="viewonly-badge"]'),
    addTrack: await stateOf(ob, '[data-pc="add-track"]'),
    composer: await stateOf(ob, '[data-pc="ai-input"]'),
    media: await stateOf(ob, '[data-pc-add="media"]'),
    tools: await ob.evaluate(() => [...document.querySelectorAll('.pc-pv-tool')].map((b) => b.disabled)),
    marker: await ob.evaluate(() => document.documentElement.dataset.pcReadonly ?? null),
    fences: await countOf(ob, 'fieldset.pc-ro-fence[disabled]'),
    trim: await countOf(ob, '.pc-clip-trim'),
  };
  await ob.evaluate(() => document.querySelector('.pc-proj-btn').click());
  await sleep(300);
  const obMenu = await ob.evaluate(() => [...document.querySelectorAll('.pc-proj-item')].map((b) => ({ t: b.querySelector('b')?.textContent, d: b.disabled })));
  check('R8.observe-badge-unchanged', obState.badge.found && obState.badge.text === '只读查看' && obState.badge.title.includes('?observe=1'), { badge: obState.badge });
  check('R8.observe-save-off', obMenu.find((m) => m.t === '保存项目')?.d === true, { obMenu });
  check('R8.observe-has-no-new-locks', obState.marker === null && !obState.addTrack.off && !obState.composer.off && !obState.media.off && obState.tools.every((d) => !d) && obState.fences === 0 && obState.trim > 0, obState);
  await shot(ob, 'observe-full.png');
  await ob.close();

  /* ── 手机版:只在在线构建里出现,这里另起一台在线模式的开发服务 ── */
  if (WITH_MOBILE) {
    const logFile = path.join(tmp, 'vite-online.log');
    const child = spawn(process.execPath, [viteBin(), '--mode', 'online', '--port', String(MOBILE_PORT), '--strictPort', '--host', '127.0.0.1'], {
      cwd: REPO, env: { ...process.env, BROWSER: 'none', ...serverEnv() }, stdio: ['ignore', fs.openSync(logFile, 'a'), fs.openSync(logFile, 'a')], windowsHide: true,
    });
    mobileServer = { stop: () => killTree(child.pid) };
    await waitHttp(`http://127.0.0.1:${MOBILE_PORT}/`, () => true, 120_000, '在线模式开发服务').catch(() => {});
    const mob = await openEditor(`http://127.0.0.1:${MOBILE_PORT}/editor`, '?editor&layout=mobile', { width: 390, height: 844 });
    await waitFor(() => mob.evaluate(() => !!document.querySelector('[data-pcm="editor"]')), 60_000, '手机版编辑页');
    await setAccess(mob, 'r', '/editor');
    const mWhy = await WHY(mob, '/editor');
    const m = await mob.evaluate(() => ({
      flag: document.querySelector('[data-pcm="editor"]')?.getAttribute('data-readonly'),
      sub: [...document.querySelectorAll('[data-pcm="subnav-preview"] button')].map((b) => ({ d: b.disabled, t: b.title })),
      undo: document.querySelector('[data-pcm="undo"]')?.disabled,
      play: document.querySelector('[data-pcm="play"]')?.disabled,
      exportBtn: document.querySelector('[data-pcm="top-export"]')?.disabled,
      bar: document.querySelector('[data-pcm="ro-bar"]')?.textContent ?? null,
    }));
    check('M1.mobile-subnav-off', m.bar === mWhy && m.flag === '1' && m.sub.length > 0 && m.sub.every((b) => b.d && b.t === mWhy) && m.undo === true && m.play === false && m.exportBtn === false, { m });
    await shot(mob, 'ro-mobile.png');
    await mob.evaluate(() => document.querySelector('[data-pcm="pg-agent"]').click());
    await sleep(1200);
    const a = await mob.evaluate(() => ({
      composer: document.querySelector('[data-pcm="agent-composer"]')?.getAttribute('data-readonly') ?? null,
      note: document.querySelector('[data-pcm="agent-composer"] .note')?.textContent ?? null,
      input: !!document.querySelector('[data-pcm="chat-input"]'),
      start: document.querySelector('[data-pcm="agent-start"]')?.getAttribute('data-readonly') ?? null,
    }));
    check('M2.mobile-agent-composer-explains', a.composer === '1' && a.note === mWhy && !a.input, { a });
    await shot(mob, 'ro-mobile-agent.png');
    // 时间轴分页:卡片段点选后拖动平移——只读不动,读写会动
    const mobProject = () => mob.evaluate(() => JSON.stringify(window.__pcStore.getState().project));
    const dragClip = async () => {
      const box = await mob.evaluate(() => { const r = document.querySelector('[data-pcm="clip"]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
      await mob.mouse.click(box.x, box.y); // 先点选
      await sleep(300);
      await mob.mouse.move(box.x, box.y);
      await mob.mouse.down();
      await mob.mouse.move(box.x + 70, box.y, { steps: 6 });
      await mob.mouse.up();
      await sleep(400);
    };
    await mob.evaluate(async () => {
      const { allCards } = await import('/editor/src/kernel/registry.ts');
      window.__pcStore.actions.addCardClip(allCards()[0].id, 2, {});
    });
    await mob.evaluate(() => document.querySelector('[data-pcm="pg-timeline"]').click());
    await sleep(1200);
    const mBefore = await mobProject();
    await dragClip();
    check('M3.mobile-timeline-drag-refused', (await mobProject()) === mBefore, { clips: await mob.evaluate(() => document.querySelectorAll('[data-pcm="clip"]').length) });
    const align = await mob.evaluate(() => [...document.querySelectorAll('[data-pcm="align-start"],[data-pcm="align-end"]')].map((b) => b.disabled));
    check('M3.mobile-align-off', align.length === 2 && align.every(Boolean), { align });
    await shot(mob, 'ro-mobile-timeline.png');
    await setAccess(mob, 'rw', '/editor');
    const mBefore2 = await mobProject();
    await dragClip();
    check('M3.mobile-timeline-drag-works-in-readwrite', (await mobProject()) !== mBefore2);
    await mob.close();
  }
} catch (e) {
  check('probe.run', false, { error: String(e?.stack ?? e) });
} finally {
  const failed = results.filter((r) => !r.ok);
  console.log(JSON.stringify({ summary: { total: results.length, failed: failed.length, failedChecks: failed.map((r) => r.check) } }));
  if (browser && !KEEP) await browser.close().catch(() => {});
  if (server && !KEEP) server.stop();
  if (mobileServer && !KEEP) mobileServer.stop();
  process.exitCode = failed.length ? 1 : 0;
}
