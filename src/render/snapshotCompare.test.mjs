import test from 'node:test';
import assert from 'node:assert/strict';

import { compareSnapshotHtml, numbersClose, tokenizeHtml, valuesCloseEnough } from './snapshotCompare.mjs';

const same = (a, b, opts) => {
  const r = compareSnapshotHtml(a, b, opts);
  assert.equal(r.same, true, `本应相同,却报:${r.reason} ${r.expected ?? ''} / ${r.actual ?? ''}`);
};
const differ = (a, b, hint) => {
  const r = compareSnapshotHtml(a, b);
  assert.equal(r.same, false, `本应不同(${hint ?? ''}),却报相同`);
  return r;
};

/* ------------------------------------------------------------ 容差 */

test('内联样式里末位差 1 ulp 算相同', () => {
  const x = 0.1 + 0.2;                       // 0.30000000000000004
  const y = 0.3;
  assert.notEqual(String(x), String(y), '前提:这两个数的字符串不同');
  same(
    `<div style="opacity: ${x};"></div>`,
    `<div style="opacity: ${y};"></div>`,
  );
  // translateY:全局时钟累加 8 次 vs 一步乘 8,末位差一个 ulp
  const a = -8.6551513671875;
  const b = a * (1 + Number.EPSILON);
  assert.notEqual(a, b, '前提:这两个数真的差了一个 ulp');
  same(
    `<div style="transform: translateY(${a}px);"></div>`,
    `<div style="transform: translateY(${b}px);"></div>`,
  );
});

test('0 附近的 1 ulp 也算相同(绝对地板)', () => {
  same('<div style="opacity: 0;"></div>', `<div style="opacity: ${Number.MIN_VALUE};"></div>`);
  same('<i style="left: 0px;"></i>', '<i style="left: 1e-13px;"></i>');
});

test('超出 1e-6 相对误差就算不同', () => {
  differ('<div style="opacity: 1;"></div>', '<div style="opacity: 1.00001;"></div>', '1e-5 相对误差');
  differ('<div style="width: 100px;"></div>', '<div style="width: 100.001px;"></div>');
  // 0 和一个真有意义的小数不算相同
  differ('<div style="opacity: 0;"></div>', '<div style="opacity: 0.0001;"></div>');
});

test('容差只放给 style,别的属性逐字', () => {
  differ('<path d="M0 0 L10.0 0"/>', '<path d="M0 0 L10.000000001 0"/>', 'SVG 的 d 不放宽');
  differ('<circle r="5"/>', '<circle r="5.000000001"/>');
  same('<path d="M0 0 L10.0 0"/>', '<path d="M0 0 L10.0 0"/>');
});

test('numbersClose / valuesCloseEnough 直接的几条', () => {
  assert.equal(numbersClose(1, 1), true);
  assert.equal(numbersClose(1, 1 + 1e-9), true);
  assert.equal(numbersClose(1, 1.001), false);
  assert.equal(numbersClose(NaN, NaN), false, 'NaN 不等于 NaN');
  assert.equal(numbersClose(Infinity, Infinity), true, '同一个字面值短路');
  assert.equal(valuesCloseEnough('10.0px 20.0px', '10.000000001px 20.0px'), true);
  assert.equal(valuesCloseEnough('10px 20px', '10px 21px'), false);
  assert.equal(valuesCloseEnough('calc(10px - 2px)', 'calc(10px + 2px)'), false, '符号留在字面段');
  assert.equal(valuesCloseEnough('#1a2b3c', '#1a2b3d'), false, '颜色不会被当成数混过去');
  assert.equal(valuesCloseEnough('10px', '10px 10px'), false, '段数不同');
});

/* ------------------------------------------------------------ 属性 / 标签 / 文本 */

test('属性不同算不同', () => {
  differ('<div class="a"></div>', '<div class="b"></div>', '值不同');
  differ('<div class="a"></div>', '<div data-x="a"></div>', '名字不同');
  differ('<div class="a"></div>', '<div class="a" id="x"></div>', '多一个属性');
  differ('<div class="a" id="x"></div>', '<div class="a"></div>', '少一个属性');
  // 顺序不是画面:属性按名字比,不按序列化顺序
  same('<div class="a" id="x"></div>', '<div id="x" class="a"></div>');
});

test('标签和文本逐字', () => {
  differ('<span>1</span>', '<div>1</div>', '标签名');
  differ('<span>1</span>', '<span>2</span>', '文本');
  differ('<span>a </span>', '<span>a</span>', '空白不规范化');
  differ('<span></span>', '<span></span><span></span>', '记号数');
  same('<span>a</span>', '<span>a</span>');
});

test('空值属性、自闭合、注释', () => {
  same('<input disabled>', '<input disabled>');
  differ('<input disabled>', '<input>');
  same('<br/>', '<br/>');
  same('<!-- x --><b>1</b>', '<!-- x --><b>1</b>');
  differ('<!-- x --><b>1</b>', '<!-- y --><b>1</b>');
});

test('style / script 的内容当原始文本,里面的 < 不当标签', () => {
  const css = '<style>.a::after{content:"<";width:10.0px}</style>';
  same(css, css);
  differ(css, '<style>.a::after{content:"<";width:11px}</style>');
  // 原始文本走的是 text 记号,不走 style 属性那条容差
  differ('<style>.a{width:10.0px}</style>', '<style>.a{width:10.000000001px}</style>');
});

test('整段真实一点的快照:只有 transform 末位差 → 相同', () => {
  const html = (y, o) => `<div data-pc-part="root" class="hud" style="opacity: ${o}; transform: translateY(${y}px) scale(1);">`
    + `<svg viewBox="0 0 100 100"><linearGradient id="g__r"><stop offset="0.5"></stop></linearGradient>`
    + `<path d="M0 0 L100 100" fill="url(&quot;#g__r&quot;)"></path></svg><span>12</span></div>`;
  same(html(-8.655151367187500, 0.4), html(-8.655151367187501, 0.40000000000000002));
  differ(html(-8.65, 0.4), html(-8.66, 0.4));
  differ(html(-8.65, 0.4), html(-8.65, 0.5));
});

/* ------------------------------------------------------------ 词法分析 */

test('tokenizeHtml 切出来的记号', () => {
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

test('空串和非字符串', () => {
  same('', '');
  assert.equal(compareSnapshotHtml(null, '').same, false);
  assert.equal(compareSnapshotHtml('', undefined).same, false);
});

test('比对是纯函数:同一份输入两次结果一样,不改入参', () => {
  const a = '<div style="opacity: 0.30000000000000004;"></div>';
  const b = '<div style="opacity: 0.3;"></div>';
  assert.deepEqual(compareSnapshotHtml(a, b), compareSnapshotHtml(a, b));
  assert.equal(a, '<div style="opacity: 0.30000000000000004;"></div>');
});
