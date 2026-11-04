// QR code encoder. Run: node --test server/test/qr.test.mjs
//
// The three fingerprints are artifacts confirmed on 2026-09-08 via actual decoding with jsQR after
// module-by-module cross-checks against Python's qrcode library (96 sets: versions 1-13, L/M,
// 8 masks, all matching). If the encoder changes later and fingerprints change, re-cross-check.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { encodeQr, encodeCodewords, qrSvg, MAX_VERSION } from '../qr.mjs';

const BILI = 'https://account.bilibili.com/h5/account-h5/auth/scan-web?navhide=1&callback=close&qrcode_key=aa6b16028dda91ae6543bed069a249ea&from=';

function fingerprint(q) {
  const bits = q.modules.map((r) => r.map((v) => (v ? '1' : '0')).join('')).join('\n');
  return createHash('sha256').update(bits).digest('hex').slice(0, 16);
}

test('fingerprint: three codes cross-checked against the reference library', () => {
  const a = encodeQr('hello 你好', { ec: 'M' });
  assert.deepEqual([a.version, a.size, a.mask, fingerprint(a)], [1, 21, 0, '62ed0b8475140c8f']);
  const b = encodeQr(BILI, { ec: 'M' });
  assert.deepEqual([b.version, b.size, b.mask, fingerprint(b)], [8, 49, 2, '2577d5839d3e4942']);
  const c = encodeQr('x'.repeat(300), { ec: 'L' });
  assert.deepEqual([c.version, c.size, c.mask, fingerprint(c)], [11, 61, 0, 'd7800c87eac801b0']);
});

test('byte mode header: mode 0100 + count (versions ≤9 use 8 bits, ≥10 use 16 bits)', () => {
  const s = encodeCodewords('hello 你好', { ec: 'M' });
  assert.equal(s.version, 1);
  // "hello ni hao" is 12 bytes: 0100 0000_1100 → 0x40, 0xC6…
  assert.equal(s.data[0], 0x40);
  assert.equal(s.data[1], 0xc6);
  assert.equal(s.data.length, 16, 'version 1-M has 16 data codewords');
  assert.equal(s.codewords.length, 26, 'add 10 error-correction codewords');
  const big = encodeCodewords('x'.repeat(300), { ec: 'L' });
  assert.equal(big.version, 11);
  assert.deepEqual(big.data.slice(0, 3), [0x40, 0x12, 0xc7], '300 = 0x012C, 16-bit count');
  assert.equal(big.codewords.length, 404);
});

test('function patterns: three finder patterns, timing, fixed dark module', () => {
  const q = encodeQr('abc');
  const m = q.modules;
  const n = q.size;
  // Finder pattern outer 7×7 ring is all dark, inner second ring is all light
  for (const [cx, cy] of [[3, 3], [n - 4, 3], [3, n - 4]]) {
    for (let d = -3; d <= 3; d++) {
      assert.equal(m[cy - 3][cx + d], true);
      assert.equal(m[cy + 3][cx + d], true);
      assert.equal(m[cy + d][cx - 3], true);
      assert.equal(m[cy + d][cx + 3], true);
    }
    assert.equal(m[cy - 2][cx], false);
    assert.equal(m[cy][cy === 3 && cx === 3 ? cx : cx], true, 'the center is dark');
  }
  // Timing: row / col 6 alternates between dark and light between the two finder patterns
  for (let i = 8; i < n - 8; i++) {
    assert.equal(m[6][i], i % 2 === 0);
    assert.equal(m[i][6], i % 2 === 0);
  }
  assert.equal(m[n - 8][8], true, 'fixed dark module');
});

test('version selection: move up a version when the data does not fit, throw when the limit is exceeded', () => {
  assert.equal(encodeQr('a').version, 1);
  assert.equal(encodeQr('a'.repeat(15), { ec: 'M' }).version, 2, 'version 1-M holds at most 14 bytes');
  assert.equal(encodeQr('a'.repeat(17), { ec: 'L' }).version, 1, 'version 1-L holds at most 17 bytes');
  assert.throws(() => encodeQr('a'.repeat(700)), new RegExp(`version ${MAX_VERSION}`));
  assert.throws(() => encodeQr('a', { ec: 'H' }), /only supports L \/ M/);
});

test('mask: when none is specified, pick the one with the lowest penalty; when one is specified, use it', () => {
  const auto = encodeQr(BILI);
  assert.ok(auto.mask >= 0 && auto.mask <= 7);
  for (let k = 0; k < 8; k++) assert.equal(encodeQr(BILI, { mask: k }).mask, k);
  // Same input produces the same result twice
  assert.equal(fingerprint(encodeQr(BILI)), fingerprint(encodeQr(BILI)));
});

test('SVG: the viewBox includes a 4-cell margin, with one 1×1 path segment per dark module', () => {
  const q = encodeQr('hi');
  const svg = qrSvg('hi', { scale: 3 });
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 29 29" width="87" height="87"/);
  const dark = q.modules.flat().filter(Boolean).length;
  assert.equal((svg.match(/h1v1h-1z/g) || []).length, dark);
  assert.match(svg, /fill="#fff"/);
});
