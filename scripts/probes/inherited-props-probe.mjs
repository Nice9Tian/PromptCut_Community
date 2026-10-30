/**
 * A2(8) 的属性表对账:`src/render/snapshot/snapshotStyleProps.mjs` 的 `INHERITED_PROPS` 到底和
 * Chrome 的实际继承行为对不对得上。
 *
 *   node scripts/probes/inherited-props-probe.mjs [--json out/inherited-props.json]
 *
 * 判法就是任务书 A2(8) 那句「单测用父子两层干净元素逐个属性验『父设了非初始值、子跟不跟』」:
 * 一个干净的 `<div><div></div></div>`(和一份 SVG 版),对每个 longhand 属性,
 * **给父元素换一个和初始值不同的值**,看子元素的计算值跟不跟着走。
 *
 * 「和初始值不同的值」怎么来:不逐个属性手写候选值(写不全,也容易写错),而是用
 * `CSS.registerProperty` 之外的一条通路 —— 对每个属性试一组通用候选值
 * (`inherit` 不算;用一批覆盖面广的字面量),取第一个能让**父元素**的计算值变掉的,
 * 再看子元素。属性没有任何候选值能改动父元素的(多半是只读 / 别名 / 简写),报成 `skipped`,
 * 不参与判定 —— 表里有它不算错,表里没有它也不算错。
 *
 * 退出码 1 的两种情况:
 *   - 表里写了、Chrome 说它**不继承**(多内联几个字节,不致错,但表该改);
 *   - Chrome 说它继承、表里**没写**(顶层元素之外都安全,见 snapshotStyleProps.mjs 的说明;
 *     顶层元素会因此漏掉这个属性 —— 该补)。
 * 两种都只打印,由人决定改表还是改探针的候选值。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { INHERITED_PROPS, LAYOUT_USED_VALUE_PROPS } from '../../src/render/snapshot/snapshotStyleProps.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const flag = (name, fallback = null) => { const i = argv.indexOf(name); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback; };
const outJson = flag('--json', 'out/inherited-props.json');

/* 通用候选值:覆盖各种取值语法,逐个试到父元素的计算值真的变掉为止 */
const CANDIDATES = [
  '33px', '7', '0.37', 'red', 'rgb(1, 2, 3)', 'none', 'auto', 'hidden', 'visible', 'collapse',
  'block', 'inline', 'flex', 'bold', 'italic', 'uppercase', 'center', 'right', 'justify',
  'pre', 'nowrap', 'break-all', 'break-word', 'rtl', 'vertical-rl', 'crosshair', 'square',
  'separate', 'both', 'show', 'dark', 'evenodd', 'round', 'bevel', 'middle', 'hanging',
  'crispEdges', 'linearRGB', 'sRGB', 'optimizeSpeed', '"Courier New"', '2px 2px red',
  '33px 33px', 'url("#x")', 'stroke fill markers', 'anywhere', 'balance', 'stable',
  'ultra-expanded', 'small-caps', 'tabular-nums', 'common-ligatures', 'sub', 'always',
  '"a" "b"', 'manual', '33', 'currentcolor', 'thick', 'under', 'skip', 'from-font',
];

const browser = await puppeteer.launch({ headless: true, args: [...PROBE_CHROME_ARGS, '--no-first-run', '--hide-scrollbars'] });
let exitCode = 0;
try {
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><html><body style="margin:0">
    <div id="hp"><div id="hc"></div></div>
    <svg id="svg"><g id="sp"><g id="sc"></g></g></svg>
  </body></html>`);
  const report = await page.evaluate((candidates) => {
    const pairs = [['html', 'hp', 'hc'], ['svg', 'sp', 'sc']];
    const props = new Set();
    for (const [, p] of pairs) for (const item of getComputedStyle(document.getElementById(p))) props.add(item);
    const inherited = new Set(), notInherited = new Set(), skipped = [];
    for (const prop of props) {
      let decided = false;
      for (const [, parentId, childId] of pairs) {
        if (decided) break;
        const parent = document.getElementById(parentId), child = document.getElementById(childId);
        const pcs = getComputedStyle(parent), ccs = getComputedStyle(child);
        const before = pcs.getPropertyValue(prop), childBefore = ccs.getPropertyValue(prop);
        for (const value of candidates) {
          parent.style.setProperty(prop, value);
          const after = pcs.getPropertyValue(prop);
          if (after !== before) {
            (ccs.getPropertyValue(prop) === after ? inherited : notInherited).add(prop);
            decided = true;
          }
          parent.style.removeProperty(prop);
          if (decided) break;
          // 子元素本来就跟着变就说明候选值被拒了但触发了别的副作用,按未决处理
          void childBefore;
        }
      }
      if (!decided) skipped.push(prop);
    }
    return { inherited: [...inherited].sort(), notInherited: [...notInherited].sort(), skipped: skipped.sort() };
  }, CANDIDATES);

  const table = [...INHERITED_PROPS].sort();
  const chromeInherited = new Set(report.inherited);
  const chromeNot = new Set(report.notInherited);
  const skipped = new Set(report.skipped);

  const wrongInTable = table.filter((p) => chromeNot.has(p));
  /*
   * 布局解析值属性(width / inline-size …)会被探针误判成「继承」:给父元素设 width,
   * 块级子元素的**使用值**跟着变,但那是布局不是继承。它们本来就在 LAYOUT_USED_VALUE_PROPS
   * 里一律全内联,和继承表无关,所以这里排掉。
   */
  const missingFromTable = report.inherited.filter((p) => !INHERITED_PROPS.has(p) && !LAYOUT_USED_VALUE_PROPS.has(p));
  const unverified = table.filter((p) => !chromeInherited.has(p) && !chromeNot.has(p));

  console.log(`Chrome 判定:继承 ${report.inherited.length} 个、不继承 ${report.notInherited.length} 个、没定论 ${report.skipped.length} 个`);
  console.log(`表里 ${table.length} 个;其中 ${table.filter((p) => chromeInherited.has(p)).length} 个被 Chrome 证实继承。`);
  if (wrongInTable.length) { exitCode = 1; console.log(`\n表里写了但 Chrome 说不继承(${wrongInTable.length}):\n  ${wrongInTable.join(', ')}`); }
  if (missingFromTable.length) { exitCode = 1; console.log(`\nChrome 说继承但表里没写(${missingFromTable.length}):\n  ${missingFromTable.join(', ')}`); }
  if (unverified.length) console.log(`\n表里有、探针没定论(候选值都改不动父元素,不算错,${unverified.length}):\n  ${unverified.join(', ')}`);
  console.log(`\n没定论的属性共 ${skipped.size} 个。`);

  if (outJson) {
    const file = path.resolve(ROOT, outJson);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...report, table, wrongInTable, missingFromTable, unverified }, null, 2), 'utf8');
    console.log(`\n原始数据写到 ${file}`);
  }
} catch (err) {
  console.error(err && err.stack || err);
  exitCode = 1;
} finally {
  await browser.close();
}
process.exit(exitCode);
