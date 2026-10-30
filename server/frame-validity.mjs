import zlib from 'node:zlib';

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** True when every pixel of a PNG is 0,0,0,0 — what Chrome writes for a frame
 * that painted nothing (a screenshot taken before media or cards arrived).
 *
 * No unfiltering is needed: under every PNG filter an all-zero image has
 * all-zero filtered bytes, and row by row the reverse also holds. Images
 * without an alpha channel are never transparent. Anything this function
 * cannot read confidently returns false, so validation never discards a frame
 * because of a format it does not understand.
 */
export function isFullyTransparentPng(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 33 || !buffer.subarray(0, 8).equals(SIGNATURE)) return false;
  let at = 8, width = 0, height = 0, bitDepth = 0, colourType = -1, interlace = 0;
  const idat = [];
  while (at + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(at);
    const type = buffer.toString('latin1', at + 4, at + 8);
    if (at + 12 + length > buffer.length) return false;
    const body = buffer.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      if (length < 13) return false;
      width = body.readUInt32BE(0); height = body.readUInt32BE(4);
      bitDepth = body[8]; colourType = body[9]; interlace = body[12];
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    at += 12 + length;
  }
  // Chrome screenshots are 8-bit RGB (opaque) or RGBA. Other layouts are not guessed.
  if (colourType !== 6 || bitDepth !== 8 || interlace !== 0 || !width || !height || !idat.length) return false;
  const stride = 1 + width * 4;
  const allZero = (raw, rows) => {
    for (let row = 0; row < rows; row++) {
      const end = (row + 1) * stride;
      for (let i = row * stride + 1; i < end; i++) if (raw[i] !== 0) return false;
    }
    return true;
  };
  const compressed = Buffer.concat(idat);
  try {
    // Most frames with content fail within the first rows; decompress only a
    // prefix first and leave the full inflate for images that look empty.
    const head = zlib.inflateSync(compressed.subarray(0, Math.min(compressed.length, 16384)), { finishFlush: zlib.constants.Z_SYNC_FLUSH });
    if (!allZero(head, Math.floor(head.length / stride))) return false;
    const raw = zlib.inflateSync(compressed);
    if (raw.length !== stride * height) return false;
    return allZero(raw, height);
  } catch { return false; }
}
