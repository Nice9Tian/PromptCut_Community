// 二维码编码器。跑法:node --test server/test/qr.test.mjs
//
// 三个指纹是 2026-09-08 用 Python 的 qrcode 库(96 组:版本 1~13、L/M、8 种掩码逐模块对拍
// 全部一致)之后,再经 jsQR 实际解码确认过的产物。以后改了编码器,指纹变就得重新对拍。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { encodeQr, encodeCodewords, qrSvg, MAX_VERSION } from '../qr.mjs';

const BILI = 'https://account.bilibili.com/h5/account-h5/auth/scan-web?navhide=1&callback=close&qrcode_key=aa6b16028dda91ae6543bed069a249ea&from=';

function fingerprint(q) {
  const bits = q.modules.map((r) => r.map((v) => (v ? '1' : '0')).join('')).join('\n');
  return createHash('sha256').update(bits).digest('hex').slice(0, 16);
}

test('指纹:和参考库对拍过的三张码', () => {
  const a = encodeQr('hello 你好', { ec: 'M' });
  assert.deepEqual([a.version, a.size, a.mask, fingerprint(a)], [1, 21, 0, '62ed0b8475140c8f']);
  const b = encodeQr(BILI, { ec: 'M' });
  assert.deepEqual([b.version, b.size, b.mask, fingerprint(b)], [8, 49, 2, '2577d5839d3e4942']);
  const c = encodeQr('x'.repeat(300), { ec: 'L' });
  assert.deepEqual([c.version, c.size, c.mask, fingerprint(c)], [11, 61, 0, 'd7800c87eac801b0']);
});

test('字节模式的头:模式 0100 + 计数(版本 ≤9 用 8 位,≥10 用 16 位)', () => {
  const s = encodeCodewords('hello 你好', { ec: 'M' });
  assert.equal(s.version, 1);
  // "hello 你好" 是 12 字节:0100 0000_1100 → 0x40, 0xC6…
  assert.equal(s.data[0], 0x40);
  assert.equal(s.data[1], 0xc6);
  assert.equal(s.data.length, 16, '版本 1-M 有 16 个数据码字');
  assert.equal(s.codewords.length, 26, '加 10 个纠错码字');
  const big = encodeCodewords('x'.repeat(300), { ec: 'L' });
  assert.equal(big.version, 11);
  assert.deepEqual(big.data.slice(0, 3), [0x40, 0x12, 0xc7], '300 = 0x012C,16 位计数');
  assert.equal(big.codewords.length, 404);
});

test('功能图案:三个定位图案、时序、固定暗模块', () => {
  const q = encodeQr('abc');
  const m = q.modules;
  const n = q.size;
  // 定位图案外圈 7×7 全暗,里面第二圈全亮
  for (const [cx, cy] of [[3, 3], [n - 4, 3], [3, n - 4]]) {
    for (let d = -3; d <= 3; d++) {
      assert.equal(m[cy - 3][cx + d], true);
      assert.equal(m[cy + 3][cx + d], true);
      assert.equal(m[cy + d][cx - 3], true);
      assert.equal(m[cy + d][cx + 3], true);
    }
    assert.equal(m[cy - 2][cx], false);
    assert.equal(m[cy][cy === 3 && cx === 3 ? cx : cx], true, '中心是暗的');
  }
  // 时序:第 6 行 / 列在两个定位图案之间明暗交替
  for (let i = 8; i < n - 8; i++) {
    assert.equal(m[6][i], i % 2 === 0);
    assert.equal(m[i][6], i % 2 === 0);
  }
  assert.equal(m[n - 8][8], true, '固定暗模块');
});

test('版本选择:装不下就升版本,超过上限就抛', () => {
  assert.equal(encodeQr('a').version, 1);
  assert.equal(encodeQr('a'.repeat(15), { ec: 'M' }).version, 2, '版本 1-M 最多 14 字节');
  assert.equal(encodeQr('a'.repeat(17), { ec: 'L' }).version, 1, '版本 1-L 最多 17 字节');
  assert.throws(() => encodeQr('a'.repeat(700)), new RegExp(`版本 ${MAX_VERSION}`));
  assert.throws(() => encodeQr('a', { ec: 'H' }), /只支持 L \/ M/);
});

test('掩码:不指定时挑罚分最低的;指定了就用指定的', () => {
  const auto = encodeQr(BILI);
  assert.ok(auto.mask >= 0 && auto.mask <= 7);
  for (let k = 0; k < 8; k++) assert.equal(encodeQr(BILI, { mask: k }).mask, k);
  // 同一个输入两次结果一样
  assert.equal(fingerprint(encodeQr(BILI)), fingerprint(encodeQr(BILI)));
});

test('SVG:viewBox 含 4 格留白,每个暗模块一个 1×1 的路径段', () => {
  const q = encodeQr('hi');
  const svg = qrSvg('hi', { scale: 3 });
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 29 29" width="87" height="87"/);
  const dark = q.modules.flat().filter(Boolean).length;
  assert.equal((svg.match(/h1v1h-1z/g) || []).length, dark);
  assert.match(svg, /fill="#fff"/);
});
