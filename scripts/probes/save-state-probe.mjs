/**
 * Real-page probe for save and modification state checks (branch claude/save-state).
 * Semantics: `docs/semantics/mechanism/document-service.md` "Save baseline and modification state
 * checks": "Save temporarily disables foreground editing while waiting for local write to finish;
 * failures do not overwrite the last valid save and resume editing".
 *
 * Usage (start the editor beforehand; this probe does not launch the service):
 *   PROMPTCUT_NO_PORT_FILE=1 npx vite --port 5960 --strictPort --host 127.0.0.1
 *   node scripts/probes/save-state-probe.mjs --origin http://127.0.0.1:5960 --out out/save-state-shots [--phases lock,timeout,fail]
 *
 * "Save as" is replaced with probe's own: drop target is a real file in this page origin's OPFS,
 * `createWritable` is the browser's real one, wrapped only with an outer layer to control timing
 * (hold: wait for probe release before writing; fail: throw error after writing half the content).
 *
 * Phases:
 *   lock     When save pauses at "write file" step, attempts to modify via shortcuts (Ctrl+Z),
 *            title bar menu commands, clicking project name, drag-and-dropping files, paste,
 *            scroll wheel, and typing Enter in Agent panel never replace the project object once;
 *            after release, file is written with content reflecting the project at the moment of
 *            saving; afterwards Ctrl+Z works again. Screenshots: 1-saving.png (saving),
 *            2-after-save.png.
 *   timeout  An Agent tool call never finishes (local Agent still writing): after timeout expires,
 *            no file is written, original file remains unchanged byte-for-byte, and top notice
 *            explains what it is waiting for; editing resumes afterwards. Screenshots:
 *            3-waiting.png (waiting), 4-timeout.png (timeout notice).
 *   fail     Error occurs halfway through writing: original file remains unchanged byte-for-byte,
 *            notice explains original file was untouched, and editing resumes. Screenshot:
 *            5-write-failed.png.
 *            Also records a "without our code, relying solely on browser" control: same handle
 *            directly runs createWritable → writes half → neither close nor abort, checking whether
 *            the original file remains untouched (validating browser behavior of "write temporary
 *            replica first, replace only on close").
 * Results: one JSON line per item (`{ check, ok, ... }`), last line `{ summary }`; exit code 1 on
 * failure.
 */
import '../lib/no-user-dirs.mjs'; // First import: does not inherit external user directory variables
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};
const origin = arg('--origin', 'http://127.0.0.1:5960');
const outDir = path.resolve(arg('--out', 'out/save-state-shots'));
const phases = arg('--phases', 'lock,timeout,fail').split(',');
fs.mkdirSync(outDir, { recursive: true });

const results = [];
const check = (name, ok, extra = {}) => {
  const r = { check: name, ok: !!ok, ...extra };
  results.push(r);
  console.log(JSON.stringify(r));
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Obtains the `userEditing.ts` module used by the editor itself within the page (used by
 * mcpExecutor to start / finish Agent tools).
 * After the dev server modifies this file, imports in the page carry a `?t=` timestamp; directly
 * importing the URL without a timestamp yields a separate instance.
 */
const AGENT_TOOL = (op) => `(async () => {
  const urls = performance.getEntriesByType('resource').map((e) => e.name).filter((u) => u.includes('/src/editor/userEditing.ts'));
  const ue = await import(urls[urls.length - 1] || '/src/editor/userEditing.ts');
  ue.${op}();
  return urls[urls.length - 1] || null;
})()`;

async function waitFor(page, fn, arg, timeout = 30000) {
  return page.waitForFunction(fn, { timeout, polling: 100 }, arg);
}

/** Open editor and install the probe's own "Save as" */
async function openEditor(browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on('dialog', (d) => { console.log(JSON.stringify({ dialog: d.message() })); void d.dismiss(); });
  // Editor dev build loads thousands of modules at once; default 250 resource timing entries cannot
  // hold them all; locating actual URL of userEditing.ts relies on it (see AGENT_TOOL)
  await page.evaluateOnNewDocument(() => performance.setResourceTimingBufferSize(20000));
  await page.goto(`${origin}/?editor`, { waitUntil: 'domcontentloaded' });
  await waitFor(page, () => !!window.__pcStore && !!document.querySelector('.pc-proj-btn'), null, 60000);
  // When page connects to local document service, loads full file once (clearing undo stack): wait
  // until connection completes before modifying
  await sleep(3000);
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const probe = { mode: 'plain', release: null, log: [], createCalls: 0 };
    window.__saveProbe = probe;
    const wrap = (real) => ({
      kind: 'file',
      name: real.name,
      getFile: () => real.getFile(),
      async createWritable(opts) {
        probe.createCalls += 1;
        if (probe.mode === 'hold') await new Promise((r) => { probe.release = r; });
        const w = await real.createWritable(opts);
        if (probe.mode !== 'fail') {
          // Write as usual, only recording that it "closed": probe waits for it without relying on UI signals
          // from tested code to determine save completion
          return {
            write: (data) => w.write(data),
            close: async () => { await w.close(); probe.log.push('closed'); },
            abort: (reason) => { probe.log.push('abort'); return w.abort(reason); },
          };
        }
        return {
          async write(data) {
            const text = typeof data === 'string' ? data : await new Blob([data]).text();
            await w.write(text.slice(0, Math.floor(text.length / 2)));
            probe.log.push('half-written');
            throw new DOMException('Simulated: disk error halfway through the write', 'InvalidStateError');
          },
          close: () => { probe.log.push('close'); return w.close(); },
          abort: (reason) => { probe.log.push('abort'); return w.abort(reason); },
        };
      },
    });
    window.showSaveFilePicker = async (opts) => wrap(await root.getFileHandle(opts?.suggestedName || 'probe.proc', { create: true }));
    window.__opfsText = async (name) => {
      try { return await (await (await root.getFileHandle(name)).getFile()).text(); } catch { return null; }
    };
    window.__opfsNames = async () => { const out = []; for await (const [n] of root.entries()) out.push(n); return out; };
  });
  return page;
}

async function clickSave(page) {
  // Click top bar "Project" → "Save project". Occasionally opening the menu gets dismissed by close
  // logic elsewhere: retry a few times
  for (let i = 0; i < 4; i += 1) {
    await page.click('.pc-proj-btn');
    const open = await waitFor(page, () => [...document.querySelectorAll('.pc-proj-item')].some((b) => b.textContent.includes('Save project')), null, 2000).then(() => true, () => false);
    if (open) {
      await page.evaluate(() => {
        const item = [...document.querySelectorAll('.pc-proj-item')].find((b) => b.textContent.includes('Save project'));
        item.click();
      });
      return 'menu';
    }
    await sleep(300);
  }
  // Fall back to desktop app title bar "File → Save" command (same saveProject)
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('pc-titlebar-command', { detail: 'save-project' })));
  return 'titlebar';
}

const projectName = (page) => page.evaluate(() => window.__pcStore.getState().project.name);
/** Use adding a track for the undoable entry: project name modifications do not enter undo stack */
const trackCount = (page) => page.evaluate(() => window.__pcStore.getState().project.tracks.length);
const addTrack = (page, name) => page.evaluate((n) => { window.__pcStore.actions.addTrack(n); }, name);
const fileName = (page) => page.evaluate(() => `${window.__pcStore.getState().project.name}.proc`);
const clipCount = (page) => page.evaluate(() => window.__pcStore.getState().project.tracks.reduce((n, t) => n + t.clips.length, 0));
/** Select the first clip (the Delete key deletes the selected clip) */
const selectFirstClip = (page) => page.evaluate(() => {
  const c = window.__pcStore.getState().project.tracks.flatMap((t) => t.clips)[0];
  if (c) window.__pcStore.actions.select([c.id]);
  return c?.id ?? null;
});

/** Modify the project through each path; whether the project object changed after each path */
async function tryEditPaths(page) {
  await page.evaluate(() => { window.__p0 = window.__pcStore.getState().project; });
  const changed = {};
  const snap = () => page.evaluate(() => {
    const s = window.__pcStore.getState();
    return { same: s.project === window.__p0, name: s.project.name, tracks: s.project.tracks.length, clips: s.project.tracks.reduce((n, t) => n + t.clips.length, 0), media: s.project.media.length, renaming: !!document.querySelector('.pc-projname--editing'), canUndo: window.__pcStore.actions.canUndo() };
  });
  // 0 Shortcut: Delete deletes the selected clip (focus not in the input box)
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.keyboard.press('Delete');
  await sleep(150); changed.deleteKey = await snap();
  // 1 Shortcut: Ctrl+Z undo
  await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
  await sleep(150); changed.ctrlZ = await snap();
  // 2 Title bar menu command (desktop app "Edit → Undo")
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('pc-titlebar-command', { detail: 'undo' })));
  await sleep(150); changed.titlebarUndo = await snap();
  // 3 Click project name with mouse (enters rename). The saving overlay covers it above,
  // click its position with a real mouse
  const box = await page.evaluate(() => { const r = document.querySelector('.pc-projname--btn')?.getBoundingClientRect(); return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; });
  if (box) await page.mouse.click(box.x, box.y);
  await page.evaluate(() => document.querySelector('.pc-projname--btn')?.click()); // Bypass the overlay and dispatch directly to the button
  await sleep(150); changed.clickName = await snap();
  // 4 Drag and drop a file onto the timeline
  await page.evaluate(() => {
    const el = document.querySelector('[data-pc="timeline"]') || document.body;
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], '拖进来的.png', { type: 'image/png' }));
    for (const type of ['dragenter', 'dragover', 'drop']) el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  await sleep(300); changed.drop = await snap();
  // 5 Paste, wheel
  await page.evaluate(() => {
    const el = document.querySelector('[data-pc="timeline"]') || document.body;
    const dt = new DataTransfer(); dt.setData('text/plain', 'paste');
    el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
    el.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 300, ctrlKey: true }));
  });
  await sleep(150); changed.pasteWheel = await snap();
  // 6 Agent panel: focus the input box and type. If typing is blocked, nothing can be sent;
  // do not press Enter: if unblocked (code before the fix), Enter would really send the message
  // to the Agent
  const hasComposer = await page.evaluate(() => { const t = document.querySelector('.ai-composer-input'); if (!t) return false; t.focus(); return true; });
  if (hasComposer) await page.keyboard.type('Change the title to X');
  await sleep(200);
  changed.agentPanel = { ...(await snap()), composer: hasComposer, typed: await page.evaluate(() => document.querySelector('.ai-composer-input')?.value ?? null) };
  await page.evaluate(() => document.activeElement?.blur?.());
  return changed;
}

async function phaseLock(browser) {
  const page = await openEditor(browser);
  await page.evaluate(() => {
    const a = window.__pcStore.actions;
    a.setProjectMeta({ name: 'Save probe modified' });
  });
  const tracks0 = await trackCount(page);
  await addTrack(page, 'Probe track');
  const selected = await selectFirstClip(page);
  const clips0 = await clipCount(page);
  // There must actually be this step in the undo stack and a selected clip for the two shortcut
  // paths to test anything
  const undoReady = await waitFor(page, () => window.__pcStore.actions.canUndo(), null, 10000).then(() => true, () => false);
  check('lock.precondition', undoReady && !!selected, { canUndo: undoReady, selected, clips0 });
  const fname = await fileName(page);
  await page.evaluate(() => { window.__saveProbe.mode = 'hold'; });
  await clickSave(page);
  await waitFor(page, () => !!window.__saveProbe.release, null, 30000);
  const overlay = await page.evaluate(() => { const el = document.querySelector('[data-pc="save-lock"]'); return el ? { step: el.getAttribute('data-step'), text: el.textContent } : null; });
  check('lock.overlay-shown', !!overlay, { overlay });
  await page.screenshot({ path: path.join(outDir, '1-saving.png') });
  const tried = await tryEditPaths(page);
  for (const [k, v] of Object.entries(tried)) {
    const ok = v.same && v.name === 'Save probe modified' && v.tracks === tracks0 + 1 && v.clips === clips0 && !v.renaming && (k !== 'agentPanel' || !v.composer || !v.typed);
    check(`lock.blocked.${k}`, ok, v);
  }
  await page.evaluate(() => window.__saveProbe.release());
  // Do not rely on the UI of the code under test to judge save completion: wait for the file to
  // actually close, then wait for the dirty flag to clear (up to 10 seconds)
  await waitFor(page, () => window.__saveProbe.log.includes('closed'), null, 30000).catch(() => {});
  await waitFor(page, () => window.__pcStore.getState().dirty === false, null, 10000).catch(() => {});
  await sleep(300);
  const text = await page.evaluate((n) => window.__opfsText(n), fname);
  let savedName = null, savedTracks = null;
  try { const doc = JSON.parse(text); savedName = doc.project.name; savedTracks = doc.project.tracks.length; } catch { /* Check below */ }
  check('lock.file-written', savedName === 'Save probe modified' && savedTracks === tracks0 + 1, { savedName, savedTracks, bytes: text?.length ?? 0 });
  const dirty = await page.evaluate(() => window.__pcStore.getState().dirty);
  check('lock.marked-saved', dirty === false, { dirty });
  await page.evaluate(() => document.activeElement?.blur?.());
  await selectFirstClip(page);
  await page.keyboard.press('Delete');
  await sleep(200);
  const clipsAfter = await clipCount(page);
  check('lock.edit-restored', clipsAfter === clips0 - 1, { clipsAfterDelete: clipsAfter, clips0 });
  await page.screenshot({ path: path.join(outDir, '2-after-save.png') });
  await page.close();
}

async function phaseTimeout(browser) {
  const page = await openEditor(browser);
  await page.evaluate(() => { window.__pcStore.actions.setProjectMeta({ name: 'Timeout probe' }); });
  const fname = await fileName(page);
  // First save a version normally as "last valid save"
  await clickSave(page);
  await waitFor(page, () => window.__saveProbe.log.includes('closed') && window.__pcStore.getState().dirty === false, null, 30000);
  await sleep(300);
  const before = await page.evaluate((n) => window.__opfsText(n), fname);
  check('timeout.baseline-saved', !!before && before.includes('Timeout probe'), { bytes: before?.length ?? 0 });
  await page.evaluate(() => { window.__pcStore.actions.setProjectMeta({ name: 'Timeout probe modified' }); });
  const tracks0 = await trackCount(page);
  await addTrack(page, 'Timeout track');
  // Local Agent has a tool call started and never ended (uses the same module instance as mcpExecutor)
  const moduleUrl = await page.evaluate(AGENT_TOOL('beginAgentTool'));
  check('timeout.precondition-agent-module', !!moduleUrl, { moduleUrl });
  const createBefore = await page.evaluate(() => window.__saveProbe.createCalls);
  const t0 = Date.now();
  await clickSave(page);
  await waitFor(page, () => !!document.querySelector('[data-pc="save-lock-waiting"]'), null, 15000).catch(() => {});
  const waitingText = await page.evaluate(() => document.querySelector('[data-pc="save-lock-waiting"]')?.textContent ?? '');
  check('timeout.waiting-shown', waitingText.includes('Agent'), { waitingText });
  await page.screenshot({ path: path.join(outDir, '3-waiting.png') });
  // Cannot modify while waiting
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
  await sleep(150);
  check('timeout.blocked-while-waiting', (await trackCount(page)) === tracks0 + 1, { tracks: await trackCount(page), tracks0 });
  await waitFor(page, () => !!document.querySelector('[data-pc="save-notice"]'), null, 30000).catch(() => {});
  const elapsed = Date.now() - t0;
  const notice = await page.evaluate(() => { const el = document.querySelector('[data-pc="save-notice"]'); return { tone: el?.getAttribute('data-tone'), text: el?.textContent ?? '' }; });
  check('timeout.notice', notice.tone === 'error' && notice.text.includes('Agent') && notice.text.includes('not saved') && notice.text.includes('original file was not changed'), { notice, elapsedMs: elapsed });
  await page.screenshot({ path: path.join(outDir, '4-timeout.png') });
  const createAfter = await page.evaluate(() => window.__saveProbe.createCalls);
  const afterText = await page.evaluate((n) => window.__opfsText(n), fname);
  check('timeout.no-write', createAfter === createBefore && afterText === before, { createBefore, createAfter, unchanged: afterText === before });
  const dirty = await page.evaluate(() => window.__pcStore.getState().dirty);
  check('timeout.still-dirty', dirty === true, { dirty });
  await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
  await sleep(200);
  check('timeout.edit-restored', (await trackCount(page)) === tracks0, { tracks: await trackCount(page), tracks0 });
  await page.evaluate(AGENT_TOOL('endAgentTool'));
  await page.close();
}

async function phaseFail(browser) {
  const page = await openEditor(browser);
  await page.evaluate(() => { window.__pcStore.actions.setProjectMeta({ name: 'Failure probe' }); });
  const fname = await fileName(page);
  await clickSave(page);
  await waitFor(page, () => window.__saveProbe.log.includes('closed') && window.__pcStore.getState().dirty === false, null, 30000);
  await sleep(300);
  const before = await page.evaluate((n) => window.__opfsText(n), fname);
  check('fail.baseline-saved', !!before && before.includes('Failure probe'), { bytes: before?.length ?? 0 });
  // Modify a bit more so new content is longer than old and halfway through writing is definitely
  // different from old content
  const tracks0 = await trackCount(page);
  await addTrack(page, 'Failure track'.repeat(20));
  await page.evaluate(() => { window.__saveProbe.mode = 'fail'; window.__saveProbe.log = []; });
  await clickSave(page);
  await waitFor(page, () => !!document.querySelector('[data-pc="save-notice"]') || (!document.querySelector('[data-pc="save-lock"]') && window.__saveProbe.log.includes('half-written')), null, 30000);
  await sleep(300);
  const notice = await page.evaluate(() => { const el = document.querySelector('[data-pc="save-notice"]'); return el ? { tone: el.getAttribute('data-tone'), text: el.textContent } : null; });
  check('fail.notice', !!notice && notice.tone === 'error' && notice.text.includes('original file'), { notice });
  await page.screenshot({ path: path.join(outDir, '5-write-failed.png') });
  const log = await page.evaluate(() => window.__saveProbe.log);
  check('fail.aborted', log.includes('abort') && !log.includes('close'), { log });
  const afterText = await page.evaluate((n) => window.__opfsText(n), fname);
  check('fail.original-byte-identical', afterText === before, { beforeBytes: before?.length ?? 0, afterBytes: afterText?.length ?? 0 });
  const names = await page.evaluate(() => window.__opfsNames());
  check('fail.no-leftover-files', names.filter((n) => n !== fname && n.startsWith('Failure probe')).length === 0, { names });
  const dirty = await page.evaluate(() => window.__pcStore.getState().dirty);
  check('fail.still-dirty', dirty === true, { dirty });
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
  await sleep(200);
  check('fail.edit-restored', (await trackCount(page)) === tracks0, { tracks: await trackCount(page), tracks0 });

  // Control: without going through our code, look only at the browser: halfway through writing,
  // neither close nor abort, whether the original file remains unchanged as expected
  const raw = await page.evaluate(async (n) => {
    const root = await navigator.storage.getDirectory();
    const h = await root.getFileHandle(n);
    const orig = await (await h.getFile()).text();
    const w = await h.createWritable();
    await w.write('partial'.repeat(50));
    const midway = await (await h.getFile()).text();
    // Neither close nor abort; discard this stream
    const w2 = await h.createWritable(); // Opening another stream is also unaffected
    await w2.abort();
    const later = await (await h.getFile()).text();
    return { origBytes: orig.length, midwayUnchanged: midway === orig, laterUnchanged: later === orig, w: typeof w };
  }, fname);
  check('browser.swap-file-semantics', raw.midwayUnchanged && raw.laterUnchanged, raw);
  await page.close();
}

const browser = await puppeteer.launch({ headless: true, args: [...PROBE_CHROME_ARGS, '--window-size=1440,900'] });
try {
  if (phases.includes('lock')) await phaseLock(browser).catch((e) => check('lock.crashed', false, { error: String(e?.stack || e) }));
  if (phases.includes('timeout')) await phaseTimeout(browser).catch((e) => check('timeout.crashed', false, { error: String(e?.stack || e) }));
  if (phases.includes('fail')) await phaseFail(browser).catch((e) => check('fail.crashed', false, { error: String(e?.stack || e) }));
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ summary: { total: results.length, passed: results.length - failed.length, failed: failed.map((r) => r.check) } }));
process.exit(failed.length ? 1 : 0);
