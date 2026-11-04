/**
 * Probe: Lottie "override random seed": whether jumping directly to frame N produces the same
 * frame as advancing sequentially from the beginning to frame N.
 * Source: `docs/plan/render-refactor-task.md` "Gui: convert Lottie to remotion-style", "A point to
 * note"; (user on 2026-10-12: "I think we can override the random seed.").
 * On the same day, user suggested another approach: "Can we override directly by replacement, such
 * as replacing random with random_in_card()?", which is switch 3 below.
 * Implementation in `src/cards/native/lottie.tsx` (`loadLottie`) and
 * `src/kernel/pinEntropy.ts` (`withSeededRandom`).
 * After render refactor "Gui" is merged, the official set (switch 3, outer layer, switch 2) is
 * enabled by default, and switch 1 is disabled by default; this probe still tests all five
 * configuration modes, with configuration mode explicitly specified by the probe (passing mode
 * when calling `loadLottie` directly, appending `lottieExpr=0` etc. to the page URL when mounting
 * real cards), not relying on defaults.
 * **Run this probe and `lottie-seed-extra-probe.mjs` before upgrading player library
 * (lottie-web)**: if the version differs from the verified one below, this probe fails
 * immediately; update `LOTTIE_WEB_VERIFIED` to the new version number after the rerun passes.
 *
 *   node scripts/probes/lottie-seed-probe.mjs [--port 27601] [--assets fixture,fixtureasync,fixtureip,exprcases,textrandom,adrock,bodymovin,gatin,happy2016,navidad]
 *        [--out <dir>]        Save result.json and SVG text of mismatched frames (defaults to system temp dir)
 *        [--before 7e7ae968]  Which commit's lottie.tsx to use as pre-change for "switches off matches pre-change"
 *        [--skip-sweep]       Skip the "full length frame-by-frame, compare on vs off" check (slowest)
 *
 * Method: Start a Vite instance serving only this probe (root is this workspace, does not read
 * project Vite config, occupies only the single port --port), install the same PRNG pin
 * (`installPinnedEntropy`) in real Chrome as in production, and create instances using the card's
 * own `loadLottie`. Each frame is compared on three aspects:
 *   Raw text         SVG serialized text, renumbering node IDs issued by the player page-wide
 *                    counter (`__lottie_element_N`) by order of appearance. It even compares stale
 *                    attributes on **invisible layers**: the player hides a layer simply by adding
 *                    `display: none`, retaining its position and opacity from its last visible
 *                    frame, while never-displayed layers have no attributes at all. Therefore,
 *                    whether raw text matches depends on the frame advance path; this item is
 *                    reported only.
 *   Visible          Same text with contents and attributes of `display: none` nodes stripped,
 *                    unreferenced items in `<defs>` removed (layer mask paths live in `<defs>` and
 *                    leave stale paths after layer is hidden), and attributes sorted by name.
 *                    Compared byte by byte.
 *   Pixels           Two copies with different raw text are converted to 1920×1080 pixels; count
 *                    differing pixels.
 * "Identical" means visible text is byte-for-byte identical, and pixels are identical one by one.
 *
 * Assets: `fixture` is `scripts/probes/fixtures/lottie-seed/expr-layers.json`: handwritten test
 * Lottie with layer in points at 0, 10, 20, 25, 30, and 40, using random(), wiggle() only, and
 * seedRandom()+random() respectively to drive position, opacity, rotation, and scale, two of which
 * are inside nested compositions.
 * `fixtureasync` is the same asset with an external data asset attached (created on the fly by the
 * probe, not saved to disk): the player library waits for it to be retrieved before creating
 * layers, following the path where "loading finishes in a timer callback".
 * `fixtureip` is the same asset with start point changed to frame 22 (created on the fly by the
 * probe): the card's frame 0 falls on frame 22 of the composition, where the two wiggle()-only
 * layers are already present and the nested layer with random has not entered yet: frame 0 drawn
 * by the player library upon loading completion must match the frame redrawn when jumping back to
 * frame 0 later.
 * `exprcases` is `scripts/probes/fixtures/lottie-seed/expr-cases.json`: another handwritten asset
 * with one expression test case per layer: calling random() twice in one expression, writing
 * Math.random() in an expression, declaring local variables and functions with matching names in an
 * expression, wiggle() only, seedRandom(7, true), seedRandom(7), two other calling forms of
 * random, two layers to check "whether this.pv used by wiggle and value received by expression are
 * the same thing", and a nested composition with random expressions instantiated twice (the two
 * copies should animate independently).
 * `textrandom` is `scripts/probes/fixtures/lottie-seed/text-random.json`: three text layers, all
 * using "random order" animators (where player library calls page-wide `Math.random()` directly,
 * without going through expressions). Glyphs are self-drawn rectangles without font files. Text
 * contents on two layers have keyframes (changed at frames 30 and 40), and one does not. It also
 * runs two additional configuration modes for control only: "replace without outer wrapper" and
 * "replace with outer wrapper seeded per frame but without fixing text separately".
 * The rest are the 5 built-in assets.
 *
 * Run each of the five configuration modes once: "off" has all three switches off (status quo);
 * "seed" enables switch 1 only (seeds the player's internal sequence); "seed + no stale values"
 * enables switch 1 plus switch 2; "replace" enables switch 3 only (rewrites expressions, replacing
 * random functions with the card's own); "replace + no stale values" enables switch 3 plus
 * switch 2. For each N, capture these frames:
 *   Sequential advance   Open new page, create instance, advance frame by frame from frame 0 to
 *                        frame N
 *   Jump back            After advancing instance through full length, return to frame 0 and jump
 *                        directly to frame N
 *   New on same page     Create another instance on the same page, jump directly to frame N
 *   New on new page      Open new page, create instance, jump directly to frame N
 *   Other card first     Open new page, call Math.random 13 times first, create instance and jump
 *                        directly (sampled for 3 Ns only)
 *   Other Lottie first   Open new page, create Lottie with random expressions, advance a few
 *                        frames, then create instance and jump directly (sampled for 3 Ns only)
 *   Two in succession    Create two instances consecutively on the same page, both jumping
 *                        directly to the same frame (sampled for 1 N only)
 *
 * Additionally:
 *   Full-length frame-by-frame  Sequentially advance through full length under the four enabled
 *                               modes, compare frame by frame with "off", list changed frames, and
 *                               count differing pixels for up to 3 frames
 *   Page-wide sequence          After creating a Lottie instance and advancing several frames, how
 *                               many numbers from the page-wide shared PRNG sequence were consumed
 *                               by it
 *   Comparison with current direct jump  For assets without random expressions, whether "seed + no
 *                                        stale values" produces the exact frame from "new on new
 *                                        page direct jump" under "off" (report only)
 *   Layers                      Whether all layers (including those in nested compositions) are
 *                               created after initialization
 *   Duration                    How long it takes to create an instance and to jump one frame
 *                               (record only)
 *   Why there is still a slight difference  happy2016 has no expressions, but under "off" and
 *                                           "seed", sequential advance and direct jump still differ
 *                                           by dozens of pixels: test clearing interpolation cache
 *                                           and enabling switch 2 respectively to see which one
 *                                           works (report only)
 *   Real card                   Mount real LottieView with React: when enabled, identical to the
 *                               direct jump frame above; when disabled, raw text identical frame
 *                               by frame to the card at the commit specified by --before
 *   Expression test cases       Values on each layer for frames 28-42 in exprcases under "off",
 *                               "seed", and "replace": the two values from calling random twice in
 *                               succession, Math.random, variables with identical names, difference
 *                               between adjacent frames in wiggle, whether the two seedRandom
 *                               syntaxes vary over time, whether two copies of the same composition
 *                               animate independently; also verify this.pv vs value, whether using
 *                               gaussRandom (function not present in player library) in expressions
 *                               fails identically when enabled and disabled, and stacking switch 1
 *                               and switch 3 together. "Replace" must adhere to the principle set
 *                               by user on 2026-10-12: pinning random numbers is only for
 *                               consistent results each time, without altering original visual
 *                               appearance. The card side, like the player library, follows "all
 *                               expressions in the same frame share one sequence and draw
 *                               sequentially by evaluation order", only fixing the starting point
 *                               of each frame
 *   Alternating frame rendering Three enabled instances (two of which share the same asset) plus
 *                               one disabled instance on the same page, each jumping one frame in
 *                               turn: each instance's frame must match what it renders individually
 *   Bypass                      Call player library's goToAndStop directly without going through
 *                               loadLottie's goTo: expressions fall back to separate sequences, yet
 *                               frames read by two new pages remain identical (only report how many
 *                               frames differ from normal rendering)
 *   Images                      Save several PNGs scaled to 960×540 in --out directory for visual
 *                               confirmation that rendering is not blank: fixture frame 21 (two
 *                               copies each of sequential advance and new page for off and seed),
 *                               and happy2016 last frame
 *
 * Criteria (added to `fails` on failure, exit code 1):
 *   - "seed + no stale values", "replace + no stale values": all frames identical across all assets
 *     and all Ns; two in succession identical.
 *   - "seed", "replace": all frames identical across five test assets and all Ns; each asset
 *     identical when created twice in succession; assets without random expressions or
 *     random-order text match "off" frame-by-frame across full length (they should not be touched).
 *   - "replace": rewritten expression sites no fewer than the count of expressions in the asset
 *     (each copy counted in multi-instantiated compositions); "expression test cases" all hold (see
 *     comments in that section).
 *   - fixtureasync has indeed not finished loading when instance is created (otherwise this check
 *     did not test what it intended to test).
 *   - 0 values consumed from the page-wide sequence when enabled; all layers created after
 *     initialization; "real card" checks all hold; page has no errors or warnings.
 *   Whether frames match under "off" represents the status quo, reported only; whether built-in
 *   assets match between sequential advance and direct jump under "seed" and "replace" is also
 *   reported only (the remaining difference is attributed to switch 2). Duration is recorded only.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : dflt; };
const flag = (name) => process.argv.includes(name);
const PORT = Number(arg('--port', '27601'));
if (!Number.isInteger(PORT) || PORT < 20000 || PORT > 65000) throw new Error('--port needs a port of 20000 or above (this machine\'s ephemeral port range is below 15000, and lower ports can get taken by chance)');
/** Verified player library version. After upgrading, rerun this probe and lottie-seed-extra-probe.mjs, and update this number only after passing */
const LOTTIE_WEB_VERIFIED = '5.13.0';
const ORIGIN = `http://127.0.0.1:${PORT}`;
const BEFORE = arg('--before', '7e7ae968');
const OUT = arg('--out', fs.mkdtempSync(path.join(os.tmpdir(), 'pc-lottie-seed-')));
fs.mkdirSync(OUT, { recursive: true });
const SKIP_SWEEP = flag('--skip-sweep');
const CATALOG = path.join(ROOT, 'server', 'catalog', 'lottie');
const FIXTURE = path.join(ROOT, 'scripts', 'probes', 'fixtures', 'lottie-seed', 'expr-layers.json');
const BUNDLED = ['adrock', 'bodymovin', 'gatin', 'happy2016', 'navidad'];
const CASES = path.join(ROOT, 'scripts', 'probes', 'fixtures', 'lottie-seed', 'expr-cases.json');
const TEXT = path.join(ROOT, 'scripts', 'probes', 'fixtures', 'lottie-seed', 'text-random.json');
const FIXTURES = ['fixture', 'fixtureasync', 'fixtureip', 'exprcases', 'textrandom'];
const ASSETS = arg('--assets', [...FIXTURES, ...BUNDLED].join(',')).split(',').filter(Boolean);
const FIXTURE_PICKS = {
  fixture: [0, 5, 9, 10, 11, 12.5, 19, 20, 21, 24, 25, 26, 29, 30, 31, 39, 40, 41, 50, 59],
  fixtureasync: [0, 5, 9, 10, 11, 12.5, 19, 20, 21, 24, 25, 26, 29, 30, 31, 39, 40, 41, 50, 59],
  // Start point is at composition frame 22: card frame 3 = composition frame 25
  // (nested layer with random enters), frame 8 = frame 30, frame 18 = frame 40
  fixtureip: [0, 1, 2, 3, 4, 7, 8, 9, 17, 18, 19, 28, 37],
  exprcases: [0, 1, 5, 17, 18, 29, 30, 35, 36, 37, 59],
  textrandom: [0, 1, 15, 29, 30, 31, 39, 40, 41, 45, 59],
};
const FIXTURE_LAYERS = ['random-pos', 'wiggle-pos', 'seeded-opacity', 'wiggle-opacity', 'precomp', 'inner-wiggle', 'inner-random', 'plain-keyframes',
  'twice', 'math-random', 'shadowed', 'wiggle-only', 'seed-timeless', 'seed-timed', 'forms', 'pv-static', 'pv-keyed',
  'text-keyed-30', 'text-keyed-40', 'text-static', 'twin-a', 'twin-b', 'twin-random', 'twin-wiggle', 'seeded-wiggle'];
const MODES = ['off', 'seed', 'both', 'expr', 'exprboth'];
const MODE_NAME = { off: 'off', seed: 'seed', both: 'seed+no stale values', expr: 'replace', exprboth: 'replace+no stale values', exprbare: 'replace, no outer wrapper', exprframe: 'replace, outer layer does not pin text separately' };
/** Configuration mode for control only: run only for the test asset with random-order text, report only */
const CONTRAST = ['exprbare', 'exprframe'];
const isExpr = (mode) => mode === 'expr' || mode === 'exprboth';
/** Asset JSON text. fixtureasync = fixture with an external data asset (t: 3) attached, pointing to /lottie-data/footage.json served by the probe itself */
function dataText(name) {
  if (name === 'fixture') return fs.readFileSync(FIXTURE, 'utf8');
  if (name === 'fixtureasync') { const d = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')); d.nm = 'lottie-seed-fixture-async'; d.assets.push({ id: 'data_0', nm: 'footage', t: 3, u: '/lottie-data/', p: 'footage.json', e: 0 }); return JSON.stringify(d); }
  if (name === 'exprcases') return fs.readFileSync(CASES, 'utf8');
  if (name === 'textrandom') return fs.readFileSync(TEXT, 'utf8');
  if (name === 'fixtureip') { const d = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')); d.nm = 'lottie-seed-fixture-ip'; d.ip = 22; return JSON.stringify(d); }
  return fs.readFileSync(path.join(CATALOG, `${name}.json`), 'utf8');
}

// ── In-page execution half ──
const HARNESS = String.raw`<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;background:#111;overflow:hidden}.box{position:absolute;left:0;top:0;width:1920px;height:1080px}.absolute{position:absolute}.inset-0{inset:0}#card{position:absolute;left:0;top:0;width:1920px;height:1080px}</style>
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
  import * as current from '/src/cards/native/lottie.tsx';
  import * as before from '/__lottie_before.tsx';
  import { waitForFrameWork } from '/src/kernel/frameReady.ts';

  const MODES = {
    off: { seed: false, exact: false, expr: false }, seed: { seed: true, exact: false, expr: false }, both: { seed: true, exact: true, expr: false },
    expr: { seed: false, exact: false, expr: true }, exprboth: { seed: false, exact: true, expr: true }, all: { seed: true, exact: true, expr: true },
    exprbare: { seed: false, exact: false, expr: true, debug: 'no-outer' }, exprframe: { seed: false, exact: false, expr: true, debug: 'no-text-key' },
  };
  const texts = new Map();
  const text = async (name) => { if (!texts.has(name)) texts.set(name, await (await fetch('/lottie-data/' + name + '.json')).text()); return texts.get(name); };
  const made = new Map(); let nextId = 1;
  const normalize = (s) => { const ids = new Map(); return s.replace(/__lottie_element_\d+/g, (m) => { if (!ids.has(m)) ids.set(m, 'E' + ids.size); return ids.get(m); }); };
  /** 看得见的那部分:display:none 的节点只留壳(它和里面的东西都不画),没人引用的 <defs> 去掉,属性按名字排序 */
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
    // 图层的蒙版路径放在 <defs> 里,图层藏起来以后它不再更新,留着的是旧路径
    const refsOf = (el, into) => { for (const node of [el, ...el.querySelectorAll('*')]) for (const a of node.attributes) { for (const m of a.value.matchAll(/url\(["']?#([^)"']+)["']?\)/g)) into.add(m[1]); if (a.localName === 'href' && a.value.startsWith('#')) into.add(a.value.slice(1)); } };
    const byId = new Map(); for (const el of copy.querySelectorAll('[id]')) byId.set(el.getAttribute('id'), el);
    const used = new Set(); const pending = new Set();
    for (const child of copy.children) if (child.localName !== 'defs') refsOf(child, pending);
    while (pending.size) { const id = pending.values().next().value; pending.delete(id); if (used.has(id)) continue; used.add(id); const el = byId.get(id); if (el) { const more = new Set(); refsOf(el, more); for (const x of more) if (!used.has(x)) pending.add(x); } }
    for (const defs of copy.querySelectorAll('defs')) for (const res of [...defs.children]) { const ids = [res, ...res.querySelectorAll('[id]')].map((el) => el.getAttribute('id')).filter(Boolean); if (!ids.some((id) => used.has(id))) res.remove(); }
    return normalize(new XMLSerializer().serializeToString(copy));
  };
  /** 一份画面:r 原文,v 看得见的 */
  const svgText = (root) => { const svg = root.querySelector('svg'); return svg ? { r: normalize(new XMLSerializer().serializeToString(svg)), v: visible(svg) } : { r: '', v: '' }; };
  const loaded = (anim) => anim.isLoaded ? Promise.resolve() : new Promise((resolve, reject) => { anim.addEventListener('DOMLoaded', resolve); anim.addEventListener('data_failed', () => reject(new Error('data_failed'))); });
  const countLayers = (renderer) => { let layers = 0, built = 0; const walk = (r) => { (r.layers || []).forEach((l, i) => { if (l.ty === 99) return; layers++; const e = r.elements && r.elements[i]; if (e && e !== true) { built++; if (l.ty === 0) walk(e); } }); }; walk(renderer); return { layers, built }; };
  const median = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];

  const api = {
    /** 建一份(走卡片的 loadLottie)。mode: 'off' | 'seed' | 'both' */
    async make(name, mode) {
      const data = JSON.parse(await text(name));
      const box = document.createElement('div'); box.className = 'box'; document.body.appendChild(box);
      const t0 = performance.now();
      const handle = current.loadLottie(box, data, 'contain', MODES[mode]);
      const asyncLoad = !handle.anim.isLoaded;
      await loaded(handle.anim);
      const id = nextId++; made.set(id, { handle, box });
      return { id, asyncLoad, seed: handle.seed, exact: handle.exact, rewritten: handle.rewritten, buildMs: +(performance.now() - t0).toFixed(1), ...countLayers(handle.anim.renderer) };
    },
    goTo(id, frame) { made.get(id).handle.goTo(frame); },
    jump(id, frame) { const m = made.get(id); m.handle.goTo(frame); return svgText(m.box); },
    /** 依次推 frames,picks 里的帧各留一份画面 */
    seq(id, frames, picks) { const m = made.get(id); const want = new Set(picks); const out = {}; for (const f of frames) { m.handle.goTo(f); if (want.has(f)) out[f] = svgText(m.box); } return out; },
    /** 依次推,每帧只回「看得见的」的散列(全长逐帧用) */
    async seqHashes(id, frames) { const m = made.get(id); const out = []; for (const f of frames) { m.handle.goTo(f); const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(svgText(m.box).v)); out.push([...new Uint8Array(buf)].slice(0, 12).map((x) => x.toString(16).padStart(2, '0')).join('')); } return out; },
    /** 跳一帧的同步耗时:顺推全长 3 遍,取每帧毫秒数的中位数 */
    timeSeq(id, frames) { const m = made.get(id); const runs = []; for (let r = 0; r < 3; r++) { m.handle.goTo(frames[frames.length - 1]); const t0 = performance.now(); for (const f of frames) m.handle.goTo(f); runs.push((performance.now() - t0) / frames.length); } return +median(runs).toFixed(4); },
    hide(id) { made.get(id).box.style.display = 'none'; },
    destroy(id) { const m = made.get(id); m.handle.anim.destroy(); m.box.remove(); made.delete(id); },
    /** 别的卡:调 n 次 Math.random */
    burn(n) { let last = 0; for (let i = 0; i < n; i++) last = Math.random(); return last; },
    /** 页面里接下来的 n 个 Math.random */
    peek(n) { return Array.from({ length: n }, () => Math.random()); },
    /**
     * 实验用(不是原型的一部分):找出这份实例里所有带关键帧的属性;之后 seqCold 每次跳帧前把它们的插值缓存清回刚建好的样子。
     * 用来回答「顺推和直接跳差的那一点是不是插值缓存引起的」。
     */
    findKeyframed(id) {
      const m = made.get(id); const seen = new Set(); const props = []; const stack = [m.handle.anim.renderer.elements];
      while (stack.length) {
        const o = stack.pop();
        if (!o || typeof o !== 'object' || seen.has(o) || o instanceof Node || ArrayBuffer.isView(o) || o === window) continue;
        seen.add(o);
        if (o._caching && typeof o._caching === 'object' && 'lastFrame' in o._caching) props.push(o);
        for (const k of Object.keys(o)) { if (k === 'data' || k === 'layers' || k === 'keyframes' || k === 'globalData' || k === 'comp') continue; const v = o[k]; if (v && typeof v === 'object') stack.push(v); }
      }
      m.props = props; return props.length;
    },
    seqCold(id, frames, picks) {
      const m = made.get(id); const want = new Set(picks); const out = {};
      for (const f of frames) {
        for (const p of m.props) { const c = p._caching; c.lastFrame = -999999; c.lastIndex = 0; if ('_lastKeyframeIndex' in c) c._lastKeyframeIndex = -1; }
        m.handle.goTo(f); if (want.has(f)) out[f] = svgText(m.box);
      }
      return out;
    },
    /** 把两份 SVG 文本各变成像素,数不同的像素 */
    async pixelDiff(a, b) {
      const W = 1920, H = 1080; const canvas = new OffscreenCanvas(W, H); const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const px = async (s) => { const doc = new DOMParser().parseFromString(s, 'image/svg+xml').documentElement; doc.setAttribute('width', String(W)); doc.setAttribute('height', String(H)); const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(doc)], { type: 'image/svg+xml' })); try { const img = new Image(); img.src = url; await img.decode(); ctx.clearRect(0, 0, W, H); ctx.drawImage(img, 0, 0, W, H); } finally { URL.revokeObjectURL(url); } return ctx.getImageData(0, 0, W, H).data.slice(); };
      const pa = await px(a), pb = await px(b); let count = 0, max = 0;
      for (let i = 0; i < pa.length; i += 4) { const d = Math.max(Math.abs(pa[i] - pb[i]), Math.abs(pa[i + 1] - pb[i + 1]), Math.abs(pa[i + 2] - pb[i + 2]), Math.abs(pa[i + 3] - pb[i + 3])); if (d) { count++; if (d > max) max = d; } }
      return { pixels: count, pct: +(100 * count / (W * H)).toFixed(4), max };
    },
    /** 把一份 SVG 文本变成缩到 960×540 的 PNG(base64),给人看 */
    async png(s) {
      const doc = new DOMParser().parseFromString(s, 'image/svg+xml').documentElement; doc.setAttribute('width', '1920'); doc.setAttribute('height', '1080');
      const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(doc)], { type: 'image/svg+xml' }));
      const canvas = new OffscreenCanvas(960, 540); const ctx = canvas.getContext('2d');
      try { const img = new Image(); img.src = url; await img.decode(); ctx.fillStyle = '#111'; ctx.fillRect(0, 0, 960, 540); ctx.drawImage(img, 0, 0, 960, 540); } finally { URL.revokeObjectURL(url); }
      const buf = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer()); let out = ''; for (let i = 0; i < buf.length; i += 32768) out += String.fromCharCode(...buf.subarray(i, i + 32768)); return btoa(out);
    },
    // ── 真卡片(React) ──
    root: null, Card: null, params: null, pre: null,
    /** which: 'current' | 'before';burn > 0 时在 Lottie 前面先挂一张挂载时调 burn 次 Math.random 的卡 */
    async mountCard(which, params, t, burn) {
      api.Card = (which === 'before' ? before : current).LottieView; api.params = params;
      api.pre = burn > 0 ? function Other() { React.useEffect(() => { for (let i = 0; i < burn; i++) Math.random(); }, []); return null; } : null;
      api.root = createRoot(document.getElementById('card'));
      return api.cardFrame(t);
    },
    async cardFrame(t) {
      flushSync(() => api.root.render(React.createElement(React.Fragment, null, api.pre ? React.createElement(api.pre, { key: 'other' }) : null, React.createElement(api.Card, { ...api.params, t, key: 'card' }))));
      // 走 src 的要等取数;播放库的 DOMLoaded 是 setTimeout(0) 发的,卡片在那以后才交「这一帧好了」
      await new Promise((resolve) => setTimeout(resolve, 0));
      await waitForFrameWork();
      return svgText(document.getElementById('card'));
    },
    switches: () => ({ seed: current.lottieSeedEnabled(), exact: current.lottieExactEnabled(), expr: current.lottieExprEnabled() }),
    /** 依次跳到 frames 里的每一帧,读各图层(带 id 的 <g>)的变换矩阵和透明度:{ 帧: { 图层名: [a, b, c, d, e, f, 透明度] } } */
    readLayers(id, frames) {
      const m = made.get(id); const out = {};
      for (const f of frames) {
        m.handle.goTo(f); const row = {};
        for (const g of m.box.querySelectorAll('svg g[id]')) { const t = /matrix\(([^)]+)\)/.exec(g.getAttribute('transform') || ''); row[g.id in row ? g.id + '#2' : g.id] = [...(t ? t[1].split(',').map(Number) : [1, 0, 0, 1, 0, 0]), Number(g.getAttribute('opacity') ?? 1)]; }
        out[f] = row;
      }
      return out;
    },
    /**
     * 交替画帧:specs 里每份 { name, mode, offset },轮流各跳一帧(第 f + offset 帧),记下每份每一步「看得见的」文本。
     * 只给一份时就是它单独画。
     */
    async alternate(specs, frames) {
      const items = [];
      for (const spec of specs) { const data = JSON.parse(await text(spec.name)); const box = document.createElement('div'); box.className = 'box'; document.body.appendChild(box); const handle = current.loadLottie(box, data, 'contain', MODES[spec.mode]); await loaded(handle.anim); items.push({ handle, box, spec, out: [] }); }
      for (const f of frames) for (const it of items) { it.handle.goTo(f + it.spec.offset); it.out.push(svgText(it.box).v); }
      return items.map((it) => it.out);
    },
    /** 绕过 loadLottie 给的 goTo,直接调播放库的 goToAndStop */
    bypass(id, frames) { const m = made.get(id); return frames.map((f) => { m.handle.anim.goToAndStop(f, true); return svgText(m.box).v; }); },
    /** exprcases 里那两层记在全局对象上的核对结果 */
    pvCheck: () => ({ static: globalThis.__pcPvStatic ?? null, keyed: globalThis.__pcPvKeyed ?? null }),
    /** 卡片自己的随机函数装没装到这个页面上;装了就看它给的是不是四样、同样的参数再调一次是不是同样的数、Math 别的东西还在不在 */
    runtime() {
      const f = globalThis.__pcLottieFn; if (typeof f !== 'function') return { installed: false };
      const once = f(1, 2, 0.5, 0, Math), again = f(1, 2, 0.5, 0, Math);
      return { installed: true, gives: once.length, repeatable: once[0]() === again[0]() && once[3].random() === again[3].random(), mathKeepsRest: once[3].floor(2.5) === 2 && once[3].PI === Math.PI };
    },
    /**
     * 表达式里用了 gaussRandom(播放库没有这个函数)会怎样:建一份只有这一个表达式的动画,记下播放库报的错。
     * 图层第 2 帧才入场:播放库只在表达式第一次求值出错时报一次(之后这个属性就锁在原值上),要赶在那之前挂上监听
     */
    async gaussFails(mode) {
      const st = (v) => ({ a: 0, k: v });
      const data = { v: '5.7.4', fr: 30, ip: 0, op: 10, w: 100, h: 100, nm: 'gauss', ddd: 0, assets: [], layers: [{ ddd: 0, ind: 1, ty: 4, nm: 'g', sr: 1, ao: 0, ip: 2, op: 10, st: 0, bm: 0, shapes: [],
        ks: { o: st(100), r: st(0), p: { a: 0, k: [0, 0, 0], x: 'var $bm_rt;\n$bm_rt = [gaussRandom() * 100, 0, 0];' }, a: st([0, 0, 0]), s: st([100, 100, 100]) } }] };
      const box = document.createElement('div'); box.className = 'box'; document.body.appendChild(box);
      const errors = [];
      const handle = current.loadLottie(box, data, 'contain', MODES[mode]);
      handle.anim.addEventListener('error', (e) => errors.push(String(e?.nativeError?.message ?? e?.type ?? e)));
      await loaded(handle.anim);
      try { handle.goTo(3); } catch (e) { errors.push('抛出:' + String(e?.message ?? e)); }
      handle.anim.destroy(); box.remove();
      return errors[0] ?? null;
    },
  };
  window.api = api; window.ready = true;
</script>`;

const beforeSource = execFileSync('git', ['show', `${BEFORE}:src/cards/native/lottie.tsx`], { cwd: ROOT, encoding: 'utf8', windowsHide: true, maxBuffer: 16 << 20 });
const BEFORE_ID = path.join(ROOT, '__lottie_before.tsx').replace(/\\/g, '/');
const plugin = {
  name: 'lottie-seed-probe', enforce: 'pre',
  resolveId(id) { if (id === '/__lottie_before.tsx' || id.replace(/\\/g, '/') === BEFORE_ID) return BEFORE_ID; },
  load(id) { if (id.replace(/\\/g, '/') !== BEFORE_ID) return; return beforeSource.replace(/from "(\.[^"]+)"/g, (_, p) => `from "/${path.posix.normalize('src/cards/native/' + p)}"`); },
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      const url = new URL(req.url, 'http://x');
      res.setHeader('cache-control', 'no-store');
      if (url.pathname === '/favicon.ico') { res.statusCode = 204; res.end(); return; }
      if (url.pathname === '/harness') { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(await server.transformIndexHtml('/harness', HARNESS)); return; }
      const m = /^\/lottie-data\/([a-z0-9]+)\.json$/.exec(url.pathname);
      if (m && m[1] === 'footage') { res.setHeader('content-type', 'application/json'); res.end('{"rows":[]}'); return; }
      if (m && (FIXTURES.includes(m[1]) || BUNDLED.includes(m[1]))) { res.setHeader('content-type', 'application/json'); res.end(dataText(m[1])); return; }
      next();
    });
  },
};

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
/** Where two texts differ: position and context of first difference; fixture is further grouped by layer name */
function describeDiff(a, b, layerNames) {
  let i = 0; const n = Math.min(a.length, b.length);
  while (i < n && a[i] === b[i]) i++;
  const from = Math.max(0, i - 50);
  const out = { at: i, a: a.slice(from, i + 70), b: b.slice(from, i + 70) };
  if (layerNames) {
    const ta = a.split('<'), tb = b.split('<'); const layers = new Set(); let cur = '(root)';
    for (let k = 0; k < Math.max(ta.length, tb.length); k++) {
      const m = /^g[^>]*\bid="([^"]+)"/.exec(ta[k] ?? '');
      if (m && layerNames.includes(m[1])) cur = m[1];
      if (ta[k] !== tb[k]) layers.add(cur);
    }
    out.layers = [...layers];
  }
  return out;
}
/** Expressions in asset: total count, count using random (random, wiggle); also counts "random order" text animators */
function expressionsOf(data) {
  let all = 0, random = 0, textOrder = 0;
  const walk = (o) => { if (Array.isArray(o)) { o.forEach(walk); return; } if (o && typeof o === 'object') { if (typeof o.x === 'string' && 'k' in o) { all++; if (/random|wiggle/i.test(o.x)) random++; } if (o.rn === 1) textOrder++; for (const k in o) walk(o[k]); } };
  walk(data); return { all, random, textOrder };
}

const report = { when: new Date().toISOString(), host: { cpu: os.cpus()[0]?.model?.trim(), logicalCores: os.cpus().length }, before: BEFORE, out: OUT, assets: {}, card: {}, pageErrors: [], fails: [] };
const fail = (msg) => { report.fails.push(msg); console.log(`FAIL ${msg}`); };

const vite = await createServer({
  root: ROOT, configFile: false, plugins: [plugin], logLevel: 'error', appType: 'custom',
  cacheDir: path.join(os.tmpdir(), 'pc-lottie-seed-probe-vite'),
  optimizeDeps: { include: ['lottie-web', 'react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime'] },
  server: { host: '127.0.0.1', port: PORT, strictPort: true, hmr: false, watch: null },
});
await vite.listen();
let browser = null;
const t0 = Date.now();
try {
  browser = await puppeteer.launch({ headless: true, protocolTimeout: 900000, args: [...PROBE_CHROME_ARGS, '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1'] });
  report.chrome = await browser.version();
  report.lottieWeb = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.resolve('lottie-web'))), '..', '..', 'package.json'), 'utf8')).version;
  if (report.lottieWeb !== LOTTIE_WEB_VERIFIED) fail(`The playback library is ${report.lottieWeb}, the verified one is ${LOTTIE_WEB_VERIFIED}: once every item below passes, change LOTTIE_WEB_VERIFIED to the new version number`);
  // Frame jumps must go through the entry point provided by loadLottie: outside the card itself,
  // nothing in src/ may import the player library or call its frame jump directly
  {
    // These two are not playing Lottie: the former passes the player library to user cards written on
    // online pages (user cards directly importing the player library can only be declared as
    // motion-style, see Card Authoring Guide section 3); the latter is only an example in comments.
    // If any other file appears, think through first why it does not use LottieView
    const ALLOWED_IMPORTERS = ['src/online/cardRuntime/hostModules.ts', 'src/online/cardRuntime/soundStub.ts'];
    const offenders = [];
    const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, e.name); if (e.isDirectory()) { if (e.name !== 'node_modules') walk(full); continue; } if (!/\.(ts|tsx|mjs|js|jsx)$/.test(e.name) || /\.test\./.test(e.name)) continue; const rel = path.relative(ROOT, full).split(path.sep).join('/'); if (rel === 'src/cards/native/lottie.tsx' || ALLOWED_IMPORTERS.includes(rel)) continue; const text = fs.readFileSync(full, 'utf8'); if (/from\s+["']lottie-web["']|import\(\s*["']lottie-web["']\s*\)|\.goToAndStop\s*\(|\.goToAndPlay\s*\(/.test(text)) offenders.push(rel); } };
    walk(path.join(ROOT, 'src'));
    report.bypassers = offenders;
    if (offenders.length) fail(`Besides src/cards/native/lottie.tsx, other files in src/ import the playback library or call its frame jump directly: ${offenders.join(', ')} (go through LottieView / loadLottie)`);
    console.log(`Frame-jump entry / files in src/ other than the card itself that import the playback library or call the frame jump directly: ${offenders.length}`);
  }

  /** Fresh page per test case: page-wide PRNG sequence, player internal sequence, and node ID counters all start from scratch */
  const open = async (query = '') => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
    page.on('pageerror', (e) => report.pageErrors.push(String(e?.message ?? e).slice(0, 300)));
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warn') report.pageErrors.push(`console.${m.type()}: ${m.text().slice(0, 300)}`); });
    await page.goto(`${ORIGIN}/harness${query}`, { waitUntil: 'load' });
    await page.waitForFunction('window.ready === true', { timeout: 120000 });
    return page;
  };
  const call = (page, fn, ...args) => page.evaluate((f, a) => window.api[f](...a), fn, args);

  // First 4000 numbers in the page-wide sequence: used to count "how many were consumed"
  const refPage = await open();
  const reference = await call(refPage, 'peek', 4000);
  await refPage.close();
  const drawsBefore = (next) => reference.indexOf(next);
  const tool = await open(); // Used only to turn SVG text into pixels
  const pixelDiff = (a, b) => call(tool, 'pixelDiff', a, b);

  for (const name of ASSETS) {
    const isFixture = FIXTURES.includes(name);
    const data = JSON.parse(dataText(name));
    const total = Math.max(1, (Number(data.op) || 0) - (Number(data.ip) || 0));
    const picks = isFixture
      ? FIXTURE_PICKS[name]
      : [...new Set([0, 1, Math.floor(total * 0.13), Math.floor(total * 0.31), Math.floor(total / 2), Math.floor(total * 0.69), total - 2, total - 1])].filter((f) => f >= 0 && f < total);
    const maxPick = Math.max(...picks);
    const frames = []; for (let f = 0; f <= Math.floor(maxPick); f++) { frames.push(f); for (const p of picks) if (!Number.isInteger(p) && Math.floor(p) === f) frames.push(p); }
    const all = Array.from({ length: total }, (_, i) => i);
    const few = [picks[1], picks[Math.floor(picks.length / 2)], picks[picks.length - 1]];
    const layerNames = isFixture ? FIXTURE_LAYERS : null;
    const expressions = expressionsOf(data);
    const entry = { total, fr: Number(data.fr) || 30, picks, expressions, modes: {} };
    report.assets[name] = entry;
    console.log(`── ${name}: ${total} frames; ${expressions.all} expressions, ${expressions.random} of them using random; ${expressions.textOrder} text animators with random order; picked N = ${picks.join(',')}`);
    const noRandom = expressions.random === 0 && expressions.textOrder === 0;

    for (const mode of [...MODES, ...(expressions.textOrder ? CONTRAST : [])]) {
      const contrast = CONTRAST.includes(mode);
      const started = Date.now();
      const shots = {}; // Visual name → { N: { r, v } }
      // How many in the page-wide sequence were consumed: count in a separate page, not mixing into
      // the comparisons below
      const p0 = await open();
      const before0 = drawsBefore((await call(p0, 'peek', 1))[0]);
      const counted = await call(p0, 'make', name, mode); await call(p0, 'seq', counted.id, frames, []);
      const afterSeq = drawsBefore((await call(p0, 'peek', 1))[0]);
      const frameMs = await call(p0, 'timeSeq', counted.id, all);
      await p0.close();
      // Sequential advance, jump back, create on the same page, create twice in succession
      const p1 = await open();
      const first = await call(p1, 'make', name, mode);
      shots['sequential'] = await call(p1, 'seq', first.id, frames, picks);
      await call(p1, 'seq', first.id, all, []);
      shots['jump back'] = {};
      for (const n of picks) { await call(p1, 'goTo', first.id, 0); shots['jump back'][n] = await call(p1, 'jump', first.id, n); }
      await call(p1, 'hide', first.id);
      shots['new in same page'] = {};
      for (const n of picks) { const m = await call(p1, 'make', name, mode); shots['new in same page'][n] = await call(p1, 'jump', m.id, n); await call(p1, 'destroy', m.id); }
      const twiceN = few[1];
      const twice = [];
      for (let k = 0; k < 2; k++) { const m = await call(p1, 'make', name, mode); twice.push(await call(p1, 'jump', m.id, twiceN)); await call(p1, 'hide', m.id); }
      await p1.close();
      // Create on a new page
      shots['new in new page'] = {};
      for (const n of picks) { const p = await open(); const m = await call(p, 'make', name, mode); shots['new in new page'][n] = await call(p, 'jump', m.id, n); await p.close(); }
      // Other cards in front, other Lottie instances in front
      shots['other card first'] = {}; shots['other Lottie first'] = {};
      for (const n of few) {
        let p = await open(); await call(p, 'burn', 13);
        let m = await call(p, 'make', name, mode); shots['other card first'][n] = await call(p, 'jump', m.id, n); await p.close();
        p = await open();
        const other = await call(p, 'make', 'fixture', 'off'); await call(p, 'seq', other.id, [0, 1, 2, 3, 22, 23, 45], []); await call(p, 'hide', other.id);
        m = await call(p, 'make', name, mode); shots['other Lottie first'][n] = await call(p, 'jump', m.id, n); await p.close();
      }

      // Evaluate for each N: take "sequential advance" as the baseline, compare other copies against it
      const perN = {}; const kinds = Object.keys(shots).filter((k) => k !== 'sequential');
      const tally = { rawSame: 0, same: 0 };
      for (const n of picks) {
        const base = shots['sequential'][n]; const row = { hash: sha(base.v), jumpHash: sha(shots['new in new page'][n].v), rawSame: true, same: true, differ: {} };
        for (const kind of kinds) {
          const other = shots[kind][n]; if (other === undefined || other.r === base.r) continue;
          row.rawSame = false;
          const pixels = await pixelDiff(base.r, other.r);
          if (other.v === base.v && pixels.pixels === 0) continue;
          row.same = false;
          const d = describeDiff(base.v, other.v, layerNames);
          row.differ[kind] = { visibleSame: other.v === base.v, pixels, layers: d.layers, at: d.at, a: d.a, b: d.b };
          fs.writeFileSync(path.join(OUT, `${name}-${mode}-${n}-sequential.svg`), base.r); fs.writeFileSync(path.join(OUT, `${name}-${mode}-${n}-${kind}.svg`), other.r);
        }
        if (row.rawSame) tally.rawSame++; if (row.same) tally.same++;
        perN[n] = row;
      }
      // Images for human inspection
      const showN = name === 'fixture' && ['off', 'seed', 'expr'].includes(mode) ? 21 : name === 'textrandom' && ['off', 'exprframe', 'expr'].includes(mode) ? 45 : name === 'happy2016' && mode === 'both' ? picks[picks.length - 1] : null;
      if (showN !== null) for (const kind of ['sequential', 'new in new page']) fs.writeFileSync(path.join(OUT, `view-${name}-${MODE_NAME[mode]}-frame${showN}-${kind}.png`), Buffer.from(await call(tool, 'png', shots[kind][showN].r), 'base64'));
      let twiceSame = twice[0].r === twice[1].r;
      if (!twiceSame) twiceSame = twice[0].v === twice[1].v && (await pixelDiff(twice[0].r, twice[1].r)).pixels === 0;
      const result = {
        seed: first.seed, exact: first.exact, rewritten: first.rewritten, asyncLoad: first.asyncLoad, layers: first.layers, built: first.built, buildMs: first.buildMs, frameMs,
        allSame: tally.same === picks.length, rawSameCount: tally.rawSame, sameCount: tally.same, twice: { n: twiceN, same: twiceSame }, perN,
        // Create an instance and advance sequentially to the maximum N; how many in the page-wide sequence
        // were consumed (-1: exceeded the 4000 reference entries)
        globalDraws: before0 < 0 || afterSeq < 0 ? -1 : afterSeq - before0 - 1,
        ms: Date.now() - started,
      };
      entry.modes[mode] = result;
      const label = `${name}/${MODE_NAME[mode]}`;
      if (first.built !== first.layers) fail(`${label}: only ${first.built} of ${first.layers} layers were built after the build`);
      if (!isExpr(mode) && !contrast && first.rewritten !== null) fail(`${label}: expressions were rewritten although switch 3 is off`);
      if (first.asyncLoad !== (name === 'fixtureasync')) fail(`${label}: right after instance creation it was ${first.asyncLoad ? 'not loaded yet' : 'already loaded'}, the opposite of what was expected`);
      const worst = (n) => Object.entries(perN[n].differ).map(([k, d]) => `${k}:${d.pixels.pct}%/${d.pixels.max}${d.layers ? `(${d.layers.join(',')})` : ''}`).join(' ');
      const bad = picks.filter((n) => !perN[n].same);
      const mustMatch = !contrast && (mode === 'both' || mode === 'exprboth' || ((mode === 'seed' || mode === 'expr') && isFixture));
      if (mustMatch) for (const n of bad) fail(`${label}: frame ${n} differs from "sequential": ${worst(n)}`);
      if (mode !== 'off' && !contrast) {
        if (!twiceSame) fail(`${label}: building twice in a row, frame ${twiceN} differs`);
        if (result.globalDraws !== 0) fail(`${label}: ${result.globalDraws} values of the page-wide sequence were consumed (should be 0)`);
        if (first.seed === null) fail(`${label}: the asset seed was not computed`);
        if ((mode === 'both' || mode === 'exprboth') && first.exact !== true) fail(`${label}: switch 2 did not take effect`);
        if (isExpr(mode) && !(first.rewritten >= expressions.all)) fail(`${label}: ${first.rewritten} expressions were rewritten, the asset has ${expressions.all}`);
      }
      console.log(`${label}: out of ${picks.length} N values ${tally.same} have the same image across all copies (${tally.rawSame} of them also byte-for-byte identical in raw text); building twice in a row: ${twiceSame ? 'same' : 'different'}; ${result.globalDraws} values of the page-wide sequence consumed; layers ${first.built}/${first.layers}; build one ${first.buildMs} ms, jump one frame ${frameMs} ms${first.seed === null ? '' : `; seed ${first.seed}`}`);
      for (const n of bad) console.log(`     frame ${n} differs (image name: share of differing pixels/max diff (which layers)) ${worst(n)}`);
    }

    // Assets without random expressions: whether the visual after enabling switch 2 is identical to
    // the copy obtained currently (disabled) by jumping directly in a newly opened page
    if (noRandom) {
      entry.equalsOffJump = {};
      for (const mode of ['both', 'exprboth']) {
        const same = picks.filter((n) => entry.modes[mode].perN[n].hash === entry.modes.off.perN[n].jumpHash).length;
        entry.equalsOffJump[mode] = { same, of: picks.length };
        console.log(`${name} / "${MODE_NAME[mode]}" images vs the direct jump in a new page under "off": out of ${picks.length} N values, ${same} have byte-for-byte identical visible text`);
      }
    }

    // Full length frame-by-frame: compare each enabled configuration with "off"
    if (!SKIP_SWEEP) {
      const hashes = {};
      for (const mode of MODES) { const p = await open(); const m = await call(p, 'make', name, mode); hashes[mode] = await call(p, 'seqHashes', m.id, all); await p.close(); }
      entry.sweep = {};
      for (const mode of MODES.slice(1)) {
        const changed = all.filter((f) => hashes.off[f] !== hashes[mode][f]);
        const sample = [...new Set([changed[0], changed[Math.floor(changed.length / 2)], changed[changed.length - 1]])].filter((f) => f !== undefined);
        const pixels = {};
        if (sample.length) {
          const got = {};
          for (const m2 of ['off', mode]) { const p = await open(); const m = await call(p, 'make', name, m2); got[m2] = await call(p, 'seq', m.id, all.slice(0, Math.max(...sample) + 1), sample); await p.close(); }
          for (const f of sample) pixels[f] = await pixelDiff(got.off[f].r, got[mode][f].r);
        }
        entry.sweep[mode] = { frames: total, changed: changed.length, changedFrames: changed, pixels };
        const px = Object.entries(pixels).map(([f, d]) => `frame ${f}: ${d.pixels} pixels (${d.pct}%, max diff ${d.max})`).join(';');
        console.log(`${name} / full length ${total} frames, "${MODE_NAME[mode]}" vs "off": ${changed.length ? `${changed.length} frames changed (${changed.length > 14 ? `${changed.slice(0, 14).join(',')}…` : changed.join(',')})${px ? `;${px}` : ''}` : 'identical frame by frame'}`);
        if ((mode === 'seed' || mode === 'expr') && noRandom && changed.length) fail(`${name}: has no random expressions, yet "${MODE_NAME[mode]}" changed ${changed.length} frames`);
      }
    }
  }

  // -- Why assets without random expressions still differ slightly between sequential advance and
  // direct jump (report only; clearing the interpolation cache is experimental, not part of the
  // prototype) --
  if (ASSETS.includes('happy2016')) {
    const name = 'happy2016'; const { picks } = report.assets[name];
    const frames = Array.from({ length: Math.max(...picks) + 1 }, (_, i) => i);
    const rows = [];
    for (const [label, mode, cold] of [['seed only', 'seed', false], ['seed, plus clearing the interpolation cache every frame', 'seed', true], ['seed+no stale values (switch 2)', 'both', false]]) {
      const p = await open();
      const a = await call(p, 'make', name, mode); const props = await call(p, 'findKeyframed', a.id);
      const pushed = await call(p, cold ? 'seqCold' : 'seq', a.id, frames, picks); await call(p, 'hide', a.id);
      let same = 0, pixelsMax = 0, pctMax = 0, diffMax = 0;
      for (const n of picks) {
        const b = await call(p, 'make', name, mode); const jumped = await call(p, 'jump', b.id, n); await call(p, 'destroy', b.id);
        if (jumped.v === pushed[n].v) { same++; continue; }
        const d = await pixelDiff(pushed[n].r, jumped.r);
        pixelsMax = Math.max(pixelsMax, d.pixels); pctMax = Math.max(pctMax, d.pct); diffMax = Math.max(diffMax, d.max);
      }
      await p.close();
      rows.push({ label, keyframedProps: props, visibleSame: same, of: picks.length, worstPixels: pixelsMax, worstPct: pctMax, worstDiff: diffMax });
      console.log(`happy2016 / why it is still slightly off / "${label}": out of ${picks.length} N values ${same} have the same visible text for sequential push and direct jump; at most ${pixelsMax} pixels differ (${pctMax}%, max diff ${diffMax}); ${props} properties with keyframes`);
    }
    report.floatExperiment = rows;
  }

  // -- Expression test cases (exprcases): layer values under "off", "seed", and "replace" --
  if (ASSETS.includes('exprcases')) {
    const frames = Array.from({ length: 15 }, (_, i) => 28 + i);
    const AMP = 160; // The wiggle-only layer contains wiggle(5, 160)
    const section = { frames, modes: {} };
    const X = 4, Y = 5, O = 6;
    const col = (rows, layer, k) => frames.map((f) => rows[f][layer][k]);
    const varies = (xs) => new Set(xs).size > 1;
    const maxStep = (xs) => Math.max(...xs.slice(1).map((x, i) => Math.abs(x - xs[i])));
    for (const mode of ['off', 'seed', 'expr']) {
      // Read twice each (two new pages): both passes should be identical under the same enabled
      // configuration
      const reads = [];
      let pv = null, runtime = null, gauss = null;
      for (let k = 0; k < 2; k++) { const p = await open(); const m = await call(p, 'make', 'exprcases', mode); reads.push(await call(p, 'readLayers', m.id, frames)); pv = await call(p, 'pvCheck'); runtime = await call(p, 'runtime'); gauss = await call(p, 'gaussFails', mode); await p.close(); }
      const [a, b] = reads;
      const wx = col(a, 'wiggle-only', X), wy = col(a, 'wiggle-only', Y);
      const row = {
        repeat: JSON.stringify(a) === JSON.stringify(b),
        twice: { x: col(a, 'twice', X), y: col(a, 'twice', Y) },
        mathRandom: col(a, 'math-random', X),
        shadowed: col(a, 'shadowed', X),
        wiggle: { x: wx, y: wy, maxStep: +Math.max(maxStep(wx), maxStep(wy)).toFixed(4) },
        // In the same expression, run seedRandom(3, true) first, then wiggle(5, 100)
        seededWiggle: { x: col(a, 'seeded-wiggle', X), maxStep: +Math.max(maxStep(col(a, 'seeded-wiggle', X)), maxStep(col(a, 'seeded-wiggle', Y))).toFixed(4) },
        seedTimeless: col(a, 'seed-timeless', O), seedTimed: col(a, 'seed-timed', O),
        // Two instances placed in the same composition: respective x values of those two inner layers
        twin: { random: [col(a, 'twin-random', X), col(a, 'twin-random#2', X)], wiggle: [col(a, 'twin-wiggle', X), col(a, 'twin-wiggle#2', X)] },
        pv, runtime, gauss,
      };
      section.modes[mode] = row;
      const label = `Expression cases/${MODE_NAME[mode]}`;
      const r3 = (xs) => xs.slice(2, 13).map((x) => x.toFixed(1)).join(' ');
      const twinApart = (pair) => frames.filter((f, i) => pair[0][i] !== pair[1][i]).length;
      console.log(`${label}: two passes: ${row.repeat ? 'same' : 'different'}; x of wiggle-only at frames 30-40: ${r3(wx)}; max diff between adjacent frames ${row.wiggle.maxStep}; max diff between adjacent frames for the layer with seedRandom before wiggle ${row.seededWiggle.maxStep}`);
      console.log(`${label}: the two numbers from calling random twice in a row (frame 30) ${row.twice.x[2].toFixed(2)} / ${row.twice.y[2].toFixed(2)}; x of Math.random at frames 30-32 ${row.mathRandom.slice(2, 5).map((x) => x.toFixed(2)).join(' ')}; x of the layer with same-named variables is ${[...new Set(row.shadowed)].join(',')} throughout`);
      console.log(`${label}: opacity of seedRandom(7, true): ${varies(row.seedTimeless) ? 'varies over time' : 'does not vary over time'} (frame 30: ${row.seedTimeless[2].toFixed(4)}); opacity of seedRandom(7): ${varies(row.seedTimed) ? 'varies over time' : 'does not vary over time'} (frames 30-32: ${row.seedTimed.slice(2, 5).map((x) => x.toFixed(4)).join(' ')})`);
      console.log(`${label}: the same composition placed in two copies; across ${frames.length} frames the two copies differ in: random layer ${twinApart(row.twin.random)}, wiggle layer ${twinApart(row.twin.wiggle)} (frame 30 random ${row.twin.random[0][2].toFixed(1)} / ${row.twin.random[1][2].toFixed(1)}); gaussRandom in an expression: ${gauss ?? 'no error'}`);
      // Should hold true under all three enabled configurations
      if (!row.shadowed.every((x) => x === 600)) fail(`${label}: the expression declares its own random and wiggle with the same names, x should stay 600, got ${[...new Set(row.shadowed)].join(',')}`);
      if (!pv.static || pv.static.maxDiff !== 0 || pv.static.same !== false) fail(`${label}: for a multi-dimensional property without keyframes, this.pv should be value at single precision (and not the same object), got ${JSON.stringify(pv.static)}`);
      if (!pv.keyed || pv.keyed.same !== true) fail(`${label}: for a property with keyframes, this.pv and value should be the same object, got ${JSON.stringify(pv.keyed)}`);
      if (runtime.installed !== (mode === 'expr')) fail(`${label}: the card's own random function is ${runtime.installed ? 'installed' : 'not installed'}, the opposite of what was expected`);
      if (!gauss || !/gaussRandom/.test(gauss)) fail(`${label}: using gaussRandom in an expression should fail the way the playback library does (reporting it as undefined), got ${gauss}`);
      if (mode === 'off') continue;
      // When enabled: both passes are identical
      if (!row.repeat) fail(`${label}: the two new pages read different numbers`);
      if (mode !== 'expr') continue;
      // What "replace" must preserve: fixed values, visual appearance matches current player library
      if (gauss !== section.modes.off.gauss) fail(`${label}: gaussRandom in an expression reports "${gauss}" with the switches on and "${section.modes.off.gauss}" with them off, should be the same`);
      if (!frames.every((f, i) => row.twice.x[i] !== row.twice.y[i])) fail(`${label}: calling random twice in a row in one expression gives the same two numbers on some frames`);
      if (!varies(row.twice.x) || !varies(row.mathRandom)) fail(`${label}: the numbers from random / Math.random do not vary with the frame`);
      if (!row.mathRandom.every((x) => x >= 300 && x < 1300)) fail(`${label}: x of Math.random went outside 300-1300`);
      // wiggle jumps frame by frame as before: the difference between adjacent frames should far exceed
      // the upper bound when "continuous" (one-sixth of amplitude), on the same order of magnitude as
      // when off
      if (!(row.wiggle.maxStep > AMP)) fail(`${label}: wiggle differs by at most ${row.wiggle.maxStep} between adjacent frames, not like picking independently on each frame (with the switches off: ${section.modes.off.wiggle.maxStep})`);
      // In the same expression, seedRandom first then wiggle: matching current player library behavior,
      // continue fetching from the sequence without time, continuous over time (moving at most one-sixth
      // of amplitude per frame)
      if (!(row.seededWiggle.maxStep <= 100 / 6 + 0.001)) fail(`${label}: for the layer with seedRandom before wiggle(5, 100), the difference between adjacent frames is ${row.seededWiggle.maxStep}, above ${(100 / 6).toFixed(2)}; the playback library is continuous now (with the switches off: ${section.modes.off.seededWiggle.maxStep})`);
      if (varies(row.seedTimeless)) fail(`${label}: the value of seedRandom(7, true) varied over time`);
      if (varies(row.seedTimed)) fail(`${label}: the value of seedRandom(7) varied over time (the playback library now ignores the second argument, so it should not change)`);
      if (twinApart(row.twin.random) !== frames.length || twinApart(row.twin.wiggle) < frames.length - 1) fail(`${label}: the same composition placed twice, the two copies should move independently; frames where they differ: random ${twinApart(row.twin.random)}, wiggle ${twinApart(row.twin.wiggle)} (of ${frames.length} frames)`);
      if (!(runtime.gives === 4 && runtime.repeatable && runtime.mathKeepsRest)) fail(`${label}: calling the card's own random function directly gave a wrong result ${JSON.stringify(runtime)}`);
    }
    // When an expression with only wiggle evaluates after another expression's seedRandom (as in fixture's
    // wiggle-pos): the player library currently lets it continue fetching from that sequence,
    // appearing continuous (moving at most one-sixth of amplitude per frame). Under "replace" it must
    // also be like this
    if (ASSETS.includes('fixture')) {
      const late = Array.from({ length: 15 }, (_, i) => 42 + i); const steps = {};
      for (const mode of ['off', 'seed', 'expr']) { const p = await open(); const m = await call(p, 'make', 'fixture', mode); const rows = await call(p, 'readLayers', m.id, late); await p.close(); const xs = late.map((f) => rows[f]['wiggle-pos'][X]); steps[mode] = +Math.max(...xs.slice(1).map((x, i) => Math.abs(x - xs[i]))).toFixed(2); }
      section.wiggleAfterSeeded = steps;
      if (!(steps.expr <= AMP / 6 + 0.001)) fail(`Expression cases/replace: the fixture's wiggle-pos is evaluated after another expression's seedRandom, the playback library is continuous now (max diff between adjacent frames ${steps.off}), but with the switch on it differs by ${steps.expr}`);
      console.log(`Expression cases / the fixture's wiggle-pos (evaluated every frame after an expression with seedRandom(7, true)), max diff between adjacent frames at frames 42-56: off ${steps.off}, seed ${steps.seed}, replace ${steps.expr}`);
    }
    // Enabling switch 1 and switch 3 together (plus switch 2): expressions no longer use the player
    // library sequence; visuals should match enabling switch 3 only (plus switch 2)
    if (ASSETS.includes('fixture')) {
      const ns = [9, 21, 41]; let same = 0;
      for (const n of ns) { const p = await open(); const m = await call(p, 'make', 'fixture', 'all'); const shot = await call(p, 'jump', m.id, n); await p.close(); if (sha(shot.v) === report.assets.fixture.modes.exprboth.perN[n].hash) same++; }
      section.stacked = { same, of: ns.length };
      if (same !== ns.length) fail(`Expression cases: with all three switches on, out of ${ns.length} N values of the fixture only ${same} match "replace+no stale values"`);
      console.log(`Expression cases / all three switches on: fixture frames ${ns.join(', ')}, ${same}/${ns.length} match the image of "replace+no stale values"`);
    }
    // Alternating frame rendering: three instances with the production set enabled (two of which are the
    // same asset, offset by 11 frames) plus one disabled instance, each stepping one frame in turn
    if (ASSETS.includes('fixture')) {
      const steps = [...Array.from({ length: 26 }, (_, i) => 20 + i), 30, 22, 44];
      const specs = [{ name: 'fixture', mode: 'exprboth', offset: 0 }, { name: 'exprcases', mode: 'exprboth', offset: 3 }, { name: 'fixture', mode: 'exprboth', offset: 11 }, { name: 'fixture', mode: 'off', offset: 5 }];
      let p = await open(); const together = await call(p, 'alternate', specs, steps); await p.close();
      const rows = [];
      for (let i = 0; i < 3; i++) {
        p = await open(); const [alone] = await call(p, 'alternate', [specs[i]], steps); await p.close();
        const same = steps.filter((f, k) => alone[k] === together[i][k]).length;
        rows.push({ name: specs[i].name, offset: specs[i].offset, same, of: steps.length });
        if (same !== steps.length) fail(`Alternate drawing: ${specs[i].name} (offset by ${specs[i].offset} frames), out of ${steps.length} steps only ${same} match the standalone drawing`);
      }
      section.alternate = rows;
      console.log(`Alternate drawing / three "replace+no stale values" instances plus one with the switches off, each jumping one frame in turn (${steps.length} steps): steps matching the standalone drawing ${rows.map((r) => `${r.name}+${r.offset} ${r.same}/${r.of}`).join(',')}`);
      // Bypass: call player library goToAndStop directly, expressions are not evaluated in the segment
      // wrapped by the card
      const late = Array.from({ length: 15 }, (_, i) => 42 + i); const runs = [];
      for (let k = 0; k < 2; k++) { p = await open(); const m = await call(p, 'make', 'fixture', 'expr'); runs.push(await call(p, 'bypass', m.id, late)); await p.close(); }
      p = await open(); const normal = await call(p, 'make', 'fixture', 'expr'); const shots = await call(p, 'seq', normal.id, late, late); await p.close();
      const repeat = runs[0].every((v, k) => v === runs[1][k]); const differ = late.filter((f, k) => runs[0][k] !== shots[f].v).length;
      section.bypass = { repeat, differFromNormal: differ, of: late.length };
      if (!repeat) fail('Bypass: calling the playback library\'s goToAndStop directly, the two new pages read different images');
      console.log(`Bypass / fixture with "replace" on but calling the playback library's goToAndStop directly (frames 42-56): two new pages: ${repeat ? 'same' : 'different'}; compared with normal frame jumps, ${differ}/${late.length} frames differ`);
    }
    report.exprCases = section;
  }

  // -- Real cards --
  const inlineParams = { json: dataText('fixture'), src: '', speed: 1, loop: 'no', fit: 'contain' };
  const srcParams = (name) => ({ json: '', src: `/lottie-data/${name}.json`, speed: 1, loop: 'no', fit: 'contain' });
  /**
   * Enabled: attached directly at frame N, attached at frame 0 and advanced frame by frame to frame N,
   * or attaching a card that draws random numbers beforehand, must all match the copy jumped to
   * directly via loadLottie
   */
  const cardOn = async (label, query, wantSwitches, params, rate, ns, asset, mode) => {
    const rows = [];
    for (const n of ns) {
      const want = report.assets[asset].modes[mode].perN[n].hash; const row = { n, want };
      let p = await open(query); row.switches = await call(p, 'switches'); const directShot = await call(p, 'mountCard', 'current', params, n / rate, 0); row.direct = sha(directShot.v); await p.close();
      p = await open(query); let last = await call(p, 'mountCard', 'current', params, 0, 0); for (let f = 1; f <= n; f++) last = await call(p, 'cardFrame', f / rate); row.pushed = sha(last.v); await p.close();
      p = await open(query); row.afterOther = sha((await call(p, 'mountCard', 'current', params, n / rate, 13)).v); await p.close();
      row.same = row.switches.seed === wantSwitches.seed && row.switches.exact === wantSwitches.exact && row.switches.expr === !!wantSwitches.expr && row.direct === want && row.pushed === want && row.afterOther === want;
      if (!row.same) {
        // Where the difference lies: create another instance with loadLottie jumping directly and compare
        // against the "directly attached" copy
        p = await open(); const m = await call(p, 'make', asset, mode); const ref = await call(p, 'jump', m.id, n); await p.close();
        row.diff = { ...describeDiff(ref.v, directShot.v, asset.startsWith('fixture') ? FIXTURE_LAYERS : null), pixels: await pixelDiff(ref.r, directShot.r) };
        fail(`Real card/${label}: frame ${n}: mounted directly ${row.direct}, pushed over ${row.pushed}, other card first ${row.afterOther}, expected ${want} (switches read ${JSON.stringify(row.switches)}); mounted directly vs loadLottie direct jump: ${row.diff.pixels.pct}% of pixels differ${row.diff.layers ? `, layers ${row.diff.layers.join(',')}` : ''}; ${row.diff.a} ‖ ${row.diff.b}`);
      }
      rows.push(row);
    }
    console.log(`Real card / ${label} (URL with ${query || '(nothing)'}): frames ${ns.join(', ')}: mounted directly, pushed from frame 0, other card first: ${rows.every((r) => r.same) ? 'all identical to the one from loadLottie\'s direct jump' : 'some differ'}`);
    return rows;
  };
  if (ASSETS.includes('fixture')) report.card.seed = await cardOn('seed, fixture (inline JSON)', '?lottieSeed=1&lottieExpr=0&lottieExact=0', { seed: true, exact: false }, inlineParams, 30, [9, 21, 41, 59], 'fixture', 'seed');
  // The copy with asynchronous loading: the card called frame jump once before loading completed;
  // the player library renders that exact frame right upon finishing loading
  if (ASSETS.includes('fixtureasync')) report.card.seedAsync = await cardOn('seed, fixtureasync (inline JSON, loading is async)', '?lottieSeed=1&lottieExpr=0&lottieExact=0', { seed: true, exact: false }, { ...inlineParams, json: dataText('fixtureasync') }, 30, [21, 41], 'fixtureasync', 'seed');
  if (ASSETS.includes('fixtureip')) report.card.seedIp = await cardOn('seed, fixtureip (inline JSON, start is not at frame 0)', '?lottieSeed=1&lottieExpr=0&lottieExact=0', { seed: true, exact: false }, { ...inlineParams, json: dataText('fixtureip') }, 30, [0, 2, 17], 'fixtureip', 'seed');
  // Switch 3: same three copies
  if (ASSETS.includes('fixture')) report.card.expr = await cardOn('replace, fixture (inline JSON)', '?lottieExpr=1&lottieExact=0', { seed: false, exact: false, expr: true }, inlineParams, 30, [9, 21, 41, 59], 'fixture', 'expr');
  if (ASSETS.includes('fixtureasync')) report.card.exprAsync = await cardOn('replace, fixtureasync (inline JSON, loading is async)', '?lottieExpr=1&lottieExact=0', { seed: false, exact: false, expr: true }, { ...inlineParams, json: dataText('fixtureasync') }, 30, [21, 41], 'fixtureasync', 'expr');
  if (ASSETS.includes('fixtureip')) report.card.exprIp = await cardOn('replace, fixtureip (inline JSON, start is not at frame 0)', '?lottieExpr=1&lottieExact=0', { seed: false, exact: false, expr: true }, { ...inlineParams, json: dataText('fixtureip') }, 30, [0, 2, 17], 'fixtureip', 'expr');
  if (ASSETS.includes('textrandom')) {
    report.card.exprText = await cardOn('replace, textrandom (inline JSON, text in random order)', '?lottieExpr=1&lottieExact=0', { seed: false, exact: false, expr: true }, { ...inlineParams, json: dataText('textrandom') }, 30, [15, 31, 45], 'textrandom', 'expr');
    report.card.seedText = await cardOn('seed, textrandom (inline JSON, text in random order)', '?lottieSeed=1&lottieExpr=0&lottieExact=0', { seed: true, exact: false }, { ...inlineParams, json: dataText('textrandom') }, 30, [15, 31, 45], 'textrandom', 'seed');
  }
  if (ASSETS.includes('happy2016')) {
    const a = report.assets.happy2016;
    report.card.exprBoth = await cardOn('replace+no stale values, happy2016 (loaded via src)', '?lottieExpr=1&lottieExact=1', { seed: false, exact: true, expr: true }, srcParams('happy2016'), a.fr, [a.picks[4], a.picks[a.picks.length - 1]], 'happy2016', 'exprboth');
    report.card.both = await cardOn('seed+no stale values, happy2016 (loaded via src)', '?lottieSeed=1&lottieExact=1&lottieExpr=0', { seed: true, exact: true }, srcParams('happy2016'), a.fr, [a.picks[4], a.picks[a.picks.length - 1]], 'happy2016', 'both');
  }
  // Default (nothing in the URL): the production set of "replace + do not keep old values"
  {
    const dflt = { seed: false, exact: true, expr: true };
    if (ASSETS.includes('fixture')) report.card.dflt = await cardOn('default, fixture (inline JSON)', '', dflt, inlineParams, 30, [9, 21, 41, 59], 'fixture', 'exprboth');
    if (ASSETS.includes('fixtureasync')) report.card.dfltAsync = await cardOn('default, fixtureasync (inline JSON, loading is async)', '', dflt, { ...inlineParams, json: dataText('fixtureasync') }, 30, [21, 41], 'fixtureasync', 'exprboth');
    if (ASSETS.includes('fixtureip')) report.card.dfltIp = await cardOn('default, fixtureip (inline JSON, start is not at frame 0)', '', dflt, { ...inlineParams, json: dataText('fixtureip') }, 30, [0, 2, 17], 'fixtureip', 'exprboth');
    if (ASSETS.includes('textrandom')) report.card.dfltText = await cardOn('default, textrandom (inline JSON, text in random order)', '', dflt, { ...inlineParams, json: dataText('textrandom') }, 30, [15, 31, 45], 'textrandom', 'exprboth');
    if (ASSETS.includes('happy2016')) { const a = report.assets.happy2016; report.card.dfltHappy = await cardOn('default, happy2016 (loaded via src)', '', dflt, srcParams('happy2016'), a.fr, [a.picks[4], a.picks[a.picks.length - 1]], 'happy2016', 'exprboth'); }
  }
  // Disabled (URL with lottieExpr=0&lottieExact=0): matches card frame-by-frame output verbatim from
  // the --before commit (inline JSON fixture and navidad loaded via src)
  {
    const cases = [];
    if (ASSETS.includes('fixture')) cases.push(['fixture (inline JSON)', inlineParams, 30, 30]);
    if (ASSETS.includes('exprcases')) cases.push(['exprcases (inline JSON)', { ...inlineParams, json: dataText('exprcases') }, 20, 30]);
    if (ASSETS.includes('textrandom')) cases.push(['textrandom (inline JSON)', { ...inlineParams, json: dataText('textrandom') }, 45, 30]);
    if (ASSETS.includes('navidad')) cases.push(['navidad (loaded via src)', srcParams('navidad'), 12, 25]);
    report.card.off = [];
    for (const [label, params, count, rate] of cases) {
      const seqs = {};
      for (const which of ['before', 'current']) {
        const p = await open('?lottieExpr=0&lottieExact=0'); const switches = await call(p, 'switches'); if (switches.seed || switches.exact || switches.expr) fail(`Real card/off: with lottieExpr=0&lottieExact=0 in the URL, read ${JSON.stringify(switches)}`);
        // When disabled, it compares output verbatim: even old attributes remaining on invisible layers
        // must match
        const out = [sha((await call(p, 'mountCard', which, params, 0, 0)).r)];
        for (let f = 1; f < count; f++) out.push(sha((await call(p, 'cardFrame', f / rate)).r));
        // Jump back once more, then jump forward once
        out.push(sha((await call(p, 'cardFrame', 3 / rate)).r)); out.push(sha((await call(p, 'cardFrame', (count + 5) / rate)).r));
        seqs[which] = out; await p.close();
      }
      const equal = seqs.before.filter((h, i) => h === seqs.current[i]).length;
      report.card.off.push({ label, frames: seqs.before.length, equal });
      if (equal !== seqs.before.length) fail(`Real card/off: ${label} and the ${BEFORE} card, only ${equal} of ${seqs.before.length} frames are the same`);
      console.log(`Real card / off: ${label} compared with the ${BEFORE} card, ${equal} of ${seqs.before.length} frames have byte-for-byte identical raw text`);
    }
  }
  await tool.close();
  if (report.pageErrors.length) fail(`${report.pageErrors.length} page errors or warnings: ${report.pageErrors.slice(0, 3).join(' | ')}`);
} catch (e) {
  fail(`Probe itself failed: ${String(e?.stack ?? e).slice(0, 600)}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  await vite.close().catch(() => {});
}
report.ms = Date.now() - t0;
fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(report, null, 2));
console.log(`Machine: ${report.host.cpu}, ${report.host.logicalCores} logical cores; ${report.chrome}; lottie-web ${report.lottieWeb}; took ${(report.ms / 1000).toFixed(1)} s; result ${path.join(OUT, 'result.json')}`);
console.log(JSON.stringify({ ok: report.fails.length === 0, fails: report.fails }));
process.exitCode = report.fails.length ? 1 : 0;
