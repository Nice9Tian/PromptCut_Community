/**
 * 生成快照整场景 id 改名的单测:新写法(`renameSceneIds`,线性)与原写法逐字节对拍,外加一条代价用例。
 * 跑:node --test src/render/snapshot/renameSceneIds.test.mjs
 *
 * 对照 `legacySerializeRename` 是改动前 `src/render/createSnapshot.ts` 的 `serializeScene` 里那一段,
 * 原样拷过来(只把 `html` / `ids` 改成参数),**不要改它**:它就是「输出不变」的定义。
 * 生产代码里退回用的 `renameSceneIdsSequential` 也和它对拍一遍,免得两份拷贝悄悄走样。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { renameSceneIds, renameSceneIdsSequential } from "./renameSceneIds.ts";

/* ── 对照:改动前的原写法(main b7635ad 的 createSnapshot.ts 第 151～162 行) ────────── */

function legacySerializeRename(outerHTML, ids) {
  let html = outerHTML;
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const id of ids) {
    const e = esc(id);
    html = html
      .replace(new RegExp(`(\\sid=")${e}(")`, "g"), `$1${id}__r$2`)
      .replace(new RegExp(`(url\\((?:&quot;|["'])?[^)"'&]*#)${e}((?:&quot;|["'])?\\))`, "g"), `$1${id}__r$2`)
      .replace(new RegExp(`((?:xlink:)?href="#)${e}(")`, "g"), `$1${id}__r$2`);
  }
  return html;
}

/** 和 createSnapshot 一样收集 id:文档序去重,根的 id 排最后 */
const collect = (idsInDocOrder, rootId = "") => new Set(idsInDocOrder.concat(rootId ? [rootId] : []));

/** 从一段 html 里按文档序扫出 id 属性(夹具用;真实调用方是 querySelectorAll("[id]")) */
const scanIds = (html) => [...html.matchAll(/<[a-zA-Z][^>]*?\sid="([^"]*)"/g)].map((m) => m[1]);

function same(html, ids, label) {
  const want = legacySerializeRename(html, ids);
  const got = renameSceneIds(html, ids);
  if (got !== want) {
    let i = 0;
    while (i < got.length && got[i] === want[i]) i++;
    assert.fail(`${label}:第 ${i} 个字符起不同\n  原写法 …${JSON.stringify(want.slice(Math.max(0, i - 60), i + 60))}\n  新写法 …${JSON.stringify(got.slice(Math.max(0, i - 60), i + 60))}`);
  }
  assert.equal(renameSceneIdsSequential(html, ids), want, `${label}:退回路径与原写法不同`);
  return want;
}

/* ── 夹具:照 Chrome 序列化快照的真实形状写 ─────────────────────────────── */

/** snapshotRename.test.mjs 的 CONTROL_HTML(growth-curve 的渐变 + 计算样式内联出来的 &quot; 形式),包一层场景根 */
const GROWTH = (
  '<div data-pc-scene="" id="scene" style="position:absolute">' +
  '<div data-pc-clip="c1" data-pc-local-frame="3" style="position:absolute">' +
  '<div class="hud-glass" id="wrap" style="isolation:isolate">' +
  '<svg width="1100" height="380">' +
  '<defs><linearGradient id="grad-x" x1="0" y1="0" x2="0" y2="1">' +
  '<stop offset="0%" stop-color="#4f8cff"></stop></linearGradient>' +
  '<clipPath id=":r1:"><rect width="10" height="10"></rect></clipPath></defs>' +
  '<path d="M 0,0 L 1,1 Z" fill="url(#grad-x)" style="fill: url(&quot;#grad-x&quot;);clip-path:url(#:r1:)"></path>' +
  '<rect id="plate" width="4" height="4" style="fill:url(#grad-x)"></rect>' +
  '<use xlink:href="#plate"></use><use href="#plate"></use>' +
  "</svg></div></div></div>"
);

/** SVG 渐变、滤镜、遮罩、标记、pattern,React 19 useId 的 `_r_0_` 与旧版的 `:r1:`、`«r0»` */
const SVG_DEFS = (
  '<div data-pc-scene="" style="position:absolute;inset:0px">' +
  '<svg viewBox="0 0 100 100" aria-labelledby="t1 _r_0_" role="img"><title id="t1">标题</title>' +
  '<defs>' +
  '<radialGradient id="_r_0_" cx="50%"><stop offset="0" stop-color="#fff"></stop></radialGradient>' +
  '<linearGradient id="«r0»" gradientTransform="rotate(90)" href="#_r_0_"></linearGradient>' +
  '<filter id="glow-1" x="-50%" y="-50%"><feGaussianBlur stdDeviation="3" result="b"></feGaussianBlur>' +
  '<feMerge><feMergeNode in="b"></feMergeNode><feMergeNode in="SourceGraphic"></feMergeNode></feMerge></filter>' +
  '<mask id="m.1"><rect width="100" height="100" fill="url(#«r0»)"></rect></mask>' +
  '<marker id="arrow" markerWidth="4"><path d="M0,0 L4,2 L0,4 z"></path></marker>' +
  '<pattern id="pat" width="4" height="4"><use xlink:href="#arrow"></use></pattern>' +
  '<path id="curve" d="M10,80 Q50,10 90,80"></path>' +
  '</defs>' +
  '<circle r="40" fill="url(#_r_0_)" filter="url(#glow-1)" mask="url(#m.1)" style="fill: url(&quot;#_r_0_&quot;); filter: drop-shadow(rgba(0, 0, 0, 0.5) 0px 2px 4px) url(&quot;#glow-1&quot;); mask: url(&quot;#m.1&quot;);"></circle>' +
  '<path d="M0,0 L10,10" marker-end="url(#arrow)" style="marker-end: url(&quot;#arrow&quot;); stroke: url(\'#pat\');"></path>' +
  '<text><textPath href="#curve" xlink:href="#curve">沿路径</textPath></text>' +
  '<rect style="fill: url(&quot;#missing&quot;); clip-path: url(#_r_0_) , url(#glow-1);" width="1"></rect>' +
  '<rect style="fill: url(&quot;http://127.0.0.1:5208/?export=1&amp;timeline=x#_r_0_&quot;);" width="2"></rect>' +
  '<rect style="fill: url(&quot;/a/b.svg#_r_0_&quot;);" width="3"></rect>' +
  '</svg>' +
  '<label for="curve" aria-describedby="arrow">aria 与 for 不改名</label>' +
  "</div>"
);

/** 文本、<style> 原始文本里长得像引用的东西;相邻文本节点之间的空注释(keepTextBoundaries) */
const TEXTY = (
  '<div data-pc-scene="" id="root-x">' +
  '<style>#glow-1{filter:url(#glow-1)} .a{fill:url("#g")} .b{mask:url(\'#g\')}</style>' +
  '<p id="g">正文 id="g" 与 href="#g" 与 url(#g)、 id="g" 、x id="g"、<!---->75<!---->%</p>' +
  '<p> id=" id="g"  href="#href="#g" url(url(#g) url(#x#g) url(#g#x) url(#g" url("#g) url(&quot;#g")</p>' +
  '<a href="#g">锚点</a><a href="#root-x">回到根</a>' +
  '<span id="">空 id</span><a href="#">空锚点</a><i style="fill:url(#)"></i>' +
  "</div>"
);

/** 连环改名:集合里同时有 a 与 a__r(两种先后)、以及三级链 */
const CHAIN = (
  '<div data-pc-scene="">' +
  '<i id="a"></i><i id="a__r"></i><i id="a__r__r"></i><i id="b__r"></i><i id="b"></i>' +
  '<i style="fill:url(#a)"></i><i style="fill:url(#a__r)"></i><i style="fill:url(#b)"></i><i style="fill:url(#b__r)"></i>' +
  '<use href="#a"></use><use href="#a__r"></use><use href="#a__r__r"></use><use href="#b"></use>' +
  "</div>"
);

/** 非普通 id(引号、括号、&、#、$、=、空白):整趟退回原写法 */
const WEIRD_IDS = ['x y', 'q"q', "s'q", "p(1)", "a&b", "h#1", "d$&", "d$1", "d$'", "e=f", "tab\tid", "nb sp", " "];
const WEIRD = (
  '<div data-pc-scene="">' +
  WEIRD_IDS.map((id) => `<i id="${id}"></i><i style="fill:url(#${id})"></i><use href="#${id}"></use>`).join("") +
  '<i id="plain"></i><i style="fill:url(#plain)"></i>' +
  "</div>"
);

test("夹具:growth-curve、SVG 渐变/滤镜/遮罩/标记/pattern/textPath、文本与 <style>、空 id、连环改名、非普通 id,新旧逐字节相同", () => {
  const cases = [
    ["growth-curve", GROWTH, collect(scanIds(GROWTH).filter((id) => id !== "scene"), "scene")],
    ["svg-defs", SVG_DEFS, collect(scanIds(SVG_DEFS))],
    ["texty", TEXTY, collect(scanIds(TEXTY).filter((id) => id !== "root-x"), "root-x")],
    ["chain", CHAIN, collect(scanIds(CHAIN))],
    ["chain-reversed", CHAIN, collect(scanIds(CHAIN).reverse())],
    ["weird", WEIRD, collect(scanIds(WEIRD).concat(WEIRD_IDS))],
    ["weird-only-extra", GROWTH, collect(scanIds(GROWTH).concat(["x y"]))],
    // 两个反例:这类 id 改名后会毁掉别的 id 的命中位置,原写法的结果取决于先后,所以只能整趟退回原写法。
    // g 在前时原写法先改了 g,再改 `url(` / `href=`;若按三趟查表,第一趟先改 `url(` 就把 `url("#g)` 拆了。
    ["weird-order-paren", "<p> id=\"url(\"#g)</p>", new Set(["g", "url("])],
    ["weird-order-equals", "<p> id=\"href=\"#g\"</p>", new Set(["g", "href="])],
    ["no-ids", GROWTH, new Set()],
    ["ids-not-in-html", GROWTH, new Set(["nope", "grad"])],
  ];
  for (const [label, html, ids] of cases) same(html, ids, label);
  // 抽查几处结果,免得两边一起错:
  assert.match(renameSceneIds(GROWTH, collect(scanIds(GROWTH))), /fill: url\(&quot;#grad-x__r&quot;\);clip-path:url\(#:r1:__r\)/);
  const chain = renameSceneIds(CHAIN, collect(scanIds(CHAIN)));
  assert.match(chain, /<i id="a__r__r__r"><\/i><i id="a__r__r__r"><\/i><i id="a__r__r__r"><\/i><i id="b__r__r"><\/i><i id="b__r"><\/i>/);
  const texty = renameSceneIds(TEXTY, collect(scanIds(TEXTY)));
  assert.match(texty, /<span id="__r">空 id<\/span><a href="#__r">空锚点<\/a><i style="fill:url\(#__r\)">/);
  assert.match(texty, / id=" id="g__r"/);
});

/* ── 随机对拍 ─────────────────────────────────────────────────────────── */

/** 固定种子的 PRNG(mulberry32),失败时报种子就能复现 */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PLAIN_POOL = ["a", "b", "g", "a__r", "a__r__r", "b__r", "_r_0_", "_r_1_", ":r1:", "«r0»", "grad-x", "m.1", "x", "__r", "", "a_", "r", "__", "p1", "p10"];
const WEIRD_POOL = WEIRD_IDS.concat(["url(", "id=", "href=", "#", ")", "&quot;"]);
/** 让结构尽量撞在一起的碎片:前缀、引号、括号、#、空白、& 实体、以及 id 本身 */
const PIECES = [' id="', 'id="', ' id=\'', 'href="#', 'xlink:href="#', 'href="', "url(", "url(#", 'url("#', "url('#", "url(&quot;#",
  "&quot;", "&amp;", '"', "'", ")", "(", "#", " ", "\t", "\n", "=", "<i ", "></i>", "<!---->", "$", "$&", "__r", "fill:", "; ", "x", "é"];

function randomCase(rnd) {
  const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
  const weird = rnd() < 0.3;
  const pool = weird ? PLAIN_POOL.concat(WEIRD_POOL) : PLAIN_POOL;
  const idCount = 1 + Math.floor(rnd() * 8);
  const ids = [];
  for (let i = 0; i < idCount; i++) ids.push(pick(pool));
  const n = 5 + Math.floor(rnd() * 120);
  let html = "";
  for (let i = 0; i < n; i++) {
    const r = rnd();
    if (r < 0.35) html += pick(PIECES);
    else if (r < 0.6) html += pick(ids);
    else if (r < 0.7) html += pick(pool);
    else if (r < 0.8) html += ` id="${pick(ids)}"`;
    else if (r < 0.88) html += `url(${pick(["", '"', "'", "&quot;"])}${pick(["", "a/b", "x#y", " "])}#${pick(ids)}${pick(["", '"', "'", "&quot;"])})`;
    else if (r < 0.95) html += `${pick(["", "xlink:"])}href="#${pick(ids)}"`;
    else html += pick(PIECES) + pick(ids) + pick(PIECES);
  }
  return { html, ids: new Set(ids) };
}

test("随机对拍:20000 组随机拼出来的串(含前缀交叠、引号错配、连环改名、非普通 id),新旧逐字节相同", () => {
  const SEED = 20260927;
  const rnd = prng(SEED);
  let changed = 0;
  let fast = 0;
  for (let i = 0; i < 20000; i++) {
    const { html, ids } = randomCase(rnd);
    const want = same(html, ids, `种子 ${SEED} 第 ${i} 组`);
    if (want !== html) changed++;
    if (![...ids].some((id) => /[\s"'()&#$=]/.test(id))) fast++;
  }
  // 对拍要有牙齿:大部分组确实改了东西,而且大部分组走的是新写法(不是退回原写法)。
  assert.ok(changed > 10000, `只有 ${changed} 组有改动`);
  assert.ok(fast > 14000, `只有 ${fast} 组走新写法`);
});

/** 照 C10 探针粒子场景的样子拼一段整场景 html:n 个带 id 的元素,每个内联样式约 4 KB,一部分互相引用 */
function particleScene(n) {
  const style = "position: absolute; left: 0px; top: 0px; width: 22px; height: 22px; border-radius: 50%; " +
    "background: radial-gradient(circle at 30% 30%, rgb(255, 255, 255), rgb(51, 153, 255) 60%, rgb(0, 51, 102)); ".repeat(30);
  let html = '<div data-pc-scene="" id="scene" style="position: absolute; inset: 0px;"><div data-pc-clip="c1" data-pc-local-frame="8" id="clip">';
  for (let i = 0; i < n; i++) {
    const ref = i % 7 === 0 ? ` filter: url(&quot;#p${(i * 13) % n}&quot;);` : "";
    const use = i % 11 === 0 ? `<svg><use href="#p${(i * 5) % n}"></use></svg>` : "";
    html += `<div class="p" id="p${i}" style="${style}${ref}">${i % 100}${use}</div>`;
  }
  return html + "</div></div>";
}

test("随机对拍:三组粒子场景(200 / 600 个带 id、互相引用的元素),新旧逐字节相同", () => {
  for (const n of [200, 600]) {
    const html = particleScene(n);
    same(html, collect(scanIds(html).filter((id) => id !== "scene"), "scene"), `粒子 ${n}`);
  }
  const html = particleScene(300).replace(/id="p(\d)"/g, 'id="p$1__r"');
  same(html, collect(scanIds(html)), "粒子 300,混入 __r 结尾的 id");
});

/* ── 代价 ─────────────────────────────────────────────────────────────── */

/*
 * 1400 个带 id 的元素(约 5 MB 整场景 html):原写法在浏览器里约 6.5 s(C10 探针),在这里也是秒级;
 * 新写法应在几十毫秒。判据给得很宽(中位数 ≤ 400 ms),分批重试的做法照 src/kernel/diffProject.test.mjs 的 timeIt:
 * 每批量几次取中位数,最多 MAX_BATCHES 批、批间让出 100 ms,有一批达标就停 —— 全量测试是几十个进程并行跑的,
 * 机器上别的会话也在吃 CPU,单批撞上一阵慢不算失败;真退回平方级时每一批都是秒级,照样拦得住。
 */
const MAX_BATCHES = 8;

async function timeIt(fn, limitMs, runs = 5) {
  fn();
  let best = null;
  let batches = 0;
  for (let batch = 0; batch < MAX_BATCHES && !(best && best.median <= limitMs); batch++) {
    if (batch > 0) await new Promise((r) => setTimeout(r, 100));
    batches++;
    const xs = [];
    for (let i = 0; i < runs; i++) {
      const t0 = performance.now();
      fn();
      xs.push(performance.now() - t0);
    }
    xs.sort((x, y) => x - y);
    const t = { median: xs[xs.length >> 1], max: xs[xs.length - 1] };
    if (!best || t.median < best.median) best = t;
  }
  return { ...best, batches };
}

test("代价:1400 个带 id 的元素,整场景改名中位数 ≤ 400 ms(原写法秒级)", async () => {
  const html = particleScene(1400);
  const ids = collect(scanIds(html).filter((id) => id !== "scene"), "scene");
  assert.equal(ids.size, 1402); // 1400 个粒子 + 片段包裹层 + 场景根
  const t = await timeIt(() => renameSceneIds(html, ids), 400);
  console.log(`renameSceneIds 1400 个 id、${(html.length / 1e6).toFixed(1)} MB:median ${t.median.toFixed(1)} ms,max ${t.max.toFixed(1)} ms(量了 ${t.batches} 批)`);
  assert.ok(t.median <= 400, `量了 ${t.batches} 批,最好的一批中位数也有 ${t.median.toFixed(1)} ms,超过 400 ms`);
});
