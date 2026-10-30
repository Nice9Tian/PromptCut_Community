/**
 * 核对:有状态的卡(motion 式)在在线页面的后台舞台里,「顺着做到第 N 帧」和「从头推到第 N 帧」生成的快照是不是一样;
 * 同一帧从头推几次,是不是每次都一样。
 * 出处:`docs/plan/render-refactor-task.md`「甲一」里留下的两件核对;口径见 `docs/plan/render-standard.md`
 * 「实验:motion 式的卡跳到第 N 帧要多久」。
 *
 *   node scripts/probes/stateful-seq-vs-jump-probe.mjs [--dist dist-online] [--port-base 7430]
 *        [--cards <卡片 id,逗号分隔>]         缺省是当时核对的那 14 张有状态的内置卡(见下面 DEFAULT_CARDS)
 *        [--frames <帧号,逗号分隔>]           要核对的帧。缺省 6,12,18,24,30,45,60,90,150,180,240,300,497,540:前八个落在多数卡
 *                                             还在动的头 3 秒里,后六个是第 5、6、8、10、16.57、18 秒(30 帧/秒)
 *        [--seconds 20] [--fps 30]            片段多长、工程的帧率(25 帧/秒时每帧 40 毫秒,是个整数,逐帧累加时间没有浮点误差,拿来做对照)
 *        [--repeat 2]                         每一帧从头推几次(核对「每次都一样」;要证明稳定用 5)
 *        [--seq-repeat 1]                     顺着做几遍(大于 1 时另核对顺着做的几遍互相一样)
 *        [--no-pixels]                        不做像素比对(缺省:快照不逐节点相同的每一对,都各贴一次截图比像素)
 *        [--trace]                            记下每条动画「被拨到结尾」与「结束事件送到」的时刻、卡片里元素换入换出的时刻
 *        [--intervene <名字,逗号分隔>]        实验用的干预,只在探针里往舞台文档装,不改产品代码:
 *                                             sync-finish  动画被拨到结尾后,结束回调当场(同一个微任务检查点里)调用,不等浏览器出帧;
 *                                             exact-steps  舞台时钟推帧时,每一帧的时刻都用「帧号 ÷ 帧率 × 1000」直接算,不逐帧累加;
 *                                             settle       舞台时钟每次推完(生成快照之前),先让出一个排在 React 后面的宏任务,
 *                                                          让卡片在这一帧的回调里排下的 React 更新先提交;
 *                                             real-raf     让舞台文档一直向浏览器要真实的帧(结束事件随真实的帧送到,看它迟到多久)
 *        [--json <文件>] [--out <目录>]        --out 把不相同的快照两份都存下来;再加 --save-all 连相同的也存
 *        [--trace-deep]                       同 --trace,另记舞台每推一帧的时刻、每次经 MessageChannel 发消息的时刻(React 排后续渲染用的就是它)
 *        [--frame-rate]                       开工前量一次:父页和舞台文档各自每秒真的出几帧(结束事件是随真实的帧送到的)
 *        [--verbose]                          每一步写一行到 stderr
 *
 * 要先有在线构建:`npx vite build --mode online`(产出 `dist-online/`)。
 *
 * 2026-10-13 起产品代码已经照 sync-finish、exact-steps、settle 这三样改了(`src/render/pinAnimations.ts`、`src/render/stageClock.ts`、
 * `src/StageView.tsx` 的 `bakeFrame`;`docs/archive/agent-reports/AGENT-rr-push-exact.md`):**不带任何干预跑,应当退出 0**。这三样干预留着,
 * 只为在改之前的构建上复现当时的拆解;在现在的构建上再加它们没有意义(`exact-steps` 还会把舞台时钟的函数换掉)。
 * 改前改后各条路逐帧差多少,见 `stage-push-before-after-probe.mjs`。
 *
 * 做法:同 `stateful-seek-cost-probe.mjs`,起静态服务(父页一个源、舞台另一个源,和线上的双舞台同形),父页照 stageRpc
 * 协议把后台舞台切到生成快照的活,灌进一个只有一张卡的工程,调产品自己的 `bakeFrame`。每张卡重新载入一次舞台,互不影响。
 *
 *   顺着做     第 0、1、2…帧连着要,每帧接着上一帧推一步、生成一张快照;留下要核对的那几帧。
 *   从头推     每次先 `bakeCancel`(忘掉上一帧),再要第 N 帧:舞台重新挂载这张卡,从挂载帧一步一步推到第 N 帧,只在第 N 帧生成快照。
 *
 * 怎么算相同(照当时的口径):两份快照的标签、属性、文本逐字比,内联样式里的数值允许 1e-6 相对误差(`snapshotCompare.mjs`)。
 * 这里把所有不同处都找出来,再分三档。中间一档按不同处的种类写明是哪几样:
 *
 *   相同             没有不同处。
 *   只差……          不同处全部属于下面三样(可以同时有几样),都不是卡片画出来的内容:
 *     提示属性           内联样式里的 `will-change`。生成快照时给「此刻有动画在改这个属性」的元素补的合成层提示
 *                        (`src/render/snapshot/inlineStyles.ts`);当时就是按「不影响画面」算的。
 *     被样式盖住的属性   元素上的某个属性两份不同,但两份的内联样式里都写着同名的样式、值相同(例如 SVG 的 `opacity` 属性一份是 0
 *                        一份是 1,内联样式里都是 `opacity: 1`)。内联样式的优先级高于属性,这个属性不起作用。
 *     自动编号           React 自动生成的元素编号(`useId`,形如 `_r_3t_`):每重新挂载一次就换一个号,引用它的地方跟着一起换。
 *                        把编号按出现顺序重排以后两份相同。
 *   画面不同         其余。
 *
 * 后两档的每一对快照,都再各贴进同一个页面截一张图比像素(缺省开),报告里写差了多少像素。给了 --out 时,像素不同的两张图
 * 和一张标出差异位置的图(差值放大 8 倍)存进去。像素比对放在所有卡都做完以后:
 * 对照页是另一个标签页,一打开,父页就成了后台标签页,浏览器把它的定时器降到每秒一次,舞台推一帧就要一秒。
 *
 * 退出码:所有卡的所有帧都落在前两档、且同一帧从头推的几次互相都落在前两档,退出 0;有「画面不同」退出 1;
 * `bakeFrame` 失败、页面报错退出 1;没有在线构建退出 2。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { PNG } from 'pngjs';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { flagArg, serve, sleep } from './probe-connect.mjs';
import { tokenizeHtml, valuesCloseEnough } from '../../src/render/snapshotCompare.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIST = path.resolve(flagArg('dist', path.join(ROOT, 'dist-online')));
const BASE = Number(flagArg('port-base', '7430'));
/** 2026-10-10 那次核对用的 14 张(当时的命令行原样) */
const DEFAULT_CARDS = ['punch-pill', 'odometer', 'checklist', 'mu-word-rotate', 'mu-typing', 'mu-number-ticker', 'mu-circular-progress',
  'mu-animated-shiny-text', 'growth-curve', 'step-timeline', 'rank-bars', 'type-shift', 'chapter-bar', 'blur-text'];
const CARDS = flagArg('cards', DEFAULT_CARDS.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
const SECONDS = Number(flagArg('seconds', '20'));
const FPS = Math.max(1, Number(flagArg('fps', '30')));
const LAST = SECONDS * FPS - 1;
const FRAMES = [...new Set(flagArg('frames', '6,12,18,24,30,45,60,90,150,180,240,300,497,540').split(',').map(Number))]
  .filter((n) => Number.isInteger(n) && n > 0 && n <= LAST).sort((a, b) => a - b);
const REPEAT = Math.max(1, Number(flagArg('repeat', '2')));
const SEQ_REPEAT = Math.max(1, Number(flagArg('seq-repeat', '1')));
const PIXELS = !process.argv.includes('--no-pixels');
const TRACE_DEEP = process.argv.includes('--trace-deep');
const TRACE = TRACE_DEEP || process.argv.includes('--trace');
const SAVE_ALL = process.argv.includes('--save-all');
const FRAME_RATE = process.argv.includes('--frame-rate');
const INTERVENE = flagArg('intervene', 'none');
const INTERVENTIONS = INTERVENE === 'none' ? [] : INTERVENE.split(',').map((x) => x.trim()).filter(Boolean);
const VERBOSE = process.argv.includes('--verbose');
const JSON_OUT = flagArg('json', null);
const OUT = flagArg('out', null);
if (!fs.existsSync(path.join(DIST, 'stage.html'))) { console.error(`没有在线构建:${DIST}(先跑 npx vite build --mode online)`); process.exit(2); }
if (!FRAMES.length) { console.error('没有要核对的帧'); process.exit(2); }
if (INTERVENTIONS.some((x) => !['sync-finish', 'exact-steps', 'settle', 'real-raf'].includes(x))) { console.error(`不认识的干预:${INTERVENE}`); process.exit(2); }

/* ───────────────────────── 比对 ───────────────────────── */

const decodeEntities = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
/** 内联样式串 → 属性名到值的表。分号只在引号和括号外面才算分隔(`url("data:…;base64,…")`、带引号的字体名里都有分号) */
function styleDecls(text) {
  const s = decodeEntities(String(text ?? ''));
  const out = new Map();
  let depth = 0, quote = '', start = 0;
  const push = (end) => {
    const decl = s.slice(start, end);
    const i = decl.indexOf(':');
    if (i > 0) out.set(decl.slice(0, i).trim(), decl.slice(i + 1).trim());
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (c === ';' && depth === 0) { push(i); start = i + 1; }
  }
  push(s.length);
  return out;
}

/** React 自动生成的元素编号(`useId`):19.2 是 `_r_3t_`,更早的版本是 `:r3t:`、`«r3t»` */
const REACT_ID = /_r_[0-9a-z]+_|:r[0-9a-z]+:|«r[0-9a-z]+»/g;
const renumberIds = (html) => { const seen = new Map(); return html.replace(REACT_ID, (m) => { if (!seen.has(m)) seen.set(m, `_r_#${seen.size}_`); return seen.get(m); }); };

const clip = (v, n = 60) => { const s = String(v ?? '(无)'); return s.length > n ? `${s.slice(0, n)}…` : s; };

/** 两份快照的所有不同处。结构对不上(记号数、标签名)时只报第一处,`structural: true` */
function allDiffs(a, b) {
  if (a === b) return { diffs: [], structural: false };
  const ta = tokenizeHtml(a), tb = tokenizeHtml(b);
  const diffs = [];
  const n = Math.min(ta.length, tb.length);
  let tag = '';
  for (let i = 0; i < n; i++) {
    const x = ta[i], y = tb[i];
    if (x.kind !== y.kind || ((x.kind === 'open' || x.kind === 'close') && x.name !== y.name)) {
      diffs.push({ kind: 'structure', where: `第 ${i} 个记号`, a: x.kind === 'text' ? `文本「${clip(x.text, 20)}」` : `<${x.kind === 'close' ? '/' : ''}${x.name ?? x.kind}>`, b: y.kind === 'text' ? `文本「${clip(y.text, 20)}」` : `<${y.kind === 'close' ? '/' : ''}${y.name ?? y.kind}>` });
      return { diffs, structural: true };
    }
    if (x.kind === 'text' || x.kind === 'comment') { if (x.text !== y.text) diffs.push({ kind: 'text', where: `<${tag}> 里的文本`, a: x.text, b: y.text }); continue; }
    if (x.kind === 'close') continue;
    tag = x.name;
    for (const name of new Set([...x.attrs.keys(), ...y.attrs.keys()])) {
      const va = x.attrs.get(name), vb = y.attrs.get(name);
      if (va === vb) continue;
      if (name.toLowerCase() === 'style') {
        const da = styleDecls(va), db = styleDecls(vb);
        for (const prop of new Set([...da.keys(), ...db.keys()])) {
          const pa = da.get(prop), pb = db.get(prop);
          if (pa === pb || (pa !== undefined && pb !== undefined && valuesCloseEnough(pa, pb))) continue;
          diffs.push({ kind: 'style', where: `<${x.name}> 的样式`, prop, a: pa, b: pb });
        }
      } else {
        // 两份的内联样式里都写着同名的样式、值相同:这个属性被样式盖住,不起作用
        const da = styleDecls(x.attrs.get('style')), db = styleDecls(y.attrs.get('style'));
        const shadowed = da.has(name) && db.has(name) && valuesCloseEnough(da.get(name), db.get(name));
        diffs.push({ kind: shadowed ? 'shadowed' : 'attr', where: `<${x.name}> 的属性`, prop: name, a: va, b: vb });
      }
    }
  }
  if (ta.length !== tb.length) { diffs.push({ kind: 'structure', where: '记号数', a: String(ta.length), b: String(tb.length) }); return { diffs, structural: true }; }
  return { diffs, structural: false };
}

/** 不同处全部属于「提示属性 / 被样式盖住的属性」时,回这几样的集合;有别的不同处回 null */
function benignTags(diffs) {
  const tags = new Set();
  for (const d of diffs) {
    if (d.kind === 'style' && d.prop === 'will-change') tags.add('hint');
    else if (d.kind === 'shadowed') tags.add('shadow');
    else return null;
  }
  return tags;
}
const tagsCls = (tags) => [...tags].sort().join('+');
/** 分档:`same` 相同 / `diff` 画面不同 / 其余是用 + 连起来的几样(`hint` 提示属性、`shadow` 被样式盖住的属性、`ids` 自动编号) */
function classify(a, b) {
  if (a === null || b === null) return { cls: 'diff', diffs: [{ kind: 'structure', where: '快照', a: a === null ? '没拿到' : '有', b: b === null ? '没拿到' : '有' }] };
  const raw = allDiffs(a, b);
  if (!raw.diffs.length) return { cls: 'same', diffs: [] };
  if (!raw.structural) { const tags = benignTags(raw.diffs); if (tags) return { cls: tagsCls(tags), diffs: raw.diffs }; }
  const ra = renumberIds(a), rb = renumberIds(b);
  if (ra !== a || rb !== b) {
    const re = allDiffs(ra, rb);
    if (!re.diffs.length) return { cls: 'ids', diffs: raw.diffs };
    if (!re.structural) { const tags = benignTags(re.diffs); if (tags) { tags.add('ids'); return { cls: tagsCls(tags), diffs: raw.diffs }; } }
    return { cls: 'diff', diffs: re.diffs };
  }
  return { cls: 'diff', diffs: raw.diffs };
}
/** 两档里更重的那一档;都是「只差……」时把各自的几样合起来 */
const worse = (x, y) => {
  if (x === 'diff' || y === 'diff') return 'diff';
  if (x === 'same') return y;
  if (y === 'same') return x;
  return tagsCls(new Set([...x.split('+'), ...y.split('+')]));
};
const TAG_TEXT = { hint: '提示属性', shadow: '被样式盖住的属性', ids: '自动编号' };
const clsText = (c) => (c === 'same' ? '相同' : c === 'diff' ? '画面不同' : `只差${c.split('+').map((t) => TAG_TEXT[t]).join('、')}`);
const diffText = (diffs, limit = 4) => diffs.slice(0, limit).map((d) => `${d.where}${d.prop ? ` ${d.prop}` : ''}:${clip(d.a, 40)} → ${clip(d.b, 40)}`).join(';') + (diffs.length > limit ? `;…共 ${diffs.length} 处` : '');

/* ───────────────────────── 页面 ───────────────────────── */

const projectOf = (cardId) => ({
  id: `sj-${cardId}`, name: '顺着做与从头推对照', width: 1920, height: 1080, fps: FPS, duration: SECONDS,
  themeId: 'dark', media: [], filters: [], pixelMaps: [], audioFx: [], cardNodes: [], style: {},
  tracks: [{ id: 'tr', name: cardId, hidden: false, clips: [{ id: 'clip', kind: 'card', cardId, start: 0, end: SECONDS, params: {} }] }],
});

const PARENT_HTML = `<!doctype html><meta charset=utf-8><title>seq-vs-jump parent</title>
<body style="margin:0"><iframe id=bg style="position:absolute;left:0;top:0;width:960px;height:540px;border:0;opacity:0;pointer-events:none"></iframe>
<script>
let ready = null, stageWin = null, stageOrigin = '*', seq = 0; const waiting = new Map();
const htmlOf = new Map(); const pending = new Set();
window.__html = async (n) => { await Promise.allSettled([...pending]); const h = htmlOf.get(n) ?? null; htmlOf.delete(n); return h; };
addEventListener('message', (e) => {
  const d = e.data || {};
  if (d.type === 'pc-stage-ready') { ready = d.hostCapabilities || {}; return; }
  if (e.source !== stageWin) return;
  if (d.type === 'bake-frame') { const job = (async () => { const html = d.htmlGz ? await new Response(new Blob([d.htmlGz]).stream().pipeThrough(new DecompressionStream('gzip'))).text() : new TextDecoder().decode(d.htmlRaw); htmlOf.set(d.localFrame, html); })(); pending.add(job); job.finally(() => pending.delete(job)); return; }
  if (d.type === 'pc-rpc-reply') { const w = waiting.get(d.id); if (w) { waiting.delete(d.id); d.ok ? w.res(d.result) : w.rej(new Error(d.error)); } }
});
window.__rpc = (method, ...args) => new Promise((res, rej) => { const id = ++seq; waiting.set(id, { res, rej }); stageWin.postMessage({ type: 'pc-rpc', id, method, args }, stageOrigin); });
window.__setup = async (src) => { ready = null; htmlOf.clear(); const f = document.getElementById('bg'); f.src = src; stageWin = f.contentWindow; stageOrigin = new URL(src).origin;
  const t0 = performance.now(); while (!ready) { if (performance.now() - t0 > 60000) throw new Error('舞台 60 秒没就绪'); await new Promise((r) => setTimeout(r, 50)); } stageWin = f.contentWindow; return ready; };
</script>`;

/** 贴快照比像素的页面:带上在线构建的样式表(快照只内联了与缺省值不同的样式,缺省值要和舞台文档一样) */
const stageCss = [...fs.readFileSync(path.join(DIST, 'stage.html'), 'utf8').matchAll(/<link[^>]+rel="stylesheet"[^>]*href="([^"]+)"/g)].map((m) => m[1]);
const REPLAY_HTML = `<!doctype html><meta charset=utf-8><title>seq-vs-jump replay</title>${stageCss.map((h) => `<link rel="stylesheet" href="${h}">`).join('')}
<style>html,body{margin:0;background:transparent}#box{position:absolute;left:0;top:0;width:1920px;height:1080px;overflow:hidden}#box *{animation:none!important;transition:none!important}</style>
<body><div id=box></div>`;

/**
 * 装进舞台文档的记录器(`--trace` / `--intervene` 才装)。只读、不改时间:
 *   - 包住 `Element.prototype.animate`,给每条新建的动画编号、挂一个结束事件的监听;
 *   - 包住 `Animation.prototype.finish`,记下「被拨到结尾」的时刻;
 *   - 用 MutationObserver 记卡片里元素换入换出的时刻。
 * 每条记录带两个时刻:`v` 舞台时间(被接管的 `performance.now`,毫秒)、`r` 真实时间(`__pcRealNow`,毫秒)。
 * 干预 `sync-finish`:`finish()` 之后,在同一个微任务检查点里把这条动画的 `onfinish` 回调调掉(并摘下,免得浏览器出帧时再调一次)。
 * 干预 `exact-steps`:换掉舞台时钟对象上的 `advanceToAsync`(`__pcStageClock`),见函数里的说明。
 * 干预 `settle`:同样换掉 `advanceToAsync`,推完以后等两轮 MessageChannel 消息再返回。
 * 干预 `real-raf`:用舞台留着的原始 `requestAnimationFrame`(`__pcRealRaf`)一直要帧。
 */
function installTracer(interventions, deep) {
  if (window.__sj) { window.__sj.ev.length = 0; return 'again'; }
  const has = (name) => interventions.includes(name);
  const realNow = window.__pcRealNow || performance.now.bind(performance);
  const T = (window.__sj = { ev: [], interventions });
  const push = (k, d) => T.ev.push({ k, v: Math.round(performance.now() * 1000) / 1000, r: Math.round(realNow() * 100) / 100, ...d });
  const ids = new WeakMap(); let next = 0;
  const propOf = (a) => { try { return Object.keys(a.effect?.getKeyframes?.()[0] ?? {}).filter((x) => !['offset', 'easing', 'composite', 'computedOffset'].includes(x)).join(','); } catch { return ''; } };
  const known = (a) => {
    let id = ids.get(a);
    if (!id) { id = ++next; ids.set(a, id); a.addEventListener('finish', () => push('finish-event', { a: id })); }
    return id;
  };
  const animate = Element.prototype.animate;
  Element.prototype.animate = function (...args) {
    const a = animate.apply(this, args);
    try { push('animate', { a: known(a), prop: propOf(a), text: (this.textContent || '').slice(0, 12) }); } catch { /* 记录失败不影响卡片 */ }
    return a;
  };
  const finish = Animation.prototype.finish;
  Animation.prototype.finish = function (...args) {
    const was = this.playState;
    const out = finish.apply(this, args);
    if (was !== 'finished') {
      push('finish-call', { a: known(this) });
      if (has('sync-finish')) {
        queueMicrotask(() => {
          const h = this.onfinish;
          if (typeof h !== 'function') return;
          this.onfinish = null;
          push('finish-forced', { a: known(this) });
          h.call(this, new AnimationPlaybackEvent('finish', { currentTime: this.currentTime, timelineTime: null }));
        });
      }
    }
    return out;
  };
  if (has('exact-steps')) {
    // 舞台时钟的 `advanceToAsync` 是逐帧累加 `1000 / 帧率` 往前走的。这里换成:一帧调一次原来的函数,目标时刻用帧号直接算
    // (和 `bakeFrame` 算目标时刻同一个式子),步长给得很大,原函数每次正好走一帧、落在这个时刻上。帧与帧之间照旧让出一个宏任务。
    const clock = window.__pcStageClock;
    const wait = window.__pcRealSetTimeout || window.setTimeout.bind(window);
    const inner = clock.advanceToAsync.bind(clock);
    clock.advanceToAsync = async (target, opts = {}) => {
      const step = opts.step;
      if (!step || target <= clock.now()) return inner(target, opts);
      const fps = Math.round(1000 / step);
      const from = Math.round(clock.now() / step), to = Math.floor(target / step + 1e-6);
      for (let i = from + 1; i <= to; i++) {
        if (i > from + 1 && opts.yieldEvery) await new Promise((r) => wait(r, 0));
        if (opts.abort?.()) return;
        await inner((i / fps) * 1000, { ...opts, step: 1e12, maxCatchUp: Infinity, yieldEvery: undefined });
      }
      if (clock.now() !== target && !opts.abort?.()) await inner(target, { ...opts, step: 1e12, maxCatchUp: Infinity, yieldEvery: undefined });
    };
  }
  if (has('settle')) {
    // React 把回调里的状态更新排进 MessageChannel 的宏任务。这里在推完之后也发一条消息、等它回来:消息按先后顺序处理,
    // 等到的时候 React 那一条已经跑过了(它提交时又排了后续的,再等一轮)。
    const clock = window.__pcStageClock;
    const inner = clock.advanceToAsync.bind(clock);
    const turn = () => new Promise((r) => { const ch = new MessageChannel(); ch.port1.onmessage = () => { ch.port1.close(); r(); }; ch.port2.postMessage(null); });
    clock.advanceToAsync = async (target, opts = {}) => { await inner(target, opts); await turn(); await turn(); };
  }
  if (has('real-raf')) { const raf = window.__pcRealRaf || window.requestAnimationFrame.bind(window); const loop = () => { push('real-frame', {}); raf(loop); }; raf(loop); }
  if (deep) {
    // 舞台每推一帧(被接管的 requestAnimationFrame 每拍跑一次)记一条;MessageChannel 每发一次消息记一条
    const vloop = (ts) => { push('tick', { raw: ts }); window.requestAnimationFrame(vloop); };
    window.requestAnimationFrame(vloop);
    const post = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function (...args) { push('post', {}); return post.apply(this, args); };
  }
  const label = (n) => `${n.tagName.toLowerCase()}「${(n.textContent || '').slice(0, 12)}」`;
  new MutationObserver((records) => {
    for (const rec of records) {
      if (!(rec.target instanceof Element) || !rec.target.closest('[data-pc-clip]')) continue;
      for (const n of rec.addedNodes) if (n.nodeType === 1) push('dom-add', { el: label(n) });
      for (const n of rec.removedNodes) if (n.nodeType === 1) push('dom-remove', { el: label(n) });
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
  return 'installed';
}

const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.png': 'image/png', '.webp': 'image/webp' };
const handler = (req, res) => {
  const u = new URL(req.url, 'http://x');
  res.setHeader('Origin-Agent-Cluster', '?1');
  res.setHeader('Cache-Control', 'no-store');
  if (u.pathname === '/probe-parent') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(PARENT_HTML); }
  if (u.pathname === '/probe-replay') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(REPLAY_HTML); }
  let p = u.pathname.startsWith('/editor/') ? u.pathname.slice('/editor/'.length) : null;
  if (p === null) { res.statusCode = 404; return res.end(); }
  if (!p) p = 'index.html';
  const file = path.join(DIST, decodeURIComponent(p));
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; return res.end(); }
  res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
  res.end(fs.readFileSync(file));
};

/* ───────────────────────── 跑 ───────────────────────── */

const report = { when: new Date().toISOString(), host: { cpu: os.cpus()[0]?.model?.trim(), logicalCores: os.cpus().length },
  options: { seconds: SECONDS, fps: FPS, frames: FRAMES, repeat: REPEAT, seqRepeat: SEQ_REPEAT, pixels: PIXELS, trace: TRACE, intervene: INTERVENE }, cards: [], failures: [] };
const servers = await Promise.all([serve(BASE, handler, '127.0.0.1'), serve(BASE + 2, handler, '127.0.0.1')]);
if (OUT) fs.mkdirSync(OUT, { recursive: true });
let browser = null;
try {
  const defaults = await puppeteer.defaultArgs({ headless: true });
  // 和别的在线探针一样,去掉 puppeteer 缺省加的「后台不降速」那几项,页面的计时行为和用户手里的浏览器一致
  browser = await puppeteer.launch({ headless: true, defaultViewport: null, protocolTimeout: 900000,
    ignoreDefaultArgs: ['--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', ...defaults.filter((a) => a.startsWith('--disable-features='))],
    args: [...PROBE_CHROME_ARGS, '--window-size=1100,820'] });
  report.chrome = await browser.version();
  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 640 });
  page.on('pageerror', (e) => report.failures.push(`页面报错:${String(e.message || e).slice(0, 160)}`));
  await page.goto(`http://127.0.0.1:${BASE}/probe-parent`, { waitUntil: 'load' });
  await page.bringToFront();

  let replay = null;
  /** 把一份快照贴进对照页截一张图(透明底,1920×1080) */
  const shoot = async (html) => {
    if (!replay) {
      replay = await browser.newPage();
      await replay.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
      await replay.goto(`http://127.0.0.1:${BASE}/probe-replay`, { waitUntil: 'load' });
    }
    await replay.evaluate(async (h) => {
      const box = document.getElementById('box');
      const t = document.createElement('template'); t.innerHTML = h;
      t.content.querySelectorAll('script,iframe,object,embed,base,meta,link').forEach((el) => el.remove());
      box.replaceChildren(t.content);
      await Promise.all([...box.querySelectorAll('img')].map((img) => img.decode().catch(() => {})));
      await document.fonts.ready;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    }, html);
    return Buffer.from(await replay.screenshot({ type: 'png', omitBackground: true, clip: { x: 0, y: 0, width: 1920, height: 1080 } }));
  };
  const pixelDiff = async (a, b, label) => {
    const pa = await shoot(a), pb = await shoot(b);
    if (pa.equals(pb)) return { differ: 0, max: 0 };
    const x = PNG.sync.read(pa), y = PNG.sync.read(pb);
    const mark = new PNG({ width: x.width, height: x.height });
    let differ = 0, max = 0;
    for (let i = 0; i < x.data.length; i += 4) {
      const d = Math.max(Math.abs(x.data[i] - y.data[i]), Math.abs(x.data[i + 1] - y.data[i + 1]), Math.abs(x.data[i + 2] - y.data[i + 2]), Math.abs(x.data[i + 3] - y.data[i + 3]));
      if (d) { differ++; if (d > max) max = d; }
      const v = Math.min(255, d * 8);
      mark.data[i] = v; mark.data[i + 1] = v; mark.data[i + 2] = v; mark.data[i + 3] = 255;
    }
    if (OUT && differ) {
      fs.writeFileSync(path.join(OUT, `${label}-a.png`), pa);
      fs.writeFileSync(path.join(OUT, `${label}-b.png`), pb);
      fs.writeFileSync(path.join(OUT, `${label}-diff.png`), PNG.sync.write(mark));
    }
    return { differ, max };
  };
  /** 一对快照:分档;不逐节点相同的记下来,等所有卡做完再比像素(见文件头) */
  const pixelJobs = [];
  const pair = (a, b, label) => {
    const c = classify(a, b);
    const out = { cls: c.cls, why: c.diffs.length ? diffText(c.diffs) : null };
    if (c.cls !== 'same' && PIXELS && a !== null && b !== null) pixelJobs.push({ out, a, b, label });
    return out;
  };

  const note = (...a) => { if (VERBOSE) console.error(`[${new Date().toISOString().slice(11, 23)}]`, ...a); };
  /** 等待上限只为防卡死(一步最多 5 分钟):到了头算这一步没跑出来 */
  const guard = (what, job) => { let timer; return Promise.race([job, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${what} 5 分钟没有结果`)), 300000); })]).finally(() => clearTimeout(timer)); };
  const stageFrame = () => page.frames().find((f) => f.url().includes('/editor/stage.html')) ?? null;
  const rpc = (method, ...args) => { note('rpc', method, method === 'bakeFrame' ? args[0].localFrame : ''); return guard(`舞台调用 ${method}`, page.evaluate((m, a) => window.__rpc(m, ...a), method, args)); };
  const htmlAt = (n) => page.evaluate((k) => window.__html(k), n);
  const bake = async (cardId, n) => {
    const r = await rpc('bakeFrame', { session: 'sj', clipId: 'clip', localFrame: n, mode: 'seq', small: false });
    if (!r?.ok) { report.failures.push(`${cardId} 第 ${n} 帧:${r?.reason}${r?.detail ? ` ${String(r.detail).slice(0, 80)}` : ''}`); return null; }
    return r;
  };
  const takeTrace = async () => { const f = stageFrame(); if (!f) return []; return guard('取记录', f.evaluate(() => (window.__sj ? window.__sj.ev.splice(0) : []))); };
  /** 记录 → 摘要:每条动画从被拨到结尾到结束事件送到,隔了多少舞台毫秒和真实毫秒;元素换入换出的舞台时刻 */
  const digest = (ev) => {
    const called = new Map(); const lags = []; const swaps = []; let undelivered = 0; let realFrames = 0;
    for (const e of ev) {
      if (e.k === 'real-frame') { realFrames++; continue; }
      if (e.k === 'tick' || e.k === 'post') continue;
      if (e.k === 'finish-call') called.set(e.a, e);
      else if (e.k === 'finish-event' || e.k === 'finish-forced') { const c = called.get(e.a); if (c) { lags.push({ atV: c.v, lagV: +(e.v - c.v).toFixed(1), lagR: +(e.r - c.r).toFixed(1), forced: e.k === 'finish-forced' }); called.delete(e.a); } }
      else if (e.k === 'dom-add' || e.k === 'dom-remove') swaps.push(`${e.v.toFixed(1)}${e.k === 'dom-add' ? '+' : '-'}${e.el}`);
    }
    undelivered = called.size;
    const span = ev.length ? +(ev.at(-1).r - ev[0].r).toFixed(1) : 0;
    return { lags, swaps, undelivered, realFrames, realMs: span, events: ev.filter((e) => e.k !== 'real-frame').slice(0, TRACE_DEEP ? 6000 : 600), realFrameAt: ev.filter((e) => e.k === 'real-frame').map((e) => [e.v, e.r]).slice(0, 2000) };
  };

  for (const cardId of CARDS) {
    // 每张卡重新载入一次舞台:上一张卡留下的东西(挂着的动画、React 的编号计数)带不过来
    note('载入舞台', cardId);
    await guard('载入舞台', page.evaluate((src) => window.__setup(src), `http://127.0.0.1:${BASE + 2}/editor/stage.html?stage=1&id=B&preview=stage&dual=1&lm=0`));
    await sleep(500);
    if (FRAME_RATE && !report.frameRate) {
      // 用各自文档里真实的 requestAnimationFrame 数 1.5 秒(舞台文档的那个被接管了,原始的留在 `__pcRealRaf`)
      const count = () => new Promise((resolve) => {
        const raf = window.__pcRealRaf || window.requestAnimationFrame.bind(window);
        const now = window.__pcRealNow || performance.now.bind(performance);
        const wait = window.__pcRealSetTimeout || window.setTimeout.bind(window);
        let n = 0, on = true; const t0 = now();
        const loop = () => { if (!on) return; n++; raf(loop); };
        raf(loop);
        wait(() => { on = false; resolve(+(n / ((now() - t0) / 1000)).toFixed(1)); }, 1500);
      });
      report.frameRate = { parent: await guard('量出帧', page.evaluate(count)), stage: await guard('量出帧', stageFrame().evaluate(count)) };
      console.log(`真实出帧:父页每秒 ${report.frameRate.parent} 帧,舞台文档每秒 ${report.frameRate.stage} 帧`);
    }
    if (TRACE || INTERVENTIONS.length) { const f = stageFrame(); if (!f) throw new Error('找不到舞台文档'); note('装记录器'); note(await guard('装记录器', f.evaluate(installTracer, INTERVENTIONS, TRACE_DEEP))); }
    await rpc('setRole', 'back', { job: 'bake' });
    await rpc('setProject', projectOf(cardId), { reset: true });
    const row = { cardId, verdict: 'same', frames: [], seqStable: null, traces: [] };
    const top = FRAMES.at(-1);
    // 顺着做
    const seqRuns = [];
    for (let k = 0; k < SEQ_REPEAT; k++) {
      await rpc('bakeCancel');
      await takeTrace();
      const got = new Map();
      for (let n = 0; n <= top; n++) { const b = await bake(cardId, n); if (!b) break; const h = await htmlAt(n); if (FRAMES.includes(n)) got.set(n, h); }
      seqRuns.push(got);
      if (TRACE) row.traces.push({ how: `顺着做第 ${k + 1} 遍`, ...digest(await takeTrace()) });
    }
    if (SEQ_REPEAT > 1) {
      row.seqStable = true;
      for (const n of FRAMES) for (let k = 1; k < SEQ_REPEAT; k++) { const c = classify(seqRuns[0].get(n) ?? null, seqRuns[k].get(n) ?? null); if (c.cls !== 'same') { row.seqStable = false; row.frames.push({ frame: n, how: `顺着做第 1 遍 对 第 ${k + 1} 遍`, cls: c.cls, why: diffText(c.diffs) }); row.verdict = worse(row.verdict, c.cls); } }
    }
    // 从头推
    for (const n of FRAMES) {
      const want = seqRuns[0].get(n) ?? null;
      const jumps = [];
      for (let k = 0; k < REPEAT; k++) {
        await rpc('bakeCancel');
        await takeTrace();
        const b = await bake(cardId, n);
        jumps.push(b ? await htmlAt(n) : null);
        if (TRACE) row.traces.push({ how: `从头推到第 ${n} 帧,第 ${k + 1} 次`, ...digest(await takeTrace()) });
      }
      const entry = { frame: n, sec: +(n / FPS).toFixed(2), vsSeq: [], among: [], cls: 'same', stable: 'same' };
      for (let k = 0; k < REPEAT; k++) { const p = pair(want, jumps[k], `${cardId}-${n}-seq-vs-jump${k + 1}`); entry.vsSeq.push(p); entry.cls = worse(entry.cls, p.cls); }
      for (let k = 1; k < REPEAT; k++) { const p = pair(jumps[0], jumps[k], `${cardId}-${n}-jump1-vs-jump${k + 1}`); entry.among.push(p); entry.stable = worse(entry.stable, p.cls); }
      row.verdict = worse(worse(row.verdict, entry.cls), entry.stable);
      row.frames.push(entry);
      if (OUT && (SAVE_ALL || entry.cls !== 'same' || entry.stable !== 'same')) {
        fs.writeFileSync(path.join(OUT, `${cardId}-${n}-seq.html`), want ?? '');
        jumps.forEach((h, k) => fs.writeFileSync(path.join(OUT, `${cardId}-${n}-jump${k + 1}.html`), h ?? ''));
      }
    }
    report.cards.push(row);
    const brief = row.frames.filter((f) => f.vsSeq).map((f) => `${f.frame}:${clsText(f.cls)}${f.stable !== 'same' ? `(几次从头推之间${clsText(f.stable)})` : ''}`).join(' ');
    console.log(`[${cardId}] ${clsText(row.verdict)}  ${brief}`);
  }
  note(`比像素 ${pixelJobs.length} 对`);
  for (const job of pixelJobs) job.out.pixels = await guard('比像素', pixelDiff(job.a, job.b, job.label));
} catch (e) {
  report.failures.push(`探针自己出错:${String(e?.stack || e).slice(0, 400)}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  for (const s of servers) await new Promise((resolve) => { s.close(() => resolve()); s.closeAllConnections?.(); });
}

if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));

console.log('');
console.log(`机器:${report.host.cpu},${report.host.logicalCores} 个逻辑核;${report.chrome}`);
console.log(`每张卡一个 ${SECONDS} 秒的片段(${FPS} 帧/秒);核对第 ${FRAMES.join('、')} 帧;每帧从头推 ${REPEAT} 次${SEQ_REPEAT > 1 ? `;顺着做 ${SEQ_REPEAT} 遍` : ''}${INTERVENE !== 'none' ? `;干预:${INTERVENE}` : ''}`);
const px = (p) => (p?.pixels ? (p.pixels.differ ? `,像素差 ${p.pixels.differ} 个、最大差 ${p.pixels.max}` : ',像素相同') : '');
for (const c of report.cards) {
  console.log(`卡 ${c.cardId}:${clsText(c.verdict)}${c.seqStable === false ? '(顺着做的几遍互不相同)' : ''}`);
  for (const f of c.frames) {
    if (!f.vsSeq) { console.log(`   第 ${f.frame} 帧 ${f.how}:${clsText(f.cls)}〔${f.why}〕`); continue; }
    if (f.cls === 'same' && f.stable === 'same') continue;
    console.log(`   第 ${f.frame} 帧(${f.sec} 秒):和顺着做比 ${clsText(f.cls)};几次从头推之间 ${clsText(f.stable)}`);
    f.vsSeq.forEach((p, k) => { if (p.cls !== 'same') console.log(`      顺着做 → 第 ${k + 1} 次从头推:${clsText(p.cls)}${px(p)}〔${p.why}〕`); });
    f.among.forEach((p, k) => { if (p.cls !== 'same') console.log(`      第 1 次 → 第 ${k + 2} 次从头推:${clsText(p.cls)}${px(p)}〔${p.why}〕`); });
  }
  if (TRACE) {
    for (const t of c.traces) {
      const lagV = t.lags.map((l) => l.lagV), lagR = t.lags.map((l) => l.lagR);
      const stat = (xs) => (xs.length ? `${Math.min(...xs)}～${Math.max(...xs)}` : '无');
      console.log(`   〔记录〕${t.how}:结束事件 ${t.lags.length} 次,迟到 舞台 ${stat(lagV)} 毫秒 / 真实 ${stat(lagR)} 毫秒${t.undelivered ? `,${t.undelivered} 次到生成快照时还没送到` : ''}${INTERVENTIONS.includes('real-raf') ? `;这一段真实 ${t.realMs} 毫秒里出了 ${t.realFrames} 帧` : ''}`);
      if (t.swaps.length) console.log(`      元素换入(+)换出(-)的舞台时刻:${t.swaps.slice(0, 40).join(' ')}${t.swaps.length > 40 ? ` …共 ${t.swaps.length} 次` : ''}`);
    }
  }
}
const bad = report.cards.filter((c) => c.verdict === 'diff');
if (report.failures.length) console.log(`失败:\n  ${report.failures.join('\n  ')}`);
if (bad.length) console.log(`画面不同的卡:${bad.map((c) => c.cardId).join('、')}`);
if (report.failures.length || bad.length) process.exit(1);
console.log('全部落在「相同」或「只差提示属性、被样式盖住的属性、自动编号」');
