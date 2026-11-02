/**
 * Unit test for whole-scene id renaming in snapshot generation: compares new implementation
 * (`renameSceneIds`, linear) byte-for-byte against legacy implementation, plus a cost test case.
 * Run: node --test src/render/snapshot/renameSceneIds.test.mjs
 *
 * Reference `legacySerializeRename` is that section from `serializeScene` in
 * `src/render/createSnapshot.ts` before changes, copied as-is (only turning `html` / `ids`
 * into parameters). **Do not modify it**: it is the definition of "invariant output".
 * Production fallback `renameSceneIdsSequential` is also compared against it to prevent
 * the two copies from silently diverging.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { renameSceneIds, renameSceneIdsSequential } from "./renameSceneIds.ts";

/* ── Reference: legacy implementation before changes (lines 151~162 of createSnapshot.ts in main b7635ad) ────────── */

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

/** Collect ids just like createSnapshot: deduplicated in document order, root id placed last */
const collect = (idsInDocOrder, rootId = "") => new Set(idsInDocOrder.concat(rootId ? [rootId] : []));

/** Scan id attributes in document order from an HTML snippet (for fixtures; real caller is querySelectorAll("[id]")) */
const scanIds = (html) => [...html.matchAll(/<[a-zA-Z][^>]*?\sid="([^"]*)"/g)].map((m) => m[1]);

function same(html, ids, label) {
  const want = legacySerializeRename(html, ids);
  const got = renameSceneIds(html, ids);
  if (got !== want) {
    let i = 0;
    while (i < got.length && got[i] === want[i]) i++;
    assert.fail(`${label}: differs from character ${i}\n  old way …${JSON.stringify(want.slice(Math.max(0, i - 60), i + 60))}\n  new way …${JSON.stringify(got.slice(Math.max(0, i - 60), i + 60))}`);
  }
  assert.equal(renameSceneIdsSequential(html, ids), want, `${label}: fallback path differs from the old way`);
  return want;
}

/* ── Fixtures: written matching the actual shape of Chrome serialized snapshots ─────────── */

/** CONTROL_HTML of snapshotRename.test.mjs (growth-curve gradient + computed styles inlined as &quot; form), wrapped in a scene root */
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

/** SVG gradients, filters, masks, markers, patterns, React 19 useId's `_r_0_`, and legacy `:r1:`, `«r0»` */
const SVG_DEFS = (
  '<div data-pc-scene="" style="position:absolute;inset:0px">' +
  '<svg viewBox="0 0 100 100" aria-labelledby="t1 _r_0_" role="img"><title id="t1">Title</title>' +
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
  '<text><textPath href="#curve" xlink:href="#curve">Along path</textPath></text>' +
  '<rect style="fill: url(&quot;#missing&quot;); clip-path: url(#_r_0_) , url(#glow-1);" width="1"></rect>' +
  '<rect style="fill: url(&quot;http://127.0.0.1:5208/?export=1&amp;timeline=x#_r_0_&quot;);" width="2"></rect>' +
  '<rect style="fill: url(&quot;/a/b.svg#_r_0_&quot;);" width="3"></rect>' +
  '</svg>' +
  '<label for="curve" aria-describedby="arrow">aria and for are not renamed</label>' +
  "</div>"
);

/** Text, things resembling references in <style> raw text; empty comments between adjacent text nodes (keepTextBoundaries) */
const TEXTY = (
  '<div data-pc-scene="" id="root-x">' +
  '<style>#glow-1{filter:url(#glow-1)} .a{fill:url("#g")} .b{mask:url(\'#g\')}</style>' +
  '<p id="g">Body id="g" and href="#g" and url(#g), id="g" , x id="g", <!---->75<!---->%</p>' +
  '<p> id=" id="g"  href="#href="#g" url(url(#g) url(#x#g) url(#g#x) url(#g" url("#g) url(&quot;#g")</p>' +
  '<a href="#g">Anchor</a><a href="#root-x">Back to root</a>' +
  '<span id="">Empty id</span><a href="#">Empty anchor</a><i style="fill:url(#)"></i>' +
  "</div>"
);

/** Chained renaming: set contains both a and a__r (both orderings), as well as a three-level chain */
const CHAIN = (
  '<div data-pc-scene="">' +
  '<i id="a"></i><i id="a__r"></i><i id="a__r__r"></i><i id="b__r"></i><i id="b"></i>' +
  '<i style="fill:url(#a)"></i><i style="fill:url(#a__r)"></i><i style="fill:url(#b)"></i><i style="fill:url(#b__r)"></i>' +
  '<use href="#a"></use><use href="#a__r"></use><use href="#a__r__r"></use><use href="#b"></use>' +
  "</div>"
);

/** Non-standard ids (quotes, parentheses, &, #, $, =, whitespace): whole pass falls back to legacy implementation */
const WEIRD_IDS = ['x y', 'q"q', "s'q", "p(1)", "a&b", "h#1", "d$&", "d$1", "d$'", "e=f", "tab\tid", "nb sp", " "];
const WEIRD = (
  '<div data-pc-scene="">' +
  WEIRD_IDS.map((id) => `<i id="${id}"></i><i style="fill:url(#${id})"></i><use href="#${id}"></use>`).join("") +
  '<i id="plain"></i><i style="fill:url(#plain)"></i>' +
  "</div>"
);

test("Fixture: growth-curve, SVG gradient/filter/mask/marker/pattern/textPath, text and <style>, empty id, chained renames, non-plain ids, old and new byte-identical", () => {
  const cases = [
    ["growth-curve", GROWTH, collect(scanIds(GROWTH).filter((id) => id !== "scene"), "scene")],
    ["svg-defs", SVG_DEFS, collect(scanIds(SVG_DEFS))],
    ["texty", TEXTY, collect(scanIds(TEXTY).filter((id) => id !== "root-x"), "root-x")],
    ["chain", CHAIN, collect(scanIds(CHAIN))],
    ["chain-reversed", CHAIN, collect(scanIds(CHAIN).reverse())],
    ["weird", WEIRD, collect(scanIds(WEIRD).concat(WEIRD_IDS))],
    ["weird-only-extra", GROWTH, collect(scanIds(GROWTH).concat(["x y"]))],
    // Two counterexamples: renaming such ids destroys match positions of other ids; result of legacy
    // implementation depends on order, so the whole pass must fall back to legacy implementation.
    // When g comes first, legacy implementation renamed g first, then `url(` / `href=`; if using
    // three-pass table lookup, pass 1 renaming `url(` first breaks `url("#g)`.
    ["weird-order-paren", "<p> id=\"url(\"#g)</p>", new Set(["g", "url("])],
    ["weird-order-equals", "<p> id=\"href=\"#g\"</p>", new Set(["g", "href="])],
    ["no-ids", GROWTH, new Set()],
    ["ids-not-in-html", GROWTH, new Set(["nope", "grad"])],
  ];
  for (const [label, html, ids] of cases) same(html, ids, label);
  // Spot-check several results to avoid both sides being wrong together:
  assert.match(renameSceneIds(GROWTH, collect(scanIds(GROWTH))), /fill: url\(&quot;#grad-x__r&quot;\);clip-path:url\(#:r1:__r\)/);
  const chain = renameSceneIds(CHAIN, collect(scanIds(CHAIN)));
  assert.match(chain, /<i id="a__r__r__r"><\/i><i id="a__r__r__r"><\/i><i id="a__r__r__r"><\/i><i id="b__r__r"><\/i><i id="b__r"><\/i>/);
  const texty = renameSceneIds(TEXTY, collect(scanIds(TEXTY)));
  assert.match(texty, /<span id="__r">Empty id<\/span><a href="#__r">Empty anchor<\/a><i style="fill:url\(#__r\)"><\/i>/);
  assert.match(texty, / id=" id="g__r"/);
});

/* ── Random differential testing ─────────────────────────────────────────── */

/** Fixed-seed PRNG (mulberry32); report the seed on failure to reproduce */
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
/** Fragments designed to collide structures: prefixes, quotes, parentheses, #, whitespace, & entities, and the id itself */
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

test("Randomized cross-check: 20000 randomly assembled strings (including prefix overlaps, mismatched quotes, chained renames, non-plain ids), old and new byte-identical", () => {
  const SEED = 20260927;
  const rnd = prng(SEED);
  let changed = 0;
  let fast = 0;
  for (let i = 0; i < 20000; i++) {
    const { html, ids } = randomCase(rnd);
    const want = same(html, ids, `seed ${SEED} group ${i}`);
    if (want !== html) changed++;
    if (![...ids].some((id) => /[\s"'()&#$=]/.test(id))) fast++;
  }
  // Differential tests must have teeth: most groups actually change something, and most groups use
  // the new implementation (not falling back to the original implementation).
  assert.ok(changed > 10000, `only ${changed} groups changed`);
  assert.ok(fast > 14000, `only ${fast} groups took the new way`);
});

/** Assemble whole-scene HTML matching C10 probe particle scene: n elements with ids, ~4 KB inline styles each, some referencing each other */
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

test("Randomized cross-check: three particle scenes (200 / 600 elements with ids referencing each other), old and new byte-identical", () => {
  for (const n of [200, 600]) {
    const html = particleScene(n);
    same(html, collect(scanIds(html).filter((id) => id !== "scene"), "scene"), `particles ${n}`);
  }
  const html = particleScene(300).replace(/id="p(\d)"/g, 'id="p$1__r"');
  same(html, collect(scanIds(html)), "particles 300, mixed in ids ending in __r");
});

/* ── Cost ─────────────────────────────────────────────────────────────── */

/*
 * 1400 elements with ids (~5 MB whole-scene HTML): the original implementation took ~6.5 s in
 * the browser (C10 probe) and also takes seconds here; the new implementation should take tens of
 * milliseconds. The criterion is generous (median ≤ 400 ms), with batched retries following
 * timeIt in src/kernel/diffProject.test.mjs: measure several times per batch and take the median,
 * up to MAX_BATCHES batches with 100 ms yielded between batches, stopping as soon as one batch
 * qualifies: full test suites run in dozens of parallel processes and other sessions on the
 * machine also consume CPU, so a transient slowdown in a single batch is not a failure; if it
 * genuinely regresses to quadratic time, every batch takes seconds and will still be caught.
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

test("Cost: 1400 elements with ids, whole-scene rename median ≤ 400 ms (old way takes seconds)", async () => {
  const html = particleScene(1400);
  const ids = collect(scanIds(html).filter((id) => id !== "scene"), "scene");
  assert.equal(ids.size, 1402); // 1400 particles + clip wrapper layer + scene root
  const t = await timeIt(() => renameSceneIds(html, ids), 400);
  console.log(`renameSceneIds 1400 ids, ${(html.length / 1e6).toFixed(1)} MB: median ${t.median.toFixed(1)} ms, max ${t.max.toFixed(1)} ms (${t.batches} batches measured)`);
  assert.ok(t.median <= 400, `Measured ${t.batches} batches; even the best batch's median is ${t.median.toFixed(1)} ms, over 400 ms`);
});
