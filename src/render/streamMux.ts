/**
 * 轨道流分段的封装(浏览器这一头的「生成」;「播放」在 `streamPlayer.ts`)。
 *
 * 把 `VideoEncoder` 出的 H.264 访问单元封成和 ffmpeg 那条路同样形状的 fMP4:
 *
 *   - **初始化段** = `ftyp + moov`(`moov` 里没有样本,只有 `avcC`、宽高、时间刻度和 `mvex`);
 *   - **分段** = `moof + mdat`,一段 `SEGMENT_FRAMES` 个样本,第一个是关键帧;
 *   - 时间刻度 = fps,每个样本时长 1(和 `server/bakery/ffmpeg.mjs` 的 `-video_track_timescale fps` 一致);
 *   - `tfhd` 带 `default-base-is-moof`,`trun` 的数据偏移以 `moof` 起点为基 ——
 *     `streamPlayer.ts` 的 `parseSegment` 与 `server/frame-stream.mjs` 的 `splitFmp4` / `segmentInfo` 都这样读。
 *
 * 不引依赖,浏览器和 Node(单测)都能跑。这一层只管字节,不认识编码器。
 */

/** 一个样本:AVCC 形态(4 字节长度前缀的 NAL)的访问单元 */
export interface MuxSample { data: Uint8Array; isSync: boolean }

export interface StreamInitConfig {
  /** 编码画面的宽高(上下拼合之后的,不是卡片的) */
  width: number;
  height: number;
  fps: number;
  /** `VideoEncoder` 输出的 `decoderConfig.description`:AVCDecoderConfigurationRecord */
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

/** 单位矩阵(16.16 定点,最后一行 2.30) */
const MATRIX = concat([u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000)]);

/** 样本标志:关键帧「不依赖别的帧」;其余「依赖别的帧、不是同步样本」 */
export const SAMPLE_FLAGS_SYNC = 0x02000000;
export const SAMPLE_FLAGS_NON_SYNC = 0x01010000;

function assertPositiveInt(name: string, v: number): void {
  if (!Number.isInteger(v) || v <= 0) throw new Error(`轨道流封装:${name} 要是正整数,收到 ${v}`);
}

/** 初始化段:`ftyp + moov`。同一条流的所有分段共用它 */
export function buildStreamInit(cfg: StreamInitConfig): Uint8Array {
  assertPositiveInt('width', cfg.width);
  assertPositiveInt('height', cfg.height);
  assertPositiveInt('fps', cfg.fps);
  if (cfg.width > 0xffff || cfg.height > 0xffff) throw new Error('轨道流封装:宽高超出 avc1 能写的范围');
  if (!(cfg.avcC instanceof Uint8Array) || cfg.avcC.length < 7 || cfg.avcC[0] !== 1) throw new Error('轨道流封装:avcC 不是 AVCDecoderConfigurationRecord');

  const ftyp = box('ftyp', fourcc('isom'), u32(0x200), fourcc('isom'), fourcc('iso6'), fourcc('avc1'), fourcc('mp41'));

  const mvhd = fullBox('mvhd', 0, 0,
    u32(0), u32(0), u32(cfg.fps), u32(0),            // 创建、修改、时间刻度、时长(分段里的不计入)
    u32(0x00010000), u16(0x0100), zeros(10),          // 速率 1.0、音量 1.0、保留
    MATRIX, zeros(24), u32(2));                       // 矩阵、预定义、下一个轨道号

  const tkhd = fullBox('tkhd', 0, 0x000003,           // 启用、在影片里
    u32(0), u32(0), u32(1), u32(0), u32(0),            // 创建、修改、轨道号、保留、时长
    zeros(8), u16(0), u16(0), u16(0), u16(0),          // 保留、层、组、音量、保留
    MATRIX, u32(cfg.width << 16), u32(cfg.height << 16));

  const mdhd = fullBox('mdhd', 0, 0, u32(0), u32(0), u32(cfg.fps), u32(0), u16(0x55c4), u16(0));   // 语言 und
  const hdlr = fullBox('hdlr', 0, 0, u32(0), fourcc('vide'), zeros(12), fourcc('PromptCut stream'), u8(0));
  const vmhd = fullBox('vmhd', 0, 0x000001, u16(0), zeros(6));
  const dinf = box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 0x000001)));

  // 色彩:和 ffmpeg 那条路同样标 bt709、限定范围(`colr` 的 nclx:primaries 1、transfer 1、matrix 1、full_range 0)
  const colr = box('colr', fourcc('nclx'), u16(1), u16(1), u16(1), u8(0));
  const avc1 = box('avc1',
    zeros(6), u16(1),                                  // 保留、数据引用号
    zeros(16),                                         // 预定义与保留
    u16(cfg.width), u16(cfg.height),
    u32(0x00480000), u32(0x00480000),                  // 72 dpi
    u32(0), u16(1),                                    // 保留、每样本帧数
    zeros(32),                                         // 压缩器名
    u16(0x0018), u16(0xffff),                          // 位深 24、预定义 -1
    box('avcC', cfg.avcC), colr);
  const stbl = box('stbl',
    fullBox('stsd', 0, 0, u32(1), avc1),
    fullBox('stts', 0, 0, u32(0)),
    fullBox('stsc', 0, 0, u32(0)),
    fullBox('stsz', 0, 0, u32(0), u32(0)),
    fullBox('stco', 0, 0, u32(0)));
  const trak = box('trak', tkhd, box('mdia', mdhd, hdlr, box('minf', vmhd, dinf, stbl)));

  // 每个样本缺省:描述号 1、时长 1、大小 0(逐样本给)、标志按非关键帧
  const mvex = box('mvex', fullBox('trex', 0, 0, u32(1), u32(1), u32(1), u32(0), u32(SAMPLE_FLAGS_NON_SYNC)));
  return concat([ftyp, box('moov', mvhd, trak, mvex)]);
}

export interface StreamSegmentInput {
  /** `moof` 里的序号,从 1 起;分段号 + 1 即可 */
  sequence: number;
  /** 这一段第一个样本的解码时间(时间刻度单位,即这段的第一个样本在整条流里是第几个) */
  baseDecodeTime: number;
  samples: ReadonlyArray<MuxSample>;
}

/** 一个分段:`moof + mdat` */
export function buildStreamSegment(input: StreamSegmentInput): Uint8Array {
  assertPositiveInt('sequence', input.sequence);
  if (!Number.isInteger(input.baseDecodeTime) || input.baseDecodeTime < 0) throw new Error('轨道流封装:baseDecodeTime 要是非负整数');
  const samples = input.samples;
  if (!samples.length) throw new Error('轨道流封装:分段里没有样本');
  if (!samples[0].isSync) throw new Error('轨道流封装:分段的第一个样本必须是关键帧');
  for (const s of samples) if (!(s.data instanceof Uint8Array) || !s.data.length) throw new Error('轨道流封装:样本是空的');

  // tfhd:default-base-is-moof(0x020000);tfdt 用版本 1(64 位);
  // trun:数据偏移(0x1)+ 逐样本大小(0x200)+ 逐样本标志(0x400),时长走 trex 的缺省 1
  const tfhd = fullBox('tfhd', 0, 0x020000, u32(1));
  const tfdt = fullBox('tfdt', 1, 0, u64(input.baseDecodeTime));
  const table: Uint8Array[] = [];
  for (const s of samples) table.push(u32(s.data.length), u32(s.isSync ? SAMPLE_FLAGS_SYNC : SAMPLE_FLAGS_NON_SYNC));
  const trunOf = (dataOffset: number) => fullBox('trun', 0, 0x000601, u32(samples.length), u32(dataOffset), ...table);
  const moofOf = (dataOffset: number) => box('moof', fullBox('mfhd', 0, 0, u32(input.sequence)), box('traf', tfhd, tfdt, trunOf(dataOffset)));

  // 数据偏移 = moof 的长度 + mdat 的 8 字节头;moof 的长度不随偏移的取值变,先量一遍
  const moof = moofOf(moofOf(0).length + 8);
  return concat([moof, box('mdat', ...samples.map((s) => s.data))]);
}

/** `avcC` → `avc1.PPCCLL`(和 `streamPlayer.ts` 的 `parseInit`、服务端的 `codecOfAvcC` 同一种拼法) */
export function codecOfAvcC(avcC: Uint8Array): string {
  const hex = (n: number) => n.toString(16).padStart(2, '0');
  return `avc1.${hex(avcC[1])}${hex(avcC[2])}${hex(avcC[3])}`;
}
