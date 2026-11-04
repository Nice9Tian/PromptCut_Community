/**
 * Acceptance check probe on the page side for C6.5 (c65-editor branch): clicks through sync,
 * undo, offline, local backup, and shared projects in a real browser, capturing screenshots.
 *
 * Usage:
 *   node scripts/probes/c65-editor-probe.mjs --origin http://127.0.0.1:5510 --hosted http://127.0.0.1:5518 --out out/c65-editor-shots [--phases local,shared]
 *   node scripts/probes/c65-editor-probe.mjs --origin http://127.0.0.1:5513 --hosted http://127.0.0.1:5518 --out out/c65-editor-shots --phases lan
 *
 * - `--origin`: editor for this branch (`?editor` page); `--hosted`: local hosted stack
 *   (`server/hosted/main.mjs`) replacing Alibaba Cloud, never connecting to the real hosted side;
 *   the `lan` phase requires starting the editor with `PROMPTCUT_LAN_HOST=1`.
 * - Phases:
 *   local  V2 real page version (interleaved editing on two pages, three summaries across two pages
 *          and document service match), partial undo failure / full undo failure notice bar,
 *          outline for other users' edits, offline dialog (discard / replay), overwritten backups
 *          and bubbles, local backup list, AI panel "Undo this step" (injected event)
 *   shared Create shared project (hosted), open shared project, member list (duplicate names,
 *          Agent expansion), creator operations (verify, change password, kick user, ban list,
 *          delete project), kicked blocking dialog, password changed bubble, restart required
 *          notice in LAN mode
 *   lan    Create in LAN mode + same-name hosted project → open dialog shows both candidates side
 *          by side
 * Results: one JSON line (`{ check, ok, ... }`) per item, final line `{ summary }`; exit code 1
 * on failure. Screenshots written to `--out`.
 *
 * ## Cross-machine mode (C6.5 acceptance check U2): `--role creator|member`
 *
 * U2: After another machine enters via "Open shared project", it sees the project with the same
 * projectRev as the LAN host (or hosted side); make one edit there, and the creator receives it
 * within 5 s. Each role opens one real Chrome page, exchanging join info and completion signals
 * only through the coordination port (`probe-coord.mjs`), with no shared file system.
 *
 *   creator (LAN host machine):
 *     node scripts/probes/c65-editor-probe.mjs --role creator --mode lan|hosted (--coord-port <n> [--coord-host 0.0.0.0] | --coord <url>)
 *          (--origin <editor> | --spawn-editor <port>) [--hosted <hosted-url>] [--hosted-public <hosted-url-for-members>] [--out <dir>] [--keep]
 *   member (other machine, outbound only):
 *     node scripts/probes/c65-editor-probe.mjs --role member --coord <url> (--origin <editor> | --spawn-editor <port>) [--hosted <hosted-url>] [--out <dir>]
 *
 * - `--spawn-editor <port>`: probe starts the editor itself at the repository root (`vite --port <port> --strictPort`,
 *   `PROMPTCUT_PUSH=0`), terminating its process tree when done; creator in LAN mode additionally sets
 *   `PROMPTCUT_LAN_HOST=1` (editor binds to `0.0.0.0`), while others bind to `127.0.0.1`.
 *   `--device-id` / `--device-name` override local device info (`PROMPTCUT_DEVICE_ID` / `_NAME`,
 *   used when running two instances on one machine).
 * - `--mode lan`: creator's editor must be the LAN host; member's page finds it via the local editor's
 *   multicast discovery. Hosted address (lookup on the member side checks the hosted side concurrently)
 *   defaults to an unreachable loopback address `http://127.0.0.1:9` to avoid touching the real
 *   hosted side; if `--hosted` is provided, use that.
 * - `--mode hosted`: `--hosted` is required (hosted stack started locally or on the LAN, do not point
 *   to real Alibaba Cloud); `--hosted-public` is the address written to the coordination port for
 *   members (defaults to same as `--hosted`), with member's `--hosted` taking precedence over the one
 *   in the coordination port.
 * - Coordination port keys: `u2-join` (creator → member: project name, project password, mode,
 *   hosted address, rev / sha256 after creation), `u2-entered`, `u2-go` (creator instructs member
 *   to edit, with token), `u2-member-edit` (after member finishes editing and document service
 *   confirms), `u2-creator-edit`, `u2-member-result`. Coordination port keys are not cleared:
 *   use a newly started port from creator each round (`--coord-port`), or start a fresh
 *   `shared-project-probe.mjs --role coord`.
 * - All timing uses local clocks only, no cross-machine timestamp comparisons:
 *     creator's `memberEditSeenMs` = time member's edit appears in this page's store - time member's
 *     "submitted" report is received (recorded as 0 if seen earlier);
 *     also records `memberEditSinceGoMs` = time seen - time own `u2-go` was sent (upper bound including
 *     coordination round-trip and member edit time).
 *     member's `creatorEditSeenMs` follows the same logic. Both are **recorded only, not evaluated**
 *     (probe lead review, 2026-10-23, changed per verification.md "Record elapsed time only, do not
 *     treat as a gate"; originally required ≤ 5000 ms, semantics had no such timing guarantee).
 *     Which edit was seen and whether it was that card are still evaluated as before.
 * - projectRev verification: after member enters, page rev / project sha256 matches what is read
 *   from "probe opens a separate credential connection directly to host (hosted side) project.open",
 *   and matches what creator reported; both sides verify the final version once more at the end.
 * - Screenshots: `<role>-1-*.png` (after creator creation / member entry), `<role>-2-*.png` (after
 *   seeing other party's edits).
 * - At the end, creator deletes this shared project as creator (to prevent the LAN host from
 *   broadcasting on future startups); `--keep` does not delete.
 * Results: one JSON line per step, final line
 * `{ ok, role, mode, projectId, rev, memberEditSeenMs | creatorEditSeenMs, ..., fails }`; exit code 1
 * on failure.
 */
import '../lib/no-user-dirs.mjs'; // First import: does not inherit external PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR; outputs do not land in the user's Videos\PromptCut
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildAuthProtocols } from '../../server/auth/client.mjs';
import { createSharedProject, wsBaseOf } from '../../server/auth/route.mjs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { startCoordServer, coordClient } from './probe-coord.mjs';

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};
let origin = arg('--origin', 'http://127.0.0.1:5510');
const hosted = arg('--hosted', 'http://127.0.0.1:5518');
/** Cross-machine mode (U2): creator | member; omitted defaults to the original three phases */
const ROLE = arg('--role', null);
const outDir = path.resolve(arg('--out', 'out/c65-editor-shots'));
const phases = arg('--phases', 'local,shared').split(',');
fs.mkdirSync(outDir, { recursive: true });

const results = [];
const check = (name, ok, extra = {}) => {
  const r = { check: name, ok: !!ok, ...extra };
  results.push(r);
  console.log(JSON.stringify(r));
  return ok;
};
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

const browser = await puppeteer.launch({
  headless: true,
  defaultViewport: { width: 1440, height: 900 },
  args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1'],
});

/**
 * Whether the editor is viewable: card measurement overlay (`ProbeGate`, "Measuring cards") is
 * absent, and when the project contains clips, at least one clip on the timeline is actually
 * laid out (has width and height, within viewport). Returns { ready, gate, clips, visible }.
 */
const readyState = (page) => P(page, async () => {
  const gate = document.querySelector('[data-pc="probe-gate"]');
  const S = await import('/src/store/project.ts');
  const clips = (S.getState().project?.tracks ?? []).reduce((n, t) => n + (t.clips?.length ?? 0), 0);
  const vw = innerWidth, vh = innerHeight;
  const visible = [...document.querySelectorAll('[data-clip-id]')].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh;
  }).length;
  return { ready: !gate && (clips === 0 || visible > 0), gate: gate ? gate.innerText.replace(/\s+/g, ' ').slice(0, 80) : null, clips, visible };
});
/**
 * Wait for the editor to be viewable: counts only when ready twice consecutively (300 ms interval)
 * to avoid catching the gap where one measurement round just ended and the next is not yet queued.
 * On slow machines, the measurement overlay may stay up for dozens of seconds; does not throw on
 * timeout, returning the last state for the caller to evaluate.
 */
async function waitEditorReady(page, ms) {
  const t0 = Date.now();
  let last = null, streak = 0;
  for (;;) {
    last = await readyState(page).catch((e) => ({ ready: false, error: String(e?.message ?? e).slice(0, 120) }));
    streak = last.ready ? streak + 1 : 0;
    if (streak >= 2) return { ...last, waitedMs: Date.now() - t0 };
    if (Date.now() - t0 > ms) return { ...last, waitedMs: Date.now() - t0 };
    await sleep(300);
  }
}
/** Screenshots where editor was not viewable before capture (name + status); fails during finalization in either mode */
const shotsNotReady = [];
const SHOT_READY_MS = Number(arg('--shot-ready-timeout', '90')) * 1000;

async function shot(page, name) {
  await page.bringToFront();
  const ready = await waitEditorReady(page, SHOT_READY_MS);
  if (!ready.ready) shotsNotReady.push({ name, ...ready });
  await sleep(150);
  await closeAiSetup(page);
  const file = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(JSON.stringify({ shot: file, ready: ready.ready, waitedMs: ready.waitedMs, ...(ready.ready ? {} : { gate: ready.gate, clips: ready.clips, visible: ready.visible }) }));
  return file;
}

/** Open an editor page, wait for sync to connect; close the initial "Select AI assistant" dialog */
async function openEditor(query = '') {
  if (process.env.PROBE_TRACE) console.error('[step] open', query);
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log(JSON.stringify({ pageerror: String(e?.message ?? e).slice(0, 300) })));
  // Native dialogs block evaluate in the page: record and dismiss them
  page.on('dialog', (d) => { console.log(JSON.stringify({ dialog: d.type(), message: d.message().slice(0, 300) })); void d.dismiss(); });
  // In background pages, page.click / page.type wait for scrolling and visibility and hang
  // indefinitely: bring to the front before clicking or typing
  for (const m of ['click', 'type']) {
    const orig = page[m].bind(page);
    page[m] = async (...a) => { await page.bringToFront(); return orig(...a); };
  }
  await page.goto(`${origin}/?editor${query}`, { waitUntil: 'domcontentloaded' });
  await waitFor(() => page.evaluate(() => !!window.__pcSyncTest && window.__pcSyncTest.view().status === 'online'), 30_000, 'page sync connected');
  // When opening a project, the card measurement overlay covers the entire editor (clicks and
  // typing cannot land) and can hang for dozens of seconds on slow machines: wait for it to dismiss
  // and the timeline to lay out
  const ready = await waitEditorReady(page, Number(arg('--open-ready-timeout', '300')) * 1000);
  if (!ready.ready) throw new Error(`The editor did not become operable after opening (measurement overlay/timeline): ${JSON.stringify(ready)}`);
  say('editor.ready', { url: page.url(), waitedMs: ready.waitedMs, clips: ready.clips, visible: ready.visible });
  await sleep(800);
  await closeAiSetup(page);
  return page;
}

async function closeAiSetup(page) {
  await page.evaluate(() => {
    for (const b of document.querySelectorAll('.ais-dialog .ais-btn')) if (b.textContent?.trim() === 'Close') b.click();
  });
  await sleep(200);
}

const P = (page, fn, ...args) => {
  if (process.env.PROBE_TRACE) console.error('[eval]', page.url().slice(-40), String(fn).slice(0, 80).replace(/\s+/g, ' '));
  return page.evaluate(fn, ...args);
};

/** Summary of the current project in the page */
const pageDigest = (page) => P(page, async () => {
  const S = await import('/src/store/project.ts');
  const json = JSON.stringify(S.getState().project);
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json));
  return { sha256: [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join(''), rev: window.__pcSyncTest.rev(), status: window.__pcSyncTest.view().status };
});

/** Real instance in document service (this machine local space): loopback connection project.open */
function docState(projectId, base = origin) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/docservice`, ['promptcut.v1']);
    const parts = [];
    const done = (project, rev) => {
      const json = JSON.stringify(project);
      resolve({ rev, sha256: createHash('sha256').update(json).digest('hex'), project });
      ws.close();
    };
    ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'project.open', projectId })));
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.type === 'project.state' && m.project) done(m.project, m.rev);
      else if (m.type === 'project.state.part') parts[m.index] = m.data;
      else if (m.type === 'project.state.end') done(JSON.parse(parts.join('')), m.rev);
    });
    ws.addEventListener('error', () => reject(new Error('Cannot connect to the document service')));
    setTimeout(() => reject(new Error('project.open timed out')), 8000);
  });
}

const clipIds = (page) => P(page, async () => {
  const S = await import('/src/store/project.ts');
  return S.getState().project.tracks.flatMap((t) => t.clips.map((c) => c.id));
});
const clipOf = (page, id) => P(page, async (id) => {
  const S = await import('/src/store/project.ts');
  return S.getState().project.tracks.flatMap((t) => t.clips).find((c) => c.id === id) ?? null;
}, id);
const setParam = (page, id, params) => P(page, async (id, params) => {
  const S = await import('/src/store/project.ts');
  S.actions.setClipParams(id, params);
}, id, params);
/** Modify parameters of two clips in one commit (a single step when undoing) */
const setTwo = (page, a, b, text) => P(page, async (a, b, text) => {
  const S = await import('/src/store/project.ts');
  S.actions.editCardProject((p) => ({ ...p, tracks: p.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => (c.id === a || c.id === b ? { ...c, params: { ...c.params, text } } : c)) })) }));
}, a, b, text);
async function pressUndo(page, redo = false) {
  await P(page, () => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  await page.keyboard.down('Control');
  if (redo) await page.keyboard.down('Shift');
  await page.keyboard.press('KeyZ');
  if (redo) await page.keyboard.up('Shift');
  await page.keyboard.up('Control');
}
const settle = async (...pages) => {
  for (const p of pages) {
    await waitFor(() => P(p, () => window.__pcSyncTest.view().status === 'online'), 15_000, 'back to online').catch(async (e) => {
      throw new Error(`${e.message}:${JSON.stringify(await P(p, () => ({ status: window.__pcSyncTest.view().status, url: location.search })))}`);
    });
  }
  await sleep(600);
};
/** Click button by text (within selector scope) */
async function clickText(page, text, scope = 'body') {
  if (process.env.PROBE_TRACE) console.error('[step] click', text);
  const ok = await P(page, (text, scope) => {
    const root = document.querySelector(scope) ?? document.body;
    const el = [...root.querySelectorAll('button, [role=menuitem]')].find((b) => b.textContent?.replace(/\s+/g, ' ').trim().includes(text) && !b.disabled);
    if (!el) return false;
    el.click();
    return true;
  }, text, scope);
  if (!ok) throw new Error(`Button "${text}" not found`);
  await sleep(250);
}
async function typeInto(page, selector, text) {
  if (process.env.PROBE_TRACE) console.error('[step] type', selector);
  await page.click(selector);
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  await page.type(selector, text);
}
async function openProjectMenu(page) {
  for (let i = 0; i < 3; i++) {
    await closeAiSetup(page);
    await page.click('.pc-proj-btn');
    await sleep(300);
    if (await P(page, () => !!document.querySelector('.pc-proj-menu'))) return;
  }
  throw new Error('The project menu did not open');
}

/* ======================================================================== local */

async function phaseLocal() {
  const A = await openEditor();
  const docId = await P(A, () => window.__pcSyncTest.docProjectId());
  const B = await openEditor(`&join=${encodeURIComponent(docId)}`);
  check('join-page-gets-docservice-content', (await pageDigest(A)).sha256 === (await pageDigest(B)).sha256, { docId });

  // ---------- V2 real-page version: two pages interleaved 100 times each (scrub / modify parameters)
  const run = (page, seed, n) => P(page, async (seed, n) => {
    const S = await import('/src/store/project.ts');
    let x = seed >>> 0;
    const rnd = () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296);
    let edits = 0;
    for (let i = 0; i < n; i++) {
      const clips = S.getState().project.tracks.flatMap((t) => t.clips);
      const c = clips[Math.floor(rnd() * clips.length)];
      if (rnd() < 0.5) {
        const dt = (rnd() - 0.5) * 0.6;
        S.actions.moveClip(c.id, { start: Math.max(0, c.start + dt), end: Math.max(0.1, c.end + dt) });
      } else S.actions.setClipParams(c.id, { v2: `s${seed}-${i}` });
      edits++;
      await new Promise((r) => setTimeout(r, 3 + Math.floor(rnd() * 25)));
    }
    return edits;
  }, seed, n);
  const [ea, eb] = await Promise.all([run(A, 101, 100), run(B, 202, 100)]);
  await settle(A, B);
  const [da, db, ds] = [await pageDigest(A), await pageDigest(B), await docState(docId)];
  check('V2-page-real', da.sha256 === db.sha256 && db.sha256 === ds.sha256 && da.rev === ds.rev && db.rev === ds.rev, { edits: [ea, eb], a: da, b: db, doc: { rev: ds.rev, sha256: ds.sha256 } });
  await shot(A, 'v2-page-a');
  await shot(B, 'v2-page-b');

  const ids = await clipIds(A);
  const [c1, c2, c3, c4, c5, c6, c7, c8] = ids;

  // ---------- Undo: partially not undone (A modifies clips 1 and 2 in one step; B then modifies
  // clip 2; A undoes)
  await setTwo(A, c1, c2, 'A edited');
  await settle(A, B);
  const beforeC1 = (await docState(docId)).project.tracks.flatMap((t) => t.clips).find((c) => c.id === c1);
  await setParam(B, c2, { text: 'B edited' });
  await settle(A, B);
  await pressUndo(A);
  await sleep(500);
  const notice = await P(A, () => document.querySelector('[data-pc=undo-notice]')?.innerText ?? null);
  const a1 = await clipOf(A, c1);
  const a2 = await clipOf(A, c2);
  check('undo-partial-notice', !!notice && notice.includes('Undone, but these were overwritten by later changes and not reverted:') && a2.params.text === 'B edited' && a1.params.text !== 'A edited', { notice, c1: a1.params.text, c2: a2.params.text, c1WasBefore: beforeC1?.params?.text });
  await shot(A, 'undo-partial-notice');
  // Click entity name to jump there and select it
  await P(A, () => document.querySelector('[data-pc=undo-notice] .pc-undo-entity')?.click());
  await sleep(300);
  const sel = await P(A, async () => (await import('/src/store/project.ts')).getState().selection);
  check('undo-notice-jump-selects', sel[0] === c2, { selection: sel });
  await P(A, () => document.querySelector('[data-pc=undo-notice] .pc-undo-bar-close')?.click());

  // ---------- Undo: nothing undone
  await settle(A, B);
  await setParam(A, c3, { text: 'A3' });
  await settle(A, B);
  await setParam(B, c3, { text: 'B3' });
  await settle(A, B);
  await pressUndo(A);
  await sleep(500);
  const none = await P(A, () => document.querySelector('[data-pc=undo-notice]')?.innerText ?? null);
  check('undo-none-notice', !!none && none.includes("Couldn't undo. These were all changed afterwards, so they keep their current state:") && none.includes('see the current state of the changed spots'), { notice: none, c3: (await clipOf(A, c3)).params.text });
  await shot(A, 'undo-none-notice');
  await P(A, () => document.querySelector('[data-pc=undo-notice] .pc-undo-bar-close')?.click());

  // ---------- Button disabled state and tooltip
  const btn = await P(A, () => ({
    undoTitle: document.querySelector('[data-pc=undo-btn]')?.getAttribute('title'),
    redoTitle: document.querySelector('[data-pc=redo-btn]')?.getAttribute('title'),
    undoDisabled: document.querySelector('[data-pc=undo-btn] button')?.disabled,
    redoDisabled: document.querySelector('[data-pc=redo-btn] button')?.disabled,
  }));
  check('undo-buttons', btn.undoTitle === 'Undo (Ctrl+Z): only undoes your own actions on this page' && btn.redoTitle === 'Redo (Ctrl+Shift+Z / Ctrl+Y): restores the action you just undid (no longer available after a new action)', btn);
  const fresh = await openEditor(`&join=${encodeURIComponent(docId)}`);
  const freshBtn = await P(fresh, () => ({ undo: document.querySelector('[data-pc=undo-btn] button')?.disabled, redo: document.querySelector('[data-pc=redo-btn] button')?.disabled }));
  check('undo-buttons-disabled-when-empty', freshBtn.undo === true && freshBtn.redo === true, freshBtn);
  await fresh.close();

  // Ctrl+Y redo
  await setParam(A, c4, { text: 'A4' });
  await settle(A, B);
  await pressUndo(A);
  await settle(A, B);
  const afterUndo = (await clipOf(A, c4)).params.text;
  await P(A, () => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  await A.keyboard.down('Control');
  await A.keyboard.press('KeyY');
  await A.keyboard.up('Control');
  await settle(A, B);
  check('ctrl-y-redo', afterUndo !== 'A4' && (await clipOf(A, c4)).params.text === 'A4', { afterUndo });

  // ---------- Others' edits: timeline stroke 1.5 s
  await A.bringToFront();
  await setParam(B, c4, { text: 'B edited here' });
  await sleep(300);
  const flashed = await P(A, (id) => !!document.querySelector(`[data-clip-id="${id}"][data-remote-flash]`), c4);
  await A.screenshot({ path: path.join(outDir, 'remote-flash.png') });
  await sleep(1700);
  const gone = await P(A, (id) => !document.querySelector(`[data-clip-id="${id}"][data-remote-flash]`), c4);
  check('remote-flash-1.5s', flashed && gone, { flashed, goneAfter: gone });

  // ---------- Overwritten: A modifies clip 6, B then modifies the same clip → A first saves local
  // backup, shows bubble
  await setParam(A, c6, { text: 'A6' });
  await settle(A, B);
  await setParam(B, c6, { text: 'B6' });
  await settle(A, B);
  const toast = await waitFor(() => P(A, () => [...document.querySelectorAll('.pc-toast')].map((t) => t.innerText).find((t) => t.includes('overwritten')) ?? null), 5000, 'overwritten bubble').catch(() => null);
  check('overwritten-toast', !!toast && toast.startsWith('Your recent changes were overwritten by you on another page.'), { toast });
  await shot(A, 'overwritten-toast');

  // ---------- Offline: A modifies 3 times while disconnected, B also modifies in the meantime; A
  // comes back → first edit rejected → conflict merge dialog
  // Starting 2026-10-22, the whole-batch "Add in / Discard" offline dialog was replaced with
  // item-by-item "Merge conflicts" (conflict-merge report section 10):
  // "Discard" = check all → delete selected; "Add in" = check all → merge; after closing the dialog
  // (decide later), the top bar shows the "Merge conflicts" button (formerly "Sync paused")
  const offline = async (value) => {
    await P(A, () => window.__pcSyncTest.drop(4000));
    await waitFor(() => P(A, () => window.__pcSyncTest.view().status === 'offline'), 5000, 'A offline');
    for (let i = 0; i < 3; i++) await setParam(A, c5, { text: `${value}${i}` });
    await setParam(B, c7, { text: `B7-${value}` });
    await setParam(B, c5, { text: `B5-${value}` });
    await sleep(300);
    const chip = await P(A, () => document.querySelector('[data-pc=sync-offline]')?.innerText ?? null);
    await waitFor(() => P(A, () => !!document.querySelector('[data-pc=conflict-merge]')), 15_000, 'A\'s conflict merge window');
    await sleep(300);
    const dlg = await P(A, () => document.querySelector('[data-pc=conflict-merge]')?.innerText ?? null);
    const row = await P(A, (id) => document.querySelector(`[data-pc=merge-thing][data-key="offline:clip:${id}"]`)?.innerText ?? null, c5);
    return { chip, dlg, row };
  };
  const mergeAll = async (button) => {
    await P(A, () => { for (const i of document.querySelectorAll('[data-pc=merge-thing-check]')) if (!i.checked) i.click(); });
    await P(A, (b) => document.querySelector(`[data-pc="${b}"]`)?.click(), button);
    await waitFor(() => P(A, () => document.querySelector('[data-pc=merge-close]')?.textContent?.trim() === 'Done'), 5000, 'list cleared');
    await P(A, () => document.querySelector('[data-pc=merge-close]')?.click());
  };
  const off1 = await offline('offline');
  check('conflict-merge-window', !!off1.dlg && off1.dlg.includes('Merge conflicts') && !!off1.row && off1.row.includes('"offline2"') && off1.row.includes('The cloud is now "B5-offline"') && off1.chip === 'offline', off1);
  await shot(A, 'conflict-merge-window');
  await P(A, () => document.querySelector('[data-pc=merge-close]')?.click());
  await sleep(300);
  const navChip = await P(A, () => document.querySelector('[data-pc=conflict-merge-open]')?.innerText ?? null);
  check('merge-button-after-close', !!navChip && navChip.includes('Merge conflicts'), { navChip });
  await shot(A, 'conflict-merge-button');
  await P(A, () => document.querySelector('[data-pc=conflict-merge-open]')?.click());
  await sleep(300);
  check('merge-button-reopens-window', await P(A, () => !!document.querySelector('[data-pc=conflict-merge]')));
  await mergeAll('merge-delete');
  await settle(A, B);
  const afterDiscard = [await pageDigest(A), await pageDigest(B), await docState(docId)];
  check('offline-discard', afterDiscard[0].sha256 === afterDiscard[2].sha256 && afterDiscard[1].sha256 === afterDiscard[2].sha256 && (await clipOf(A, c5)).params.text === 'B5-offline', { c5: (await clipOf(A, c5)).params.text });

  const off2 = await offline('replay');
  check('conflict-merge-window-2', !!off2.dlg);
  await mergeAll('merge-apply');
  await settle(A, B);
  const afterReplay = [await pageDigest(A), await pageDigest(B), await docState(docId)];
  check('offline-replay', afterReplay[0].sha256 === afterReplay[2].sha256 && afterReplay[1].sha256 === afterReplay[2].sha256 && (await clipOf(A, c5)).params.text === 'replay2' && (await clipOf(A, c7)).params.text === 'B7-replay', { c5: (await clipOf(A, c5)).params.text, c7: (await clipOf(A, c7)).params.text });

  // ---------- Local backup list (the batch before discard + the overwritten version); restore = a
  // new write
  await openProjectMenu(A);
  await clickText(A, 'Local backup…', '.pc-proj-menu');
  await waitFor(() => P(A, () => document.querySelectorAll('[data-pc=backup-row]').length > 0), 5000, 'backup list');
  const rows = await P(A, () => [...document.querySelectorAll('[data-pc=backup-row]')].map((r) => r.innerText.replace(/\s+/g, ' ')));
  check('backups-list', rows.some((r) => r.includes('Discarded while offline')) && rows.some((r) => r.includes('overwritten')), { rows: rows.slice(0, 6) });
  await shot(A, 'backups-dialog');
  // Restore the overwritten version (clip 6 reverts to A6)
  const revBefore = (await docState(docId)).rev;
  await P(A, (c6) => {
    const row = [...document.querySelectorAll('[data-pc=backup-row]')].find((r) => r.dataset.entity?.endsWith(`/@${c6}`) && r.innerText.includes('overwritten by you on another page'));
    row?.querySelector('button')?.click();
  }, c6);
  await settle(A, B);
  const d6 = await docState(docId);
  check('backup-restore-is-new-write', d6.project.tracks.flatMap((t) => t.clips).find((c) => c.id === c6)?.params.text === 'A6' && d6.rev > revBefore && (await clipOf(B, c6)).params.text === 'A6', { revBefore, revAfter: d6.rev });
  await clickText(A, 'Close', '[data-pc=backups-dialog]');

  // ---------- AI panel "Undo this step": Agent commit (simulated via a loopback connection) +
  // inject completion event with opId
  const agentOp = (ops) => new Promise((resolve, reject) => {
    const ws = new WebSocket(`${origin.replace(/^http/, 'ws')}/docservice`, ['promptcut.v1']);
    const opId = `agent-op-${Date.now()}`;
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'project.open', projectId: docId }));
      ws.send(JSON.stringify({ type: 'project.op', projectId: docId, opId, session: 'agent-conv-1', ops }));
    });
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.type === 'project.op.ok' && m.opId === opId) { resolve({ opId, rev: m.rev }); ws.close(); }
      if (m.type === 'project.op.rejected' && m.opId === opId) { reject(new Error(JSON.stringify(m))); ws.close(); }
    });
  });
  const path8 = (await docState(docId)).project.tracks.map((t, ti) => ({ t, ti })).find(({ t }) => t.clips.some((c) => c.id === c8));
  const before8 = (await clipOf(A, c8)).params.text ?? null;
  const { opId: agentOpId, rev: agentRev } = await agentOp([{ op: 'set', path: `/tracks/@${path8.t.id}/clips/@${c8}/params/text`, value: 'Edited by Agent' }]);
  await settle(A, B);
  await P(A, (opId, rev) => window.__pcSyncTest.inject({ type: 'events.event', phase: 'complete', eventId: 'ev-probe-1', callId: 'call-probe-1', opId, rev, status: 'ok' }), agentOpId, agentRev);
  const reverted = await P(A, async () => {
    const m = await import('/src/editor/sync/syncManager.ts');
    const rec = m.agentOpFor('call-probe-1');
    const r = rec ? m.revertAgentOp(rec) : null;
    return { found: !!rec, done: r?.done ?? null, state: m.agentOpFor('call-probe-1')?.state ?? null };
  });
  await settle(A, B);
  const d8 = await docState(docId);
  const log8 = d8.project.tracks.flatMap((t) => t.clips).find((c) => c.id === c8).params.text ?? null;
  const canUndo = await P(A, async () => (await import('/src/store/project.ts')).actions.canUndo());
  check('agent-undo-step', reverted.found && reverted.done && reverted.state === 'done' && log8 === before8 && canUndo, { reverted, before8, now: log8 });
  // Entered the user's own undo stack: Ctrl+Z restores the Agent's changes
  await pressUndo(A);
  await settle(A, B);
  check('agent-undo-in-user-stack', (await clipOf(B, c8)).params.text === 'Edited by Agent');

  await B.close();
  return { A, docId };
}

/* ======================================================================== shared */

async function setHosted(page) {
  await P(page, (u) => localStorage.setItem('pc.shared.hostedUrl', u), hosted);
}

async function phaseShared() {
  const A = await openEditor();
  const B = await openEditor();
  await setHosted(A);
  await setHosted(B);
  const name = `c65-demo-${Date.now().toString(36)}`;

  // ---------- Create shared project: first inspect restricted entry list table, then create with
  // open entry
  await openProjectMenu(A);
  await clickText(A, 'New shared project', '.pc-proj-menu');
  await typeInto(A, '#pc-ns-name', name);
  await typeInto(A, '#pc-ns-creator', 'alice');
  await typeInto(A, '#pc-ns-cpw', 'alice-pw');
  await clickText(A, 'Restricted entry', '[data-pc=new-shared-dialog]');
  await A.type('[data-pc=list-editor] .pc-sync-list-row:last-child input:nth-child(1)', 'render-host');
  await A.type('[data-pc=list-editor] .pc-sync-list-row:last-child input:nth-child(2)', 'rh-pw');
  await clickText(A, 'Add', '[data-pc=list-editor]');
  await P(A, () => document.querySelector('[data-pc=new-shared-dialog]')?.scrollTo(0, 9999));
  await shot(A, 'new-shared-restricted');
  await clickText(A, 'LAN mode', '[data-pc=new-shared-dialog]');
  await sleep(200);
  const lanHint = await P(A, () => document.querySelector('[data-pc=lan-restart-hint]')?.innerText ?? null);
  check('lan-needs-restart-hint', !!lanHint && lanHint.includes('PROMPTCUT_LAN_HOST=1'), { lanHint });
  await shot(A, 'new-shared-lan-restart');
  await clickText(A, 'Internet mode', '[data-pc=new-shared-dialog]');
  await clickText(A, 'Open entry', '[data-pc=new-shared-dialog]');
  await typeInto(A, '#pc-ns-ppw', 'team-pw');
  await P(A, () => document.querySelector('[data-pc=new-shared-dialog]')?.scrollTo(0, 0));
  await shot(A, 'new-shared-dialog');
  await clickText(A, 'Create', '[data-pc=new-shared-dialog] .pc-dialog-foot');
  const created = await waitFor(() => P(A, () => document.querySelector('[data-pc=new-shared-dialog] .pc-sync-status-line')?.innerText.includes('Created successfully') ? document.querySelector('[data-pc=new-shared-dialog] .pc-sync-status-line').innerText : null), 20_000, 'Created successfully').catch(() => null);
  const aView = await P(A, () => { const v = window.__pcSyncTest.view(); return { kind: v.kind, shared: v.shared, status: v.status }; });
  check('new-shared-hosted', created === 'Created successfully. You are now in the project.' && aView.kind === 'shared', { created, aView });
  await shot(A, 'new-shared-done');
  await clickText(A, 'Back', '[data-pc=new-shared-dialog]');
  const sharedId = aView.shared?.projectId;

  // ---------- Open shared project (B): search → verify → enter
  await openProjectMenu(B);
  await clickText(B, 'Open shared project', '.pc-proj-menu');
  await B.type('#pc-os-name', name);
  await clickText(B, 'Hosted address', '[data-pc=open-shared-dialog]');
  await shot(B, 'open-shared-find');
  await clickText(B, 'Find', '[data-pc=open-shared-dialog] .pc-dialog-foot');
  await waitFor(() => P(B, () => !!document.querySelector('#pc-os-user')), 15_000, 'reached verification step');
  await shot(B, 'open-shared-verify');
  await typeInto(B, '#pc-os-pw', 'wrong-pw');
  await typeInto(B, '#pc-os-user', 'bob');
  await clickText(B, 'Enter', '[data-pc=open-shared-dialog] .pc-dialog-foot');
  const wrong = await waitFor(() => P(B, () => document.querySelector('[data-pc=open-shared-dialog] .pc-sync-status-line')?.innerText ?? null), 15_000, 'wrong-password notice').catch(() => null);
  check('open-shared-wrong-password', wrong === "Wrong username or password. If you've forgotten them, ask the creator.", { wrong });
  await typeInto(B, '#pc-os-pw', 'team-pw');
  await clickText(B, 'Enter', '[data-pc=open-shared-dialog] .pc-dialog-foot');
  await waitFor(() => P(B, () => window.__pcSyncTest.view().kind === 'shared'), 15_000, 'B enters the shared project').catch(async (e) => {
    throw new Error(`${e.message}:${JSON.stringify(await P(B, () => ({ line: document.querySelector('[data-pc=open-shared-dialog] .pc-sync-status-line')?.innerText, pw: document.querySelector('#pc-os-pw')?.value, user: document.querySelector('#pc-os-user')?.value })))}`);
  });
  await settle(A, B);
  check('open-shared-enter', (await pageDigest(A)).sha256 === (await pageDigest(B)).sha256, { a: await pageDigest(A), b: await pageDigest(B) });

  // ---------- Member list: same name on different devices, Agent chat
  const device = await P(B, () => window.__pcSyncTest.view().device);
  const wsBase = hosted.replace(/^http/, 'ws');
  const extra = [];
  const conn = async (o) => {
    const protocols = await buildAuthProtocols({ base: hosted, projectId: sharedId, deviceName: o.deviceName ?? device.deviceName, ...o });
    const ws = new WebSocket(wsBase, protocols);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    extra.push(ws);
    return ws;
  };
  await conn({ username: 'bob', deviceId: device.deviceId, password: 'team-pw', role: 'agent', conversation: 2 });
  await conn({ username: 'bob', deviceId: 'pc-macbook-probe-0001', deviceName: 'MacBook', password: 'team-pw', role: 'page' });
  await sleep(800);
  await A.click('[data-pc=members-button]');
  await sleep(300);
  await P(A, () => {
    const row = [...document.querySelectorAll('.pc-members-row-main')].find((r) => r.innerText.includes('Agent'));
    row?.click();
  });
  await sleep(200);
  const pop = await P(A, () => document.querySelector('[data-pc=members-pop]')?.innerText ?? '');
  check('members-list', pop.includes('alice (you)') && pop.includes('[creator]') && pop.includes('[editing]') && pop.includes('[Agent ×1]') && pop.includes('bob (MacBook)') && pop.includes('bob · Agent · chat 2') && pop.includes('Project management (visible to the creator only)'), { pop });
  await shot(A, 'members-list');
  const btnText = await P(A, () => document.querySelector('[data-pc=members-button]')?.innerText ?? '');
  check('members-button-badge', /Members: ?\d+/.test(btnText), { btnText });

  // ---------- Creator operations: change project password (verify → change), members receive bubble
  await clickText(A, 'Change project password', '[data-pc=members-pop]');
  await waitFor(() => P(A, () => !!document.querySelector('[data-pc=creator-verify]')), 5000, 'verification dialog');
  await typeInto(A, '#pc-cv-pw', 'wrong');
  await clickText(A, 'Verify', '[data-pc=creator-verify] .pc-dialog-foot');
  const verr = await waitFor(() => P(A, () => document.querySelector('[data-pc=creator-verify] .pc-sync-err')?.innerText ?? null), 8000, 'wrong password').catch(() => null);
  check('creator-verify-wrong', verr === 'Wrong password.', { verr });
  await typeInto(A, '#pc-cv-pw', 'alice-pw');
  await shot(A, 'creator-verify');
  await clickText(A, 'Verify', '[data-pc=creator-verify] .pc-dialog-foot');
  await waitFor(() => P(A, () => !!document.querySelector('[data-pc=project-password]')), 8000, 'change-password dialog');
  await typeInto(A, '#pc-pw-a', 'team-pw-2');
  await typeInto(A, '#pc-pw-b', 'team-pw-2');
  await shot(A, 'creator-change-password');
  await clickText(A, 'Confirm change', '[data-pc=project-password]');
  const pwToast = await waitFor(() => P(B, () => [...document.querySelectorAll('.pc-toast')].map((t) => t.innerText).find((t) => t.includes('The project password has been changed')) ?? null), 8000, 'password-changed bubble').catch(() => null);
  check('member-password-changed-toast', pwToast?.startsWith('The project password has been changed. Your current connection is not affected, but you will need the new password next time you enter.'), { pwToast });
  await shot(B, 'member-password-changed-toast');

  // ---------- Kick member (kick bob on MacBook): verify → confirm
  await A.click('[data-pc=members-button]');
  await sleep(300);
  await P(A, () => {
    const row = [...document.querySelectorAll('.pc-members-row-main')].find((r) => r.innerText.includes('bob (MacBook)'));
    row?.querySelector('.pc-members-kick')?.click();
  });
  await waitFor(() => P(A, () => !!document.querySelector('[data-pc=creator-verify]')), 5000, 'verification dialog');
  await typeInto(A, '#pc-cv-pw', 'alice-pw');
  await clickText(A, 'Verify', '[data-pc=creator-verify] .pc-dialog-foot');
  await waitFor(() => P(A, () => !!document.querySelector('[data-pc=kick-dialog]')), 8000, 'kick confirmation');
  const kickText = await P(A, () => document.querySelector('[data-pc=kick-dialog]')?.innerText ?? '');
  check('kick-confirm-text', kickText.includes('Are you sure you want to kick bob (MacBook) out of the project?'), { kickText });
  await shot(A, 'creator-kick-confirm');
  await clickText(A, 'Kick', '[data-pc=kick-dialog] .pc-dialog-foot');
  const kickToast = await waitFor(() => P(A, () => [...document.querySelectorAll('.pc-toast')].map((t) => t.innerText).find((t) => t.includes('Kicked')) ?? null), 8000, 'kick bubble').catch(() => null);
  check('kick-free-mode-hint', kickToast?.startsWith('Kicked out. In open entry mode, to block them completely, you need to change the project password.'), { kickToast });

  // ---------- Banned devices
  await A.click('[data-pc=members-button]');
  await sleep(300);
  await clickText(A, 'Banned devices', '[data-pc=members-pop]');
  await typeInto(A, '#pc-cv-pw', 'alice-pw');
  await clickText(A, 'Verify', '[data-pc=creator-verify] .pc-dialog-foot');
  await waitFor(() => P(A, () => !!document.querySelector('[data-pc=bans-dialog]')), 8000, 'ban list');
  const bans = await P(A, () => document.querySelector('[data-pc=bans-dialog]')?.innerText ?? '');
  check('bans-list', bans.includes('pc-macbook-probe-0001') && bans.includes('Revoke'), { bans });
  await shot(A, 'creator-bans');
  await clickText(A, 'Back', '[data-pc=bans-dialog]');

  // ---------- Delete project dialog (manually type project name)
  await A.click('[data-pc=members-button]');
  await sleep(300);
  await clickText(A, 'Delete project', '[data-pc=members-pop]');
  await typeInto(A, '#pc-cv-pw', 'alice-pw');
  await clickText(A, 'Verify', '[data-pc=creator-verify] .pc-dialog-foot');
  await waitFor(() => P(A, () => !!document.querySelector('[data-pc=delete-dialog]')), 8000, 'delete-project dialog');
  const delDisabled = await P(A, () => [...document.querySelectorAll('[data-pc=delete-dialog] button')].find((b) => b.textContent.includes('Permanently delete project'))?.disabled);
  await A.type('[data-pc=delete-dialog] input', name);
  const delEnabled = await P(A, () => !([...document.querySelectorAll('[data-pc=delete-dialog] button')].find((b) => b.textContent.includes('Permanently delete project'))?.disabled));
  check('delete-needs-typed-name', delDisabled === true && delEnabled === true);
  await shot(A, 'creator-delete');
  await clickText(A, 'Cancel', '[data-pc=delete-dialog] .pc-dialog-foot');

  // ---------- Kick B: B sees blocking dialog
  await A.click('[data-pc=members-button]');
  await sleep(300);
  await P(A, () => {
    const row = [...document.querySelectorAll('.pc-members-row-main')].find((r) => r.innerText.startsWith('bob') && !r.innerText.includes('MacBook'));
    row?.querySelector('.pc-members-kick')?.click();
  });
  await waitFor(() => P(A, () => !!document.querySelector('[data-pc=creator-verify]')), 5000, 'verification dialog');
  await typeInto(A, '#pc-cv-pw', 'alice-pw');
  await clickText(A, 'Verify', '[data-pc=creator-verify] .pc-dialog-foot');
  await waitFor(() => P(A, () => !!document.querySelector('[data-pc=kick-dialog]')), 8000, 'kick confirmation');
  await clickText(A, 'Kick', '[data-pc=kick-dialog] .pc-dialog-foot');
  const blocked = await waitFor(() => P(B, () => document.querySelector('[data-pc=blocked-dialog]')?.innerText ?? null), 8000, 'B\'s blocking dialog').catch(() => null);
  check('kicked-blocking-dialog', blocked?.includes('You were kicked out of this project by the creator and can no longer edit. To come back, ask the creator to revoke it.') && blocked.includes('start page'), { blocked });
  await shot(B, 'blocked-kicked');

  // Cleanup: actually delete (verify deletion flow and returning to the start page oneself)
  await A.click('[data-pc=members-button]');
  await sleep(300);
  await clickText(A, 'Delete project', '[data-pc=members-pop]');
  await typeInto(A, '#pc-cv-pw', 'alice-pw');
  await clickText(A, 'Verify', '[data-pc=creator-verify] .pc-dialog-foot');
  await waitFor(() => P(A, () => !!document.querySelector('[data-pc=delete-dialog]')), 8000, 'delete-project dialog');
  await A.type('[data-pc=delete-dialog] input', name);
  await clickText(A, 'Permanently delete project', '[data-pc=delete-dialog] .pc-dialog-foot');
  const gone = await waitFor(async () => (await fetch(`${hosted}/shared/lookup?name=${encodeURIComponent(name)}`)).status === 404, 8000, 'project deleted').catch(() => false);
  const aAfter = await P(A, () => window.__pcSyncTest.view().kind);
  check('delete-project', gone && aAfter === 'local', { aAfter });
  for (const ws of extra) ws.close();
  await A.close();
  await B.close();
}

/* ======================================================================== lan */

async function phaseLan() {
  const C = await openEditor();
  await setHosted(C);
  const lan = await P(C, () => window.__pcSyncTest.view().device);
  if (!check('lan-host-editor', lan?.lanHost === true, { device: lan })) return;
  const name = `c65-lan-${Date.now().toString(36)}`;
  // Hosted project with the same name (created directly via hosted side)
  await createSharedProject({ where: 'hosted', hostedUrl: hosted, name, mode: 'free', creator: { username: 'zed', password: 'zed-pw' }, password: 'x-pw', kdf: { alg: 'pbkdf2-sha256', iter: 100000 } });
  // Create in LAN mode (this machine as host)
  await openProjectMenu(C);
  await clickText(C, 'New shared project', '.pc-proj-menu');
  await typeInto(C, '#pc-ns-name', name);
  await typeInto(C, '#pc-ns-creator', 'carol');
  await typeInto(C, '#pc-ns-cpw', 'carol-pw');
  await clickText(C, 'LAN mode', '[data-pc=new-shared-dialog]');
  await typeInto(C, '#pc-ns-ppw', 'lan-pw');
  await shot(C, 'new-shared-lan');
  await clickText(C, 'Create', '[data-pc=new-shared-dialog] .pc-dialog-foot');
  const created = await waitFor(() => P(C, () => { const t = document.querySelector('[data-pc=new-shared-dialog] .pc-sync-status-line')?.innerText; return t?.includes('Created successfully') ? t : null; }), 20_000, 'LAN project created').catch(() => null);
  check('new-shared-lan', created === 'Created successfully. Members on the same network segment can join by looking up the project name. Remember to keep this machine on.', { created });
  await clickText(C, 'Back', '[data-pc=new-shared-dialog]');
  await sleep(1500);
  // Search from another page: one each from LAN (local host responds via multicast) + hosted side
  // → side by side
  const D = await openEditor();
  await setHosted(D);
  await openProjectMenu(D);
  await clickText(D, 'Open shared project', '.pc-proj-menu');
  await D.type('#pc-os-name', name);
  await clickText(D, 'Find', '[data-pc=open-shared-dialog] .pc-dialog-foot');
  const cands = await waitFor(() => P(D, () => { const el = document.querySelector('[data-pc=shared-candidates]'); return el ? el.innerText : null; }), 15_000, 'side-by-side candidates').catch(() => null);
  check('open-shared-two-candidates', !!cands && cands.includes('[Internet mode] Hosted on Alibaba Cloud') && cands.includes('[LAN mode] Host:'), { cands, title: await P(D, () => document.querySelector('[data-pc=open-shared-dialog] .pc-dialog-body')?.innerText.split('\n')[0]) });
  await shot(D, 'open-shared-choose');
  await C.close();
  await D.close();
}

/* ======================================================================== U2 cross-machine */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const say = (step, fields = {}) => console.log(JSON.stringify({ step, t: Date.now(), ...fields }));

/**
 * worktree has no node_modules of its own (resolves up to main repo): resolve vite as a module,
 * then return to package root to find bin
 */
function viteBin() {
  const local = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  if (fs.existsSync(local)) return local;
  const main = createRequire(import.meta.url).resolve('vite');
  const at = main.lastIndexOf(`${path.sep}vite${path.sep}`);
  return path.join(main.slice(0, at + 6), 'bin', 'vite.js');
}

let editorProc = null;
const editorLog = [];
/**
 * Start an editor at the repo root; when `lan`, act as the LAN host (PROMPTCUT_LAN_HOST=1, editor
 * rebinds to 0.0.0.0 itself)
 */
async function spawnEditor(port, { lan }) {
  const env = { ...process.env, PROMPTCUT_PUSH: '0' };
  if (lan) env.PROMPTCUT_LAN_HOST = '1';
  else delete env.PROMPTCUT_LAN_HOST;
  const id = arg('--device-id', null);
  const nm = arg('--device-name', null);
  if (id) env.PROMPTCUT_DEVICE_ID = id;
  if (nm) env.PROMPTCUT_DEVICE_NAME = nm;
  editorProc = spawn(process.execPath, [viteBin(), '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env });
  const keep = (c) => { editorLog.push(c.toString()); if (editorLog.length > 300) editorLog.shift(); };
  editorProc.stdout.on('data', keep);
  editorProc.stderr.on('data', keep);
  origin = `http://127.0.0.1:${port}`;
  say('editor.spawn', { pid: editorProc.pid, origin, lan: !!lan });
  await waitFor(async () => {
    if (editorProc.exitCode !== null) throw new Error(`The editor process exited (${editorProc.exitCode}): ${editorLog.join('').slice(-600)}`);
    return fetch(`${origin}/`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false);
  }, 180_000, 'editor started');
}
async function stopEditor() {
  if (!editorProc || editorProc.exitCode !== null || !editorProc.pid) return;
  const exited = new Promise((r) => editorProc.once('exit', r));
  // The editor also keeps prerender processes and Chrome running: terminate along with the process
  // tree (only terminate this tree spawned by itself)
  if (process.platform === 'win32') spawn('taskkill', ['/PID', String(editorProc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else editorProc.kill('SIGKILL');
  await Promise.race([exited, sleep(10_000)]);
  say('editor.stopped', { pid: editorProc.pid });
}

/**
 * The probe opens a separate credential connection to read project directly from the host (hosted
 * side): { rev, sha256 }
 */
async function hostRead(base, projectId, cred, tag) {
  const protocols = await buildAuthProtocols({
    base, projectId, username: cred.username, as: cred.as, password: cred.password, role: 'page',
    deviceId: `u2-reader-${tag}`.padEnd(16, '0').slice(0, 64), deviceName: 'u2-probe-reader',
  });
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsBaseOf(base), protocols);
    const parts = [];
    const timer = setTimeout(() => { reject(new Error('host project.open timed out')); ws.close(); }, 10_000);
    const done = (project, rev) => {
      clearTimeout(timer);
      resolve({ rev, sha256: createHash('sha256').update(JSON.stringify(project)).digest('hex') });
      ws.close();
    };
    ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'project.open', projectId })));
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.type === 'project.state' && m.project) done(m.project, m.rev);
      else if (m.type === 'project.state.part') parts[m.index] = m.data;
      else if (m.type === 'project.state.end') done(JSON.parse(parts.join('')), m.rev);
    });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error(`Cannot connect to host ${wsBaseOf(base)}`)); });
  });
}

/**
 * Modify clip parameters in the same evaluate and wait for document service confirmation
 * (DocSync.whenSettled); return milliseconds from modification to confirmation (page clock)
 */
const editAndSave = (page, id, params) => P(page, async (id, params) => {
  const S = await import('/src/store/project.ts');
  const M = await import('/src/editor/sync/syncManager.ts');
  const t0 = performance.now();
  S.actions.setClipParams(id, params);
  await M.whenSaved(10_000);
  return Math.round((performance.now() - t0) * 10) / 10;
}, id, params);

/**
 * Watch page store: which clip's params.text becomes value. Returns { at(this machine timestamp),
 * clipId, flash(timeline has "others' edits" stroke) }.
 * Start watching immediately (without waiting for reports), so peer changes arriving before the
 * coordinator port report are also captured.
 */
function watchFor(page, value, ms, shotName) {
  return (async () => {
    const hit = await waitFor(() => P(page, async (value) => {
      const S = await import('/src/store/project.ts');
      const c = S.getState().project.tracks.flatMap((t) => t.clips).find((x) => x.params?.text === value);
      if (!c) return null;
      return { clipId: c.id, flash: !!document.querySelector(`[data-clip-id="${c.id}"][data-remote-flash]`) };
    }, value), ms, `page shows ${value}`);
    const at = Date.now();
    const file = await shot(page, shotName);
    return { at, ...hit, shot: file };
  })();
}

async function openSharedMenu(page, item) {
  await openProjectMenu(page);
  await clickText(page, item, '.pc-proj-menu');
}

async function runCreator(res, fails) {
  const mode = arg('--mode', null);
  if (mode !== 'lan' && mode !== 'hosted') throw new Error('--mode must be lan or hosted');
  if (mode === 'hosted' && !argv.includes('--hosted')) throw new Error('Hosted mode requires --hosted <hosted bundle address>');
  res.mode = mode;
  const runId = res.runId;
  const timeoutMs = Number(arg('--timeout', '900')) * 1000;

  // Coordinator port: start one yourself (--coord-host 0.0.0.0 for cross-machine), or use an
  // existing one
  let coordUrl = arg('--coord', null);
  const coordPort = arg('--coord-port', null);
  if (coordPort) {
    const server = await startCoordServer({ port: Number(coordPort), host: arg('--coord-host', '127.0.0.1') });
    res._coordServer = server;
    coordUrl = server.url;
    say('coord.listen', { port: server.port, host: arg('--coord-host', '127.0.0.1') });
  }
  if (!coordUrl) throw new Error('Requires --coord-port <n> (this process starts a coordinator port) or --coord <url>');
  res.coord = coordUrl;
  const coord = coordClient(coordUrl);

  if (arg('--spawn-editor', null)) await spawnEditor(Number(arg('--spawn-editor')), { lan: mode === 'lan' });
  res.origin = origin;
  const A = await openEditor();
  const device = await P(A, () => window.__pcSyncTest.view().device);
  res.device = device;
  if (mode === 'lan' && !(device?.lanHost && device?.localEditor)) throw new Error(`LAN mode requires the editor to be started with PROMPTCUT_LAN_HOST=1 and the page to be opened from loopback: ${JSON.stringify(device)}`);
  if (mode === 'hosted') await P(A, (u) => localStorage.setItem('pc.shared.hostedUrl', u), hosted);

  // ---------- D11 UI "Create shared project" (open entry)
  const name = `u2-${runId}`;
  const creatorPw = `cpw-${randomBytes(6).toString('hex')}`;
  const projectPw = `ppw-${randomBytes(6).toString('hex')}`;
  res.name = name;
  await openSharedMenu(A, 'New shared project');
  await typeInto(A, '#pc-ns-name', name);
  await typeInto(A, '#pc-ns-creator', 'alice');
  await typeInto(A, '#pc-ns-cpw', creatorPw);
  await clickText(A, mode === 'lan' ? 'LAN mode' : 'Internet mode', '[data-pc=new-shared-dialog]');
  await clickText(A, 'Open entry', '[data-pc=new-shared-dialog]');
  await typeInto(A, '#pc-ns-ppw', projectPw);
  await clickText(A, 'Create', '[data-pc=new-shared-dialog] .pc-dialog-foot');
  const created = await waitFor(() => P(A, () => {
    const t = document.querySelector('[data-pc=new-shared-dialog] .pc-sync-status-line')?.innerText;
    return t && !t.includes('Creating') ? t : null;
  }), 30_000, 'Creation result');
  const shared = await P(A, () => window.__pcSyncTest.view().shared);
  say('creator.created', { created, shared });
  if (!created.includes('Created successfully') || !shared) throw new Error(`Creation failed: ${created}`);
  res.projectId = shared.projectId;
  res.where = shared.where;
  await clickText(A, 'Back', '[data-pc=new-shared-dialog]');
  await settle(A);

  const cred = { as: 'creator', username: 'alice', password: creatorPw };
  const page0 = await pageDigest(A);
  const host0 = await hostRead(shared.base, shared.projectId, cred, `creator-${runId}`);
  say('creator.state', { page: page0, host: host0 });
  if (page0.rev !== host0.rev || page0.sha256 !== host0.sha256) fails.push('creator-page-vs-host');
  res.rev = host0.rev;
  res.sha256 = host0.sha256;
  res.shots.push(await shot(A, 'creator-1-created'));

  const hostedPublic = mode === 'hosted' ? arg('--hosted-public', hosted) : null;
  const memberToken = `u2-member-${runId}`;
  const creatorToken = `u2-creator-${runId}`;
  await coord.put('u2-join', { runId, name, mode, username: 'bob', projectPassword: projectPw, hosted: hostedPublic, rev: host0.rev, sha256: host0.sha256, hostDeviceName: device.deviceName });
  say('creator.join-posted', { coord: coordUrl });

  // ---------- Member joins
  const entered = await coord.take('u2-entered', Date.now() + timeoutMs);
  if (!entered) throw new Error('Timed out waiting for the member to join');
  say('creator.member-entered', entered);
  res.member = { entered };
  if (!entered.ok) fails.push('member-enter');

  // ---------- Member makes one edit → seen on this page within 5 s
  const seenMember = watchFor(A, memberToken, 120_000, 'creator-2-saw-member-edit');
  const tGo = Date.now();
  await coord.put('u2-go', { memberToken, creatorToken });
  const report = await coord.take('u2-member-edit', Date.now() + 120_000);
  const tReport = Date.now();
  if (!report) throw new Error('Timed out waiting for member "submitted"');
  const seen = await seenMember;
  res.memberEditSeenMs = Math.max(0, seen.at - tReport);
  res.memberEditSinceGoMs = seen.at - tGo;
  res.memberEdit = { clipId: report.clipId, value: report.value, memberCommitMs: report.commitMs, seenClipId: seen.clipId, flash: seen.flash };
  res.shots.push(seen.shot);
  say('creator.saw-member-edit', { memberEditSeenMs: res.memberEditSeenMs, memberEditSinceGoMs: res.memberEditSinceGoMs, ...res.memberEdit });
  // memberEditSeenMs measures how long an edit takes from one side to the other (including
  // coordinator port round-trip); there is no such timing commitment in semantics: elapsed time is
  // only recorded, not used as a gate (verification.md, user revised decision, 2026-10-07; probe
  // overall review revision, 2026-10-23)
  if (seen.clipId !== report.clipId) fails.push('member-edit-wrong-clip');

  // ---------- This page makes one edit, hand over to member to verify
  const ids = await clipIds(A);
  const target = ids.find((id) => id !== report.clipId) ?? ids[0];
  const commitMs = await editAndSave(A, target, { text: creatorToken });
  await coord.put('u2-creator-edit', { clipId: target, key: 'text', value: creatorToken, commitMs });
  res.creatorEdit = { clipId: target, value: creatorToken, commitMs };
  say('creator.edit-committed', res.creatorEdit);

  const memberResult = await coord.take('u2-member-result', Date.now() + 120_000);
  if (!memberResult) throw new Error('Timed out waiting for the member\'s result');
  res.member.result = memberResult;
  res.creatorEditSeenMs = memberResult.creatorEditSeenMs ?? null;
  if (!memberResult.ok) fails.push(`member:${(memberResult.fails ?? []).join('|')}`);

  // ---------- Finally all three parties consistent: this page, host, member page
  await settle(A);
  const page1 = await pageDigest(A);
  const host1 = await hostRead(shared.base, shared.projectId, cred, `creator-${runId}`);
  res.final = { page: page1, host: host1, member: memberResult.final?.page ?? null };
  say('creator.final', res.final);
  if (page1.rev !== host1.rev || page1.sha256 !== host1.sha256) fails.push('final-creator-vs-host');
  if (memberResult.final?.page?.rev !== host1.rev || memberResult.final?.page?.sha256 !== host1.sha256) fails.push('final-member-vs-host');

  // ---------- Cleanup: delete this shared project
  if (!argv.includes('--keep')) {
    const del = await P(A, async (pw) => {
      const S = await import('/src/editor/sync/syncManager.ts');
      const r = await S.adminOp('delete', { password: pw });
      return r.ok ? { ok: true } : r;
    }, creatorPw);
    res.deleted = del.ok === true;
    say('creator.delete', del);
    if (!del.ok) fails.push('delete');
  }
  await A.close();
}

async function runMember(res, fails) {
  const coordUrl = arg('--coord', null);
  if (!coordUrl) throw new Error('member requires --coord <url>');
  res.coord = coordUrl;
  const coord = coordClient(coordUrl);
  const timeoutMs = Number(arg('--timeout', '900')) * 1000;
  let result = null;
  try {
    if (arg('--spawn-editor', null)) await spawnEditor(Number(arg('--spawn-editor')), { lan: false });
    res.origin = origin;
    const B = await openEditor();
    res.device = await P(B, () => window.__pcSyncTest.view().device);
    say('member.editor', { origin, device: res.device });

    const join = await coord.take('u2-join', Date.now() + timeoutMs);
    if (!join) throw new Error('Timed out waiting for the creator\'s join info');
    say('member.join', { ...join, projectPassword: '(present)' });
    res.mode = join.mode;
    res.name = join.name;
    // When searching, the page queries the hosted side simultaneously: LAN mode defaults to an
    // unreachable loopback address, without touching the real hosted side
    const hostedUrl = argv.includes('--hosted') ? hosted : join.mode === 'hosted' ? join.hosted : 'http://127.0.0.1:9';
    res.hosted = hostedUrl;
    await P(B, (u) => localStorage.setItem('pc.shared.hostedUrl', u), hostedUrl);

    // ---------- D11 UI "Open shared project": search → (pick corresponding mode when side by side) →
    // verify → enter
    await openSharedMenu(B, 'Open shared project');
    await B.type('#pc-os-name', join.name);
    await clickText(B, 'Find', '[data-pc=open-shared-dialog] .pc-dialog-foot');
    const found = await waitFor(() => P(B, () => {
      if (document.querySelector('#pc-os-user')) return 'verify';
      if (document.querySelector('[data-pc=shared-candidates]')) return 'choose';
      const line = document.querySelector('[data-pc=open-shared-dialog] .pc-sync-status-line')?.innerText;
      return line && !line.includes('In progress') ? `msg:${line}` : null;
    }), 20_000, 'Lookup result');
    say('member.found', { found });
    if (found.startsWith('msg:')) throw new Error(`Lookup failed: ${found.slice(4)}`);
    if (found === 'choose') {
      const want = join.mode === 'lan' ? '[LAN mode]' : '[Internet mode]';
      await clickText(B, want, '[data-pc=shared-candidates]');
      await waitFor(() => P(B, () => !!document.querySelector('#pc-os-user')), 5000, 'Verification step');
    }
    const label = await P(B, () => document.querySelector('[data-pc=open-shared-dialog] .pc-dialog-body')?.innerText.split('\n')[0] ?? null);
    await typeInto(B, '#pc-os-pw', join.projectPassword);
    await typeInto(B, '#pc-os-user', join.username);
    const tEnter = Date.now();
    await clickText(B, 'Enter', '[data-pc=open-shared-dialog] .pc-dialog-foot');
    await waitFor(() => P(B, () => window.__pcSyncTest.view().kind === 'shared'), 20_000, 'Joined shared project').catch(async (e) => {
      throw new Error(`${e.message}:${await P(B, () => document.querySelector('[data-pc=open-shared-dialog] .pc-sync-status-line')?.innerText ?? '')}`);
    });
    res.enterMs = Date.now() - tEnter;
    await settle(B);
    const shared = await P(B, () => window.__pcSyncTest.view().shared);
    res.projectId = shared.projectId;
    res.where = shared.where;
    res.base = shared.base;
    res.candidate = label;
    const cred = { as: 'member', username: join.username, password: join.projectPassword };
    const page0 = await pageDigest(B);
    const host0 = await hostRead(shared.base, shared.projectId, cred, `member-${join.runId}`);
    res.rev = page0.rev;
    res.entered = { page: page0, host: host0, creatorRev: join.rev, creatorSha256: join.sha256 };
    say('member.entered', { shared, ...res.entered, enterMs: res.enterMs });
    const revOk = page0.rev === host0.rev && page0.sha256 === host0.sha256 && host0.rev === join.rev && host0.sha256 === join.sha256;
    if (!revOk) fails.push('projectRev-mismatch');
    if (shared.where !== join.mode) fails.push(`entered-${shared.where}-not-${join.mode}`);
    res.shots.push(await shot(B, 'member-1-entered'));
    await coord.put('u2-entered', { ok: revOk && shared.where === join.mode, rev: page0.rev, sha256: page0.sha256, hostRev: host0.rev, where: shared.where, base: shared.base, candidate: label, enterMs: res.enterMs });

    // ---------- Make one edit: text parameter of the first clip; reports "Submitted" after document
    // service confirms
    const go = await coord.take('u2-go', Date.now() + 120_000);
    if (!go) throw new Error('Timed out waiting for the creator\'s "edit" signal');
    const seenCreator = watchFor(B, go.creatorToken, 180_000, 'member-2-saw-creator-edit');
    const [clipId] = await clipIds(B);
    const commitMs = await editAndSave(B, clipId, { text: go.memberToken });
    await coord.put('u2-member-edit', { clipId, key: 'text', value: go.memberToken, commitMs });
    res.memberEdit = { clipId, value: go.memberToken, commitMs };
    say('member.edit-committed', res.memberEdit);

    // ---------- Wait for creator's edit to appear on this page
    const report = await coord.take('u2-creator-edit', Date.now() + 120_000);
    const tReport = Date.now();
    if (!report) throw new Error('Timed out waiting for creator "submitted"');
    const seen = await seenCreator;
    res.creatorEditSeenMs = Math.max(0, seen.at - tReport);
    res.creatorEdit = { clipId: report.clipId, value: report.value, creatorCommitMs: report.commitMs, seenClipId: seen.clipId, flash: seen.flash };
    res.shots.push(seen.shot);
    say('member.saw-creator-edit', { creatorEditSeenMs: res.creatorEditSeenMs, ...res.creatorEdit });
    // creatorEditSeenMs same as above, recorded only and not judged (elapsed time is only recorded,
    // not used as a gate (verification.md, user revised decision, 2026-10-07; probe overall review
    // revision, 2026-10-23))
    if (seen.clipId !== report.clipId) fails.push('creator-edit-wrong-clip');

    await settle(B);
    const page1 = await pageDigest(B);
    const host1 = await hostRead(shared.base, shared.projectId, cred, `member-${join.runId}`);
    res.final = { page: page1, host: host1 };
    if (page1.rev !== host1.rev || page1.sha256 !== host1.sha256) fails.push('final-page-vs-host');
    result = { ok: fails.length === 0, fails: [...fails], rev: res.rev, creatorEditSeenMs: res.creatorEditSeenMs, memberEdit: res.memberEdit, final: res.final };
    await B.close();
  } finally {
    // Also notify creator on failure to avoid waiting in vain
    try { await coord.put('u2-member-result', result ?? { ok: false, fails: [...fails, 'member-error'] }); } catch { /* Coordinator port closed */ }
  }
}

async function runCross() {
  const res = { ok: false, role: ROLE, mode: null, runId: randomBytes(4).toString('hex'), origin: null, coord: null, name: null, projectId: null, rev: null, shots: [] };
  const fails = [];
  try {
    if (ROLE === 'creator') await runCreator(res, fails);
    else if (ROLE === 'member') await runMember(res, fails);
    else throw new Error('--role must be creator or member');
  } catch (e) {
    const lines = String(e?.stack ?? e).split(/\r?\n/);
    fails.push(`error:${lines[0].slice(0, 300)}`);
    say('error', { at: lines.filter((l) => l.includes('c65-editor-probe')).map((l) => l.trim()).slice(0, 4) });
  } finally {
    await browser.close().catch(() => {});
    await stopEditor().catch(() => {});
    if (res._coordServer) { await res._coordServer.close(); delete res._coordServer; }
  }
  for (const s of shotsNotReady) fails.push(`shot-not-ready:${s.name}`);
  if (shotsNotReady.length) res.shotsNotReady = shotsNotReady;
  res.fails = fails;
  res.ok = fails.length === 0;
  console.log(JSON.stringify(res));
  process.exitCode = res.ok ? 0 : 1;
}

if (ROLE) await runCross();
else {
  try {
    if (phases.includes('local')) await phaseLocal();
    if (phases.includes('shared')) await phaseShared();
    if (phases.includes('lan')) await phaseLan();
  } catch (e) {
    const stack = String(e?.stack ?? e);
    const lines = stack.split(/\r?\n/);
    check('probe-error', false, { message: lines[0].slice(0, 300), at: lines.filter((l) => l.includes('c65-editor-probe')).map((l) => l.trim()).slice(0, 4) });
  } finally {
    await browser.close();
  }
  check('shots-editor-ready', shotsNotReady.length === 0, shotsNotReady.length ? { notReady: shotsNotReady } : {});
  const failed = results.filter((r) => !r.ok);
  console.log(JSON.stringify({ summary: { total: results.length, passed: results.length - failed.length, failed: failed.map((f) => f.check) } }));
  process.exitCode = failed.length ? 1 : 0;
}
