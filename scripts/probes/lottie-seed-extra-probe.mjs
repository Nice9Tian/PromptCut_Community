/**
 * Probe: Lottie PRNG pinning: items not tested in prototype (`lottie-seed-probe.mjs`), plus "how
 * long it takes to compute one frame on the fly".
 * Source: `docs/plan/render-refactor-task.md` "Gui", item 2 under "Integration tasks". **Rerun
 * together with `lottie-seed-probe.mjs` before upgrading player library (lottie-web).**
 *
 *   node scripts/probes/lottie-seed-extra-probe.mjs [--port 27602] [--out <dir>] [--only posterize,crossread,…] [--skip-build] [--skip-big] [--skip-timing]
 *
 * Method: Start a Vite instance serving only this probe (root is this workspace, does not read
 * project Vite config, occupies only --port; the production build item occupies --port + 1
 * separately for static files), install the same PRNG pin in headless Chrome as in production, and
 * create instances using the card's own `loadLottie`, **without passing configuration modes**:
 * this tests defaults (the official set: replace random functions in expressions, outer wrapper
 * layer, and do not retain stale attribute values). Assets are all created on the fly by the probe
 * and not written to disk.
 *
 * For each asset, sample several Ns, comparing six frames per N (criteria identical to
 * `lottie-seed-probe.mjs`: visible SVG text byte-for-byte identical, and pixels identical one by
 * one):
 *   Sequential advance, jump back, new on same page, new on new page, other card first (call
 *   Math.random 13 times first), other Lottie first (create an instance with switches off and
 *   random expressions, advance a few frames first)
 * Also run once with all three switches disabled as a control (report only: when disabled, these
 * assets do not match initially, proving the test case actually exercises random numbers).
 *
 * Assets:
 *   posterize     Call `posterizeTime()` first in expression, then wiggle / random / seedRandom
 *   crossread     An expression reads another property with random expressions midway through
 *                 evaluation (one instance each where the reading layer evaluates earlier and later)
 *   globalbypass  Expression bypasses and directly accesses global objects:
 *                 `globalThis.Math.random()`, `globalThis.crypto.getRandomValues()`
 *   textexpr      Expression modifies text content, paired with a "random order" text animator
 *   nested        Compositions nested three levels, multiple copies at each level, innermost with
 *                 random and wiggle; also verifies that each copy animates independently
 *   netfont       Text layer with web font (probe serves a local font file as web font), loading is
 *                 asynchronous; recorded as "skipped" if font file is not found
 * Additionally:
 *   build         Production build (vite build, default minification): bundle the same page code
 *                 and rerun fixture, exprcases, textrandom, nested, textexpr, globalbypass,
 *                 happy2016; six frames identical, and identical to frames obtained in dev build;
 *                 page has no `[lottie]` warnings (several hooks relying on player internal names
 *                 are wrapped)
 *   big           Duration and memory of duplicating compositions on large assets (record only):
 *                 30 copies of a 150-layer composition with random expressions on every layer
 *   timing        How long it takes to compute one frame on the fly (record only): 5 built-in
 *                 assets, synchronous duration of jumping one frame, and duration of "jump one
 *                 frame and wait for browser to render one frame"; measured with main thread
 *                 unthrottled and throttled 4x
 *
 * Criteria (added to `fails` on failure, exit code 1): when enabled, all six frames across all Ns
 * are identical for each asset; copies in nested animate independently; numbers in globalbypass
 * change with frames; build checks pass; page has no errors or warnings. Disabled control, big,
 * and timing are reported only.
 */
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createServer, build } from 'vite';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : dflt; };
const flag = (name) => process.argv.includes(name);
const PORT = Number(arg('--port', '27602'));
if (!Number.isInteger(PORT) || PORT < 20000 || PORT > 64999) throw new Error('--port must be a port of 20000 or above');
const OUT = path.resolve(ROOT, arg('--out', path.join('out', 'lottie-seed-extra-probe')));
fs.mkdirSync(OUT, { recursive: true });
const ONLY = arg('--only', '').split(',').filter(Boolean);
const want = (name) => !ONLY.length || ONLY.includes(name);
const CATALOG = path.join(ROOT, 'server', 'catalog', 'lottie');
const FIX = path.join(ROOT, 'scripts', 'probes', 'fixtures', 'lottie-seed');
const BUNDLED = ['adrock', 'bodymovin', 'gatin', 'happy2016', 'navidad'];
const fsPath = (rel) => path.join(ROOT, rel).split(path.sep).join('/');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

// ── Assets created on the fly ──
const st = (v) => ({ a: 0, k: v });
const base = (nm, extra = {}) => ({ v: '5.7.4', fr: 30, ip: 0, op: 60, w: 1920, h: 1080, nm, ddd: 0, assets: [], layers: [], ...extra });
const ks = (pos, over = {}) => ({ o: st(100), r: st(0), p: st(pos), a: st([0, 0, 0]), s: st([100, 100, 100]), ...over });
const box = (color, size = [160, 100]) => [{ ty: 'gr', it: [
  { ty: 'rc', d: 1, s: st(size), p: st([0, 0]), r: st(12) },
  { ty: 'fl', c: st(color), o: st(100) },
  { ty: 'tr', p: st([0, 0]), a: st([0, 0]), s: st([100, 100]), r: st(0), o: st(100) },
] }];
const shape = (ind, nm, pos, over, color = [0.37, 0.55, 1, 1], op = 60) => ({ ddd: 0, ind, ty: 4, nm, ln: nm, sr: 1, ao: 0, ip: 0, op, st: 0, bm: 0, ks: ks(pos, over), shapes: box(color) });
const precomp = (ind, nm, refId, pos, w, h, op = 60) => ({ ddd: 0, ind, ty: 0, nm, ln: nm, refId, sr: 1, ao: 0, ip: 0, op, st: 0, bm: 0, w, h, ks: ks(pos) });
const expr = (k, x) => ({ a: 0, k, x });

function posterize() {
  const d = base('pc-extra-posterize');
  d.layers = [
    shape(1, 'post-wiggle', [500, 250, 0], { p: expr([500, 250, 0], 'var $bm_rt;\nposterizeTime(5);\n$bm_rt = wiggle(5, 120);') }),
    shape(2, 'post-random', [500, 500, 0], { p: expr([500, 500, 0], 'var $bm_rt;\nposterizeTime(4);\n$bm_rt = [random(200, 1700), 500, 0];') }, [1, 0.5, 0.3, 1]),
    shape(3, 'post-seeded', [500, 800, 0], { o: expr(100, 'var $bm_rt;\nposterizeTime(3);\nseedRandom(5, true);\n$bm_rt = random(20, 100);') }, [0.4, 0.9, 0.5, 1]),
    shape(4, 'post-wiggle-only', [1200, 800, 0], { p: expr([1200, 800, 0], 'var $bm_rt;\nposterizeTime(6);\n$bm_rt = wiggle(2, 200);') }, [0.9, 0.8, 0.2, 1]),
  ];
  return d;
}
function crossread() {
  const d = base('pc-extra-crossread');
  const read = (name) => `var $bm_rt;\nvar other = thisComp.layer('${name}').transform.position;\n$bm_rt = [other[0] + random(0, 60), other[1] + 250, 0];`;
  d.layers = [
    // Player library evaluates backward from the last layer for each frame: reader-late is on layer 1,
    // evaluating last (target-a is already computed when read); reader-early is on the last layer,
    // evaluating first (target-b is not yet computed when read)
    shape(1, 'reader-late', [0, 0, 0], { p: expr([0, 0, 0], read('target-a')) }, [1, 0.4, 0.4, 1]),
    shape(2, 'target-a', [500, 250, 0], { p: expr([500, 250, 0], 'var $bm_rt;\n$bm_rt = wiggle(5, 90);') }),
    shape(3, 'tail-wiggle', [1500, 250, 0], { p: expr([1500, 250, 0], 'var $bm_rt;\n$bm_rt = wiggle(5, 90);') }, [0.9, 0.8, 0.2, 1]),
    shape(4, 'target-b', [1000, 250, 0], { p: expr([1000, 250, 0], 'var $bm_rt;\nseedRandom(11, true);\n$bm_rt = wiggle(5, 90);') }, [0.4, 0.9, 0.5, 1]),
    shape(5, 'reader-early', [0, 0, 0], { p: expr([0, 0, 0], read('target-b')) }, [0.8, 0.4, 1, 1]),
  ];
  return d;
}
function globalbypass() {
  const d = base('pc-extra-globalbypass');
  d.layers = [
    shape(1, 'global-math', [400, 300, 0], { p: expr([400, 300, 0], 'var $bm_rt;\n$bm_rt = [300 + globalThis.Math.random() * 1200, 300, 0];') }),
    shape(2, 'global-crypto', [400, 600, 0], { p: expr([400, 600, 0], 'var $bm_rt;\nvar a = new Uint8Array(2);\nglobalThis.crypto.getRandomValues(a);\n$bm_rt = [300 + (a[0] * 256 + a[1]) / 65535 * 1200, 600, 0];') }, [1, 0.5, 0.3, 1]),
    shape(3, 'plain-wiggle', [960, 850, 0], { p: expr([960, 850, 0], 'var $bm_rt;\n$bm_rt = wiggle(5, 100);') }, [0.4, 0.9, 0.5, 1]),
  ];
  return d;
}
function textexpr() {
  const src = JSON.parse(fs.readFileSync(path.join(FIX, 'text-random.json'), 'utf8'));
  const d = base('pc-extra-textexpr', { fonts: src.fonts, chars: src.chars });
  const layer = (ind, nm, y, x) => {
    const l = JSON.parse(JSON.stringify(src.layers[0]));
    l.ind = ind; l.nm = nm; l.ln = nm; l.ks.p = st([300, y, 0]);
    l.t.d = { k: [l.t.d.k[0]], x };
    return l;
  };
  d.layers = [
    layer(1, 'text-by-time', 300, "var $bm_rt;\n$bm_rt = time < 0.5 ? 'ABCDEFGH' : (time < 1.2 ? 'HGFEDCBA' : 'ABCDHGFE');"),
    layer(2, 'text-back-and-forth', 600, "var $bm_rt;\n$bm_rt = (Math.floor(time * 3) % 2) ? 'AABBCCDD' : 'ABCDEFGH';"),
    shape(3, 'beside', [1400, 500, 0], { p: expr([1400, 500, 0], 'var $bm_rt;\n$bm_rt = wiggle(5, 80);') }),
  ];
  return d;
}
function nested() {
  const d = base('pc-extra-nested');
  d.assets = [
    { id: 'inner', layers: [
      shape(1, 'in-random', [150, 100, 0], { p: expr([150, 100, 0], 'var $bm_rt;\n$bm_rt = [random(40, 260), random(30, 170), 0];') }, [0.37, 0.55, 1, 1]),
      shape(2, 'in-wiggle', [150, 100, 0], { p: expr([150, 100, 0], 'var $bm_rt;\n$bm_rt = wiggle(5, 40);'), s: st([40, 40, 100]) }, [1, 0.5, 0.3, 1]),
    ] },
    { id: 'mid', layers: [precomp(1, 'mid-a', 'inner', [0, 0, 0], 300, 200), precomp(2, 'mid-b', 'inner', [320, 0, 0], 300, 200), precomp(3, 'mid-c', 'inner', [0, 220, 0], 300, 200)] },
    { id: 'outer', layers: [precomp(1, 'outer-a', 'mid', [0, 0, 0], 640, 440), precomp(2, 'outer-b', 'mid', [660, 0, 0], 640, 440)] },
  ];
  d.layers = [precomp(1, 'root-a', 'outer', [20, 20, 0], 1320, 440), precomp(2, 'root-b', 'outer', [20, 520, 0], 1320, 440), precomp(3, 'root-mid', 'mid', [1380, 20, 0], 640, 440)];
  return d;
}
const FONT_FILE = ['C:/Windows/Fonts/arial.ttf', '/System/Library/Fonts/Supplemental/Arial.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'].find((f) => fs.existsSync(f)) ?? null;
function netfont() {
  const src = JSON.parse(fs.readFileSync(path.join(FIX, 'text-random.json'), 'utf8'));
  const d = base('pc-extra-netfont', { fonts: { list: [{ fName: 'PcNetFont', fFamily: 'PcNetFont', fStyle: 'Regular', fPath: '/lottie-data/font.ttf', fOrigin: 'p', ascent: 75 }] } });
  const l = JSON.parse(JSON.stringify(src.layers[0]));
  l.nm = 'net-text'; l.ln = 'net-text';
  l.t.d.k = [{ s: { ...l.t.d.k[0].s, f: 'PcNetFont', t: 'LOTTIE SEED' }, t: 0 }, { s: { ...l.t.d.k[0].s, f: 'PcNetFont', t: 'SEED LOTTIE' }, t: 30 }];
  d.layers = [l, shape(2, 'beside', [1400, 700, 0], { p: expr([1400, 700, 0], 'var $bm_rt;\n$bm_rt = [random(900, 1700), 700, 0];') })];
  return d;
}
function big(layersPerComp = 150, copies = 30) {
  const d = base('pc-extra-big');
  d.assets = [{ id: 'heavy', layers: Array.from({ length: layersPerComp }, (_, i) => shape(i + 1, `h${i}`, [20 + (i % 15) * 20, 20 + Math.floor(i / 15) * 20, 0], { p: expr([0, 0, 0], `var $bm_rt;\n$bm_rt = [random(0, 300), random(0, 200), 0];`), s: st([10, 10, 100]) })) }];
  d.layers = Array.from({ length: copies }, (_, i) => precomp(i + 1, `copy${i}`, 'heavy', [(i % 6) * 310, Math.floor(i / 6) * 210, 0], 300, 200));
  return d;
}
const CASES = {
  posterize: { data: posterize, picks: [0, 1, 5, 6, 7, 8, 14, 15, 29, 30, 44, 59] },
  crossread: { data: crossread, picks: [0, 1, 7, 15, 16, 30, 31, 45, 59] },
  globalbypass: { data: globalbypass, picks: [0, 1, 9, 10, 25, 40, 59] },
  textexpr: { data: textexpr, picks: [0, 1, 14, 15, 16, 20, 30, 35, 36, 40, 45, 59] },
  nested: { data: nested, picks: [0, 1, 12, 13, 30, 47, 59] },
  netfont: { data: netfont, picks: [0, 1, 15, 29, 30, 31, 45, 59], asyncLoad: true },
};
const fixtureText = (name) => fs.readFileSync(name === 'fixture' ? path.join(FIX, 'expr-layers.json') : name === 'exprcases' ? path.join(FIX, 'expr-cases.json') : name === 'textrandom' ? path.join(FIX, 'text-random.json') : path.join(CATALOG, `${name}.json`), 'utf8');

// ── In-page execution half (shared between dev build and production build) ──
const PIN_ID = 'virtual:lottie-extra-pin', ENTRY_ID = 'virtual:lottie-extra-entry';
const PIN_SOURCE = `import { installPinnedEntropy } from ${JSON.stringify(fsPath('src/kernel/pinEntropy.ts'))};\n// Same as the product: install the random-number pin before the playback library loads\ninstallPinnedEntropy();\n`;
const ENTRY_SOURCE = `import ${JSON.stringify(PIN_ID)};
import * as card from ${JSON.stringify(fsPath('src/cards/native/lottie.tsx'))};
const OFF = { seed: false, exact: false, expr: false };
const made = new Map(); let nextId = 1;
const normalize = (s) => { const ids = new Map(); return s.replace(/__lottie_element_\\d+/g, (m) => { if (!ids.has(m)) ids.set(m, 'E' + ids.size); return ids.get(m); }); };
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
  const refsOf = (el, into) => { for (const node of [el, ...el.querySelectorAll('*')]) for (const a of node.attributes) { for (const m of a.value.matchAll(/url\\(["']?#([^)"']+)["']?\\)/g)) into.add(m[1]); if (a.localName === 'href' && a.value.startsWith('#')) into.add(a.value.slice(1)); } };
  const byId = new Map(); for (const el of copy.querySelectorAll('[id]')) byId.set(el.getAttribute('id'), el);
  const used = new Set(); const pending = new Set();
  for (const child of copy.children) if (child.localName !== 'defs') refsOf(child, pending);
  while (pending.size) { const id = pending.values().next().value; pending.delete(id); if (used.has(id)) continue; used.add(id); const el = byId.get(id); if (el) { const more = new Set(); refsOf(el, more); for (const x of more) if (!used.has(x)) pending.add(x); } }
  for (const defs of copy.querySelectorAll('defs')) for (const res of [...defs.children]) { const ids = [res, ...res.querySelectorAll('[id]')].map((el) => el.getAttribute('id')).filter(Boolean); if (!ids.some((id) => used.has(id))) res.remove(); }
  return normalize(new XMLSerializer().serializeToString(copy));
};
const svgText = (root) => { const svg = root.querySelector('svg'); return svg ? { r: normalize(new XMLSerializer().serializeToString(svg)), v: visible(svg) } : { r: '', v: '' }; };
const loaded = (anim) => anim.isLoaded ? Promise.resolve() : new Promise((resolve, reject) => { anim.addEventListener('DOMLoaded', resolve); anim.addEventListener('data_failed', () => reject(new Error('data_failed'))); });
const median = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
const api = {
  /** Build one. When off is true all three switches are off; otherwise pass no options and use the card defaults (the official set) */
  async make(text, off) {
    const data = JSON.parse(text);
    const box = document.createElement('div'); box.className = 'box'; document.body.appendChild(box);
    const errors = [];
    const t0 = performance.now();
    const handle = off ? card.loadLottie(box, data, 'contain', OFF) : card.loadLottie(box, data, 'contain');
    handle.anim.addEventListener('error', (e) => errors.push(String(e?.nativeError?.message ?? e?.type ?? e)));
    const asyncLoad = !handle.anim.isLoaded;
    await loaded(handle.anim);
    const id = nextId++; made.set(id, { handle, box, errors });
    return { id, asyncLoad, seed: handle.seed, exact: handle.exact, rewritten: handle.rewritten, buildMs: +(performance.now() - t0).toFixed(1) };
  },
  errors(id) { return made.get(id).errors; },
  goTo(id, frame) { made.get(id).handle.goTo(frame); },
  jump(id, frame) { const m = made.get(id); m.handle.goTo(frame); return svgText(m.box); },
  seq(id, frames, picks) { const m = made.get(id); const want = new Set(picks); const out = {}; for (const f of frames) { m.handle.goTo(f); if (want.has(f)) out[f] = svgText(m.box); } return out; },
  hide(id) { made.get(id).box.style.display = 'none'; },
  destroy(id) { const m = made.get(id); m.handle.anim.destroy(); m.box.remove(); made.delete(id); },
  burn(n) { let last = 0; for (let i = 0; i < n; i++) last = Math.random(); return last; },
  switches: () => ({ seed: card.lottieSeedEnabled(), exact: card.lottieExactEnabled(), expr: card.lottieExprEnabled() }),
  /** Jump to each frame in frames in turn and read the translation and opacity of each layer (the <g> elements with an id, in document order): { frame: [[layer name, x, y, opacity], …] } */
  readLayers(id, frames) {
    const m = made.get(id); const out = {};
    for (const f of frames) {
      m.handle.goTo(f); const rows = [];
      for (const g of m.box.querySelectorAll('svg g[id]')) { const t = /matrix\\(([^)]+)\\)/.exec(g.getAttribute('transform') || ''); const n = t ? t[1].split(',').map(Number) : [1, 0, 0, 1, 0, 0]; rows.push([g.id, n[4], n[5], Number(g.getAttribute('opacity') ?? 1)]); }
      out[f] = rows;
    }
    return out;
  },
  async pixelDiff(a, b) {
    const W = 1920, H = 1080; const canvas = new OffscreenCanvas(W, H); const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const px = async (s) => { const doc = new DOMParser().parseFromString(s, 'image/svg+xml').documentElement; doc.setAttribute('width', String(W)); doc.setAttribute('height', String(H)); const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(doc)], { type: 'image/svg+xml' })); try { const img = new Image(); img.src = url; await img.decode(); ctx.clearRect(0, 0, W, H); ctx.drawImage(img, 0, 0, W, H); } finally { URL.revokeObjectURL(url); } return ctx.getImageData(0, 0, W, H).data.slice(); };
    const pa = await px(a), pb = await px(b); let count = 0, max = 0;
    for (let i = 0; i < pa.length; i += 4) { const d = Math.max(Math.abs(pa[i] - pb[i]), Math.abs(pa[i + 1] - pb[i + 1]), Math.abs(pa[i + 2] - pb[i + 2]), Math.abs(pa[i + 3] - pb[i + 3])); if (d) { count++; if (d > max) max = d; } }
    return { pixels: count, pct: +(100 * count / (W * H)).toFixed(4), max };
  },
  /** Big asset: how long rewriting the expressions alone takes (including copying compositions) and how large the data is before and after the rewrite; then build one of each and measure time and heap memory */
  async bigCost(text) {
    const heap = () => (performance.memory ? performance.memory.usedJSHeapSize : null);
    const gc = () => { if (typeof globalThis.gc === 'function') globalThis.gc(); };
    const data = JSON.parse(text);
    const seed = card.lottieSeedOf(data);
    const t0 = performance.now();
    const rewritten = card.rewriteLottieExpressions(data, seed);
    const rewriteMs = performance.now() - t0;
    const after = JSON.stringify(data).length;
    const one = async (off) => {
      gc(); const h0 = heap();
      const box = document.createElement('div'); box.className = 'box'; document.body.appendChild(box);
      const t1 = performance.now();
      const handle = off ? card.loadLottie(box, JSON.parse(text), 'contain', OFF) : card.loadLottie(box, JSON.parse(text), 'contain');
      await loaded(handle.anim);
      const buildMs = performance.now() - t1;
      const t2 = performance.now(); for (let f = 0; f < 30; f++) handle.goTo(f); const frameMs = (performance.now() - t2) / 30;
      gc(); const h1 = heap();
      const nodes = box.querySelectorAll('*').length;
      handle.anim.destroy(); box.remove();
      return { buildMs: +buildMs.toFixed(1), frameMs: +frameMs.toFixed(2), heapMB: h0 === null ? null : +((h1 - h0) / 1048576).toFixed(1), nodes };
    };
    const off = await one(true), on = await one(false);
    return { textKB: Math.round(text.length / 1024), afterKB: Math.round(after / 1024), rewritten, rewriteMs: +rewriteMs.toFixed(1), off, on };
  },
  /** Time a frame on the spot: the sync time of jumping one frame (3 passes over the full length, taking the median per frame and the slowest frame), and the time of "jump one frame and wait for the browser to render a frame" */
  async timing(text) {
    const data = JSON.parse(text); const total = Math.max(1, (Number(data.op) || 0) - (Number(data.ip) || 0));
    const box = document.createElement('div'); box.className = 'box'; document.body.appendChild(box);
    const t0 = performance.now();
    const handle = card.loadLottie(box, data, 'contain');
    await loaded(handle.anim);
    const buildMs = performance.now() - t0;
    const per = [];
    for (let r = 0; r < 3; r++) { handle.goTo(total - 1); for (let f = 0; f < total; f++) { const t1 = performance.now(); handle.goTo(f); per.push(performance.now() - t1); } }
    // Direct jumps (non-adjacent frames): the step is about 0.37 times the full length
    const hop = []; const step = Math.max(2, Math.floor(total * 0.37));
    for (let i = 0, f = 0; i < total; i++) { f = (f + step) % total; const t1 = performance.now(); handle.goTo(f); hop.push(performance.now() - t1); }
    await nextFrame();
    const t2 = performance.now();
    for (let f = 0; f < total; f++) { handle.goTo(f); await nextFrame(); }
    const shown = (performance.now() - t2) / total;
    handle.anim.destroy(); box.remove();
    const p = (xs, q) => xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * q))];
    return { total, buildMs: +buildMs.toFixed(1), syncMedian: +median(per).toFixed(3), syncP95: +p(per, 0.95).toFixed(3), syncMax: +Math.max(...per).toFixed(3), hopMedian: +median(hop).toFixed(3), hopMax: +Math.max(...hop).toFixed(3), shownPerFrame: +shown.toFixed(2) };
  },
};
window.api = api; window.ready = true;
`;
const PAGE_STYLE = '<style>html,body{margin:0;background:#111;overflow:hidden}.box{position:absolute;left:0;top:0;width:1920px;height:1080px}</style>';
const HARNESS = `<!doctype html><meta charset="utf-8">${PAGE_STYLE}<script type="module">import ${JSON.stringify(ENTRY_ID)};</script>`;
const virtual = {
  name: 'lottie-extra-virtual', enforce: 'pre',
  resolveId(id) { if (id === PIN_ID || id === ENTRY_ID) return `\0${id}`; },
  load(id) { if (id === `\0${PIN_ID}`) return PIN_SOURCE; if (id === `\0${ENTRY_ID}`) return ENTRY_SOURCE; },
};
const serveData = (url, res) => {
  const m = /^\/lottie-data\/([a-z0-9.]+)$/.exec(url.pathname);
  if (!m) return false;
  if (m[1] === 'font.ttf' && FONT_FILE) { res.setHeader('content-type', 'font/ttf'); res.end(fs.readFileSync(FONT_FILE)); return true; }
  return false;
};
const devPlugin = {
  name: 'lottie-extra-dev',
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      const url = new URL(req.url, 'http://x');
      res.setHeader('cache-control', 'no-store');
      if (url.pathname === '/favicon.ico') { res.statusCode = 204; res.end(); return; }
      if (url.pathname === '/harness') { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(await server.transformIndexHtml('/harness', HARNESS)); return; }
      if (serveData(url, res)) return;
      next();
    });
  },
};

const report = { when: new Date().toISOString(), host: { cpu: os.cpus()[0]?.model?.trim(), logicalCores: os.cpus().length }, out: OUT, cases: {}, pageErrors: [], notRun: [], fails: [] };
const fail = (msg) => { report.fails.push(msg); console.log(`FAIL ${msg}`); };

const vite = await createServer({
  root: ROOT, configFile: false, plugins: [virtual, devPlugin], logLevel: 'error', appType: 'custom',
  cacheDir: path.join(os.tmpdir(), 'pc-lottie-seed-extra-probe-vite'),
  optimizeDeps: { include: ['lottie-web'] },
  server: { host: '127.0.0.1', port: PORT, strictPort: true, hmr: false, watch: null },
});
await vite.listen();
let browser = null, staticServer = null;
const t0 = Date.now();
try {
  browser = await puppeteer.launch({ headless: true, protocolTimeout: 900000, args: [...PROBE_CHROME_ARGS, '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1', '--enable-precise-memory-info', '--js-flags=--expose-gc'] });
  report.chrome = await browser.version();
  report.lottieWeb = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.resolve('lottie-web'))), '..', '..', 'package.json'), 'utf8')).version;
  const opener = (origin) => async () => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
    page.on('pageerror', (e) => report.pageErrors.push(String(e?.message ?? e).slice(0, 300)));
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warn') report.pageErrors.push(`console.${m.type()}: ${m.text().slice(0, 300)}`); });
    await page.goto(`${origin}/harness`, { waitUntil: 'load' });
    await page.waitForFunction('window.ready === true', { timeout: 120000 });
    return page;
  };
  const openDev = opener(`http://127.0.0.1:${PORT}`);
  const call = (page, fn, ...args) => page.evaluate((f, a) => window.api[f](...a), fn, args);
  const tool = await openDev();
  const pixelDiff = (a, b) => call(tool, 'pixelDiff', a, b);
  const otherLottie = fixtureText('fixture');

  /** Six frames: returns { shots, perN, same (count of Ns where all copies are identical) } */
  const sixWay = async (open, text, picks, off) => {
    const maxPick = Math.max(...picks);
    const frames = Array.from({ length: maxPick + 1 }, (_, i) => i);
    const total = (() => { const d = JSON.parse(text); return Math.max(1, (Number(d.op) || 0) - (Number(d.ip) || 0)); })();
    const all = Array.from({ length: total }, (_, i) => i);
    const shots = {};
    const p1 = await open();
    const first = await call(p1, 'make', text, off);
    shots['sequential'] = await call(p1, 'seq', first.id, frames, picks);
    await call(p1, 'seq', first.id, all, []);
    shots['jump back'] = {};
    for (const n of picks) { await call(p1, 'goTo', first.id, 0); shots['jump back'][n] = await call(p1, 'jump', first.id, n); }
    const errors = await call(p1, 'errors', first.id);
    await call(p1, 'hide', first.id);
    shots['new in same page'] = {};
    for (const n of picks) { const m = await call(p1, 'make', text, off); shots['new in same page'][n] = await call(p1, 'jump', m.id, n); await call(p1, 'destroy', m.id); }
    await p1.close();
    shots['new in new page'] = {}; shots['other card first'] = {}; shots['other Lottie first'] = {};
    for (const n of picks) {
      let p = await open(); let m = await call(p, 'make', text, off); shots['new in new page'][n] = await call(p, 'jump', m.id, n); await p.close();
      p = await open(); await call(p, 'burn', 13); m = await call(p, 'make', text, off); shots['other card first'][n] = await call(p, 'jump', m.id, n); await p.close();
      p = await open(); const other = await call(p, 'make', otherLottie, true); await call(p, 'seq', other.id, [0, 1, 2, 3, 22, 23, 45], []); await call(p, 'hide', other.id);
      m = await call(p, 'make', text, off); shots['other Lottie first'][n] = await call(p, 'jump', m.id, n); await p.close();
    }
    const perN = {}; let same = 0;
    for (const n of picks) {
      const baseShot = shots['sequential'][n]; const differ = {};
      for (const kind of Object.keys(shots)) {
        if (kind === 'sequential') continue;
        const other = shots[kind][n];
        if (other.r === baseShot.r) continue;
        if (other.v === baseShot.v && (await pixelDiff(baseShot.r, other.r)).pixels === 0) continue;
        differ[kind] = other.v === baseShot.v ? 'visible text same, pixels differ' : 'visible text differs';
      }
      perN[n] = { hash: sha(baseShot.v), differ };
      if (!Object.keys(differ).length) same++;
    }
    return { first, errors, perN, same, of: picks.length };
  };
  const badNs = (r) => Object.entries(r.perN).filter(([, v]) => Object.keys(v.differ).length).map(([n, v]) => `frame ${n} (${Object.keys(v.differ).join(', ')})`).join(';');

  // ── Six asset types ──
  for (const [name, spec] of Object.entries(CASES)) {
    if (!want(name)) continue;
    if (name === 'netfont' && !FONT_FILE) { report.notRun.push('netfont: no font file that can be served as a web font was found on this machine'); console.log('netfont: not run (font file not found)'); continue; }
    const text = JSON.stringify(spec.data());
    const on = await sixWay(openDev, text, spec.picks, false);
    const off = await sixWay(openDev, text, spec.picks, true);
    const entry = { picks: spec.picks, on: { same: on.same, of: on.of, perN: on.perN, rewritten: on.first.rewritten, exact: on.first.exact, asyncLoad: on.first.asyncLoad, errors: on.errors }, off: { same: off.same, of: off.of, errors: off.errors } };
    report.cases[name] = entry;
    console.log(`${name}: on (default), out of ${on.of} N values ${on.same} have the same image across all six copies; all three switches off ${off.same}/${off.of}; ${on.first.rewritten} expressions rewritten; at instance creation ${on.first.asyncLoad ? 'not loaded yet' : 'already loaded'}; expression errors: on ${on.errors.length}, off ${off.errors.length}${on.errors.length ? `(${on.errors[0]})` : ''}`);
    if (on.same !== on.of) fail(`${name}: with the switches on, the six copies differ for some N values: ${badNs(on)}`);
    if (on.first.exact !== true) fail(`${name}: "no stale property values" should be on by default, got ${on.first.exact}`);
    if (!(on.first.rewritten > 0)) fail(`${name}: expressions should be rewritten by default, got ${on.first.rewritten}`);
    if (spec.asyncLoad && !on.first.asyncLoad) fail(`${name}: the instance was already loaded right after creation, async loading was not observed`);
    if (on.errors.length !== off.errors.length) fail(`${name}: expression error count is ${on.errors.length} with the switches on and ${off.errors.length} with them off, should be equal`);

    // Supplementary checks specific to each asset
    const frames = Array.from({ length: 16 }, (_, i) => i);
    const read = async (isOff) => { const p = await openDev(); const m = await call(p, 'make', text, isOff); const rows = await call(p, 'readLayers', m.id, frames); await p.close(); return rows; };
    const colOf = (rows, layer, k) => frames.map((f) => (rows[f].find((r) => r[0] === layer) ?? [])[k]);
    const distinct = (xs) => new Set(xs.map((x) => (typeof x === 'number' ? x.toFixed(3) : String(x)))).size;
    if (name === 'posterize') {
      const a = await read(false), b = await read(true);
      // Visual control (report only): random after posterizeTime(4), how many distinct numbers are
      // sampled in frames 0-15; how many distinct opacities for posterizeTime(3) plus seedRandom(5, true)
      entry.look = { on: { random: distinct(colOf(a, 'post-random', 1)), seeded: distinct(colOf(a, 'post-seeded', 3)), wiggle: distinct(colOf(a, 'post-wiggle', 1)) }, off: { random: distinct(colOf(b, 'post-random', 1)), seeded: distinct(colOf(b, 'post-seeded', 3)), wiggle: distinct(colOf(b, 'post-wiggle', 1)) } };
      console.log(`posterize / number of distinct values over frames 0-15 (on vs off): random after posterizeTime(4) ${entry.look.on.random} vs ${entry.look.off.random}; opacity with posterizeTime(3) plus seedRandom ${entry.look.on.seeded} vs ${entry.look.off.seeded}; wiggle after posterizeTime(5) ${entry.look.on.wiggle} vs ${entry.look.off.wiggle}`);
      if (entry.look.on.seeded !== entry.look.off.seeded) fail(`posterize: for the layer with posterizeTime plus seedRandom, the number of distinct values is ${entry.look.on.seeded} with the switches on and ${entry.look.off.seeded} with them off, so the look changed`);
      if ((entry.look.on.random > 1) !== (entry.look.off.random > 1)) fail('posterize: whether random after posterizeTime varies with the frame differs between switches on and off');
    }
    if (name === 'globalbypass') {
      const a = await read(false), again = await read(false);
      entry.varies = { math: distinct(colOf(a, 'global-math', 1)), crypto: distinct(colOf(a, 'global-crypto', 1)), repeat: JSON.stringify(a) === JSON.stringify(again) };
      console.log(`globalbypass / number of distinct values over frames 0-15: globalThis.Math.random ${entry.varies.math}, globalThis.crypto ${entry.varies.crypto}; what the two new pages read: ${entry.varies.repeat ? 'same' : 'different'}`);
      if (!(entry.varies.math > 8 && entry.varies.crypto > 8)) fail(`globalbypass: random numbers fetched through the bypass should vary by frame (random numbers were really obtained), got ${JSON.stringify(entry.varies)}`);
      if (!entry.varies.repeat) fail('globalbypass: the two new pages read different numbers');
    }
    if (name === 'nested') {
      const a = await read(false), b = await read(true);
      // Total copies placed on innermost layer, and how many have pairwise distinct positions at
      // frame 13
      const copiesAt = (rows, f, layer) => rows[f].filter((r) => r[0] === layer).map((r) => `${r[1].toFixed(2)},${r[2].toFixed(2)}`);
      const on13 = copiesAt(a, 13, 'in-random'), off13 = copiesAt(b, 13, 'in-random'), onW = copiesAt(a, 13, 'in-wiggle');
      entry.copies = { count: on13.length, distinctOn: new Set(on13).size, distinctOff: new Set(off13).size, wiggleDistinctOn: new Set(onW).size };
      console.log(`nested / the innermost layer with random was placed in ${on13.length} copies; at frame 13 the copies with pairwise different positions: ${entry.copies.distinctOn} on, ${entry.copies.distinctOff} off; for the layer with wiggle, ${entry.copies.wiggleDistinctOn} copies are pairwise different when on; ${on.first.rewritten} expressions rewritten after copying the composition`);
      if (on13.length !== 15) fail(`nested: the innermost layer should be placed in 15 copies, got ${on13.length}`);
      if (entry.copies.distinctOn !== on13.length || entry.copies.wiggleDistinctOn !== on13.length) fail(`nested: each copy should move independently, but out of ${on13.length} copies only ${entry.copies.distinctOn} differ for random and ${entry.copies.wiggleDistinctOn} for wiggle`);
      if (on.first.rewritten !== 30) fail(`nested: 15 copies with 2 expressions each should rewrite 30 expressions, got ${on.first.rewritten}`);
    }
    if (name === 'textexpr') {
      // Text content was indeed replaced by expression: layer 1 frames at 0, 16, and 40 are mutually
      // distinct
      const hs = [0, 16, 40].map((f) => on.perN[f].hash);
      entry.textChanges = new Set(hs).size;
      if (entry.textChanges !== 3) fail(`textexpr: the expression should change the text at frames 15 and 36; frames 0, 16 and 40 show only ${entry.textChanges} distinct images`);
    }
  }

  // ── Production build ──
  if (want('build') && !flag('--skip-build')) {
    const dist = path.join(OUT, 'build');
    fs.rmSync(dist, { recursive: true, force: true });
    const started = Date.now();
    const result = await build({ root: ROOT, configFile: false, plugins: [virtual], logLevel: 'error', build: { outDir: dist, emptyOutDir: true, write: true, copyPublicDir: false, rollupOptions: { input: ENTRY_ID } } });
    const outputs = (Array.isArray(result) ? result : [result]).flatMap((r) => r.output ?? []);
    const entryChunk = outputs.find((o) => o.type === 'chunk' && o.isEntry);
    if (!entryChunk) throw new Error('The production build produced no entry');
    const minified = entryChunk.code.split('\n').length < 400;
    const SPORT = PORT + 1;
    staticServer = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://x');
      res.setHeader('cache-control', 'no-store');
      if (url.pathname === '/favicon.ico') { res.statusCode = 204; res.end(); return; }
      if (url.pathname === '/harness') { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(`<!doctype html><meta charset="utf-8">${PAGE_STYLE}<script type="module" src="/${entryChunk.fileName}"></script>`); return; }
      if (serveData(url, res)) return;
      const file = path.join(dist, decodeURIComponent(url.pathname));
      if (file.startsWith(dist) && fs.existsSync(file) && fs.statSync(file).isFile()) { res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream'); res.end(fs.readFileSync(file)); return; }
      res.statusCode = 404; res.end();
    });
    await new Promise((resolve, reject) => { staticServer.once('error', reject); staticServer.listen(SPORT, '127.0.0.1', resolve); });
    const openProd = opener(`http://127.0.0.1:${SPORT}`);
    const section = { buildSeconds: +((Date.now() - started) / 1000).toFixed(1), entry: entryChunk.fileName, entryKB: Math.round(entryChunk.code.length / 1024), minified, assets: {} };
    report.build = section;
    if (!minified) fail('Production build: the entry was not minified (too many lines), minified code was not tested');
    const p0 = await openProd(); section.switches = await call(p0, 'switches'); await p0.close();
    if (!(section.switches.seed === false && section.switches.exact === true && section.switches.expr === true)) fail(`Production build: the default switches should be off/on/on, got ${JSON.stringify(section.switches)}`);
    const list = [['fixture', fixtureText('fixture'), [0, 9, 21, 41, 59]], ['exprcases', fixtureText('exprcases'), [0, 18, 30, 37, 59]], ['textrandom', fixtureText('textrandom'), [0, 15, 31, 40, 45]], ['nested', JSON.stringify(nested()), [0, 13, 30, 59]], ['textexpr', JSON.stringify(textexpr()), [0, 14, 20, 40, 45]], ['globalbypass', JSON.stringify(globalbypass()), [0, 1, 25, 59]], ['happy2016', fixtureText('happy2016'), [0, 49, 68, 98]]];
    for (const [name, text, picks] of list) {
      const prod = await sixWay(openProd, text, picks, false);
      // Identical frames in dev build: open new page and jump directly
      let sameAsDev = 0;
      for (const n of picks) { const p = await openDev(); const m = await call(p, 'make', text, false); const shot = await call(p, 'jump', m.id, n); await p.close(); if (sha(shot.v) === prod.perN[n].hash) sameAsDev++; }
      section.assets[name] = { same: prod.same, of: prod.of, sameAsDev, rewritten: prod.first.rewritten, exact: prod.first.exact };
      console.log(`Production build / ${name}: out of ${prod.of} N values ${prod.same} have the same image across all six copies; same as the dev build's direct jump ${sameAsDev}/${picks.length}; ${prod.first.rewritten} expressions rewritten; no stale property values ${prod.first.exact ? 'applied' : 'not applied'}`);
      if (prod.same !== prod.of) fail(`Production build / ${name}: the six copies differ for some N values: ${badNs(prod)}`);
      if (sameAsDev !== picks.length) fail(`Production build / ${name}: out of ${picks.length} N values only ${sameAsDev} have the same image as the dev build`);
      if (prod.first.exact !== true) fail(`Production build / ${name}: "no stale property values" was not applied`);
    }
    console.log(`Production build: took ${section.buildSeconds} s, entry ${section.entryKB} KB (${minified ? 'minified' : 'not minified'}), default switches ${JSON.stringify(section.switches)}`);
  }

  // ── Large assets ──
  if (want('big') && !flag('--skip-big')) {
    const p = await openDev();
    report.big = await call(p, 'bigCost', JSON.stringify(big()));
    await p.close();
    const b = report.big;
    console.log(`Big asset (a 150-layer composition placed in 30 copies, 4500 expressions with random; record only): asset ${b.textKB} KB, ${b.afterKB} KB after rewriting and copying compositions, ${b.rewritten} rewrites took ${b.rewriteMs} ms; build one: off ${b.off.buildMs} ms / on ${b.on.buildMs} ms; jump one frame: off ${b.off.frameMs} / on ${b.on.frameMs} ms; extra heap after the build: off ${b.off.heapMB} MB / on ${b.on.heapMB} MB; ${b.on.nodes} nodes`);
  }

  // ── How long it takes to compute one frame on the fly ──
  if (want('timing') && !flag('--skip-timing')) {
    report.timing = {};
    for (const rate of [1, 4]) {
      report.timing[`x${rate}`] = {};
      for (const name of BUNDLED) {
        const p = await openDev();
        await p.emulateCPUThrottling(rate);
        const r = await call(p, 'timing', fixtureText(name));
        await p.close();
        report.timing[`x${rate}`][name] = r;
        console.log(`Timing / main thread ${rate === 1 ? 'not slowed down' : `slowed down ${rate}x`} / ${name} (${r.total} frames): build one ${r.buildMs} ms; jump one frame sequentially: median ${r.syncMedian}, 95% ${r.syncP95}, slowest ${r.syncMax} ms; jump one frame non-adjacently: median ${r.hopMedian}, slowest ${r.hopMax} ms; jump one frame and wait for the browser to render a frame: mean ${r.shownPerFrame} ms`);
      }
    }
  }
  await tool.close();
  if (report.pageErrors.length) fail(`${report.pageErrors.length} page errors or warnings: ${report.pageErrors.slice(0, 3).join(' | ')}`);
} catch (e) {
  fail(`Probe itself failed: ${String(e?.stack ?? e).slice(0, 800)}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  await vite.close().catch(() => {});
  if (staticServer) await new Promise((resolve) => staticServer.close(resolve));
}
report.ms = Date.now() - t0;
fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(report, null, 2));
console.log(`Machine: ${report.host.cpu}, ${report.host.logicalCores} logical cores; ${report.chrome}; lottie-web ${report.lottieWeb}; took ${(report.ms / 1000).toFixed(1)} s; result ${path.join(OUT, 'result.json')}`);
for (const n of report.notRun) console.log(`Not run: ${n}`);
console.log(JSON.stringify({ ok: report.fails.length === 0, fails: report.fails }));
process.exitCode = report.fails.length ? 1 : 0;
