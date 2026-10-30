/**
 * 手机版接业务层的验收探针(任务书 `docs/plan/mobile-online-task.md` 的 M3)。
 * 全程在本机:本机托管组合(文档服务 + 素材服务)+ 仿 nginx 的代理(`lib/mobile-env.mjs`),在线构建当页面。
 *
 *   npx vite build --mode online
 *   node scripts/probes/mobile-business-probe.mjs [--dist dist-online] [--out <目录>] [--base-port 5840] [--base2-port 5845] [--doc-port 5848] [--asset-port 5849]
 *
 * 用手机界面(安卓仿真、触屏)对一个真项目逐项操作,每一项都看 store 里的项目变没变对:
 *   选中、seek、播放;换序、改时长、分割、复制、删除;撤销 / 重做;加素材(经素材库导入)、加卡片、加文字、加 / 换转场;
 *   切 / 建剪辑;引用进 Agent(输入框上方的引用标记条);导出(手机没有「另存为」,攒成文件下载)。
 * 然后用桌面界面(桌面仿真)打开同一个项目,项目内容和手机这边一致;手机页刷新后内容仍在。
 * 手机界面里不出现演示稿的假数据(示例名字)。结果最后一行是一行 JSON。
 */
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { startMobileEnv, emptyProject, solidPng } from './lib/mobile-env.mjs';

const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = path.resolve(arg('--dist', path.join(ROOT, 'dist-online')));
const OUT = path.resolve(arg('--out', path.join(os.tmpdir(), 'mobile-business')));
const DL = path.join(OUT, 'downloads');
fs.rmSync(DL, { recursive: true, force: true });
fs.mkdirSync(DL, { recursive: true });

const fails = [];
const out = { ok: false, out: OUT, steps: {} };
const step = (k, v) => { out.steps[k] = v; };
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 400))); return !!cond; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = 15_000, every = 200) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) { fails.push(`等不到:${what}`); return null; }
    await sleep(every);
  }
}
const shot = (page, name) => page.screenshot({ path: path.join(OUT, `${name}.png`) }).catch(() => {});
const rect = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; e.scrollIntoView({ block: 'nearest', inline: 'nearest' }); const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }, sel);
const tap = async (page, sel) => { const r = await rect(page, sel); if (!r) throw new Error(`点不到 ${sel}`); await page.touchscreen.tap(r.x + r.w / 2, r.y + r.h / 2); await sleep(300); };
const tapText = async (page, scope, label) => {
  const r = await page.evaluate((s, l) => { const b = [...document.querySelectorAll(`${s} button`)].find((x) => x.textContent.trim() === l); if (!b) return null; const q = b.getBoundingClientRect(); return { x: q.x + q.width / 2, y: q.y + q.height / 2 }; }, scope, label);
  if (!r) throw new Error(`点不到「${label}」`);
  await page.touchscreen.tap(r.x, r.y);
  await sleep(300);
};
/** 关掉最上面那个底部面板(点它头部的 ✕;遮罩中心常被面板自己盖住) */
const closeSheet = async (page) => {
  const r = await page.evaluate(() => { const bs = [...document.querySelectorAll('.sheet-head button[aria-label="关闭"]')]; const b = bs[bs.length - 1]; if (!b) return null; const q = b.getBoundingClientRect(); return { x: q.x + q.width / 2, y: q.y + q.height / 2 }; });
  if (r) { await page.touchscreen.tap(r.x, r.y); await sleep(400); }
};
const store = (page, src, ...a) => page.evaluate((s, a2) => new Function('S', 'args', s)(window.__pcStore, a2), src, a);
async function touch(page, steps, { holdMs = 0, stepMs = 16 } = {}) {
  const send = (type, pts) => page.cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, i) => ({ x: p.x, y: p.y, id: i + 1 })) });
  await send('touchStart', steps[0]);
  if (holdMs) await sleep(holdMs);
  for (const pts of steps.slice(1)) { await send('touchMove', pts); await sleep(stepMs); }
  await send('touchEnd', []);
  await sleep(300);
}
const lerp = (a, b, n) => Array.from({ length: n + 1 }, (_, i) => [{ x: a.x + (b.x - a.x) * i / n, y: a.y + (b.y - a.y) * i / n }]);
/** 项目里和内容有关的部分(比对手机与桌面、刷新前后用) */
const digest = (page) => store(page, `
  const p = S.getState().project;
  const tracks = (p.tracks ?? []).map((t) => ({ id: t.id, clips: t.clips.map((c) => ({ id: c.id, start: +c.start.toFixed(3), end: +c.end.toFixed(3), cardId: c.cardId || null, mediaId: c.mediaId || null, cutId: c.cutId || null })) }));
  return JSON.stringify({ name: p.name, activeCutId: p.activeCutId ?? null, cuts: (p.cuts ?? []).map((c) => c.id), media: p.media.map((m) => m.id).sort(), tracks, transitions: (p.transitions ?? []).map((t) => [t.kind, t.aId, t.bId ?? null]) });`);
const allClips = (page) => store(page, 'return S.getState().project.tracks.flatMap((t) => t.clips.map((c) => ({ id: c.id, track: t.id, start: c.start, end: c.end, cardId: c.cardId, mediaId: c.mediaId ?? null })));');
const mainIds = (page) => page.$$eval('[data-pcm="mblock"]', (bs) => bs.map((b) => b.dataset.id));
const page_ = (p) => p.evaluate(() => document.querySelector('[data-pcm="editor"]')?.getAttribute('data-page'));

const NAME = `m3-${Date.now().toString(36)}`;
const env = await startMobileEnv({
  dist: DIST, basePort: Number(arg('--base-port', 5840)), base2Port: Number(arg('--base2-port', 5845)),
  docPort: Number(arg('--doc-port', 5848)), assetPort: Number(arg('--asset-port', 5849)), name: NAME,
});
const seeded = await env.seed({ ...emptyProject(NAME), name: NAME });
check(!/error|reject/i.test(`${seeded.opened}${seeded.seeded}`), '替创建者写进初始项目', seeded);
const browser = await puppeteer.launch({ headless: true, protocolTimeout: 600_000, args: [...PROBE_CHROME_ARGS, '--no-first-run', '--autoplay-policy=no-user-gesture-required'] });
try {
  const A = await env.newPage(browser, 'phone');
  // 手机浏览器没有「另存为」(showSaveFilePicker):导出攒成文件下载
  await A.evaluateOnNewDocument(() => { try { delete window.showSaveFilePicker; } catch { /* */ } window.showSaveFilePicker = undefined; });
  // 下载落到 DL:浏览器级会话按这个页面所在的上下文设(页面级的设置对新开的上下文不生效)
  const bcdp = await browser.target().createCDPSession();
  await bcdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL, browserContextId: A.browserContext().id, eventsEnabled: true });
  await env.enter(A, { username: 'jia' });
  await A.waitForSelector('[data-pcm="editor"]', { visible: true });

  /* ---------------- 加素材:素材库导入三张图,点一下接到主要内容末尾 ---------------- */
  const imgs = [];
  for (const [i, rgb] of [[1, [200, 60, 50]], [2, [40, 160, 90]], [3, [50, 90, 200]]]) imgs.push(await solidPng(path.join(OUT, `img-${i}.png`), rgb));
  await tap(A, '[data-pcm="sub-image"]');
  await (await A.waitForSelector('[data-pcm="import-input"]')).uploadFile(...imgs);
  const tiles = await until('三张图进素材库', async () => { const n = (await A.$$('[data-pcm="asset"]')).length; return n >= 3 ? n : null; }, 60_000, 300);
  const media0 = await store(A, 'return S.getState().project.media.map((m) => ({ id: m.id, kind: m.kind, name: m.name, hash: m.hash ?? null }));');
  for (let i = 0; i < 3; i++) {
    if (!(await A.$('[data-pcm="sheet-assets"]'))) await tap(A, '[data-pcm="sub-image"]');
    await A.waitForSelector('[data-pcm="asset"]', { visible: true });
    await tap(A, `[data-pcm="asset"]:nth-of-type(${i + 1})`);
  }
  const ids0 = await until('主要内容三段', async () => { const ids = await mainIds(A); return ids.length === 3 ? ids : null; }, 15_000);
  step('addMedia', { tiles, media: media0, main: ids0 });
  check(media0.length === 3 && media0.every((m) => m.kind === 'image' && m.hash), '加素材:导入进项目(有内容哈希)', media0);
  check(ids0?.length === 3, '加素材:三段接到主要内容');

  /* ---------------- 选中、seek、播放 ---------------- */
  await tap(A, `[data-pcm="mblock"][data-id="${ids0[0]}"]`);
  const sel = await store(A, 'return S.getState().selection;');
  step('select', sel);
  check(sel[0] === ids0[0], '选中:点缩略卡 → store 选中这一段', sel);
  await tap(A, '.mainhead');
  const t0 = await store(A, 'return S.getState().t;');
  const strip = await rect(A, '.strip-scroll');
  await touch(A, lerp({ x: strip.x + 300, y: strip.y + 40 }, { x: strip.x + 120, y: strip.y + 40 }, 10));
  const t1 = await store(A, 'return S.getState().t;');
  step('seek', { t0, t1 });
  check(t1 > t0 + 0.5, 'seek:按住缩略时间轴往左拖 → 当前时间往后走', { t0, t1 });
  await tap(A, '[data-pcm="play"]');
  const playing = await until('播放', () => store(A, 'return S.getState().playing;'), 5000);
  await sleep(800);
  await tap(A, '[data-pcm="play"]');
  const after = await store(A, 'return { playing: S.getState().playing, t: S.getState().t };');
  step('play', { playing, after });
  check(!!playing && after.playing === false, '播放 / 暂停', { playing, after });

  /* ---------------- 换序 ---------------- */
  await store(A, 'const c = S.getState().project.tracks.flatMap((t) => t.clips).find((x) => x.id === args[0]); S.actions.seek((c.start + c.end) / 2); return true;', ids0[1]);
  await sleep(400);
  await tap(A, `[data-pcm="mblock"][data-id="${ids0[2]}"]`);
  const r3 = await rect(A, `[data-pcm="mblock"][data-id="${ids0[2]}"]`), r1 = await rect(A, `[data-pcm="mblock"][data-id="${ids0[0]}"]`);
  await touch(A, lerp({ x: r3.x + r3.w / 2, y: r3.y + r3.h / 2 }, { x: r1.x + 4, y: r3.y + r3.h / 2 }, 12), { holdMs: 450 });
  const ids1 = await until('换序落地', async () => { const ids = await mainIds(A); return ids[0] === ids0[2] ? ids : null; }, 8000);
  step('reorder', ids1);
  check(JSON.stringify(ids1) === JSON.stringify([ids0[2], ids0[0], ids0[1]]), '换序:长按拖动 → 项目里三段的起点换了', ids1);
  const undoReorder = await store(A, 'S.actions.undo(); return true;');
  const idsUndo = await until('撤销换序一步到位', async () => { const ids = await mainIds(A); return ids[0] === ids0[0] ? ids : null; }, 5000);
  check(JSON.stringify(idsUndo) === JSON.stringify(ids0), '撤销:换序整次一步撤回', idsUndo);
  await tap(A, '[data-pcm="redo"]');
  const idsRedo = await until('重做换序', async () => { const ids = await mainIds(A); return ids[0] === ids0[2] ? ids : null; }, 5000);
  step('reorderUndoRedo', { undo: idsUndo, redo: idsRedo, undoReorder });
  check(JSON.stringify(idsRedo) === JSON.stringify(ids1), '重做:换序回来', idsRedo);

  /* ---------------- 时间轴分页:改时长(拖右手柄)、分割、复制、删除 ---------------- */
  await tap(A, '[data-pcm="pg-timeline"]');
  await A.waitForSelector('[data-pcm="full-timeline"]', { visible: true });
  await sleep(400);
  const target = ids1[2]; // 主轨最后一段:往回拖右手柄
  const before = (await allClips(A)).find((c) => c.id === target);
  await tap(A, `[data-pcm="clip"][data-id="${target}"]`);
  const hr = await A.evaluate((id) => { const h = document.querySelector(`[data-pcm="clip"][data-id="${id}"] .h.r`).getBoundingClientRect(); return { x: h.x + h.width / 2, y: h.y + h.height / 2 }; }, target);
  const px = await A.$eval('.tl-inner', (e) => Number(e.dataset.px));
  await touch(A, lerp(hr, { x: hr.x - 2 * px, y: hr.y }, 10));
  const trimmed = await until('改时长落地', async () => { const c = (await allClips(A)).find((x) => x.id === target); return c && Math.abs((c.end - c.start) - (before.end - before.start - 2)) < 0.26 ? c : null; }, 5000);
  step('trim', { before, after: trimmed, px });
  check(!!trimmed, '改时长:拖右手柄短 2 秒(吸附 0.5 秒)', { before, trimmed });
  // 分割:播放头放到这段中间
  await store(A, 'const c = S.getState().project.tracks.flatMap((t) => t.clips).find((x) => x.id === args[0]); S.actions.seek((c.start + c.end) / 2); return true;', target);
  await sleep(300);
  const n0 = (await allClips(A)).length;
  await tapText(A, '[data-pcm="subnav-timeline"]', '分割');
  const n1 = (await allClips(A)).length;
  await tapText(A, '[data-pcm="subnav-timeline"]', '复制');
  const n2 = (await allClips(A)).length;
  await tapText(A, '[data-pcm="subnav-timeline"]', '删除');
  await tap(A, '[data-pcm="confirm-ok"]');
  const n3 = (await allClips(A)).length;
  await tap(A, '[data-pcm="undo"]');
  const n4 = (await allClips(A)).length;
  await tap(A, '[data-pcm="redo"]');
  const n5 = (await allClips(A)).length;
  step('splitDupDel', { n0, split: n1, dup: n2, del: n3, undo: n4, redo: n5 });
  check(n1 === n0 + 1, '分割:播放头处切成两段', { n0, n1 });
  check(n2 === n1 + 1, '复制:多一段', { n1, n2 });
  check(n3 === n2 - 1, '删除(确认后):少一段', { n2, n3 });
  check(n4 === n3 + 1 && n5 === n3, '撤销 / 重做删除', { n3, n4, n5 });
  await shot(A, 'm3-timeline-edits');

  /* ---------------- 加卡片、加文字 ---------------- */
  await tap(A, '[data-pcm="tl-done"]');
  await store(A, 'S.actions.seek(1); return true;');
  const cardsBefore = (await allClips(A)).filter((c) => c.cardId).length;
  await tap(A, '[data-pcm="sub-card"]');
  await A.waitForSelector('[data-pcm="card"]', { visible: true });
  const cardId = await A.$eval('[data-pcm="card"]', (b) => b.dataset.card);
  await tap(A, '[data-pcm="card"]');
  const afterCard = await until('卡片加进时间轴', async () => { const c = (await allClips(A)).filter((x) => x.cardId); return c.length === cardsBefore + 1 ? c : null; }, 5000);
  const pageAfterCard = await page_(A);
  await tap(A, '[data-pcm="tl-done"]');
  await tap(A, '[data-pcm="sub-text"]');
  await A.waitForSelector('[data-pcm="card"]', { visible: true });
  const textId = await A.$eval('[data-pcm="card"]', (b) => b.dataset.card);
  await tap(A, '[data-pcm="card"]');
  const afterText = await until('文字卡加进时间轴', async () => { const c = (await allClips(A)).filter((x) => x.cardId); return c.length === cardsBefore + 2 ? c : null; }, 5000);
  const textParams = await store(A, 'const c = S.getState().project.tracks.flatMap((t) => t.clips).find((x) => x.cardId === args[0]); return c ? Object.keys(c.params ?? {}) : null;', textId);
  step('cards', { cardId, textId, pageAfterCard, card: afterCard?.find((c) => c.cardId === cardId), textParams });
  check(!!afterCard && afterCard.some((c) => c.cardId === cardId && Math.abs(c.start - 1) < 0.05), '加卡片:落在播放头位置', afterCard);
  check(pageAfterCard === 'timeline', '加卡片后进时间轴分页并选中它', pageAfterCard);
  check(!!afterText && afterText.some((c) => c.cardId === textId), '加文字:文字卡加进时间轴', afterText);
  // 改文字:调整面板里改「文字」参数
  await tapText(A, '[data-pcm="subnav-timeline"]', '样式');
  const textInput = await A.waitForSelector('[data-pcm="param-text"]', { visible: true, timeout: 5000 }).catch(() => null);
  let textValue = null;
  if (textInput) {
    await textInput.evaluate((el) => { el.focus(); el.select(); });
    await textInput.type('手机版改的字');
    await A.keyboard.press('Enter');
    await sleep(400);
    textValue = await store(A, 'const c = S.getState().project.tracks.flatMap((t) => t.clips).find((x) => x.cardId === args[0]); return c?.params?.text ?? null;', textId);
  }
  step('editText', textValue);
  check(textValue === '手机版改的字', '调整面板:改文字卡的文字', textValue);
  await closeSheet(A);
  await tap(A, '[data-pcm="tl-done"]');

  /* ---------------- 加 / 换转场 ---------------- */
  await A.evaluate(() => { document.querySelector('.strip-scroll').scrollLeft = 0; });
  await sleep(200);
  await tap(A, '[data-pcm="mark-add"]');
  await tap(A, '[data-pcm="transition-kind"][data-kind="crossfade"]');
  const tr1 = await until('交叉溶解', () => store(A, 'const t = S.getState().project.transitions ?? []; return t.length ? t : null;'), 5000);
  await tap(A, '[data-pcm="mark"]');
  await tapText(A, '[data-pcm="subnav-preview"]', '换转场');
  await tap(A, '[data-pcm="transition-kind"][data-kind="fadeOut"]');
  const tr2 = await until('换成淡出', () => store(A, 'const t = S.getState().project.transitions ?? []; return t.length === 1 && t[0].kind === "fadeOut" ? t : null;'), 5000);
  step('transitions', { added: tr1, swapped: tr2 });
  check(tr1?.[0]?.kind === 'crossfade', '加转场:两段之间加上交叉溶解', tr1);
  check(tr2?.[0]?.kind === 'fadeOut', '换转场:交叉溶解换成淡出(一处)', tr2);
  await tap(A, '.mainhead');

  /* ---------------- 切 / 建剪辑 ---------------- */
  const cut0 = await store(A, 'return S.getState().project.activeCutId;');
  await tap(A, '[data-pcm="sub-cut"]');
  await tap(A, '[data-pcm="cut-new"]');
  const cut1 = await store(A, 'const p = S.getState().project; return { active: p.activeCutId, cuts: p.cuts.map((c) => c.id) };');
  const emptyMain = (await mainIds(A)).length;
  await tap(A, '[data-pcm="sub-cut"]');
  await tap(A, `[data-pcm="cut-row"][data-cut="${cut0}"]`);
  const cut2 = await store(A, 'return S.getState().project.activeCutId;');
  const backMain = (await mainIds(A)).length;
  step('cuts', { cut0, cut1, emptyMain, cut2, backMain });
  check(cut1.active !== cut0 && cut1.cuts.includes(cut1.active) && emptyMain === 0, '建剪辑:新建并切过去,缩略时间轴换成空的', cut1);
  check(cut2 === cut0 && backMain >= 3, '切剪辑:切回「剪辑 1」,主要内容回来', { cut2, backMain });

  /* ---------------- 引用进 Agent ---------------- */
  await A.evaluate(() => { window.__quotes = []; window.addEventListener('pc-quote-clip', (e) => window.__quotes.push(e.detail)); });
  const refId = (await mainIds(A))[0];
  await tap(A, `[data-pcm="mblock"][data-id="${refId}"]`);
  await tapText(A, '[data-pcm="subnav-preview"]', '引用');
  const quotes = await until('引用事件', async () => { const q = await A.evaluate(() => window.__quotes); return q.length ? q : null; }, 5000);
  // 引用不再往输入框里插字(2026-10-22 起):放进输入框上方的引用标记条,发送时才带上
  await until('引用标记条出现', () => A.$('[data-pcm="refbar"]'), 5000);
  const composer = await A.evaluate(() => ({ input: document.querySelector('[data-pcm="pane-agent"] textarea')?.value ?? null, chip: document.querySelector('[data-pcm="refbar"] [data-pcm="ref-chip"]')?.textContent?.replace(/✕$/, '').trim() ?? null }));
  step('quote', { page: await page_(A), quotes, composer });
  check((await page_(A)) === 'agent' && quotes?.[0]?.clipId === refId, '引用:切到 Agent 分页并把这一段带进对话', { quotes });
  check(composer.input === '' && composer.chip === `@ ${quotes?.[0]?.label}`, '引用:输入框上方出现引用标记条(标记是「@ 名字」),输入框里没被插字', composer);
  await shot(A, 'm3-agent-quote');
  await tap(A, '[data-pcm="top-back"]');

  /* ---------------- 导出 ---------------- */
  await tap(A, '[data-pcm="top-export"]');
  await tap(A, '[data-pcm="export-start"][data-mode="full"]');
  const done = await until('导出结束', () => A.evaluate(() => { const e = document.querySelector('[data-pcm="export-progress"]'); const ph = e?.getAttribute('data-phase'); return ph && ph !== 'running' ? { phase: ph, text: e.textContent } : null; }), 420_000, 1000);
  await until('下载落盘', () => fs.readdirSync(DL).some((f) => f.endsWith('.mp4')), 30_000, 500);
  const files = fs.readdirSync(DL).filter((f) => !f.endsWith('.crdownload'));
  const mp4 = files.find((f) => f.endsWith('.mp4'));
  step('export', { done, files, bytes: mp4 ? fs.statSync(path.join(DL, mp4)).size : 0 });
  check(done?.phase === 'done' && !!mp4 && fs.statSync(path.join(DL, mp4)).size > 10_000, '导出:在浏览器里导出成 mp4 并下载', { done, files });
  await shot(A, 'm3-export');
  await closeSheet(A);

  /* ---------------- 没有假数据 ---------------- */
  const fake = await A.evaluate(() => { const t = document.body.innerText; return ['海浪远景', '沙滩奔跑', '小林', '轻松吉他', '夏日海边', '演示', '假的'].filter((w) => t.includes(w)); });
  step('noFake', fake);
  check(fake.length === 0, '手机界面里没有演示稿的假数据', fake);

  /* ---------------- 桌面界面打开同一个项目:内容一致 ---------------- */
  await sleep(1500);
  const dA = await digest(A);
  const D = await env.newPage(browser, 'desktop');
  await env.enter(D, { via: 2, username: 'yi' });
  await until('桌面页的时间轴', () => D.evaluate(() => !!window.__pcStore), 30_000);
  const dD = await until('桌面页内容同步过来', async () => { const d = await digest(D); return d === dA ? d : null; }, 30_000, 500);
  const desktopUi = await D.evaluate(() => ({ desktop: !!document.querySelector('[data-pc="editor"]'), mobile: !!document.querySelector('[data-pc="mobile-ui"]') }));
  step('desktop', { same: dD === dA, desktopUi, digest: JSON.parse(dA) });
  check(dD === dA && desktopUi.desktop && !desktopUi.mobile, '桌面界面打开同一个项目:内容和手机改的一致', { desktopUi });
  await shot(D, 'm3-desktop');
  await D.browserContext().close();

  /* ---------------- 刷新后仍在 ---------------- */
  await A.reload({ waitUntil: 'domcontentloaded' });
  await A.waitForSelector('[data-pcm="editor"]', { visible: true, timeout: 90_000 });
  const dR = await until('刷新后内容回来', async () => { const d = await digest(A); return d === dA ? d : null; }, 30_000, 500);
  step('reload', { same: dR === dA });
  check(dR === dA, '刷新后改动都还在', { before: dA.slice(0, 200), after: (await digest(A)).slice(0, 200) });
  await shot(A, 'm3-after-reload');
  out.pageErrors = A.errors;
  out.consoleErrors = A.consoleErrors;
  out.badResponses = A.badResponses;
  check(A.errors.length === 0, '手机页没有未捕获的错误', A.errors);
} catch (e) {
  fails.push(`探针异常:${e?.stack ?? e}`);
} finally {
  out.ok = fails.length === 0;
  out.fails = fails;
  await browser.close().catch(() => {});
  await env.close();
  console.log(JSON.stringify(out));
  process.exit(out.ok ? 0 : 1);
}
