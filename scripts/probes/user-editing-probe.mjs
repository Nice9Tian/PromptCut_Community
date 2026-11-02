/**
 * 「用户正在编辑」探针(计划 agent-workflow-plan.md A2):
 *
 *   node scripts/probes/user-editing-probe.mjs [--origin http://127.0.0.1:5770] [--shots <目录>]
 *
 * 真的打开编辑台(?editor),新项目里放一张卡,依次:
 *   U1 页面接上文档服务、Agent 服务端绑上项目副本(/api/agent/status bound);
 *   U2 在时间轴上按住这张卡拖动(不松手):页面推给服务端的编辑状态里它是「拖动中」;
 *      经 /api/mcp/call 以 Agent 身份 get_clip 读它,结果带 userEditing(drag)和「用户正在编辑」那句;读别的片段不带;
 *   U3 松手(拖动落地 = 页面改了这张卡,且它选中着):状态变成「刚动过」;
 *   U4 Agent 随后 update_clip 写它:写入照常落地(只提示不拦),结果带 overwrote「用户刚改过」和 userEditing(recent);
 *   U5 取消选中:编辑状态清空,Agent 再读不带提示。
 * 截图(--shots 给了才存):dragging.png(按住拖动时)。
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { devOrigin, flagArg } from './probe-connect.mjs';

const origin = devOrigin();
const shots = flagArg('shots', null);
if (shots) fs.mkdirSync(shots, { recursive: true });
const fails = [];
const passes = [];
const check = (cond, label, extra) => {
  (cond ? passes : fails).push(label + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''));
  return cond;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const AGENT = `ueprobe${Date.now().toString(36)}`;
const mcpCall = async (tool, args, agent = AGENT) => {
  const res = await fetch(`${origin}/api/mcp/call`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool, args, ...(agent ? { agent } : {}) }),
  });
  const j = await res.json();
  return j.ok === false ? { __error: j.error } : j.result;
};
const editingNow = async () => (await (await fetch(`${origin}/api/agent/editing`)).json()).entities ?? [];
async function waitFor(fn, ms, step = 200) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(step);
  }
}

const browser = await puppeteer.launch({ headless: true, args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(origin + '/?editor&nosetup=1', { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(async () => { const m = await import('/src/store/project.ts'); return !!m.getState().project; }, { timeout: 180000, polling: 500 });
  await page.waitForFunction(() => !document.querySelector('[data-pc="probe-gate"]'), { timeout: 120000, polling: 500 }).catch(() => {});

  /* 新项目 + 两张卡(c 被拖、d 作对照) */
  const ids = await page.evaluate(async () => {
    const m = await import('/src/store/project.ts');
    const reg = await import('/src/kernel/registry.ts');
    m.actions.newProject?.('ue-probe');
    const card = reg.allCards().find((c) => c.kind !== 'audio' && !c.id.startsWith('user'));
    const a = m.actions.addCardClip(card.id, 1, { duration: 3 });
    const b = m.actions.addCardClip(card.id, 6, { duration: 3 });
    m.actions.select([]);
    return { a: a?.id ?? null, b: b?.id ?? null, card: card.id };
  });
  check(!!ids.a && !!ids.b, 'U0 two cards placed in the new project', ids);

  /* U1 绑上项目副本(overwrote 要经文档服务) */
  const bound = await waitFor(async () => {
    const s = await (await fetch(`${origin}/api/agent/status`)).json();
    return s.bound ? s : null;
  }, 60000, 500);
  check(!!bound, 'U1 the Agent server bound the project copy', bound && { mode: bound.mode, projectId: bound.projectId });
  // 副本里有这两张卡了(页面的写入进了文档服务)
  const seen = await waitFor(async () => {
    const r = await mcpCall('get_clip', { clipId: ids.a });
    return r && !r.__error ? r : null;
  }, 30000, 500);
  check(!!seen, 'U1 the Agent can read the newly placed card', seen?.__error);

  /* U2 按住拖动(不松手) */
  await page.evaluate((id) => document.querySelector(`[data-clip-id="${id}"]`)?.scrollIntoView({ block: 'center', inline: 'center' }), ids.a);
  await sleep(300);
  const box = await page.$eval(`[data-clip-id="${ids.a}"]`, (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  const sx = box.x + Math.min(40, box.w / 2);
  const sy = box.y + box.h / 2;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  for (let i = 1; i <= 12; i += 1) { await page.mouse.move(sx + i * 5, sy); await sleep(16); }
  const dragging = await waitFor(async () => (await editingNow()).find((e) => e.clipId === ids.a && e.kind === 'drag'), 3000);
  check(!!dragging, 'U2 while the drag is held, the server records "dragging"', await editingNow());
  if (shots) await page.screenshot({ path: path.join(shots, 'dragging.png') });
  const readA = await mcpCall('get_clip', { clipId: ids.a });
  check(Array.isArray(readA?.userEditing) && readA.userEditing.some((e) => e.clipId === ids.a && e.kind === 'drag'), 'U2 when the Agent reads this card, the result carries userEditing(drag)', readA?.userEditing ?? readA);
  check(typeof readA?.notice === 'string' && readA.notice.startsWith(`User is editing clip ${ids.a}(dragging)`), 'U2 the sentence in the result meant for the model: "User is editing …"', readA?.notice);
  const readB = await mcpCall('get_clip', { clipId: ids.b });
  check(readB && !readB.__error && readB.userEditing === undefined && readB.notice === undefined, 'U2 reading another card carries no notice', readB?.notice ?? readB?.__error);

  /* U3 松手 = 页面改了这张卡,选中着 → 「刚动过」 */
  await page.mouse.up();
  const recent = await waitFor(async () => (await editingNow()).find((e) => e.clipId === ids.a && e.kind === 'recent'), 3000);
  check(!!recent, 'U3 after release the state becomes "just moved" (moved within 30 seconds after selection)', await editingNow());
  const moved = await page.evaluate(async (id) => {
    const m = await import('/src/store/project.ts');
    return m.getState().project.tracks.flatMap((t) => t.clips).find((c) => c.id === id)?.start;
  }, ids.a);
  check(typeof moved === 'number' && moved !== 1, 'U3 the drag really took effect (start changed)', moved);

  /* U4 Agent 写它:照常落地,结果带 overwrote「用户刚改过」 */
  let wrote = null;
  for (let i = 0; i < 10; i += 1) {
    await mcpCall('get_clip', { clipId: ids.a });
    wrote = await mcpCall('update_clip', { clipId: ids.a, opacity: 0.5 });
    if (!wrote?.__error) break;
    await sleep(300); // 副本还没追上页面刚落地的那一版:stale,重读再写
  }
  check(wrote?.ok === true, 'U4 the write takes effect as usual (only warns, does not block)', wrote?.__error ?? wrote?.ok);
  const ow = Array.isArray(wrote?.overwrote) ? wrote.overwrote.find((o) => o.clipId === ids.a) : null;
  check(!!ow && ow.by === 'user' && ow.label === 'user just edited', 'U4 the result carries overwrote "user just edited"', wrote?.overwrote);
  check(typeof wrote?.notice === 'string' && /This write overwrote content someone else just wrote: clip \S+\(user just edited/.test(wrote.notice), 'U4 the overwrite notice shown to the model', wrote?.notice);
  check(Array.isArray(wrote?.userEditing) && wrote.userEditing.some((e) => e.clipId === ids.a && e.kind === 'recent'), 'U4 the write also carries userEditing(recent)', wrote?.userEditing);
  const opacity = await waitFor(async () => page.evaluate(async (id) => {
    const m = await import('/src/store/project.ts');
    const c = m.getState().project.tracks.flatMap((t) => t.clips).find((x) => x.id === id);
    return c?.opacity === 0.5 ? c.opacity : null;
  }, ids.a), 5000);
  check(opacity === 0.5, 'U4 the page received the Agent\'s write', opacity);
  const stillRecent = (await editingNow()).find((e) => e.clipId === ids.a);
  check(stillRecent?.kind === 'recent', 'U4 the Agent\'s write does not count as "user moved it" (the timer is still the one from the moment of release)', stillRecent);

  /* U5 取消选中 → 清空 */
  await page.evaluate(async () => { const m = await import('/src/store/project.ts'); m.actions.select([]); });
  const cleared = await waitFor(async () => ((await editingNow()).length === 0 ? true : null), 3000);
  check(!!cleared, 'U5 the editing state is cleared after deselection', await editingNow());
  const readAfter = await mcpCall('get_clip', { clipId: ids.a });
  check(readAfter && !readAfter.__error && readAfter.userEditing === undefined, 'U5 the Agent reads again with no notice', readAfter?.notice);

  check(errors.length === 0, 'Page has no uncaught exceptions', errors.slice(0, 5));
} finally {
  await browser.close();
}
for (const p of passes) console.log('PASS', p);
for (const f of fails) console.log('FAIL', f);
console.log(fails.length ? `Probe failed: ${fails.length} failed, ${passes.length} passed` : `Probe passed: ${passes.length} checks`);
process.exit(fails.length ? 1 : 0);
