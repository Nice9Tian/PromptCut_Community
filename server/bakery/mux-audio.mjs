/**
 * 给导出的成品加音轨。
 *
 * 逐帧截图那条链路只产出画面,声音必须在最后用 ffmpeg 拼回去:
 * 项目里每一段有声音的素材(配乐、以及视频自带的声音)按它在时间轴上的位置延迟、
 * 按 mediaOffset 取片段、按 fadeIn/fadeOut 做淡入淡出,再混成一条轨。变速的素材段不出原声(kernel/clipTime.mjs)。
 *
 * 单独成文件是为了可测:buildAudioPlan / buildFfmpegArgs 都是纯函数,不碰磁盘。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { audioPlanOf } from "../../src/kernel/audioPlan.mjs";
import { ffmpegVarispeed } from "../../src/kernel/clipTime.mjs";
import { audioProjectOf } from "../../src/kernel/cutAudio.mjs";
import { audioFxOfClip } from "../../src/kernel/audioFx.mjs";

export const MISSING_MATERIAL_WAV = fileURLToPath(new URL("../../src/audio/assets/missing-material.wav", import.meta.url));

function isConfirmedMissingAudio(media, project) {
  const state = media?.missingMaterial;
  if (media && media.kind !== "image" && state?.v === 1 && state.reason === "confirmed-missing"
    && state.mediaId === media.id && state.audio === true && typeof state.visual === "boolean"
    && state.original?.kind === media.kind && state.original?.name === media.name && state.original?.url === media.url
    && state.original?.hash === media.hash) return true;
  const source = media?.soundOf ? project?.media?.find((item) => item.id === media.soundOf) : undefined;
  const sourceState = source?.missingMaterial;
  return source?.kind === "video" && sourceState?.v === 1 && sourceState.reason === "confirmed-missing"
    && sourceState.mediaId === source.id && sourceState.audio === true && typeof sourceState.visual === "boolean"
    && sourceState.original?.kind === "video" && sourceState.original?.name === source.name && sourceState.original?.url === source.url
    && sourceState.original?.hash === source.hash;
}

/** 导出时素材的 url 形如 /@export/<id>/media/<file>,真实文件在 outDir/media/<file> */
export function localPathOf(url, outDir) {
  if (!url) return null;
  const marker = "/media/";
  const i = url.lastIndexOf(marker);
  if (i === -1) return null;
  return path.join(outDir, "media", decodeURIComponent(url.slice(i + marker.length)));
}

/**
 * 从 Project 里挑出所有该出声的片段。
 * 图片没有声音;隐藏的序列不出声;音量取 clip.opacity(和画面用同一个字段,画面淡下去声音也淡)。
 *
 * sourceOf:素材 → ffmpeg 能读的文件或同源 http 地址。导出时传 export-frames 的 mediaSourceOf,
 * 和画面层同一套规则。以前只认 localPathOf(/@export/<id>/media/),素材库里的 /@media/<文件> 一律被跳过,
 * 配乐、配音、打开 .proc 后的视频原声都进不了成片。
 */
export function buildAudioPlan(source, outDir, exists = fs.existsSync, sourceOf = (m) => localPathOf(m.url, outDir)) {
  // 剪辑段:按 kernel/cutAudio.mjs 展开成平移、裁好的片段(和 audioPlanOf 同一份),下面按 clipId 找片段也在这一份里找
  const project = audioProjectOf(source);
  const out = [];
  // 谁出声、多响的规则在 kernel/audioPlan.mjs(和测响度、Chrome 离线混音同一份);这里只补文件在哪
  for (const e of audioPlanOf(project)) {
    const sourceClip = (project.tracks ?? []).flatMap(track => track.clips ?? []).find(clip => clip.id === e.clipId);
    // A generated node replaces its corresponding source-media input; applying both would double it.
    if (!sourceClip?.cardAudio && isCardAudioNode(project, sourceClip?.nodeId)) continue;
    const m = (project.media || []).find((x) => x.id === e.mediaId);
    const missingMaterial = isConfirmedMissingAudio(m, project);
    const file = missingMaterial ? MISSING_MATERIAL_WAV : sourceOf(m);
    const soundEffect = !!(sourceClip?.cardAudio || m?.soundEffect || sourceClip?.soundEffect);
    if (!file || (!/^https?:/i.test(file) && !exists(file))) {
      if (soundEffect) throw new Error(`${e.clipId} 的合成音效文件缺失，请恢复素材或重新生成`);
      continue;
    }
    out.push({ file, clipId: e.clipId, start: e.start, dur: e.dur, offset: missingMaterial ? 0 : e.offset, volume: e.volume, fadeIn: e.fadeIn, fadeOut: e.fadeOut, fx: e.fx,
      // 变速的声音段(kernel/clipTime.mjs):读 dur × speed 秒素材、ffmpegVarispeed 变速变调成 dur 秒
      ...(e.speed && !missingMaterial ? { speed: e.speed, renderDir: outDir } : null),
      ...(e.env ? { env: e.env } : null),
      ...(missingMaterial ? { missingMaterial: true } : null), ...(soundEffect ? { soundEffect: true } : {}) });
  }
  // 音频素材效果卡节点 have no ffmpeg-readable source file.  Keep them in the one common
  // plan so Chrome's OfflineAudioContext can request their true WAV blocks.  A caller that
  // explicitly selects the old --audio ffmpeg path must reject them, never silently omit them.
  for (const track of project.tracks ?? []) {
    if (track.hidden || track.muted) continue;
    for (const clip of track.clips ?? []) {
      // 变速的视频段不出原声,但挂在它上面的音频素材效果卡照常出:卡读这段素材当输入,随倍率变速变调
      // (src/render/cards/audioSources.ts 的 varispeedBlock;2026-10-23 用户定「放开。」)。这里只收音频素材效果卡节点,
      // 声画一体卡走上面 audioPlanOf 那一路(已生成的 WAV;变速段上同样照常出声,2026-10-23 用户定「出声。」)
      if (clip.audioMuted || clip.cardAudio || !isCardAudioNode(project, clip.nodeId)) continue;
      // Generated blocks are sample-addressed; do not quantize their timeline placement to
      // the legacy 3 ms audio-plan precision before converting duration to frames.
      const dur = clip.end - clip.start;
      if (!(dur > 0)) continue;
      const definition = audioFxOfClip(project, clip);
      out.push({ cardAudio: true, nodeId: clip.nodeId, clipId: clip.id, start: clip.start, dur,
        offset: 0, volume: (clip.opacity ?? 1) * (clip.audioVolume ?? 1), fadeIn: clip.fadeIn ?? 0, fadeOut: clip.fadeOut ?? 0,
        fx: definition ? { def: definition, params: clip.audioFx?.params } : null, ...(clip.cutEnv?.length ? { env: clip.cutEnv } : null) });
    }
  }
  return out;
}

/** Kept local to this script so the project model need not invent a fake media asset for a generated node.
 *  只看节点:Node 侧脚本读不到 TSX 定义,kind 是 H2 从定义抄进节点的那一份。 */
export function isCardAudioNode(project, nodeId) {
  if (!nodeId) return false;
  const node = (project.cardNodes ?? []).find(value => value.id === nodeId);
  return node?.adapter === "card" && node.kind === "audio";
}

/** 这个文件里有没有音频流(视频不一定有声轨,直接引用会让整条 filter 崩掉) */
export function hasAudioStream(file, ffprobeCmd) {
  try {
    const out = execFileSync(
      ffprobeCmd,
      ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", file],
      { encoding: "utf8", timeout: 15000, windowsHide: true },
    );
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

/** ffprobe 的路径换回同一个目录里的 ffmpeg(`ffmpeg.mjs` 的 ffprobeOf 反过来) */
const ffmpegOf = (ffprobeCmd) => String(ffprobeCmd).replace(/ffprobe(\.exe)?$/i, (m) => (m.toLowerCase() === 'ffprobe.exe' ? 'ffmpeg.exe' : 'ffmpeg'));

/**
 * 变速的声音段(音画分离出来的那种,kernel/clipTime.mjs)先用 ffmpeg 做成一段时间轴长度的 wav:读 dur × speed 秒素材、
 * `ffmpegVarispeed` 变速变调。导出的两条混音路(Chrome 离线混音的裁段、ffmpeg 混音)都从这一份 wav 起,所以两条路拿到的
 * 是同一份重采样结果。放在这里(不放进 `audio-mix.mjs`)是因为 `server/bakery/` 的那七个模块进共享快照键的代码指纹
 * (`server/frame-code.mjs` 的 SNAPSHOT_FILES),改它们会让所有已有快照的键都变。
 * @returns {string} 做好的 wav 路径
 */
export function renderVarispeedWav(entry, ffmpegCmd, index) {
  const dir = path.join(entry.renderDir || ".", "audio-speed");
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `speed-${index}-${String(entry.clipId).replace(/[^\w.-]+/g, "_").slice(0, 60)}.wav`);
  execFileSync(ffmpegCmd, ["-y", "-hide_banner", "-loglevel", "error", "-ss", String(entry.offset), "-t", String(entry.dur * entry.speed), "-i", entry.file,
    "-vn", "-sn", "-dn", "-af", ffmpegVarispeed(entry.speed).join(","), "-ac", "2", "-ar", "48000", "-c:a", "pcm_f32le", out], { timeout: 600000, windowsHide: true });
  return out;
}

/** 普通静音视频可以略过；已有合成音效却读不到音轨时必须失败，不能报告无声成片成功。变速的声音段换成做好的 wav(见上)。 */
export function playableAudioPlan(plan, ffprobeCmd, probe = hasAudioStream, render = renderVarispeedWav) {
  return plan.filter((entry) => {
    if (entry.cardAudio) return true;
    const playable = probe(entry.file, ffprobeCmd);
    if (!playable && entry.soundEffect) throw new Error(`${entry.clipId} 的合成音效无法读取音轨，请恢复素材或重新生成`);
    return playable;
  }).map((entry, i) => {
    if (!entry.speed || entry.cardAudio) return entry;
    const { speed: _speed, renderDir: _dir, ...rest } = entry;
    return { ...rest, file: render(entry, ffmpegOf(ffprobeCmd), i), offset: 0 };
  });
}

/** 拼 ffmpeg 参数:视频流照抄,音频按计划混音 */
export function buildFfmpegArgs(videoIn, plan, videoOut, durationSec) {
  if (plan.some(p => p.cardAudio)) throw new Error("ffmpeg audio mux cannot render card audio; use the Chrome audio mixer");
  const args = ["-y", "-i", videoIn];
  const filters = [];
  plan.forEach((p, i) => {
    // 变速的声音段:读 dur × speed 秒素材,先变速变调成 dur 秒再摆位(和 Chrome 那条路的裁段同一份 ffmpegVarispeed)
    args.push("-ss", String(p.offset), "-t", String(p.speed ? p.dur * p.speed : p.dur), "-i", p.file);
    const k = i + 1; // 0 是视频
    const chain = p.soundEffect
      ? ['aresample=48000', `adelay=${Math.round(p.start * 48000)}S:all=1`]
      : [...ffmpegVarispeed(p.speed ?? 1), `adelay=${Math.round(p.start * 1000)}:all=1`];
    if (p.fadeIn > 0) chain.push(`afade=t=in:st=${p.soundEffect ? p.start : p.start.toFixed(3)}:d=${p.fadeIn}`);
    if (p.fadeOut > 0) {
      const fadeStart = p.start + p.dur - p.fadeOut;
      chain.push(`afade=t=out:st=${p.soundEffect ? fadeStart : fadeStart.toFixed(3)}:d=${p.fadeOut}`);
    }
    // 剪辑段的包络(时间轴绝对时间):每层的淡入淡出各一条 afade,相乘(和 kernel/audioPlan.mjs 的 gainCurve 同一语义)
    for (const e of p.env ?? []) {
      if ((e.fadeIn ?? 0) > 0) chain.push(`afade=t=in:st=${e.start.toFixed(3)}:d=${e.fadeIn}`);
      if ((e.fadeOut ?? 0) > 0) chain.push(`afade=t=out:st=${(e.end - e.fadeOut).toFixed(3)}:d=${e.fadeOut}`);
    }
    if (p.volume !== 1) chain.push(`volume=${p.volume}`);
    filters.push(`[${k}:a]${chain.join(",")}[a${k}]`);
  });
  const labels = plan.map((_, i) => `[a${i + 1}]`).join("");
  // normalize=0:多条音轨叠加时不要自动压低音量,否则加一段配乐会把原声压小
  filters.push(`${labels}amix=inputs=${plan.length}:normalize=0:dropout_transition=0[aout]`);
  args.push(
    "-filter_complex",
    filters.join(";"),
    "-map",
    "0:v",
    "-map",
    "[aout]",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-t",
    String(durationSec),
    videoOut,
  );
  return args;
}
