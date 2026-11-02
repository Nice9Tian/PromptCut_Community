/**
 * X6(`docs/plan/m6c-contract.md`): inline styles of snapshots are output in a deterministic order
 * of property names, independent of browser enumeration order of `CSSStyleDeclaration`: the same
 * content gets the same chunk hash in different processes.
 *
 * Runs directly after transpiling `src/render/snapshot/inlineStyles.ts` without starting a browser:
 * `getComputedStyle` / `document` are replaced with minimal mock implementations, feeding the same
 * computed styles twice in different enumeration orders and comparing style strings written on
 * clones.
 * Frame-by-frame comparison across a real browser and two prerender processes was originally in
 * `scripts/probes/snapshot-hash-probe.mjs`; that probe was deleted on 2026-10-23 (it requires
 * `snapshotTier() === 'shared'`, but after per-card snapshots were removed on 2026-10-16, that
 * function always returns `'none'`, so the entire probe is bound to fail).
 * For the deletion rationale and readings at that time, see
 * `docs/reports/AGENT-claude-probe-audit.md`. Assertions in this file do not depend on it.
 *
 * Run: node --test server/test/snapshot-style-order.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const ts = require_('typescript');
const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-style-order-test-'));
const propsUrl = pathToFileURL(path.join(ROOT, 'src', 'render', 'snapshot', 'snapshotStyleProps.mjs')).href;
const src = fs.readFileSync(path.join(ROOT, 'src', 'render', 'snapshot', 'inlineStyles.ts'), 'utf8')
  .split('from "./snapshotStyleProps.mjs"').join(`from "${propsUrl}"`);
const js = ts.transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
fs.writeFileSync(path.join(OUT, 'inlineStyles.mjs'), js);
const { serializeDeclarations, inlineDOMStyles, STOP_CLOCKS } = await import(pathToFileURL(path.join(OUT, 'inlineStyles.mjs')).href);

const HTML_NS = 'http://www.w3.org/1999/xhtml';
const sha = text => createHash('sha256').update(text).digest('hex');

/** Deterministic pseudo-random shuffle (different seeds → different orders), no dependencies */
function shuffled(list, seed) {
  const out = [...list];
  let s = seed >>> 0 || 1;
  for (let i = out.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/* ------------------------------------------------------------------ Mock DOM */

/** Computed style: the order of `entries` is the enumeration order */
function fakeComputed(entries) {
  const names = entries.map(([name]) => name);
  const values = new Map(entries);
  return {
    length: names.length,
    item: i => names[i],
    getPropertyValue: name => values.get(name) ?? '',
    zoom: values.get('zoom') ?? '1',
  };
}

class FakeElement {
  constructor(tag, { computed = [], inline = [], attrs = {} } = {}) {
    this.tagName = tag.toUpperCase();
    this.namespaceURI = HTML_NS;
    this.parentElement = null;
    this.children = [];
    this.computed = computed;
    this.attrs = new Map(Object.entries(attrs));
    this.style = { length: inline.length, item: i => inline[i] };
  }
  get attributes() { return [...this.attrs].map(([name, value]) => ({ name, value })); }
  hasAttribute(name) { return this.attrs.has(name); }
  getAttribute(name) { return this.attrs.get(name) ?? null; }
  setAttribute(name, value) { this.attrs.set(name, String(value)); }
  appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
  remove() {
    const parent = this.parentElement;
    if (parent) parent.children = parent.children.filter(c => c !== this);
    this.parentElement = null;
  }
  getAnimations() { return []; }
}

/** Same-tag baseline: computed style of probe element (`ensureBaselines` via `document.createElement`) */
const BASELINE = {
  DIV: [['color', 'rgb(0, 0, 0)'], ['display', 'block'], ['opacity', '1'], ['position', 'static'], ['will-change', 'auto']],
  SPAN: [['color', 'rgb(0, 0, 0)'], ['display', 'inline'], ['opacity', '1'], ['position', 'static'], ['will-change', 'auto']],
};

function installDom() {
  const prevDocument = globalThis.document;
  const prevGcs = globalThis.getComputedStyle;
  globalThis.document = {
    createElement: tag => new FakeElement(tag, { computed: BASELINE[tag.toUpperCase()] ?? [] }),
    createElementNS: (_ns, tag) => new FakeElement(tag, { computed: [] }),
  };
  globalThis.getComputedStyle = el => fakeComputed(el.computed);
  return () => { globalThis.document = prevDocument; globalThis.getComputedStyle = prevGcs; };
}

/**
 * A small card: scene root → div (several custom properties + prefixed properties + mask-position
 * shorthand) → span.
 * `order(entries, who)` determines enumeration order of computed styles for each element:
 * simulating different orders given by browsers in two processes.
 */
function buildTree(order) {
  const rootComputed = [['color', 'rgb(255, 255, 255)'], ['display', 'block'], ['font-size', '16px'], ['--accent', '#39f'], ['--pad', '12px']];
  const divComputed = [
    ['color', 'rgb(255, 255, 255)'], ['display', 'flex'], ['font-size', '16px'], ['mask-position', '0% 0%'], ['opacity', '0.5'],
    ['position', 'absolute'], ['width', '823.5px'], ['will-change', 'auto'],
    ['-webkit-mask-position-x', '0%'], ['-webkit-mask-position-y', '0%'], ['-webkit-text-fill-color', 'rgb(255, 0, 0)'], ['-webkit-writing-mode', 'horizontal-tb'],
    ['--accent', '#39f'], ['--pad', '12px'], ['--z-last', '1'], ['--a-first', '2'], ['--mid', 'calc(1px + 2px)'],
  ];
  const spanComputed = [['color', 'rgb(255, 0, 0)'], ['display', 'inline'], ['font-size', '16px'], ['opacity', '1'], ['--accent', '#39f'], ['--pad', '12px'], ['--span-only', 'x']];
  const root = new FakeElement('div', { computed: order(rootComputed, 'root'), attrs: { 'data-pc-scene': '' } });
  const div = root.appendChild(new FakeElement('div', { computed: order(divComputed, 'div'), inline: ['opacity'] }));
  const span = div.appendChild(new FakeElement('span', { computed: order(spanComputed, 'span') }));
  const orig = [root, div, span];
  const copy = orig.map(el => new FakeElement(el.tagName.toLowerCase()));
  return { root, orig, copy };
}

function styleStrings(order) {
  const restore = installDom();
  try {
    const { root, orig, copy } = buildTree(order);
    inlineDOMStyles(root, orig, copy);
    return copy.map(el => el.getAttribute('style'));
  } finally { restore(); }
}

/* ------------------------------------------------------------------ Test cases */

test('X6-1 serializeDeclarations: the same set of declarations yields the same string regardless of order', () => {
  const decls = [['width', '10px'], ['--b', '1'], ['-webkit-text-fill-color', 'red'], ['color', 'red'], ['--a', '2'], ['align-items', 'center'], ['-webkit-box-flex', '0']];
  const want = serializeDeclarations([...decls]);
  for (let seed = 1; seed <= 50; seed++) assert.equal(serializeDeclarations(shuffled(decls, seed)), want, `Seed ${seed}`);
});

test('X6-2 the order is three groups: "standard properties, prefixed properties, custom properties", and within each group by UTF-16 code unit order', () => {
  const text = serializeDeclarations([
    ['--z', '1'], ['width', '1px'], ['-webkit-writing-mode', 'horizontal-tb'], ['--A', '2'], ['--a', '3'],
    ['align-items', 'center'], ['-webkit-mask-position-x', '0%'], ['mask-position', '0% 0%'], ['Z-upper', 'x'],
  ]);
  assert.equal(text, 'Z-upper:x;align-items:center;mask-position:0% 0%;width:1px;'
    + '-webkit-mask-position-x:0%;-webkit-writing-mode:horizontal-tb;'
    + '--A:2;--a:3;--z:1;');
});

test('X6-3 the order of the standard section and the prefixed section matches Chrome\'s own enumeration (the shorthand mask-position still comes before -webkit-mask-position-x/y)', () => {
  // Chrome 152 enumeration: standard properties alphabetically, prefixed properties alphabetically,
  // custom properties (actual measurements from section X6 of this branch report)
  const chromeOrder = [['align-items', 'center'], ['mask-position', '0% 0%'], ['writing-mode', 'horizontal-tb'],
    ['-webkit-mask-position-x', '0%'], ['-webkit-mask-position-y', '0%'], ['-webkit-writing-mode', 'horizontal-tb']];
  const old = chromeOrder.map(([p, v]) => `${p}:${v};`).join('');
  assert.equal(serializeDeclarations(shuffled(chromeOrder, 7)), old, 'With no custom properties, the output is byte-for-byte identical to the old string built in Chrome enumeration order');
});

test('X6-4 inlineDOMStyles: when the enumeration order of computed styles differs (simulating two processes), the style strings on the clone are byte-for-byte identical', () => {
  const asIs = styleStrings(entries => entries);
  const reversed = styleStrings(entries => [...entries].reverse());
  const hashes = new Set([asIs, reversed].map(list => sha(list.join('\n'))));
  for (let seed = 1; seed <= 20; seed++) hashes.add(sha(styleStrings((entries, who) => shuffled(entries, seed * 31 + who.length)).join('\n')));
  assert.equal(hashes.size, 1, '22 enumeration orders should produce only one snapshot');
  for (const text of asIs) assert.ok(text.endsWith(STOP_CLOCKS), 'The end is still the stop-clocks entry');
  // Criteria unchanged: its own newly added custom properties are written as usual, those identical
  // to parent element (--accent, --pad) omitted as usual; order of three groups follows X6-2
  assert.equal(asIs[1], 'display:flex;mask-position:0% 0%;opacity:0.5;position:absolute;width:823.5px;'
    + '-webkit-mask-position-x:0%;-webkit-mask-position-y:0%;-webkit-text-fill-color:rgb(255, 0, 0);-webkit-writing-mode:horizontal-tb;'
    + '--a-first:2;--mid:calc(1px + 2px);--z-last:1;' + STOP_CLOCKS);
  assert.doesNotMatch(asIs[2], /font-size/, 'Inherited properties equal to the parent element are still omitted');
  assert.match(asIs[1], /opacity:0\.5;/, 'Properties with their own inline style are still force-inlined');
});

test('X6-5 after merging, will-change is placed by name and appears only once', () => {
  const decls = [['--x', '1'], ['opacity', '0.5'], ['will-change', 'transform, opacity'], ['color', 'red']];
  const text = serializeDeclarations(decls);
  assert.equal(text, 'color:red;opacity:0.5;will-change:transform, opacity;--x:1;');
  assert.equal(text.split('will-change').length - 1, 1);
});
