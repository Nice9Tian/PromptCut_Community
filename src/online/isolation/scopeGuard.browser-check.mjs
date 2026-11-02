/**
 * Verification in real headless Chrome of stage origin cross-document channel guards
 * (`scopeGuard.ts`, steps 6c/6d of `harden.ts`) and stage iframe rebuilding on project switch.
 * Not included in `npm test` (filename is not `*.test.mjs`).
 *
 * Setup: two ports on this machine, `127.0.0.1:<port>` as editor page, `localhost:<port+1>` as stage
 * origin (carrying the same Content Security Policy `stageCspHeader` and `Origin-Agent-Cluster` as
 * the online stage); stage iframe has `sandbox="allow-scripts allow-same-origin"`, identical to
 * online pages. `harden.ts` and `scopeGuard.ts` are bundled with rolldown into a minified IIFE and
 * sent into the stage (verifying the guard remains self-contained after minification), with the editor
 * page sending snippets of "card code" into the stage for execution.
 *
 * Verification: after hardening is installed:
 *   - Cards cannot spawn background threads themselves: whether using blob URLs created on this page
 *     (classic scripts or modules), same-origin scripts, `data:`, or revoked blobs, or via
 *     `Worker.prototype.constructor`, `class extends Worker`, or `Reflect.construct`, all throw
 *     `PromptCut stage: cannot spawn background threads`;
 *   - Stage runtime's own dedicated background threads (spawned via module closure `spawnRuntimeWorker`,
 *     like `spawnGlWorker` / `spawnSoundWorker`) run as usual;
 *   - Sound thread entry calls `denyPersistentStorage(self)` and then `installScopeGuard(self)` without
 *     errors, where IndexedDB, Cache Storage, Origin Private File System, BroadcastChannel,
 *     SharedWorker, and spawning further Workers are all revoked or rejected, and Web Locks are
 *     isolated by prefix as usual;
 *   - Values written to `window.name` before reload are empty after reload; values written when
 *     hardening was not installed are cleared when hardening is installed;
 *   - Stage iframe element rebuilding on in-place project switch (corresponding to `stageFrameGen` key
 *     in `Preview.tsx`): even if previous project cards modified `location.search` / `location.hash`
 *     leaving session history entries in the old iframe, the rebuilt new iframe is a brand-new
 *     browsing context (`history.length === 1`, `entries` contains only new entry,
 *     `activation.from === null`), and navigating back will not return to URLs left by previous project;
 *   - BroadcastChannel and SharedWorker are absent in document; `cookieStore.set` rejects;
 *   - Lock names are isolated per document: other documents cannot see or acquire locks of this document;
 *   - Storage events from other documents writing to real localStorage are not received;
 *     `navigator.storage.persist()` returns false.
 * Also includes controls: in stage documents without hardening, the same patterns can spawn threads,
 * store data, broadcast, and see lock names (proving that these checks detect leaks).
 *
 * Run: node src/online/isolation/scopeGuard.browser-check.mjs [--port 6440] [--no-minify]
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { rolldown } from 'rolldown';
import { stageCspHeader } from '../stagePolicy.mjs';
import { PROBE_CHROME_ARGS } from '../../../scripts/probes/probe-chrome.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const PORT = Number(arg('--port', 6440));
const MINIFY = !argv.includes('--no-minify');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const EDITOR = `http://127.0.0.1:${PORT}`;
const STAGE = `http://localhost:${PORT + 1}`;

let pass = 0; const fails = [];
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : `  [${typeof detail === 'string' ? detail : JSON.stringify(detail)}]`}`); if (ok) pass++; else fails.push(label); };

/* ---------- Bundle ---------- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-scope-guard-'));
async function bundle(input, name) {
  const b = await rolldown({ input, platform: 'browser', logLevel: 'silent' });
  const { output } = await b.generate({ format: 'iife', name, minify: MINIFY });
  await b.close();
  return output[0].code;
}
const hardenPath = JSON.stringify(path.join(HERE, 'harden.ts').replace(/\\/g, '/'));
const scopeGuardPath = JSON.stringify(path.join(HERE, 'scopeGuard.ts').replace(/\\/g, '/'));
const hardenEntry = path.join(tmp, 'harden-entry.ts');
fs.writeFileSync(hardenEntry, `export { installStageHardening, denyPersistentStorage } from ${hardenPath};\nexport { installScopeGuard, spawnRuntimeWorker } from ${scopeGuardPath};\n`);
const dpsEntry = path.join(tmp, 'dps-entry.ts');
fs.writeFileSync(dpsEntry, `import { denyPersistentStorage } from ${hardenPath};
import { installScopeGuard } from ${scopeGuardPath};
const d = denyPersistentStorage(self);
const s = installScopeGuard(self, { strict: true });
(async () => {
  let opfs = 'open', subWorker = 'constructed', idbOpen = 'opened', locks = 'err';
  try { await navigator.storage.getDirectory(); } catch { opfs = 'denied'; }
  try { new Worker('blob:fake/1'); } catch (e) { subWorker = String((e as Error).message || e); }
  try { IDBFactory.prototype.open.call(null, 'x'); } catch { idbOpen = 'denied'; }
  try { await navigator.locks.request('pc-sound-probe', { ifAvailable: true }, (l) => { locks = l ? l.name : 'blocked'; }); } catch (e) { locks = 'err:' + (e as Error).message; }
  (self as any).postMessage({
    t: 'dps',
    errors: [...d.errors, ...s.errors],
    idb: typeof (self as any).indexedDB,
    caches: typeof (self as any).caches,
    BC: typeof (self as any).BroadcastChannel,
    SW: typeof (self as any).SharedWorker,
    opfs,
    idbOpen,
    subWorker,
    locks,
  });
})();
`);
const HARDEN_JS = await bundle(hardenEntry, 'PCH');
const DPS_JS = await bundle(dpsEntry, 'PCD');

/* ---------- Proxy in stage page: records original state at load time, executes code sent from editor page ---------- */
const AGENT_JS = `
(() => {
  const raw = { name: window.name, state: history.state, hash: location.hash, search: location.search, href: location.href, historyLength: history.length,
    from: (() => { try { const f = window.navigation && navigation.activation && navigation.activation.from; return f ? { url: f.url, state: f.getState() } : null; } catch (e) { return 'err:' + e.message; } })(),
    entries: (() => { try { return window.navigation ? navigation.entries().map((e) => e.url) : null; } catch (e) { return 'err'; } })() };
  window.addEventListener('message', async (e) => {
    const m = e.data || {};
    if (m.t !== 'eval') return;
    let value, error = null;
    try { value = await (new Function('return (async () => {' + m.code + '\\n})()'))(); } catch (err) { error = String(err && err.message || err); }
    parent.postMessage({ t: 'result', id: m.id, value, error }, '*');
  });
  parent.postMessage({ t: 'loaded', frame: new URLSearchParams(location.search).get('f'), raw }, '*');
})();`;
const STAGE_HTML = '<!doctype html><meta charset="utf-8"><title>stage</title><script src="/harden.js"></script><script src="/agent.js"></script>';
const RUNTIME_WORKER_JS = `postMessage({ t: 'runtime-ok', kind: 'classic' });`;
const RUNTIME_WORKER_MJS = `postMessage({ t: 'runtime-ok', kind: 'module' });`;

const TOP_HTML = `<!doctype html><meta charset="utf-8"><title>editor</title><body><script>
window.loads = {}; let seq = 0; const waiting = new Map();
window.addEventListener('message', (e) => {
  const m = e.data || {};
  if (m.t === 'loaded') (window.loads[m.frame] ||= []).push(m.raw);
  if (m.t === 'result') { const w = waiting.get(m.id); if (w) { waiting.delete(m.id); w(m); } }
});
window.addFrame = (id, query = '') => { const f = document.createElement('iframe'); f.id = id; f.setAttribute('sandbox', 'allow-scripts allow-same-origin');
  f.src = '${STAGE}/stage.html?f=' + id + query; document.body.appendChild(f); };
window.reloadFrame = (id) => { const f = document.getElementById(id); f.src = f.src; };
window.recreateFrame = (id, query = '') => {
  const old = document.getElementById(id);
  const f = document.createElement('iframe');
  f.id = id;
  f.setAttribute('sandbox', 'allow-scripts allow-same-origin');
  f.src = '${STAGE}/stage.html?f=' + id + query;
  old.replaceWith(f);
};
window.callFrame = (id, code) => new Promise((res) => { const n = ++seq; waiting.set(n, res); document.getElementById(id).contentWindow.postMessage({ t: 'eval', id: n, code }, '${STAGE}'); });
</script></body>`;

const stageHeaders = { 'Content-Security-Policy': stageCspHeader(EDITOR), 'Origin-Agent-Cluster': '?1', 'Cache-Control': 'no-store' };
const servers = [];
const listen = (port, host, handler) => new Promise((res) => { const s = http.createServer(handler); s.listen(port, host, () => res(s)); servers.push(s); });
await listen(PORT, '127.0.0.1', (req, res) => {
  if (req.url.startsWith('/top.html')) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(TOP_HTML); return; }
  if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  res.writeHead(404); res.end();
});
const stageFiles = {
  '/stage.html': ['text/html; charset=utf-8', STAGE_HTML], '/harden.js': ['text/javascript', HARDEN_JS], '/agent.js': ['text/javascript', AGENT_JS],
  '/runtime-worker.js': ['text/javascript', RUNTIME_WORKER_JS], '/runtime-worker.mjs': ['text/javascript', RUNTIME_WORKER_MJS], '/dps-worker.js': ['text/javascript', DPS_JS],
  '/same-origin-worker.js': ['text/javascript', 'postMessage("same-origin")'],
};
await listen(PORT + 1, 'localhost', (req, res) => {
  if (req.url === '/favicon.ico') { res.writeHead(204, stageHeaders); res.end(); return; }
  const f = stageFiles[new URL(req.url, STAGE).pathname];
  if (!f) { res.writeHead(404, stageHeaders); res.end(); return; }
  res.writeHead(200, { ...stageHeaders, 'Content-Type': f[0] }); res.end(f[1]);
});

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-scope-guard-profile-'));
const browser = await puppeteer.launch({ pipe: true, headless: true, userDataDir: profile, args: [...PROBE_CHROME_ARGS] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  await page.goto(`${EDITOR}/top.html`);
  const loads = (id) => page.evaluate((i) => (window.loads[i] || []).length, id);
  const waitLoad = async (id, n) => { for (let k = 0; k < 100; k++) { if ((await loads(id)) >= n) return true; await sleep(100); } return false; };
  const call = async (id, code) => { const r = await page.evaluate((i, c) => window.callFrame(i, c), id, code); if (r.error) throw new Error(`${id}: ${r.error}`); return r.value; };
  const raw = (id, n) => page.evaluate((i, k) => window.loads[i][k], id, n);

  // A, C: stages with hardening installed; D: control without hardening (same origin)
  for (const id of ['A', 'C', 'D']) await page.evaluate((i) => window.addFrame(i), id);
  for (const id of ['A', 'C', 'D']) check(`Stage ${id} loaded`, await waitLoad(id, 1));

  // A first writes to window.name before hardening is installed (simulating leftovers from old
  // documents), then installs after full-page reload
  await call('A', `window.name = 'pre-leak-sid'; return window.name;`);
  await page.evaluate(() => window.reloadFrame('A'));
  check('A reload (window.name written before hardening)', await waitLoad('A', 2));
  check('Control: window.name written without hardening survives a frame.src = frame.src reload', (await raw('A', 1)).name === 'pre-leak-sid', (await raw('A', 1)).name);

  const install = `const r = PCH.installStageHardening({}); return { errors: r.errors, scopeGuarded: r.scopeGuarded, storageDenied: r.storageDenied };`;
  const repA = await call('A', install);
  const repC = await call('C', install);
  check('Hardening installed without errors', repA.errors.length === 0 && repC.errors.length === 0, [...repA.errors, ...repC.errors].join('; ') || '');
  console.log(`      scopeGuarded: ${repA.scopeGuarded.join(', ')}`);
  check('Installing hardening cleared the real window.name', await call('A', `return window.name;`) === '');

  /* ---------- Channels in document ---------- */
  const docChannels = `return { BC: typeof BroadcastChannel, SW: typeof SharedWorker, idb: typeof indexedDB, caches: typeof caches, sharedStorage: typeof window.sharedStorage,
    workerFn: typeof Worker, ctorOk: Worker.prototype.constructor === Worker };`;
  const dA = await call('A', docChannels);
  check('Document: no BroadcastChannel or SharedWorker', dA.BC === 'undefined' && dA.SW === 'undefined', dA);
  check('Document: Worker is still a function (for host capability detection via typeof Worker), and Worker.prototype.constructor points back to the guard Worker', dA.workerFn === 'function' && dA.ctorOk === true, dA);
  const dD = await call('D', docChannels);
  check('Control (no hardening): BroadcastChannel and SharedWorker are both present', dD.BC === 'function' && dD.SW === 'function', dD);

  const cookie = await call('A', `let set; try { await cookieStore.set('pc-leak', 'x'); set = 'written'; } catch (e) { set = 'rejected:' + e.message; }
    let del; try { await cookieStore.delete('pc-leak'); del = 'deleted'; } catch (e) { del = 'rejected'; }
    document.cookie = 'pc-leak2=y'; return { set, del, cookie: document.cookie, typeofStore: typeof cookieStore };`);
  check('cookieStore.set and delete are rejected; document.cookie cannot be written', cookie.set.startsWith('rejected') && cookie.del === 'rejected' && !cookie.cookie.includes('pc-leak'), cookie);
  const cookieD = await call('D', `try { await cookieStore.set('pc-ctl', 'x'); await cookieStore.delete('pc-ctl'); return 'written'; } catch (e) { return 'rejected:' + e.message; }`);
  check('Control (no hardening): cookieStore.set uses the browser\'s own implementation', !cookieD.includes('PromptCut'), cookieD);

  const persist = await call('A', `return { persist: await navigator.storage.persist(), estimate: typeof (await navigator.storage.estimate()).quota };`);
  check('navigator.storage.persist() returns false, estimate unchanged', persist.persist === false && persist.estimate === 'number', persist);

  /* ---------- Background threads: cards cannot spawn, runtime dedicated threads spawn as usual, sound thread installs guard ---------- */
  const cardWorkerAttempts = await call('A', `const out = {};
    const tryW = (k, f) => {
      try { f(); out[k] = 'constructed'; }
      catch (e) { out[k] = /PromptCut stage: cannot start background thread/.test(String(e && e.message)) ? 'blocked' : 'other:' + String(e && e.message); }
    };
    const u = URL.createObjectURL(new Blob(['postMessage(1)'], { type: 'text/javascript' }));
    tryW('classicBlob', () => new Worker(u));
    tryW('moduleBlob', () => new Worker(u, { type: 'module' }));
    tryW('fragBlob', () => new Worker(u + '#frag'));
    tryW('sameOrigin', () => new Worker('/same-origin-worker.js'));
    tryW('dataUrl', () => new Worker('data:text/javascript,postMessage(1)'));
    const rev = URL.createObjectURL(new Blob(['postMessage(1)'])); URL.revokeObjectURL(rev);
    tryW('revoked', () => new Worker(rev));
    tryW('callWithoutNew', () => Worker(u));
    tryW('protoCtor', () => new Worker.prototype.constructor(u));
    class Sub extends Worker {}
    tryW('subclass', () => new Sub(u));
    tryW('reflectConstruct', () => Reflect.construct(Worker, [u]));
    return out;`);
  check('Card background threads (classic blob, module blob, #frag, same-origin script, data:, revoked blob, no new, prototype.constructor, subclass, Reflect.construct) are all rejected',
    Object.values(cardWorkerAttempts).every((v) => v === 'blocked'), cardWorkerAttempts);

  const CHECKS = `async function checks() {
    const r = { idb: typeof self.indexedDB, caches: typeof self.caches, BC: typeof self.BroadcastChannel, SW: typeof self.SharedWorker };
    try { await navigator.storage.getDirectory(); r.opfs = 'open'; } catch (e) { r.opfs = 'denied'; }
    return r;
  }`;
  const cwD = await call('D', `const w = new Worker(URL.createObjectURL(new Blob([${JSON.stringify(`${CHECKS}\nchecks().then((r) => postMessage(r));`)}], { type: 'text/javascript' })));
    return await new Promise((res) => { w.onmessage = (e) => res(e.data); w.onerror = (e) => { e.preventDefault(); res({ error: e.message || 'error' }); }; setTimeout(() => res({ error: 'timeout' }), 10000); });`);
  check('Control (no hardening): the stage document can start a classic thread, and IndexedDB, Cache, OPFS and BroadcastChannel are all present inside it',
    cwD.idb === 'object' && cwD.caches === 'object' && cwD.opfs === 'open' && cwD.BC === 'function', cwD);

  const rtClassic = await call('A', `const w = PCH.spawnRuntimeWorker(${JSON.stringify(`importScripts(${JSON.stringify(`${STAGE}/runtime-worker.js`)});`)});
    return await new Promise((res) => { w.onmessage = (e) => res(e.data); w.onerror = (e) => { e.preventDefault(); res({ error: e.message || 'error' }); }; setTimeout(() => res({ error: 'timeout' }), 10000); });`);
  check('Runtime dedicated threads (spawnRuntimeWorker classic bootstrap + importScripts, same as production GL / sound threads) run as usual',
    rtClassic.t === 'runtime-ok' && rtClassic.kind === 'classic', rtClassic);

  const rtModule = await call('A', `const modUrl = URL.createObjectURL(new Blob([${JSON.stringify(RUNTIME_WORKER_MJS)}], { type: 'text/javascript' }));
    const w = PCH.spawnRuntimeWorker('import ' + JSON.stringify(modUrl) + ';', { type: 'module', name: 'pc-card-sound' });
    return await new Promise((res) => { w.onmessage = (e) => res(e.data); w.onerror = (e) => { e.preventDefault(); res({ error: e.message || 'error' }); }; setTimeout(() => res({ error: 'timeout' }), 10000); });`);
  check('Runtime dedicated threads (spawnRuntimeWorker module bootstrap + import) run as usual',
    rtModule.t === 'runtime-ok' && rtModule.kind === 'module', rtModule);

  const dps = await call('A', `const w = PCH.spawnRuntimeWorker(${JSON.stringify(`importScripts(${JSON.stringify(`${STAGE}/dps-worker.js`)});`)}, { name: 'pc-card-sound' });
    return await new Promise((res) => { w.onmessage = (e) => res(e.data); w.onerror = (e) => { e.preventDefault(); res({ error: e.message || 'error' }); }; setTimeout(() => res({ error: 'timeout' }), 10000); });`);
  check('Sound thread entry (denyPersistentStorage + installScopeGuard): no errors, storage and channels all removed, starting a Worker inside the thread is also rejected, locks work correctly by prefix',
    dps.t === 'dps' && dps.errors.length === 0 && dps.idb === 'undefined' && dps.caches === 'undefined' && dps.BC === 'undefined' && dps.SW === 'undefined'
    && dps.opfs === 'denied' && dps.idbOpen === 'denied' && /PromptCut stage: cannot start background thread/.test(dps.subWorker) && dps.locks === 'pc-sound-probe', dps);

  /* ---------- Lock names ---------- */
  await call('A', `navigator.locks.request('sid-lock-0123', () => new Promise(() => {})); await new Promise((r) => setTimeout(r, 100)); return 1;`);
  const lockA = await call('A', `const q = await navigator.locks.query();
    const own = await navigator.locks.request('sid-lock-0123', { ifAvailable: true }, (l) => l ? 'got' : 'blocked');
    return { held: q.held.map((l) => l.name), own };`);
  check('This document\'s query() sees its own lock (name with the prefix stripped), and requesting the same name again fails', lockA.held.includes('sid-lock-0123') && lockA.own === 'blocked', lockA);
  const lockC = await call('C', `const q = await navigator.locks.query();
    const got = await navigator.locks.request('sid-lock-0123', { ifAvailable: true }, (l) => l ? 'got:' + l.name : 'blocked');
    return { names: [...q.held, ...q.pending].map((l) => l.name), got };`);
  check('Another document (with hardening) cannot see A\'s lock names, and a lock with the same name can still be acquired', lockC.names.length === 0 && lockC.got === 'got:sid-lock-0123', lockC);
  const lockD = await call('D', `const q = await navigator.locks.query(); return q.held.map((l) => l.name);`);
  check('Control (no hardening): the real lock name carries the document prefix, not the name the card chose', lockD.some((n) => /^pc-[0-9a-f]{32}:sid-lock-0123$/.test(n)) && !lockD.includes('sid-lock-0123'), lockD);

  /* ---------- storage events ---------- */
  for (const id of ['C', 'D']) await call(id, `window.__se = []; addEventListener('storage', (e) => window.__se.push(e.key)); window.onstorage = (e) => window.__se.push('on:' + e.key); return 1;`);
  await call('A', `localStorage.setItem('pc.playable.1:' + 'a'.repeat(64), '1'); return 1;`);
  await sleep(600);
  const seC = await call('C', `return window.__se;`), seD = await call('D', `return window.__se;`);
  check('Another document writes real localStorage: the hardened document receives no storage event', seC.length === 0, seC);
  check('Control (no hardening): it is received', seD.length > 0, seD);

  /* ---------- Reload and stage iframe rebuild on project switch: window.name, history.state, location.hash, session history ---------- */
  const before = await call('A', `window.name = 'leak-sid-A'; history.pushState({ sid: 'leak-sid-A' }, '', '?sid=leak-sid-A'); location.hash = '#leak-sid-A';
    const out = { name: window.name, state: history.state, search: location.search, hash: location.hash, nav: typeof navigation, len: history.length };
    history.back(); history.go(-1); await new Promise((r) => setTimeout(r, 300)); out.stillHere = location.hash; return out;`);
  check('With hardening: the card reads and writes window.name and history.state as usual (this document only); pushState does not change the address; no navigation; back/go do nothing',
    before.name === 'leak-sid-A' && before.state?.sid === 'leak-sid-A' && before.search === '?f=A' && before.nav === 'undefined' && before.stillHere === '#leak-sid-A', before);
  await page.evaluate(() => window.reloadFrame('A'));
  check('A second reload', await waitLoad('A', 3));
  const after = await raw('A', 2);
  console.log(`      After reload of the hardened document (raw values read before hardening): ${JSON.stringify(after)}`);
  check('window.name written by the hardened document is empty after a frame.src = frame.src reload', after.name === '', after.name);
  check('history.state does not survive a frame.src = frame.src reload', after.state === null, after.state);
  check('location.hash does not survive a frame.src = frame.src reload', after.hash === '', after.hash);
  check('The previous entry read by the new document via navigation.activation.from has no path number (the address has only the hash a card can change, and the state is empty)',
    !after.from || (typeof after.from === 'object' && after.from.state === undefined && !String(after.from.url).includes('sid=')), after.from);
  const afterInstall = await call('A', install.replace('return {', 'return { nav: typeof navigation, len: history.length,'));
  check('A: hardening installed again after reload: no errors, no navigation', afterInstall.errors.length === 0 && afterInstall.nav === 'undefined', afterInstall.errors.join('; '));

  // Rebuild stage iframe element on in-place project switch (corresponding to stageFrameGen key in Preview.tsx):
  // First have card in project A self-navigate to change location.search (inserting an entry with
  // path id into old iframe session history), then rebuild iframe element per project switch procedure
  const loadsBeforeNav = await loads('A');
  await call('A', `setTimeout(() => { location.search = '?f=A&sid=leak-from-project-A'; }, 10); return 1;`);
  check('A: loaded after the card navigated itself by changing location.search', await waitLoad('A', loadsBeforeNav + 1));
  const navEntry = await raw('A', loadsBeforeNav);
  check('Control: changing location.search in the card left a session history entry with parameters in the old iframe (entries include the old entry)',
    navEntry.search.includes('sid=leak-from-project-A') && Array.isArray(navEntry.entries) && navEntry.entries.length > 1, { search: navEntry.search, entries: navEntry.entries });
  const loadsBeforeRecreate = await loads('A');
  await page.evaluate(() => window.recreateFrame('A'));
  check('A: loaded after recreating the stage iframe element on project switch', await waitLoad('A', loadsBeforeRecreate + 1));
  const recreated = await raw('A', loadsBeforeRecreate);
  console.log(`      Raw value after recreating the stage iframe: ${JSON.stringify(recreated)}`);
  check('Recreating the stage iframe on project switch: fresh browsing context (navigation.entries has only the current 1 entry, activation.from is null, no address left over from the previous project)',
    recreated.name === '' && recreated.state === null && recreated.hash === '' && recreated.search === '?f=A'
    && recreated.from === null && Array.isArray(recreated.entries) && recreated.entries.length === 1 && !recreated.entries[0].includes('leak-from-project-A'),
    recreated);
  await page.goBack().catch(() => {});
  await sleep(300);
  const afterBack = await call('A', `return { href: location.href, search: location.search, hash: location.hash };`);
  check('After recreating the stage iframe on project switch, browser back: the new iframe does not go back to the address changed by the old project\'s card',
    !afterBack.href.includes('leak-from-project-A') && afterBack.search === '?f=A' && afterBack.hash === '', afterBack);

  // Control: D without hardening writes the same way to see which remain
  await call('D', `window.name = 'ctl'; history.replaceState({ sid: 'ctl' }, ''); navigation.updateCurrentEntry({ state: { sid: 'ctl-nav' } }); location.hash = '#ctl'; return 1;`);
  await page.evaluate(() => window.reloadFrame('D'));
  check('D: reload', await waitLoad('D', 2));
  const ctl = await raw('D', 1);
  console.log(`      Control (no hardening) after reload: ${JSON.stringify(ctl)}`);
  check('Control: without hardening, window.name persists (this channel really exists)', ctl.name === 'ctl', ctl.name);
  check('Control: without hardening, the new document can read the previous document\'s address hash and state via navigation.activation.from (this channel really exists)',
    ctl.from && String(ctl.from.url).includes('#ctl') && ctl.from.state?.sid === 'ctl-nav', ctl.from);
  // Stage documents loaded with # in URL (can only be navigating back to an entry added by
  // previous document): stripped when installing hardening
  await page.evaluate(() => window.addFrame('E', '#leak-sid-E'));
  check('E: loaded', await waitLoad('E', 1));
  const hashE = await call('E', `const before = location.hash; PCH.installStageHardening({}); return { before, after: location.hash, href: location.href };`);
  check('Document loaded with #… in the address: stripped when hardening is installed', hashE.before === '#leak-sid-E' && hashE.after === '', hashE);
  // When cards call location.reload() themselves: whether history.state persists (only affects same
  // document in same project; records conclusion)
  await call('C', `history.replaceState({ sid: 'self-reload' }, ''); setTimeout(() => location.reload(), 10); return 1;`);
  check('C: reloads itself', await waitLoad('C', 2));
  const selfReload = await raw('C', 1);
  console.log(`      After the card's own location.reload(): state=${JSON.stringify(selfReload.state)} name=${JSON.stringify(selfReload.name)}`);

  check('No console errors in the stage (except the expected rejections)', consoleErrors.filter((t) => !/PromptCut|Content Security Policy|Refused/.test(t)).length === 0, consoleErrors.slice(0, 5));
} finally {
  await browser.close();
  for (const s of servers) s.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(profile, { recursive: true, force: true }); } catch { /* Harmless to keep */ }
}
console.log(`\nscopeGuard browser check (${MINIFY ? 'minified' : 'not minified'}): ${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log(`  FAILED: ${f}`); process.exitCode = 1; }
