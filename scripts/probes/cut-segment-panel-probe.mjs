/**
 * 剪辑段属性面板与素材库剪辑格子的界面探针(剪辑段首版局限补齐,`docs/archive/agent-reports/AGENT-cut-segment-followups.md` 第 1、5 项)。
 * 真的打开编辑台,在面板上点、填、拖,读 store 核对,逐步截图。
 *
 *   node scripts/probes/cut-segment-panel-probe.mjs --origin http://127.0.0.1:5370 --out <截图目录>
 *
 * dev server 要先起好(三个连号端口都空着;不碰 5190～5192)。
 *
 * 断言(每条一行 PASS/FAIL,最后一行打一行 JSON,有失败退出码 1):
 *   P1 单击时间轴上的剪辑段:编辑分区显示剪辑段面板(被引用剪辑的名字、偏移、起止、框、不透明度、淡入淡出、音量、静音、「打开被引用剪辑」)
 *   P2 改起点偏移:store 里 cutOffset 跟着变、出点截到被引用剪辑剩下的长度;撤销一次回到原值
 *   P3 引用哪条剪辑不能改(2026-10-21 用户定):面板里没有「引用」下拉框(也没有别的 select),「打开被引用剪辑」按钮还在
 *   P4 框:改 X、Y、缩放 → frame;「铺满」清掉 frame;撤销回来(数字框回车才提交,X、Y、缩放各一步,共三步)
 *   P5 不透明度、淡入、淡出 → opacity / fadeIn / fadeOut;撤销回来
 *   P6 音量、静音 → audioVolume / audioMuted;撤销回来
 *   P7 偏移超出被引用剪辑的总时长:不改项目,面板底下写明原因
 *   P8 每次改动都换了新的项目对象(不原地改)
 *   P9 「打开被引用剪辑」:激活剪辑换成被引用的那条,标签栏里有它的标签(和双击剪辑段同效)
 *   L1 素材库「剪辑」组:总览缩略和详情格子里剪辑名都完整一行(高度 ≥ 14 像素),字号不小于视频 / 图片格子的标题
 */
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import fs from 'node:fs';
import path from 'node:path';

setTimeout(() => { console.error('SCRIPT_TIMEOUT'); process.exit(124); }, 10 * 60_000).unref();
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const ORIGIN = arg('--origin', 'http://127.0.0.1:5370');
const OUT = path.resolve(arg('--out', 'out/cut-segment-panel'));
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = {};
const fails = [];
const check = (key, cond, note, extra) => {
  results[key] = { ok: !!cond, note, ...(extra !== undefined ? { extra } : {}) };
  if (!cond) fails.push(`${key}: ${note}${extra !== undefined ? ' :: ' + JSON.stringify(extra).slice(0, 400) : ''}`);
  console.log(`${cond ? 'PASS' : 'FAIL'} ${key} ${note}${!cond && extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 400) : ''}`);
};

const browser = await puppeteer.launch({ headless: true, args: [...PROBE_CHROME_ARGS, '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => { void d.dismiss(); });
  await page.goto(`${ORIGIN}/?editor&nosetup=1`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
  await page.waitForFunction(() => !!window.__pcStore, { timeout: 120_000 });
  await sleep(6000);
  const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
  const panelShot = async (name) => {
    const r = await page.evaluate(() => { const el = document.querySelector('[data-pc="inspector"]'); if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; });
    if (r && r.w > 0) await page.screenshot({ path: path.join(OUT, `${name}.png`), clip: { x: r.x, y: r.y, width: r.w, height: r.h } });
  };

  /* 准备:剪辑2(一张卡 0～6 秒)、剪辑3(一张卡 0～4 秒),剪辑1 里 1 秒处一个引用剪辑2 的剪辑段 */
  const ids = await page.evaluate(() => {
    const a = window.__pcStore.actions;
    a.newProject('剪辑段面板');
    const c2 = a.addCut('剪辑2', { switchTo: true });
    a.addCardClip('punch-pill', 0, { duration: 6, params: { text: '剪辑二' } });
    a.setProjectMeta({ duration: 6 });
    const c3 = a.addCut('剪辑3', { switchTo: true });
    a.addCardClip('punch-pill', 0, { duration: 4, params: { text: '剪辑三' } });
    a.setProjectMeta({ duration: 4 });
    const root = window.__pcStore.getState().project.cuts[0].id;
    a.switchCut(root);
    a.select([]);
    const seg = a.addCutSegment(c2.id, 1, {});
    a.select([]);
    return { root, c2: c2.id, c3: c3.id, seg: seg.id };
  });
  await sleep(800);
  const seg = () => page.evaluate((id) => {
    const p = window.__pcStore.getState().project;
    return p.tracks.flatMap((t) => t.clips).find((c) => c.id === id) ?? null;
  }, ids.seg);
  const projectRef = () => page.evaluate(() => { window.__probeRefs = window.__probeRefs || []; window.__probeRefs.push(window.__pcStore.getState().project); return window.__probeRefs.length - 1; });
  const sameRef = (i) => page.evaluate((i) => window.__probeRefs[i] === window.__pcStore.getState().project, i);
  const undo = async () => { await page.evaluate(() => window.__pcStore.actions.undo()); await sleep(250); };
  const typeInto = async (sel, value) => {
    await page.click(sel, { clickCount: 3 });
    await page.keyboard.press('Backspace');
    await page.type(sel, String(value));
    await page.keyboard.press('Enter'); // 数字框敲字只改草稿,回车(失焦)才提交一步
    await sleep(250);
  };
  const setRange = async (sel, value) => {
    await page.evaluate((sel, value) => {
      const el = document.querySelector(sel);
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, String(value));
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, sel, value);
    await sleep(250);
  };

  /* P1 单击剪辑段 → 编辑分区显示剪辑段面板 */
  const segEl = await page.$(`[data-pc-cut-segment="${ids.c2}"]`);
  if (segEl) await segEl.click();
  await sleep(400);
  const editShown = await page.evaluate(() => { const el = document.querySelector('[data-pc="inspector"]'); return !!el && el.getBoundingClientRect().width > 0; });
  if (!editShown) await page.evaluate(() => document.querySelector('[data-pc-rail="edit"]')?.click());
  await sleep(600);
  const panel = await page.evaluate(() => {
    const f = document.querySelector('[data-pc="cut-segment-form"]');
    if (!f) return null;
    const has = (k) => !!f.querySelector(`[data-pc="${k}"]`);
    return {
      text: f.innerText.replace(/\s+/g, ' ').slice(0, 300),
      fields: ['cut-segment-offset', 'clip-start', 'clip-end', 'cut-segment-x', 'cut-segment-y', 'cut-segment-scale', 'cut-segment-rotate',
        'cut-segment-opacity', 'cut-segment-fadein', 'cut-segment-fadeout', 'cut-segment-volume', 'cut-segment-muted', 'cut-segment-open', 'cut-segment-frame-reset'].filter((k) => !has(k)),
    };
  });
  const sel = await page.evaluate(() => window.__pcStore.getState().selection);
  check('P1', panel && panel.fields.length === 0 && /剪辑2/.test(panel.text) && sel[0] === ids.seg, '单击剪辑段:编辑分区显示剪辑段面板,各项都在', { panel, sel });
  await shot('01-panel-selected');
  await panelShot('01b-panel');

  /* P2 起点偏移 */
  let r0 = await projectRef();
  await typeInto('[data-pc="cut-segment-offset"]', 2);
  let s = await seg();
  const p8a = !(await sameRef(r0));
  check('P2', s.cutOffset === 2 && s.start === 1 && Math.abs(s.end - (1 + 6 - 2)) < 1e-6, '改偏移:cutOffset = 2,出点截到被引用剪辑剩下的 4 秒', { cutOffset: s.cutOffset, start: s.start, end: s.end });
  await panelShot('02-offset');
  await undo();
  s = await seg();
  check('P2u', (s.cutOffset ?? 0) === 0 && s.end === 7, '撤销一次:偏移与出点回到原值', { cutOffset: s.cutOffset, end: s.end });

  /* P3 引用哪条剪辑不能改(2026-10-21 用户定):编辑分区里没有「引用」下拉框,「打开被引用剪辑」按钮还在 */
  const refUi = await page.evaluate(() => {
    const f = document.querySelector('[data-pc="cut-segment-form"]');
    return { select: !!f?.querySelector('[data-pc="cut-segment-cut"]'), anySelect: f ? f.querySelectorAll('select').length : -1,
      open: !!f?.querySelector('[data-pc="cut-segment-open"]'), label: /引用\s/.test(f?.innerText ?? '') };
  });
  check('P3', !refUi.select && refUi.anySelect === 0 && refUi.open, '编辑分区里没有换引用的下拉框;「打开被引用剪辑」按钮还在', refUi);
  await panelShot('03-no-ref-select');

  /* P4 框 */
  r0 = await projectRef();
  await typeInto('[data-pc="cut-segment-x"]', 100);
  await typeInto('[data-pc="cut-segment-y"]', 50);
  await setRange('[data-pc="cut-segment-scale"]', 0.5);
  s = await seg();
  const p8c = !(await sameRef(r0));
  check('P4', s.frame?.x === 100 && s.frame?.y === 50 && s.frame?.scale === 0.5, '改 X、Y、缩放写进 frame', { frame: s.frame });
  await sleep(500);
  await shot('04-frame');
  await page.click('[data-pc="cut-segment-frame-reset"]');
  await sleep(300);
  s = await seg();
  const cleared = s.frame === undefined;
  await undo();
  s = await seg();
  check('P4r', cleared && s.frame?.scale === 0.5, '「铺满」清掉 frame;撤销回到缩放 0.5', { frame: s.frame, cleared });
  // 数字框回车才提交(2026-10-20 用户定):X 填 100 一步、Y 填 50 一步、缩放一步,共三步
  let steps = 0;
  while (s.frame !== undefined && steps < 10) { await undo(); steps++; s = await seg(); }
  check('P4u', s.frame === undefined && steps === 3, `再逐步撤销 ${steps} 次:框回到铺满`, { frame: s.frame, steps });

  /* P5 不透明度、淡入淡出 */
  r0 = await projectRef();
  await setRange('[data-pc="cut-segment-opacity"]', 0.6);
  await typeInto('[data-pc="cut-segment-fadein"]', 1);
  await typeInto('[data-pc="cut-segment-fadeout"]', 0.5);
  s = await seg();
  const p8d = !(await sameRef(r0));
  check('P5', s.opacity === 0.6 && s.fadeIn === 1 && s.fadeOut === 0.5, '不透明度 0.6、淡入 1、淡出 0.5', { opacity: s.opacity, fadeIn: s.fadeIn, fadeOut: s.fadeOut });
  await panelShot('05-opacity-fades');
  await undo();
  s = await seg();
  check('P5u', s.fadeOut !== 0.5 && s.fadeIn === 1, '撤销一次:淡出回去,淡入留着', { fadeIn: s.fadeIn, fadeOut: s.fadeOut });

  /* P6 音量、静音 */
  r0 = await projectRef();
  await setRange('[data-pc="cut-segment-volume"]', 0.4);
  await page.click('[data-pc="cut-segment-muted"]');
  await sleep(300);
  s = await seg();
  const p8e = !(await sameRef(r0));
  check('P6', s.audioVolume === 0.4 && s.audioMuted === true, '音量 0.4、静音', { audioVolume: s.audioVolume, audioMuted: s.audioMuted });
  await panelShot('06-volume-muted');
  await undo();
  s = await seg();
  check('P6u', !s.audioMuted && s.audioVolume === 0.4, '撤销一次:静音取消,音量留着', { audioVolume: s.audioVolume, audioMuted: s.audioMuted });

  /* P7 偏移超出 */
  r0 = await projectRef();
  await typeInto('[data-pc="cut-segment-offset"]', 9);
  const err = await page.evaluate(() => document.querySelector('[data-pc="cut-segment-error"]')?.textContent ?? null);
  s = await seg();
  check('P7', (await sameRef(r0)) && /超出/.test(err ?? '') && (s.cutOffset ?? 0) === 0, '偏移 9 秒超出剪辑2 的 6 秒:项目不动,面板写明原因', { err, cutOffset: s.cutOffset });
  await page.evaluate(() => document.querySelector('[data-pc="cut-segment-error"]')?.scrollIntoView({ block: 'end' }));
  await sleep(200);
  await panelShot('07-offset-error');

  check('P8', p8a && p8c && p8d && p8e, '每次改动都换了新的项目对象', { p8a, p8c, p8d, p8e });

  /* P9 打开被引用剪辑 */
  await page.click('[data-pc="cut-segment-open"]');
  await sleep(800);
  const st = await page.evaluate(() => ({ active: window.__pcStore.getState().project.activeCutId, tabs: [...document.querySelectorAll('[data-pc-cut-tab]')].map((el) => ({ id: el.getAttribute('data-pc-cut-tab'), on: el.classList.contains('is-on') })) }));
  check('P9', st.active === ids.c2 && st.tabs.some((t) => t.id === ids.c2 && t.on), '「打开被引用剪辑」:激活剪辑2,标签栏里它的标签亮着', st);
  await shot('09-open-referenced');
  await page.evaluate((root) => window.__pcStore.actions.switchCut(root), ids.root);
  await sleep(500);

  /* L1 素材库剪辑格子 */
  const libShown = await page.evaluate(() => { const el = document.querySelector('[data-pc="library"]'); return !!el && el.getBoundingClientRect().width > 0; });
  if (!libShown) await page.evaluate(() => document.querySelector('[data-pc-rail="library"]')?.click());
  await sleep(600);
  // 一张图片素材,拿它详情格子的标题字号作对照(和视频格子同一个标题条 `.pc-lib-card-title`)
  await page.evaluate(() => window.__pcStore.actions.addMedia({ kind: 'image', name: '对照图片.svg', url: '/favicon.svg', width: 64, height: 64 }));
  await sleep(600);
  await page.evaluate(() => document.querySelector('[data-pc-group="cuts"]')?.scrollIntoView());
  await sleep(400);
  const overview = await page.evaluate(() => [...document.querySelectorAll('[data-pc-group="cuts"] .pc-lib-cut-name')].map((el) => ({ t: el.textContent, fs: parseFloat(getComputedStyle(el).fontSize), h: el.getBoundingClientRect().height })));
  const gbox = await page.evaluate(() => { const b = document.querySelector('[data-pc-group="cuts"]').getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; });
  await page.screenshot({ path: path.join(OUT, 'L1-overview-cuts-group.png'), clip: { x: gbox.x - 4, y: gbox.y - 4, width: gbox.w + 8, height: gbox.h + 8 } });
  await page.evaluate(() => document.querySelector('[data-pc-group="images"]')?.click());
  await sleep(800);
  const videoTitle = await page.evaluate(() => { const el = document.querySelector('.pc-lib-card-title'); return el ? { t: el.textContent, fs: parseFloat(getComputedStyle(el).fontSize), h: el.getBoundingClientRect().height } : null; });
  await shot('L1-image-detail');
  // 回总览,开剪辑组详情
  await page.evaluate(() => document.querySelector('[data-pc-category="all"]')?.click());
  await sleep(400);
  await page.evaluate(() => { const c = document.querySelector('[data-pc-group="cuts"]'); if (c) c.click(); else document.querySelector('[data-pc-cat-chip="cuts"], [data-pc-group-chip="cuts"]')?.click(); });
  await sleep(800);
  const detail = await page.evaluate(() => [...document.querySelectorAll('[data-pc-lib-cut] .pc-lib-cut-name')].map((el) => ({ t: el.textContent, fs: parseFloat(getComputedStyle(el).fontSize), h: el.getBoundingClientRect().height })));
  await shot('L1-detail-cuts');
  const ref = videoTitle?.fs ?? 11.5;
  check('L1', overview.length >= 2 && overview.every((n) => n.h >= 14 && n.fs >= ref) && detail.length >= 3 && detail.every((n) => n.h >= 14 && n.fs >= ref),
    `剪辑名在总览缩略与详情格子里都完整一行,字号不小于图片 / 视频格子的标题(${ref}px)`, { overview, detail, videoTitle });

  check('E0', errors.length === 0, '页面零报错', errors);
} finally {
  await browser.close();
}
console.log(JSON.stringify({ ok: fails.length === 0, results, fails }));
process.exit(fails.length ? 1 : 0);
