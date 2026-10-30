// Probe: does the browser put same-host different-port iframes in separate renderer
// processes, with and without `Origin-Agent-Cluster: ?1`? Compare with a
// different-host iframe. Two signals per config:
//   1. is there a `type: 'iframe'` target for the child -> out-of-process iframe or not
//   2. block one iframe's main thread for 2.5 s, measure the parent's worst rAF gap
//
//   node scripts/probes/oac-probe.mjs                 -> puppeteer's own Chrome (a fresh
//                                                        browser per config, as before)
//   node scripts/probes/oac-probe.mjs --connect        -> the desktop shell's WebView2 on 9333
//   node scripts/probes/oac-probe.mjs --json out.json
//
// 冷启动第一轮有噪声，所以每个配置默认跑两遍（--repeats）。
import fs from 'node:fs';
import { connectArg, flagArg, openBrowser, pageFactory, listTargets, serve, closeAll, sleep }
  from './probe-connect.mjs';

const connect = connectArg();
const jsonOut = flagArg('json');
const REPEATS = Number(flagArg('repeats', '2'));
const P = Number(flagArg('parent-port', '5221'));
const A = Number(flagArg('a-port', '5222'));
const B = Number(flagArg('b-port', '5223'));

const stagePage = (name) => `<!doctype html><title>${name}</title><body style="margin:0;background:#246">
<div id=t style="color:#fff;font:24px monospace;padding:8px">${name}</div>
<script>
  addEventListener('message', e => {
    if (e.data === 'measure') { const gaps=[]; let last=performance.now(); const t0=last; (function m(){ const now=performance.now(); gaps.push(now-last); last=now; if (now-t0>3000) parent.postMessage({ measured: Math.max(...gaps) }, '*'); else requestAnimationFrame(m); })(); }
    if (e.data === 'block') { const end = performance.now() + 2500; while (performance.now() < end) {} parent.postMessage('blocked-done', '*'); }
  });
  let n = 0; (function loop(){ document.getElementById('t').textContent = '${name} ' + (n++); requestAnimationFrame(loop); })();
</script></body>`;

const parentPage = (a, b) => `<!doctype html><title>parent</title><body style="margin:0">
<iframe id=a src="${a}" style="width:400px;height:120px;border:0"></iframe>
<iframe id=b src="${b}" style="width:400px;height:120px;border:0"></iframe>
<script>
  window.__probe = () => new Promise(resolve => {
    const gaps = []; let last = performance.now(); let done = false; let bWorst = null;
    addEventListener('message', e => { if (e.data === 'blocked-done') done = true; if (e.data && e.data.measured !== undefined) bWorst = e.data.measured; });
    (function loop(){ const now = performance.now(); gaps.push(now - last); last = now; if (done && bWorst !== null && gaps.length > 20) resolve({ parent: Math.max(...gaps), b: bWorst }); else requestAnimationFrame(loop); })();
    setTimeout(() => { document.getElementById('b').contentWindow.postMessage('measure', '*'); document.getElementById('a').contentWindow.postMessage('block', '*'); }, 200);
    setTimeout(() => resolve({ parent: -1, b: -1 }), 9000);
  });
</script></body>`;

// In connect mode we keep one browser (WebView2 has no Target.createTarget and killing
// the shell between configs is not an option); in launch mode we keep the old behaviour
// of a fresh browser per config so no process-model decision leaks across configs.
// `--reuse-browser` makes launch mode behave like connect mode — that is how you show
// that the sticky origin-keying below is Chromium behaviour and not a WebView2 quirk.
const reuseBrowser = process.argv.includes('--reuse-browser') || process.argv.includes('--reuse-page');
// `--reuse-page` 还要求所有配置共用同一个 page（连 BrowsingInstance 一起共用），这正是
// connect 模式在 WebView2 里的处境。
const reusePage = process.argv.includes('--reuse-page');
let shared = null;
async function withBrowser(fn) {
  if (connect || reuseBrowser) {
    if (!shared) {
      shared = await openBrowser({ connect, launch: { headless: false, args: ['--window-size=900,400'] } });
      shared.factory = await pageFactory(shared.browser, shared.mode, { reusePage });
      shared.version = await shared.browser.version();
    }
    return fn(shared);
  }
  const b = await openBrowser({ launch: { headless: false, args: ['--window-size=900,400'] } });
  b.factory = await pageFactory(b.browser, b.mode);
  b.version = await b.browser.version();
  try { return await fn(b); } finally { await b.close(); }
}

// `--only <子串>` 只跑匹配的配置。用来做对照：Chromium 把「这个 origin 是不是 origin-keyed」
// 的判定按 BrowsingInstance 缓存，同一个浏览器里先跑过不带头的配置，再拿同一组端口跑带头的
// 配置就可能读到旧判定 —— connect 模式没法换浏览器，只能换端口或重启壳来复验。
const only = flagArg('only');

const results = [];
async function run(label, { oac, hostA, hostB, hostP }) {
  if (only && !label.includes(only)) return;
  const stage = (name) => (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    if (oac) res.setHeader('Origin-Agent-Cluster', '?1');
    res.end(stagePage(name));
  };
  const urlA = `http://${hostA}:${A}/`, urlB = `http://${hostB}:${B}/`;
  const servers = await Promise.all([
    serve(P, (req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.end(parentPage(urlA, urlB)); }),
    serve(A, stage('A')), serve(B, stage('B')),
  ]);
  try {
    for (let rep = 0; rep < REPEATS; rep++) {
      const row = await withBrowser(async (b) => {
        const handle = await b.factory.fresh();
        const page = handle.page;
        try {
          await page.goto(`http://${hostP}:${P}/`, { waitUntil: 'networkidle0' });
          await sleep(500);
          const frames = page.frames().filter((f) => f !== page.mainFrame());
          const targets = await listTargets(connect ?? b.browser).catch(() => []);
          const oopUrls = new Set((targets || []).filter((t) => t.type === 'iframe').map((t) => t.url));
          const oop = frames.map((f) => `${new URL(f.url()).host}:${oopUrls.has(f.url()) ? 'OOP' : 'in-process'}`);
          const worst = await page.evaluate(() => window.__probe());
          const oacApplied = await Promise.all(frames.map((f) => f.evaluate(() => window.originAgentCluster).catch(() => 'n/a')));
          return { label, rep: rep + 1, browser: b.version, frames: oop, oopifCount: oop.filter((s) => s.endsWith('OOP')).length,
            originAgentCluster: oacApplied, parentWorstRafMs: worst.parent, bWorstRafMs: worst.b };
        } finally {
          await b.factory.release(handle);
        }
      });
      results.push(row);
      console.log(`${(label + ` #${rep + 1}`).padEnd(46)} frames=[${row.frames.join(', ')}] originAgentCluster=[${row.originAgentCluster.join(', ')}] ` +
        `while A blocks 2.5s -> parent worst rAF gap ${row.parentWorstRafMs < 0 ? 'timeout' : row.parentWorstRafMs.toFixed(0) + ' ms'}, ` +
        `B worst rAF gap ${row.bWorstRafMs < 0 ? 'timeout' : row.bWorstRafMs.toFixed(0) + ' ms'}`);
    }
  } finally {
    await closeAll(servers);
  }
}

const head = connect
  ? `connect ${connect}`
  : 'launch ' + (await openBrowser({ launch: { headless: true } }).then(async (b) => { const v = await b.browser.version(); await b.close(); return v; }));
console.log('oac-probe:', head, `\nports parent=${P} A=${A} B=${B}\n`);

await run('same host, different ports, no header', { oac: false, hostP: 'localhost', hostA: 'localhost', hostB: 'localhost' });
await run('same host, different ports, OAC header', { oac: true, hostP: 'localhost', hostA: 'localhost', hostB: 'localhost' });
await run('different hosts (localhost / 127.0.0.1)', { oac: false, hostP: 'localhost', hostA: '127.0.0.1', hostB: '127.0.0.2' });
await run('different hosts + OAC header', { oac: true, hostP: 'localhost', hostA: '127.0.0.1', hostB: '127.0.0.2' });

if (shared) await shared.close();
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ probe: 'oac', mode: connect ? 'connect' : 'launch', when: new Date().toISOString(), results }, null, 2));
if (jsonOut) console.log(`\nJSON: ${jsonOut}`);
