import zlib from 'node:zlib';

/**
 * A frame cache is shared by processes (the editor server and the background
 * prerender worker write the same directory), and each process rewrites the
 * frame table from its own view. The render record — what produced a frame —
 * therefore travels inside the PNG itself, as a tEXt chunk right after IHDR.
 * Decoders ignore it; any process can read it from the first bytes of a file.
 */
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const KEY = 'promptcut-render';

let table = null;
function tableCrc32(data) {
  table ??= Int32Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });
  let c = -1;
  for (let i = 0; i < data.length; i++) c = table[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
const crc32 = zlib.crc32 ?? tableCrc32;

const isPng = buffer => Buffer.isBuffer(buffer) && buffer.length >= 33 && buffer.subarray(0, 8).equals(SIGNATURE);

function* chunks(buffer) {
  let at = 8;
  while (at + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(at);
    const end = at + 12 + length;
    if (end > buffer.length) return;
    const type = buffer.toString('latin1', at + 4, at + 8);
    yield { at, end, type, data: buffer.subarray(at + 8, at + 8 + length) };
    if (type === 'IEND') return;
    at = end;
  }
}

const isRecordChunk = chunk => chunk.type === 'tEXt' && chunk.data.length > KEY.length
  && chunk.data.toString('latin1', 0, KEY.length + 1) === KEY + '\0';

/** The PNG with `record` embedded (replacing an earlier record). Anything that
 * is not a PNG with an IHDR is returned unchanged. The record must be ASCII JSON. */
export function withRenderRecord(png, record) {
  if (!isPng(png)) return png;
  const text = Buffer.from(KEY + '\0' + JSON.stringify(record), 'latin1');
  const chunk = Buffer.alloc(12 + text.length);
  chunk.writeUInt32BE(text.length, 0);
  chunk.write('tEXt', 4, 'latin1');
  text.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + text.length)), 8 + text.length);
  const parts = [png.subarray(0, 8)];
  let inserted = false, last = 8;
  for (const c of chunks(png)) {
    last = c.end;
    if (isRecordChunk(c)) continue;
    parts.push(png.subarray(c.at, c.end));
    if (c.type === 'IHDR' && !inserted) { parts.push(chunk); inserted = true; }
  }
  if (!inserted) return png;
  if (last < png.length) parts.push(png.subarray(last));
  return Buffer.concat(parts);
}

/** The embedded record, or null. `head` may be just the first bytes of a file:
 * the record sits before any image data. */
export function readRenderRecord(head) {
  if (!isPng(head)) return null;
  for (const c of chunks(head)) {
    if (isRecordChunk(c)) {
      try { return JSON.parse(c.data.toString('latin1', KEY.length + 1)); } catch { return null; }
    }
    if (c.type === 'IDAT') return null;
  }
  return null;
}
