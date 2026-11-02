/**
 * Muxing for track stream segments ("generation" on the browser side; "playback" is in
 * `streamPlayer.ts`).
 *
 * Packages H.264 access units from `VideoEncoder` into fMP4 with the same structure as the ffmpeg path:
 *
 *   - **Initialization segment** = `ftyp + moov` (no samples in `moov`, only `avcC`, width/height,
 *     timescale, and `mvex`);
 *   - **Segment** = `moof + mdat`, `SEGMENT_FRAMES` samples per segment, the first being a keyframe;
 *   - timescale = fps, duration 1 per sample (consistent with `-video_track_timescale fps` in
 *     `server/bakery/ffmpeg.mjs`);
 *   - `tfhd` has `default-base-is-moof`, data offset in `trun` is based on the start of `moof`:
 *     both `parseSegment` in `streamPlayer.ts` and `splitFmp4` / `segmentInfo` in
 *     `server/frame-stream.mjs` read it this way.
 *
 * Zero dependencies; runs in both browser and Node (unit tests). This layer only handles bytes and
 * is agnostic to the encoder.
 */

/** A sample: an access unit in AVCC format (NAL with 4-byte length prefix) */
export interface MuxSample { data: Uint8Array; isSync: boolean }

export interface StreamInitConfig {
  /** Width and height of encoded visuals (after top-bottom stitching, not the card's) */
  width: number;
  height: number;
  fps: number;
  /** `decoderConfig.description` output by `VideoEncoder`: AVCDecoderConfigurationRecord */
  avcC: Uint8Array;
}

const TEXT = new TextEncoder();

function concat(parts: ReadonlyArray<Uint8Array>): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const u8 = (...v: number[]): Uint8Array => Uint8Array.from(v);
const u16 = (v: number): Uint8Array => u8((v >>> 8) & 0xff, v & 0xff);
const u32 = (v: number): Uint8Array => u8((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
const u64 = (v: number): Uint8Array => { const hi = Math.floor(v / 0x100000000); return concat([u32(hi), u32(v - hi * 0x100000000)]); };
const zeros = (n: number): Uint8Array => new Uint8Array(n);
const fourcc = (s: string): Uint8Array => TEXT.encode(s);

export function box(type: string, ...content: Uint8Array[]): Uint8Array {
  const body = concat(content);
  return concat([u32(8 + body.length), fourcc(type), body]);
}

function fullBox(type: string, version: number, flags: number, ...content: Uint8Array[]): Uint8Array {
  return box(type, u32(((version & 0xff) << 24) | (flags & 0xffffff)), ...content);
}

/** Identity matrix (16.16 fixed point, last row 2.30) */
const MATRIX = concat([u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000)]);

/** Sample flags: keyframes "do not depend on other frames"; others "depend on other frames, not a sync sample" */
export const SAMPLE_FLAGS_SYNC = 0x02000000;
export const SAMPLE_FLAGS_NON_SYNC = 0x01010000;

function assertPositiveInt(name: string, v: number): void {
  if (!Number.isInteger(v) || v <= 0) throw new Error(`Track stream muxing: ${name} must be a positive integer, got ${v}`);
}

/** Initialization segment: `ftyp + moov`. Shared by all segments of the same stream */
export function buildStreamInit(cfg: StreamInitConfig): Uint8Array {
  assertPositiveInt('width', cfg.width);
  assertPositiveInt('height', cfg.height);
  assertPositiveInt('fps', cfg.fps);
  if (cfg.width > 0xffff || cfg.height > 0xffff) throw new Error('Track stream muxing: width/height exceed what avc1 can store');
  if (!(cfg.avcC instanceof Uint8Array) || cfg.avcC.length < 7 || cfg.avcC[0] !== 1) throw new Error('Track stream muxing: avcC is not an AVCDecoderConfigurationRecord');

  const ftyp = box('ftyp', fourcc('isom'), u32(0x200), fourcc('isom'), fourcc('iso6'), fourcc('avc1'), fourcc('mp41'));

  const mvhd = fullBox('mvhd', 0, 0,
    u32(0), u32(0), u32(cfg.fps), u32(0),            // Creation, modification, timescale, duration (those in segments not included)
    u32(0x00010000), u16(0x0100), zeros(10),          // Rate 1.0, volume 1.0, reserved
    MATRIX, zeros(24), u32(2));                       // Matrix, predefined, next track ID

  const tkhd = fullBox('tkhd', 0, 0x000003,           // Enabled, in movie
    u32(0), u32(0), u32(1), u32(0), u32(0),            // Creation, modification, track ID, reserved, duration
    zeros(8), u16(0), u16(0), u16(0), u16(0),          // Reserved, layer, group, volume, reserved
    MATRIX, u32(cfg.width << 16), u32(cfg.height << 16));

  const mdhd = fullBox('mdhd', 0, 0, u32(0), u32(0), u32(cfg.fps), u32(0), u16(0x55c4), u16(0));   // Language und
  const hdlr = fullBox('hdlr', 0, 0, u32(0), fourcc('vide'), zeros(12), fourcc('PromptCut stream'), u8(0));
  const vmhd = fullBox('vmhd', 0, 0x000001, u16(0), zeros(6));
  const dinf = box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 0x000001)));

  // Color: matches ffmpeg path with bt709, limited range (nclx in `colr`: primaries 1, transfer 1, matrix 1, full_range 0)
  const colr = box('colr', fourcc('nclx'), u16(1), u16(1), u16(1), u8(0));
  const avc1 = box('avc1',
    zeros(6), u16(1),                                  // Reserved, data reference index
    zeros(16),                                         // Predefined and reserved
    u16(cfg.width), u16(cfg.height),
    u32(0x00480000), u32(0x00480000),                  // 72 dpi
    u32(0), u16(1),                                    // Reserved, frames per sample
    zeros(32),                                         // Compressor name
    u16(0x0018), u16(0xffff),                          // Bit depth 24, predefined -1
    box('avcC', cfg.avcC), colr);
  const stbl = box('stbl',
    fullBox('stsd', 0, 0, u32(1), avc1),
    fullBox('stts', 0, 0, u32(0)),
    fullBox('stsc', 0, 0, u32(0)),
    fullBox('stsz', 0, 0, u32(0), u32(0)),
    fullBox('stco', 0, 0, u32(0)));
  const trak = box('trak', tkhd, box('mdia', mdhd, hdlr, box('minf', vmhd, dinf, stbl)));

  // Per-sample defaults: description index 1, duration 1, size 0 (provided per sample), flags as non-keyframe
  const mvex = box('mvex', fullBox('trex', 0, 0, u32(1), u32(1), u32(1), u32(0), u32(SAMPLE_FLAGS_NON_SYNC)));
  return concat([ftyp, box('moov', mvhd, trak, mvex)]);
}

export interface StreamSegmentInput {
  /** Sequence number in `moof`, starting from 1; segment index + 1 is sufficient */
  sequence: number;
  /** Decode time of first sample in this segment (in timescale units, i.e. index of this segment's first sample in entire stream) */
  baseDecodeTime: number;
  samples: ReadonlyArray<MuxSample>;
}

/** A segment: `moof + mdat` */
export function buildStreamSegment(input: StreamSegmentInput): Uint8Array {
  assertPositiveInt('sequence', input.sequence);
  if (!Number.isInteger(input.baseDecodeTime) || input.baseDecodeTime < 0) throw new Error('Track stream muxing: baseDecodeTime must be a non-negative integer');
  const samples = input.samples;
  if (!samples.length) throw new Error('Track stream muxing: the segment has no samples');
  if (!samples[0].isSync) throw new Error('Track stream muxing: the first sample of a segment must be a keyframe');
  for (const s of samples) if (!(s.data instanceof Uint8Array) || !s.data.length) throw new Error('Track stream muxing: the sample is empty');

  // tfhd: default-base-is-moof (0x020000); tfdt uses version 1 (64-bit);
  // trun: data offset (0x1) + per-sample size (0x200) + per-sample flags (0x400), duration uses trex default 1
  const tfhd = fullBox('tfhd', 0, 0x020000, u32(1));
  const tfdt = fullBox('tfdt', 1, 0, u64(input.baseDecodeTime));
  const table: Uint8Array[] = [];
  for (const s of samples) table.push(u32(s.data.length), u32(s.isSync ? SAMPLE_FLAGS_SYNC : SAMPLE_FLAGS_NON_SYNC));
  const trunOf = (dataOffset: number) => fullBox('trun', 0, 0x000601, u32(samples.length), u32(dataOffset), ...table);
  const moofOf = (dataOffset: number) => box('moof', fullBox('mfhd', 0, 0, u32(input.sequence)), box('traf', tfhd, tfdt, trunOf(dataOffset)));

  // Data offset = moof length + mdat 8-byte header; moof length does not change with offset value, measure once first
  const moof = moofOf(moofOf(0).length + 8);
  return concat([moof, box('mdat', ...samples.map((s) => s.data))]);
}

/** `avcC` → `avc1.PPCCLL` (same formatting as `parseInit` in `streamPlayer.ts` and `codecOfAvcC` on server) */
export function codecOfAvcC(avcC: Uint8Array): string {
  const hex = (n: number) => n.toString(16).padStart(2, '0');
  return `avc1.${hex(avcC[1])}${hex(avcC[2])}${hex(avcC[3])}`;
}
