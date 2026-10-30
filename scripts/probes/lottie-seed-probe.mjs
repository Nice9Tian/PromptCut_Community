/**
 * 探针:Lottie「覆盖随机数种子」——直接跳到第 N 帧和从头顺着推到第 N 帧,画面相同不相同。
 * 出处:`docs/plan/render-refactor-task.md`「癸:Lottie 改成 remotion 式」的「要留意的一处」;用户 2026-10-12:「我觉得可以覆盖随机数种子。」
 * 同日用户又提了另一种做法:「能不能用替换方式直接覆盖,比如替换 random 为 random_in_card()」,即下面的开关三。
 * 做法在 `src/cards/native/lottie.tsx`(`loadLottie`)和 `src/kernel/pinEntropy.ts`(`withSeededRandom`)。
 * 渲染重构「癸」合入以后,正式的一组(开关三、外面那一层、开关二)缺省开着,开关一缺省关;本探针照旧五种开法各做一遍,
 * 开法由探针显式指定(直接调 `loadLottie` 的传 mode,挂真卡片的在页面地址上写 `lottieExpr=0` 之类),不靠缺省。
 * **升级播放库(lottie-web)之前先跑本探针和 `lottie-seed-extra-probe.mjs`**:版本和下面核对过的不一样时本探针直接判失败,
 * 重跑通过以后把 `LOTTIE_WEB_VERIFIED` 改成新版本号。
 *
 *   node scripts/probes/lottie-seed-probe.mjs [--port 27601] [--assets fixture,fixtureasync,fixtureip,exprcases,textrandom,adrock,bodymovin,gatin,happy2016,navidad]
 *        [--out <目录>]       存结果 result.json,以及对不上的那几帧的 SVG 文本(缺省放系统临时目录)
 *        [--before 7e7ae968]  「开关关着和改之前一样」拿哪个提交的 lottie.tsx 当改之前
 *        [--skip-sweep]       不跑「全长逐帧,开和关比」那一项(最慢)
 *
 * 做法:起一个只服务本探针的 vite(根是本工作区,不读项目的 vite 配置,只占 --port 这一个端口),真 Chrome 里装上和产品一样的
 * 随机数钉子(`installPinnedEntropy`),用卡片自己的 `loadLottie` 建实例。每份画面比三样:
 *   原文      SVG 序列化后的文本,只把播放库按全页计数器发的节点 id(`__lottie_element_N`)按出现顺序重新编号。
 *             它连**看不见的图层**上留着的旧属性也比:播放库藏起一个图层只是加 `display: none`,上次显示时的位置、透明度原样留着,
 *             从没显示过的图层则什么属性都没有。所以原文相同不相同和推帧路径有关,这一项只报告。
 *   看得见的  同一份文本去掉 `display: none` 的节点里面的内容和它身上的其它属性,去掉 `<defs>` 里已经没人引用的东西
 *             (图层的蒙版路径放在 `<defs>` 里,图层藏起来以后留着旧路径),属性按名字排序。逐字节比。
 *   像素      原文不同的两份各变成 1920×1080 的像素,数不同的像素。
 * 「相同」指看得见的文本逐字节相同、并且像素逐个相同。
 *
 * 素材:`fixture` 是 `scripts/probes/fixtures/lottie-seed/expr-layers.json`——手写的测试 Lottie,图层入点 0、10、20、25、30、40,
 * 分别用 random()、只有 wiggle()、seedRandom()+random() 驱动位置、透明度、旋转、缩放,其中两层在嵌套合成里。
 * `fixtureasync` 是同一份再挂一个外部数据素材(探针现造,不落盘):播放库要等它取回来才建图层,走的是「装载完成在定时器回调里」那条路。
 * `fixtureip` 是同一份把起点改到第 22 帧(探针现造):卡片的第 0 帧落在合成的第 22 帧,这时两个只有 wiggle() 的图层已经在场、
 * 带 random 的那个嵌套图层还没进来——播放库装载完成那一下自己画的第 0 帧,和之后跳回第 0 帧重画的,要是同一个画面。
 * `exprcases` 是 `scripts/probes/fixtures/lottie-seed/expr-cases.json`——另一份手写的,一层一个表达式用例:一个表达式里连调两次
 * random()、表达式里写 Math.random()、表达式里自己声明同名变量和函数、只有 wiggle()、seedRandom(7, true)、seedRandom(7)、
 * random 的另两种调用形式、两层用来核对「wiggle 用的 this.pv 和表达式拿到的 value 是不是同一个东西」,
 * 以及一个带随机表达式、放了两份的嵌套合成(两份应当各动各的)。
 * `textrandom` 是 `scripts/probes/fixtures/lottie-seed/text-random.json`——三个文字图层,都用了「随机顺序」的动画器(播放库在这里
 * 直接调全页的 `Math.random()`,不经过表达式)。字形是自己画的方块,不用字体文件。两层的文字内容带关键帧(第 30、40 帧各换一次),
 * 一层不带。它另外多做两种只为对照的开法:「替换、不包外层」和「替换、外层按帧播种但不单独固定文字」。
 * 其余是自带的 5 个。
 *
 * 五种开法各做一遍:「关」三个开关都关(现状);「种子」只开开关一(给播放库内部那一串播种);「种子+不留旧数」开关一加开关二;
 * 「替换」只开开关三(改写表达式,把随机函数换成卡片自己的);「替换+不留旧数」开关三加开关二。每个 N 取这几份画面:
 *   顺推              新开页面,建一份,从第 0 帧一帧一帧推到第 N 帧
 *   回跳              同一份实例推完全长后,回到第 0 帧再直接跳到第 N 帧
 *   同页新建          同一个页面里再建一份,直接跳到第 N 帧
 *   新页新建          新开页面,建一份,直接跳到第 N 帧
 *   别的卡在前        新开页面,先调 13 次 Math.random,再建一份直接跳(只取 3 个 N)
 *   别的 Lottie 在前  新开页面,先建一份带随机表达式的 Lottie 推几帧,再建一份直接跳(只取 3 个 N)
 *   连建两次          同一个页面里连建两份,都直接跳到同一帧(只取 1 个 N)
 * 另外:
 *   全长逐帧      开着的四种开法各顺推全长,和「关」逐帧比,列出变了的帧,取最多 3 帧数不同的像素
 *   全页那一串    建一份 Lottie 并推几帧之后,全页共用的那一串随机数被它吃掉几个
 *   和现在的直接跳比  不带随机表达式的素材,「种子+不留旧数」的画面是不是就是「关」下新页新建直接跳的那一份(只报告)
 *   图层          建好后是不是所有图层(含嵌套合成里的)都已经建了
 *   耗时          建一份、跳一帧各要多久(只记录)
 *   为什么还差一点  happy2016 不带表达式,「关」和「种子」下顺推和直接跳仍差几十个像素:分别试清插值缓存、开开关二,看哪个管用(只报告)
 *   真卡片        用 React 挂真的 LottieView:开着时和上面直接跳的那一份相同;关着时和 --before 那个提交的卡片逐帧原文相同
 *   表达式用例    exprcases 在「关」「种子」「替换」下第 28～42 帧各图层的数:连调两次 random 的两个数、Math.random、同名变量、
 *                 wiggle 相邻帧差多少、seedRandom 两种写法随不随时间变、同一个合成的两份是不是各动各的;另核 this.pv 和 value、
 *                 表达式里用 gaussRandom(播放库没有这个函数)开着和关着是不是同样地失败、开关一和开关三叠着开。
 *                 「替换」要守的是用户 2026-10-12 定的原则:固定随机数只为每次结果一致,不改变原来的观感。
 *                 卡片这边和播放库一样是「同一帧里各表达式共用一串、按求值先后接着取」,只把每一帧的起点固定住
 *   交替画帧      同一页里三份开着的实例(其中两份是同一个素材)加一份关着的,轮流各跳一帧:每份的画面要和它单独画时相同
 *   绕过去        不走 loadLottie 给的 goTo、直接调播放库的 goToAndStop:表达式退回各用各的一串,两个新页面读到的仍相同(只报告和正常画差几帧)
 *   图            --out 目录里存几张缩到 960×540 的 PNG,给人看一眼画面不是空的:fixture 第 21 帧(关、种子各取顺推和新页新建两份)、happy2016 最后一帧
 *
 * 判定(不满足进 `fails`,退出码 1):
 *   - 「种子+不留旧数」「替换+不留旧数」:所有素材、所有 N 的各份画面相同;连建两次相同。
 *   - 「种子」「替换」:五份测试素材所有 N 的各份画面相同;各素材连建两次相同;不带随机表达式、也没有随机顺序文字的素材全长逐帧和「关」相同(不该动它们)。
 *   - 「替换」:改写的表达式处数不少于素材里的表达式个数(放了几份的合成每份各算);「表达式用例」各条成立(见那一段的注释)。
 *   - fixtureasync 建实例那一下确实还没装载完(否则这一项没测到它要测的)。
 *   - 开着时全页那一串被吃掉 0 个;建好后图层全建了;「真卡片」各条成立;页面没有报错和警告。
 *   「关」下各份画面相同不相同是现状,只报告;自带素材在「种子」「替换」下顺推和直接跳相同不相同也只报告(差的那一点归开关二)。耗时只记录。
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
if (!Number.isInteger(PORT) || PORT < 20000 || PORT > 65000) throw new Error('--port 要用 20000 以上的端口(这台机器的临时端口段在 15000 以下,低的端口会被碰巧占住)');
/** 核对过的播放库版本。升级以后重跑本探针和 lottie-seed-extra-probe.mjs,通过了再改这个数 */
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
  // 起点在合成第 22 帧:卡片第 3 帧 = 合成第 25 帧(带 random 的嵌套图层入),第 8 帧 = 第 30 帧,第 18 帧 = 第 40 帧
  fixtureip: [0, 1, 2, 3, 4, 7, 8, 9, 17, 18, 19, 28, 37],
  exprcases: [0, 1, 5, 17, 18, 29, 30, 35, 36, 37, 59],
  textrandom: [0, 1, 15, 29, 30, 31, 39, 40, 41, 45, 59],
};
const FIXTURE_LAYERS = ['random-pos', 'wiggle-pos', 'seeded-opacity', 'wiggle-opacity', 'precomp', 'inner-wiggle', 'inner-random', 'plain-keyframes',
  'twice', 'math-random', 'shadowed', 'wiggle-only', 'seed-timeless', 'seed-timed', 'forms', 'pv-static', 'pv-keyed',
  'text-keyed-30', 'text-keyed-40', 'text-static', 'twin-a', 'twin-b', 'twin-random', 'twin-wiggle', 'seeded-wiggle'];
const MODES = ['off', 'seed', 'both', 'expr', 'exprboth'];
const MODE_NAME = { off: '关', seed: '种子', both: '种子+不留旧数', expr: '替换', exprboth: '替换+不留旧数', exprbare: '替换、不包外层', exprframe: '替换、外层不单独固定文字' };
/** 只为对照的开法:只有带随机顺序文字的那份测试素材做,只报告 */
const CONTRAST = ['exprbare', 'exprframe'];
const isExpr = (mode) => mode === 'expr' || mode === 'exprboth';
/** 素材的 JSON 文本。fixtureasync = fixture 再挂一个外部数据素材(t: 3),地址指向探针自己服务的 /lottie-data/footage.json */
function dataText(name) {
  if (name === 'fixture') return fs.readFileSync(FIXTURE, 'utf8');
  if (name === 'fixtureasync') { const d = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')); d.nm = 'lottie-seed-fixture-async'; d.assets.push({ id: 'data_0', nm: 'footage', t: 3, u: '/lottie-data/', p: 'footage.json', e: 0 }); return JSON.stringify(d); }
  if (name === 'exprcases') return fs.readFileSync(CASES, 'utf8');
  if (name === 'textrandom') return fs.readFileSync(TEXT, 'utf8');
  if (name === 'fixtureip') { const d = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')); d.nm = 'lottie-seed-fixture-ip'; d.ip = 22; return JSON.stringify(d); }
  return fs.readFileSync(path.join(CATALOG, `${name}.json`), 'utf8');
}

// ── 页面里跑的那一半 ──
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
/** 两份文本哪里不同:第一处的位置和上下文;fixture 再按图层名归到层上 */
function describeDiff(a, b, layerNames) {
  let i = 0; const n = Math.min(a.length, b.length);
  while (i < n && a[i] === b[i]) i++;
  const from = Math.max(0, i - 50);
  const out = { at: i, a: a.slice(from, i + 70), b: b.slice(from, i + 70) };
  if (layerNames) {
    const ta = a.split('<'), tb = b.split('<'); const layers = new Set(); let cur = '(根)';
    for (let k = 0; k < Math.max(ta.length, tb.length); k++) {
      const m = /^g[^>]*\bid="([^"]+)"/.exec(ta[k] ?? '');
      if (m && layerNames.includes(m[1])) cur = m[1];
      if (ta[k] !== tb[k]) layers.add(cur);
    }
    out.layers = [...layers];
  }
  return out;
}
/** 素材里的表达式:一共几个,其中用到随机(random、wiggle)的几个;另数「随机顺序」的文字动画器 */
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
  if (report.lottieWeb !== LOTTIE_WEB_VERIFIED) fail(`播放库是 ${report.lottieWeb},核对过的是 ${LOTTIE_WEB_VERIFIED}:下面各项都过了再把 LOTTIE_WEB_VERIFIED 改成新版本号`);
  // 跳帧一律走 loadLottie 给的入口:src/ 里除了卡片自己,不许别处引播放库或直接调它的跳帧
  {
    // 这两个不是在放 Lottie:前一个把播放库交给在线页面里用户自己写的卡(用户卡直接引播放库的只能声明成 motion 式,见建卡指南第 3 节),
    // 后一个只在注释里举例。再有别的文件出现,先想清楚它为什么不走 LottieView
    const ALLOWED_IMPORTERS = ['src/online/cardRuntime/hostModules.ts', 'src/online/cardRuntime/soundStub.ts'];
    const offenders = [];
    const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, e.name); if (e.isDirectory()) { if (e.name !== 'node_modules') walk(full); continue; } if (!/\.(ts|tsx|mjs|js|jsx)$/.test(e.name) || /\.test\./.test(e.name)) continue; const rel = path.relative(ROOT, full).split(path.sep).join('/'); if (rel === 'src/cards/native/lottie.tsx' || ALLOWED_IMPORTERS.includes(rel)) continue; const text = fs.readFileSync(full, 'utf8'); if (/from\s+["']lottie-web["']|import\(\s*["']lottie-web["']\s*\)|\.goToAndStop\s*\(|\.goToAndPlay\s*\(/.test(text)) offenders.push(rel); } };
    walk(path.join(ROOT, 'src'));
    report.bypassers = offenders;
    if (offenders.length) fail(`src/ 里除 src/cards/native/lottie.tsx 外还有文件引播放库或直接调它的跳帧:${offenders.join('、')}(要走 LottieView / loadLottie)`);
    console.log(`跳帧入口 / src/ 里除卡片自己外引播放库或直接调跳帧的文件:${offenders.length} 个`);
  }

  /** 每个用例一个新页面:全页那一串随机数、播放库内部那一串、节点 id 计数器都从头来 */
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

  // 全页那一串的前 4000 个数:用来数「被吃掉几个」
  const refPage = await open();
  const reference = await call(refPage, 'peek', 4000);
  await refPage.close();
  const drawsBefore = (next) => reference.indexOf(next);
  const tool = await open(); // 只用来把 SVG 文本变成像素
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
    console.log(`── ${name}:${total} 帧;表达式 ${expressions.all} 个,其中用到随机的 ${expressions.random} 个;随机顺序的文字动画器 ${expressions.textOrder} 个;取 N = ${picks.join(',')}`);
    const noRandom = expressions.random === 0 && expressions.textOrder === 0;

    for (const mode of [...MODES, ...(expressions.textOrder ? CONTRAST : [])]) {
      const contrast = CONTRAST.includes(mode);
      const started = Date.now();
      const shots = {}; // 画面名 → { N: { r, v } }
      // 全页那一串被吃掉几个:单开一页数,不搅进下面的比较
      const p0 = await open();
      const before0 = drawsBefore((await call(p0, 'peek', 1))[0]);
      const counted = await call(p0, 'make', name, mode); await call(p0, 'seq', counted.id, frames, []);
      const afterSeq = drawsBefore((await call(p0, 'peek', 1))[0]);
      const frameMs = await call(p0, 'timeSeq', counted.id, all);
      await p0.close();
      // 顺推、回跳、同页新建、连建两次
      const p1 = await open();
      const first = await call(p1, 'make', name, mode);
      shots['顺推'] = await call(p1, 'seq', first.id, frames, picks);
      await call(p1, 'seq', first.id, all, []);
      shots['回跳'] = {};
      for (const n of picks) { await call(p1, 'goTo', first.id, 0); shots['回跳'][n] = await call(p1, 'jump', first.id, n); }
      await call(p1, 'hide', first.id);
      shots['同页新建'] = {};
      for (const n of picks) { const m = await call(p1, 'make', name, mode); shots['同页新建'][n] = await call(p1, 'jump', m.id, n); await call(p1, 'destroy', m.id); }
      const twiceN = few[1];
      const twice = [];
      for (let k = 0; k < 2; k++) { const m = await call(p1, 'make', name, mode); twice.push(await call(p1, 'jump', m.id, twiceN)); await call(p1, 'hide', m.id); }
      await p1.close();
      // 新页新建
      shots['新页新建'] = {};
      for (const n of picks) { const p = await open(); const m = await call(p, 'make', name, mode); shots['新页新建'][n] = await call(p, 'jump', m.id, n); await p.close(); }
      // 别的卡在前、别的 Lottie 在前
      shots['别的卡在前'] = {}; shots['别的 Lottie 在前'] = {};
      for (const n of few) {
        let p = await open(); await call(p, 'burn', 13);
        let m = await call(p, 'make', name, mode); shots['别的卡在前'][n] = await call(p, 'jump', m.id, n); await p.close();
        p = await open();
        const other = await call(p, 'make', 'fixture', 'off'); await call(p, 'seq', other.id, [0, 1, 2, 3, 22, 23, 45], []); await call(p, 'hide', other.id);
        m = await call(p, 'make', name, mode); shots['别的 Lottie 在前'][n] = await call(p, 'jump', m.id, n); await p.close();
      }

      // 逐个 N 判:以「顺推」为准,别的各份和它比
      const perN = {}; const kinds = Object.keys(shots).filter((k) => k !== '顺推');
      const tally = { rawSame: 0, same: 0 };
      for (const n of picks) {
        const base = shots['顺推'][n]; const row = { hash: sha(base.v), jumpHash: sha(shots['新页新建'][n].v), rawSame: true, same: true, differ: {} };
        for (const kind of kinds) {
          const other = shots[kind][n]; if (other === undefined || other.r === base.r) continue;
          row.rawSame = false;
          const pixels = await pixelDiff(base.r, other.r);
          if (other.v === base.v && pixels.pixels === 0) continue;
          row.same = false;
          const d = describeDiff(base.v, other.v, layerNames);
          row.differ[kind] = { visibleSame: other.v === base.v, pixels, layers: d.layers, at: d.at, a: d.a, b: d.b };
          fs.writeFileSync(path.join(OUT, `${name}-${mode}-${n}-顺推.svg`), base.r); fs.writeFileSync(path.join(OUT, `${name}-${mode}-${n}-${kind}.svg`), other.r);
        }
        if (row.rawSame) tally.rawSame++; if (row.same) tally.same++;
        perN[n] = row;
      }
      // 给人看的图
      const showN = name === 'fixture' && ['off', 'seed', 'expr'].includes(mode) ? 21 : name === 'textrandom' && ['off', 'exprframe', 'expr'].includes(mode) ? 45 : name === 'happy2016' && mode === 'both' ? picks[picks.length - 1] : null;
      if (showN !== null) for (const kind of ['顺推', '新页新建']) fs.writeFileSync(path.join(OUT, `看-${name}-${MODE_NAME[mode]}-第${showN}帧-${kind}.png`), Buffer.from(await call(tool, 'png', shots[kind][showN].r), 'base64'));
      let twiceSame = twice[0].r === twice[1].r;
      if (!twiceSame) twiceSame = twice[0].v === twice[1].v && (await pixelDiff(twice[0].r, twice[1].r)).pixels === 0;
      const result = {
        seed: first.seed, exact: first.exact, rewritten: first.rewritten, asyncLoad: first.asyncLoad, layers: first.layers, built: first.built, buildMs: first.buildMs, frameMs,
        allSame: tally.same === picks.length, rawSameCount: tally.rawSame, sameCount: tally.same, twice: { n: twiceN, same: twiceSame }, perN,
        // 建一份并顺推到最大的 N,全页那一串被吃掉几个(-1:超出参照的 4000 个)
        globalDraws: before0 < 0 || afterSeq < 0 ? -1 : afterSeq - before0 - 1,
        ms: Date.now() - started,
      };
      entry.modes[mode] = result;
      const label = `${name}/${MODE_NAME[mode]}`;
      if (first.built !== first.layers) fail(`${label}:建好后只建了 ${first.built}/${first.layers} 个图层`);
      if (!isExpr(mode) && !contrast && first.rewritten !== null) fail(`${label}:没开开关三却改写了表达式`);
      if (first.asyncLoad !== (name === 'fixtureasync')) fail(`${label}:建实例那一下${first.asyncLoad ? '还没装载完' : '已经装载完'},和预期相反`);
      const worst = (n) => Object.entries(perN[n].differ).map(([k, d]) => `${k}:${d.pixels.pct}%/${d.pixels.max}${d.layers ? `(${d.layers.join(',')})` : ''}`).join(' ');
      const bad = picks.filter((n) => !perN[n].same);
      const mustMatch = !contrast && (mode === 'both' || mode === 'exprboth' || ((mode === 'seed' || mode === 'expr') && isFixture));
      if (mustMatch) for (const n of bad) fail(`${label}:第 ${n} 帧和「顺推」不同 —— ${worst(n)}`);
      if (mode !== 'off' && !contrast) {
        if (!twiceSame) fail(`${label}:连建两次,第 ${twiceN} 帧不同`);
        if (result.globalDraws !== 0) fail(`${label}:全页那一串被吃掉 ${result.globalDraws} 个(应为 0)`);
        if (first.seed === null) fail(`${label}:素材种子没算出来`);
        if ((mode === 'both' || mode === 'exprboth') && first.exact !== true) fail(`${label}:开关二没生效`);
        if (isExpr(mode) && !(first.rewritten >= expressions.all)) fail(`${label}:改写了 ${first.rewritten} 处表达式,素材里有 ${expressions.all} 个`);
      }
      console.log(`${label}:${picks.length} 个 N 里 ${tally.same} 个各份画面相同(原文也逐字节相同的 ${tally.rawSame} 个);连建两次${twiceSame ? '相同' : '不同'};全页那一串被吃掉 ${result.globalDraws} 个;图层 ${first.built}/${first.layers};建一份 ${first.buildMs} 毫秒,跳一帧 ${frameMs} 毫秒${first.seed === null ? '' : `;种子 ${first.seed}`}`);
      for (const n of bad) console.log(`     第 ${n} 帧不同(画面名:不同的像素占比/最大差(哪些图层)) ${worst(n)}`);
    }

    // 不带随机表达式的素材:加上开关二以后的画面,是不是就是现在(关着)新开页面直接跳拿到的那一份
    if (noRandom) {
      entry.equalsOffJump = {};
      for (const mode of ['both', 'exprboth']) {
        const same = picks.filter((n) => entry.modes[mode].perN[n].hash === entry.modes.off.perN[n].jumpHash).length;
        entry.equalsOffJump[mode] = { same, of: picks.length };
        console.log(`${name} /「${MODE_NAME[mode]}」的画面和「关」下新页新建直接跳的画面比:${picks.length} 个 N 里 ${same} 个看得见的文本逐字节相同`);
      }
    }

    // 全长逐帧:开着的各种开法各和「关」比
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
        const px = Object.entries(pixels).map(([f, d]) => `第 ${f} 帧 ${d.pixels} 个像素(${d.pct}%,最多差 ${d.max})`).join(';');
        console.log(`${name} / 全长 ${total} 帧,「${MODE_NAME[mode]}」和「关」比:${changed.length ? `${changed.length} 帧变了(${changed.length > 14 ? `${changed.slice(0, 14).join(',')}…` : changed.join(',')})${px ? `;${px}` : ''}` : '逐帧相同'}`);
        if ((mode === 'seed' || mode === 'expr') && noRandom && changed.length) fail(`${name}:不带随机表达式,「${MODE_NAME[mode]}」却让 ${changed.length} 帧变了`);
      }
    }
  }

  // ── 不带随机表达式的素材顺推和直接跳为什么还会差一点(只报告;清插值缓存那一项是实验,不是原型的一部分)──
  if (ASSETS.includes('happy2016')) {
    const name = 'happy2016'; const { picks } = report.assets[name];
    const frames = Array.from({ length: Math.max(...picks) + 1 }, (_, i) => i);
    const rows = [];
    for (const [label, mode, cold] of [['只开种子', 'seed', false], ['种子,另外每帧清插值缓存', 'seed', true], ['种子+不留旧数(开关二)', 'both', false]]) {
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
      console.log(`happy2016 / 为什么还差一点 /「${label}」:${picks.length} 个 N 里顺推和直接跳看得见的文本相同的 ${same} 个;像素最多 ${pixelsMax} 个不同(${pctMax}%,最多差 ${diffMax});带关键帧的属性 ${props} 个`);
    }
    report.floatExperiment = rows;
  }

  // ── 表达式用例(exprcases):「关」「种子」「替换」下各图层的数 ──
  if (ASSETS.includes('exprcases')) {
    const frames = Array.from({ length: 15 }, (_, i) => 28 + i);
    const AMP = 160; // wiggle-only 那一层写的是 wiggle(5, 160)
    const section = { frames, modes: {} };
    const X = 4, Y = 5, O = 6;
    const col = (rows, layer, k) => frames.map((f) => rows[f][layer][k]);
    const varies = (xs) => new Set(xs).size > 1;
    const maxStep = (xs) => Math.max(...xs.slice(1).map((x, i) => Math.abs(x - xs[i])));
    for (const mode of ['off', 'seed', 'expr']) {
      // 各读两遍(两个新页面):同一种开法下两遍应当一样
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
        // 同一个表达式里先 seedRandom(3, true) 再 wiggle(5, 100)
        seededWiggle: { x: col(a, 'seeded-wiggle', X), maxStep: +Math.max(maxStep(col(a, 'seeded-wiggle', X)), maxStep(col(a, 'seeded-wiggle', Y))).toFixed(4) },
        seedTimeless: col(a, 'seed-timeless', O), seedTimed: col(a, 'seed-timed', O),
        // 同一个合成放的两份:里面那两层各自的 x
        twin: { random: [col(a, 'twin-random', X), col(a, 'twin-random#2', X)], wiggle: [col(a, 'twin-wiggle', X), col(a, 'twin-wiggle#2', X)] },
        pv, runtime, gauss,
      };
      section.modes[mode] = row;
      const label = `表达式用例/${MODE_NAME[mode]}`;
      const r3 = (xs) => xs.slice(2, 13).map((x) => x.toFixed(1)).join(' ');
      const twinApart = (pair) => frames.filter((f, i) => pair[0][i] !== pair[1][i]).length;
      console.log(`${label}:两遍${row.repeat ? '相同' : '不同'};wiggle-only 第 30～40 帧的 x:${r3(wx)};相邻帧最多差 ${row.wiggle.maxStep};先 seedRandom 再 wiggle 的那一层相邻帧最多差 ${row.seededWiggle.maxStep}`);
      console.log(`${label}:连调两次 random 的两个数(第 30 帧)${row.twice.x[2].toFixed(2)} / ${row.twice.y[2].toFixed(2)};Math.random 的 x 第 30～32 帧 ${row.mathRandom.slice(2, 5).map((x) => x.toFixed(2)).join(' ')};同名变量那一层 x 都是 ${[...new Set(row.shadowed)].join(',')}`);
      console.log(`${label}:seedRandom(7, true) 的透明度${varies(row.seedTimeless) ? '随时间变' : '不随时间变'}(第 30 帧 ${row.seedTimeless[2].toFixed(4)});seedRandom(7) 的透明度${varies(row.seedTimed) ? '随时间变' : '不随时间变'}(第 30～32 帧 ${row.seedTimed.slice(2, 5).map((x) => x.toFixed(4)).join(' ')})`);
      console.log(`${label}:同一个合成放两份,${frames.length} 帧里两份不同的帧数——random 那层 ${twinApart(row.twin.random)},wiggle 那层 ${twinApart(row.twin.wiggle)}(第 30 帧 random ${row.twin.random[0][2].toFixed(1)} / ${row.twin.random[1][2].toFixed(1)});表达式里用 gaussRandom:${gauss ?? '没报错'}`);
      // 三种开法下都该成立的
      if (!row.shadowed.every((x) => x === 600)) fail(`${label}:表达式里自己声明了同名的 random、wiggle,x 应恒为 600,读到 ${[...new Set(row.shadowed)].join(',')}`);
      if (!pv.static || pv.static.maxDiff !== 0 || pv.static.same !== false) fail(`${label}:不带关键帧的多维属性,this.pv 应当是 value 取单精度(且不是同一个对象),读到 ${JSON.stringify(pv.static)}`);
      if (!pv.keyed || pv.keyed.same !== true) fail(`${label}:带关键帧的属性,this.pv 和 value 应当是同一个对象,读到 ${JSON.stringify(pv.keyed)}`);
      if (runtime.installed !== (mode === 'expr')) fail(`${label}:卡片自己的随机函数${runtime.installed ? '装上了' : '没装上'},和预期相反`);
      if (!gauss || !/gaussRandom/.test(gauss)) fail(`${label}:表达式里用 gaussRandom 应当照播放库的方式失败(报它没定义),读到 ${gauss}`);
      if (mode === 'off') continue;
      // 开着时:两遍相同
      if (!row.repeat) fail(`${label}:两个新页面读到的数不同`);
      if (mode !== 'expr') continue;
      // 「替换」要守的:数固定,观感和播放库现在的一样
      if (gauss !== section.modes.off.gauss) fail(`${label}:表达式里用 gaussRandom,开着报「${gauss}」,关着报「${section.modes.off.gauss}」,应当一样`);
      if (!frames.every((f, i) => row.twice.x[i] !== row.twice.y[i])) fail(`${label}:一个表达式里连调两次 random,有的帧两个数相同`);
      if (!varies(row.twice.x) || !varies(row.mathRandom)) fail(`${label}:random / Math.random 的数不随帧变`);
      if (!row.mathRandom.every((x) => x >= 300 && x < 1300)) fail(`${label}:Math.random 的 x 出了 300～1300`);
      // wiggle 照旧逐帧跳:相邻帧的差应当远超过「连续」时的上限(幅度的六分之一),和关着时一个量级
      if (!(row.wiggle.maxStep > AMP)) fail(`${label}:wiggle 相邻帧最多只差 ${row.wiggle.maxStep},不像逐帧各取各的(关着时 ${section.modes.off.wiggle.maxStep})`);
      // 同一个表达式里先 seedRandom 再 wiggle:照播放库现在的,接着不带时间的那一串取,随时间连续(每帧最多走幅度的六分之一)
      if (!(row.seededWiggle.maxStep <= 100 / 6 + 0.001)) fail(`${label}:先 seedRandom 再 wiggle(5, 100) 的那一层相邻帧差 ${row.seededWiggle.maxStep},超过 ${(100 / 6).toFixed(2)};播放库现在是连续的(关着时 ${section.modes.off.seededWiggle.maxStep})`);
      if (varies(row.seedTimeless)) fail(`${label}:seedRandom(7, true) 的值随时间变了`);
      if (varies(row.seedTimed)) fail(`${label}:seedRandom(7) 的值随时间变了(播放库现在不看第二个参数,不变)`);
      if (twinApart(row.twin.random) !== frames.length || twinApart(row.twin.wiggle) < frames.length - 1) fail(`${label}:同一个合成放两份,两份应当各动各的;不同的帧数 random ${twinApart(row.twin.random)}、wiggle ${twinApart(row.twin.wiggle)}(共 ${frames.length} 帧)`);
      if (!(runtime.gives === 4 && runtime.repeatable && runtime.mathKeepsRest)) fail(`${label}:卡片自己的随机函数直接调的结果不对 ${JSON.stringify(runtime)}`);
    }
    // 只有 wiggle 的表达式跟在别的表达式的 seedRandom 后面求值时(fixture 的 wiggle-pos 就是):播放库现在让它接着那一串取,
    // 看起来是连续的(每帧最多走幅度的六分之一)。「替换」下也得是这样
    if (ASSETS.includes('fixture')) {
      const late = Array.from({ length: 15 }, (_, i) => 42 + i); const steps = {};
      for (const mode of ['off', 'seed', 'expr']) { const p = await open(); const m = await call(p, 'make', 'fixture', mode); const rows = await call(p, 'readLayers', m.id, late); await p.close(); const xs = late.map((f) => rows[f]['wiggle-pos'][X]); steps[mode] = +Math.max(...xs.slice(1).map((x, i) => Math.abs(x - xs[i]))).toFixed(2); }
      section.wiggleAfterSeeded = steps;
      if (!(steps.expr <= AMP / 6 + 0.001)) fail(`表达式用例/替换:fixture 的 wiggle-pos 排在别的表达式的 seedRandom 后面求值,播放库现在是连续的(相邻帧最多差 ${steps.off}),开着却差 ${steps.expr}`);
      console.log(`表达式用例 / fixture 的 wiggle-pos(每帧排在一个 seedRandom(7, true) 的表达式后面求值)第 42～56 帧相邻帧最多差:关 ${steps.off},种子 ${steps.seed},替换 ${steps.expr}`);
    }
    // 开关一和开关三叠着开(再加开关二):表达式已经不用播放库那一串了,画面应当和只开开关三(加开关二)一样
    if (ASSETS.includes('fixture')) {
      const ns = [9, 21, 41]; let same = 0;
      for (const n of ns) { const p = await open(); const m = await call(p, 'make', 'fixture', 'all'); const shot = await call(p, 'jump', m.id, n); await p.close(); if (sha(shot.v) === report.assets.fixture.modes.exprboth.perN[n].hash) same++; }
      section.stacked = { same, of: ns.length };
      if (same !== ns.length) fail(`表达式用例:三个开关都开,fixture ${ns.length} 个 N 里只有 ${same} 个和「替换+不留旧数」相同`);
      console.log(`表达式用例 / 三个开关都开:fixture 第 ${ns.join('、')} 帧,${same}/${ns.length} 和「替换+不留旧数」的画面相同`);
    }
    // 交替画帧:三份开着正式那一组的实例(其中两份是同一个素材、错开 11 帧)加一份关着的,轮流各跳一帧
    if (ASSETS.includes('fixture')) {
      const steps = [...Array.from({ length: 26 }, (_, i) => 20 + i), 30, 22, 44];
      const specs = [{ name: 'fixture', mode: 'exprboth', offset: 0 }, { name: 'exprcases', mode: 'exprboth', offset: 3 }, { name: 'fixture', mode: 'exprboth', offset: 11 }, { name: 'fixture', mode: 'off', offset: 5 }];
      let p = await open(); const together = await call(p, 'alternate', specs, steps); await p.close();
      const rows = [];
      for (let i = 0; i < 3; i++) {
        p = await open(); const [alone] = await call(p, 'alternate', [specs[i]], steps); await p.close();
        const same = steps.filter((f, k) => alone[k] === together[i][k]).length;
        rows.push({ name: specs[i].name, offset: specs[i].offset, same, of: steps.length });
        if (same !== steps.length) fail(`交替画帧:${specs[i].name}(错开 ${specs[i].offset} 帧)${steps.length} 步里只有 ${same} 步和单独画时相同`);
      }
      section.alternate = rows;
      console.log(`交替画帧 / 三份「替换+不留旧数」的实例加一份关着的轮流各跳一帧(${steps.length} 步):和单独画时相同的步数 ${rows.map((r) => `${r.name}+${r.offset} ${r.same}/${r.of}`).join(',')}`);
      // 绕过去:直接调播放库的 goToAndStop,表达式不在卡片包住的那一段里求值
      const late = Array.from({ length: 15 }, (_, i) => 42 + i); const runs = [];
      for (let k = 0; k < 2; k++) { p = await open(); const m = await call(p, 'make', 'fixture', 'expr'); runs.push(await call(p, 'bypass', m.id, late)); await p.close(); }
      p = await open(); const normal = await call(p, 'make', 'fixture', 'expr'); const shots = await call(p, 'seq', normal.id, late, late); await p.close();
      const repeat = runs[0].every((v, k) => v === runs[1][k]); const differ = late.filter((f, k) => runs[0][k] !== shots[f].v).length;
      section.bypass = { repeat, differFromNormal: differ, of: late.length };
      if (!repeat) fail('绕过去:直接调播放库的 goToAndStop,两个新页面读到的画面不同');
      console.log(`绕过去 / fixture 开着「替换」但直接调播放库的 goToAndStop(第 42～56 帧):两个新页面${repeat ? '相同' : '不同'};和正常跳帧比 ${differ}/${late.length} 帧不同`);
    }
    report.exprCases = section;
  }

  // ── 真卡片 ──
  const inlineParams = { json: dataText('fixture'), src: '', speed: 1, loop: 'no', fit: 'contain' };
  const srcParams = (name) => ({ json: '', src: `/lottie-data/${name}.json`, speed: 1, loop: 'no', fit: 'contain' });
  /** 开着:直接挂在第 N 帧、挂在第 0 帧再一帧帧推到第 N 帧、前面先挂一张取随机数的卡,都要和 loadLottie 直接跳的那一份相同 */
  const cardOn = async (label, query, wantSwitches, params, rate, ns, asset, mode) => {
    const rows = [];
    for (const n of ns) {
      const want = report.assets[asset].modes[mode].perN[n].hash; const row = { n, want };
      let p = await open(query); row.switches = await call(p, 'switches'); const directShot = await call(p, 'mountCard', 'current', params, n / rate, 0); row.direct = sha(directShot.v); await p.close();
      p = await open(query); let last = await call(p, 'mountCard', 'current', params, 0, 0); for (let f = 1; f <= n; f++) last = await call(p, 'cardFrame', f / rate); row.pushed = sha(last.v); await p.close();
      p = await open(query); row.afterOther = sha((await call(p, 'mountCard', 'current', params, n / rate, 13)).v); await p.close();
      row.same = row.switches.seed === wantSwitches.seed && row.switches.exact === wantSwitches.exact && row.switches.expr === !!wantSwitches.expr && row.direct === want && row.pushed === want && row.afterOther === want;
      if (!row.same) {
        // 不同在哪:再用 loadLottie 建一份直接跳,和「直接挂」的那一份比
        p = await open(); const m = await call(p, 'make', asset, mode); const ref = await call(p, 'jump', m.id, n); await p.close();
        row.diff = { ...describeDiff(ref.v, directShot.v, asset.startsWith('fixture') ? FIXTURE_LAYERS : null), pixels: await pixelDiff(ref.r, directShot.r) };
        fail(`真卡片/${label}:第 ${n} 帧 直接挂 ${row.direct}、推过来 ${row.pushed}、别的卡在前 ${row.afterOther},应为 ${want}(开关读到 ${JSON.stringify(row.switches)});直接挂和 loadLottie 直接跳比:${row.diff.pixels.pct}% 的像素不同${row.diff.layers ? `,图层 ${row.diff.layers.join(',')}` : ''};${row.diff.a} ‖ ${row.diff.b}`);
      }
      rows.push(row);
    }
    console.log(`真卡片 / ${label}(地址带 ${query || '(什么都不带)'}):第 ${ns.join('、')} 帧,直接挂、从第 0 帧推过来、别的卡在前 —— ${rows.every((r) => r.same) ? '都和 loadLottie 直接跳的那一份相同' : '有不同'}`);
    return rows;
  };
  if (ASSETS.includes('fixture')) report.card.seed = await cardOn('种子,fixture(内联 JSON)', '?lottieSeed=1&lottieExpr=0&lottieExact=0', { seed: true, exact: false }, inlineParams, 30, [9, 21, 41, 59], 'fixture', 'seed');
  // 装载是异步的那一份:卡片在装载完成之前就调过一次跳帧,播放库装完那一下画的就是那一帧
  if (ASSETS.includes('fixtureasync')) report.card.seedAsync = await cardOn('种子,fixtureasync(内联 JSON,装载是异步的)', '?lottieSeed=1&lottieExpr=0&lottieExact=0', { seed: true, exact: false }, { ...inlineParams, json: dataText('fixtureasync') }, 30, [21, 41], 'fixtureasync', 'seed');
  if (ASSETS.includes('fixtureip')) report.card.seedIp = await cardOn('种子,fixtureip(内联 JSON,起点不在第 0 帧)', '?lottieSeed=1&lottieExpr=0&lottieExact=0', { seed: true, exact: false }, { ...inlineParams, json: dataText('fixtureip') }, 30, [0, 2, 17], 'fixtureip', 'seed');
  // 开关三:同样三份
  if (ASSETS.includes('fixture')) report.card.expr = await cardOn('替换,fixture(内联 JSON)', '?lottieExpr=1&lottieExact=0', { seed: false, exact: false, expr: true }, inlineParams, 30, [9, 21, 41, 59], 'fixture', 'expr');
  if (ASSETS.includes('fixtureasync')) report.card.exprAsync = await cardOn('替换,fixtureasync(内联 JSON,装载是异步的)', '?lottieExpr=1&lottieExact=0', { seed: false, exact: false, expr: true }, { ...inlineParams, json: dataText('fixtureasync') }, 30, [21, 41], 'fixtureasync', 'expr');
  if (ASSETS.includes('fixtureip')) report.card.exprIp = await cardOn('替换,fixtureip(内联 JSON,起点不在第 0 帧)', '?lottieExpr=1&lottieExact=0', { seed: false, exact: false, expr: true }, { ...inlineParams, json: dataText('fixtureip') }, 30, [0, 2, 17], 'fixtureip', 'expr');
  if (ASSETS.includes('textrandom')) {
    report.card.exprText = await cardOn('替换,textrandom(内联 JSON,随机顺序的文字)', '?lottieExpr=1&lottieExact=0', { seed: false, exact: false, expr: true }, { ...inlineParams, json: dataText('textrandom') }, 30, [15, 31, 45], 'textrandom', 'expr');
    report.card.seedText = await cardOn('种子,textrandom(内联 JSON,随机顺序的文字)', '?lottieSeed=1&lottieExpr=0&lottieExact=0', { seed: true, exact: false }, { ...inlineParams, json: dataText('textrandom') }, 30, [15, 31, 45], 'textrandom', 'seed');
  }
  if (ASSETS.includes('happy2016')) {
    const a = report.assets.happy2016;
    report.card.exprBoth = await cardOn('替换+不留旧数,happy2016(src 加载)', '?lottieExpr=1&lottieExact=1', { seed: false, exact: true, expr: true }, srcParams('happy2016'), a.fr, [a.picks[4], a.picks[a.picks.length - 1]], 'happy2016', 'exprboth');
    report.card.both = await cardOn('种子+不留旧数,happy2016(src 加载)', '?lottieSeed=1&lottieExact=1&lottieExpr=0', { seed: true, exact: true }, srcParams('happy2016'), a.fr, [a.picks[4], a.picks[a.picks.length - 1]], 'happy2016', 'both');
  }
  // 缺省(地址上什么都不带):就是正式的一组「替换+不留旧数」
  {
    const dflt = { seed: false, exact: true, expr: true };
    if (ASSETS.includes('fixture')) report.card.dflt = await cardOn('缺省,fixture(内联 JSON)', '', dflt, inlineParams, 30, [9, 21, 41, 59], 'fixture', 'exprboth');
    if (ASSETS.includes('fixtureasync')) report.card.dfltAsync = await cardOn('缺省,fixtureasync(内联 JSON,装载是异步的)', '', dflt, { ...inlineParams, json: dataText('fixtureasync') }, 30, [21, 41], 'fixtureasync', 'exprboth');
    if (ASSETS.includes('fixtureip')) report.card.dfltIp = await cardOn('缺省,fixtureip(内联 JSON,起点不在第 0 帧)', '', dflt, { ...inlineParams, json: dataText('fixtureip') }, 30, [0, 2, 17], 'fixtureip', 'exprboth');
    if (ASSETS.includes('textrandom')) report.card.dfltText = await cardOn('缺省,textrandom(内联 JSON,随机顺序的文字)', '', dflt, { ...inlineParams, json: dataText('textrandom') }, 30, [15, 31, 45], 'textrandom', 'exprboth');
    if (ASSETS.includes('happy2016')) { const a = report.assets.happy2016; report.card.dfltHappy = await cardOn('缺省,happy2016(src 加载)', '', dflt, srcParams('happy2016'), a.fr, [a.picks[4], a.picks[a.picks.length - 1]], 'happy2016', 'exprboth'); }
  }
  // 关着(地址带 lottieExpr=0&lottieExact=0):和 --before 那个提交的卡片逐帧原文相同(内联 JSON 的 fixture,和走 src 加载的 navidad)
  {
    const cases = [];
    if (ASSETS.includes('fixture')) cases.push(['fixture(内联 JSON)', inlineParams, 30, 30]);
    if (ASSETS.includes('exprcases')) cases.push(['exprcases(内联 JSON)', { ...inlineParams, json: dataText('exprcases') }, 20, 30]);
    if (ASSETS.includes('textrandom')) cases.push(['textrandom(内联 JSON)', { ...inlineParams, json: dataText('textrandom') }, 45, 30]);
    if (ASSETS.includes('navidad')) cases.push(['navidad(src 加载)', srcParams('navidad'), 12, 25]);
    report.card.off = [];
    for (const [label, params, count, rate] of cases) {
      const seqs = {};
      for (const which of ['before', 'current']) {
        const p = await open('?lottieExpr=0&lottieExact=0'); const switches = await call(p, 'switches'); if (switches.seed || switches.exact || switches.expr) fail(`真卡片/关:地址带 lottieExpr=0&lottieExact=0 时读到 ${JSON.stringify(switches)}`);
        // 关着比的是原文:连看不见的图层上留着的旧属性也要一样
        const out = [sha((await call(p, 'mountCard', which, params, 0, 0)).r)];
        for (let f = 1; f < count; f++) out.push(sha((await call(p, 'cardFrame', f / rate)).r));
        // 再往回跳一次、往前跳一次
        out.push(sha((await call(p, 'cardFrame', 3 / rate)).r)); out.push(sha((await call(p, 'cardFrame', (count + 5) / rate)).r));
        seqs[which] = out; await p.close();
      }
      const equal = seqs.before.filter((h, i) => h === seqs.current[i]).length;
      report.card.off.push({ label, frames: seqs.before.length, equal });
      if (equal !== seqs.before.length) fail(`真卡片/关:${label} 和 ${BEFORE} 的卡片 ${seqs.before.length} 帧里只有 ${equal} 帧相同`);
      console.log(`真卡片 / 关:${label} 和 ${BEFORE} 的卡片比,${seqs.before.length} 帧里 ${equal} 帧原文逐字节相同`);
    }
  }
  await tool.close();
  if (report.pageErrors.length) fail(`页面报错或警告 ${report.pageErrors.length} 条:${report.pageErrors.slice(0, 3).join(' | ')}`);
} catch (e) {
  fail(`探针自己出错:${String(e?.stack ?? e).slice(0, 600)}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  await vite.close().catch(() => {});
}
report.ms = Date.now() - t0;
fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(report, null, 2));
console.log(`机器:${report.host.cpu},${report.host.logicalCores} 个逻辑核;${report.chrome};lottie-web ${report.lottieWeb};用时 ${(report.ms / 1000).toFixed(1)} 秒;结果 ${path.join(OUT, 'result.json')}`);
console.log(JSON.stringify({ ok: report.fails.length === 0, fails: report.fails }));
process.exitCode = report.fails.length ? 1 : 0;
