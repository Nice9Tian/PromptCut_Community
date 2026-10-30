/**
 * 最小的 MP4 封装器(`docs/plan/c10a-contract.md` 第 11 节〔裁〕、第 11.1 节):一条 H.264 视频轨,有音频时再加一条 AAC 轨。
 * 不引依赖(`mp4-muxer` 停维护;Mediabunny 是 MPL-2.0)。浏览器(WebCodecs 的输出)和 Node(单测)都能跑。
 *
 * # 布局
 *
 *   ftyp | mdat(64 位长度,样本按到达顺序追加)| moov(写在最后)
 *
 * - 样本一到就写进 `mdat`,内存里只留每个样本的大小、偏移、时长这些小表(导出长片时不攒字节)。
 * - `finalize()` 写 `moov`,再回头把 `mdat` 头里的 64 位长度补上 —— 所以落点要能按位置写:
 *   `FileSystemWritableFileStream` 的 `write({ type: 'write', position, data })`,或者内存里的 `MemorySink`。
 * - 每个样本一个 chunk(`stsc` 一条:每 chunk 1 个样本),偏移一律 `co64`;视频的关键帧进 `stss`;
 *   解码顺序与显示顺序不同(有 B 帧)时写 `ctts`(版本 1,有符号偏移),没有就不写。
 *
 * # 时间
 *
 * - 视频轨的 timescale = fps × 1000,每帧 1000;样本的解码时间按到达序号排,显示时间按块的时间戳(微秒)换算。
 * - 音频轨的 timescale = 采样率;每个样本的时长按块的时长换算,没有就按 AAC 的 1024 个采样。
 * - 影片的 timescale 1000(毫秒)。
 */

export interface VideoTrackConfig {
  /** `avc1.640028` 这样的编码串(只用来核对是 H.264) */
  codec: string;
  width: number;
  height: number;
  fps: number;
  /** `VideoEncoder` 输出的 `decoderConfig.description`:avcC 盒的内容(AVCDecoderConfigurationRecord) */
  avcC: Uint8Array;
}

export interface AudioTrackConfig {
  /** `mp4a.40.2` */
  codec: string;
  sampleRate: number;
  channels: number;
  /** `AudioEncoder` 输出的 `decoderConfig.description`:AudioSpecificConfig */
  asc: Uint8Array;
}

/** 落点:按位置写(写 `mdat` 长度时要回头改) */
export interface MuxSink {
  write(data: Uint8Array, position: number): void | Promise<void>;
}

interface TrackState {
  id: number;
  kind: "video" | "audio";
  timescale: number;
  sizes: number[];
  offsets: number[];
  durations: number[];
  /** 显示时间 − 解码时间(timescale 单位) */
  ctsOffsets: number[];
  sync: number[];
  /** 下一个样本的解码时间 */
  nextDts: number;
}

const enc = new TextEncoder();

/** 大端写入的小缓冲 */
class W {
  private parts: number[] = [];
  u8(v: number) { this.parts.push(v & 0xff); return this; }
  u16(v: number) { return this.u8(v >>> 8).u8(v); }
  u24(v: number) { return this.u8(v >>> 16).u8(v >>> 8).u8(v); }
  u32(v: number) { return this.u8(v >>> 24).u8(v >>> 16).u8(v >>> 8).u8(v); }
  i32(v: number) { return this.u32(v >>> 0); }
  u64(v: number) {
    const hi = Math.floor(v / 0x100000000);
    return this.u32(hi).u32(v - hi * 0x100000000);
  }
  str(s: string) { for (const b of enc.encode(s)) this.u8(b); return this; }
  bytes(b: Uint8Array | number[]) { for (const x of b) this.u8(x); return this; }
  zeros(n: number) { for (let i = 0; i < n; i++) this.u8(0); return this; }
  out(): Uint8Array { return Uint8Array.from(this.parts); }
}

function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** 一个盒:4 字节长度 + 4 字节类型 + 内容 */
export function box(type: string, ...content: Uint8Array[]): Uint8Array {
  const body = concat(content);
  const head = new W().u32(8 + body.length).str(type).out();
  return concat([head, body]);
}
/** full box:再加 1 字节版本 + 3 字节标志 */
function fullBox(type: string, version: number, flags: number, ...content: Uint8Array[]): Uint8Array {
  return box(type, new W().u8(version).u24(flags).out(), ...content);
}

const MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];
const matrix = () => { const w = new W(); for (const v of MATRIX) w.u32(v); return w.out(); };

/** MPEG-4 描述符的长度:4 字节变长编码(每字节 7 位,前三字节带续位) */
function descriptor(tag: number, body: Uint8Array): Uint8Array {
  const n = body.length;
  const len = new W().u8(0x80 | ((n >>> 21) & 0x7f)).u8(0x80 | ((n >>> 14) & 0x7f)).u8(0x80 | ((n >>> 7) & 0x7f)).u8(n & 0x7f).out();
  return concat([new W().u8(tag).out(), len, body]);
}

/** 把一串等长的时长压成 stts 的 (count, delta) 条目 */
function runs(values: number[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const v of values) {
    const last = out[out.length - 1];
    if (last && last[1] === v) last[0]++;
    else out.push([1, v]);
  }
  return out;
}

export class Mp4Muxer {
  private sink: MuxSink;
  private video: VideoTrackConfig;
  private audio: AudioTrackConfig | null;
  private position = 0;
  private mdatStart = 0;
  private tracks: TrackState[] = [];
  private finalized = false;
  private chain: Promise<void> = Promise.resolve();

  constructor({ video, audio = null, sink }: { video: VideoTrackConfig; audio?: AudioTrackConfig | null; sink: MuxSink }) {
    if (!/^avc[13]\./.test(video.codec)) throw new Error(`只封装 H.264:${video.codec}`);
    if (audio && !/^mp4a\.40\./.test(audio.codec)) throw new Error(`只封装 AAC:${audio.codec}`);
    if (!(video.width > 0) || !(video.height > 0) || !(video.fps > 0)) throw new Error("视频轨的宽高帧率不对");
    this.sink = sink;
    this.video = video;
    this.audio = audio;
    this.tracks.push({ id: 1, kind: "video", timescale: Math.round(video.fps * 1000), sizes: [], offsets: [], durations: [], ctsOffsets: [], sync: [], nextDts: 0 });
    if (audio) this.tracks.push({ id: 2, kind: "audio", timescale: audio.sampleRate, sizes: [], offsets: [], durations: [], ctsOffsets: [], sync: [], nextDts: 0 });
    const ftyp = box("ftyp", new W().str("isom").u32(0x200).str("isom").str("iso2").str("avc1").str("mp41").out());
    // mdat 头:长度字段写 1,真长度放在后面的 64 位里(finalize 时回头补)
    const mdatHead = new W().u32(1).str("mdat").u64(0).out();
    this.enqueue(ftyp);
    this.mdatStart = this.position;
    this.enqueue(mdatHead);
  }

  private enqueue(data: Uint8Array, position = this.position): void {
    if (position === this.position) this.position += data.length;
    const at = position;
    this.chain = this.chain.then(() => this.sink.write(data, at));
  }

  /** 已经写了多少字节(含还在排队的) */
  get bytesWritten(): number { return this.position; }

  private sample(track: TrackState, data: Uint8Array, duration: number, cts: number, sync: boolean) {
    if (this.finalized) throw new Error("已经 finalize 过了");
    track.offsets.push(this.position);
    track.sizes.push(data.length);
    track.durations.push(duration);
    track.ctsOffsets.push(cts);
    if (sync) track.sync.push(track.sizes.length);
    track.nextDts += duration;
    this.enqueue(data);
  }

  /**
   * 一个视频块(`EncodedVideoChunk` 拷出来的字节,AVCC 格式,长度前缀 4 字节)。
   * `timestampUs` 是显示时间;解码时间按到达顺序每帧一格。
   */
  addVideoChunk(data: Uint8Array, { timestampUs, key }: { timestampUs: number; key: boolean }): void {
    const track = this.tracks[0];
    const frame = track.timescale / this.video.fps;
    const pts = Math.round((timestampUs * track.timescale) / 1e6);
    this.sample(track, data, Math.round(frame), pts - track.nextDts, key);
  }

  /** 一个音频块(裸 AAC 帧,不带 ADTS 头)。时长缺省按 AAC 的 1024 个采样 */
  addAudioChunk(data: Uint8Array, { durationUs }: { timestampUs?: number; durationUs?: number } = {}): void {
    const track = this.tracks[1];
    if (!track) throw new Error("这个封装器没有音频轨");
    const duration = durationUs && durationUs > 0 ? Math.round((durationUs * track.timescale) / 1e6) : 1024;
    this.sample(track, data, duration, 0, true);
  }

  /** 写 moov、补 mdat 长度;回整个文件的字节数 */
  async finalize(): Promise<number> {
    if (this.finalized) return this.position;
    this.finalized = true;
    const mdatEnd = this.position;
    const moov = this.moov();
    this.enqueue(moov);
    const size = new W().u64(mdatEnd - this.mdatStart).out();
    this.enqueue(size, this.mdatStart + 8);
    await this.chain;
    return this.position;
  }

  private trackDuration(t: TrackState): number {
    return t.durations.reduce((a, b) => a + b, 0);
  }

  private moov(): Uint8Array {
    const movieTimescale = 1000;
    const movieDur = Math.max(...this.tracks.map((t) => Math.round((this.trackDuration(t) * movieTimescale) / t.timescale)));
    const mvhd = fullBox("mvhd", 0, 0, new W().u32(0).u32(0).u32(movieTimescale).u32(movieDur).u32(0x00010000).u16(0x0100).zeros(10).out(),
      matrix(), new W().zeros(24).u32(this.tracks.length + 1).out());
    return box("moov", mvhd, ...this.tracks.map((t) => this.trak(t, movieTimescale)));
  }

  private trak(t: TrackState, movieTimescale: number): Uint8Array {
    const dur = this.trackDuration(t);
    const video = t.kind === "video";
    const tkhd = fullBox("tkhd", 0, 3, new W().u32(0).u32(0).u32(t.id).u32(0).u32(Math.round((dur * movieTimescale) / t.timescale)).zeros(8)
      .u16(0).u16(0).u16(video ? 0 : 0x0100).u16(0).out(), matrix(),
      new W().u32(video ? this.video.width * 0x10000 : 0).u32(video ? this.video.height * 0x10000 : 0).out());
    const mdhd = fullBox("mdhd", 0, 0, new W().u32(0).u32(0).u32(t.timescale).u32(dur).u16(0x55c4).u16(0).out());
    const hdlr = fullBox("hdlr", 0, 0, new W().u32(0).str(video ? "vide" : "soun").zeros(12).str(video ? "VideoHandler" : "SoundHandler").u8(0).out());
    const xmhd = video ? fullBox("vmhd", 0, 1, new W().u16(0).zeros(6).out()) : fullBox("smhd", 0, 0, new W().u16(0).u16(0).out());
    const dinf = box("dinf", fullBox("dref", 0, 0, new W().u32(1).out(), fullBox("url ", 0, 1)));
    const stbl = box("stbl", this.stsd(t), this.stts(t), ...this.ctts(t), ...(video ? [this.stss(t)] : []), this.stsc(), this.stsz(t), this.co64(t));
    const minf = box("minf", xmhd, dinf, stbl);
    return box("trak", tkhd, box("mdia", mdhd, hdlr, minf));
  }

  private stsd(t: TrackState): Uint8Array {
    if (t.kind === "video") {
      const v = this.video;
      const name = new Uint8Array(32);
      const avc1 = box("avc1", new W().zeros(6).u16(1).zeros(16).u16(v.width).u16(v.height).u32(0x00480000).u32(0x00480000).u32(0).u16(1).out(),
        name, new W().u16(0x0018).u16(0xffff).out(), box("avcC", this.video.avcC));
      return fullBox("stsd", 0, 0, new W().u32(1).out(), avc1);
    }
    const a = this.audio!;
    const dcd = descriptor(0x04, concat([new W().u8(0x40).u8(0x15).u24(0).u32(0).u32(0).out(), descriptor(0x05, a.asc)]));
    const es = descriptor(0x03, concat([new W().u16(t.id).u8(0).out(), dcd, descriptor(0x06, Uint8Array.of(0x02))]));
    const esds = fullBox("esds", 0, 0, es);
    const mp4a = box("mp4a", new W().zeros(6).u16(1).zeros(8).u16(a.channels).u16(16).u16(0).u16(0).u32(Math.min(0xffff, a.sampleRate) * 0x10000).out(), esds);
    return fullBox("stsd", 0, 0, new W().u32(1).out(), mp4a);
  }

  private stts(t: TrackState): Uint8Array {
    const entries = runs(t.durations);
    const w = new W().u32(entries.length);
    for (const [count, delta] of entries) w.u32(count).u32(delta);
    return fullBox("stts", 0, 0, w.out());
  }

  private ctts(t: TrackState): Uint8Array[] {
    if (t.ctsOffsets.every((v) => v === 0)) return [];
    const entries = runs(t.ctsOffsets);
    const w = new W().u32(entries.length);
    for (const [count, offset] of entries) w.u32(count).i32(offset);
    return [fullBox("ctts", 1, 0, w.out())];
  }

  private stss(t: TrackState): Uint8Array {
    const w = new W().u32(t.sync.length);
    for (const n of t.sync) w.u32(n);
    return fullBox("stss", 0, 0, w.out());
  }

  private stsc(): Uint8Array {
    return fullBox("stsc", 0, 0, new W().u32(1).u32(1).u32(1).u32(1).out());
  }

  private stsz(t: TrackState): Uint8Array {
    const w = new W().u32(0).u32(t.sizes.length);
    for (const s of t.sizes) w.u32(s);
    return fullBox("stsz", 0, 0, w.out());
  }

  private co64(t: TrackState): Uint8Array {
    const w = new W().u32(t.offsets.length);
    for (const o of t.offsets) w.u64(o);
    return fullBox("co64", 0, 0, w.out());
  }
}

/** 内存里的落点:按位置写,最后拼成一整块(iOS 没有「另存为」时攒成 Blob 下载;单测也用它) */
export class MemorySink implements MuxSink {
  private parts: { at: number; data: Uint8Array }[] = [];
  private end = 0;
  write(data: Uint8Array, position: number): void {
    const copy = data.slice();
    if (position >= this.end) {
      this.parts.push({ at: position, data: copy });
      this.end = position + copy.length;
      return;
    }
    // 回头改(mdat 长度):落在哪几段里就改哪几段
    for (const p of this.parts) {
      const lo = Math.max(position, p.at), hi = Math.min(position + copy.length, p.at + p.data.length);
      if (lo < hi) p.data.set(copy.subarray(lo - position, hi - position), lo - p.at);
    }
  }
  get size(): number { return this.end; }
  bytes(): Uint8Array {
    const out = new Uint8Array(this.end);
    for (const p of this.parts) out.set(p.data, p.at);
    return out;
  }
  /** 浏览器里:拼成 Blob(不先合成一整块 Uint8Array,省一份拷贝) */
  blob(type = "video/mp4"): Blob {
    return new Blob(this.parts.map((p) => p.data as BlobPart), { type });
  }
}
