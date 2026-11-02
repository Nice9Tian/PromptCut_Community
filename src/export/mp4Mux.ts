import { tr } from "../i18n/index.ts";
/**
 * Minimal MP4 muxer (`docs/plan/c10a-contract.md` Section 11 [ruling], Section 11.1): one H.264 video
 * track, plus an AAC track when audio is present.
 * Introduces no dependencies (`mp4-muxer` is unmaintained; Mediabunny is MPL-2.0). Runs in both
 * browser (WebCodecs output) and Node (unit tests).
 *
 * # Layout
 *
 *   ftyp | mdat (64-bit length, samples appended in arrival order) | moov (written at the end)
 *
 * - Samples are written to `mdat` upon arrival; memory keeps only small tables for each sample's
 *   size, offset, and duration (avoids accumulating bytes when exporting long videos).
 * - `finalize()` writes `moov`, then seeks back to patch the 64-bit length in the `mdat` header:
 *   so the drop target must support positional writes:
 *   `FileSystemWritableFileStream`'s `write({ type: 'write', position, data })`, or in-memory
 *   `MemorySink`.
 * - One chunk per sample (single entry in `stsc`: 1 sample per chunk), offsets are always `co64`;
 *   video keyframes go into `stss`; writes `ctts` (version 1, signed offset) when decode order
 *   differs from presentation order (with B-frames), omitted otherwise.
 *
 * # Timing
 *
 * - Video track timescale = fps × 1000, 1000 per frame; sample decode times follow arrival order,
 *   presentation times are converted from chunk timestamps (microseconds).
 * - Audio track timescale = sample rate; each sample duration is converted from chunk duration,
 *   defaulting to 1024 samples for AAC when missing.
 * - Movie timescale is 1000 (milliseconds).
 */

export interface VideoTrackConfig {
  /** Codec string like `avc1.640028` (only used to verify it is H.264) */
  codec: string;
  width: number;
  height: number;
  fps: number;
  /** `decoderConfig.description` output by `VideoEncoder`: avcC box contents (AVCDecoderConfigurationRecord) */
  avcC: Uint8Array;
}

export interface AudioTrackConfig {
  /** `mp4a.40.2` */
  codec: string;
  sampleRate: number;
  channels: number;
  /** `decoderConfig.description` output by `AudioEncoder`: AudioSpecificConfig */
  asc: Uint8Array;
}

/** Drop target: positional writes (must seek back and update when writing `mdat` length) */
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
  /** Presentation time - decode time (timescale units) */
  ctsOffsets: number[];
  sync: number[];
  /** Decode time of the next sample */
  nextDts: number;
}

const enc = new TextEncoder();

/** Small buffer for big-endian writes */
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

/** A box: 4-byte length + 4-byte type + content */
export function box(type: string, ...content: Uint8Array[]): Uint8Array {
  const body = concat(content);
  const head = new W().u32(8 + body.length).str(type).out();
  return concat([head, body]);
}
/** full box: plus 1-byte version + 3-byte flags */
function fullBox(type: string, version: number, flags: number, ...content: Uint8Array[]): Uint8Array {
  return box(type, new W().u8(version).u24(flags).out(), ...content);
}

const MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];
const matrix = () => { const w = new W(); for (const v of MATRIX) w.u32(v); return w.out(); };

/** MPEG-4 descriptor length: 4-byte variable-length encoding (7 bits per byte, continuation bit on first three bytes) */
function descriptor(tag: number, body: Uint8Array): Uint8Array {
  const n = body.length;
  const len = new W().u8(0x80 | ((n >>> 21) & 0x7f)).u8(0x80 | ((n >>> 14) & 0x7f)).u8(0x80 | ((n >>> 7) & 0x7f)).u8(n & 0x7f).out();
  return concat([new W().u8(tag).out(), len, body]);
}

/** Compresses a run of equal durations into stts (count, delta) entries */
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
    if (!/^avc[13]\./.test(video.codec)) throw new Error(tr("Only H.264 can be muxed: {0}", video.codec));
    if (audio && !/^mp4a\.40\./.test(audio.codec)) throw new Error(tr("Only AAC can be muxed: {0}", audio.codec));
    if (!(video.width > 0) || !(video.height > 0) || !(video.fps > 0)) throw new Error(tr("The video track has an invalid width, height or frame rate"));
    this.sink = sink;
    this.video = video;
    this.audio = audio;
    this.tracks.push({ id: 1, kind: "video", timescale: Math.round(video.fps * 1000), sizes: [], offsets: [], durations: [], ctsOffsets: [], sync: [], nextDts: 0 });
    if (audio) this.tracks.push({ id: 2, kind: "audio", timescale: audio.sampleRate, sizes: [], offsets: [], durations: [], ctsOffsets: [], sync: [], nextDts: 0 });
    const ftyp = box("ftyp", new W().str("isom").u32(0x200).str("isom").str("iso2").str("avc1").str("mp41").out());
    // mdat header: write 1 in length field, true length is placed in subsequent 64 bits (patched later during finalize)
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

  /** Total bytes written so far (including those still queued) */
  get bytesWritten(): number { return this.position; }

  private sample(track: TrackState, data: Uint8Array, duration: number, cts: number, sync: boolean) {
    if (this.finalized) throw new Error(tr("Already finalized"));
    track.offsets.push(this.position);
    track.sizes.push(data.length);
    track.durations.push(duration);
    track.ctsOffsets.push(cts);
    if (sync) track.sync.push(track.sizes.length);
    track.nextDts += duration;
    this.enqueue(data);
  }

  /**
   * A video chunk (bytes copied from `EncodedVideoChunk`, AVCC format with 4-byte length prefix).
   * `timestampUs` is presentation time; decode time advances one frame per arrival order.
   */
  addVideoChunk(data: Uint8Array, { timestampUs, key }: { timestampUs: number; key: boolean }): void {
    const track = this.tracks[0];
    const frame = track.timescale / this.video.fps;
    const pts = Math.round((timestampUs * track.timescale) / 1e6);
    this.sample(track, data, Math.round(frame), pts - track.nextDts, key);
  }

  /** An audio chunk (raw AAC frame, without ADTS header). Duration defaults to 1024 samples for AAC */
  addAudioChunk(data: Uint8Array, { durationUs }: { timestampUs?: number; durationUs?: number } = {}): void {
    const track = this.tracks[1];
    if (!track) throw new Error(tr("This muxer has no audio track"));
    const duration = durationUs && durationUs > 0 ? Math.round((durationUs * track.timescale) / 1e6) : 1024;
    this.sample(track, data, duration, 0, true);
  }

  /** Writes moov, patches mdat length; returns total byte count of the entire file */
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

/** In-memory drop target: positional writes, assembled into a single chunk at the end (accumulated as a Blob download on iOS without "Save as"; also used by unit tests) */
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
    // Seek back and update (mdat length): update whichever segments it falls into
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
  /** In the browser: assemble into a Blob (avoids combining into a single Uint8Array first, saving a copy) */
  blob(type = "video/mp4"): Blob {
    return new Blob(this.parts.map((p) => p.data as BlobPart), { type });
  }
}
