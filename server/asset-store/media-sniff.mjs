/**
 * Identifies asset category by file header bytes (for guest video count, `guest-quota.mjs`;
 * 2026-10-23 claude/guest-fix [ruling]).
 *
 * Why this is needed: guest video counts were previously determined by the extension reported by
 * the page (`X-Media-Ext`, whole file upload file name); if a guest reported a video as `jpg`, it
 * was not counted (review REVIEW-guest-identity A2, verified that all 5 mp4s were accepted). The
 * extension is reported by the page, but the file header is not: for any playable video, its first
 * few dozen bytes definitely look like its container.
 *
 * The recognized formats are those in the extension table of `server/vite-plugin-media.ts` (plus
 * several common containers playable in browsers):
 * - Video: ISO BMFF (mp4 / m4v / mov, `ftyp` box; legacy QuickTime starts with `moov` / `mdat` /
 *   `wide` / `free` / `skip`), Matroska / WebM (EBML header), AVI, MPEG-TS, MPEG-PS, FLV, ASF, Ogg
 *   containing Theora;
 * - Image: PNG, JPEG, GIF, WebP, BMP, AVIF / HEIF (`ftyp` with image brand), SVG (text, starting
 *   with `<`);
 * - Audio: MP3 (`ID3` or frame sync), AAC (ADTS), WAV, Ogg (not Theora), FLAC, M4A (`ftyp` with
 *   audio brand).
 *
 * **What to do when unrecognized**: fail-closed, count as **video** (counted), with only two
 * exceptions:
 * 1. The extension reported by the page is already video: it counts as video anyway, same conclusion;
 * 2. The beginning is text (valid UTF-8, no control characters): a playable video container always
 *    starts with binary, text is never video.
 * Therefore, renaming a video's extension or providing an unrecognized container both result in
 * "counting as one video"; properly uploaded images and audio are recognized and unaffected.
 *
 * WebM / Matroska might also contain only audio, but is treated as video here across the board
 * (preferring overcounting).
 *
 * Only imports Node built-in modules (in fact imports nothing).
 */

/** Number of bytes to read for type recognition: all checks fall within this range */
export const SNIFF_BYTES = 64;

const ascii = (buf, at, text) => buf.length >= at + text.length && buf.toString('latin1', at, at + text.length) === text;
const bytesAt = (buf, at, list) => buf.length >= at + list.length && list.every((b, i) => buf[at + i] === b);

/** Major brands of ISO BMFF (`ftyp` box): which are images, which are audio; all others are video */
const IMAGE_BRANDS = new Set(['avif', 'avis', 'heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1']);
const AUDIO_BRANDS = new Set(['M4A ', 'M4B ', 'M4P ', 'F4A ', 'F4B ']);
/** Box types at the beginning of legacy QuickTime files without `ftyp` */
const QT_ATOMS = new Set(['moov', 'mdat', 'wide', 'free', 'skip', 'pnot']);

/** Whether the beginning is plain text (valid UTF-8, no control characters except tab, LF, CR; BOM allowed at start) */
function looksLikeText(buf) {
  if (!buf.length) return false;
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch (error) {
    // Truncated in the middle of a multi-byte character: strip incomplete trailing bytes and retry
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, Math.max(0, buf.length - 3))); }
    catch { return false; }
  }
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text.replace(/^﻿/, ''));
}

/**
 * Recognizes type by leading bytes.
 * @param {Uint8Array | Buffer | null | undefined} head File head (provide at least `SNIFF_BYTES`, or entire file for short files)
 * @returns {'video' | 'image' | 'audio' | 'text' | 'unknown'}
 */
export function sniffMediaKind(head) {
  if (!head || !head.length) return 'unknown';
  const buf = Buffer.isBuffer(head) ? head : Buffer.from(head.buffer, head.byteOffset, head.byteLength);
  // ISO BMFF: bytes 4-8 are `ftyp`, major brand at 8-12; then check if compatible brands contain image brands (some AVIF have major brand mif1)
  if (ascii(buf, 4, 'ftyp')) {
    const major = buf.toString('latin1', 8, 12);
    if (AUDIO_BRANDS.has(major)) return 'audio';
    if (IMAGE_BRANDS.has(major)) return 'image';
    return 'video';
  }
  if (buf.length >= 8 && QT_ATOMS.has(buf.toString('latin1', 4, 8))) return 'video';
  if (bytesAt(buf, 0, [0x1a, 0x45, 0xdf, 0xa3])) return 'video'; // EBML: WebM / Matroska
  if (ascii(buf, 0, 'RIFF')) {
    const form = buf.toString('latin1', 8, 12);
    if (form === 'WEBP') return 'image';
    if (form === 'WAVE') return 'audio';
    return 'video'; // AVI and unrecognized RIFF
  }
  if (ascii(buf, 0, 'FLV')) return 'video';
  if (bytesAt(buf, 0, [0x30, 0x26, 0xb2, 0x75])) return 'video'; // ASF / WMV
  if (bytesAt(buf, 0, [0x00, 0x00, 0x01, 0xba]) || bytesAt(buf, 0, [0x00, 0x00, 0x01, 0xb3])) return 'video'; // MPEG-PS / MPEG-1
  if (buf[0] === 0x47 && (buf.length < 189 || buf[188] === 0x47)) {
    // MPEG-TS: 0x47 every 188 bytes. When only receiving the head, check only the first byte, then exclude text starting with G (GIF is recognized first below)
    if (!ascii(buf, 0, 'GIF8') && !looksLikeText(buf)) return 'video';
  }
  if (ascii(buf, 0, 'OggS')) return buf.includes(Buffer.from('theora', 'latin1')) ? 'video' : 'audio';
  // Image
  if (bytesAt(buf, 0, [0x89, 0x50, 0x4e, 0x47])) return 'image';
  if (bytesAt(buf, 0, [0xff, 0xd8, 0xff])) return 'image';
  if (ascii(buf, 0, 'GIF8')) return 'image';
  if (ascii(buf, 0, 'BM') && buf.length >= 14) return 'image';
  // Audio
  if (ascii(buf, 0, 'ID3') || ascii(buf, 0, 'fLaC')) return 'audio';
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'audio'; // MP3 frame sync / AAC ADTS
  if (looksLikeText(buf)) return 'text';
  return 'unknown';
}

/**
 * Whether this file counts as a video: files whose header is recognized as video count,
 * unrecognized (and not text) also count; files recognized as image, audio, or text do not count.
 * If the extension reported by the page is video, it counts regardless of what the header says
 * (only falls back toward counting).
 *
 * @param {Uint8Array | Buffer | null | undefined} head
 * @param {boolean} claimedVideo Whether the extension reported by the page is video
 */
export function countsAsVideoFile(head, claimedVideo) {
  if (claimedVideo) return true;
  const kind = sniffMediaKind(head);
  return kind === 'video' || kind === 'unknown';
}
