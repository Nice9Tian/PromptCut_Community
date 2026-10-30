import test from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { pngIntegrityError } from '../bakery/png-integrity.mjs';

function samplePng() {
  const png = new PNG({ width: 64, height: 32 });
  for (let i = 0; i < png.data.length; i++) png.data[i] = (i * 37) & 0xff;
  return PNG.sync.write(png);
}

test('a well-formed PNG passes', () => {
  assert.equal(pngIntegrityError(samplePng()), null);
});

test('a flipped byte inside compressed image data is a CRC mismatch', () => {
  // The Tokyo export failure: Chrome returned an IDAT whose bytes no longer
  // matched their CRC, and ffmpeg dropped that frame and the following ones.
  const png = samplePng();
  const idat = png.indexOf('IDAT', 0, 'latin1');
  png[idat + 4 + 10] ^= 0xff;
  assert.match(pngIntegrityError(png), /CRC mismatch in IDAT/);
});

test('truncated, padded and non-PNG buffers are rejected', () => {
  const png = samplePng();
  assert.match(pngIntegrityError(png.subarray(0, png.length - 6)), /overruns|truncated|missing IEND/);
  assert.match(pngIntegrityError(Buffer.concat([png, Buffer.from('junk')])), /4 bytes after IEND/);
  assert.equal(pngIntegrityError(Buffer.from('not a png')), 'bad PNG signature');
  assert.equal(pngIntegrityError(png.subarray(0, 8)), 'missing IEND chunk');
});
