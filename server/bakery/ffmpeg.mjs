/**
 * The ffmpeg layer: where to find it, how to feed Chrome's PNG stream directly into it, and how to
 * read its progress.
 *
 * Split out from scripts/export-frames.mjs (pure refactoring, ported verbatim).
 */

import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { spawn } from 'child_process';

/**
 * Local ffmpeg: use it if on PATH; if not, fall back to the one installed via winget
 */
export async function findFfmpeg() {
  const localAppData = process.env.LOCALAPPDATA || '';
  const ffmpegFallback = path.join(localAppData, 'Microsoft', 'WinGet', 'Packages', 'Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe', 'ffmpeg-9.0.1-full_build', 'bin', 'ffmpeg.exe');
  try {
    await new Promise((resolve, reject) => {
      const proc = spawn('ffmpeg', ['-version'], { windowsHide: true });
      proc.on('close', code => code === 0 ? resolve() : reject());
      proc.on('error', reject);
    });
    return 'ffmpeg';
  } catch {
    return ffmpegFallback;
  }
}

const ffprobeOf = (ffmpegCmd) => ffmpegCmd.replace(/ffmpeg(.exe)?$/i, (m) => m.toLowerCase().startsWith('ffmpeg.exe') ? 'ffprobe.exe' : 'ffprobe');

/** Encode incoming screenshots immediately so Node retains at most one PNG.
 * The movie must hold exactly the frames written: a shorter file shifts every
 * later shard in the concatenated export, so a mismatch is an error.
 */
export function streamPngVideo(ffmpeg, file, fps) {
  const proc = spawn(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-progress', 'pipe:2', '-f', 'image2pipe', '-vcodec', 'png',
    '-framerate', String(fps), '-i', 'pipe:0', '-an', '-c:v', 'prores_ks', '-profile:v', '4444',
    '-pix_fmt', 'yuva444p10le', file], { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
  let stderr = '', partial = '', inputError = null, written = 0;
  const progress = {};
  proc.stderr.on('data', d => {
    const lines = (partial + d).split(/\r?\n/);
    partial = lines.pop();
    for (const line of lines) {
      const m = /^(frame|drop_frames|dup_frames|progress)=(\S*)$/.exec(line);
      if (m) progress[m[1]] = m[2];
      else if (!/^[a-z_0-9]+=/.test(line)) stderr = (stderr + line + '\n').slice(-8000);
    }
  });
  proc.stdin.on('error', e => { inputError = e; });
  const done = new Promise((resolve, reject) => {
    proc.on('error', reject);
    proc.on('close', code => {
      if (partial && !/^[a-z_0-9]+=/.test(partial)) stderr = (stderr + partial).slice(-8000);
      code === 0 ? resolve() : reject(inputError || new Error(`ffmpeg ${code}: ${stderr}`));
    });
  });
  done.catch(() => {});
  return {
    async write(buffer) {
      if (inputError) throw inputError;
      await new Promise((resolve, reject) => proc.stdin.write(buffer, e => e ? reject(e) : resolve()));
      written++;
    },
    async finish() {
      proc.stdin.end();
      await done;
      const encoded = Number(progress.frame);
      if (process.env.PC_STREAM_DEBUG) console.log(`[stream-png] ${file}: written=${written} encoded=${progress.frame} drop=${progress.drop_frames} dup=${progress.dup_frames}`);
      if (encoded !== written) {
        throw new Error(`${file}: wrote ${written} frames but ffmpeg encoded ${progress.frame ?? 'unknown'} (drop=${progress.drop_frames}, dup=${progress.dup_frames}) ${stderr}`);
      }
    },
    async abort() { proc.stdin.destroy(); proc.kill(); await done.catch(() => {}); },
  };
}

/**
 * Run an ffmpeg pass, reading output frame counts via -progress to callback to onFrame.
 * Watchdog: if frame count remains unchanged within stallMs, kill and report error. When ffmpeg
 * truly hangs, CPU drops to zero without error or exit (measured: card PNG changing format
 * midstream triggers filtergraph rebuilding, see the -reinit_filter section in buildComposeArgs);
 * without this gate, exports would stall forever at a certain progress on the UI.
 */
function runFfmpegProgress(ffmpegCmd, args, onFrame, stallMs = Number(process.env.PC_COMPOSE_STALL_MS) || 45000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegCmd, ['-progress', 'pipe:1', '-nostats', '-loglevel', 'warning', ...args], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
    let buf = '';
    let last = -1;
    let lastChange = Date.now();
    let stalled = false;
    const dog = setInterval(() => {
      if (Date.now() - lastChange > stallMs) {
        stalled = true;
        proc.kill();
      }
    }, 2000);
    proc.stdout.on('data', (d) => {
      buf += d;
      let k;
      while ((k = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, k).trim();
        buf = buf.slice(k + 1);
        const m = /^frame=(\d+)$/.exec(line);
        if (!m) continue;
        const n = Number(m[1]);
        if (n !== last) {
          last = n;
          lastChange = Date.now();
          onFrame(n);
        }
      }
    });
    proc.on('close', (code) => {
      clearInterval(dog);
      if (stalled) reject(Object.assign(new Error(`ffmpeg compositing made no progress for ${stallMs / 1000} seconds (stuck at frame ${Math.max(0, last)}), aborted`), { stalled: true }));
      else if (code === 0) resolve();
      else reject(new Error(`ffmpeg (media compositing) exited with code ${code}`));
    });
    proc.on('error', (e) => {
      clearInterval(dog);
      reject(e);
    });
  });
}

export { ffprobeOf, runFfmpegProgress };

/* ======================================================================== *
 * Segment encoder for track streams (R8 / G3)
 *
 * One segment = one ffmpeg invocation: PNGs are fed from stdin via image2pipe, and fMP4 bytes are
 * received back from stdout.
 * Splitting init / segments and dropping mfra happens on the Node side (`server/frame-stream.mjs`);
 * this only handles "encoding".
 * ======================================================================== */

/** Exactly this many samples per segment (G2; except the last segment) */
export const STREAM_SEGMENT_FRAMES = 15;

/**
 * One line of parameters per encoder (table in G3): **do not concatenate from common chunks**:
 * options like `-sc_threshold` are not recognized by all encoders.
 * `pixFmt`: pixel format at the tail of the filter chain. The hardware path of `h264_mf` only
 * accepts `nv12` (G0-b (7): specifying `yuv420p` directly causes `format negotiation failed`).
 *
 * The three rows nvenc / qsv / amf were not run successfully on this machine (G0-b (7): driver /
 * hardware absent); they are preserved as-is from the task brief, not empirical conclusions; the
 * choice between `-tune ll` and `-rc vbr -cq` for nvenc was not tested either, retaining the
 * `-rc vbr -cq` set written in the task brief here.
 */
export const STREAM_ENCODERS = {
  libx264: { pixFmt: 'yuv420p', args: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-g', '15', '-keyint_min', '15', '-sc_threshold', '0', '-bf', '0'] },
  h264_nvenc: { pixFmt: 'yuv420p', args: ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '16', '-b:v', '0', '-g', '15', '-bf', '0', '-no-scenecut', '1', '-forced-idr', '1', '-strict_gop', '1'] },
  h264_qsv: { pixFmt: 'yuv420p', args: ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-global_quality', '16', '-g', '15', '-bf', '0'] },
  h264_amf: { pixFmt: 'yuv420p', args: ['-c:v', 'h264_amf', '-quality', 'speed', '-rc', 'cqp', '-qp_i', '16', '-qp_p', '16'] },
  h264_mf: { pixFmt: 'nv12', args: ['-c:v', 'h264_mf', '-hw_encoding', '1', '-rate_control', 'quality', '-quality', '90', '-g', '15', '-bf', '0'] },
};

/**
 * Probe order (G0-b conclusion 4): hardware first; `libx264` precedes `h264_mf` (the latter is
 * twice as slow and only outputs Baseline)
 */
export const STREAM_ENCODER_ORDER = ['h264_nvenc', 'h264_qsv', 'h264_amf', 'libx264', 'h264_mf'];

/**
 * The default encoder is `libx264` (G0-b conclusion 4: the only one on this machine passing all
 * tests, best across duration, size, and profile).
 * Hardware encoders are **tested first only when explicitly named**
 * (`PROMPTCUT_STREAM_ENCODER=auto` probes in the order above, or specify the encoder name
 * directly): all four hardware encoders on this machine are "listed but unusable", and parameters
 * for the nvenc line have not been empirically tested.
 */
export function streamEncoderPreference(env = process.env) {
  const want = String(env.PROMPTCUT_STREAM_ENCODER || '').trim();
  if (!want) return ['libx264', 'h264_mf'];
  if (want === 'auto') return [...STREAM_ENCODER_ORDER];
  return [want, ...STREAM_ENCODER_ORDER.filter(name => name !== want)].filter(name => STREAM_ENCODERS[name]);
}

/**
 * Filter chain for G3. **Color half stores premultiplied color** (`premultiply=inplace=1`,
 * transparent RGB is constantly pure black); **`out_range=tv`** (G0-b conclusion 2: `pc` is
 * treated as limited range by Chrome and expanded once more, average alpha error 8.4/255). Width
 * and height are already even numbers padded outward in G1; the filter chain no longer rounds them.
 *
 * Byte-for-byte equivalent to the legacy `streamFilterIdentity` (every frame's YUV fed into the
 * encoder is identical, see `server/test/stream-encode-fast.test.mjs`), but does fewer full-frame
 * passes:
 *   - No longer converts back to `rgba` after premultiplication before branching
 *     (`docs/reports/AGENT-perf-encode.md`);
 *   - **Alpha half branches off before premultiplication**: premultiplication only modifies the
 *     color plane and leaves the alpha plane untouched, so extracted alpha is identical; from
 *     ffmpeg 8 onward, frames carry an alpha mode where premultiplied frames are marked as
 *     "premultiplied", while `alphaextract` only accepts "unpremultiplied" frames; branching after
 *     premultiplication causes the filtergraph to automatically insert a `premultiply_dynamic` to
 *     unpremultiply the entire frame back (a wasted pass whose result is discarded);
 *   - Both halves are combined using planar `gbrp` (`gbrap → gbrp` and `gray → gbrp` just move
 *     planes); the final `gbrp → yuv` pass is cheaper than `rgb24 → yuv`;
 * Under single thread, this chain saves ~one quarter compared to the previous version
 * (`docs/reports/AGENT-perf-encode-2.md`).
 */
export function streamFilter(pixFmt = 'yuv420p') {
  return '[0:v]format=gbrap,split=2[p][a];'
    + '[p]premultiply=inplace=1,format=gbrp,pad=iw:ih+8:0:0:black[rgb];'
    + '[a]alphaextract,format=gbrp,pad=iw:ih+8:0:0:black[mask];'
    + `[rgb][mask]vstack=inputs=2,scale=out_range=tv:out_color_matrix=bt709,format=${pixFmt}`;
}

/**
 * Filter chain **identity**: the encoding parameter hash in the segment signature is computed
 * against it (`encoderParamsHash`), not the literal text of `streamFilter`.
 * This is the chain before rewriting; the current chain produces byte-for-byte identical output to
 * it, so existing segments on disk remain valid as-is and do not need to be re-produced.
 * **When modifying the filter chain such that output changes, this must be modified at the same
 * time** (otherwise old and new segments will be treated as products of the same parameter set).
 */
export function streamFilterIdentity(pixFmt = 'yuv420p') {
  return '[0:v]format=gbrap,premultiply=inplace=1,format=rgba,split=2[c][a];'
    + '[c]format=rgb24,pad=iw:ih+8:0:0:black[rgb];'
    + '[a]alphaextract,format=gray,format=rgb24,pad=iw:ih+8:0:0:black[mask];'
    + `[rgb][mask]vstack=inputs=2,scale=out_range=tv:out_color_matrix=bt709,format=${pixFmt}`;
}

/**
 * Three options on the input side, **only changing when work begins without changing output**
 * (byte-for-byte identical for identical inputs, see `stream-encode-fast.test.mjs`):
 *   - `-probesize 32 -analyzeduration 0`: by default, ffmpeg requires reading 5 MB (or 5 seconds)
 *     before opening input and starting work; a single PNG is 200-300 KB, not enough to fill an
 *     entire 15-frame segment, so **it does nothing until stdin closes**. Framerate is provided by
 *     `-framerate`, and width, height, and pixel format are decoded from the first PNG, with no
 *     need for extra reading;
 *   - `-threads 1` (PNG decoding): frame-level multithreaded decoding must accumulate "thread count
 *     − 1" packets before emitting the first frame (exactly a full segment on a 16-thread machine).
 *     Single-threaded decoding of a 1080p screenshot takes only 1-2 ms, far faster than downstream
 *     filtering and encoding, and is not a bottleneck.
 * Combined, frames enter the filter and encoder as soon as they arrive; after feeding the last
 * image, only the last few frames and finalization remain (when fed at the frame emission pace,
 * 1080p from feeding finished to all bytes emitted dropped from ~270 ms to ~70 ms).
 */
const STREAM_INPUT_ARGS = ['-probesize', '32', '-analyzeduration', '0', '-threads', '1'];

/**
 * Filtergraph slice thread count: default (0) is logical core count, capped at 8 here. The filter
 * and x264 (where auto thread count is cores × 1.5) compete for the same cores; on a 16-thread
 * laptop, 16 slices is actually ~15 ms / segment slower than 8 slices
 * (`docs/reports/AGENT-perf-encode-2.md`); unchanged below 8 cores.
 * The number of slices **does not change output**: swscale / premultiply / vstack slice by row,
 * with 1~16 slices producing byte-for-byte identical output (unit tests compare 1 slice vs 3
 * slices).
 */
export function streamFilterThreads(cpus = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length, env = process.env) {
  // PROMPTCUT_STREAM_FILTER_THREADS: manually specify (0 = leave to ffmpeg, i.e., logical cores),
  // for tuning parameters on other machines
  const forced = String(env.PROMPTCUT_STREAM_FILTER_THREADS ?? '').trim();
  if (/^\d+$/.test(forced)) return Number(forced);
  return Math.max(1, Math.min(8, Math.floor(Number(cpus)) || 1));
}

/**
 * Complete command line for a segment (outputs fMP4 to stdout).
 *
 * `raw: { width, height }` (captured directly from canvas, `./capture-canvas.mjs`): input is not
 * PNG, but frame-by-frame straight RGBA raw pixels (`rawvideo`, `rgba`, `width × height × 4` bytes
 * per frame). Only this input section is replaced, with downstream filter chains and encoding
 * parameters verbatim: decoded PNG yields the same `rgba` frames, and encoding the same pixels
 * from either input produces byte-for-byte identical output
 * (`server/test/stream-encode-raw.test.mjs`).
 */
export function streamSegmentArgs({ encoder = 'libx264', fps, raw = null }) {
  const spec = STREAM_ENCODERS[encoder];
  if (!spec) throw new Error(`Unknown track stream encoder ${encoder}`);
  if (!(Number(fps) > 0)) throw new Error('Track stream encoding requires a frame rate');
  if (raw && !(Number.isInteger(raw.width) && Number.isInteger(raw.height) && raw.width > 0 && raw.height > 0)) throw new Error('Raw pixel input requires an integer width and height');
  const input = raw ? ['-f', 'rawvideo', '-pix_fmt', 'rgba', '-video_size', `${raw.width}x${raw.height}`] : ['-f', 'image2pipe', '-c:v', 'png'];
  return ['-y', '-hide_banner', '-loglevel', 'error', '-filter_complex_threads', String(streamFilterThreads()),
    '-reinit_filter', '0', ...STREAM_INPUT_ARGS, ...input, '-framerate', String(fps), '-i', 'pipe:0',
    '-filter_complex', streamFilter(spec.pixFmt),
    ...spec.args,
    '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
    '-video_track_timescale', String(fps),
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-an',
    '-f', 'mp4', 'pipe:1'];
}

/* ------------------------------------------------------------ Pre-spawned encoding processes */

/**
 * Keep one **pre-spawned, idling for input** ffmpeg for each command line
 * (`openStreamSegmentEncoder` claims it and spawns another replacement). The same command line and
 * executable produce byte-for-byte identical output to freshly spawned ones; what is saved is
 * process loading and initialization overhead (time breakdown in
 * `docs/reports/AGENT-perf-encode.md`). Idling processes do not keep Node from exiting (`unref`)
 * and are reaped after idling beyond `SPARE_IDLE_MS`; when Node exits, their stdin disconnects,
 * they read EOF and exit on their own, and are killed again on `exit`. Disabled via
 * `PROMPTCUT_STREAM_PREWARM=0`.
 */
const SPARE_IDLE_MS = 60_000;
const spareSegmentProcs = new Map();
let spareExitHook = false;

export function streamPrewarmEnabled(env = process.env) {
  return String(env.PROMPTCUT_STREAM_PREWARM ?? '').trim() !== '0';
}

function spareKey(ffmpeg, args) { return `${ffmpeg}\u0000${args.join('\u0000')}`; }

function spawnSegmentProc(ffmpeg, args) {
  return spawn(ffmpeg, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
}

function setRef(proc, on) {
  for (const handle of [proc, proc.stdin, proc.stdout, proc.stderr]) {
    try { if (on) handle?.ref?.(); else handle?.unref?.(); } catch { /* Handle already closed */ }
  }
}

function parkSpare(ffmpeg, args) {
  const key = spareKey(ffmpeg, args);
  if (spareSegmentProcs.has(key)) return;
  let proc;
  try { proc = spawnSegmentProc(ffmpeg, args); } catch { return; }
  const entry = { proc, dead: false, timer: null, onGone: null };
  // Errors or exits while idling simply remove it from the pool; once claimed, the taker takes over
  // (`takeSpare` removes this listener)
  entry.onGone = () => {
    entry.dead = true;
    clearTimeout(entry.timer);
    if (spareSegmentProcs.get(key) === entry) spareSegmentProcs.delete(key);
  };
  proc.on('error', entry.onGone);
  proc.on('exit', entry.onGone);
  proc.stdin.on('error', entry.onGone);
  entry.timer = setTimeout(() => { entry.onGone(); try { proc.stdin.destroy(); } catch {} proc.kill(); }, SPARE_IDLE_MS);
  entry.timer.unref?.();
  setRef(proc, false);
  spareSegmentProcs.set(key, entry);
  if (!spareExitHook) {
    spareExitHook = true;
    process.once('exit', () => { for (const e of spareSegmentProcs.values()) { try { e.proc.kill(); } catch {} } });
  }
}

function takeSpare(ffmpeg, args) {
  const key = spareKey(ffmpeg, args);
  const entry = spareSegmentProcs.get(key);
  if (!entry) return null;
  spareSegmentProcs.delete(key);
  clearTimeout(entry.timer);
  const { proc } = entry;
  proc.off('error', entry.onGone);
  proc.off('exit', entry.onGone);
  proc.stdin.off('error', entry.onGone);
  // While idling, ffmpeg produces no output and does not exit; if it has already exited
  // (or was killed), discard it
  if (entry.dead || proc.exitCode !== null || proc.signalCode !== null || proc.killed || !proc.pid) {
    try { proc.kill(); } catch {}
    return null;
  }
  setRef(proc, true);
  return proc;
}

/**
 * Command lines for raw pixel input carry width and height, where each rectangle is its own
 * command line: there are more idling processes than for PNG (divided only by encoder and
 * framerate). Keep the latest `SPARE_MAX` instances, reaping earlier ones (`Map` orders by
 * insertion order).
 */
const SPARE_MAX = 3;
function trimSpares() {
  while (spareSegmentProcs.size > SPARE_MAX) {
    const [key, entry] = spareSegmentProcs.entries().next().value;
    spareSegmentProcs.delete(key);
    clearTimeout(entry.timer);
    entry.dead = true;
    try { entry.proc.stdin.destroy(); } catch {}
    try { entry.proc.kill(); } catch {}
  }
}

/** Reap all idling encoding processes (for testing and shutdown) */
export function dropStreamEncoderSpares() {
  for (const [key, entry] of spareSegmentProcs) {
    spareSegmentProcs.delete(key);
    clearTimeout(entry.timer);
    entry.dead = true;
    try { entry.proc.stdin.destroy(); } catch {}
    try { entry.proc.kill(); } catch {}
  }
}

/** Number of idling processes in the pool (for testing) */
export function streamEncoderSpareCount() { return spareSegmentProcs.size; }

/**
 * Whether `buf` ends exactly with a complete top-level `mfra` box (written last in the trailer of
 * fragmented mov muxing). Seeing it indicates that ffmpeg has finished writing the entire segment,
 * so there is no need to wait for process exit (releasing encoder memory before exit takes tens of
 * milliseconds).
 */
export function endsWithCompleteMfra(buf) {
  let off = 0, last = null;
  while (off + 8 <= buf.length) {
    let size = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    if (size === 1) {
      if (off + 16 > buf.length) return false;
      size = Number(buf.readBigUInt64BE(off + 8));
    } else if (size === 0) return false;
    if (size < 8 || off + size > buf.length) return false;
    last = type;
    off += size;
  }
  return off === buf.length && last === 'mfra';
}

/**
 * Open a segment encoder. `write(png)` feeds in arrival order (backpressure: wait for stdin to
 * accept), `finish()` returns the full fMP4 bytes output by ffmpeg (`ftyp moov moof mdat mfra`),
 * and `abort()` discards. However many frames are fed in, ffmpeg should encode that many:
 * discrepancies are judged on the splitter side by sample count (G2 "retick if short a frame").
 *
 * `prewarm` (defaults to `streamPrewarmEnabled`): preferentially claims a pre-spawned process and
 * spawns the next replacement.
 * `raw: { width, height }`: feeds raw RGBA frames; `write` provides exactly one frame each time
 * (see `streamSegmentArgs`).
 * `finish()` delivers bytes as soon as output ends with a complete `mfra`, without waiting for
 * process exit; if it did not end with `mfra` and process exit code is non-zero, errors as usual.
 */
export function openStreamSegmentEncoder(ffmpeg, { encoder = 'libx264', fps, prewarm = streamPrewarmEnabled(), raw = null }) {
  const args = streamSegmentArgs({ encoder, fps, raw });
  const proc = (prewarm && takeSpare(ffmpeg, args)) || spawnSegmentProc(ffmpeg, args);
  if (prewarm) setImmediate(() => { parkSpare(ffmpeg, args); if (raw) trimSpares(); });
  const chunks = [];
  let stderr = '', inputError = null, written = 0, received = 0, onTrailer = null;
  const startedAt = Date.now();
  const checkTrailer = () => {
    if (!onTrailer) return;
    const buf = Buffer.concat(chunks, received);
    if (endsWithCompleteMfra(buf)) onTrailer(buf);
  };
  proc.stdout.on('data', d => { chunks.push(d); received += d.length; checkTrailer(); });
  proc.stderr.on('data', d => { stderr = (stderr + d).slice(-4000); });
  proc.stdin.on('error', e => { inputError = e; });
  const done = new Promise((resolve, reject) => {
    proc.on('error', reject);
    proc.on('close', code => code === 0 ? resolve(Buffer.concat(chunks))
      : reject(inputError || new Error(`ffmpeg (${encoder}) exit code ${code}: ${stderr.trim()}`)));
  });
  done.catch(() => {});
  return {
    encoder,
    get written() { return written; },
    /**
     * Number of bytes already received from stdout (starts growing while feeding frames: the encoder
     * starts working when the first frame arrives, see `STREAM_INPUT_ARGS`).
     */
    get received() { return received; },
    async write(buffer) {
      if (inputError) throw inputError;
      await new Promise((resolve, reject) => proc.stdin.write(buffer, e => e ? reject(e) : resolve()));
      written++;
    },
    async finish() {
      const endedAt = Date.now();
      const trailer = new Promise(resolve => { onTrailer = resolve; });
      proc.stdin.end();
      checkTrailer();
      const bytes = await Promise.race([done, trailer]);
      // encodeMs: from opening encoder to finishing byte output (overlaps with frame output); tailMs:
      // how long to wait after feeding the last frame
      return { bytes, encodeMs: Date.now() - startedAt, tailMs: Date.now() - endedAt, written };
    },
    async abort() { try { proc.stdin.destroy(); } catch {} proc.kill(); await done.catch(() => {}); },
  };
}

/**
 * A short segment for probing: two 320×240 translucent PNGs (inlined, does not depend on any asset
 * files; `h264_mf` directly refuses to encode frames that are too small).
 */
function probePngs() {
  // RGBA, left half opaque red, right half fully transparent; identical content across both
  // frames is fine: only checking whether encoding succeeds
  const width = 320, height = 240;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    for (let x = 0; x < width; x++) {
      const i = row + 1 + x * 4;
      if (x < width / 2) { raw[i] = 255; raw[i + 3] = 255; }
    }
  }
  return [pngOf(raw, width, height), pngOf(raw, width, height)];
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
function crc32(buf) { let c = -1; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); out.write(type, 4, 'latin1'); data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function pngOf(raw, width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}

/**
 * Which H.264 encoders on this machine **can actually encode** (G0-b conclusion 4: must actually
 * encode a short segment before deciding: all four hardware encoders on this machine are "listed in
 * `ffmpeg -encoders` but cannot run").
 *
 * Uses the exact same command line as segments (same filter chain, same parameters, also outputs
 * fMP4); encoded bytes must contain `moof` to pass. Tests one by one in `order` sequence and
 * returns all results.
 */
export async function probeEncoders(ffmpeg, { order = STREAM_ENCODER_ORDER, fps = 30, timeoutMs = 15000 } = {}) {
  const pngs = probePngs();
  const results = [];
  for (const name of order) {
    if (!STREAM_ENCODERS[name]) { results.push({ name, ok: false, error: 'Unknown encoder' }); continue; }
    const started = Date.now();
    const enc = openStreamSegmentEncoder(ffmpeg, { encoder: name, fps, prewarm: false });
    const timer = setTimeout(() => { void enc.abort(); }, timeoutMs);
    try {
      for (const png of pngs) await enc.write(png);
      const { bytes } = await enc.finish();
      const ok = bytes.includes(Buffer.from('moof', 'latin1')) && bytes.includes(Buffer.from('avcC', 'latin1'));
      results.push({ name, ok, ms: Date.now() - started, error: ok ? null : 'No moof / avcC in the output' });
    } catch (e) {
      results.push({ name, ok: false, ms: Date.now() - started, error: String(e?.message || e).split(/\r?\n/).slice(-2).join(' ') });
    } finally { clearTimeout(timer); }
  }
  return results;
}

/**
 * Find the first encoder that can actually encode according to `preference`; throw if none work.
 * Results are cached by ffmpeg path.
 */
const pickedEncoders = new Map();
export async function pickStreamEncoder(ffmpeg, preference = streamEncoderPreference()) {
  const key = `${ffmpeg}\u0000${preference.join(',')}`;
  if (!pickedEncoders.has(key)) {
    pickedEncoders.set(key, (async () => {
      const results = await probeEncoders(ffmpeg, { order: preference });
      const hit = results.find(r => r.ok);
      if (!hit) throw Object.assign(new Error(`No usable H.264 encoder: ${results.map(r => `${r.name}(${r.error})`).join('; ')}`), { code: 'NO_STREAM_ENCODER', results });
      return { encoder: hit.name, results };
    })());
    pickedEncoders.get(key).catch(() => pickedEncoders.delete(key));
  }
  return pickedEncoders.get(key);
}
