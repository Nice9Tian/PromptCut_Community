import test from 'node:test';
import assert from 'node:assert/strict';

import { compareSnapshotHtml, numbersClose, tokenizeHtml, valuesCloseEnough } from './snapshotCompare.mjs';

const same = (a, b, opts) => {
  const r = compareSnapshotHtml(a, b, opts);
  assert.equal(r.same, true, `Expected identical, but got: ${r.reason} ${r.expected ?? ''} / ${r.actual ?? ''}`);
};
const differ = (a, b, hint) => {
  const r = compareSnapshotHtml(a, b);
  assert.equal(r.same, false, `Expected different (${hint ?? ''}), but reported identical`);
  return r;
};

/* ------------------------------------------------------------ Tolerance */

test('1 ulp difference in the last place counts as identical in inline styles', () => {
  const x = 0.1 + 0.2;                       // 0.30000000000000004
  const y = 0.3;
  assert.notEqual(String(x), String(y), 'Precondition: the two numbers have different strings');
  same(
    `<div style="opacity: ${x};"></div>`,
    `<div style="opacity: ${y};"></div>`,
  );
  // translateY: global clock accumulated 8 times vs multiplied by 8 in one step, differs by 1 ulp in the last place
  const a = -8.6551513671875;
  const b = a * (1 + Number.EPSILON);
  assert.notEqual(a, b, 'Precondition: the two numbers really differ by one ulp');
  same(
    `<div style="transform: translateY(${a}px);"></div>`,
    `<div style="transform: translateY(${b}px);"></div>`,
  );
});

test('1 ulp near 0 also counts as identical (absolute floor)', () => {
  same('<div style="opacity: 0;"></div>', `<div style="opacity: ${Number.MIN_VALUE};"></div>`);
  same('<i style="left: 0px;"></i>', '<i style="left: 1e-13px;"></i>');
});

test('Beyond 1e-6 relative error counts as different', () => {
  differ('<div style="opacity: 1;"></div>', '<div style="opacity: 1.00001;"></div>', '1e-5 relative error');
  differ('<div style="width: 100px;"></div>', '<div style="width: 100.001px;"></div>');
  // 0 and a truly meaningful decimal are not considered equal
  differ('<div style="opacity: 0;"></div>', '<div style="opacity: 0.0001;"></div>');
});

test('Tolerance applies only to style; other attributes are compared verbatim', () => {
  differ('<path d="M0 0 L10.0 0"/>', '<path d="M0 0 L10.000000001 0"/>', 'SVG d is not relaxed');
  differ('<circle r="5"/>', '<circle r="5.000000001"/>');
  same('<path d="M0 0 L10.0 0"/>', '<path d="M0 0 L10.0 0"/>');
});

test('A few direct cases for numbersClose / valuesCloseEnough', () => {
  assert.equal(numbersClose(1, 1), true);
  assert.equal(numbersClose(1, 1 + 1e-9), true);
  assert.equal(numbersClose(1, 1.001), false);
  assert.equal(numbersClose(NaN, NaN), false, 'NaN does not equal NaN');
  assert.equal(numbersClose(Infinity, Infinity), true, 'Identical literal values short-circuit');
  assert.equal(valuesCloseEnough('10.0px 20.0px', '10.000000001px 20.0px'), true);
  assert.equal(valuesCloseEnough('10px 20px', '10px 21px'), false);
  assert.equal(valuesCloseEnough('calc(10px - 2px)', 'calc(10px + 2px)'), false, 'Operators stay in the literal part');
  assert.equal(valuesCloseEnough('#1a2b3c', '#1a2b3d'), false, 'Colors are not mistaken for numbers');
  assert.equal(valuesCloseEnough('10px', '10px 10px'), false, 'Different number of parts');
});

/* ------------------------------------------------------------ Attributes / tags / text */

test('Different attributes count as different', () => {
  differ('<div class="a"></div>', '<div class="b"></div>', 'Different value');
  differ('<div class="a"></div>', '<div data-x="a"></div>', 'Different name');
  differ('<div class="a"></div>', '<div class="a" id="x"></div>', 'One extra attribute');
  differ('<div class="a" id="x"></div>', '<div class="a"></div>', 'One attribute missing');
  // Order is not visual output: compare attributes by name, not serialization order
  same('<div class="a" id="x"></div>', '<div id="x" class="a"></div>');
});

test('Tags and text are compared verbatim', () => {
  differ('<span>1</span>', '<div>1</div>', 'Tag name');
  differ('<span>1</span>', '<span>2</span>', 'Text');
  differ('<span>a </span>', '<span>a</span>', 'Whitespace is not normalized');
  differ('<span></span>', '<span></span><span></span>', 'token count');
  same('<span>a</span>', '<span>a</span>');
});

test('Empty-value attributes, self-closing tags, comments', () => {
  same('<input disabled>', '<input disabled>');
  differ('<input disabled>', '<input>');
  same('<br/>', '<br/>');
  same('<!-- x --><b>1</b>', '<!-- x --><b>1</b>');
  differ('<!-- x --><b>1</b>', '<!-- y --><b>1</b>');
});

test('Content of style / script is treated as raw text; a < inside is not a tag', () => {
  const css = '<style>.a::after{content:"<";width:10.0px}</style>';
  same(css, css);
  differ(css, '<style>.a::after{content:"<";width:11px}</style>');
  // Raw text goes through the text token, not the style attribute tolerance
  differ('<style>.a{width:10.0px}</style>', '<style>.a{width:10.000000001px}</style>');
});

test('A more realistic whole snapshot: only a last-place transform difference → identical', () => {
  const html = (y, o) => `<div data-pc-part="root" class="hud" style="opacity: ${o}; transform: translateY(${y}px) scale(1);">`
    + `<svg viewBox="0 0 100 100"><linearGradient id="g__r"><stop offset="0.5"></stop></linearGradient>`
    + `<path d="M0 0 L100 100" fill="url(&quot;#g__r&quot;)"></path></svg><span>12</span></div>`;
  same(html(-8.655151367187500, 0.4), html(-8.655151367187501, 0.40000000000000002));
  differ(html(-8.65, 0.4), html(-8.66, 0.4));
  differ(html(-8.65, 0.4), html(-8.65, 0.5));
});

/* ------------------------------------------------------------ Lexical analysis */

test('Tokens produced by tokenizeHtml', () => {
  const t = tokenizeHtml('<div class="a" style="x: 1;">hi<br/></div>');
  assert.deepEqual(t.map((x) => x.kind), ['open', 'text', 'open', 'close']);
  assert.equal(t[0].name, 'div');
  assert.equal(t[0].attrs.get('style'), 'x: 1;');
  assert.equal(t[1].text, 'hi');
  assert.equal(t[2].selfClosing, true);
  assert.equal(t[3].name, 'div');
  assert.deepEqual(tokenizeHtml('').map((x) => x.kind), []);
  assert.deepEqual(tokenizeHtml('纯文本').map((x) => x.text), ['纯文本']);
});

test('Empty string and non-strings', () => {
  same('', '');
  assert.equal(compareSnapshotHtml(null, '').same, false);
  assert.equal(compareSnapshotHtml('', undefined).same, false);
});

test('Comparison is a pure function: the same input gives the same result twice and the arguments are not modified', () => {
  const a = '<div style="opacity: 0.30000000000000004;"></div>';
  const b = '<div style="opacity: 0.3;"></div>';
  assert.deepEqual(compareSnapshotHtml(a, b), compareSnapshotHtml(a, b));
  assert.equal(a, '<div style="opacity: 0.30000000000000004;"></div>');
});
