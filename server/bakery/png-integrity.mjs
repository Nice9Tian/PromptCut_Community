import zlib from 'node:zlib';

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
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

/** Null for a structurally sound PNG, otherwise what is wrong with it.
 * Checks the signature, chunk bounds, every chunk CRC, IHDR first, IEND last
 * and no trailing bytes. It does not inflate IDAT: a CRC over the compressed
 * bytes already detects damage to them, at a fraction of the cost.
 */
export function pngIntegrityError(buffer) {
  if (buffer.length < SIGNATURE.length || !buffer.subarray(0, SIGNATURE.length).equals(SIGNATURE)) return 'bad PNG signature';
  let at = SIGNATURE.length;
  let first = true;
  while (at < buffer.length) {
    if (at + 12 > buffer.length) return `truncated chunk header at byte ${at}`;
    const length = buffer.readUInt32BE(at);
    const type = buffer.toString('latin1', at + 4, at + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) return `invalid chunk type at byte ${at}`;
    if (first && type !== 'IHDR') return `first chunk is ${type}, not IHDR`;
    first = false;
    const end = at + 8 + length;
    if (end + 4 > buffer.length) return `${type} chunk overruns the file at byte ${at}`;
    if (crc32(buffer.subarray(at + 4, end)) !== buffer.readUInt32BE(end)) return `CRC mismatch in ${type} chunk at byte ${at}`;
    at = end + 4;
    if (type === 'IEND') return at === buffer.length ? null : `${buffer.length - at} bytes after IEND`;
  }
  return 'missing IEND chunk';
}
