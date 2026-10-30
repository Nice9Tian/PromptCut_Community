/**
 * 编辑面板数字框与滑块的提交时机探针(`docs/archive/agent-reports/AGENT-number-input-undo.md`;语义 workflow/editing.md「撤销、重做」2026-10-20 用户定)。
 * 真的打开编辑台,在剪辑段属性面板的「不透明度」滑块和数字框上敲字、按键、拖动,核对 store 与撤销栈,逐步截图。
 * 页面连着 dev server 自带的文档服务,所以走的是文档服务的提交与撤销(不是快照栈)。
 *
 *   node scripts/probes/number-input-undo-probe.mjs --origin http://127.0.0.1:5390 --out <截图目录>
 *
 * dev server 要先起好(三个连号端口都空着;不碰 5190～5192)。
 *
 * 断言(每条一行 PASS/FAIL,最后一行打一行 JSON,有失败退出码 1):
 *   N1 数字框把 1 改成 0.3:敲「0」「.」「3」每一键后项目里的不透明度都没动、一次提交也没有(中间的 0 不落进项目,剪辑段不会变透明);
 *      回车后恰好一次提交 0.3;撤销一次回到 1
 *   N2 Esc 放弃草稿:不提交,框里显示回原值
 *   N3 空值 / 半截值失焦:不提交,框里显示回原值
 *   N4 失焦(点别处)提交一次;撤销一次回到原值
 *   N5 回车后 Ctrl+Z 马上能撤(回车让框失焦,全局撤销快捷键才不被输入框挡住)
 *   N6 方向键连续步进:每一下立即提交,连按并成一步撤销;停顿超过窗口后再按另起一步
 *   N7 滑块一次拖动(中途停顿 400 ms):撤销栈只一步;拖动中提交条数被限速(远少于指针移动次数);松手后项目里是最后的值
 *   N8 滑块键盘连按并成一步撤销
 *   N9 整个过程中不透明度从未被提交为 0
 *   M1 卡片段「开始 / 结束」数字框(Inspector):敲字不提交,回车提交一次,撤销一次回原值
 *   M2 卡片参数面板的数字框(ParamsForm):同上
 *   M3 参数名上左右拖动微调(ParamsForm):一次拖动一步撤销,提交被限速
 *   M4 三维面板(Frame3DForm)的滑块一次拖动一步撤销、数字框回车才提交
 *   M5 素材段的滤镜参数数字框(ClipFilterForm):敲字时项目不动,回车提交一次,撤销一次回原值
 *   E0 页面零报错
 */
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import fs from 'node:fs';
import path from 'node:path';

setTimeout(() => { console.error('SCRIPT_TIMEOUT'); process.exit(124); }, 10 * 60_000).unref();
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const ORIGIN = arg('--origin', 'http://127.0.0.1:5390');
const OUT = path.resolve(arg('--out', 'out/number-input-undo'));
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = {};
const fails = [];
const check = (key, cond, note, extra) => {
  results[key] = { ok: !!cond, note, ...(extra !== undefined ? { extra } : {}) };
  if (!cond) fails.push(`${key}: ${note}${extra !== undefined ? ' :: ' + JSON.stringify(extra).slice(0, 400) : ''}`);
  console.log(`${cond ? 'PASS' : 'FAIL'} ${key} ${note}${!cond && extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 400) : ''}`);
};

const NUM = '[data-pc="cut-segment-opacity-num"]';
const RANGE = '[data-pc="cut-segment-opacity"]';

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

  /* 准备:剪辑2(一张卡 0～6 秒),剪辑1 里 1 秒处一个引用剪辑2 的剪辑段 */
  const ids = await page.evaluate(() => {
    const a = window.__pcStore.actions;
    a.newProject('数字框撤销');
    const c2 = a.addCut('剪辑2', { switchTo: true });
    a.addCardClip('punch-pill', 0, { duration: 6, params: { text: '剪辑二' } });
    a.setProjectMeta({ duration: 6 });
    const root = window.__pcStore.getState().project.cuts[0].id;
    a.switchCut(root);
    a.select([]);
    const seg = a.addCutSegment(c2.id, 1, {});
    a.select([]);
    a.seek(2); // 播放头放进剪辑段里,舞台上看得到它(截图证明敲「0」时它没变透明)
    // 记下每一次 updateClip 调用(面板的不透明度每提交一次就调一次)
    window.__calls = [];
    window.__all = [];
    const orig = a.updateClip.bind(a);
    a.updateClip = (id, patch) => { window.__calls.push({ patch, t: performance.now() }); window.__all.push(patch.opacity); return orig(id, patch); };
    return { root, c2: c2.id, seg: seg.id };
  });
  await sleep(800);
  const seg = () => page.evaluate((id) => window.__pcStore.getState().project.tracks.flatMap((t) => t.clips).find((c) => c.id === id) ?? null, ids.seg);
  const opacity = async () => (await seg()).opacity ?? 1;
  const calls = () => page.evaluate(() => window.__calls.map((c) => c.patch.opacity));
  const resetCalls = () => page.evaluate(() => { window.__calls.length = 0; });
  const boxText = () => page.$eval(NUM, (el) => el.value);
  const undo = async () => { await page.evaluate(() => window.__pcStore.actions.undo()); await sleep(250); };
  const focusBox = async () => { await page.click(NUM, { clickCount: 3 }); };
  const clearBox = async () => { await focusBox(); await page.keyboard.press('Backspace'); };

  const segEl = await page.$(`[data-pc-cut-segment="${ids.c2}"]`);
  if (segEl) await segEl.click();
  await sleep(400);
  const editShown = await page.evaluate(() => { const el = document.querySelector('[data-pc="inspector"]'); return !!el && el.getBoundingClientRect().width > 0; });
  if (!editShown) await page.evaluate(() => document.querySelector('[data-pc-rail="edit"]')?.click());
  await sleep(800);
  await page.waitForSelector(NUM, { timeout: 20_000 });
  await shot('00-panel');

  /* N1 数字框 1 → 0.3 */
  await resetCalls();
  await clearBox();
  const trace = [];
  for (const key of ['0', '.', '3']) {
    await page.keyboard.press(key);
    await sleep(120);
    trace.push({ key, box: await boxText(), stored: await opacity(), calls: (await calls()).length });
    if (key === '0') await shot('01-typing-0-stage-still-visible');
  }
  await panelShot('02-typing-0.3-not-committed');
  const noneYet = trace.every((x) => x.stored === 1 && x.calls === 0);
  await page.keyboard.press('Enter');
  await sleep(400);
  const afterEnter = { calls: await calls(), stored: await opacity(), box: await boxText() };
  await panelShot('03-after-enter');
  await shot('03b-after-enter-stage');
  await undo();
  const afterUndo = await opacity();
  check('N1', noneYet && afterEnter.calls.length === 1 && afterEnter.calls[0] === 0.3 && afterEnter.stored === 0.3 && afterUndo === 1,
    '敲「0」「.」「3」期间项目里的不透明度一直是 1、零次提交;回车后恰好一次提交 0.3;撤销一次回到 1', { trace, afterEnter, afterUndo });

  /* N2 Esc */
  await resetCalls();
  await clearBox();
  await page.keyboard.type('0.7');
  await page.keyboard.press('Escape');
  await sleep(150);
  const escBox = await boxText();
  await page.keyboard.press('Tab');
  await sleep(250);
  check('N2', escBox === '1' && (await calls()).length === 0 && (await opacity()) === 1, 'Esc 放弃草稿:框里回到 1,失焦后也没有提交', { escBox, calls: await calls() });

  /* N3 空值 */
  await resetCalls();
  await clearBox();
  await page.keyboard.press('Tab');
  await sleep(250);
  const emptyBox = await boxText();
  await clearBox();
  await page.keyboard.type('-');
  await page.keyboard.press('Tab');
  await sleep(250);
  const halfBox = await boxText();
  check('N3', emptyBox === '1' && halfBox === '1' && (await calls()).length === 0 && (await opacity()) === 1, '空值、半截值(「-」)失焦:不提交,框里显示回 1', { emptyBox, halfBox, calls: await calls() });

  /* N4 失焦提交 */
  await resetCalls();
  await clearBox();
  await page.keyboard.type('0.6');
  await sleep(150);
  const midCalls = (await calls()).length;
  await page.click('[data-pc="cut-segment-form"] .font-semibold'); // 点别处,框失焦
  await sleep(300);
  const blurCalls = await calls();
  const blurStored = await opacity();
  await undo();
  check('N4', midCalls === 0 && blurCalls.length === 1 && blurCalls[0] === 0.6 && blurStored === 0.6 && (await opacity()) === 1, '失焦才提交一次 0.6;撤销一次回到 1', { midCalls, blurCalls, blurStored });

  /* N5 回车后 Ctrl+Z */
  await clearBox();
  await page.keyboard.type('0.4');
  await page.keyboard.press('Enter');
  await sleep(300);
  const set04 = await opacity();
  await page.keyboard.down('Control');
  await page.keyboard.press('z');
  await page.keyboard.up('Control');
  await sleep(400);
  check('N5', set04 === 0.4 && (await opacity()) === 1, '回车提交 0.4 后直接按 Ctrl+Z 撤回 1(框已失焦,全局撤销键有效)', { set04, after: await opacity() });

  /* N6 方向键步进 */
  await resetCalls();
  await page.click(NUM);
  await page.keyboard.press('ArrowDown');
  await sleep(60);
  const s1 = { calls: (await calls()).length, stored: await opacity() };
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await sleep(300);
  const s3 = { calls: (await calls()).length, stored: await opacity() };
  await page.keyboard.press('Tab');
  await undo();
  const s3u = await opacity();
  // 停顿超过窗口(1 秒)后再按:另起一步
  await page.click(NUM);
  await page.keyboard.press('ArrowDown');
  await sleep(1300);
  await page.keyboard.press('ArrowDown');
  await sleep(300);
  await page.keyboard.press('Tab');
  await undo();
  const gapAfter1 = await opacity();
  await undo();
  const gapAfter2 = await opacity();
  check('N6', s1.calls === 1 && s1.stored === 0.95 && s3.calls === 3 && Math.abs(s3.stored - 0.85) < 1e-9 && s3u === 1 && Math.abs(gapAfter1 - 0.95) < 1e-9 && gapAfter2 === 1,
    '方向键:每一下立即提交(0.95、0.9、0.85),连按撤销一次回到 1;隔了 1.3 秒再按另起一步(撤销一次只退到 0.95)', { s1, s3, s3u, gapAfter1, gapAfter2 });

  /* N7 滑块一次拖动 */
  await resetCalls();
  const box = await page.$eval(RANGE, (el) => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; });
  const y = box.y + box.h / 2;
  const thumbX = box.x + box.w - 6; // 值 1:手柄在最右
  await page.mouse.move(thumbX, y);
  await page.mouse.down();
  let moves = 0;
  const midShot = box.x + box.w * 0.35;
  for (let i = 0; i <= 40; i++) {
    const x = thumbX - (thumbX - box.x) * (i / 40) * 0.8;
    await page.mouse.move(x, y);
    moves++;
    await sleep(8);
    if (i === 20) { await shot('04-slider-mid-drag'); await sleep(400); } // 按住不动 400 ms,超过默认合并窗口
  }
  const duringDrag = (await calls()).length;
  await page.mouse.up();
  await sleep(400);
  const dragCalls = await calls();
  const finalVal = await opacity();
  const last = dragCalls[dragCalls.length - 1];
  await panelShot('05-slider-after-drag');
  await undo();
  const dragUndo = await opacity();
  await page.evaluate(() => window.__pcStore.actions.redo());
  await sleep(250);
  check('N7', dragCalls.length >= 2 && dragCalls.length <= 30 && dragCalls.length < moves / 2 && Math.abs(finalVal - last) < 1e-9 && finalVal < 0.5 && dragUndo === 1,
    `滑块一次拖动(${moves} 次指针移动,中途停 400 ms):提交 ${dragCalls.length} 条(限速);松手后项目里是最后的值 ${finalVal};撤销一次回到 1`, { moves, duringDrag, total: dragCalls.length, finalVal, last, dragUndo });
  await undo(); // redo 过了,再撤回 1,保证状态干净
  const back = await opacity();

  /* N8 滑块键盘 */
  await resetCalls();
  await page.focus(RANGE);
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await sleep(300);
  const keyCalls = (await calls()).length;
  const keyVal = await opacity();
  await undo();
  check('N8', back === 1 && keyCalls === 3 && keyVal < 1 && (await opacity()) === 1, '滑块方向键连按 3 下提交 3 次,撤销一次回到 1', { back, keyCalls, keyVal });

  const everCalls = await page.evaluate(() => window.__all);
  check('N9', everCalls.length > 0 && !everCalls.includes(0), `整个过程共 ${everCalls.length} 次提交,不透明度从未被提交为 0`, { everCalls: everCalls.slice(0, 12) });
  /* ---- 其它面板:卡片段的开始 / 结束、参数数字框、参数名拖动、三维面板 ---- */
  const cardId = await page.evaluate(() => {
    const a = window.__pcStore.actions;
    a.switchCut(window.__pcStore.getState().project.cuts[0].id);
    const c = a.addCardClip('blur-text', 0, { duration: 5, params: { text: '参数面板' } });
    a.select([c.id]);
    a.seek(1);
    window.__mcalls = [];
    for (const name of ['setClipParams', 'setClipFrame', 'moveClip']) {
      const orig = a[name].bind(a);
      a[name] = (...args) => { window.__mcalls.push({ name, args: JSON.stringify(args.slice(1)) }); return orig(...args); };
    }
    return c.id;
  });
  await sleep(1000);
  const clipNow = () => page.evaluate((id) => window.__pcStore.getState().project.tracks.flatMap((t) => t.clips).find((c) => c.id === id), cardId);
  const mcalls = () => page.evaluate(() => window.__mcalls.length);
  const mreset = () => page.evaluate(() => { window.__mcalls.length = 0; });
  const selectAllAndClear = async (sel) => { await page.click(sel); await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control'); await page.keyboard.press('Backspace'); };

  // M1 开始 / 结束
  await mreset();
  const end0 = (await clipNow()).end;
  await selectAllAndClear('[data-pc="clip-end"]');
  await page.keyboard.type('4.5');
  await sleep(150);
  const m1mid = { calls: await mcalls(), end: (await clipNow()).end };
  await page.keyboard.press('Enter');
  await sleep(300);
  const m1after = { calls: await mcalls(), end: (await clipNow()).end };
  await undo();
  check('M1', m1mid.calls === 0 && m1mid.end === end0 && m1after.calls === 1 && m1after.end === 4.5 && (await clipNow()).end === end0,
    '「结束」敲 4.5:敲字时零次提交,回车一次提交,撤销一次回原值', { end0, m1mid, m1after, undone: (await clipNow()).end });

  // M2 参数数字框
  const numParam = await page.evaluate(() => { const el = document.querySelector('input[type="number"][data-pc-param]'); return el ? { key: el.getAttribute('data-pc-param'), value: el.value, min: el.min, max: el.max, step: el.step } : null; });
  if (!numParam) {
    check('M2', false, '这张卡的参数面板里找不到数字框', numParam);
    check('M3', false, '找不到参数名拖动', numParam);
  } else {
    const sel = `input[type="number"][data-pc-param="${numParam.key}"]`;
    const before = (await clipNow()).params[numParam.key];
    await mreset();
    await selectAllAndClear(sel);
    const lo = numParam.min !== '' ? Number(numParam.min) : 1;
    const hi = numParam.max !== '' ? Number(numParam.max) : lo + 10;
    const target = String(Math.round((lo + hi) / 2));
    await page.keyboard.type(target);
    await sleep(150);
    const mid = { calls: await mcalls(), v: (await clipNow()).params[numParam.key] };
    await page.keyboard.press('Enter');
    await sleep(300);
    const after = { calls: await mcalls(), v: (await clipNow()).params[numParam.key] };
    await panelShot('06-params-number-after-enter');
    await undo();
    const undone = (await clipNow()).params[numParam.key];
    check('M2', mid.calls === 0 && mid.v === before && after.calls === 1 && after.v === Number(target) && undone === before,
      `参数「${numParam.key}」敲 ${target}:敲字时零次提交,回车一次提交,撤销一次回原值`, { numParam, before, mid, after, undone });

    // M3 参数名拖动
    await mreset();
    const lab = await page.$eval(`[data-pc-drag="${numParam.key}"]`, (el) => { const b = el.getBoundingClientRect(); return { x: b.x + 10, y: b.y + b.height / 2 }; });
    await page.mouse.move(lab.x, lab.y);
    await page.mouse.down();
    let mv = 0;
    for (let i = 1; i <= 30; i++) { await page.mouse.move(lab.x + i * 3, lab.y); mv++; await sleep(8); if (i === 15) await sleep(400); }
    await page.mouse.up();
    await sleep(400);
    const dragCalls = await mcalls();
    const dragged = (await clipNow()).params[numParam.key];
    await undo();
    const dragUndone = (await clipNow()).params[numParam.key];
    check('M3', dragCalls >= 2 && dragCalls < mv / 2 && dragged !== before && dragUndone === before,
      `参数名上左右拖动(${mv} 次指针移动,中途停 400 ms):提交 ${dragCalls} 条(限速),值 ${before} → ${dragged};撤销一次回 ${before}`, { dragCalls, mv, before, dragged, dragUndone });
  }

  // M4 三维面板
  await mreset();
  const rbox = await page.$eval('[data-pc="frame3d-rotateY"]', (el) => { el.scrollIntoView({ block: 'center' }); const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; });
  await sleep(200);
  const rbox2 = await page.$eval('[data-pc="frame3d-rotateY"]', (el) => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; });
  const ry = rbox2.y + rbox2.h / 2;
  const startX = rbox2.x + rbox2.w / 2; // 值 0:手柄在正中
  await page.mouse.move(startX, ry);
  await page.mouse.down();
  let rmv = 0;
  for (let i = 1; i <= 30; i++) { await page.mouse.move(startX + i * 2, ry); rmv++; await sleep(8); if (i === 15) await sleep(400); }
  await page.mouse.up();
  await sleep(400);
  const rcalls = await mcalls();
  const rval = ((await clipNow()).frame?.rotateY) ?? 0;
  await panelShot('07-frame3d-after-drag');
  await undo();
  const rundone = ((await clipNow()).frame?.rotateY) ?? 0;
  await mreset();
  const rnum = await page.evaluate(() => { const row = document.querySelector('[data-pc="frame3d-rotateY"]').parentElement; return [...row.querySelectorAll('input[type="number"]')].length; });
  const rnumSel = '[data-pc="frame3d-rotateY"] ~ input[type="number"]';
  await page.click(rnumSel, { clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.keyboard.type('30');
  await sleep(150);
  const nmid = await mcalls();
  await page.keyboard.press('Enter');
  await sleep(300);
  const nval = ((await clipNow()).frame?.rotateY) ?? 0;
  const ncalls = await mcalls();
  await undo();
  const nundone = ((await clipNow()).frame?.rotateY) ?? 0;
  check('M4', rcalls >= 2 && rcalls < rmv / 2 && rval !== 0 && rundone === 0 && rnum === 1 && nmid === 0 && ncalls === 1 && nval === 30 && nundone === 0,
    `三维:滑块一次拖动(${rmv} 次移动)提交 ${rcalls} 条、值 ${rval},撤销一次回 0;数字框敲 30 时零次提交、回车一次、撤销一次回 0`, { rcalls, rmv, rval, rundone, rnum, nmid, ncalls, nval, nundone });

  // M5 滤镜参数
  const fclip = await page.evaluate(() => {
    const a = window.__pcStore.actions;
    const m = a.addMedia({ kind: 'image', name: '图.svg', url: '/favicon.svg', width: 64, height: 64 });
    const c = a.addMediaClip(m.id, 0, { duration: 4 });
    a.addFilter({ id: 'f-probe', name: '探针亮度', params: { amount: { default: 1, min: 0, max: 3, label: '量' } }, ops: [{ kind: 'brightness', value: 'amount' }] }, { clipId: c.id, filter: { id: 'f-probe' } });
    a.select([c.id]);
    return c.id;
  });
  await sleep(1000);
  const fstored = () => page.evaluate((id) => window.__pcStore.getState().project.tracks.flatMap((t) => t.clips).find((c) => c.id === id)?.filter?.params?.amount ?? null, fclip);
  const FSEL = '[data-pc="clip-filter-param-amount"]';
  await page.waitForSelector(FSEL, { timeout: 15_000 });
  const f0 = await fstored();
  await selectAllAndClear(FSEL);
  await page.keyboard.type('2');
  await sleep(150);
  const fmid = await fstored();
  await page.keyboard.press('Enter');
  await sleep(300);
  const fafter = await fstored();
  await panelShot('08-filter-param-after-enter');
  await undo();
  const fundone = await fstored();
  check('M5', fmid === f0 && fafter === 2 && fundone === f0, '滤镜参数敲 2:敲字时项目里不动,回车一次提交,撤销一次回原值', { f0, fmid, fafter, fundone });

  check('E0', errors.length === 0, '页面零报错', errors);
} finally {
  await browser.close();
}
console.log(JSON.stringify({ ok: fails.length === 0, results, fails }));
process.exit(fails.length ? 1 : 0);
