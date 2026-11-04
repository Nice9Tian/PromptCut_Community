/**
 * Probe for AI panel chat history list windowing (branch `chat-list-window`, fixing leftovers
 * from Section 8 of REPORT-C6.5.md).
 *
 * Create a historical session with 2000 messages in a temporary directory, launch an editor
 * (`?editor&aimock=1`, with built-in mock stream, requiring no model backend), and open it from
 * the "Chat history" drawer, then:
 *   1. Message DOM nodes (`.ai-messages [data-pc-msg]`) do not exceed 60, sticking to the bottom
 *      after opening;
 *   2. Scroll to top then back to bottom with mouse wheel: no long tasks exceeding 50 ms throughout
 *      (PerformanceObserver longtask), node count never exceeds 60 throughout, top item is the session's
 *      first message when scrolled to top, and sticks to bottom when scrolled back;
 *   3. Focus: let a button in a bubble acquire focus; when scrolled far away, it remains in the
 *      document and retains focus;
 *   4. Sticking to bottom: enable "Show thinking" (all bubbles become taller) still sticks to bottom;
 *      send a message at bottom, and every sample during mock stream output is at bottom (≤ 40px),
 *      sticking to bottom when finished (≤ 2px);
 *   5. Scroll to middle and send another message: during mock stream output, position of item at top
 *      of viewport does not move without being dragged back to bottom, and streaming item is always
 *      rendered in DOM.
 * Screenshots are written to `--out` (bottom, top, middle, after streaming ends).
 *
 * Usage:
 *   node scripts/probes/chat-window-probe.mjs [--port 5670] [--out out/chat-window-probe] [--height 900] [--origin http://127.0.0.1:N] [--keep]
 *
 * - `--height`: Browser viewport height (defaults to 900, where message area is only about 200px tall);
 *   taller message area renders more items concurrently, and node count upper limit must hold under
 *   tall viewports.
 *
 * - By default starts an editor at repo root (`vite --port <port> --strictPort --host 127.0.0.1`,
 *   additionally taking +1 and +2 as stage ports), pointing session directory, work directory,
 *   data directory, and AI config to a newly created temporary directory (`PROMPTCUT_CHATS_DIR`,
 *   `PROMPTCUT_WORK_DIR`, `PROMPTCUT_DATA_DIR`, `PROMPTCUT_AI_CONFIG`) without touching user data
 *   directory; terminates its own process tree after running and removes temporary directory
 *   (`--keep` preserves it).
 * - `--origin`: Uses an existing external editor instead (no process started); you must ensure that
 *   editor's session directory is writable; probe writes sessions via `/api/chats/save`.
 * Result: one JSON line per item (`{ check, ok, ... }`), with `{ summary }` on the last line; exit
 * code 1 on failure.
 */
import '../lib/no-user-dirs.mjs'; // First import: does not inherit external PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR; outputs do not land in the user's Videos\PromptCut
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
async function waitFor(fn, ms = 10_000, what = 'condition') {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`Timed out waiting for ${what}`);
    await sleep(100);
  }
}

/** Generate 2000 items: alternating user and replies; each reply has its own bubble with varying lengths and heights */
function makeMessages() {
  const out = [];
  let t = Date.UTC(2026, 8, 1, 1, 0, 0);
  for (let i = 0; i < N_MESSAGES / 2; i++) {
    // Every 7 rounds separated by 10 minutes: emit time divider row
    t += i % 7 === 0 ? 10 * 60_000 : 60_000;
    const words = 'Shift the third caption back by half a second, then add a punchline card at the start'.repeat(1 + (i % 4));
    out.push({ id: String(t), role: 'user', text: `Round ${i + 1}: ${words}` });
    const done = Array.from({ length: 1 + (i % 3) }, (_, k) => `Item ${k + 1} done in round ${i + 1}` + '. Detail notes'.repeat(i % 5));
    const text = `Reply body for round ${i + 1}.` + 'This paragraph is what the model said, visible only when "Show thinking" is turned on.'.repeat(1 + (i % 3));
    out.push({
      id: `a-${i}`,
      role: 'assistant',
      text,
      startedAt: t + 1000,
      finishedAt: t + 5000,
      outcome: 'completed',
      parts: [
        { kind: 'text', text },
        { kind: 'tool', name: 'get_editor_state', input: {}, ok: true, summary: 'Fetched successfully' },
        ...(i % 2 ? [{ kind: 'tool', name: 'add_clip', input: { start: i, end: i + 2 }, ok: true, summary: 'Added' }] : []),
        { kind: 'tool', name: 'report_progress', input: { final: true, done, todo: i % 4 === 0 ? ['Check the pacing next'] : [], problems: [] }, ok: true, summary: 'ok' },
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
    JSON.stringify({ id: CHAT_ID, title: 'Windowing probe, 2000 messages', createdAt: now, updatedAt: now, messages: makeMessages() }),
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
    if (editorProc.exitCode !== null) throw new Error(`The editor process exited (${editorProc.exitCode}): ${editorLog.join('').slice(-600)}`);
    return fetch(`${origin}/`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false);
  }, 180_000, 'editor started');
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

/** Current state of the scroll area */
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
      body: JSON.stringify({ id: CHAT_ID, title: 'Windowing probe, 2000 messages', messages: makeMessages() }),
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
  await waitFor(() => page.$('[data-pc="ai-history"]'), 120_000, 'AI panel');

  // Open this session from the "Chat history" drawer (real user path)
  // Page may still be covered by measurement overlay right after startup; click again if unclickable
  const item = await waitFor(async () => {
    if (!(await page.$('.chat-history-drawer'))) await page.click('[data-pc="ai-history"]').catch(() => {});
    const items = await page.$$('.chat-drawer-item');
    for (const it of items) {
      const t = await it.evaluate((el) => el.textContent ?? '');
      if (t.includes('Windowing probe')) return it;
    }
    return null;
  }, 60_000, 'Probe session in the history drawer');
  await item.click();
  await waitFor(async () => ((await listState(page))?.nodes ?? 0) > 0, 20_000, 'Messages appear');
  await sleep(1500);
  await frames(page, 4);

  // ── 1. After opening: node count, sticking to bottom ──
  const open = await listState(page);
  check('open.nodes<=60', open.nodes <= MAX_NODES, open);
  check('open.stuck-bottom', open.fromBottom <= 2, { fromBottom: open.fromBottom });
  check('open.last-is-last', open.lastId === `a-${N_MESSAGES / 2 - 1}`, { lastId: open.lastId });
  await page.screenshot({ path: path.join(OUT, '1-open-bottom.png') });

  // ── 2. Scroll to top then back to bottom: long tasks ──
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

  // ── 3. Focus: button in bubble acquires focus, still remains when scrolled away ──
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

  // ── 4. Sticking to bottom: enable "Show thinking", send message at bottom ──
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
    // Mock stream: ~1.3 s character-by-character output + 1 s tools + 0.6 s finalize; sample until
    // streaming ends (no is-streaming) plus two more times
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
  await sendMsg('Windowing probe: send one at the bottom');
  const bottomSamples = await sampleStream(async (s) => ({ fromBottom: s.fromBottom, lastNew: !seeded.has(s.lastId ?? '') }));
  const grew = new Set(bottomSamples.map((x) => x.scrollHeight)).size;
  // Sampling itself forces layout: when content-visibility just swapped a row to real height and
  // ResizeObserver has not fired its callback yet (it fires before painting in the same frame),
  // read distance from bottom will briefly have extra pixels. So each sample during streaming is
  // judged by "at bottom" definition (≤ 40px, BOTTOM_SLACK in listWindow.ts), and the final sample
  // after streaming ends must truly stick to bottom (≤ 2px)
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

  // ── 5. Scroll to middle and receive new message: not dragged back to bottom, item at top of
  // viewport does not move, streaming item stays in DOM ──
  await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
  await page.evaluate(() => {
    const b = document.querySelector('.ai-messages');
    b.scrollTop = b.scrollHeight / 2;
  });
  await sleep(400);
  await frames(page, 4);
  // Move a short distance with mouse wheel again as the user's latest interaction
  await page.mouse.wheel({ deltaY: -200 });
  await sleep(300);
  await frames(page, 4);
  const mid = await listState(page);
  await page.screenshot({ path: path.join(OUT, '4-middle-before.png') });
  await sendMsg('Windowing probe: message that arrives while scrolled to the middle');
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

  // ── 6. Short chat (under windowing gate of 150 items, fully rendered): open a new page, send three
  // messages from empty chat, each sticks to bottom during streaming, no placeholders ──
  const first = page;
  page = await browser.newPage();
  page.on('pageerror', (e) => pageErrors.push(String(e?.message ?? e)));
  await page.goto(`${origin}/?editor&aimock=1&nosetup=1`, { waitUntil: 'domcontentloaded' });
  // As of 2026-10-22, when a new project has no sessions, the AI panel shows start page
  // (.ai-messages.pc-start), no longer empty chat example prompts; sending first message creates Agent 1
  await waitFor(() => page.$('.ai-messages .ai-empty-state, .ai-messages.pc-start'), 120_000, 'Empty chat on a new page (start page)');
  const smallSamples = [];
  for (let k = 0; k < 3; k++) {
    await sendMsg(`Short chat, message ${k + 1}`);
    smallSamples.push(...(await sampleStream(async (s) => ({ fromBottom: s.fromBottom, spacers: s.spacers, nodes: s.nodes }))));
  }
  const small = await listState(page);
  // Replies for each round take one bubble each (on 2026-10-20 removed "merge into previous bubble if
  // round summary not submitted"): 3 user messages + 3 reply bubbles
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
