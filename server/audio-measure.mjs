/**
 * audio-measure.mjs
 * Pure functions: generate ffmpeg ebur128 test parameters and parse output
 */

/**
 * Assemble ffmpeg arguments for a single file or trimmed clip
 * @param {object} opts
 * @param {string} opts.file - Absolute file path
 * @param {number} [opts.offset] - Start time (seconds)
 * @param {number} [opts.duration] - Trim duration (seconds)
 * @returns {string[]}
 */

export function measureArgs({ file, offset, duration }) {
  // -nostats: progress lines (size= time= …) are \r-delimited and crowded with ebur128
  // per-frame lines; parsing would drop whole-second points
  const args = ["-hide_banner", "-nostats"];
  if (offset !== undefined) args.push("-ss", String(offset));
  if (duration !== undefined) args.push("-t", String(duration));
  args.push("-i", file, "-map", "0:a", "-af", "ebur128=peak=true", "-f", "null", "-");
  return args;
}

/**
 * ffmpeg filter for audio clip speed (pitch) changes, verbatim copy of `ffmpegVarispeed` in
 * `src/kernel/clipTime.mjs` (the Agent service process loads this file, and this side is not
 * allowed to import src/, gatekeeper tests SEAM-2 / SEAM-3, so copied as-is). Returns an empty
 * array when speed is 1.
 */
function ffmpegVarispeed(speed, rate = 48000) {
  if (!(speed > 0) || speed === 1) return [];
  return [`aresample=${rate}`, `asetrate=${Math.round(rate * speed)}`, `aresample=${rate}`];
}

/**
 * Mix graph for multi-clip timeline audio (consistent with mux-audio): input arguments, per-clip
 * filter chains, and final amix step (without output label). Shared between loudness measurement
 * (timelineMeasureArgs) and custom measurement PCM decoding (audio-pcm.mjs), ensuring both mix
 * the exact same audio.
 * @param {Array<{file: string, start: number, dur: number, offset: number, volume: number, fadeIn: number, fadeOut: number}>} entries
 * @param {number} [duration] Timeline duration (seconds), where mix is truncated; if omitted,
 *   runs until the end of the last clip
 * @returns {{ inputs: string[], filters: string[], mix: string }}
 */
export function timelineMixParts(entries, duration) {
  const inputs = [];
  const filters = [];
  entries.forEach((p, i) => {
    // Speed-changed sound clip: read dur × speed seconds of asset, change speed and pitch to dur seconds
    // (same ffmpegVarispeed as the two export mix paths, kernel/clipTime.mjs)
    const speed = Number(p.speed) > 0 ? Number(p.speed) : 1;
    inputs.push("-ss", String(p.offset), "-t", String(speed !== 1 ? p.dur * speed : p.dur), "-i", p.file);
    // Since only audio is measured here without video, all inputs are audio and index starts at 0.
    // In mux-audio.mjs, video is input 0, so audio starts at 1 there.
    const k = i;
    const chain = [...ffmpegVarispeed(speed), `adelay=${Math.round(p.start * 1000)}:all=1`];
    if (p.fadeIn > 0) chain.push(`afade=t=in:st=${p.start.toFixed(3)}:d=${p.fadeIn}`);
    if (p.fadeOut > 0) {
      chain.push(`afade=t=out:st=${(p.start + p.dur - p.fadeOut).toFixed(3)}:d=${p.fadeOut}`);
    }
    if (p.volume !== 1) chain.push(`volume=${p.volume}`);
    filters.push(`[${k}:a]${chain.join(",")}[a${k}]`);
  });
  const labels = entries.map((_, i) => `[a${i}]`).join("");
  const trim = duration > 0 ? `,atrim=0:${duration}` : "";
  return { inputs, filters, mix: `${labels}amix=inputs=${entries.length}:normalize=0:dropout_transition=0${trim}` };
}

/**
 * Assemble ffmpeg arguments for multi-clip timeline audio mix (consistent with mux-audio)
 * @param {Array<{file: string, start: number, dur: number, offset: number, volume: number, fadeIn: number, fadeOut: number}>} entries 
 * @returns {string[]}
 */
export function timelineMeasureArgs(entries, duration) {
  // duration: timeline duration (seconds), where mix is truncated, measuring the same segment as
  // export (-t duration); if omitted, measures until the end of the last clip.
  // -nostats: progress lines are \r-delimited and crowded with ebur128 per-frame lines;
  // parsing would drop whole-second points.
  // asetpts=N/SR/TB: restamps timestamps by sample index before passing to ebur128. When a clip
  // ends before the end, ffmpeg 9 amix occasionally stamps NOPTS on subsequent frames, making ebur128
  // per-frame lines show t: -192153584101141.06 (INT64_MIN / 48000), causing missing points in
  // the per-second curve after that point (measured at ~1-13%, AGENT-maint-3). Under normal conditions
  // amix output is continuous from 0, so this step is an identity op; loudness only depends on
  // samples, so summary values are unaffected.
  const { inputs, filters, mix } = timelineMixParts(entries, duration);
  return [
    "-hide_banner", "-nostats", ...inputs,
    "-filter_complex", [...filters, `${mix},asetpts=N/SR/TB,ebur128=peak=true[aout]`].join(";"),
    "-map", "[aout]", "-f", "null", "-",
  ];
}

/**
 * Parse stderr output of the ebur128 filter
 * @param {string} stderr 
 * @returns {object} Parsed result
 */
export function parseEbur128(stderr) {
  // Helper to convert -inf or nan to null
  const numOrNull = (str) => {
    if (!str || str.toLowerCase() === "-inf" || str.toLowerCase() === "nan") return null;
    const n = parseFloat(str);
    return isNaN(n) ? null : n;
  };

  // Progress lines are \r-delimited; without splitting on \r, a single line can contain
  // multiple t: and only match the first
  const lines = stderr.split(/\r?\n|\r/).map(l => l.trim());

  let integrated, threshold, lra, lraLow, lraHigh, truePeak, duration;
  const series = [];
  // For each integer second, take the first frame falling in [k, k+1); using floor instead of
  // "record once nextSec is crossed" ensures a dropped frame won't shift all subsequent points
  let lastSec = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Matches ebur128 per-frame output, for example:
    // [Parsed_ebur128_0 @ 0000021bd94a2540] t: 177.799977 TARGET:-23 LUFS    M: -46.4 S: -20.0     I: -12.4 LUFS       LRA:  11.0 LU  FTPK: -42.7 -46.6 dBFS  TPK:   0.0   0.0 dBFS
    const tMatch = line.match(/t:\s*([\d.]+)/);
    const sMatch = line.match(/S:\s*([-+\d.A-Za-z]+)/); 
    if (tMatch && sMatch) {
      const t = parseFloat(tMatch[1]);
      const sVal = numOrNull(sMatch[1]);
      
      duration = t;

      const sec = Math.floor(t + 1e-6);
      if (sec > lastSec) {
        series.push({ t: sec, lufs: sVal });
        lastSec = sec;
      }
    }

    // Matches Summary section, for example:
    //     I:         -12.4 LUFS
    if (line.match(/^\s*I:\s*([-+\d.A-Za-z]+)\s*LUFS/)) {
      integrated = numOrNull(line.match(/^\s*I:\s*([-+\d.A-Za-z]+)/)[1]);
    }
    //     Threshold: -22.9 LUFS
    if (line.match(/^\s*Threshold:\s*([-+\d.A-Za-z]+)\s*LUFS/)) {
      if (threshold === undefined) threshold = numOrNull(line.match(/^\s*Threshold:\s*([-+\d.A-Za-z]+)/)[1]);
    }

    // LRA section, for example:
    //     LRA:        11.5 LU
    if (line.match(/^\s*LRA:\s*([-+\d.A-Za-z]+)\s*LU/)) {
      lra = numOrNull(line.match(/^\s*LRA:\s*([-+\d.A-Za-z]+)/)[1]);
    }
    //     LRA low:   -20.9 LUFS
    if (line.match(/^\s*LRA low:\s*([-+\d.A-Za-z]+)\s*LUFS/)) {
      lraLow = numOrNull(line.match(/^\s*LRA low:\s*([-+\d.A-Za-z]+)/)[1]);
    }
    //     LRA high:   -9.3 LUFS
    if (line.match(/^\s*LRA high:\s*([-+\d.A-Za-z]+)\s*LUFS/)) {
      lraHigh = numOrNull(line.match(/^\s*LRA high:\s*([-+\d.A-Za-z]+)/)[1]);
    }

    // True peak section, for example:
    //     Peak:        0.0 dBFS
    if (line.match(/^\s*Peak:\s*([-+\d.A-Za-z]+)\s*dBFS/)) {
      truePeak = numOrNull(line.match(/^\s*Peak:\s*([-+\d.A-Za-z]+)/)[1]);
    }
    
    // Matches ffmpeg progress output to obtain more accurate duration:
    // size=N/A time=00:03:02.00 bitrate=N/A speed= 396x elapsed=0:00:00.45
    const timeMatch = line.match(/time=(\d{2}):(\d{2}):([\d.]+)/);
    if (timeMatch) {
      const h = parseInt(timeMatch[1], 10);
      const m = parseInt(timeMatch[2], 10);
      const s = parseFloat(timeMatch[3]);
      duration = h * 3600 + m * 60 + s;
    }
  }

  return { integrated, truePeak, lra, lraLow, lraHigh, threshold, duration, series };
}
