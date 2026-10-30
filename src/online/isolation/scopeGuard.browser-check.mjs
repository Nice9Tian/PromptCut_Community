/**
 * 舞台源跨文档通道守卫(`scopeGuard.ts`、`harden.ts` 的 6c/6d 步)与换项目重建舞台 iframe 在真实无头 Chrome 里的核对。
 * 不进 `npm test`(文件名不是 `*.test.mjs`)。
 *
 * 搭法:本机两个端口,`127.0.0.1:<port>` 当编辑页,`localhost:<port+1>` 当舞台源(带在线舞台同一份内容安全策略
 * `stageCspHeader` 与 `Origin-Agent-Cluster`),舞台 iframe 带 `sandbox="allow-scripts allow-same-origin"`,与在线页面相同。
 * `harden.ts` 与 `scopeGuard.ts` 用 rolldown 打成压缩过的 iife 送进舞台(核守卫经压缩后仍自足),由编辑页把一段段「卡片代码」送进舞台执行。
 *
 * 核:装上加固之后
 *   - 卡片不能自己起后台线程:无论用本页建的 blob 地址(经典脚本或模块)、同源脚本、`data:`、撤销了的 blob,
 *     还是经 `Worker.prototype.constructor`、`class extends Worker`、`Reflect.construct`,一律抛 `PromptCut 舞台:不能起后台线程`;
 *   - 舞台运行时自己的专用后台线程(经模块闭包的 `spawnRuntimeWorker` 起,同 `spawnGlWorker` / `spawnSoundWorker`)照常跑;
 *   - 声音线程入口先后调 `denyPersistentStorage(self)` 与 `installScopeGuard(self)` 不报错,里面 IndexedDB、Cache Storage、
 *     源私有文件系统、BroadcastChannel、SharedWorker、再起 Worker 全部收走或拒绝,Web Locks 照常按前缀隔离;
 *   - `window.name` 在重载前写的,重载后是空的;没装加固时写进去的,装上加固时清掉;
 *   - 原地换项目时重建舞台 iframe 元素(对应 `Preview.tsx` 的 `stageFrameGen` key):即使上一个项目的卡片改过 `location.search` /
 *     `location.hash` 在旧 iframe 里留下了会话历史条目,重建后的新 iframe 是全新浏览上下文(`history.length === 1`、`entries` 只有新条目、
 *     `activation.from === null`),后退也不会回到上一个项目留下的地址;
 *   - BroadcastChannel、SharedWorker 在文档里没有;`cookieStore.set` 拒绝;
 *   - 锁名按文档隔开:别的文档看不见、占不住本文档的锁;
 *   - 别的文档写真实 localStorage 的 storage 事件收不到;`navigator.storage.persist()` 回 false。
 * 另有对照:没装加固的舞台文档里同样的写法能起线程、能存、能广播、锁名看得见(证明这些检查能测出泄漏)。
 *
 * 跑:node src/online/isolation/scopeGuard.browser-check.mjs [--port 6440] [--no-minify]
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

/* ---------- 打包 ---------- */
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

/* ---------- 舞台页里的代理:记下载入时的原始状态,执行编辑页送来的代码 ---------- */
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

  // A、C:装加固的舞台;D:没装加固的对照(同一个源)
  for (const id of ['A', 'C', 'D']) await page.evaluate((i) => window.addFrame(i), id);
  for (const id of ['A', 'C', 'D']) check(`舞台 ${id} 载入`, await waitLoad(id, 1));

  // A 先在没装加固时往 window.name 里写(模拟旧文档留下的东西),整页重载后再装
  await call('A', `window.name = 'pre-leak-sid'; return window.name;`);
  await page.evaluate(() => window.reloadFrame('A'));
  check('A 重载(加固前写过 window.name)', await waitLoad('A', 2));
  check('对照:没装加固时写的 window.name 跨 frame.src = frame.src 重载留下来了', (await raw('A', 1)).name === 'pre-leak-sid', (await raw('A', 1)).name);

  const install = `const r = PCH.installStageHardening({}); return { errors: r.errors, scopeGuarded: r.scopeGuarded, storageDenied: r.storageDenied };`;
  const repA = await call('A', install);
  const repC = await call('C', install);
  check('加固装上没有错误', repA.errors.length === 0 && repC.errors.length === 0, [...repA.errors, ...repC.errors].join('; ') || '');
  console.log(`      scopeGuarded: ${repA.scopeGuarded.join(', ')}`);
  check('装上加固时清掉了真实的 window.name', await call('A', `return window.name;`) === '');

  /* ---------- 文档里的通道 ---------- */
  const docChannels = `return { BC: typeof BroadcastChannel, SW: typeof SharedWorker, idb: typeof indexedDB, caches: typeof caches, sharedStorage: typeof window.sharedStorage,
    workerFn: typeof Worker, ctorOk: Worker.prototype.constructor === Worker };`;
  const dA = await call('A', docChannels);
  check('文档:BroadcastChannel、SharedWorker 没有', dA.BC === 'undefined' && dA.SW === 'undefined', dA);
  check('文档:Worker 仍是函数(供宿主能力检测 typeof Worker),且 Worker.prototype.constructor 指回守卫 Worker', dA.workerFn === 'function' && dA.ctorOk === true, dA);
  const dD = await call('D', docChannels);
  check('对照(没装加固):BroadcastChannel、SharedWorker 都在', dD.BC === 'function' && dD.SW === 'function', dD);

  const cookie = await call('A', `let set; try { await cookieStore.set('pc-leak', 'x'); set = 'written'; } catch (e) { set = 'rejected:' + e.message; }
    let del; try { await cookieStore.delete('pc-leak'); del = 'deleted'; } catch (e) { del = 'rejected'; }
    document.cookie = 'pc-leak2=y'; return { set, del, cookie: document.cookie, typeofStore: typeof cookieStore };`);
  check('cookieStore.set、delete 拒绝;document.cookie 写不进', cookie.set.startsWith('rejected') && cookie.del === 'rejected' && !cookie.cookie.includes('pc-leak'), cookie);
  const cookieD = await call('D', `try { await cookieStore.set('pc-ctl', 'x'); await cookieStore.delete('pc-ctl'); return 'written'; } catch (e) { return 'rejected:' + e.message; }`);
  check('对照(没装加固):cookieStore.set 走的是浏览器自己的实现', !cookieD.includes('PromptCut'), cookieD);

  const persist = await call('A', `return { persist: await navigator.storage.persist(), estimate: typeof (await navigator.storage.estimate()).quota };`);
  check('navigator.storage.persist() 回 false,estimate 照旧', persist.persist === false && persist.estimate === 'number', persist);

  /* ---------- 后台线程:卡片不能起,运行时专用线程照常起,声音线程装守卫 ---------- */
  const cardWorkerAttempts = await call('A', `const out = {};
    const tryW = (k, f) => {
      try { f(); out[k] = 'constructed'; }
      catch (e) { out[k] = /PromptCut 舞台:不能起后台线程/.test(String(e && e.message)) ? 'blocked' : 'other:' + String(e && e.message); }
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
  check('卡片起后台线程(经典 blob、模块 blob、#frag、同源脚本、data:、已撤销 blob、无 new、prototype.constructor、子类、Reflect.construct)一律拒绝',
    Object.values(cardWorkerAttempts).every((v) => v === 'blocked'), cardWorkerAttempts);

  const CHECKS = `async function checks() {
    const r = { idb: typeof self.indexedDB, caches: typeof self.caches, BC: typeof self.BroadcastChannel, SW: typeof self.SharedWorker };
    try { await navigator.storage.getDirectory(); r.opfs = 'open'; } catch (e) { r.opfs = 'denied'; }
    return r;
  }`;
  const cwD = await call('D', `const w = new Worker(URL.createObjectURL(new Blob([${JSON.stringify(`${CHECKS}\nchecks().then((r) => postMessage(r));`)}], { type: 'text/javascript' })));
    return await new Promise((res) => { w.onmessage = (e) => res(e.data); w.onerror = (e) => { e.preventDefault(); res({ error: e.message || 'error' }); }; setTimeout(() => res({ error: 'timeout' }), 10000); });`);
  check('对照(没装加固):舞台文档能起经典线程且里面 IndexedDB、Cache、OPFS、BroadcastChannel 都在',
    cwD.idb === 'object' && cwD.caches === 'object' && cwD.opfs === 'open' && cwD.BC === 'function', cwD);

  const rtClassic = await call('A', `const w = PCH.spawnRuntimeWorker(${JSON.stringify(`importScripts(${JSON.stringify(`${STAGE}/runtime-worker.js`)});`)});
    return await new Promise((res) => { w.onmessage = (e) => res(e.data); w.onerror = (e) => { e.preventDefault(); res({ error: e.message || 'error' }); }; setTimeout(() => res({ error: 'timeout' }), 10000); });`);
  check('运行时专用线程(spawnRuntimeWorker 经典引导 + importScripts,同生产态 GL / 声音线程)照常跑',
    rtClassic.t === 'runtime-ok' && rtClassic.kind === 'classic', rtClassic);

  const rtModule = await call('A', `const modUrl = URL.createObjectURL(new Blob([${JSON.stringify(RUNTIME_WORKER_MJS)}], { type: 'text/javascript' }));
    const w = PCH.spawnRuntimeWorker('import ' + JSON.stringify(modUrl) + ';', { type: 'module', name: 'pc-card-sound' });
    return await new Promise((res) => { w.onmessage = (e) => res(e.data); w.onerror = (e) => { e.preventDefault(); res({ error: e.message || 'error' }); }; setTimeout(() => res({ error: 'timeout' }), 10000); });`);
  check('运行时专用线程(spawnRuntimeWorker 模块引导 + import)照常跑',
    rtModule.t === 'runtime-ok' && rtModule.kind === 'module', rtModule);

  const dps = await call('A', `const w = PCH.spawnRuntimeWorker(${JSON.stringify(`importScripts(${JSON.stringify(`${STAGE}/dps-worker.js`)});`)}, { name: 'pc-card-sound' });
    return await new Promise((res) => { w.onmessage = (e) => res(e.data); w.onerror = (e) => { e.preventDefault(); res({ error: e.message || 'error' }); }; setTimeout(() => res({ error: 'timeout' }), 10000); });`);
  check('声音线程入口(denyPersistentStorage + installScopeGuard):没有错误,存储与通道全部收走,线程内再起 Worker 同样被拒,锁按前缀正常',
    dps.t === 'dps' && dps.errors.length === 0 && dps.idb === 'undefined' && dps.caches === 'undefined' && dps.BC === 'undefined' && dps.SW === 'undefined'
    && dps.opfs === 'denied' && dps.idbOpen === 'denied' && /PromptCut 舞台:不能起后台线程/.test(dps.subWorker) && dps.locks === 'pc-sound-probe', dps);

  /* ---------- 锁名 ---------- */
  await call('A', `navigator.locks.request('sid-lock-0123', () => new Promise(() => {})); await new Promise((r) => setTimeout(r, 100)); return 1;`);
  const lockA = await call('A', `const q = await navigator.locks.query();
    const own = await navigator.locks.request('sid-lock-0123', { ifAvailable: true }, (l) => l ? 'got' : 'blocked');
    return { held: q.held.map((l) => l.name), own };`);
  check('本文档 query() 看到自己的锁(名字去掉了前缀),同名再要拿不到', lockA.held.includes('sid-lock-0123') && lockA.own === 'blocked', lockA);
  const lockC = await call('C', `const q = await navigator.locks.query();
    const got = await navigator.locks.request('sid-lock-0123', { ifAvailable: true }, (l) => l ? 'got:' + l.name : 'blocked');
    return { names: [...q.held, ...q.pending].map((l) => l.name), got };`);
  check('别的文档(装了加固)看不见 A 的锁名,同名的锁照拿', lockC.names.length === 0 && lockC.got === 'got:sid-lock-0123', lockC);
  const lockD = await call('D', `const q = await navigator.locks.query(); return q.held.map((l) => l.name);`);
  check('对照(没装加固):真实锁名带着文档前缀,不是卡片起的名字', lockD.some((n) => /^pc-[0-9a-f]{32}:sid-lock-0123$/.test(n)) && !lockD.includes('sid-lock-0123'), lockD);

  /* ---------- storage 事件 ---------- */
  for (const id of ['C', 'D']) await call(id, `window.__se = []; addEventListener('storage', (e) => window.__se.push(e.key)); window.onstorage = (e) => window.__se.push('on:' + e.key); return 1;`);
  await call('A', `localStorage.setItem('pc.playable.1:' + 'a'.repeat(64), '1'); return 1;`);
  await sleep(600);
  const seC = await call('C', `return window.__se;`), seD = await call('D', `return window.__se;`);
  check('别的文档写真实 localStorage:装了加固的文档收不到 storage 事件', seC.length === 0, seC);
  check('对照(没装加固):收得到', seD.length > 0, seD);

  /* ---------- 重载与换项目重建 iframe:window.name、history.state、location.hash、会话历史 ---------- */
  const before = await call('A', `window.name = 'leak-sid-A'; history.pushState({ sid: 'leak-sid-A' }, '', '?sid=leak-sid-A'); location.hash = '#leak-sid-A';
    const out = { name: window.name, state: history.state, search: location.search, hash: location.hash, nav: typeof navigation, len: history.length };
    history.back(); history.go(-1); await new Promise((r) => setTimeout(r, 300)); out.stillHere = location.hash; return out;`);
  check('装了加固:卡片照常读写 window.name、history.state(只在本文档);pushState 不改地址;navigation 没有;back/go 不动',
    before.name === 'leak-sid-A' && before.state?.sid === 'leak-sid-A' && before.search === '?f=A' && before.nav === 'undefined' && before.stillHere === '#leak-sid-A', before);
  await page.evaluate(() => window.reloadFrame('A'));
  check('A 第二次重载', await waitLoad('A', 3));
  const after = await raw('A', 2);
  console.log(`      装了加固的文档重载后(加固前读到的原始值):${JSON.stringify(after)}`);
  check('装了加固的文档写的 window.name,frame.src = frame.src 重载后是空的', after.name === '', after.name);
  check('history.state 不跨 frame.src = frame.src 重载', after.state === null, after.state);
  check('location.hash 不跨 frame.src = frame.src 重载', after.hash === '', after.hash);
  check('新文档经 navigation.activation.from 读到的上一个条目里没有路径号(地址只有卡片能改的 hash,状态是空)',
    !after.from || (typeof after.from === 'object' && after.from.state === undefined && !String(after.from.url).includes('sid=')), after.from);
  const afterInstall = await call('A', install.replace('return {', 'return { nav: typeof navigation, len: history.length,'));
  check('A 重载后再装加固:没有错误,navigation 没有', afterInstall.errors.length === 0 && afterInstall.nav === 'undefined', afterInstall.errors.join('; '));

  // 原地换项目重建舞台 iframe(对应 Preview.tsx 的 stageFrameGen key):
  // 先让项目 A 的卡片自导航改 location.search(往旧 iframe 会话历史里塞一条带路径号的记录),再按换项目的做法重建 iframe 元素
  const loadsBeforeNav = await loads('A');
  await call('A', `setTimeout(() => { location.search = '?f=A&sid=leak-from-project-A'; }, 10); return 1;`);
  check('A 卡片自导航改 location.search 后载入', await waitLoad('A', loadsBeforeNav + 1));
  const navEntry = await raw('A', loadsBeforeNav);
  check('对照:卡片改 location.search 在旧 iframe 里留下了带参数的会话历史条目(entries 含旧条目)',
    navEntry.search.includes('sid=leak-from-project-A') && Array.isArray(navEntry.entries) && navEntry.entries.length > 1, { search: navEntry.search, entries: navEntry.entries });
  const loadsBeforeRecreate = await loads('A');
  await page.evaluate(() => window.recreateFrame('A'));
  check('换项目重建舞台 iframe 元素后 A 载入', await waitLoad('A', loadsBeforeRecreate + 1));
  const recreated = await raw('A', loadsBeforeRecreate);
  console.log(`      重建舞台 iframe 后的原始值:${JSON.stringify(recreated)}`);
  check('换项目重建舞台 iframe:全新浏览上下文(navigation.entries 只有当前 1 条,activation.from 为 null,没有上一个项目留下的地址)',
    recreated.name === '' && recreated.state === null && recreated.hash === '' && recreated.search === '?f=A'
    && recreated.from === null && Array.isArray(recreated.entries) && recreated.entries.length === 1 && !recreated.entries[0].includes('leak-from-project-A'),
    recreated);
  await page.goBack().catch(() => {});
  await sleep(300);
  const afterBack = await call('A', `return { href: location.href, search: location.search, hash: location.hash };`);
  check('换项目重建舞台 iframe 后按浏览器后退:新 iframe 不会退回旧项目卡片改过的地址',
    !afterBack.href.includes('leak-from-project-A') && afterBack.search === '?f=A' && afterBack.hash === '', afterBack);

  // 对照:没装加固的 D 同样写,看哪些会留下
  await call('D', `window.name = 'ctl'; history.replaceState({ sid: 'ctl' }, ''); navigation.updateCurrentEntry({ state: { sid: 'ctl-nav' } }); location.hash = '#ctl'; return 1;`);
  await page.evaluate(() => window.reloadFrame('D'));
  check('D 重载', await waitLoad('D', 2));
  const ctl = await raw('D', 1);
  console.log(`      对照(没装加固)重载后:${JSON.stringify(ctl)}`);
  check('对照:没装加固时 window.name 留下来(说明这条通道真实存在)', ctl.name === 'ctl', ctl.name);
  check('对照:没装加固时新文档经 navigation.activation.from 读得到上一个文档的地址 hash 与状态(说明这条通道真实存在)',
    ctl.from && String(ctl.from.url).includes('#ctl') && ctl.from.state?.sid === 'ctl-nav', ctl.from);
  // 地址带 # 载入的舞台文档(只可能是退回到上一个文档自己加的条目):装加固时去掉
  await page.evaluate(() => window.addFrame('E', '#leak-sid-E'));
  check('E 载入', await waitLoad('E', 1));
  const hashE = await call('E', `const before = location.hash; PCH.installStageHardening({}); return { before, after: location.hash, href: location.href };`);
  check('地址带 #… 载入的文档:装加固时去掉', hashE.before === '#leak-sid-E' && hashE.after === '', hashE);
  // 卡片自己 location.reload():history.state 会不会留(只影响同一个项目的同一个文档,记结论)
  await call('C', `history.replaceState({ sid: 'self-reload' }, ''); setTimeout(() => location.reload(), 10); return 1;`);
  check('C 自己 reload', await waitLoad('C', 2));
  const selfReload = await raw('C', 1);
  console.log(`      卡片自己 location.reload() 之后:state=${JSON.stringify(selfReload.state)} name=${JSON.stringify(selfReload.name)}`);

  check('舞台里没有控制台错误(除了预期的拒绝)', consoleErrors.filter((t) => !/PromptCut|Content Security Policy|Refused/.test(t)).length === 0, consoleErrors.slice(0, 5));
} finally {
  await browser.close();
  for (const s of servers) s.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 留着也无妨 */ }
}
console.log(`\nscopeGuard browser check (${MINIFY ? 'minified' : 'not minified'}): ${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log(`  FAILED: ${f}`); process.exitCode = 1; }
