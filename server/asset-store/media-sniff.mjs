/**
 * 按文件头字节认素材是哪一类（游客视频条数用，`guest-quota.mjs`；2026-10-23 claude/guest-fix〔裁〕）。
 *
 * 为什么要有它：游客的视频条数原先按页面报的扩展名（`X-Media-Ext`、整件上传的文件名）判，游客把视频报成
 * `jpg` 就不计数（审查 REVIEW-guest-identity 的 A2，实测 5 条 mp4 全收）。扩展名是页面说的，文件头不是：
 * 一个能播放的视频，开头几十个字节一定是它那种容器的样子。
 *
 * 认的范围就是 `server/vite-plugin-media.ts` 那张扩展名表里的格式（加上浏览器能播的几种常见容器）：
 * - 视频：ISO BMFF（mp4 / m4v / mov，`ftyp` 盒子；老式 QuickTime 开头是 `moov` / `mdat` / `wide` / `free` / `skip`）、
 *   Matroska / WebM（EBML 头）、AVI、MPEG-TS、MPEG-PS、FLV、ASF、Ogg 里装 Theora 的；
 * - 图片：PNG、JPEG、GIF、WebP、BMP、AVIF / HEIF（`ftyp` 带图片牌子）、SVG（文本，以 `<` 开头）；
 * - 音频：MP3（`ID3` 或帧同步）、AAC（ADTS）、WAV、Ogg（不是 Theora）、FLAC、M4A（`ftyp` 带音频牌子）。
 *
 * **认不出来的怎么办**：失败要闭合，按**视频**算（计数），只有两种例外——
 * 1. 页面报的扩展名本身就是视频：本来就算视频，结论一样；
 * 2. 开头是一段文本（合法 UTF-8、没有控制字符）：能播放的视频容器开头一定是二进制，文本绝不会是视频。
 * 所以把一个视频改了扩展名、或者塞一个我们认不出的容器，结果都是「算一条视频」；正经传的图片、音频都认得出，不受影响。
 *
 * WebM / Matroska 也可能只装音频，这里一律当视频（宁可多算）。
 *
 * 只引 Node 内置模块（其实什么也不引）。
 */

/** 认类型要读的字节数：所有判断都落在这一段里 */
export const SNIFF_BYTES = 64;

const ascii = (buf, at, text) => buf.length >= at + text.length && buf.toString('latin1', at, at + text.length) === text;
const bytesAt = (buf, at, list) => buf.length >= at + list.length && list.every((b, i) => buf[at + i] === b);

/** ISO BMFF（`ftyp` 盒子）的主牌子：哪些是图片、哪些是音频；其余一律视频 */
const IMAGE_BRANDS = new Set(['avif', 'avis', 'heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1']);
const AUDIO_BRANDS = new Set(['M4A ', 'M4B ', 'M4P ', 'F4A ', 'F4B ']);
/** 没有 `ftyp` 的老式 QuickTime 文件，开头那个盒子的类型 */
const QT_ATOMS = new Set(['moov', 'mdat', 'wide', 'free', 'skip', 'pnot']);

/** 开头这一段是不是纯文本（合法 UTF-8，除了制表、换行、回车不带控制字符；开头允许 BOM） */
function looksLikeText(buf) {
  if (!buf.length) return false;
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch (error) {
    // 截断在一个多字节字符中间：去掉末尾不完整的那几个字节再试
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, Math.max(0, buf.length - 3))); }
    catch { return false; }
  }
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text.replace(/^﻿/, ''));
}

/**
 * 按开头的字节认类型。
 * @param {Uint8Array | Buffer | null | undefined} head 文件开头（至少给 `SNIFF_BYTES` 个，短文件给全部）
 * @returns {'video' | 'image' | 'audio' | 'text' | 'unknown'}
 */
export function sniffMediaKind(head) {
  if (!head || !head.length) return 'unknown';
  const buf = Buffer.isBuffer(head) ? head : Buffer.from(head.buffer, head.byteOffset, head.byteLength);
  // ISO BMFF：第 4～8 字节是 `ftyp`，主牌子在 8～12；再看兼容牌子里有没有图片牌子（有的 AVIF 主牌子写 mif1）
  if (ascii(buf, 4, 'ftyp')) {
    const major = buf.toString('latin1', 8, 12);
    if (AUDIO_BRANDS.has(major)) return 'audio';
    if (IMAGE_BRANDS.has(major)) return 'image';
    return 'video';
  }
  if (buf.length >= 8 && QT_ATOMS.has(buf.toString('latin1', 4, 8))) return 'video';
  if (bytesAt(buf, 0, [0x1a, 0x45, 0xdf, 0xa3])) return 'video'; // EBML：WebM / Matroska
  if (ascii(buf, 0, 'RIFF')) {
    const form = buf.toString('latin1', 8, 12);
    if (form === 'WEBP') return 'image';
    if (form === 'WAVE') return 'audio';
    return 'video'; // AVI 以及认不出的 RIFF
  }
  if (ascii(buf, 0, 'FLV')) return 'video';
  if (bytesAt(buf, 0, [0x30, 0x26, 0xb2, 0x75])) return 'video'; // ASF / WMV
  if (bytesAt(buf, 0, [0x00, 0x00, 0x01, 0xba]) || bytesAt(buf, 0, [0x00, 0x00, 0x01, 0xb3])) return 'video'; // MPEG-PS / MPEG-1
  if (buf[0] === 0x47 && (buf.length < 189 || buf[188] === 0x47)) {
    // MPEG-TS：每 188 字节一个 0x47。只拿到开头一段时只看第一个字节，再排除掉以 G 开头的文本（GIF 在下面先认）
    if (!ascii(buf, 0, 'GIF8') && !looksLikeText(buf)) return 'video';
  }
  if (ascii(buf, 0, 'OggS')) return buf.includes(Buffer.from('theora', 'latin1')) ? 'video' : 'audio';
  // 图片
  if (bytesAt(buf, 0, [0x89, 0x50, 0x4e, 0x47])) return 'image';
  if (bytesAt(buf, 0, [0xff, 0xd8, 0xff])) return 'image';
  if (ascii(buf, 0, 'GIF8')) return 'image';
  if (ascii(buf, 0, 'BM') && buf.length >= 14) return 'image';
  // 音频
  if (ascii(buf, 0, 'ID3') || ascii(buf, 0, 'fLaC')) return 'audio';
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'audio'; // MP3 帧同步 / AAC ADTS
  if (looksLikeText(buf)) return 'text';
  return 'unknown';
}

/**
 * 这个文件算不算一条视频：文件头认出是视频的算，认不出（又不是文本）的也算；认出是图片、音频、文本的不算。
 * 页面报的扩展名是视频的，不管文件头怎么说都算（只往「计数」那边退）。
 *
 * @param {Uint8Array | Buffer | null | undefined} head
 * @param {boolean} claimedVideo 页面报的扩展名是不是视频
 */
export function countsAsVideoFile(head, claimedVideo) {
  if (claimedVideo) return true;
  const kind = sniffMediaKind(head);
  return kind === 'video' || kind === 'unknown';
}
