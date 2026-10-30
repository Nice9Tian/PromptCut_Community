/**
 * 剪辑任务(`docs/plan/cut-nesting-task.md`「验收」)的本机界面探针:真的打开编辑台,逐条点、拖、截图。
 *
 *   node scripts/probes/cut-nesting-ui-probe.mjs --origin http://127.0.0.1:5350 --out <截图目录>
 *
 * dev server 要先起好(三个连号端口都空着;不碰 5190～5192)。舞台 iframe 走 puppeteer 的 frame 句柄。
 * 拖放用页面里构造的 `DragEvent` + `DataTransfer` 派发到素材库格子和时间轴序列上(和手拖走同一组 React 事件处理)。
 *
 * 断言(每条一个结论,最后一行打一行 JSON):
 *   A1 新建项目只有「剪辑1」(store 与标签栏、素材库剪辑组都只有一条;标签上没有「×」)
 *   A2 素材库出现「剪辑」组,显示名称与时长
 *   A3 单击素材库里的剪辑:时间轴上方开标签并激活
 *   A4 点别处、切左栏分区、失去焦点:标签都在
 *   A5 点「×」只关标签,剪辑还在素材库里;最后一个标签没有「×」
 *   A6 把剪辑2 拖进剪辑1 的序列:出现剪辑段;预览里画出剪辑2 的内容
 *   A7 改剪辑2,剪辑1 里跟着变(预览前后不同)
 *   A8 拖剪辑1 进剪辑1、在剪辑2 里拖剪辑1(A→B→A):落点预览标红并写明原因,松手不落
 *   A9 删除被引用的剪辑:确认框说明被哪些剪辑用着;确认后剪辑段一起删;撤销后都回来
 *   A10 选中剪辑段:编辑分区里没有换引用的「引用」下拉框(引用哪条剪辑不能改,2026-10-21 用户定),「打开被引用剪辑」按钮还在
 */
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import fs from 'node:fs';
import path from 'node:path';

setTimeout(() => { console.error('SCRIPT_TIMEOUT'); process.exit(124); }, 12 * 60_000).unref();
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const ORIGIN = arg('--origin', 'http://127.0.0.1:5350');
const OUT = path.resolve(arg('--out', 'out/cut-nesting-ui'));
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = {};
const fails = [];
const check = (key, cond, note, extra) => {
  results[key] = { ok: !!cond, note, ...(extra !== undefined ? { extra } : {}) };
  if (!cond) fails.push(`${key}: ${note}${extra !== undefined ? ' :: ' + JSON.stringify(extra).slice(0, 300) : ''}`);
  console.log(`${cond ? 'PASS' : 'FAIL'} ${key} ${note}`);
};

const browser = await puppeteer.launch({ headless: true, args: [...PROBE_CHROME_ARGS, '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => { console.log('[dialog]', d.message()); void d.dismiss(); });
  await page.goto(`${ORIGIN}/?editor&nosetup=1`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
  await page.waitForFunction(() => !!window.__pcStore, { timeout: 120_000 });
  await sleep(6000);
  const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
  const state = () => page.evaluate(() => {
    const p = window.__pcStore.getState().project;
    return {
      cuts: (p.cuts ?? []).map((c) => ({ id: c.id, name: c.name })), active: p.activeCutId,
      tabs: [...document.querySelectorAll('[data-pc-cut-tab]')].map((el) => ({ id: el.getAttribute('data-pc-cut-tab'), on: el.classList.contains('is-on'), close: !!el.querySelector('[data-pc="cut-tab-close"]') })),
      segments: p.tracks.flatMap((t) => t.clips).filter((c) => c.cutId).map((c) => ({ id: c.id, cutId: c.cutId, start: c.start, end: c.end })),
    };
  });
  const stageText = async () => {
    const texts = [];
    for (const f of page.frames().filter((fr) => fr.url().includes('stage=1'))) {
      texts.push(await f.evaluate(() => ({ text: document.body.innerText, cutScenes: document.querySelectorAll('[data-pc-cut-scene]').length })).catch(() => ({ text: '', cutScenes: 0 })));
    }
    return texts;
  };
  const openLibraryGroup = async () => {
    // 素材库分区没露出来才点 rail(点已经展开的那一项会把抽屉收起来,藏起来的分区页不跟 store 更新)
    const shown = await page.evaluate(() => { const el = document.querySelector('[data-pc="library"]'); return !!el && el.getBoundingClientRect().width > 0; });
    if (!shown) await page.evaluate(() => document.querySelector('[data-pc-rail="library"]')?.click());
    await sleep(300);
    const open = await page.$('[data-pc-open-group="cuts"]');
    if (!open) await page.evaluate(() => document.querySelector('[data-pc-group="cuts"]')?.click());
    await sleep(400);
  };

  /* A1 新建项目 */
  await page.evaluate(() => window.__pcStore.actions.newProject('剪辑验收'));
  await sleep(2500);
  let s = await state();
  check('A1', s.cuts.length === 1 && s.cuts[0].name === '剪辑1' && s.tabs.length === 1 && !s.tabs[0].close, '新建项目只有剪辑1,标签栏一个标签且没有 ×', s);
  await openLibraryGroup();
  await shot('01-new-project-one-cut');

  /* A2 素材库剪辑组 */
  const lib = await page.evaluate(() => [...document.querySelectorAll('[data-pc-lib-cut]')].map((el) => el.innerText.replace(/\s+/g, ' ')));
  check('A2', lib.length === 1 && /剪辑1/.test(lib[0]) && /\d+:\d\d/.test(lib[0]), '素材库「剪辑」组列出剪辑1 及时长', lib);

  /* 新建剪辑2(标签栏「+」),往里放一张卡和一段视频 */
  await page.click('[data-pc="cut-add"]');
  await sleep(800);
  s = await state();
  const cut2 = s.cuts.find((c) => c.name === '剪辑2')?.id;
  await page.evaluate(() => {
    const a = window.__pcStore.actions;
    const media = a.addMedia({ kind: 'video', name: 'fixture.mp4', url: '/@media/392128b6b4d1ba0f32751a1fb23df75e9f08cfc3981b1a19a457c5ff4ebb7e95', duration: 8, width: 320, height: 180, hash: '392128b6b4d1ba0f32751a1fb23df75e9f08cfc3981b1a19a457c5ff4ebb7e95' });
    const tracks = window.__pcStore.getState().project.tracks;
    a.addMediaClip(media.id, 0, { trackId: tracks[1].id, duration: 6 });
    a.addCardClip('punch-pill', 0, { trackId: tracks[0].id, duration: 6, params: { text: '剪辑二的卡' } });
  });
  await sleep(800);

  /* A3 单击素材库里的剪辑:开标签并激活。先关掉剪辑2 的标签、回到剪辑1 */
  await page.evaluate((id) => document.querySelector(`[data-pc-cut-tab="${id}"] [data-pc="cut-tab-close"]`)?.click(), cut2);
  await sleep(600);
  await openLibraryGroup();
  s = await state();
  check('A5', s.tabs.length === 1 && s.cuts.length === 2 && s.active !== cut2 && !s.tabs[0].close, '× 只关标签:剪辑2 还在;只剩一个标签时没有 ×', s);
  const libAfterClose = await page.evaluate(() => [...document.querySelectorAll('[data-pc-lib-cut]')].map((el) => el.getAttribute('data-pc-lib-cut')));
  check('A5b', libAfterClose.includes(cut2), '关掉标签后素材库里还有剪辑2', libAfterClose);
  await shot('02-tab-closed-cut-still-in-library');
  await openLibraryGroup();
  await page.evaluate((id) => document.querySelector(`[data-pc-lib-cut="${id}"]`)?.click(), cut2);
  await sleep(800);
  s = await state();
  check('A3', s.active === cut2 && s.tabs.some((t) => t.id === cut2 && t.on), '单击素材库里的剪辑2:时间轴上方开标签并激活', s);
  await shot('03-click-library-opens-tab');

  /* A4 点别处、切分区、失去焦点 */
  await page.mouse.click(780, 400); // 预览
  await page.evaluate(() => document.querySelector('[data-pc-rail="animations"]')?.click());
  await sleep(300);
  await page.evaluate(() => { document.activeElement?.blur?.(); window.dispatchEvent(new Event('blur')); });
  await page.mouse.click(1300, 300); // AI 栏
  await sleep(500);
  s = await state();
  check('A4', s.tabs.length === 2, '点预览、切左栏分区、失焦、点 AI 栏之后两个标签都在', s);
  await shot('04-tabs-survive-focus-loss');

  /* A6 回到剪辑1,把剪辑2 拖进剪辑1 的序列 */
  const cut1 = s.cuts.find((c) => c.name === '剪辑1').id;
  await page.evaluate((id) => document.querySelector(`[data-pc-cut-tab="${id}"] [role="tab"]`)?.click(), cut1);
  await sleep(800);
  await openLibraryGroup();
  const drag = async (cutId, x, holdShot) => page.evaluate(async ({ cutId, x, holdShot }) => {
    const tile = document.querySelector(`[data-pc-lib-cut="${cutId}"]`);
    const row = document.querySelector('[data-track-id]');
    if (!tile || !row) return { error: 'no tile/row' };
    const dt = new DataTransfer();
    tile.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
    const r = row.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + x, clientY: r.top + r.height / 2 };
    row.dispatchEvent(new DragEvent('dragenter', opts));
    row.dispatchEvent(new DragEvent('dragover', opts));
    await new Promise((res) => setTimeout(res, 300));
    const ghost = row.querySelector('.pc-drop-ghost, [data-pc="drop-ghost"]')?.innerText ?? row.innerText;
    const red = row.className.includes('bg-red');
    if (holdShot) return { ghost, red, held: true, rowSel: row.getAttribute('data-track-id') };
    row.dispatchEvent(new DragEvent('drop', opts));
    tile.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    return { ghost, red };
  }, { cutId, x, holdShot });
  const dropRes = await drag(cut2, 40, false);
  await sleep(1200);
  s = await state();
  const segOk = s.segments.length === 1 && s.segments[0].cutId === cut2 && Math.abs(s.segments[0].end - s.segments[0].start - 6) < 0.05;
  await page.evaluate((t) => window.__pcStore.actions.seek(t), s.segments[0] ? s.segments[0].start + 2 : 2);
  await sleep(5000);
  let st = await stageText();
  check('A6', segOk && st.some((x) => x.cutScenes > 0 && x.text.includes('剪辑二的卡')), '剪辑2 拖进剪辑1:出现剪辑段,预览画出剪辑2 的卡', { dropRes, segments: s.segments, stage: st.map((x) => ({ cutScenes: x.cutScenes, has: x.text.includes('剪辑二的卡') })) });
  await shot('05-cut2-dropped-into-cut1');

  /* A10 剪辑段的属性面板(2026-10-21 用户定):编辑分区里没有换引用的「引用」下拉框,「打开被引用剪辑」按钮还在 */
  {
    const segEl = await page.$(`[data-pc-cut-segment="${cut2}"]`);
    if (segEl) await segEl.click();
    await sleep(400);
    const editShown = await page.evaluate(() => { const el = document.querySelector('[data-pc="inspector"]'); return !!el && el.getBoundingClientRect().width > 0; });
    if (!editShown) await page.evaluate(() => document.querySelector('[data-pc-rail="edit"]')?.click());
    await sleep(600);
    const form = await page.evaluate(() => {
      const f = document.querySelector('[data-pc="cut-segment-form"]');
      return f ? { refSelect: !!f.querySelector('[data-pc="cut-segment-cut"]'), selects: f.querySelectorAll('select').length,
        open: !!f.querySelector('[data-pc="cut-segment-open"]'), offset: !!f.querySelector('[data-pc="cut-segment-offset"]'), text: f.innerText.replace(/\s+/g, ' ').slice(0, 160) } : null;
    });
    check('A10', !!form && !form.refSelect && form.selects === 0 && form.open && form.offset,
      '剪辑段面板:没有「引用」下拉框,「打开被引用剪辑」按钮和起点偏移还在', form);
    await shot('05b-cut-segment-panel');
    // 后面的拖放要素材库格子:切回素材库
    await openLibraryGroup();
  }

  /* A7 改剪辑2,剪辑1 里跟着变 */
  await page.evaluate((id) => {
    const a = window.__pcStore.actions;
    a.switchCut(id);
    const clip = window.__pcStore.getState().project.tracks.flatMap((t) => t.clips).find((c) => c.cardId === 'punch-pill');
    a.setClipParams(clip.id, { text: '改过的剪辑二' });
  }, cut2);
  await sleep(500);
  await page.evaluate((id) => window.__pcStore.actions.switchCut(id), cut1);
  await sleep(500);
  await page.evaluate((t) => window.__pcStore.actions.seek(t), s.segments[0].start + 2);
  await sleep(5000);
  st = await stageText();
  check('A7', st.some((x) => x.text.includes('改过的剪辑二')) && !st.some((x) => x.text.includes('剪辑二的卡')), '改剪辑2 的卡,剪辑1 预览跟着变', st.map((x) => x.text.slice(0, 80)));
  await shot('06-edit-cut2-reflects-in-cut1');

  /* A8 拒绝自引用与 A→B→A */
  const selfDrag = await drag(cut1, 400, true);
  await shot('07-reject-self');
  await page.evaluate(() => { const row = document.querySelector('[data-track-id]'); row.dispatchEvent(new DragEvent('dragleave', { bubbles: true })); window.dispatchEvent(new Event('dragend')); });
  const selfDrop = await drag(cut1, 400, false);
  await sleep(500);
  const afterSelf = (await state()).segments.length;
  await page.evaluate((id) => document.querySelector(`[data-pc-lib-cut="${id}"]`)?.click(), cut2);
  await sleep(800);
  await openLibraryGroup();
  const loopDrag = await drag(cut1, 500, true);
  await shot('08-reject-a-b-a');
  await page.evaluate(() => { const row = document.querySelector('[data-track-id]'); row.dispatchEvent(new DragEvent('dragleave', { bubbles: true })); window.dispatchEvent(new Event('dragend')); });
  await drag(cut1, 500, false);
  await sleep(500);
  const loopSegs = (await state()).segments.length;
  check('A8', /放进它自己/.test(selfDrag.ghost) && selfDrag.red && afterSelf === 1 && /循环引用/.test(loopDrag.ghost) && loopDrag.red && loopSegs === 0,
    '拖剪辑1 进剪辑1、在剪辑2 里拖剪辑1:都标红写明原因,松手不落', { selfDrag, selfDrop, afterSelf, loopDrag, loopSegs });

  /* A9 删除被引用的剪辑 */
  await page.evaluate((id) => document.querySelector(`[data-pc-cut-tab="${id}"] [role="tab"]`)?.click(), cut1);
  await sleep(600);
  await openLibraryGroup();
  await page.evaluate((id) => {
    const tile = document.querySelector(`[data-pc-lib-cut="${id}"]`);
    tile.querySelector('[data-pc="lib-cut-delete"]').click();
  }, cut2);
  await sleep(500);
  const dialogText = await page.evaluate(() => document.body.innerText.match(/剪辑「剪辑2」正被[^\n]*\n?[^\n]*/)?.[0] ?? '');
  await shot('09-delete-referenced-confirm');
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === '删除')?.click());
  await sleep(800);
  const afterDelete = await state();
  await page.evaluate(() => window.__pcStore.actions.undo());
  await sleep(800);
  const afterUndo = await state();
  check('A9', /用着/.test(dialogText) && /一起删除/.test(dialogText) && afterDelete.cuts.length === 1 && afterDelete.segments.length === 0 && afterUndo.cuts.length === 2 && afterUndo.segments.length === 1,
    '删被引用的剪辑:确认框写明被谁用着;删后剪辑段一起没了;撤销全回来', { dialogText, afterDelete, afterUndo });
  await shot('10-after-undo');
  console.log('page errors:', errors.slice(0, 5));
} finally {
  await browser.close();
}
console.log(JSON.stringify({ ok: fails.length === 0, fails, results }));
process.exit(fails.length ? 1 : 0);
