import test from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { isFullyTransparentPng } from '../frame-validity.mjs';

const rgba = (width, height, paint = () => {}) => {
  const png = new PNG({ width, height });
  png.data.fill(0);
  paint(png);
  return PNG.sync.write(png);
};

test('an empty RGBA frame is fully transparent, at stage size too', () => {
  assert.equal(isFullyTransparentPng(rgba(64, 32)), true);
  const started = performance.now();
  assert.equal(isFullyTransparentPng(rgba(1920, 1080)), true);
  assert.ok(performance.now() - started < 2000);
});

test('one visible pixel anywhere, even in the last row, is content', () => {
  assert.equal(isFullyTransparentPng(rgba(64, 32, png => { png.data[(31 * 64 + 63) * 4 + 3] = 1; })), false);
  assert.equal(isFullyTransparentPng(rgba(1920, 1080, png => { png.data[(1079 * 1920 + 1919) * 4 + 3] = 255; })), false);
  assert.equal(isFullyTransparentPng(rgba(64, 32, png => { png.data[0] = 255; png.data[3] = 255; })), false);
});

test('opaque RGB frames, damaged data and non-PNG input are never reported transparent', () => {
  const rgb = new PNG({ width: 16, height: 16, colorType: 2, inputColorType: 6 });
  rgb.data.fill(0);
  assert.equal(isFullyTransparentPng(PNG.sync.write(rgb, { colorType: 2 })), false);
  const damaged = rgba(64, 32);
  assert.equal(isFullyTransparentPng(damaged.subarray(0, damaged.length - 20)), false);
  assert.equal(isFullyTransparentPng(Buffer.from('png')), false);
  assert.equal(isFullyTransparentPng(null), false);
});
