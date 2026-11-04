// First import protects user directories and the shared port file before any fixture import.
import '../lib/no-user-dirs.mjs';
/**
 * Real run of desktop app Vibe mode (branch `claude/editor-vibe-button`).
 *
 * **Runs in the real desktop shell**, not a browser tab: Tauri shell opens a debug port for its
 * WebView2 (`browser_args` in `desktop/src-tauri/src/agent_webview.rs`; main window and agent
 * sub-webview share the same environment). This script connects to that port, gets the main
 * window page, clicks through, and takes screenshots. Captures content inside the desktop app window.
 *
 * How to run this branch's code in the shell: when the shell starts, it probes 5210 first;
 * **if it detects an existing instance serving, it skips starting its own sidecar and navigates
 * directly there** (`existing_instance` in `desktop/src-tauri/src/lib.rs`). So start `vite --port 5210`
 * in this worktree first, then launch the shell; the shell will display this branch.
 *
 *   # 1) Start dev server in this worktree first
 *   PROMPTCUT_NO_PORT_FILE=1 npx vite --port 5210 --strictPort --host 127.0.0.1
 *   # 2) Launch desktop shell (any promptcut.exe works, Rust side is unchanged in this branch)
 *   # 3) Find WebView2 debug port and run this script
 *   node scripts/probes/vibe-desktop-probe.mjs --cdp <port> --out <dir>
 *
 * Path taken (one screenshot per step, see `step` records for image names):
 *   Classic start page has "Vibe mode" → click it to enter Vibe mode screen (URL becomes ?ui=vibe) →
 *   say one sentence to create local project → enter chat page, sentence is inside →
 *   check local Agent status (real reply / real reason for inability to speak, record both truthfully) →
 *   return to home, new project is listed in sidebar and that row →
 *   open another chat (= second Agent tab in AI panel) → open right side panel, enter detail editing
 *   to view real stage and real timeline →
 *   click "Enter Classic mode" to enter editor → "Vibe mode" slot in editor top bar is no longer
 *   grayed out, click it to return to Vibe mode screen →
 *   "Extensions and storage" in top bar returns to Classic start page
 * Last line is a single JSON line: { ok, steps, fails }. Exit code 0 passes, 1 fails.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

setTimeout(() => { console.error('SCRIPT_TIMEOUT'); process.exit(124); }, 10 * 60_000).unref();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const arg = (key, dflt) => { const i = argv.indexOf(key); return i < 0 ? dflt : argv[i + 1]; };
const CDP = Number(arg('--cdp', ''));
const OUT = path.resolve(arg('--out', path.join(ROOT, 'docs/archive/agent-reports/AGENT-claude-editor-vibe-button-shots')));
const EDITOR = arg('--editor', 'http://127.0.0.1:5210');
if (!Number.isInteger(CDP) || CDP <= 0) {
  console.error('Requires --cdp <port>: the debugging port of the desktop shell\'s WebView2. See the top of this file for how to find it.');
  process.exit(2);
}
await fs.mkdir(OUT, { recursive: true });

const fails = [];
const out = { ok: false, out: OUT, steps: {} };
const step = (k, v) => { out.steps[k] = v; console.error(`[step] ${k} ${JSON.stringify(v).slice(0, 400)}`); };
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 400))); return !!cond; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Wait that does not count as failure on timeout: used where "better if present, fall back if not" */
async function soft(fn, ms, every = 500) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(every);
  }
}

async function until(what, fn, ms = 30_000, every = 300, pass) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await fn(pass); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) { fails.push(`Timed out waiting for: ${what}`); return null; }
    await sleep(every);
  }
}

let shotNo = 0;
async function shot(page, name) {
  const file = path.join(OUT, `${String(++shotNo).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file });
  return path.basename(file);
}

/** Current state of each item on the page at this moment */
const snapshot = (page) => page.evaluate(() => {
  const pick = (sel) => document.querySelector(sel);
  const text = (sel) => pick(sel)?.textContent?.trim() ?? null;
  const rows = (sel) => [...document.querySelectorAll(sel)].map((el) => el.textContent.trim().replace(/^›\s*/, ''));
  const mode = pick('[data-pc="mode-switch"]');
  return {
    url: location.href,
    classic: !!pick('[data-pc="start-join"]') || !!pick('[data-pc="start-go-vibe"]'),
    vibe: !!pick('[data-pc="start-desktop"]'),
    editor: !!mode,
    chat: !!pick('[data-pc="start-chat"]'),
    detail: !!pick('[data-pc="start-detail"]'),
    ext: !!pick('[data-pc="start-ext"]'),
    agentBtn: text('[data-pc="start-agent-setup"]'),
    note: text('[data-pc="start-notice"]'),
    chatNote: text('[data-pc="start-chat-note"]'),
    banner: text('[data-pc="start-chat-banner"]'),
    title: text('[data-pc="start-chat-name"]'),
    where: text('.ps-top-where'),
    sideNotice: text('[data-pc="start-side-notice"]'),
    projects: rows('[data-pc="start-side-project"]'),
    agents: rows('[data-pc="start-side-agent"]'),
    tiles: [...document.querySelectorAll('[data-pc="start-project-tile"]')].map((el) => el.textContent.trim()),
    railCount: text('[data-pc="start-rail-count"]'),
    msgs: [...document.querySelectorAll('[data-pc="start-chat-msg"]')].map((el) => ({
      from: el.dataset.from, send: el.dataset.send ?? null, text: el.textContent.trim().slice(0, 160),
    })),
    // The three top bar items: their text, whether pressed, and whether grayed out
    modes: mode ? [...mode.querySelectorAll('button')].map((b) => ({
      label: b.textContent.trim(), on: b.getAttribute('aria-pressed') === 'true', off: b.disabled, title: b.title,
    })) : null,
    // The account section should not exist in the desktop app
    account: !!pick('[data-pc="start-top-account"]'),
  };
});

const clickPc = (page, pc) => page.click(`[data-pc="${pc}"]`);

/* ---------------- Connect to desktop shell ---------------- */
const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${CDP}`, defaultViewport: null });
const pages = await browser.pages();
const page = pages.find((p) => p.url().startsWith(EDITOR));
if (!page) {
  console.error(`The desktop shell has no ${EDITOR} page. Currently open:`, pages.map((p) => p.url()));
  await browser.disconnect();
  process.exit(2);
}
page.setDefaultTimeout(30_000);
// Dirty data confirmation dialog (pops up when switching to Vibe mode or returning home) blocks clicks; always click "Continue" and record what popped up
const dialogs = [];
page.on('dialog', (d) => { dialogs.push(d.message()); void d.accept(); });
step('connect', { cdp: CDP, url: page.url(), pages: pages.map((p) => p.url()) });

try {
  /* ---------------- 1. Classic start page: added "Vibe mode" button ---------------- */
  // Start fresh: clear URL to clean /, refresh
  await page.goto(`${EDITOR}/`, { waitUntil: 'domcontentloaded' });
  await until('Classic start page', () => page.$('[data-pc="start-go-vibe"]'));
  let s = await snapshot(page);
  check(s.classic && !s.vibe, 'The start page should be the classic one', s);
  step('classic', { ...s, shot: await shot(page, 'classic-start') });

  /* ---------------- 2. Click "Vibe mode" to enter that screen ---------------- */
  await clickPc(page, 'start-go-vibe');
  await until('The Vibe mode screen', () => page.$('[data-pc="start-desktop"]'));
  s = await snapshot(page);
  check(s.vibe, 'Should enter the Vibe mode screen', s);
  check(s.url.includes('ui=vibe'), 'The URL should record ?ui=vibe (stays on this screen after refresh)', s.url);
  check(!s.account, 'The desktop app top bar should not have the account section', s);
  check(!!s.agentBtn, 'The top bar should have the Agent button', s);
  step('vibe', { ...s, shot: await shot(page, 'vibe-home') });

  // Refresh once: URL is remembered, should still land on this screen
  await page.reload({ waitUntil: 'domcontentloaded' });
  const back = await until('Still in Vibe mode after refresh', () => page.$('[data-pc="start-desktop"]'));
  check(!!back, 'Should still be on the Vibe mode screen after refresh');
  step('reload', { vibe: !!back });

  /* ---------------- 3. Say one sentence: create local project, enter chat page ---------------- */
  const SAY = `Make a 15-second product video, opening with one line that states the topic ${Date.now().toString(36).slice(-4)}`;
  const projectsBefore = (await snapshot(page)).projects.length;
  await page.click('[data-pc="start-prompt-input"]');
  await page.type('[data-pc="start-prompt-input"]', SAY);
  // Select aspect ratio 9:16 (portrait): also verify "created project sized by selected aspect ratio".
  // After clicking, wait for React rerender before reading pressed state
  await page.evaluate(() => {
    [...document.querySelectorAll('.ps-prompt-foot .ps-chip')].find((x) => x.textContent.trim() === '9:16')?.click();
  });
  const picked = await until('9:16 pressed', () => page.evaluate(() =>
    [...document.querySelectorAll('.ps-prompt-foot .ps-chip')].find((x) => x.textContent.trim() === '9:16')?.getAttribute('aria-pressed') === 'true' || null), 5_000);
  check(!!picked, '9:16 should be selected');
  await clickPc(page, 'start-prompt-send');
  const entered = await until('Enter the chat page', () => page.$('[data-pc="start-chat"]'), 60_000);
  check(!!entered, 'After saying one line, it should enter this new project\'s chat page');
  // That sentence from the start page can only be sent once Agent is ready (pending in `ChatView`), so wait until it actually appears in chat
  const said = await until('That line appears in the chat', () => page.evaluate((want) =>
    [...document.querySelectorAll('[data-pc="start-chat-msg"][data-from="me"]')].some((el) => el.textContent.includes(want)) || null, SAY), 90_000);
  check(!!said, 'The line just said should be in the chat');
  s = await snapshot(page);
  check((s.where ?? '').includes('Make a'), 'The project name should come from this line', s.where);
  check(s.projects.length === projectsBefore + 1, 'The sidebar should gain one project', { projectsBefore, now: s.projects });
  // Name of project created this time (taken from that sentence, truncated with ellipsis if long).
  // Match by it below when checking auto-save, so as not to mistake it for one left from previous run
  const madeName = (s.where ?? '').replace(/^Project "/, '').replace(/"$/, '');
  step('say', { ...s, dialogs: [...dialogs], shot: await shot(page, 'chat-after-say') });

  /* ---------------- 4. Can the local Agent speak right now? ---------------- */
  // Both count as passing, but record truthfully which one: if configured, wait for real reply; if not configured, record that reason message
  const agentState = await page.evaluate(() => ({
    canSend: !document.querySelector('[data-pc="start-chat-input"]')?.disabled,
    why: document.querySelector('[data-pc="start-chat-note"]')?.textContent?.trim() ?? null,
    agentBtn: document.querySelector('[data-pc="start-agent-setup"]')?.textContent?.trim() ?? null,
  }));
  check(agentState.canSend, 'This machine has an Agent, so sending should work now (if it cannot send, the next line states the reason)', agentState);
  // Wait for it to respond: real reply or real error, both count as connected, but record truthfully which one
  const replied = await until('Reply from the local Agent', async () => {
    const r = await page.evaluate(() => ({
      agent: [...document.querySelectorAll('[data-pc="start-chat-msg"][data-from="agent"]')].length,
      say: document.querySelector('[data-pc="start-chat-msg"][data-from="agent"]')?.textContent?.trim().slice(0, 200) ?? null,
      err: document.querySelector('[data-pc="start-chat-send-error"]')?.textContent?.trim()
        ?? document.querySelector('[data-pc="start-chat-banner"]')?.textContent?.trim() ?? null,
    }));
    return r.agent > 0 || r.err ? r : null;
  }, 120_000);
  check(!!replied, 'The local Agent should reply');
  step('agent', { ...agentState, ...(replied ?? {}), shot: await shot(page, 'agent-reply') });

  /* ---------------- 4b. Auto-save: saved to disk when Agent modifies, no need for user to click "Save project" ---------------- */
  // `workflow/project.md` "Drafts auto-saved on this machine". Wait for store dirty to settle, then read draft from server again to verify
  const saved = await until('Autosave written to disk', async (want) => {
    const r = await page.evaluate(async () => {
      const res = await fetch('/api/projects', { cache: 'no-store' });
      const body = await res.json();
      return { list: (body.projects ?? []).map((d) => ({ name: d.name, clips: d.clips, at: d.updatedAt })) };
    });
    const hit = r.list.find((d) => d.name === want);
    return hit ? { hit } : null;
  }, 60_000, 1000, madeName);
  check(!!saved, 'This project should already be written to disk on its own (without the user pressing "Save project")');
  step('autosave', { madeName, ...(saved ?? {}) });

  /* ---------------- 4c. Open another chat (= second Agent tab in AI panel) ---------------- */
  // Wait to click until first message is actually sent: with no real sessions, sidebar item is a placeholder start page,
  // `addTab()` by design does not create a new one then (same behavior as AI panel)
  const agentsBefore = (await snapshot(page)).agents.length;
  if (await page.$('[data-pc="start-side-new-chat"]')) {
    await clickPc(page, 'start-side-new-chat');
    await until('Second chat', async () => {
      const n = await page.$$eval('[data-pc="start-side-agent"]', (a) => a.length).catch(() => 0);
      return n > agentsBefore ? n : null;
    }, 15_000);
  }
  s = await snapshot(page);
  check(s.agents.length === agentsBefore + 1, 'One more chat should appear', { agentsBefore, now: s.agents });
  step('chats', { agentsBefore, agents: s.agents, shot: await shot(page, 'two-chats') });

  /* ---------------- 5. Return to home: new project listed in sidebar and that row ---------------- */
  await clickPc(page, 'start-home');
  await until('back to the start page', async () => (await page.$('[data-pc="start-prompt"]')) && !(await page.$('[data-pc="start-chat"]')));
  s = await snapshot(page);
  check(s.projects.length >= 1, 'The sidebar should list the just-created local project', s.projects);
  check(s.tiles.length >= 1, 'That row should include the just-created project', s.tiles);
  step('home', { ...s, shot: await shot(page, 'home-with-project') });

  /* ---------------- 6. Right side panel + detail editing ---------------- */
  if (!(await page.$('[data-pc="start-chat"]'))) {
    // Return to chat page: click the first chat in the sidebar
    await clickPc(page, 'start-side-agent');
    await until('Chat page', () => page.$('[data-pc="start-chat"]'));
  }
  // After entering session, the side panel expands automatically (issue #6): do not click if already open, clicking would close it
  await page.evaluate(() => { if (!document.querySelector('[data-pc="start-ext"]')) document.querySelector('[data-pc="start-chat-ext-toggle"]')?.click(); });
  const extOn = await until('Right side panel', () => page.$('[data-pc="start-ext"]'));
  check(!!extOn, 'The side panel should open');
  step('ext', { ...(await snapshot(page)), shot: await shot(page, 'ext-panel') });

  await clickPc(page, 'start-ext-detail');
  const detail = await until('Detail editing', () => page.$('[data-pc="start-detail"]'));
  check(!!detail, 'Detail editing should open (it contains the real stage and the real timeline)');
  // Must mount the **real** timeline from the editor, not a custom read-only track
  const realTl = await until('Real timeline', () => page.$('[data-pc="start-detail-tl"] [data-pc="timeline"]'), 20_000);
  check(!!realTl, 'Detail editing should mount the editor\'s real timeline (`src/editor/timeline/`)');
  // Stage pane aspect ratio is project dimensions (`VibeStage` uses store width/height): verify 9:16 selected on start page was actually applied
  const ratio = await page.evaluate(() => {
    const el = document.querySelector('.ps-stage');
    return el ? getComputedStyle(el).aspectRatio : null;
  });
  check(ratio === '1080 / 1920' || ratio === '1080/1920', 'The project should be created with the 9:16 clicked on the start page', ratio);
  step('detail', { ratio, realTimeline: !!realTl, ...(await snapshot(page)), shot: await shot(page, 'detail-edit') });

  /* ---------------- 6b. Timeline is truly adjustable: drag a clip, its start point truly changes ---------------- */
  // `user-workflow.md` "Working mode": in Vibe mode, "enter detail editing from "Video" in right side panel, where timeline is adjustable".
  // Checking DOM alone does not count: drag it, then read this clip's start point from store; only if changed does it count as adjustable
  const pickClip = () => page.evaluate(() => {
    const st = window.__pcStore?.getState?.();
    const c = st?.project?.tracks?.flatMap((t) => t.clips)?.[0];
    return c ? { id: c.id, start: c.start, end: c.end } : null;
  });
  // `__pcStore` is attached by timeline module (`src/editor/timeline/index.tsx`); attachment indicates real timeline was truly loaded
  const hasStore = await until('__pcStore', () => page.evaluate(() => !!window.__pcStore), 20_000);
  check(!!hasStore, 'The real timeline\'s debug hook should exist (it is attached by the timeline module)');
  // First wait for Agent to place items itself; if slow this round, place a clip manually; this step verifies "draggable" and should not get stuck waiting on model
  let seeded = false;
  let beforeDrag = await soft(pickClip, 30_000);
  if (!beforeDrag && hasStore) {
    seeded = true;
    await page.evaluate(() => { window.__pcStore.actions.addCardClip('av-pulse', 1, { duration: 2 }); });
    beforeDrag = await until('The clip it placed itself', pickClip, 10_000);
  }
  let dragged = null;
  const diag = {};
  if (beforeDrag) {
    const box = await page.$eval(`[data-clip-id="${beforeDrag.id}"]`, (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    // Press down in middle of clip, move right a bit, then release (useDrag binds native pointer events, moving in steps produces intermediate states)
    diag.at = await page.evaluate((b) => document.elementsFromPoint(b.x, b.y).slice(0, 4).map((el) => `${el.tagName}.${el.className}`.slice(0, 60)), box);
    await page.mouse.move(box.x, box.y);
    await page.mouse.down();
    diag.selAfterDown = await page.evaluate(() => window.__pcStore?.getState?.().selection ?? null);
    await page.mouse.move(box.x + 60, box.y + 4, { steps: 6 });
    diag.leftDuring = await page.$eval(`[data-clip-id="${beforeDrag.id}"]`, (el) => el.style.left);
    await page.mouse.move(box.x + 120, box.y + 4, { steps: 6 });
    await page.mouse.up();
    dragged = await until('The start really changed', async () => {
      const now = await pickClip();
      return now && Math.abs(now.start - beforeDrag.start) > 1e-6 ? now : null;
    }, 10_000);
  }
  check(!!dragged, 'After dragging a clip its start should change (the timeline is adjustable)', { beforeDrag, dragged });
  step('drag', { seeded, beforeDrag, afterDrag: dragged, ...diag, shot: await shot(page, 'timeline-dragged') });

  /* ---------------- 6c. Context menu has "Quote into the input box" unique to this page ---------------- */
  let menuItems = [];
  if (beforeDrag) {
    await page.click(`[data-clip-id="${beforeDrag.id}"]`, { button: 'right' });
    await until('Context menu', () => page.$('[data-pc="tl-ctxmenu"]'), 10_000);
    menuItems = await page.$$eval('[data-pc="tl-ctxmenu"] .pc-tl-ctxmenu-item', (a) => a.map((el) => el.textContent.trim()));
    await page.keyboard.press('Escape');
  }
  check(menuItems.includes('Quote into input box'), 'The context menu should have "Quote into input box", which only this page has', menuItems);
  check(menuItems.some((m) => m === 'Delete' || m.startsWith('Split at playhead')), 'The context menu should be the real timeline\'s set (has delete, split)', menuItems);
  step('ctxmenu', { items: menuItems });

  /* ---------------- 7. "Enter Classic mode" → editor ---------------- */
  await clickPc(page, 'start-enter-traditional');
  const inEditor = await until('Editor', () => page.$('[data-pc="mode-switch"]'), 90_000);
  check(!!inEditor, 'Should enter the editor');
  s = await snapshot(page);
  const vibeSlot = (s.modes ?? []).find((m) => m.label === 'Vibe mode');
  check(!!vibeSlot, 'The top bar should have the "Vibe mode" slot', s.modes);
  check(vibeSlot && !vibeSlot.off, 'In the desktop app this slot should no longer be grayed out', vibeSlot);
  step('editor', { ...s, shot: await shot(page, 'editor-modeswitch') });

  /* ---------------- 8. Top bar item "Vibe mode": return to Vibe mode screen ---------------- */
  /*
   * Before clicking, replace `confirm` with a version that logs and passes. Two reasons:
   *   - This screen was auto-saved, so `goVibe` should not pop up "Unsaved changes exist" in the first
   *     place; whether it popped up is itself one of the check items;
   *   - In WebView2, a real popup is a native modal dialog that CDP cannot dismiss, and probe would
   *     stay stuck there forever.
   */
  await page.evaluate(() => {
    window.__pcConfirms = [];
    window.confirm = (m) => { window.__pcConfirms.push(String(m)); return true; };
  });
  await clickPc(page, 'mode-vibe');
  const backVibe = await until('Back to Vibe mode', () => page.$('[data-pc="start-desktop"]'), 60_000);
  const confirms = await page.evaluate(() => window.__pcConfirms ?? []);
  check(confirms.length === 0, 'Autosave has already happened, so switching to Vibe mode should no longer ask "There are unsaved changes"', confirms);
  check(!!backVibe, 'Clicking "Vibe mode" should leave the editor and return to the Vibe mode screen');
  s = await snapshot(page);
  check(s.url.includes('ui=vibe'), 'After returning, the URL still records ?ui=vibe', s.url);
  step('back', { confirms, ...s, shot: await shot(page, 'back-to-vibe') });

  /* ---------------- 9. "Extensions and storage" returns to Classic start page ---------------- */
  await clickPc(page, 'start-go-classic');
  const classicAgain = await until('Classic start page', () => page.$('[data-pc="start-go-vibe"]'));
  check(!!classicAgain, '"Extensions and storage" should return to the classic start page');
  s = await snapshot(page);
  check(!s.url.includes('ui=vibe'), 'After returning to the classic page, ?ui=vibe should be removed from the URL', s.url);
  step('classic-again', { ...s, shot: await shot(page, 'classic-again') });
  step('dialogs', dialogs);
} catch (e) {
  fails.push(`Threw: ${e instanceof Error ? e.message : String(e)}`);
  try { await shot(page, 'threw'); } catch { /* Skip if unable to capture screenshot */ }
} finally {
  // Disconnect only, do not close browser: this is the user's desktop app window, closing it closes the application
  await browser.disconnect();
}

out.ok = fails.length === 0;
out.fails = fails;
console.log(JSON.stringify(out));
process.exit(out.ok ? 0 : 1);
