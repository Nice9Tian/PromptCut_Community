/**
 * Probe: frame-by-frame comparison of Lottie cards before and after changes ("baseline capture"
 * and "compare against baseline").
 * Source: acceptance check for "Gui: Convert Lottie to remotion-style" in
 * `docs/plan/render-refactor-task.md`: capture baseline before changes, taking full-length
 * frame-by-frame screenshots for 5 built-in assets; after changes, every frame is identical, and
 * sampled jump frames are also identical. The pixel baseline demo project has no Lottie, so a full
 * comparison does not test it; this targeted comparison serves as the authoritative check.
 *
 *   Capture  node scripts/probes/lottie-baseline-probe.mjs capture --out out/lottie-baseline/before [--port 27600] [--assets adrock,…,demo]
 *   Compare  node scripts/probes/lottie-baseline-probe.mjs compare --a out/lottie-baseline/before --b out/lottie-baseline/after [--json <file>]
 *
 * How baseline capture works: start a vite instance serving only this probe (root is this workspace,
 * does not read the project's vite config, occupies only the single --port port), install the same
 * pinned entropy (`installPinnedEntropy`) in headless Chrome as in the product, and mount the **real**
 * `LottieView` with React (which is what media wrapper cards use, with `src` pointing to files in the
 * asset catalog; `demo` is the demo animation inlined in the default parameters of the generic Lottie
 * card). Place the card in a 1920×1080 frame and save page screenshots as PNG. Take three sets for
 * each asset:
 *   seq   Sequential push: mount at frame 0, advance frame by frame to the last frame, one image per frame (full length)
 *   back  Jump back: after sequential push, the same instance returns to frame 0 and jumps directly to sampled frames
 *   jump  Direct jump: open a new page for each sampled frame, mounting directly at that frame
 * Frame numbers follow the asset's own frame rate (t = frame / frame rate, the reverse of the
 * t → frame calculation in cards). Each image also records the hash of "visible SVG text"
 * (excluding contents of `display: none` nodes and unreferenced `<defs>`, using the same standard as
 * `lottie-seed-probe.mjs`) to distinguish "text changed, pixels unchanged".
 *
 * How comparison works: two images with the same name are considered identical if PNG bytes match;
 * if bytes differ, decode and count pixel by pixel, reporting differing pixel counts and max difference.
 * Exit code: compare is non-zero only when images are missing on either side or counts do not match;
 * differing frames are listed as-is, with reasons explained one by one in the report (for expected
 * ones, see task brief "Gui").
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const [, , COMMAND] = process.argv;
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : dflt; };
const BUNDLED = ['adrock', 'bodymovin', 'gatin', 'happy2016', 'navidad'];
const CATALOG = path.join(ROOT, 'server', 'catalog', 'lottie');
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 20);
const pad = (n) => String(n).padStart(4, '0');

if (COMMAND === 'capture') await capture();
else if (COMMAND === 'compare') await compare();
else { console.error('See the file header for usage: capture --out <dir> | compare --a <dir> --b <dir>'); process.exit(2); }

async function capture() {
  const { createServer } = await import('vite');
  const { default: puppeteer } = await import('puppeteer');
  const { PROBE_CHROME_ARGS } = await import('./probe-chrome.mjs');
  const PORT = Number(arg('--port', '27600'));
  if (!Number.isInteger(PORT) || PORT < 20000 || PORT > 64999) throw new Error('--port must be a port of 20000 or above');
  const OUT = path.resolve(ROOT, arg('--out', 'out/lottie-baseline/run'));
  const ASSETS = arg('--assets', [...BUNDLED, 'demo'].join(',')).split(',').filter(Boolean);
  const POKE = arg('--poke', '');
  const REFLOW = process.argv.includes('--reflow');
  const JUMP_ALL = process.argv.includes('--jump-all');
  const QUERY = arg('--query', '');
  fs.mkdirSync(OUT, { recursive: true });

  const HARNESS = String.raw`<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;background:#111;overflow:hidden}.absolute{position:absolute}.inset-0{inset:0}#card{position:absolute;left:0;top:0;width:1920px;height:1080px}</style>
<div id="card"></div>
<script type="module">
  // 和产品一样:随机数钉子赶在播放库加载之前装(render/stageClockEntry.ts 是入口的第一个 import)
  import { installPinnedEntropy } from '/src/kernel/pinEntropy.ts';
  installPinnedEntropy();
</script>
<script type="module">
  import React from 'react';
  import { createRoot } from 'react-dom/client';
  import { flushSync } from 'react-dom';
  import { LottieView, lottieCard } from '/src/cards/native/lottie.tsx';
  import { waitForFrameWork } from '/src/kernel/frameReady.ts';
  const normalize = (s) => { const ids = new Map(); return s.replace(/__lottie_element_\d+/g, (m) => { if (!ids.has(m)) ids.set(m, 'E' + ids.size); return ids.get(m); }); };
  const visible = (svg) => {
    const copy = svg.cloneNode(true);
    const walk = (el) => {
      if (el.style && el.style.display === 'none') { while (el.firstChild) el.removeChild(el.firstChild); for (const a of [...el.attributes]) if (a.name !== 'id' && a.name !== 'style') el.removeAttributeNode(a); return; }
      const attrs = [...el.attributes].sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
      for (const a of attrs) el.removeAttributeNode(a);
      for (const a of attrs) el.setAttributeNode(a);
      for (const child of [...el.children]) walk(child);
    };
    walk(copy);
    const refsOf = (el, into) => { for (const node of [el, ...el.querySelectorAll('*')]) for (const a of node.attributes) { for (const m of a.value.matchAll(/url\(["']?#([^)"']+)["']?\)/g)) into.add(m[1]); if (a.localName === 'href' && a.value.startsWith('#')) into.add(a.value.slice(1)); } };
    const byId = new Map(); for (const el of copy.querySelectorAll('[id]')) byId.set(el.getAttribute('id'), el);
    const used = new Set(); const pending = new Set();
    for (const child of copy.children) if (child.localName !== 'defs') refsOf(child, pending);
    while (pending.size) { const id = pending.values().next().value; pending.delete(id); if (used.has(id)) continue; used.add(id); const el = byId.get(id); if (el) { const more = new Set(); refsOf(el, more); for (const x of more) if (!used.has(x)) pending.add(x); } }
    for (const defs of copy.querySelectorAll('defs')) for (const res of [...defs.children]) { const ids = [res, ...res.querySelectorAll('[id]')].map((el) => el.getAttribute('id')).filter(Boolean); if (!ids.some((id) => used.has(id))) res.remove(); }
    return normalize(new XMLSerializer().serializeToString(copy));
  };
  const api = {
    root: null, params: null,
    mount(name, t) {
      api.params = name === 'demo'
        ? { json: lottieCard.defaults.json, src: '', speed: 1, loop: 'no', fit: 'contain' }
        : { json: '', src: '/catalog/lottie/' + name + '.json', speed: 1, loop: 'no', fit: 'contain' };
      api.root = createRoot(document.getElementById('card'));
      return api.frame(t);
    },
    async frame(t) {
      flushSync(() => api.root.render(React.createElement(LottieView, { ...api.params, t })));
      // 走 src 的要等取数;播放库的 DOMLoaded 是 setTimeout(0) 发的,卡片在那以后才交「这一帧好了」
      await new Promise((resolve) => setTimeout(resolve, 0));
      await waitForFrameWork();
      const svg = document.querySelector('#card svg');
      // 等浏览器把这一帧画出来再让外面截图
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return svg ? visible(svg) : '';
    },
  };
  window.api = api; window.ready = true;
</script>`;

  const plugin = {
    name: 'lottie-baseline-probe', enforce: 'pre',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url, 'http://x');
        res.setHeader('cache-control', 'no-store');
        if (url.pathname === '/favicon.ico') { res.statusCode = 204; res.end(); return; }
        if (url.pathname === '/harness') { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(await server.transformIndexHtml('/harness', HARNESS)); return; }
        const m = /^\/catalog\/lottie\/([a-z0-9]+)\.json$/.exec(url.pathname);
        if (m && BUNDLED.includes(m[1])) { res.setHeader('content-type', 'application/json'); res.end(fs.readFileSync(path.join(CATALOG, `${m[1]}.json`))); return; }
        next();
      });
    },
  };
  const vite = await createServer({
    root: ROOT, configFile: false, plugins: [plugin], logLevel: 'error', appType: 'custom',
    cacheDir: path.join(os.tmpdir(), 'pc-lottie-baseline-probe-vite'),
    optimizeDeps: { include: ['lottie-web', 'react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime'] },
    server: { host: '127.0.0.1', port: PORT, strictPort: true, hmr: false, watch: null },
  });
  await vite.listen();
  let browser = null;
  const started = Date.now();
  const index = { when: new Date().toISOString(), out: OUT, pageErrors: [], assets: {} };
  try {
    browser = await puppeteer.launch({ headless: true, protocolTimeout: 900000, args: [...PROBE_CHROME_ARGS, '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1'] });
    index.chrome = await browser.version();
    const open = async () => {
      const page = await browser.newPage();
      await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
      page.on('pageerror', (e) => index.pageErrors.push(String(e?.message ?? e).slice(0, 300)));
      page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warn') index.pageErrors.push(`console.${m.type()}: ${m.text().slice(0, 300)}`); });
      await page.goto(`http://127.0.0.1:${PORT}/harness${QUERY}`, { waitUntil: 'load' });
      await page.waitForFunction('window.ready === true', { timeout: 120000 });
      return page;
    };
    const shot = async (page, file, vis) => {
      // --reflow: force the browser to repaint the entire SVG before screenshot
      // (for diagnostics, see file header)
      if (REFLOW) await page.evaluate(() => { const svg = document.querySelector('#card svg'); if (svg) { svg.style.display = 'none'; void svg.getBoundingClientRect(); svg.style.display = 'block'; } return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); });
      const png = Buffer.from(await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 1920, height: 1080 } }));
      fs.writeFileSync(file, png);
      return { png: sha(png), vis: sha(vis), empty: vis === '' };
    };
    for (const name of ASSETS) {
      const data = name === 'demo' ? { fr: 30, ip: 0, op: 60 } : JSON.parse(fs.readFileSync(path.join(CATALOG, `${name}.json`), 'utf8'));
      const fr = Number(data.fr) || 30, total = Math.max(1, (Number(data.op) || 0) - (Number(data.ip) || 0));
      const picks = [...new Set([0, 1, Math.floor(total * 0.13), Math.floor(total * 0.31), Math.floor(total / 2), Math.floor(total * 0.69), total - 2, total - 1])].filter((f) => f >= 0 && f < total);
      const dir = path.join(OUT, name);
      fs.mkdirSync(dir, { recursive: true });
      const entry = { fr, total, picks, seq: [], back: {}, jump: {} };
      index.assets[name] = entry;
      const page = await open();
      for (let f = 0; f < total; f++) {
        const vis = await page.evaluate((n, t, first) => (first ? window.api.mount(n, t) : window.api.frame(t)), name, f / fr, f === 0);
        entry.seq.push(await shot(page, path.join(dir, `seq-${pad(f)}.png`), vis));
      }
      if (POKE.startsWith(`${name}:`)) {
        // For diagnostics (see file header --poke): after sequential advance to this frame, use several
        // methods to force the browser to repaint, opening a new page for each method to see which one
        // makes the frame match the direct jump frame
        const f = Number(POKE.split(':')[1]);
        const reset = (attr) => `(() => { let n = 0; for (const el of document.querySelectorAll('#card svg [${attr}]')) { const v = el.getAttribute('${attr}'); el.removeAttribute('${attr}'); void el.getBoundingClientRect(); el.setAttribute('${attr}', v); n++; } return n; })()`;
        const tricks = {
          wait: `new Promise((r) => setTimeout(r, 500))`,
          mask: reset('mask'), clip: reset('clip-path'), filter: reset('filter'),
          maskContent: `(() => { let n = 0; for (const m of document.querySelectorAll('#card svg mask, #card svg clipPath')) { const first = m.firstChild; if (first) { m.removeChild(first); m.insertBefore(first, m.firstChild); n++; } } return n; })()`,
          describe: `(() => { const out = {}; for (const m of document.querySelectorAll('#card svg mask')) { const kids = [...m.children].map((c) => c.localName + (c.style.display ? '[' + c.style.display + ']' : '')).join(','); const deep = m.querySelectorAll('*').length; const hidden = m.querySelectorAll('[style*="display"]').length; const key = kids.slice(0, 60) + ' | deep ' + (deep > 5 ? 'many' : deep) + ' | styled ' + (hidden ? 'yes' : 'no'); out[key] = (out[key] || 0) + 1; } return JSON.stringify(out, null, 1); })()`,
          maskWithLayers: `(() => { let n = 0; for (const m of document.querySelectorAll('#card svg mask')) { if (!m.querySelector('g')) continue; const first = m.firstChild; if (first) { m.removeChild(first); m.insertBefore(first, m.firstChild); n++; } } return n; })()`,
          maskPathsOnly: `(() => { let n = 0; for (const m of document.querySelectorAll('#card svg mask')) { if (m.querySelector('g')) continue; const first = m.firstChild; if (first) { m.removeChild(first); m.insertBefore(first, m.firstChild); n++; } } return n; })()`,
          maskOnly: `(() => { let n = 0; for (const m of document.querySelectorAll('#card svg mask')) { const first = m.firstChild; if (first) { m.removeChild(first); m.insertBefore(first, m.firstChild); n++; } } return n; })()`,
          reflow: `(() => { const svg = document.querySelector('#card svg'); svg.style.display = 'none'; void svg.getBoundingClientRect(); svg.style.display = 'block'; })()`,
        };
        for (const [trick, code] of Object.entries(tricks)) {
          const p2 = await open();
          let vis = '';
          for (let g = 0; g <= f; g++) vis = await p2.evaluate((n, t, first) => (first ? window.api.mount(n, t) : window.api.frame(t)), name, g / fr, g === 0);
          const before = await shot(p2, path.join(dir, `poke-${pad(f)}-${trick}-0.png`), vis);
          const touched = await p2.evaluate(code);
          await p2.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
          const after = await shot(p2, path.join(dir, `poke-${pad(f)}-${trick}-1.png`), vis);
          console.log(`  poke ${trick}: touched ${touched ?? '-'} places; before ${before.png}, after ${after.png}`);
          await p2.close();
        }
      }
      await page.evaluate(() => window.api.frame(0));
      for (const f of picks) {
        const vis = await page.evaluate((t) => window.api.frame(t), f / fr);
        entry.back[f] = await shot(page, path.join(dir, `back-${pad(f)}.png`), vis);
      }
      await page.close();
      for (const f of picks) {
        const fresh = await open();
        const vis = await fresh.evaluate((n, t) => window.api.mount(n, t), name, f / fr);
        entry.jump[f] = await shot(fresh, path.join(dir, `jump-${pad(f)}.png`), vis);
        await fresh.close();
      }
      if (JUMP_ALL) {
        // --jump-all: open a new page for every frame and mount directly at that frame (full-length
        // "direct jump"), used to compare frame by frame against the sequential advance of another run
        entry.jumpall = [];
        for (let f = 0; f < total; f++) {
          const fresh = await open();
          const vis = await fresh.evaluate((n, t) => window.api.mount(n, t), name, f / fr);
          entry.jumpall.push(await shot(fresh, path.join(dir, `jumpall-${pad(f)}.png`), vis));
          await fresh.close();
        }
      }
      const empties = entry.seq.filter((s) => s.empty).length;
      console.log(`${name}: ${total} frames (frame rate ${fr}), forward ${entry.seq.length} images, back-jump ${Object.keys(entry.back).length} images, direct jump ${Object.keys(entry.jump).length} images (frames ${picks.join(', ')}); ${empties} images without SVG`);
      if (empties) index.pageErrors.push(`${name}: ${empties} images contain no SVG`);
    }
  } finally {
    index.seconds = +((Date.now() - started) / 1000).toFixed(1);
    fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index, null, 1));
    await browser?.close().catch(() => {});
    await vite.close().catch(() => {});
  }
  console.log(`Capture written to ${OUT}, took ${index.seconds} s; ${index.pageErrors.length} page errors and warnings`);
  for (const e of index.pageErrors.slice(0, 10)) console.log(`  ${e}`);
  process.exit(index.pageErrors.length ? 1 : 0);
}

async function compare() {
  const { PNG } = await import('pngjs');
  const A = path.resolve(ROOT, arg('--a', '')), B = path.resolve(ROOT, arg('--b', ''));
  const ia = JSON.parse(fs.readFileSync(path.join(A, 'index.json'), 'utf8')), ib = JSON.parse(fs.readFileSync(path.join(B, 'index.json'), 'utf8'));
  const result = { a: A, b: B, assets: {}, problems: [] };
  // --pairs seq:jumpall means compare seq from the first run against jumpall from the second;
  // omitting it compares seq, back, and jump individually
  const PAIRS = arg('--pairs', 'seq,back,jump').split(',').filter(Boolean);
  const pixels = (fa, fb) => {
    const pa = PNG.sync.read(fs.readFileSync(fa)), pb = PNG.sync.read(fs.readFileSync(fb));
    if (pa.width !== pb.width || pa.height !== pb.height) return { pixels: -1, max: 255 };
    let count = 0, max = 0;
    for (let i = 0; i < pa.data.length; i += 4) {
      const d = Math.max(Math.abs(pa.data[i] - pb.data[i]), Math.abs(pa.data[i + 1] - pb.data[i + 1]), Math.abs(pa.data[i + 2] - pb.data[i + 2]), Math.abs(pa.data[i + 3] - pb.data[i + 3]));
      if (d) { count++; if (d > max) max = d; }
    }
    return { pixels: count, max };
  };
  for (const name of Object.keys(ia.assets)) {
    const ea = ia.assets[name], eb = ib.assets[name];
    if (!eb) { result.problems.push(`${name}: missing in the second capture`); continue; }
    if (ea.total !== eb.total) { result.problems.push(`${name}: frame count mismatch ${ea.total} / ${eb.total}`); continue; }
    const out = { total: ea.total };
    for (const pair of PAIRS) {
      const [ga, gb] = pair.split(':'); const group = ga === (gb ?? ga) ? ga : `${ga}→${gb}`;
      const la = ea[ga], lb = eb[gb ?? ga];
      if (!la || !lb) { result.problems.push(`${name}: no group ${!la ? ga : gb}`); continue; }
      const keys = Array.isArray(la) ? la.map((_, i) => i) : Object.keys(la).map(Number);
      const g = { count: keys.length, same: 0, textOnly: [], pixelDiff: [] };
      for (const f of keys) {
        const sa = la[f], sb = lb[f];
        if (!sa || !sb) { result.problems.push(`${name} ${group} frame ${f}: image missing`); continue; }
        if (sa.png === sb.png) { if (sa.vis === sb.vis) g.same++; else g.textOnly.push(f); continue; }
        const d = pixels(path.join(A, name, `${ga}-${pad(f)}.png`), path.join(B, name, `${gb ?? ga}-${pad(f)}.png`));
        if (d.pixels === 0) { if (sa.vis === sb.vis) g.same++; else g.textOnly.push(f); } else g.pixelDiff.push({ f, pixels: d.pixels, max: d.max, textSame: sa.vis === sb.vis });
      }
      out[group] = g;
      const worst = g.pixelDiff.reduce((m, x) => Math.max(m, x.pixels), 0);
      console.log(`${name} ${group}: ${g.count} images, identical ${g.same}; text differs but pixels identical ${g.textOnly.length}${g.textOnly.length ? `(frames ${ranges(g.textOnly)})` : ''}; pixels differ ${g.pixelDiff.length}${g.pixelDiff.length ? `(frames ${ranges(g.pixelDiff.map((x) => x.f))}, up to ${worst} pixels, max difference ${g.pixelDiff.reduce((m, x) => Math.max(m, x.max), 0)})` : ''}`);
    }
    result.assets[name] = out;
  }
  const json = arg('--json', '');
  if (json) fs.writeFileSync(path.resolve(ROOT, json), JSON.stringify(result, null, 1));
  for (const p of result.problems) console.log(`Mismatch: ${p}`);
  process.exit(result.problems.length ? 1 : 0);
}

/** [1,2,3,7,9,10] → "1-3, 7, 9-10" */
function ranges(list) {
  const xs = [...list].sort((a, b) => a - b), out = [];
  for (let i = 0; i < xs.length; i++) { let j = i; while (j + 1 < xs.length && xs[j + 1] === xs[j] + 1) j++; out.push(j > i ? `${xs[i]}-${xs[j]}` : `${xs[i]}`); i = j; }
  return out.join(', ');
}
