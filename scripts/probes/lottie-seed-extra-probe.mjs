/**
 * 探针:Lottie 随机数固定——原型(`lottie-seed-probe.mjs`)没测到的那几样,加上「当场算一帧要多久」。
 * 出处:`docs/plan/render-refactor-task.md`「癸」「接的时候要做的」第 2 条。**升级播放库(lottie-web)之前和 `lottie-seed-probe.mjs` 一起重跑。**
 *
 *   node scripts/probes/lottie-seed-extra-probe.mjs [--port 27602] [--out <目录>] [--only posterize,crossread,…] [--skip-build] [--skip-big] [--skip-timing]
 *
 * 做法:起一个只服务本探针的 vite(根是本工作区,不读项目的 vite 配置,只占 --port;生产构建那一项另占 --port + 1 放静态文件),
 * 无头 Chrome 里装上和产品一样的随机数钉子,用卡片自己的 `loadLottie` 建实例,**不传开法**——测的就是缺省(正式的一组:
 * 换掉表达式里的随机函数、外面那一层、属性值不留旧数)。素材都是探针现造的,不落盘。
 *
 * 每份素材取若干个 N,每个 N 比六份画面(口径同 `lottie-seed-probe.mjs`:看得见的 SVG 文本逐字节相同,并且像素逐个相同):
 *   顺推、回跳、同页新建、新页新建、别的卡在前(先调 13 次 Math.random)、别的 Lottie 在前(先建一份关着开关的带随机表达式的 Lottie 推几帧)
 * 另把三个开关都关掉各做一遍当对照(只报告:关着时这些素材本来就对不上,说明用例确实踩到了随机数)。
 *
 * 素材:
 *   posterize     表达式里先调 `posterizeTime()` 再调 wiggle / random / seedRandom
 *   crossread     一个表达式求值到一半去读另一个带随机表达式的属性(读的那一层先求值、后求值各一份)
 *   globalbypass  表达式绕过去直接用全局对象:`globalThis.Math.random()`、`globalThis.crypto.getRandomValues()`
 *   textexpr      表达式改文字内容,再配「随机顺序」的文字动画器
 *   nested        合成嵌套三层、每层各放几份,最里面带 random 和 wiggle;另核各份是不是各动各的
 *   netfont       带网络字体(探针把本机一个字体文件当网络字体发出去)的文字图层,装载是异步的;找不到字体文件就记「没跑」
 * 另外:
 *   build         生产构建(vite build,缺省的压缩):同一段页面代码打包后再跑一遍 fixture、exprcases、textrandom、nested、textexpr、globalbypass、happy2016,
 *                 六份画面相同,并且和开发构建取到的画面相同;页面没有 `[lottie]` 警告(几处靠播放库内部名字的钩子都包上了)
 *   big           大素材上复制合成的耗时和内存(只记录):一个 150 层、层层带随机表达式的合成放 30 份
 *   timing        当场算一帧要多久(只记录):5 个自带素材,跳一帧的同步耗时,和「跳一帧并等浏览器出一帧」的耗时;主线程不放慢、放慢 4 倍各量一遍
 *
 * 判定(不满足进 `fails`,退出码 1):开着时各素材所有 N 的六份画面相同;nested 的各份各动各的;globalbypass 的数确实随帧变;
 * build 各条成立;页面没有报错和警告。关着的对照、big、timing 只报告。
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
if (!Number.isInteger(PORT) || PORT < 20000 || PORT > 64999) throw new Error('--port 要用 20000 以上的端口');
const OUT = path.resolve(ROOT, arg('--out', path.join('out', 'lottie-seed-extra-probe')));
fs.mkdirSync(OUT, { recursive: true });
const ONLY = arg('--only', '').split(',').filter(Boolean);
const want = (name) => !ONLY.length || ONLY.includes(name);
const CATALOG = path.join(ROOT, 'server', 'catalog', 'lottie');
const FIX = path.join(ROOT, 'scripts', 'probes', 'fixtures', 'lottie-seed');
const BUNDLED = ['adrock', 'bodymovin', 'gatin', 'happy2016', 'navidad'];
const fsPath = (rel) => path.join(ROOT, rel).split(path.sep).join('/');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

// ── 现造的素材 ──
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
    // 播放库每帧从最后一层往前求值:reader-late 排在第一层,最后求值(读的时候 target-a 已经算过);reader-early 排最后一层,最先求值(读的时候 target-b 还没算)
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

// ── 页面里跑的那一半(开发构建和生产构建用同一段)──
const PIN_ID = 'virtual:lottie-extra-pin', ENTRY_ID = 'virtual:lottie-extra-entry';
const PIN_SOURCE = `import { installPinnedEntropy } from ${JSON.stringify(fsPath('src/kernel/pinEntropy.ts'))};\n// 和产品一样:随机数钉子赶在播放库加载之前装\ninstallPinnedEntropy();\n`;
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
  /** 建一份。off 为真时三个开关都关;否则不传开法,用卡片的缺省(正式的一组) */
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
  /** 依次跳到 frames 里的每一帧,读各图层(带 id 的 <g>,按文档顺序)的平移和透明度:{ 帧: [[图层名, x, y, 透明度], …] } */
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
  /** 大素材:改写表达式(含复制合成)单独要多久、改写前后数据多大;再各建一份量耗时和堆内存 */
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
  /** 当场算一帧:跳一帧的同步耗时(全长 3 遍取每帧的中位数、最慢的一帧),和「跳一帧并等浏览器出一帧」的耗时 */
  async timing(text) {
    const data = JSON.parse(text); const total = Math.max(1, (Number(data.op) || 0) - (Number(data.ip) || 0));
    const box = document.createElement('div'); box.className = 'box'; document.body.appendChild(box);
    const t0 = performance.now();
    const handle = card.loadLottie(box, data, 'contain');
    await loaded(handle.anim);
    const buildMs = performance.now() - t0;
    const per = [];
    for (let r = 0; r < 3; r++) { handle.goTo(total - 1); for (let f = 0; f < total; f++) { const t1 = performance.now(); handle.goTo(f); per.push(performance.now() - t1); } }
    // 直接跳(不相邻的帧):步长取全长的 0.37 倍左右
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

  /** 六份画面:返回 { shots, perN, same(各份都相同的 N 的个数) } */
  const sixWay = async (open, text, picks, off) => {
    const maxPick = Math.max(...picks);
    const frames = Array.from({ length: maxPick + 1 }, (_, i) => i);
    const total = (() => { const d = JSON.parse(text); return Math.max(1, (Number(d.op) || 0) - (Number(d.ip) || 0)); })();
    const all = Array.from({ length: total }, (_, i) => i);
    const shots = {};
    const p1 = await open();
    const first = await call(p1, 'make', text, off);
    shots['顺推'] = await call(p1, 'seq', first.id, frames, picks);
    await call(p1, 'seq', first.id, all, []);
    shots['回跳'] = {};
    for (const n of picks) { await call(p1, 'goTo', first.id, 0); shots['回跳'][n] = await call(p1, 'jump', first.id, n); }
    const errors = await call(p1, 'errors', first.id);
    await call(p1, 'hide', first.id);
    shots['同页新建'] = {};
    for (const n of picks) { const m = await call(p1, 'make', text, off); shots['同页新建'][n] = await call(p1, 'jump', m.id, n); await call(p1, 'destroy', m.id); }
    await p1.close();
    shots['新页新建'] = {}; shots['别的卡在前'] = {}; shots['别的 Lottie 在前'] = {};
    for (const n of picks) {
      let p = await open(); let m = await call(p, 'make', text, off); shots['新页新建'][n] = await call(p, 'jump', m.id, n); await p.close();
      p = await open(); await call(p, 'burn', 13); m = await call(p, 'make', text, off); shots['别的卡在前'][n] = await call(p, 'jump', m.id, n); await p.close();
      p = await open(); const other = await call(p, 'make', otherLottie, true); await call(p, 'seq', other.id, [0, 1, 2, 3, 22, 23, 45], []); await call(p, 'hide', other.id);
      m = await call(p, 'make', text, off); shots['别的 Lottie 在前'][n] = await call(p, 'jump', m.id, n); await p.close();
    }
    const perN = {}; let same = 0;
    for (const n of picks) {
      const baseShot = shots['顺推'][n]; const differ = {};
      for (const kind of Object.keys(shots)) {
        if (kind === '顺推') continue;
        const other = shots[kind][n];
        if (other.r === baseShot.r) continue;
        if (other.v === baseShot.v && (await pixelDiff(baseShot.r, other.r)).pixels === 0) continue;
        differ[kind] = other.v === baseShot.v ? '看得见的文本相同、像素不同' : '看得见的文本不同';
      }
      perN[n] = { hash: sha(baseShot.v), differ };
      if (!Object.keys(differ).length) same++;
    }
    return { first, errors, perN, same, of: picks.length };
  };
  const badNs = (r) => Object.entries(r.perN).filter(([, v]) => Object.keys(v.differ).length).map(([n, v]) => `第 ${n} 帧(${Object.keys(v.differ).join('、')})`).join(';');

  // ── 六种素材 ──
  for (const [name, spec] of Object.entries(CASES)) {
    if (!want(name)) continue;
    if (name === 'netfont' && !FONT_FILE) { report.notRun.push('netfont:本机找不到可以当网络字体发出去的字体文件'); console.log('netfont:没跑(找不到字体文件)'); continue; }
    const text = JSON.stringify(spec.data());
    const on = await sixWay(openDev, text, spec.picks, false);
    const off = await sixWay(openDev, text, spec.picks, true);
    const entry = { picks: spec.picks, on: { same: on.same, of: on.of, perN: on.perN, rewritten: on.first.rewritten, exact: on.first.exact, asyncLoad: on.first.asyncLoad, errors: on.errors }, off: { same: off.same, of: off.of, errors: off.errors } };
    report.cases[name] = entry;
    console.log(`${name}:开着(缺省)${on.of} 个 N 里 ${on.same} 个六份画面相同;三个开关都关 ${off.same}/${off.of};改写表达式 ${on.first.rewritten} 处;建实例那一下${on.first.asyncLoad ? '还没装载完' : '已经装载完'};表达式报错 开 ${on.errors.length} 条、关 ${off.errors.length} 条${on.errors.length ? `(${on.errors[0]})` : ''}`);
    if (on.same !== on.of) fail(`${name}:开着时有的 N 六份画面不同 —— ${badNs(on)}`);
    if (on.first.exact !== true) fail(`${name}:缺省应当开着「属性值不留旧数」,读到 ${on.first.exact}`);
    if (!(on.first.rewritten > 0)) fail(`${name}:缺省应当改写表达式,读到 ${on.first.rewritten}`);
    if (spec.asyncLoad && !on.first.asyncLoad) fail(`${name}:建实例那一下已经装载完,没测到异步装载`);
    if (on.errors.length !== off.errors.length) fail(`${name}:表达式报错的条数开着 ${on.errors.length}、关着 ${off.errors.length},应当一样`);

    // 各素材自己的补充核对
    const frames = Array.from({ length: 16 }, (_, i) => i);
    const read = async (isOff) => { const p = await openDev(); const m = await call(p, 'make', text, isOff); const rows = await call(p, 'readLayers', m.id, frames); await p.close(); return rows; };
    const colOf = (rows, layer, k) => frames.map((f) => (rows[f].find((r) => r[0] === layer) ?? [])[k]);
    const distinct = (xs) => new Set(xs.map((x) => (typeof x === 'number' ? x.toFixed(3) : String(x)))).size;
    if (name === 'posterize') {
      const a = await read(false), b = await read(true);
      // 观感对照(只报告):posterizeTime(4) 之后的 random,第 0～15 帧里取到几个不同的数;posterizeTime(3) 加 seedRandom(5, true) 的透明度几个
      entry.look = { on: { random: distinct(colOf(a, 'post-random', 1)), seeded: distinct(colOf(a, 'post-seeded', 3)), wiggle: distinct(colOf(a, 'post-wiggle', 1)) }, off: { random: distinct(colOf(b, 'post-random', 1)), seeded: distinct(colOf(b, 'post-seeded', 3)), wiggle: distinct(colOf(b, 'post-wiggle', 1)) } };
      console.log(`posterize / 第 0～15 帧里取到几个不同的数(开 对 关):posterizeTime(4) 后的 random ${entry.look.on.random} 对 ${entry.look.off.random};posterizeTime(3) 加 seedRandom 的透明度 ${entry.look.on.seeded} 对 ${entry.look.off.seeded};posterizeTime(5) 后的 wiggle ${entry.look.on.wiggle} 对 ${entry.look.off.wiggle}`);
      if (entry.look.on.seeded !== entry.look.off.seeded) fail(`posterize:posterizeTime 加 seedRandom 的那一层,不同的数的个数开着 ${entry.look.on.seeded}、关着 ${entry.look.off.seeded},观感变了`);
      if ((entry.look.on.random > 1) !== (entry.look.off.random > 1)) fail('posterize:posterizeTime 后的 random 随不随帧变,开着和关着不一样');
    }
    if (name === 'globalbypass') {
      const a = await read(false), again = await read(false);
      entry.varies = { math: distinct(colOf(a, 'global-math', 1)), crypto: distinct(colOf(a, 'global-crypto', 1)), repeat: JSON.stringify(a) === JSON.stringify(again) };
      console.log(`globalbypass / 第 0～15 帧里取到几个不同的数:globalThis.Math.random ${entry.varies.math},globalThis.crypto ${entry.varies.crypto};两个新页面读到的${entry.varies.repeat ? '相同' : '不同'}`);
      if (!(entry.varies.math > 8 && entry.varies.crypto > 8)) fail(`globalbypass:绕过去取的随机数应当随帧变(确实取到了随机数),读到 ${JSON.stringify(entry.varies)}`);
      if (!entry.varies.repeat) fail('globalbypass:两个新页面读到的数不同');
    }
    if (name === 'nested') {
      const a = await read(false), b = await read(true);
      // 最里面那一层一共放了几份、其中在第 13 帧位置两两不同的有几份
      const copiesAt = (rows, f, layer) => rows[f].filter((r) => r[0] === layer).map((r) => `${r[1].toFixed(2)},${r[2].toFixed(2)}`);
      const on13 = copiesAt(a, 13, 'in-random'), off13 = copiesAt(b, 13, 'in-random'), onW = copiesAt(a, 13, 'in-wiggle');
      entry.copies = { count: on13.length, distinctOn: new Set(on13).size, distinctOff: new Set(off13).size, wiggleDistinctOn: new Set(onW).size };
      console.log(`nested / 最里面带 random 的那一层放了 ${on13.length} 份,第 13 帧位置互不相同的:开 ${entry.copies.distinctOn} 份、关 ${entry.copies.distinctOff} 份;带 wiggle 的那一层开着 ${entry.copies.wiggleDistinctOn} 份互不相同;复制合成后改写 ${on.first.rewritten} 处`);
      if (on13.length !== 15) fail(`nested:最里面那一层应当放了 15 份,读到 ${on13.length}`);
      if (entry.copies.distinctOn !== on13.length || entry.copies.wiggleDistinctOn !== on13.length) fail(`nested:各份应当各动各的,${on13.length} 份里互不相同的只有 random ${entry.copies.distinctOn}、wiggle ${entry.copies.wiggleDistinctOn}`);
      if (on.first.rewritten !== 30) fail(`nested:15 份、每份 2 个表达式,应当改写 30 处,读到 ${on.first.rewritten}`);
    }
    if (name === 'textexpr') {
      // 文字内容确实被表达式换过:第 0、16、40 帧第一层的画面互不相同
      const hs = [0, 16, 40].map((f) => on.perN[f].hash);
      entry.textChanges = new Set(hs).size;
      if (entry.textChanges !== 3) fail(`textexpr:表达式应当在第 15、36 帧换文字内容,第 0、16、40 帧的画面只有 ${entry.textChanges} 种`);
    }
  }

  // ── 生产构建 ──
  if (want('build') && !flag('--skip-build')) {
    const dist = path.join(OUT, 'build');
    fs.rmSync(dist, { recursive: true, force: true });
    const started = Date.now();
    const result = await build({ root: ROOT, configFile: false, plugins: [virtual], logLevel: 'error', build: { outDir: dist, emptyOutDir: true, write: true, copyPublicDir: false, rollupOptions: { input: ENTRY_ID } } });
    const outputs = (Array.isArray(result) ? result : [result]).flatMap((r) => r.output ?? []);
    const entryChunk = outputs.find((o) => o.type === 'chunk' && o.isEntry);
    if (!entryChunk) throw new Error('生产构建没有产出入口');
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
    if (!minified) fail('生产构建:入口没有被压缩(行数太多),没测到压缩后的代码');
    const p0 = await openProd(); section.switches = await call(p0, 'switches'); await p0.close();
    if (!(section.switches.seed === false && section.switches.exact === true && section.switches.expr === true)) fail(`生产构建:缺省的开关应当是 关/开/开,读到 ${JSON.stringify(section.switches)}`);
    const list = [['fixture', fixtureText('fixture'), [0, 9, 21, 41, 59]], ['exprcases', fixtureText('exprcases'), [0, 18, 30, 37, 59]], ['textrandom', fixtureText('textrandom'), [0, 15, 31, 40, 45]], ['nested', JSON.stringify(nested()), [0, 13, 30, 59]], ['textexpr', JSON.stringify(textexpr()), [0, 14, 20, 40, 45]], ['globalbypass', JSON.stringify(globalbypass()), [0, 1, 25, 59]], ['happy2016', fixtureText('happy2016'), [0, 49, 68, 98]]];
    for (const [name, text, picks] of list) {
      const prod = await sixWay(openProd, text, picks, false);
      // 开发构建同样的帧:新开页面直接跳
      let sameAsDev = 0;
      for (const n of picks) { const p = await openDev(); const m = await call(p, 'make', text, false); const shot = await call(p, 'jump', m.id, n); await p.close(); if (sha(shot.v) === prod.perN[n].hash) sameAsDev++; }
      section.assets[name] = { same: prod.same, of: prod.of, sameAsDev, rewritten: prod.first.rewritten, exact: prod.first.exact };
      console.log(`生产构建 / ${name}:${prod.of} 个 N 里 ${prod.same} 个六份画面相同;和开发构建直接跳的画面相同的 ${sameAsDev}/${picks.length};改写表达式 ${prod.first.rewritten} 处;属性值不留旧数${prod.first.exact ? '包上了' : '没包上'}`);
      if (prod.same !== prod.of) fail(`生产构建 / ${name}:有的 N 六份画面不同 —— ${badNs(prod)}`);
      if (sameAsDev !== picks.length) fail(`生产构建 / ${name}:${picks.length} 个 N 里只有 ${sameAsDev} 个和开发构建的画面相同`);
      if (prod.first.exact !== true) fail(`生产构建 / ${name}:「属性值不留旧数」没包上`);
    }
    console.log(`生产构建:用时 ${section.buildSeconds} 秒,入口 ${section.entryKB} KB(${minified ? '已压缩' : '没压缩'}),缺省开关 ${JSON.stringify(section.switches)}`);
  }

  // ── 大素材 ──
  if (want('big') && !flag('--skip-big')) {
    const p = await openDev();
    report.big = await call(p, 'bigCost', JSON.stringify(big()));
    await p.close();
    const b = report.big;
    console.log(`大素材(150 层的合成放 30 份,4500 个带随机的表达式;只记录):素材 ${b.textKB} KB,改写并复制合成以后 ${b.afterKB} KB,改写 ${b.rewritten} 处用 ${b.rewriteMs} 毫秒;建一份 关 ${b.off.buildMs} 毫秒 / 开 ${b.on.buildMs} 毫秒;跳一帧 关 ${b.off.frameMs} / 开 ${b.on.frameMs} 毫秒;建完多占的堆 关 ${b.off.heapMB} MB / 开 ${b.on.heapMB} MB;节点 ${b.on.nodes} 个`);
  }

  // ── 当场算一帧要多久 ──
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
        console.log(`耗时 / 主线程${rate === 1 ? '不放慢' : `放慢 ${rate} 倍`} / ${name}(${r.total} 帧):建一份 ${r.buildMs} 毫秒;顺着跳一帧 中位 ${r.syncMedian}、95% ${r.syncP95}、最慢 ${r.syncMax} 毫秒;隔着跳一帧 中位 ${r.hopMedian}、最慢 ${r.hopMax} 毫秒;跳一帧并等浏览器出一帧 平均 ${r.shownPerFrame} 毫秒`);
      }
    }
  }
  await tool.close();
  if (report.pageErrors.length) fail(`页面报错或警告 ${report.pageErrors.length} 条:${report.pageErrors.slice(0, 3).join(' | ')}`);
} catch (e) {
  fail(`探针自己出错:${String(e?.stack ?? e).slice(0, 800)}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  await vite.close().catch(() => {});
  if (staticServer) await new Promise((resolve) => staticServer.close(resolve));
}
report.ms = Date.now() - t0;
fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(report, null, 2));
console.log(`机器:${report.host.cpu},${report.host.logicalCores} 个逻辑核;${report.chrome};lottie-web ${report.lottieWeb};用时 ${(report.ms / 1000).toFixed(1)} 秒;结果 ${path.join(OUT, 'result.json')}`);
for (const n of report.notRun) console.log(`没跑:${n}`);
console.log(JSON.stringify({ ok: report.fails.length === 0, fails: report.fails }));
process.exitCode = report.fails.length ? 1 : 0;
