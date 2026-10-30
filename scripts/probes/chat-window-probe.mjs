/**
 * AI 栏聊天记录列表窗口化的探针(chat-list-window 分支,修 REPORT-C6.5.md 第 8 节的遗留)。
 *
 * 在临时目录里造一个 2000 条消息的历史会话,起一台编辑器(`?editor&aimock=1`,内置假流,不要任何模型后端),
 * 从「历史对话」抽屉打开它,然后:
 *   1. 消息 DOM 节点(`.ai-messages [data-pc-msg]`)不超过 60 个,打开后贴在底部;
 *   2. 用滚轮滚到顶、再滚回底:全程没有超过 50 ms 的长任务(PerformanceObserver 的 longtask),
 *      节点数全程不超过 60,滚到顶时第一条就是会话的第一条,滚回底时贴底;
 *   3. 焦点:让一个气泡里的按钮拿到焦点,滚远了它仍在文档里、仍是焦点;
 *   4. 贴底:打开「显示思考」(所有气泡变高)仍贴底;在底部发一条消息,假流输出期间每次采样都在底部(≤ 40px)、结束时贴底(≤ 2px);
 *   5. 翻到中间再发一条消息:假流输出期间视口顶上那条的位置不动、不被拽回底部,流式中的那条始终渲染在 DOM 里。
 * 截图写进 `--out`(底部、顶部、中间、流式结束后)。
 *
 * 用法:
 *   node scripts/probes/chat-window-probe.mjs [--port 5670] [--out out/chat-window-probe] [--height 900] [--origin http://127.0.0.1:N] [--keep]
 *
 * - `--height`:浏览器视口高度(缺省 900,这时消息区只有两百来像素高);消息区越高同时渲染的条越多,节点数上限要在高视口下也成立。
 *
 * - 缺省自己在仓库根起编辑器(`vite --port <port> --strictPort --host 127.0.0.1`,另占 +1、+2 当舞台端口),
 *   会话目录、工作目录、数据目录、AI 配置都指到一个新建的临时目录(`PROMPTCUT_CHATS_DIR`、`PROMPTCUT_WORK_DIR`、
 *   `PROMPTCUT_DATA_DIR`、`PROMPTCUT_AI_CONFIG`),不碰用户数据目录;跑完结束自己起的进程树、删掉临时目录(`--keep` 保留)。
 * - `--origin`:改用外面现成的编辑器(不起进程);那台编辑器的会话目录要自己保证能写,探针经 `/api/chats/save` 写入会话。
 * 结果:每项一行 JSON(`{ check, ok, ... }`),最后一行 `{ summary }`;有失败退出码 1。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR,产物不落进用户的 Videos\PromptCut
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};
const PORT = Number(arg('--port', 5670));
const OUT = path.resolve(ROOT, arg('--out', 'out/chat-window-probe'));
const KEEP = argv.includes('--keep');
const VIEW_H = Number(arg('--height', 900));
let origin = arg('--origin', null);
fs.mkdirSync(OUT, { recursive: true });

const N_MESSAGES = 2000;
const MAX_NODES = 60;
const LONG_TASK_MS = 50;
const CHAT_ID = 'c-probe-window-2000';

const results = [];
const check = (name, ok, extra = {}) => {
  const r = { check: name, ok: !!ok, ...extra };
  results.push(r);
  console.log(JSON.stringify(r));
  return ok;
};
const say = (what, extra = {}) => console.log(JSON.stringify({ at: what, ...extra }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 10_000, what = '条件') {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`等 ${what} 超时`);
    await sleep(100);
  }
}

/** 造 2000 条:用户、回复交替;每条回复各自一个气泡,条目数和长短不一,高度各不相同 */
function makeMessages() {
  const out = [];
  let t = Date.UTC(2026, 8, 1, 1, 0, 0);
  for (let i = 0; i < N_MESSAGES / 2; i++) {
    // 每 7 轮隔 10 分钟:出时间分隔行
    t += i % 7 === 0 ? 10 * 60_000 : 60_000;
    const words = '把第三段字幕往后挪半秒,再给开头加一张金句卡'.repeat(1 + (i % 4));
    out.push({ id: String(t), role: 'user', text: `第 ${i + 1} 轮:${words}` });
    const done = Array.from({ length: 1 + (i % 3) }, (_, k) => `第 ${i + 1} 轮完成的第 ${k + 1} 件事` + '。细节说明'.repeat(i % 5));
    const text = `第 ${i + 1} 轮的回复正文。` + '这一段是模型说的话,打开「显示思考」才看得到。'.repeat(1 + (i % 3));
    out.push({
      id: `a-${i}`,
      role: 'assistant',
      text,
      startedAt: t + 1000,
      finishedAt: t + 5000,
      outcome: 'completed',
      parts: [
        { kind: 'text', text },
        { kind: 'tool', name: 'get_editor_state', input: {}, ok: true, summary: '获取成功' },
        ...(i % 2 ? [{ kind: 'tool', name: 'add_clip', input: { start: i, end: i + 2 }, ok: true, summary: '加好了' }] : []),
        { kind: 'tool', name: 'report_progress', input: { final: true, done, todo: i % 4 === 0 ? ['下一步看看节奏'] : [], problems: [] }, ok: true, summary: 'ok' },
      ],
    });
  }
  return out;
}

function viteBin() {
  const local = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  if (fs.existsSync(local)) return local;
  const main = createRequire(import.meta.url).resolve('vite');
  const at = main.lastIndexOf(`${path.sep}vite${path.sep}`);
  return path.join(main.slice(0, at + 6), 'bin', 'vite.js');
}

let editorProc = null;
const editorLog = [];
let tmpDir = null;

async function spawnEditor() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-chat-window-'));
  const chats = path.join(tmpDir, 'chats');
  fs.mkdirSync(chats, { recursive: true });
  const now = Date.now();
  fs.writeFileSync(
    path.join(chats, `${CHAT_ID}.json`),
    JSON.stringify({ id: CHAT_ID, title: '窗口化探针 2000 条', createdAt: now, updatedAt: now, messages: makeMessages() }),
  );
  const env = {
    ...process.env,
    PROMPTCUT_PUSH: '0',
    PROMPTCUT_CHATS_DIR: chats,
    PROMPTCUT_WORK_DIR: path.join(tmpDir, 'work'),
    PROMPTCUT_DATA_DIR: path.join(tmpDir, 'data'),
    PROMPTCUT_AI_CONFIG: path.join(tmpDir, 'ai.json'),
  };
  delete env.PROMPTCUT_LAN_HOST;
  editorProc = spawn(process.execPath, [viteBin(), '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env,
  });
  const keep = (c) => {
    editorLog.push(c.toString());
    if (editorLog.length > 300) editorLog.shift();
  };
  editorProc.stdout.on('data', keep);
  editorProc.stderr.on('data', keep);
  origin = `http://127.0.0.1:${PORT}`;
  say('editor.spawn', { pid: editorProc.pid, origin, tmpDir });
  await waitFor(async () => {
    if (editorProc.exitCode !== null) throw new Error(`编辑器进程退出了(${editorProc.exitCode}):${editorLog.join('').slice(-600)}`);
    return fetch(`${origin}/`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false);
  }, 180_000, '编辑器起来');
}

async function stopEditor() {
  if (editorProc && editorProc.exitCode === null && editorProc.pid) {
    const exited = new Promise((r) => editorProc.once('exit', r));
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(editorProc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else editorProc.kill('SIGKILL');
    await Promise.race([exited, sleep(10_000)]);
    say('editor.stopped', { pid: editorProc.pid });
  }
  if (tmpDir && !KEEP) {
    for (let i = 0; i < 10; i++) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        break;
      } catch {
        await sleep(500);
      }
    }
    say('tmp.removed', { tmpDir, gone: !fs.existsSync(tmpDir) });
  }
}

/** 滚动区此刻的状态 */
const listState = (page) =>
  page.evaluate(() => {
    const box = document.querySelector('.ai-messages');
    if (!box) return null;
    const msgs = [...box.querySelectorAll('[data-pc-msg]')];
    const br = box.getBoundingClientRect();
    const firstVisible = msgs.find((el) => el.getBoundingClientRect().bottom > br.top + 1);
    return {
      nodes: msgs.length,
      children: box.children.length,
      spacers: box.querySelectorAll('[data-pc-vspacer]').length,
      scrollTop: box.scrollTop,
      scrollHeight: box.scrollHeight,
      clientHeight: box.clientHeight,
      fromBottom: box.scrollHeight - box.scrollTop - box.clientHeight,
      firstId: msgs[0]?.getAttribute('data-pc-msg') ?? null,
      lastId: msgs[msgs.length - 1]?.getAttribute('data-pc-msg') ?? null,
      anchorId: firstVisible?.getAttribute('data-pc-msg') ?? null,
      anchorTop: firstVisible ? firstVisible.getBoundingClientRect().top - br.top : null,
    };
  });
const frames = (page, n = 2) =>
  page.evaluate(
    (n) =>
      new Promise((r) => {
        let k = 0;
        const step = () => (++k >= n ? r() : requestAnimationFrame(step));
        requestAnimationFrame(step);
      }),
    n,
  );

let browser = null;
let page = null;
try {
  if (!origin) await spawnEditor();
  else {
    const res = await fetch(`${origin}/api/chats/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: CHAT_ID, title: '窗口化探针 2000 条', messages: makeMessages() }),
    });
    check('seed.via-api', res.ok, { status: res.status });
  }

  browser = await puppeteer.launch({
    headless: true,
    defaultViewport: { width: 1440, height: VIEW_H },
    args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--force-device-scale-factor=1'],
  });
  page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e?.message ?? e)));
  await page.goto(`${origin}/?editor&aimock=1&nosetup=1`, { waitUntil: 'domcontentloaded' });
  await waitFor(() => page.$('[data-pc="ai-history"]'), 120_000, 'AI 栏');

  // 从历史对话抽屉打开这个会话(真实用户路径)
  // 页面刚起来时可能还盖着测量遮罩,点不到就再点
  const item = await waitFor(async () => {
    if (!(await page.$('.chat-history-drawer'))) await page.click('[data-pc="ai-history"]').catch(() => {});
    const items = await page.$$('.chat-drawer-item');
    for (const it of items) {
      const t = await it.evaluate((el) => el.textContent ?? '');
      if (t.includes('窗口化探针')) return it;
    }
    return null;
  }, 60_000, '历史抽屉里的探针会话');
  await item.click();
  await waitFor(async () => ((await listState(page))?.nodes ?? 0) > 0, 20_000, '消息出现');
  await sleep(1500);
  await frames(page, 4);

  // ── 1. 打开后:节点数、贴底 ──
  const open = await listState(page);
  check('open.nodes<=60', open.nodes <= MAX_NODES, open);
  check('open.stuck-bottom', open.fromBottom <= 2, { fromBottom: open.fromBottom });
  check('open.last-is-last', open.lastId === `a-${N_MESSAGES / 2 - 1}`, { lastId: open.lastId });
  await page.screenshot({ path: path.join(OUT, '1-open-bottom.png') });

  // ── 2. 滚到顶再滚回底:长任务 ──
  await page.evaluate(() => {
    window.__lt = [];
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) window.__lt.push({ name: e.name, start: Math.round(e.startTime), dur: Math.round(e.duration) });
    }).observe({ type: 'longtask' });
  });
  const box = await page.$('.ai-messages');
  const bb = await box.boundingBox();
  await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
  let maxNodes = 0;
  let steps = 0;
  for (;;) {
    await page.mouse.wheel({ deltaY: -1200 });
    await frames(page, 2);
    const s = await listState(page);
    maxNodes = Math.max(maxNodes, s.nodes);
    steps++;
    if (s.scrollTop <= 0 || steps > 2000) break;
  }
  await sleep(300);
  await frames(page, 3);
  const top = await listState(page);
  check('top.reached', top.scrollTop <= 0, { steps, scrollTop: top.scrollTop });
  check('top.first-is-first', top.firstId === makeMessages()[0].id && top.anchorId === top.firstId, { firstId: top.firstId, anchorId: top.anchorId });
  await page.screenshot({ path: path.join(OUT, '2-top.png') });
  let downSteps = 0;
  for (;;) {
    await page.mouse.wheel({ deltaY: 1200 });
    await frames(page, 2);
    const s = await listState(page);
    maxNodes = Math.max(maxNodes, s.nodes);
    downSteps++;
    if (s.fromBottom <= 1 || downSteps > 2000) break;
  }
  await sleep(300);
  await frames(page, 3);
  const back = await listState(page);
  const longTasks = await page.evaluate(() => window.__lt);
  const worst = longTasks.reduce((m, e) => Math.max(m, e.dur), 0);
  check('scroll.nodes<=60', maxNodes <= MAX_NODES, { maxNodes, upSteps: steps, downSteps });
  check('scroll.no-longtask>50ms', longTasks.every((e) => e.dur <= LONG_TASK_MS), { count: longTasks.length, worst, longTasks: longTasks.slice(0, 10) });
  check('scroll.back-bottom', back.fromBottom <= 2 && back.lastId === `a-${N_MESSAGES / 2 - 1}`, { fromBottom: back.fromBottom, lastId: back.lastId });

  // ── 3. 焦点:气泡里的按钮拿到焦点,滚远了还在 ──
  const focused = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.ai-messages button')].reverse().find((b) => b.getBoundingClientRect().height > 0);
    if (!btn) return null;
    btn.focus();
    window.__focusBtn = btn;
    return document.activeElement === btn;
  });
  await page.evaluate(() => {
    const b = document.querySelector('.ai-messages');
    b.scrollTop = b.scrollHeight / 3;
  });
  await frames(page, 4);
  const focusKept = await page.evaluate(() => ({ connected: !!window.__focusBtn?.isConnected, active: document.activeElement === window.__focusBtn }));
  check('focus.kept-while-scrolled-away', focused && focusKept.connected && focusKept.active, { focused, ...focusKept });
  await page.evaluate(() => {
    window.__focusBtn?.blur();
    const b = document.querySelector('.ai-messages');
    b.scrollTop = b.scrollHeight;
  });
  await sleep(300);
  await frames(page, 3);

  // ── 4. 贴底:打开「显示思考」、在底部发消息 ──
  await page.click('[data-pc="ai-show-thinking"]');
  await sleep(500);
  await frames(page, 4);
  const thinking = await listState(page);
  check('thinking-on.still-bottom', thinking.fromBottom <= 2 && thinking.nodes <= MAX_NODES, { fromBottom: thinking.fromBottom, nodes: thinking.nodes });

  const sendMsg = async (text) => {
    await page.click('[data-pc="ai-input"]');
    await page.type('[data-pc="ai-input"]', text);
    await page.keyboard.press('Enter');
  };
  const seeded = new Set(makeMessages().map((m) => m.id));
  const sampleStream = async (fn) => {
    const samples = [];
    const t0 = Date.now();
    // 假流:约 1.3 s 逐字输出 + 1 s 工具 + 0.6 s 收尾;采样到流式结束(没有 is-streaming)再多两次
    let idleSeen = 0;
    while (Date.now() - t0 < 15_000) {
      await sleep(80);
      const s = await listState(page);
      const streaming = await page.evaluate(() => !!document.querySelector('.ai-composer.is-streaming'));
      samples.push({ ...(await fn(s)), streaming, scrollHeight: s.scrollHeight });
      if (!streaming && Date.now() - t0 > 500) idleSeen++;
      if (idleSeen >= 3) break;
    }
    return samples;
  };
  await sendMsg('窗口化探针:在底部发一条');
  const bottomSamples = await sampleStream(async (s) => ({ fromBottom: s.fromBottom, lastNew: !seeded.has(s.lastId ?? '') }));
  const grew = new Set(bottomSamples.map((x) => x.scrollHeight)).size;
  // 采样本身会强制排版:content-visibility 刚把一行换成真高度、ResizeObserver 还没回调(它在同一帧绘制之前回调)时,
  // 读到的离底距离会短暂地多出几像素。所以流式中每次采样按「在底部」的定义(≤ 40px,listWindow.ts 的 BOTTOM_SLACK)判,
  // 流式结束后最后一次采样必须真正贴底(≤ 2px)
  const lastBottom = bottomSamples[bottomSamples.length - 1];
  check('stream-at-bottom.stuck', bottomSamples.every((x) => x.fromBottom <= 40) && lastBottom.fromBottom <= 2, {
    last: lastBottom.fromBottom,
    over2: bottomSamples.filter((x) => x.fromBottom > 2).length,
    samples: bottomSamples.length,
    heights: grew,
    worst: Math.max(...bottomSamples.map((x) => x.fromBottom)),
  });
  check('stream-at-bottom.new-rendered', bottomSamples.some((x) => x.streaming) && bottomSamples.every((x) => x.lastNew), { firstSample: bottomSamples[0] });
  await page.screenshot({ path: path.join(OUT, '3-after-stream-bottom.png') });

  // ── 5. 翻到中间来新消息:不被拽回底部,视口顶上那条不动,流式中的那条一直在 DOM 里 ──
  await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
  await page.evaluate(() => {
    const b = document.querySelector('.ai-messages');
    b.scrollTop = b.scrollHeight / 2;
  });
  await sleep(400);
  await frames(page, 4);
  // 再用滚轮挪一小段,当作用户最后一次表态
  await page.mouse.wheel({ deltaY: -200 });
  await sleep(300);
  await frames(page, 4);
  const mid = await listState(page);
  await page.screenshot({ path: path.join(OUT, '4-middle-before.png') });
  await sendMsg('窗口化探针:翻到中间时来的消息');
  const midSamples = await sampleStream(async (s) => ({
    fromBottom: s.fromBottom,
    scrollTop: s.scrollTop,
    anchorId: s.anchorId,
    anchorTop: s.anchorTop,
    lastNew: !seeded.has(s.lastId ?? ''),
    nodes: s.nodes,
  }));
  const moved = midSamples.filter((x) => x.anchorId !== mid.anchorId || Math.abs((x.anchorTop ?? 0) - mid.anchorTop) > 2);
  check('stream-in-middle.not-dragged', midSamples.every((x) => x.fromBottom > 200), { mid: { scrollTop: mid.scrollTop, fromBottom: mid.fromBottom }, minFromBottom: Math.min(...midSamples.map((x) => x.fromBottom)) });
  check('stream-in-middle.anchor-still', moved.length === 0, { anchor: { id: mid.anchorId, top: mid.anchorTop }, moved: moved.slice(0, 5) });
  check('stream-in-middle.live-rendered', midSamples.some((x) => x.streaming) && midSamples.every((x) => x.lastNew), { samples: midSamples.length });
  check('stream-in-middle.nodes<=60', midSamples.every((x) => x.nodes <= MAX_NODES), { max: Math.max(...midSamples.map((x) => x.nodes)) });
  await page.screenshot({ path: path.join(OUT, '5-middle-after-stream.png') });

  // ── 6. 短对话(不到窗口化门槛 150 条,全渲染):新开一页从空对话发三条,每条流式期间都贴底,没有占位 ──
  const first = page;
  page = await browser.newPage();
  page.on('pageerror', (e) => pageErrors.push(String(e?.message ?? e)));
  await page.goto(`${origin}/?editor&aimock=1&nosetup=1`, { waitUntil: 'domcontentloaded' });
  // 2026-10-22 起新项目没有会话时 AI 栏是开始页(.ai-messages.pc-start),不再是空对话的示例句;从它发第一条消息就建出 Agent 1
  await waitFor(() => page.$('.ai-messages .ai-empty-state, .ai-messages.pc-start'), 120_000, '新页面的空对话(开始页)');
  const smallSamples = [];
  for (let k = 0; k < 3; k++) {
    await sendMsg(`短对话第 ${k + 1} 条`);
    smallSamples.push(...(await sampleStream(async (s) => ({ fromBottom: s.fromBottom, spacers: s.spacers, nodes: s.nodes }))));
  }
  const small = await listState(page);
  // 每一轮的回复各占一个气泡(2026-10-20 去掉了「没交本轮小结就并进上一个气泡」):3 条用户消息 + 3 个回复气泡
  check('small.all-rendered-no-spacer', small.nodes === 6 && smallSamples.every((x) => x.spacers === 0), { nodes: small.nodes, spacers: small.spacers });
  check('small.stuck', smallSamples.every((x) => x.fromBottom <= 40) && small.fromBottom <= 2, {
    last: small.fromBottom,
    worst: Math.max(...smallSamples.map((x) => x.fromBottom)),
    scrollable: small.scrollHeight > small.clientHeight,
  });
  await page.screenshot({ path: path.join(OUT, '6-small-chat.png') });
  await page.close();
  page = first;

  check('page.no-errors', pageErrors.length === 0, { pageErrors: pageErrors.slice(0, 5) });
} catch (err) {
  check('probe.crashed', false, { error: String(err?.stack ?? err) });
  if (page) await page.screenshot({ path: path.join(OUT, 'crash.png') }).catch(() => {});
} finally {
  if (browser) await browser.close().catch(() => {});
  await stopEditor();
}
const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ summary: { total: results.length, failed: failed.length, failedChecks: failed.map((r) => r.check), out: OUT } }));
process.exit(failed.length ? 1 : 0);
