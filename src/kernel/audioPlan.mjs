/**
 * 时间轴上「谁在什么时候出声、多响」的清单,纯函数,不碰磁盘。
 *
 * 三处用同一份规则,免得各写一遍又对不上:
 *   - 导出混音(server/bakery/mux-audio.mjs 的 buildAudioPlan → ffmpeg;server/bakery/audio-mix.mjs 的 Chrome 离线渲染)
 *   - 测响度(measure_audio 的 timeline 档,浏览器把这份清单发给服务端)
 *   - 预览不用它(预览按时刻查 audioClipsAt / videoLayersAt),但规则一致:隐藏 / 静音的序列不出声,
 *     片段 audioMuted 不出声,变速的视频段不出原声(`speedMutesSource`;变速的声音段照常出声、变调;挂在变速段上的声画一体卡照常出声),图片没声音,音量 = opacity × audioVolume,淡入淡出线性。
 */

import { audioFxOfClip } from "./audioFx.mjs";
import { clipHasEmbeddedAudio, resolveCardAudioRendition } from "./cardAudioRendition.mjs";
import { audioProjectOf, envelopeAt } from "./cutAudio.mjs";
import { clipSpeed, speedMutesSource } from "./clipTime.mjs";

const r3 = (n) => +Number(n).toFixed(3);

/**
 * @returns 每一条:{ clipId, trackId, mediaId, start, dur, offset, volume, fadeIn, fadeOut, fx: { def, params } | null, env? }
 *   start / dur 是时间轴上的位置(秒),offset 是从素材第几秒开始。顺序按序列从上到下、片段原顺序。
 *   剪辑段(kernel/cutSegments.ts):先按 `audioProjectOf` 把激活剪辑里的剪辑段展开成平移、裁好的片段,
 *   它们的 clipId 带剪辑段路径前缀,`env` 是外层各段的包络(时间轴绝对时间),混音器乘上去(`gainCurve`)。
 *   没有剪辑段的项目和以前逐字节相同。
 */
export function audioPlanOf(source) {
  const project = audioProjectOf(source);
  const out = [];
  for (const tr of project.tracks || []) {
    if (tr.hidden || tr.muted) continue;
    for (const c of tr.clips || []) {
      if (c.audioMuted) continue;
      // 〔裁〕第一版变速段的原声不出(kernel/clipTime.mjs 文件头):浏览器离线混音与 ffmpeg 做不出一样的变速声音,
      // 只有「不出」两边一致。挂在它上面的音频效果同样不出(声音来源就是这段原声)。
      // 声画一体卡照常出声(2026-10-23 用户定「出声。」):它的声音是已生成的 WAV,本来就按时间轴长度生成
      // (读这段素材时已随倍率变速变调,卡片时钟见 clipTime.mjs 的 cardClockOffset),这里照 1 倍摆位,不再带 speed。
      // 音频素材效果卡不走这份清单(mux-audio 的 buildAudioPlan 另收),变速段当它的输入时随倍率变速变调(2026-10-23 用户定「放开。」)。
      const embedded = clipHasEmbeddedAudio(project, c);
      if (!embedded && speedMutesSource(c, project)) continue;
      const rendition = embedded ? resolveCardAudioRendition(project, c) : null;
      const m = rendition?.media ?? (project.media || []).find((x) => x.id === c.mediaId);
      // 合成声音是已入库的项目内容；丢了引用不能悄悄导出无声片段。
      const generated = embedded || !!(c.soundEffect || m?.soundEffect);
      if (generated && (!m || !m.url)) throw new Error(`${c.id} 的合成音效素材缺失，请重新生成或恢复素材`);
      if (!c.mediaId && !embedded) continue;
      if (!m || !m.url || m.kind === "image") continue;
      // 普通旧素材保持既有口径；合成 WAV 的定位保留到采样，不能先舍入成毫秒。
      const time = generated ? (value) => value : r3;
      const dur = time(c.end - c.start);
      if (!(dur > 0)) continue;
      const def = audioFxOfClip(project, c);
      out.push({
        clipId: c.id,
        trackId: tr.id,
        mediaId: m.id,
        start: time(c.start),
        dur,
        offset: time(rendition?.offset ?? c.mediaOffset ?? 0),
        volume: (c.opacity ?? 1) * (c.audioVolume ?? 1),
        fadeIn: c.fadeIn ?? 0,
        fadeOut: c.fadeOut ?? 0,
        fx: def ? { def, params: c.audioFx.params } : null,
        // 声音段变速(音画分离出来的那种):随倍率变速变调,两条混音路都按 ffmpegVarispeed 做(kernel/clipTime.mjs);
        // 缺省 1 不写这一项,清单逐字不变
        ...(!generated && clipSpeed(c) !== 1 ? { speed: clipSpeed(c) } : null),
        ...(c.cutEnv?.length ? { env: c.cutEnv } : null),
      });
    }
  }
  return out;
}

/**
 * 一段的音量包络:volume × 淡入(线性 0→1)× 淡出(线性 1→0),采成 n 个点(首尾各一个,之间等距)。
 * 和 ffmpeg 那条路(server/bakery/mux-audio.mjs:afade t=in 再 afade t=out,默认 tri 曲线)语义完全一样 —— 两条淡化相乘。
 * 淡入淡出重叠(fadeIn + fadeOut > dur)时是两条斜线的乘积(抛物线),淡入比片段还长时终点只到 dur/fadeIn,
 * 都由乘法自然给出;以前用「两段自动化拼起来」在重叠时会被 AudioParam 的事件排序吃掉整段淡入(实测硬跳)。
 * 导出用 setValueCurveAtTime 铺进去,点间线性插值,5 ms 一个点足够。
 */
export function fadeEnvelope(volume, fadeIn, fadeOut, dur, n) {
  const count = Math.max(2, Math.floor(n) || 2);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const t = (i / (count - 1)) * dur;
    let g = volume;
    if (fadeIn > 0) g *= Math.min(1, t / fadeIn);
    if (fadeOut > 0) g *= Math.min(1, (dur - t) / fadeOut);
    out[i] = Math.max(0, g);
  }
  return out;
}

/**
 * 一段的完整增益曲线:`fadeEnvelope` 再乘上剪辑段的包络(`entry.env`,时间轴绝对时间)。
 * 没有包络时和 `fadeEnvelope` 逐点相同。
 */
export function gainCurve(entry, n) {
  const curve = fadeEnvelope(entry.volume, entry.fadeIn, entry.fadeOut, entry.dur, n);
  if (!entry.env?.length) return curve;
  const count = curve.length;
  for (let i = 0; i < count; i++) {
    // 包络在区间右端是开的;曲线最后一个点落在段尾,取一个极小的回退,免得最后一点被算成 0 产生咔哒声
    const t = entry.start + Math.min((i / (count - 1)) * entry.dur, entry.dur - 1e-6);
    for (const e of entry.env) curve[i] *= envelopeAt(e, t, false);
  }
  return curve;
}

/** 这一段需不需要逐点的增益曲线(有淡化或剪辑段包络) */
export function needsGainCurve(entry) {
  return entry.fadeIn > 0 || entry.fadeOut > 0 || !!entry.env?.some((e) => (e.fadeIn ?? 0) > 0 || (e.fadeOut ?? 0) > 0);
}

/** 时间轴时刻 T 正在出声的片段(给测响度的逐秒归因用) */
export function soundingAt(plan, T) {
  return plan.filter((p) => T >= p.start && T < p.start + p.dur).map((p) => p.clipId);
}
