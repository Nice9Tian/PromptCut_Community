/**
 * Property table reconciliation for A2(8): check whether `INHERITED_PROPS` in
 * `src/render/snapshot/snapshotStyleProps.mjs` actually matches Chrome's real inheritance behavior.
 *
 *   node scripts/probes/inherited-props-probe.mjs [--json out/inherited-props.json]
 *
 * Verification logic follows the quote from task brief A2(8): "unit test uses two clean
 * parent-child element layers to verify per-property 'if parent sets a non-initial value, does child
 * follow'": a clean `<div><div></div></div>` (and an SVG version); for each longhand property,
 * **set the parent element to a value different from the initial value**, and see if the child
 * element's computed value follows.
 *
 * How to get "a value different from the initial value": instead of manually writing candidate
 * values per property (incomplete and error-prone), use a path outside `CSS.registerProperty`:
 * test a set of generic candidate values for each property (`inherit` does not count; use a broad
 * batch of literals), take the first one that changes the **parent element's** computed value, and
 * then inspect the child element. If a property has no candidate value that can alter the parent
 * element (mostly read-only / alias / shorthand), report it as `skipped` and exclude it from the
 * verdict: having it in the table is not an error, and not having it in the table is not an error.
 *
 * Two cases for exit code 1:
 *   - Listed in the table, but Chrome says it **does not inherit** (inlines a few extra bytes, not
 *     fatal, but the table should be updated);
 *   - Chrome says it inherits, but it is **not listed** in the table (safe for non-top-level
 *     elements, see snapshotStyleProps.mjs explanation; top-level elements would miss this
 *     property as a result: should be added).
 * Both cases only log; humans decide whether to update the table or probe candidate values.
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

/* Generic candidate values: covers syntax variants, tested until parent element's computed value actually changes */
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
          // If child element already changes along, candidate was rejected but triggered other side effects;
          // treat as undetermined
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
   * Layout resolved-value properties (width / inline-size …) are misidentified by the probe as
   * "inherited": setting width on the parent changes the block-level child's **used value**, but that
   * is layout, not inheritance. They are already fully inlined in LAYOUT_USED_VALUE_PROPS anyway and
   * have nothing to do with the inheritance table, so they are excluded here.
   */
  const missingFromTable = report.inherited.filter((p) => !INHERITED_PROPS.has(p) && !LAYOUT_USED_VALUE_PROPS.has(p));
  const unverified = table.filter((p) => !chromeInherited.has(p) && !chromeNot.has(p));

  console.log(`Chrome verdict: ${report.inherited.length} inherited, ${report.notInherited.length} not inherited, ${report.skipped.length} inconclusive`);
  console.log(`${table.length} in the table; ${table.filter((p) => chromeInherited.has(p)).length} of them confirmed inherited by Chrome.`);
  if (wrongInTable.length) { exitCode = 1; console.log(`\nListed in the table but Chrome says not inherited (${wrongInTable.length}):\n  ${wrongInTable.join(', ')}`); }
  if (missingFromTable.length) { exitCode = 1; console.log(`\nChrome says inherited but not listed in the table (${missingFromTable.length}):\n  ${missingFromTable.join(', ')}`); }
  if (unverified.length) console.log(`\nListed in the table, probe inconclusive (no candidate value could change the parent element, not counted as an error, ${unverified.length}):\n  ${unverified.join(', ')}`);
  console.log(`\n${skipped.size} properties in total are inconclusive.`);

  if (outJson) {
    const file = path.resolve(ROOT, outJson);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...report, table, wrongInTable, missingFromTable, unverified }, null, 2), 'utf8');
    console.log(`\nRaw data written to ${file}`);
  }
} catch (err) {
  console.error(err && err.stack || err);
  exitCode = 1;
} finally {
  await browser.close();
}
process.exit(exitCode);
