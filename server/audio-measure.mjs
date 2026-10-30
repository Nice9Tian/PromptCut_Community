/**
 * audio-measure.mjs
 * 纯函数: 生成 ffmpeg ebur128 测试参数并解析输出
 */

/**
 * 拼装单个文件或截断片段的 ffmpeg 参数
 * @param {object} opts
 * @param {string} opts.file - 绝对文件路径
 * @param {number} [opts.offset] - 起始时间(秒)
 * @param {number} [opts.duration] - 截取时长(秒)
 * @returns {string[]}
 */

export function measureArgs({ file, offset, duration }) {
  // -nostats:进度行(size= time= …)是 \r 分隔、和 ebur128 的逐帧行挤在一起,解析时会吞掉整秒的点
  const args = ["-hide_banner", "-nostats"];
  if (offset !== undefined) args.push("-ss", String(offset));
  if (duration !== undefined) args.push("-t", String(duration));
  args.push("-i", file, "-map", "0:a", "-af", "ebur128=peak=true", "-f", "null", "-");
  return args;
}

/**
 * 声音段变速(变调)的 ffmpeg 滤镜,和 `src/kernel/clipTime.mjs` 的 ffmpegVarispeed 逐字同一份(Agent 服务进程会载这个文件,
 * 这一侧不许 import src/,守门测试 SEAM-2 / SEAM-3,所以照抄)。速度为 1 时回空数组。
 */
function ffmpegVarispeed(speed, rate = 48000) {
  if (!(speed > 0) || speed === 1) return [];
  return [`aresample=${rate}`, `asetrate=${Math.round(rate * speed)}`, `aresample=${rate}`];
}

/**
 * 时间轴多段音频的混音图(和 mux-audio 一致):输入参数、每段的滤镜链、最后一步 amix(不带输出标签)。
 * 测响度(timelineMeasureArgs)和自定义测量解码 PCM(audio-pcm.mjs)共用这一份,两边混出来的是同一段声音。
 * @param {Array<{file: string, start: number, dur: number, offset: number, volume: number, fadeIn: number, fadeOut: number}>} entries
 * @param {number} [duration] 时间轴时长(秒),混音在这里截断;不传就到最后一段结束
 * @returns {{ inputs: string[], filters: string[], mix: string }}
 */
export function timelineMixParts(entries, duration) {
  const inputs = [];
  const filters = [];
  entries.forEach((p, i) => {
    // 变速的声音段:读 dur × speed 秒素材、变速变调成 dur 秒(和导出两条混音路同一份 ffmpegVarispeed,kernel/clipTime.mjs)
    const speed = Number(p.speed) > 0 ? Number(p.speed) : 1;
    inputs.push("-ss", String(p.offset), "-t", String(speed !== 1 ? p.dur * speed : p.dur), "-i", p.file);
    // 因为这里只测音频没有视频文件参与，输入文件全都是音频，所以输入索引从 0 开始。
    // 而 mux-audio.mjs 里有视频作为输入 0，所以那里的音频是从 1 开始的。
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
 * 拼装时间轴多段音频混音的 ffmpeg 参数 (和 mux-audio 一致)
 * @param {Array<{file: string, start: number, dur: number, offset: number, volume: number, fadeIn: number, fadeOut: number}>} entries 
 * @returns {string[]}
 */
export function timelineMeasureArgs(entries, duration) {
  // duration:时间轴时长(秒),混音在这里截断,和导出(-t duration)测的是同一段;不传就测到最后一段结束。
  // -nostats:进度行是 \r 分隔、和 ebur128 的逐帧行挤在一起,解析会吞掉整秒的点
  // asetpts=N/SR/TB:按样本序号重打时间戳,再交给 ebur128。有一段先于结尾结束时,ffmpeg 9 的 amix 偶发给之后的帧
  // 打 NOPTS,ebur128 的逐帧行就成了 t: -192153584101141.06(INT64_MIN / 48000),逐秒曲线在那之后缺点
  // (实测约 1～13%,AGENT-maint-3)。正常时 amix 的输出从 0 连续,这一步是恒等的;响度只看样本,汇总值不受影响
  const { inputs, filters, mix } = timelineMixParts(entries, duration);
  return [
    "-hide_banner", "-nostats", ...inputs,
    "-filter_complex", [...filters, `${mix},asetpts=N/SR/TB,ebur128=peak=true[aout]`].join(";"),
    "-map", "[aout]", "-f", "null", "-",
  ];
}

/**
 * 解析 ebur128 滤镜的 stderr 输出
 * @param {string} stderr 
 * @returns {object} 解析得到的结果
 */
export function parseEbur128(stderr) {
  // -inf 或 nan 转 null 的小函数
  const numOrNull = (str) => {
    if (!str || str.toLowerCase() === "-inf" || str.toLowerCase() === "nan") return null;
    const n = parseFloat(str);
    return isNaN(n) ? null : n;
  };

  // 进度行是 \r 分隔的,不按 \r 切的话一行里会有好几个 t:,只匹配到第一个
  const lines = stderr.split(/\r?\n|\r/).map(l => l.trim());

  let integrated, threshold, lra, lraLow, lraHigh, truePeak, duration;
  const series = [];
  // 每整秒取落在 [k, k+1) 里的第一帧;按 floor 而不是「跨过 nextSec 就记」,丢一帧不会让后面整体错位
  let lastSec = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 匹配 ebur128 的逐帧输出，例如：
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

    // 匹配 Summary section，例如：
    //     I:         -12.4 LUFS
    if (line.match(/^\s*I:\s*([-+\d.A-Za-z]+)\s*LUFS/)) {
      integrated = numOrNull(line.match(/^\s*I:\s*([-+\d.A-Za-z]+)/)[1]);
    }
    //     Threshold: -22.9 LUFS
    if (line.match(/^\s*Threshold:\s*([-+\d.A-Za-z]+)\s*LUFS/)) {
      if (threshold === undefined) threshold = numOrNull(line.match(/^\s*Threshold:\s*([-+\d.A-Za-z]+)/)[1]);
    }

    // LRA section，例如：
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

    // True peak section，例如：
    //     Peak:        0.0 dBFS
    if (line.match(/^\s*Peak:\s*([-+\d.A-Za-z]+)\s*dBFS/)) {
      truePeak = numOrNull(line.match(/^\s*Peak:\s*([-+\d.A-Za-z]+)/)[1]);
    }
    
    // 匹配 ffmpeg 进度输出以获得更准确的时长：
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
